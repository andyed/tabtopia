/**
 * wunderkammer — the spatial view.
 *
 * The flat wall answers "show me fifty things at once and let me narrow by
 * property". This answers a different question: "which of these belong
 * together, and what is the shape of what I have collected". Same index, same
 * filters, same adapter — a second reading of one corpus, not a second corpus.
 *
 * Everything structural lives in the vendored muriel lib (see lib/VENDOR.md).
 * What is here is wunderkammer's own: mapping clips onto the field, turning facets
 * into piles, keeping the `obsidian://` deep link on every promoted card, and
 * persisting pile membership as VIEW STATE — an annotation over the corpus,
 * never a write to the notes.
 *
 * SECURITY NOTE: as in wall.mjs, every string here — titles, notes, tags, facet
 * values — comes from scraped third-party pages, and all of it goes into the
 * DOM via textContent. There is no innerHTML path for clip-derived data. The
 * hybrid's build() hook is a node-filling callback for exactly this reason.
 */

import { createScene, makePlane, THREE }
  from './lib/spatial.js';
import { remote } from '../media-policy.mjs';
import { TileField } from './lib/instanced.js';
import { HybridField } from './lib/hybrid.js';
import { PileLayout } from './lib/piles.js';
import { FieldNavigator } from './lib/navigate.js';
import { CardHost, supported as drawableSupported } from './lib/cards.js';
import { RETRY, taintsCanvas } from './lib/atlas.js';
import { spriteCovers } from '../sprite-covers.mjs';
import { RowMotion } from './lib/motion.js';
import { groupBy, layout, SIMILARITY, isSimilarity } from '../layout.mjs';
import { spreadScale, HOVER_PX } from '../similarity-layout.mjs';
import { perf } from '../instrument.mjs';
import { VideoTiles, fieldPlacement } from '../video-tiles.mjs';

/** How long the cards must go without a repaint before find is armed. Covers
 * arrive in bursts a second or more apart on a cold cache, and those are
 * waited for by name; this is the margin for a repaint nobody listed. */
const FIND_QUIET_MS = 400;
/** The longest find stays off waiting for covers whose page never answers. */
const FIND_WORK_TIMEOUT_MS = 15000;
// A card that repaints by itself is not answering a find. An animated cover
// (GIF, APNG, an animated SVG) repaints its card on every frame, and nothing
// on the paint event tells that from a match. A card that repaints this many
// times, each within RESTLESS_GAP_MS of the last, is animating: it is left
// out of find for the life of the field. Measured on a 544-item wall: an
// animated PNG repainted its card 20 times a second, two GIFs 1 to 4 times.
const RESTLESS_PAINTS = 5;
const RESTLESS_GAP_MS = 3000;
// Only a paint of a few cards counts toward that. While a wall loads, the
// browser repaints nearly every card together, over and over (543 of 544, a
// dozen times in two seconds), and counting those marked the whole wall
// restless. In paints of up to this many cards, 535 of the 544 appeared at
// most once, 6 twice, and the three animated ones 13 to 481 times.
const RESTLESS_SET = 8;
// A capture is followed by a repaint of the captured card when its cover had
// not been decoded yet: drawing the card decodes the image, and the card is
// painted again with it. On the 544-item wall those came 0.8 to 1.4 s after a
// camera move, 19 to 33 cards at a time, long after the capture call returned.
// A card does not answer a find for this long after we captured it.
const CAPTURE_ECHO_MS = 3000;
/** How far from the camera a tile gets a near-tier slot, in world units. */
const NEAR_DISTANCE = 3200;
/** The edge of a far-tier tile in its atlas (AtlasPair's `farPx`). */
const FAR_TILE_PX = 64;
// A card is authored at this size, with a 15 px title (spatial.css .sp-t).
const CARD_W = 340, CARD_H = 255, CARD_TITLE_PX = 15;
// Semantic zoom for the title band: a tile wears it only while that title
// reaches this many CSS px on screen. Below it the band is a smear across the
// picture, so the tile is the bare cover and the title waits for hover.
const LABEL_MIN_TITLE_PX = 7;
// A tile already labelled keeps its band down to this fraction of the
// cutoff, so one sitting on the line does not flicker as the camera drifts.
const LABEL_KEEP = 0.9;
// Tiles redrawn per frame when they cross the cutoff. A capture is the cost.
const RELABEL_PER_FRAME = 24;



/** Same fallback as layout.mjs — a clip with no usable dims is assumed 4:3. */
function aspectOfClip(clip) {
  const dim = String(clip.props?.dims?.[0] || clip.props?.dims || '');
  const m = dim.match(/^(\d+)x(\d+)$/);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return Math.min(4, Math.max(0.3, w / h));
    }
  }
  return 4 / 3;
}

/**
 * The stable key for view state.
 *
 * NOT clip.id. Ids are the note filename (obsidian), the tiddler title
 * (tiddlywiki) or an upstream id (interests) — none of them survive a rename,
 * and clip.mjs builds the filename out of a title slug, which is exactly the
 * thing you correct in Obsidian three weeks later. The URL is what was actually
 * clipped: stable across renames, across retitles, and across swapping the
 * adapter underneath. Id is the fallback for the URL-less.
 */
export const keyOfClip = (clip) => clip.url || `id:${clip.id}`;

/**
 * Route remote images through wunderkammer's own origin.
 *
 * A texture atlas is a canvas, so a cross-origin image needs the publisher to
 * send CORS headers — the loader has to request crossOrigin="anonymous", and
 * every publisher that does not send Access-Control-Allow-Origin fails
 * silently, leaving a blank tile. Measured on this corpus: plain <img> loads
 * 90% of harvested heroes, the same URLs with crossOrigin load 63%. Serving
 * them same-origin sidesteps the whole problem, and stops leaking a referrer
 * to each publisher on every render besides.
 *
 * Vault media is already same-origin and is left alone.
 */
export function proxied(src) {
  // Same-origin media needs no proxy: root-relative (the server) or relative
  // (the static demo, served from a sub-path). Only absolute remote URLs go through it.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('//')) return src;
  if (new URL(src, location.href).origin === location.origin) return src;
  return remote(src);
}

/**
 * The clip's image source for a target pixel size: the smallest cover variant
 * at least that wide, else the largest there is, else the plain cover. The
 * far tier's 64 px slot takes a 128 px derivative and the near tier's 256 px
 * slot a 640 px one, instead of both downscaling the same file.
 */
export function sourceFor(clip, px) {
  const variants = (Array.isArray(clip?.coverVariants) ? clip.coverVariants : [])
    .filter(v => typeof v?.src === 'string' && Number.isFinite(v.width) && v.width > 0)
    .sort((a, b) => a.width - b.width);
  const fit = variants.find(v => v.width >= px) || variants.at(-1);
  return fit?.src || clip?.cover || clip?.media?.[0]?.src || null;
}

/**
 * One axis of the pan rule: `a` and `b` are the camera centres that put the
 * content's near and far edge at the pane's edge (with `half` the visible
 * half-extent). Overflowing content (a ≤ b) may be panned between them;
 * fitting content (a > b) is frozen unless part of it is off the pane.
 */
function clampPan(current, next, lo, hi, half) {
  const a = lo + half, b = hi - half;
  const clamp = (v, l, h) => Math.max(l, Math.min(h, v));
  if (a <= b) return clamp(next, a, b);
  if (current > a) return clamp(next, a, current);   // the near edge is clipped: may return, not go on
  if (current < b) return clamp(next, current, b);   // the far edge is clipped: likewise
  return current;                                     // fully visible: nothing to reveal
}

export class SpatialView {
  /**
   * @param {HTMLElement} host element to mount into
   * @param {object} hooks
   * @param {(clip:object) => void} hooks.onOpen  open the detail panel
   * @param {(clip:object) => void} [hooks.onHover]  the pointer rests on an item
   * @param {() => void} [hooks.onHoverEnd]  the pointer has left every item
   * @param {() => boolean} [hooks.hoverEnabled]  asked BEFORE each pick, so a
   *   field nobody is previewing costs nothing
   * @param {() => void} [hooks.onInteraction] invalidate parent preview intent
   */
  constructor(host, { onOpen, onHover, onHoverEnd, hoverEnabled, onInteraction } = {}) {
    this.host = host;
    this.onOpen = onOpen || (() => {});
    this.onHover = onHover || (() => {});
    this.onHoverEnd = onHoverEnd || (() => {});
    this.hoverEnabled = hoverEnabled || (() => false);
    this.onInteraction = onInteraction || (() => {});
    this._cameraMotion = null;
    this._returnPose = null;
    this._hoverCandidate = -1;
    this._hoverTimer = 0;
    this._hovered = -1;
    this._hoverFrame = 0;
    this.clips = [];
    this.groupKey = 'none';
    this.built = false;
    this.mode = 'mountain';
  }

  /** Build the scene. Deferred until the view is first shown — a WebGL context
   *  and a 100 MB atlas are not worth creating for a session that never opens
   *  it. */
  _ensureScene() {
    if (this.built) return;
    this.built = true;

    this.host.replaceChildren();
    const webgl = document.createElement('div');
    webgl.id = 'sp-webgl';
    const css3d = document.createElement('div');
    css3d.id = 'sp-css3d';
    this.host.append(webgl, css3d);
    this.backButton = document.createElement('button');
    this.backButton.type = 'button';
    this.backButton.className = 'btn sp-back';
    this.backButton.textContent = '← All stacks';
    this.backButton.hidden = true;
    this.backButton.addEventListener('click', () => { this.collapse(); css3d.focus(); });
    this.host.append(this.backButton);

    const rig = createScene({
      webglMount: '#sp-webgl',
      cssMount: '#sp-css3d',
      container: this.host,          // an app pane, not the window
      cameraPos: [0, 360, 1650],
      lookAt: [0, 560, -950],
      far: 14000,
    });
    Object.assign(this, rig);

    // A reading plane with real stack depth. The old demo slope reserved most
    // of the viewport for a grid and kept moving even when nobody touched it.
    this.surface = { planeToWorld: (u, v, h) => new THREE.Vector3(u, v + h / 2, 0) };
    this.basePos = new THREE.Vector3(0, 0, 1600);
    this.lookTarget = new THREE.Vector3();
    // An initially empty scope has no corners for fit(), but still has a valid
    // automatic camera state to save and restore through a view link.
    this.fitted = true;
    this.motion = new RowMotion({ speed: 0, wrapSpan: 0, sweep: 0 });
    this.motion.setEnabled(false);
    this._replaceField();

    this.nav = new FieldNavigator({
      field: this.field, hybrid: this.hybrid, camera: this.camera,
      container: css3d,
      labelOf: (i) => this._label(i),
      onSelect: (i, centre) => {
        // Selection must not destroy the overview. Pan only when off screen.
        const p = centre.clone().project(this.camera);
        if (Math.abs(p.x) > 0.9 || Math.abs(p.y) > 0.9) {
          this.panTo(centre.x, centre.y);
        }
      },
      onActivate: (i) => this._activate(i),
      onEscape: () => this.collapse(),
      onGroupStep: (dir) => this._stepPile(dir),
      onTypeAhead: (prefix) => this._jumpPile(prefix),
    });

    // Selection promotes a card and repositions it outside the frame loop,
    // so it must invalidate the on-demand frame (focus is wrapped per field).
    const select = this.nav.select.bind(this.nav);
    this.nav.select = (i) => { select(i); this.invalidate(); };
    const selectFirst = this.nav.selectFirstVisible.bind(this.nav);
    this.nav.selectFirstVisible = () => {
      if (this.mode !== 'piles' || !this.piles.piles.length) return selectFirst();
      const tops = this.piles.piles.filter(p => p.indices.length).map(p => p.indices.at(-1));
      tops.sort((a, b) => {
        const pa = this.field.worldCentre(a, new THREE.Vector3()).project(this.camera);
        const pb = this.field.worldCentre(b, new THREE.Vector3()).project(this.camera);
        return pa.x * pa.x + pa.y * pa.y - pb.x * pb.x - pb.y * pb.y;
      });
      if (tops.length) this.nav.select(tops[0]);
      return tops[0] ?? -1;
    };
    this.labelObjs = [];
    this._bindPointer();

    // Debug handle. Atlas load failures are invisible from the outside — a
    // tile that never loaded is a flat placeholder, which looks like a tile
    // whose image is simply dark — so the counts have to be reachable.
    window.__cwSpatial = this;

    // Render on demand. A stationary camera over a settled field has nothing
    // new to draw, and drawing it anyway cost 18% of a core and a full tier
    // pass over every instance, every frame, while the view sat idle. The
    // loop keeps ticking (cheap) but does the CPU passes and the two renders
    // only when something moved: the camera, an animating instance, the pane,
    // a tile landing in an atlas, a hover or selection, or any explicit
    // invalidate(). Anything that changes what the field shows must call
    // invalidate(); the lib's takeDirty() covers its own mutations.
    let last = performance.now();
    const seen = { pos: new THREE.Vector3(NaN, NaN, NaN), look: new THREE.Vector3(NaN, NaN, NaN), w: 0, h: 0 };
    const frame = (now) => {
      const dt = Math.min(100, now - last); last = now;
      if (!this.host.hidden) {
        this._tickCamera(now);
        const w = this.host.clientWidth, h = this.host.clientHeight;
        const moved = !seen.pos.equals(this.basePos) || !seen.look.equals(this.lookTarget) || seen.w !== w || seen.h !== h;
        const moving = this.field.tick(dt) > 0;
        if (moved || moving || this._dirty) {
          seen.pos.copy(this.basePos); seen.look.copy(this.lookTarget); seen.w = w; seen.h = h;
          this._dirty = false;
          this.camera.position.copy(this.basePos);
          this.camera.lookAt(this.lookTarget);
          this.camera.updateMatrixWorld();
          this._applySpread();
          // Spend the near atlas on exposed covers / the open stack before
          // hidden members. Otherwise late-month covers get stuck at 64px.
          const readable = this.mode === 'piles'
            ? (this.piles.spreadPile >= 0 ? this.piles.piles[this.piles.spreadPile].indices
              : this.piles.piles.flatMap((_, i) => this.piles.faceOf(i))) : [];
          for (const i of readable) this.field.atlases.request(i, 'near', now);
          if (this.cardHost && this.field.atlases.sourcePathBlank) this.host.classList.remove('sp-cards');
          this._reachOpenStack(h);
          this._labelPass(h);
          const endPass = perf.begin('spatial/pass');
          this.field.update(this.camera, now);
          this.hybrid.update(this.camera);
          this._labelPool();
          this.hybrid.sort(this.camera);
          this.videos?.update(this.camera);
          endPass();
          // Keep group names readable and steady at every zoom level.
          const focal = h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
          for (const label of this.labelObjs) label.scale.setScalar(
            (this.camera.position.z - label.position.z) / focal * 0.55);
          this.field.takeDirty();
          this._render();
        } else {
          // Nothing moved, but a tile landed (or the lib changed an attribute):
          // draw the new pixels, skip the passes. Both calls run every frame:
          // an upload also marks the field dirty, and with `flush() || takeDirty()`
          // that mark survived to the next frame and drew the same pixels again.
          const uploaded = this.field.flush(now), changed = this.field.takeDirty();
          if (uploaded || changed) this._render();
        }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    this._observer = new ResizeObserver(() => {
      if (this.host.hidden || !this.fitted) return;
      if (this.mode === 'piles' && this._generatedPiles && this.piles.spreadPile < 0) this._packPiles();
      else if (this.mode !== 'piles') this._placeField();
      this.fit();
    });
    this._observer.observe(this.host);
  }

  _render() {
    const done = perf.begin('spatial/render');
    this.webglRenderer.render(this.scene, this.camera);
    this.cssRenderer.render(this.scene, this.camera);
    done();
    this.renders = (this.renders || 0) + 1;   // for the perf harness: idle must not count
  }

  /**
   * Perf probe only (off unless ?perf): count atlas tile draws and the bytes
   * each flush sends to the GPU, and expose residency as a gauge. Wraps the
   * vendored lib's instances rather than editing lib/, which is a copy.
   */
  _instrumentField() {
    for (const [tier, atlas] of [['far', this.field.atlases.far], ['near', this.field.atlases.near]]) {
      const draw = atlas.draw.bind(atlas), flush = atlas.flush.bind(atlas);
      atlas.draw = (slot, image) => { const ok = draw(slot, image); if (ok) perf.count(`spatial/draws.${tier}`); return ok; };
      atlas.flush = (t) => {
        const done = perf.begin(`spatial/upload.${tier}`);
        const ok = flush(t); done();
        if (ok) { perf.count(`spatial/uploads.${tier}`); perf.count(`spatial/uploadMB.${tier}`, (atlas.uploadedBytes ?? atlas.bytes) / 1048576); }
        return ok;
      };
    }
    perf.provide('spatial', () => {
      if (!this.field || this.host.hidden) return { open: false };
      const a = this.field.atlases; let far = 0, near = 0, resident = 0;
      for (let i = 0; i < this.field.count; i++) {
        const f = a.farSlot[i] >= 0, n = a.nearSlot[i] >= 0;
        if (f) far++; if (n) near++; if (f || n) resident++;
      }
      const info = this.webglRenderer.info;
      return { open: true, count: this.field.count, resident, far, near, failed: a._failed?.size ?? 0,
        inflight: a._inflight ?? 0, queued: (a._farQueue?.length ?? 0) + (a._nearQueue?.length ?? 0),
        domCards: this.hybrid.live.size, renders: this.renders || 0, atlasMB: Math.round(this.field.bytes / 1048576),
        drawCalls: info.render.calls, textures: info.memory.textures };
    });
  }

  /** Something outside the lib's knowledge changed what the frame shows. */
  invalidate() { this._dirty = true; }

  /**
   * Numeric indices belong to one clip snapshot. The mesh, both atlases, DOM
   * pool, piles, and selection must retire together before those indices can
   * mean different clips. Keep the scene and its input/render lifecycle;
   * replace only the data-dependent resources, using their public disposers.
   */
  _replaceField() {
    this._dirty = true;
    this.hybrid?.dispose();
    this.videos?.dispose();
    this.videos = null;
    this.field?.dispose();
    this.cardHost?.dispose();
    this.cardHost = null;
    this._lastFind = -1;
    this._lastFindKey = '';
    this._findArmed = false;
    // Cards that repaint by themselves (_answering), the run of repaints that
    // gets a card there, cards on trial after their cover lands, each drawable
    // card's cover, and when we last captured each card.
    this._restless = new Set();
    this._streaks = new Map();
    this._trial = new Map();
    this._cardImgs = new Map();
    this._coverSeen = new Map();
    this._capturedAt = new Map();
    this._cardGen = (this._cardGen ?? 0) + 1;
    this._unsubscribePaint?.();
    this._unsubscribePaint = null;

    const clips = this.clips;
    // Both tiers ask for many covers at once; have their sheets decoding first.
    if (spriteCovers.available) { spriteCovers.warm(64); spriteCovers.warm(160); }

    // Drawable cards: source near-tier tiles from live DOM instead of images,
    // so a tile keeps its text in find-in-page and Cmd+F can move the camera.
    // Chrome-only and off unless the API is present; when off, everything
    // below is skipped and the view is byte-for-byte its previous self.
    // `.sp-host[hidden]` is display:none, where a card has no layout box and
    // no paint record — so building the host then would fail every tile
    // permanently. The normal path is safe (wall.mjs unhides before calling
    // setClips) and this guard covers the constructor's first, empty build.
    const drawable = (window.__cwDrawable ?? drawableSupported()) && !this.host.hidden;
    // Sheet-covered cards whose cover is in and painted (_adoptCovered).
    this._cardCovered = new Set();
    // Which items are big enough on screen to wear their title band
    // (_labelPass), and the ones whose near tile is waiting to be redrawn.
    this._labelled = new Uint8Array(Math.max(1, clips.length));
    this._relabel = new Set();
    this._stackLabelled = 0;
    if (drawable && clips.length) {
      // Covers a card will still receive after build() returns (_buildCard).
      this._cardWork = [];
      this.cardHost = new CardHost({
        container: this.host,
        count: clips.length,
        width: CARD_W,
        height: CARD_H,
        // NOT `sp-card`: that class is the DOM-overlay pool, and both the
        // tests and the CSS3D layer select on it. A drawable card is never an
        // overlay. It shares the visual rules via a grouped selector instead.
        className: 'sp-dcard',
        // Same builder as the DOM pool, with the hero proxied: cross-origin
        // content inside a drawable renders blank, and 27% of harvested heroes
        // have no CORS headers.
        build: (i, el) => this._buildCard(i, el, { proxyHero: true }),
      });
      const work = this._cardWork;
      this._cardWork = null;
      void this._armFind(this.cardHost, work);
    }
    // Tiles drawn from cards wear their title band, so the pool's cards show
    // theirs too (spatial.css). Off again if the card path turns out blank
    // and the tiles fall back to plain covers (see the frame loop).
    this.host.classList.toggle('sp-cards', !!this.cardHost);

    this._nearReach = null;
    this.field = new TileField({
      scene: this.scene,
      // The atlas requires nonzero backing dimensions. An empty filter still
      // has zero active instances, so it cannot render or navigate a phantom.
      count: Math.max(1, clips.length),
      nearDistance: NEAR_DISTANCE,
      nearSlots: 256,
      resolve: (i, tier) => {
        const src = sourceFor(clips[i], tier === 'near' ? 256 : 64);
        return src ? proxied(src) : null;
      },
      // Near tier only. The far atlas is the whole corpus resident at once, and
      // there is no reason to pay a capture for a tile that is a few pixels of
      // colour. Returning null for 'far' falls through to the image path.
      // `_capturing` brackets our own drawElementImage calls: a capture
      // repaints the card, and a repaint is indistinguishable from a find at
      // the event level.
      // A cover kept as sprite-sheet cells has no URL for the image path: both
      // tiers draw its cell straight from the decoded sheet, and RETRY waits
      // the frames a page takes to arrive (sprite-covers.mjs). The near tier
      // asks for 160 px, not its 256 px slot: the 256 nearest covers span most
      // of a collection's full-size level (~45 Mpx for the Psychodeli example,
      // over the decode budget, so pages evicted each other and tiles ran out
      // of retries), and the closest ones become DOM cards with the full cell.
      // With a card host, a near tile big enough to read is drawn from its
      // card, title band included; see _nearSource for the rest. The far tier
      // stays the cell or the file: at that size the label goes.
      resolveSource: this.cardHost || spriteCovers.available
        ? (i, tier) => {
          if (tier === 'near') return this._nearSource(i);
          // No cell (its page failed): null takes the image path to the clip's file.
          return spriteCovers.has(clips[i]) && spriteCovers.serves(clips[i], 64)
            ? spriteCovers.source(clips[i], 64) ?? RETRY : null;
        }
        : null,
    });
    this.field.count = clips.length;
    this.field.mesh.count = clips.length;
    this.field.setMotion(this.motion);
    // Per-slot atlas uploads instead of the whole canvas per flush (atlas.js).
    this.field.setRenderer(this.webglRenderer);
    // Items with a video play it over their cover (video-tiles.mjs); each
    // presented frame asks for a render, so the on-demand loop keeps up.
    this.videos = new VideoTiles({
      scene: this.scene, placement: fieldPlacement(this.field),
      sourceOf: (i) => clips[i]?.video || null,
      keyOf: (i) => keyOfClip(clips[i]),
      onFrame: () => this.invalidate(),
      standIns: () => [...(this.hybrid?.live || [])].map(([i, entry]) => [i, entry.el.querySelector('video')]).filter(([, v]) => v),
    });

    this.piles = new PileLayout({
      field: this.field, surface: this.surface, maxVisibleInPile: 8,
      aspectOf: (i) => aspectOfClip(clips[i]),
    });
    this.hybrid = new HybridField({
      scene: this.scene, field: this.field,
      poolSize: 14, basePx: 340, promoteDistance: 0,
      eligible: (i) => this._domEligible(i),
      className: 'sp-card', idPrefix: 'sp-card',
      build: (i, el) => this._buildCard(i, el),
      onActivate: (i) => this._activate(i),
    });
    this._bindCardHover();
    if (perf.enabled) this._instrumentField();
    { const setFocus = this.hybrid.setFocus.bind(this.hybrid); this.hybrid.setFocus = (i) => { setFocus(i); this.invalidate(); }; }
    if (this.nav) {
      this.nav.field = this.field;
      this.nav.hybrid = this.hybrid;
      this.nav.selection = -1;
      this.nav.container.removeAttribute('aria-activedescendant');
      this.nav.live.textContent = '';
    }
    // Find-in-page, measured against Chrome's real find bar (NOT window.find,
    // which takes a different path and gives opposite evidence):
    //
    //   * `changedElements` is exactly the set of cards matching the current
    //     query, narrowing as the user types. It is a precise signal.
    //   * The find bar leaves NO DOM selection, so there is nothing else to
    //     key on.
    //   * Opening or closing the bar repaints every card, as does our own
    //     capture pass — so a whole-corpus set is the one shape to ignore.
    //
    // A find therefore answers with a SET, and the camera fits the set rather
    // than flying to a guessed single match. Scope is untouched either way:
    // this moves the camera and the selection, never `state.filtered`.
    if (this.cardHost) {
      this._unsubscribePaint = this.cardHost.onPaint((painted) => {
        const now = performance.now();
        this._adoptCovered(painted);
        const whole = !painted.length || painted.length === this.clips.length;
        // The cards that could be answering a find; one repainting for a
        // reason of its own is not.
        const indices = whole ? painted : this._answering(painted, now);
        if (!indices.length) return;
        this._cardPaintAt = now;
        if (!this._findArmed || this._capturing || whole) return;
        const key = indices.join(',');
        if (key === this._lastFindKey) return;
        this._lastFindKey = key;
        this._lastFind = indices[0];
        for (const i of indices.slice(0, 32)) this.field.atlases.request(i, 'near');
        this.hybrid?.setFocus(indices[0]);
        this.nav?.select(indices[0]);
        this.fit(indices);
      });
    }

    this._everPlaced = false;
  }



  /**
   * What an item's near tile is drawn from: a source to draw now, RETRY, or
   * null for the image path to the clip's file.
   *
   * With a card host, an item big enough to read (_labelPass) is its card,
   * title band and all; a sheet-covered one only once the card has its cover
   * (_adoptCovered), because a capture before then is a band under an empty
   * hero. An item too small to read is the bare cover: the cell for a
   * sheet-covered item, as without a card host, and otherwise the image the
   * card already holds, which is decoded and needs no request.
   *
   * `_capturing` brackets our own drawElementImage calls: a capture repaints
   * the card, and a repaint is indistinguishable from a find at the event
   * level.
   */
  _nearSource(i) {
    const clip = this.clips[i];
    const sprite = spriteCovers.has(clip);
    if (this.cardHost && !this.host.hidden) {
      if (this._labelled[i] && (!sprite || this._cardCovered.has(i))) {
        const shot = this._capture(i);
        // A sheet cover has no file for the image path: fall back to its cell.
        if (shot || !sprite) return shot;
      } else if (!sprite) {
        const img = this._cardImage(i);
        // A cover the atlas would refuse (an SVG with a foreignObject taints
        // it) is shown through its card, which captures clean, band and all.
        // The alternative is a hole where every other tile has a picture.
        if (img && taintsCanvas(img)) return this._capture(i);
        return img;
      }
    }
    if (!sprite) return null;
    // The near tier asks for 160 px, not its 256 px slot (see resolveSource).
    return spriteCovers.serves(clip, 160) ? spriteCovers.source(clip, 160) ?? RETRY : null;
  }

  /** One card drawn into the host's bitmap, marked so its echo is not a find. */
  _capture(i) {
    this._capturing = true;
    this._capturedAt.set(i, performance.now());
    try { return this.cardHost.capture(i) ?? null; }
    finally { queueMicrotask(() => { this._capturing = false; }); }
  }

  /**
   * The cover a card holds, if it can be drawn into the atlas: loaded, and
   * same-origin, since anything else would taint the atlas canvas. Null sends
   * the tile down the image path, which asks for the file with CORS.
   */
  _cardImage(i) {
    const img = this.cardHost?.elementFor(i)?.querySelector('img.sp-thumb');
    if (!img?.complete || !img.naturalWidth) return null;
    const src = img.currentSrc || img.src;
    if (/^(blob|data):/i.test(src)) return img;
    try { return new URL(src, location.href).origin === location.origin ? img : null; }
    catch { return null; }
  }

  /**
   * Decide which items are big enough on screen to wear their title band, and
   * redraw the near tiles that just crossed the line.
   *
   * The measure is the title's height in CSS px: the card is fitted to the
   * tile, so the tighter of the tile's two axes sets it. An open stack gets
   * ONE answer, from its median member: its rows differ in height by a few
   * pixels, and deciding tile by tile labelled some rows and not others.
   * Elsewhere each item answers for itself, so the near ones are labelled and
   * the ones behind them are not.
   */
  _labelPass(paneHeight) {
    const f = this.field;
    const n = Math.min(f.count, this.clips.length, this._labelled.length);
    const cam = this.camera, eye = cam.position;
    const focal = paneHeight / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)));
    const look = cam.getWorldDirection(this._lookDir ??= new THREE.Vector3());
    const at = this._tileAt ??= new THREE.Vector3();
    const titlePx = (i) => {
      f.worldCentre(i, at);
      const depth = (at.x - eye.x) * look.x + (at.y - eye.y) * look.y + (at.z - eye.z) * look.z;
      if (!(depth > 0)) return 0;
      return CARD_TITLE_PX * Math.min(f.sizes[i * 2] / CARD_W, f.sizes[i * 2 + 1] / CARD_H) * focal / depth;
    };
    const decide = (was, px) => (px >= LABEL_MIN_TITLE_PX * (was ? LABEL_KEEP : 1) ? 1 : 0);
    const set = (i, on) => {
      if (this._labelled[i] === on) return;
      this._labelled[i] = on;
      this._relabel.add(i);
    };

    const open = this.mode === 'piles' && this.piles.spreadPile >= 0 && this._spreadMembers;
    if (open) {
      const px = [];
      for (const i of open) if (i < n) px.push(titlePx(i));
      px.sort((a, b) => a - b);
      const on = decide(this._stackLabelled, px[px.length >> 1] ?? 0);
      this._stackLabelled = on;
      for (const i of open) if (i < n) set(i, on);
    } else {
      this._stackLabelled = 0;
      for (let i = 0; i < n; i++) if (f.isActive(i)) set(i, decide(this._labelled[i], titlePx(i)));
    }

    if (!this.cardHost) { this._relabel.clear(); return; }
    // In place, so a tile never shows an empty slot between its two pictures.
    const tiles = f.atlases;
    let left = RELABEL_PER_FRAME;
    for (const i of this._relabel) {
      if (left <= 0) break;
      this._relabel.delete(i);
      const slot = tiles.nearSlot[i];
      if (slot < 0) continue;                 // drawn in its new state when it is asked for
      left--;
      const source = this._nearSource(i);
      if (source && source !== RETRY && tiles.near.draw(slot, source)) tiles.onTileReady?.(i, 'near');
      else tiles.releaseNear(i);              // the queue draws it, by whatever path is left
    }
    if (this._relabel.size) this._dirty = true;
  }

  /** The pool's cards follow the same answer as the tiles around them. */
  _labelPool() {
    for (const [i, entry] of this.hybrid.live) entry.el?.classList.toggle('sp-small', !this._labelled[i]);
  }

  /**
   * Switch a sheet-covered item's near tile from the bare cell to its card,
   * the first time the card is painted with its cover in.
   *
   * The card gets its cover some time after it is built (_buildCard), and a
   * capture taken before then is a band under an empty hero. The paint that
   * follows the cover is the signal the card is whole.
   */
  _adoptCovered(indices) {
    const tiles = this.field?.atlases;
    if (!tiles || !this.cardHost) return;
    for (const i of indices) {
      if (this._cardCovered.has(i) || !spriteCovers.has(this.clips[i])) continue;
      const img = this.cardHost.elementFor(i)?.querySelector('img.sp-thumb');
      if (!img?.complete || !img.naturalWidth) continue;
      this._cardCovered.add(i);
      // Redraw a tile already holding the cell; one not near yet asks later.
      if (this._labelled[i] && tiles.nearSlot[i] >= 0) { this._relabel.add(i); this._dirty = true; }
    }
  }

  /**
   * The cards in a paint that may be answering a find: the painted ones, minus
   * those repainting for a reason of their own.
   *
   * - A card whose cover is on its way (_coverPending): the image paints as
   *   it arrives.
   * - A card on trial. Its cover has just landed (_coverLanded), which repaints
   *   it, and an animated cover goes on repainting; each repaint extends the
   *   trial. A cover that stays still leaves trial RESTLESS_GAP_MS later.
   * - A restless card: RESTLESS_PAINTS repaints in a row, each within
   *   RESTLESS_GAP_MS of the last. It is animating, and stays out for good.
   * - A card we captured within CAPTURE_ECHO_MS: the capture decoded its
   *   cover, and the card is repainting with it.
   *
   * Runs are counted for a card on trial, and for every card before find is
   * armed, when nothing can be a find. They are not counted for the rest once
   * it is armed: a match being typed repaints its cards as fast as an
   * animation does, and those must keep answering. Our own captures repaint
   * cards too and are not counted, nor is a paint of more than RESTLESS_SET
   * cards: that is the browser repainting the wall, not a card animating.
   */
  _answering(painted, now) {
    const counted = !this._capturing && painted.length <= RESTLESS_SET;
    const out = [];
    for (const i of painted) {
      if (this._restless.has(i)) continue;
      if (this._coverPending(i)) continue;
      if (now - (this._capturedAt.get(i) ?? -Infinity) < CAPTURE_ECHO_MS) continue;
      let onTrial = this._trial.has(i);
      if (onTrial && now > this._trial.get(i)) { this._trial.delete(i); this._streaks.delete(i); onTrial = false; }
      if (onTrial || !this._findArmed) {
        if (counted) {
          const run = this._streaks.get(i);
          const n = run && now - run.last <= RESTLESS_GAP_MS ? run.n + 1 : 1;
          if (n >= RESTLESS_PAINTS) {
            this._restless.add(i); this._streaks.delete(i); this._trial.delete(i);
            continue;
          }
          this._streaks.set(i, { n, last: now });
          if (onTrial) this._trial.set(i, now + RESTLESS_GAP_MS);
        }
        if (onTrial) continue;
      }
      out.push(i);
    }
    return out;
  }

  /** How many cards are on trial now. Finished trials are closed on the way. */
  _trialsOpen(now = performance.now()) {
    for (const [i, until] of this._trial) if (now > until) { this._trial.delete(i); this._streaks.delete(i); }
    return this._trial.size;
  }

  /**
   * Is this card's cover on its way? True from the moment the card's image is
   * given a URL until its load or error event has been handled here.
   *
   * `img.complete` cannot answer this. It turns true, and the card can
   * repaint with the picture, before the load event runs: measured, the paint
   * came about 20 ms ahead of `load` in 3 of 24 late arrivals, and each was
   * read as a find match because the card was not on trial yet.
   */
  _coverPending(i) {
    const img = this._cardImgs.get(i);
    return !!img && !!img.getAttribute('src') && this._coverSeen.get(i) !== img.src;
  }

  /** A card's cover has loaded: the card goes on trial, armed or not. */
  _coverLanded(i) {
    if (!this._restless.has(i)) this._trial.set(i, performance.now() + RESTLESS_GAP_MS);
  }

  /**
   * Arm the find handler once the cards have stopped changing by themselves.
   *
   * A `paint` event that names some cards is the only signal a find-in-page
   * match gives, and anything else that repaints a card looks the same. So the
   * handler stays disarmed until this view is done changing its own cards:
   *
   *   1. the covers a card receives after it is built. A sprite-sheet cell
   *      reaches its <img> when its page has decoded, long after
   *      `CardHost.settled()` looked for images still loading and found none.
   *      Armed that early, every arriving page read as a find: the camera
   *      moved and an item was selected with nobody at the keyboard.
   *   2. `settled()`, for the images that have a src by then.
   *   3. FIND_QUIET_MS without a repaint, for whatever the first two missed.
   *
   * A card that never stops repainting (an animated cover) does not hold this
   * up: it is marked restless and left out, of the wait and of find
   * (_answering). Before that, such a wall either never armed, or armed in a
   * chance gap and then read every frame of the animation as a match.
   */
  async _armFind(host, work = []) {
    const current = () => this.cardHost === host;
    const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    // Bounded: a page that never answers must not hold find off for good.
    await Promise.race([Promise.allSettled(work), pause(FIND_WORK_TIMEOUT_MS)]);
    if (!current()) return;
    await host.settled();
    this._cardPaintAt = performance.now();
    // Quiet, and nobody still on trial: armed means every card whose cover is
    // in will answer. A cover that lands later is tried on its own.
    while (current() && (performance.now() - this._cardPaintAt < FIND_QUIET_MS || this._trialsOpen() > 0)) await pause(100);
    if (current()) this._findArmed = true;
  }

  /* ------------------------------------------------------------ cards --- */

  _buildCard(i, el, { proxyHero = false } = {}) {
    const clip = this.clips[i];
    if (!clip) return;

    const sprite = spriteCovers.has(clip);
    const src = sourceFor(clip, 340) || '';   // the card is authored 340 px wide
    // A video plays in the DOM card too, over its cover as the poster. Not in a
    // drawable card: a capture is one still frame, and the field's own video
    // quad already plays at that distance.
    if (clip.video && !proxyHero) {
      const video = document.createElement('video');
      video.className = 'sp-thumb';
      video.muted = true; video.loop = true; video.playsInline = true;
      // A capture holds every video on its clock (video-tiles.mjs seek()).
      video.autoplay = !this.videos?.frozen;
      if (src && !sprite) video.poster = src;
      video.src = clip.video;
      video.addEventListener('error', () => el.classList.add('broken'), { once: true });
      el.append(video);
    } else if (src || sprite) {
      const img = document.createElement('img');
      img.className = 'sp-thumb';
      // The DOM pool renders a plain <img> and is fine cross-origin. A drawable
      // is not: cross-origin content inside one is dropped from the snapshot,
      // leaving the hero blank while the rest of the card draws.
      const file = src && (proxyHero ? proxied(src) : src);
      if (proxyHero) {
        // A cover repaints its card as it arrives and when it lands, and an
        // animated one never stops. _answering keeps the card out of find
        // while the cover is loading and on trial once it is in. Listening
        // before the source is set covers a sheet cell, which is set later.
        const gen = this._cardGen;
        this._cardImgs.set(i, img);
        // Not once: a card given another cover later is pending, then on
        // trial, again.
        img.addEventListener('load', () => {
          if (gen !== this._cardGen) return;
          this._coverSeen.set(i, img.src);
          this._coverLanded(i);
        });
        img.addEventListener('error', () => { if (gen === this._cardGen) this._coverSeen.set(i, img.src); });
      }
      if (sprite) {
        // A pooled card can be rebuilt for another item before the cell
        // arrives; only an <img> still in its card takes it.
        const landed = spriteCovers.coverUrl(clip, 340 * Math.min(2, window.devicePixelRatio || 1), file).then(url => {
          if (!url || img.parentNode !== el) return null;
          img.src = url;
          // Resolves once the cell is in the card, shown or broken.
          return new Promise(done => {
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
          });
        });
        // A drawable card repaints when this lands, and a repaint is how a
        // find match announces itself; _armFind waits for it.
        if (proxyHero) this._cardWork?.push(landed.catch(() => null)); else void landed;
      } else img.src = file;
      img.alt = '';
      img.draggable = false;
      img.addEventListener('error', () => el.classList.add('broken'), { once: true });
      el.append(img);
    }

    const body = document.createElement('div');
    body.className = 'sp-body';

    const t = document.createElement('div');
    t.className = 'sp-t';
    t.textContent = clip.title || '(untitled)';          // untrusted

    const m = document.createElement('div');
    m.className = 'sp-m';
    m.textContent = [clip.source, clip.captured, (clip.tags || []).join(' · ')]
      .filter(Boolean).join('  ·  ');                     // untrusted

    body.append(t, m);

    // The deep link, on every promoted card. This is the whole division of
    // labour: the wall never edits, and a correction is one click into the
    // real editor. A card that reaches the DOM tier and drops it would make
    // the spatial view a dead end.
    if (clip.editUri) {
      const a = document.createElement('a');
      a.className = 'sp-edit';
      a.href = clip.editUri;
      a.textContent = 'edit in Obsidian';
      a.rel = 'noopener';
      a.addEventListener('click', (e) => e.stopPropagation());
      body.append(a);
    }

    el.append(body);
    el.setAttribute('aria-label', this._label(i));
  }

  _label(i) {
    const clip = this.clips[i];
    if (!clip) return `Item ${i}`;
    const pile = this.mode === 'piles' ? this.piles.pileOf(i) : -1;
    const where = pile >= 0 ? `, in ${this.piles.piles[pile].label}` : '';
    return `${clip.title || 'untitled'}, ${clip.source || 'unknown source'}${where}`;
  }

  /**
   * Hover for the DOM twins. The pool elements are persistent, so this runs
   * once per pool and reads entry.index at event time rather than closing over
   * it — a pool entry is a different item a second from now.
   */
  _bindCardHover() {
    for (const entry of this.hybrid.pool) {
      if (entry.el.dataset.hoverBound) continue;
      entry.el.dataset.hoverBound = '1';
      // pointermove, not pointerenter: enter fires only on crossing the border,
      // so a preview switched on while the pointer already rests on a card
      // would wait for the pointer to leave and come back.
      entry.el.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch' || e.buttons !== 0 || !this.hoverEnabled()) return;
        if (entry.index < 0 || entry.index === this._hovered) return;
        const clip = this._hoverTarget(entry.index);
        if (!clip) return;
        if (this._hoverFrame) { cancelAnimationFrame(this._hoverFrame); this._hoverFrame = 0; }
        this._queueHover(entry.index);
      });
      entry.el.addEventListener('pointerleave', (e) => {
        if (e.pointerType === 'touch') return;
        if (entry.index >= 0 && (entry.index === this._hovered || entry.index === this._hoverCandidate)) this._endHover();
      });
    }
  }

  /** Resolve the item under the pointer and report it, once per frame. */
  _pickHover(clientX, clientY) {
    if (!this.built || !this.hoverEnabled()) return this._endHover();
    const r = this.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const hit = this.field.pickAt(((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1, this.camera);
    if (hit === this._hovered && this._hoverCandidate < 0) return; // same settled item
    const clip = hit >= 0 ? this._hoverTarget(hit) : null;
    if (clip) this._queueHover(hit); else this._endHover();
  }

  _queueHover(index) {
    if (this._cameraMotion || index === this._hovered || index === this._hoverCandidate) return;
    this._endHover();
    this._hoverCandidate = index;
    this._hoverTimer = setTimeout(() => {
      this._hoverTimer = 0; this._hoverCandidate = -1;
      if (!this.hoverEnabled() || this._cameraMotion) return;
      const clip = this._hoverTarget(index);
      if (clip) { this._hovered = index; this.onHover(clip); if (this._applySpread(true)) this.invalidate(); }
    }, 120);
  }

  /** Only a fresh pointer move may establish intent after camera/layout work. */
  cancelHover() { this._endHover(); }

  _notifyInteraction() { this.cancelHover(); this.onInteraction(); }

  _endHover() {
    clearTimeout(this._hoverTimer); this._hoverTimer = 0; this._hoverCandidate = -1;
    if (this._hoverFrame) { cancelAnimationFrame(this._hoverFrame); this._hoverFrame = 0; }
    if (this._hovered === -1) return;
    this._hovered = -1;
    if (this._applySpread(true)) this.invalidate();
    this.onHoverEnd();
  }

  /**
   * The clip a hit would open, or null. A collapsed pile is not an item — a
   * click there spreads the stack — so hovering one must not preview anything.
   * Mirrors _activate()'s branch deliberately: the two must agree, or hover
   * shows one thing and the click that follows does another.
   */
  _hoverTarget(i) {
    if (this.mode === 'piles') {
      const pile = this.piles.pileOf(i);
      if (pile >= 0 && this.piles.spreadPile !== pile) return null;
    }
    return this.clips[i] || null;
  }

  _activate(i) {
    this._notifyInteraction();
    if (this.mode === 'piles') {
      const pile = this.piles.pileOf(i);
      if (pile >= 0 && this.piles.spreadPile !== pile) {
        this.hybrid.setFocus(-1);
        if (this.piles.spreadPile < 0) {
          this._returnPose = this._cameraPose();
          this._returnBox = this._box?.clone();
          this._returnLabels = this.labelObjs.map(label => label.position.clone());
        }
        if (this.piles.spreadPile >= 0) this._collapsePile(this.piles.spreadPile, { animate: true });
        this.piles.spread(pile, { columns: Math.max(1, Math.round(Math.sqrt(
          this.piles.piles[pile].indices.length * this.camera.aspect / 1.5))) });
        // Browsing an open stack uses the existing justified layout so mixed
        // image proportions fill the pane without overlapping their neighbours.
        const corners = this._spread(pile, { animate: true });
        this._labels();
        this.fit(this.piles.piles[pile].indices, { animate: true, corners });
        return;
      }
    }
    const clip = this.clips[i];
    if (clip) this.onOpen(clip);
  }

  /* ------------------------------------------------------------ data ---- */

  /**
   * Show a filtered set. Called with whatever the facet rail has narrowed to,
   * so the spatial view and the flat wall always agree about what is in scope.
   */
  setClips(clips, groupKey = 'none', { corpus = null, revision = null } = {}) {
    // Two ways to be called. With a `corpus` (the app: the whole clip index
    // and its server revision), the field is allocated for the corpus once
    // and `clips` is MEMBERSHIP — a filter change is a mask over resident
    // instances, never a rebuild. Without one (fixtures, older callers) the
    // clips are the corpus, and content, not just ids, decides whether it
    // changed: an editor may retitle a note or change its cover without
    // changing its id/URL, including by mutating an object already supplied.
    this._returnPose = null;
    this._notifyInteraction();
    const all = corpus || clips;
    const snapshot = revision !== null ? `rev:${revision}:${all.length}` : JSON.stringify(all);
    const replace = this.built && (snapshot !== this._clipSnapshot || all !== this.clips);
    this.clips = all;
    this.groupKey = groupKey;
    this._ensureScene();
    if (replace) this._replaceField();
    this._clipSnapshot = snapshot;
    if (replace || !this._indexOf) this._indexOf = new Map(all.map((clip, i) => [clip, i]));
    this._setMembership(corpus ? clips.map(clip => this._indexOf.get(clip)).filter(i => i !== undefined) : all.map((_, i) => i));
    this._show();
  }

  /**
   * While a stack is open, let the near tier reach all of it.
   *
   * The lib grants a near slot by world distance, which stands in for "large
   * on screen" only while the camera is close. A big stack opened in a small
   * pane is fitted from further back than that, and every one of its tiles
   * was then a 64 px far tile drawn two or three times that size: soft, and
   * without the title band a tile drawn from its card carries. So while a
   * stack is open the reach is extended to where its largest tile is still
   * drawn larger than a far tile holds. Only that stack is drawn then
   * (_applyVisibility), so the near pool is not spent on anything else.
   *
   * The field's own reach is put back when the stack closes and is never
   * touched otherwise: it is a setting others may change.
   */
  _reachOpenStack(paneHeight) {
    const open = this.mode === 'piles' && this.piles.spreadPile >= 0 && this._spreadMembers;
    if (!open) {
      if (this._nearReach != null) { this.field.nearDistance = this._nearReach; this._nearReach = null; }
      return;
    }
    this._nearReach ??= this.field.nearDistance;
    const focal = paneHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    const sizes = this.field.sizes;
    let longest = 0;
    for (const i of open) longest = Math.max(longest, sizes[i * 2], sizes[i * 2 + 1]);
    this.field.nearDistance = Math.max(this._nearReach, longest * focal / FAR_TILE_PX);
  }

  /**
   * Draw what is in scope and, while a stack is open, only that stack.
   *
   * An open stack is laid out on its own plane in front of the others, which
   * stay where they stand. Left drawn, they show through every gap in the open
   * tray and take the clicks that land there, which closes the stack being
   * read. Their labels are already hidden while one is open (_labels); this
   * hides the tiles the same way a scope change does, so they keep their
   * placement and their atlas slots and return as they were.
   */
  _applyVisibility() {
    const scope = this._inScope;
    const open = this.mode === 'piles' && this.piles?.spreadPile >= 0 ? this._spreadMembers : null;
    for (let i = 0; i < this.field.count && i < this.clips.length; i++) {
      this.field.setActive(i, (!scope || scope.has(i)) && (!open || open.has(i)));
    }
    this._dirty = true;
  }

  /** Which corpus indices are in scope. Everything else is hidden in place. */
  _setMembership(indices) {
    this.active = indices;
    const inScope = new Set(indices);
    this._inScope = inScope;
    this._applyVisibility();
    if (this.nav && this.nav.selection >= 0 && !inScope.has(this.nav.selection)) {
      // A filtered-out selection is no selection.
      this.hybrid.setFocus(-1);
      this.nav.selection = -1;
      this.nav.container.removeAttribute('aria-activedescendant');
    }
    this._dirty = true;
  }

  /** Lay the in-scope field out flat and frame it. */
  _show() {
    this._returnPose = null;
    this._notifyInteraction();
    if (this._trayRim) this._trayRim.visible = false;
    if (this.piles.spreadPile >= 0) this._collapsePile(this.piles.spreadPile);
    this.hybrid.promoteDistance = 0;
    this.mode = 'mountain'; // retained version-1 view-state name for the field
    this._generatedPiles = false;
    this._placeField();
    this._labels();
    this.fit();
  }

  _composition(clips, gap = 14) {
    // The similarity map and grid keep the flat wall's places (same corpus,
    // same projection); every other key lays the field out as justified rows.
    const key = isSimilarity(this.groupKey) ? this.groupKey : 'none';
    return layout(clips, key, { viewportAspect: this.camera.aspect, gap, universe: this.clips });
  }

  _placeField() {
    const active = this.active || [];
    const result = this._composition(active.map(i => this.clips[i]));
    // The similarity map spreads on zoom: keep each tile's base place so the
    // frame loop can resize it around its centre (_applySpread).
    this._spreadBase = this.groupKey === SIMILARITY ? new Map() : null;
    result.tiles.forEach((t, k) => {
      const i = active[k];
      this.field.place(i, t.x + t.w / 2, -t.y - t.h / 2, 0, t.w, t.h);
      this.field.setRow(i, 0);
      this._spreadBase?.set(i, { x: t.x + t.w / 2, y: -t.y - t.h / 2, w: t.w, h: t.h });
    });
    this._spreadZ = NaN;
    this.field.layout();
  }

  /**
   * Hold every similarity-map tile inside SPREAD_BAND screen pixels for the
   * current camera distance; the hovered tile alone grows to HOVER_PX and
   * steps forward. Writes instance sizes only when the distance changed by
   * more than 0.2% (or `force`), so a settled camera costs nothing.
   */
  _applySpread(force = false) {
    if (!this._spreadBase || this.mode !== 'mountain') return false;
    const z = Math.max(1, this.basePos.z), h = this.host.clientHeight || 1;
    if (!force && Math.abs(z - this._spreadZ) / z < 0.002) return false;
    this._spreadZ = z;
    const focal = h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    for (const [i, b] of this._spreadBase) {
      const natural = Math.max(b.w, b.h) * focal / z;
      const k = i === this._hovered ? Math.max(HOVER_PX, natural) / natural : spreadScale(natural);
      this.field.place(i, b.x, b.y, i === this._hovered ? 1 : 0, b.w * k, b.h * k);
    }
    this.field.layout();
    return true;
  }

  _spread(index, { animate = false } = {}) {
    { const p = this.piles.piles[index]; if (p?.all) p.indices = p.all; } // a spread shows every member, shared ones included
    const pile = this.piles.piles[index];
    const result = this._composition(pile.indices.map(i => this.clips[i]));
    result.tiles.forEach((t, k) => {
      const i = pile.indices[k];
      this.field.moveTo(i, pile.u + t.x + t.w / 2 - result.width / 2,
        pile.v - t.y - t.h / 2 + result.height / 2, 140, t.w, t.h, new THREE.Quaternion());
      this.field.setRow(i, 0);
    });
    if (!animate || this._reducedMotion()) for (const i of pile.indices) this.field.settle(i);
    this._spreadMembers = new Set(pile.indices);
    this._applyVisibility();
    this._spreadExtent = { x: pile.u, top: pile.v + result.height / 2 };
    // A shallow, non-interactive rim keeps the open tray legible as a place.
    // It never takes a card's hit target or changes collection membership.
    if (!this._trayRim) {
      this._trayRim = new THREE.LineLoop(new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x8fd9ff, transparent: true, opacity: 0.42 }));
      this.scene.add(this._trayRim);
    }
    const x0 = pile.u - result.width / 2 - 12, x1 = pile.u + result.width / 2 + 12;
    const y0 = pile.v - result.height / 2 - 12, y1 = pile.v + result.height / 2 + 12;
    this._trayRim.geometry.dispose();
    this._trayRim.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x0, y0, 139), new THREE.Vector3(x1, y0, 139),
      new THREE.Vector3(x1, y1, 139), new THREE.Vector3(x0, y1, 139)]);
    this._trayRim.visible = true;
    this.field.layout();
    return [new THREE.Vector3(pile.u - result.width / 2, pile.v - result.height / 2, 140),
      new THREE.Vector3(pile.u + result.width / 2, pile.v + result.height / 2, 140)];
  }

  _packPiles() {
    const covers = this.piles.piles.map((p, i) => ({ id: String(i), props: {
      // A pile placed nothing (every member stands elsewhere) still needs a footprint.
      dims: [`${Math.round((p.indices.length ? aspectOfClip(this.clips[p.indices.at(-1)]) : 1) * 1000)}x1000`]
    }}));
    const result = this._composition(covers, 90);
    result.tiles.forEach((t, i) => {
      Object.assign(this.piles.piles[i], { u: t.x + t.w / 2, v: -t.y - t.h, w: t.w, h: t.h });
      this._collapsePile(i);
    });
    this._labels();
  }

  _collapsePile(index, { animate = false } = {}) {
    const pile = this.piles.piles[index];
    const borrowed = !!pile?.exclusive && pile.indices.length !== pile.exclusive.length;
    const owned = borrowed ? new Set(pile.exclusive) : null;
    const borrowedMembers = borrowed ? new Set(pile.indices.filter(i => !owned.has(i))) : null;
    const owners = borrowed ? this.piles.piles.map((p, i) => ({ p, i })).filter(({ p, i }) =>
      i !== index && (p.exclusive || p.indices).some(member => borrowedMembers.has(member))) : [];
    // Compute canonical collapsed geometry once, then move from the visible
    // pose. Borrowed members return to their own tray in the same transition.
    const affected = [...pile.indices, ...owners.flatMap(({ p }) => p.exclusive || p.indices)];
    const starts = animate && !this._reducedMotion() ? new Map([...new Set(affected)].map(i => [i, this._placement(i)])) : null;
    if (pile?.exclusive) pile.indices = pile.exclusive; // give shared members back to their own piles
    const wasOpen = this.piles.spreadPile === index;
    this.piles.collapse(index, true);
    if (wasOpen) this._applyVisibility();   // the other stacks come back as this one closes
    // Shared members the spread borrowed were moved; their owning piles re-place them.
    for (const { i } of owners) this._collapsePile(i);
    // A stack has a stable cover footprint. Contain banners/portraits within
    // it, retaining proportions; expanding reveals each image at full size.
    // Face members are already contained in their cells by the layout.
    const face = new Set(this.piles.faceOf(index));
    for (const i of pile.indices) {
      if (face.has(i)) continue;
      const w = this.field.sizes[i * 2], h = this.field.sizes[i * 2 + 1];
      const scale = Math.min(pile.w / w, pile.h / h);
      const c = this.field.worldCentre(i, new THREE.Vector3());
      const q = this.field.worldOrientation(i, new THREE.Quaternion());
      this.field.moveTo(i, c.x, c.y, c.z, w * scale, h * scale, q);
      this.field.settle(i);
    }
    if (starts) for (const [i, from] of starts) {
      const to = this._placement(i);
      this.field.place(i, ...from.position, ...from.size, from.rotation);
      this.field.moveTo(i, ...to.position, ...to.size, to.rotation);
    }
    this.field.layout();
  }

  _placement(i) {
    return { position: this.field.worldCentre(i, new THREE.Vector3()).toArray(),
      size: [this.field.sizes[i * 2], this.field.sizes[i * 2 + 1]],
      rotation: this.field.worldOrientation(i, new THREE.Quaternion()) };
  }

  collapse() {
    if (this.piles.spreadPile >= 0) {
      this._notifyInteraction();
      if (this._trayRim) this._trayRim.visible = false;
      this._collapsePile(this.piles.spreadPile, { animate: true });
      this._labels();
      const origin = this._returnPose; this._returnPose = null;
      if (origin) {
        this._box = this._returnBox || null;
        // The tray labels are landmarks, not followers of their moving cards.
        this._returnLabels?.forEach((position, i) => this.labelObjs[i]?.position.copy(position));
        this._returnLabels = null;
        this._moveCamera(origin, { animate: true });
      }
      else this.fit();
    }
    this.hybrid.setFocus(-1);
  }

  /**
   * The world box of what is currently being shown: the spread pile, or the
   * whole field with its pile labels. Fit frames it; pan is bounded by it.
   */
  _measure(indices = null) {
    if (!indices && this.piles.spreadPile >= 0) indices = this.piles.piles[this.piles.spreadPile].indices;
    indices ||= this.active || [];
    const corners = [];
    const q = new THREE.Quaternion();
    for (const i of indices) {
      const c = this.field.worldCentre(i, new THREE.Vector3());
      this.field.worldOrientation(i, q);
      for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) {
        corners.push(new THREE.Vector3(x * this.field.sizes[i * 2], y * this.field.sizes[i * 2 + 1], 0).applyQuaternion(q).add(c));
      }
    }
    if (!corners.length) return null;
    if (this.mode === 'piles' && this.piles.spreadPile < 0) {
      this.labelObjs.forEach((label, i) => {
        if (!label.visible) return;
        const p = label.position, w = this.piles.piles[i].w;
        corners.push(new THREE.Vector3(p.x - w / 2, p.y + 18, p.z));
        corners.push(new THREE.Vector3(p.x + w / 2, p.y + 18, p.z));
      });
    }
    this._box = new THREE.Box3().setFromPoints(corners);
    this._corners = corners;
    return this._box;
  }

  /** Fit actual card corners, including depth and pile labels, into the pane. */
  fit(indices = null, { animate = false, corners = null } = {}) {
    if (!this.built) return;
    const box = corners ? new THREE.Box3().setFromPoints(corners) : this._measure(indices);
    if (!box) return;
    corners ||= this._corners;
    this._box = box;
    const centre = box.getCenter(new THREE.Vector3());
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const rect = this.host.getBoundingClientRect();
    const inset = Math.min(32, rect.width * 0.04, rect.height * 0.04);
    const fx = Math.max(0.1, 1 - 2 * inset / rect.width), fy = Math.max(0.1, 1 - 2 * inset / rect.height);
    let z = 150;
    for (const p of corners) z = Math.max(z, p.z + Math.abs(p.x - centre.x) / (tan * this.camera.aspect * fx),
      p.z + Math.abs(p.y - centre.y) / (tan * fy));
    // A sparse arrangement (the similarity map) fits from further away than the
    // scene's default far plane; past it the whole field is clipped to black.
    if (z * 1.25 > this.camera.far) { this.camera.far = z * 1.5; this.camera.updateProjectionMatrix(); }
    this._moveCamera({ position: [centre.x, centre.y, z], target: [centre.x, centre.y, 0], fitted: true }, { animate });
  }

  fitView() {
    if (this.mode === 'piles') {
      if (this.piles.spreadPile >= 0) this._spread(this.piles.spreadPile);
      else if (this._generatedPiles) this._packPiles();
    } else this._placeField();
    this.fit();
  }

  /**
   * Pan only where there is clipped content to reveal. Per axis, the visible
   * half-extent at the camera's distance from the content plane says whether
   * the box overflows the pane: if it does, the camera may travel between the
   * positions that bring either edge to the pane's edge; if it fits, a fully
   * visible axis is frozen and a partly clipped one may only come back into
   * view. Sliding a wholly visible field around is motion without information.
   */
  panTo(x, y) {
    this._interruptCamera();
    const box = this._box || this._measure();
    if (box) {
      const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      const halfH = Math.max(1, this.basePos.z - box.max.z) * tan, halfW = halfH * this.camera.aspect;
      x = clampPan(this.basePos.x, x, box.min.x, box.max.x, halfW);
      y = clampPan(this.basePos.y, y, box.min.y, box.max.y, halfH);
    }
    if (x === this.basePos.x && y === this.basePos.y) return;
    this.basePos.x = this.lookTarget.x = x;
    this.basePos.y = this.lookTarget.y = y;
    this.fitted = false;
  }

  panBy(dx, dy) {
    const plane = this.piles.spreadPile >= 0 ? 140 : 0;
    const unit = 2 * Math.max(1, this.basePos.z - plane) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / this.host.clientHeight;
    this.panTo(this.basePos.x - dx * unit, this.basePos.y + dy * unit);
  }

  zoomBy(factor, clientX, clientY) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this._interruptCamera();
    const rect = this.host.getBoundingClientRect();
    const nx = Number.isFinite(clientX) ? 2 * (clientX - rect.left) / rect.width - 1 : 0;
    const ny = Number.isFinite(clientY) ? 1 - 2 * (clientY - rect.top) / rect.height : 0;
    const oldZ = this.basePos.z;
    const plane = this.piles.spreadPile >= 0 ? 140 : 0;
    const z = Math.min(12000, Math.max(250, plane + (oldZ - plane) / factor));
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    // The reading plane's depth cancels from the old/new ray difference.
    this.basePos.x += nx * (oldZ - z) * tan * this.camera.aspect;
    this.basePos.y += ny * (oldZ - z) * tan;
    this.lookTarget.x = this.basePos.x; this.lookTarget.y = this.basePos.y;
    this.basePos.z = z;
    this.fitted = false;
    this._syncCamera();
  }

  _reducedMotion() { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; }

  _cameraPose() {
    return { position: this.basePos.toArray(), target: this.lookTarget.toArray(), fitted: this.fitted };
  }

  _syncCamera() {
    this.camera.position.copy(this.basePos); this.camera.lookAt(this.lookTarget);
    this.camera.updateMatrixWorld(); this.invalidate();
  }

  _interruptCamera() { this._cameraMotion = null; this._notifyInteraction(); }

  _moveCamera(pose, { animate = false, duration = 300 } = {}) {
    this._interruptCamera();
    if (!animate || this._reducedMotion()) {
      this.basePos.fromArray(pose.position); this.lookTarget.fromArray(pose.target);
      this.fitted = pose.fitted; this._syncCamera(); return;
    }
    this._cameraMotion = { from: this._cameraPose(), to: pose, start: performance.now(), duration };
    this.fitted = false;
    this.invalidate();
  }

  _tickCamera(now) {
    const motion = this._cameraMotion;
    if (!motion) return;
    const t = Math.min(1, Math.max(0, (now - motion.start) / motion.duration));
    const k = this._reducedMotion() ? 1 : 1 - (1 - t) ** 3;
    this.basePos.set(...motion.from.position.map((v, i) => v + (motion.to.position[i] - v) * k));
    this.lookTarget.set(...motion.from.target.map((v, i) => v + (motion.to.target[i] - v) * k));
    if (k === 1) {
      this.basePos.fromArray(motion.to.position); this.lookTarget.fromArray(motion.to.target);
      this.fitted = motion.to.fitted; this._cameraMotion = null;
    }
    this.invalidate();
  }

  /** Viewport rectangle of this identity's currently rendered quad. */
  originRectangle(clipOrKey) {
    if (!this.built || !clipOrKey) return null;
    const key = typeof clipOrKey === 'string' ? clipOrKey : keyOfClip(clipOrKey);
    const i = this.clips.findIndex(clip => keyOfClip(clip) === key);
    if (i < 0 || !this.field.isActive(i)) return null;
    const rect = this.host.getBoundingClientRect(), { position, size, rotation } = this._placement(i);
    const centre = new THREE.Vector3(...position);
    const points = [-.5, .5].flatMap(x => [-.5, .5].map(y =>
      new THREE.Vector3(x * size[0], y * size[1], 0).applyQuaternion(rotation).add(centre).project(this.camera)));
    const left = rect.left + (Math.min(...points.map(p => p.x)) + 1) * rect.width / 2;
    const top = rect.top + (1 - Math.max(...points.map(p => p.y))) * rect.height / 2;
    const width = (Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x))) * rect.width / 2;
    const height = (Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y))) * rect.height / 2;
    return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height };
  }

  _domEligible(i) {
    if (this.mode === 'piles' && !(this.piles.spreadPile >= 0 ? this._spreadMembers?.has(i) : this._pileTops?.has(i))) return false;
    const c = this.field.centres, s = this.field.sizes;
    const depth = this.camera.position.z - c[i * 3 + 2];
    if (depth <= 0) return false;
    const halfH = depth * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const halfW = halfH * this.camera.aspect;
    if (Math.abs(c[i * 3] - this.camera.position.x) > halfW + s[i * 2] / 2 ||
        Math.abs(c[i * 3 + 1] - this.camera.position.y) > halfH + s[i * 2 + 1] / 2) return false;
    const px = Math.min(s[i * 2], s[i * 2 + 1]) * this.host.clientHeight / (2 * halfH);
    return px >= (this.hybrid?.live.has(i) ? 56 : 72);
  }

  /* ----------------------------------------------------------- piles ---- */

  /** Facet values become piles. Multi-valued facets put a clip in several. */
  showPiles(facetKey) {
    this._returnPose = null;
    this._notifyInteraction();
    if (this._trayRim) this._trayRim.visible = false;
    // Share date buckets and multi-valued membership with the flat layout.
    const indexOf = this._indexOf || new Map(this.clips.map((clip, i) => [clip, i]));
    const active = this.active || [];
    // One quad per clip: a clip in several groups (multi-valued facets) can
    // stand in only one pile. It is placed in the smallest group it belongs
    // to, so small piles keep their members and large piles lose few; every
    // pile keeps its true count and full membership, and a spread pile
    // temporarily borrows its shared members.
    const raw = groupBy(active.map(i => this.clips[i]), facetKey).map(({ label, clips }) => ({ label, all: clips.map(clip => indexOf.get(clip)) }));
    const placed = new Set();
    for (const g of [...raw].sort((a, b) => a.all.length - b.all.length)) {
      g.indices = g.all.filter(i => !placed.has(i));
      for (const i of g.indices) placed.add(i);
    }
    const groups = raw.map(g => ({ label: g.label, indices: g.indices, all: g.all, count: g.all.length }));

    this.mode = 'piles';
    this.hybrid.promoteDistance = Infinity;
    this.hybrid.setFocus(-1);
    this.piles.arrange(groups);
    this.piles.piles.forEach((p, i) => { p.exclusive = groups[i].indices; p.all = groups[i].all; p.count = groups[i].count; });
    this._generatedPiles = true;
    this._packPiles();
    this.fit();
    return groups.length;
  }

  showMountain(arrangement = this.groupKey) {
    // The field's arrangement: 'none' (justified rows) or the similarity map.
    this.groupKey = arrangement;
    this._show();
  }

  _stepPile(dir) {
    if (this.mode !== 'piles' || !this.piles.piles.length) return;
    const cur = this.piles.pileOf(this.nav.selection);
    const next = ((cur < 0 ? 0 : cur + dir) + this.piles.piles.length) % this.piles.piles.length;
    const pile = this.piles.piles[next];
    if (!pile.indices.length) return;
    this.nav.select(pile.indices[pile.indices.length - 1]);
    this.nav.announce(`${pile.label}, ${pile.indices.length} clips`);
  }

  _jumpPile(prefix) {
    if (this.mode !== 'piles') return null;
    const hit = this.piles.piles.findIndex((p) => p.label.toLowerCase().startsWith(prefix));
    if (hit < 0 || !this.piles.piles[hit].indices.length) return null;
    const pile = this.piles.piles[hit];
    this.nav.select(pile.indices[pile.indices.length - 1]);
    this.nav.announce(`${pile.label}, ${pile.indices.length} clips`);
    return hit;
  }

  /** One CSS3D label per pile. Nodes only — labels are facet values, which are
   *  scraped strings like any other. */
  _labels() {
    this._dirty = true;
    // Exposed covers: every member on a pile's contact-sheet face may be promoted to DOM.
    this._pileTops = new Set(this.piles.piles.flatMap((_, i) => this.piles.faceOf(i)));
    for (const o of this.labelObjs) o.visible = false;
    this.backButton.hidden = this.mode !== 'piles' || this.piles.spreadPile < 0;
    if (!this.backButton.hidden) {
      const pile = this.piles.piles[this.piles.spreadPile];
      this.backButton.textContent = `← All stacks · ${pile.label} · ${pile.indices.length} items`;
    }
    if (this.mode !== 'piles') return;
    this.piles.labelAnchors().forEach((a, i) => {
      let obj = this.labelObjs[i];
      if (!obj) {
        const n = document.createElement('span'); n.className = 'n';
        const c = document.createElement('span'); c.className = 'c';
        obj = makePlane([n, c], { className: 'sp-pile-label' });
        obj.userData.parts = { n, c };
        this.scene.add(obj);
        this.labelObjs[i] = obj;
      }
      obj.userData.parts.n.textContent = a.label;         // untrusted
      obj.userData.parts.c.textContent = String(this.piles.piles[i].count ?? a.count);
      const members = this.piles.piles[i].indices;
      let top = -Infinity, front = a.z;
      for (const j of members) {
        top = Math.max(top, this.field.centres[j * 3 + 1] + this.field.sizes[j * 2 + 1] * 0.53);
        front = Math.max(front, this.field.centres[j * 3 + 2]);
      }
      obj.position.set(a.x, (Number.isFinite(top) ? top : a.y) + 10, front + 5);
      obj.scale.setScalar(Math.max(0.9, a.width / 440));
      const opened = this.piles.spreadPile === i;
      if (opened && this._spreadExtent) obj.position.set(this._spreadExtent.x, this._spreadExtent.top + 20, 145);
      obj.visible = this.piles.spreadPile < 0 || opened;
    });
  }

  /* ------------------------------------------------------ view state ---- */

  captureView() {
    if (!this.built) return null;
    return {
      mode: this.mode,
      arrangement: { version: 1, piles: this.piles.piles.map(p => ({
        label: p.label, u: p.u, v: p.v, w: p.w, h: p.h,
        keys: p.indices.map(i => keyOfClip(this.clips[i])),
      })) },
      spread: this.piles.spreadPile,
      position: this.basePos.toArray(), target: this.lookTarget.toArray(),
      fitted: this.fitted, aspect: this.camera.aspect,
      selection: this.clips[this.nav.selection] ? keyOfClip(this.clips[this.nav.selection]) : null,
    };
  }

  restoreView(view) {
    this._returnPose = null;
    this._interruptCamera();
    if (view.mode === 'piles') {
      this.restore(view.arrangement);
      view.arrangement.piles.forEach((saved, i) => {
        Object.assign(this.piles.piles[i], { u: saved.u, v: saved.v, w: saved.w || 220, h: saved.h || 150 });
        this._collapsePile(i);
      });
      if (view.spread >= 0 && this.piles.piles[view.spread]?.indices.length) {
        this.piles.spread(view.spread);
        this._spread(view.spread);
      }
      this._labels();
    } else this.showMountain();
    const selected = (this.active || []).find(i => keyOfClip(this.clips[i]) === view.selection) ?? -1;
    if (selected >= 0) this.nav.select(selected);
    if (view.fitted) this.fit();
    else {
      this.basePos.fromArray(view.position); this.lookTarget.fromArray(view.target);
      // A narrower screen needs proportionally more camera distance.
      if (Math.abs(this.camera.aspect - view.aspect) > .001)
        this.basePos.z = this.lookTarget.z + (this.basePos.z - this.lookTarget.z) * Math.max(1, view.aspect / this.camera.aspect);
      this.fitted = false;
      this.camera.position.copy(this.basePos); this.camera.lookAt(this.lookTarget); this.camera.updateMatrixWorld();
    }
  }

  /** Capture piles as portable, URL-keyed view state. */
  serialize() {
    return this.piles.serialize((i) => {
      const clip = this.clips[i];
      return clip ? keyOfClip(clip) : null;
    });
  }

  /** @returns {{restored:number, orphaned:string[]}} */
  restore(state) {
    if (this._trayRim) this._trayRim.visible = false;
    // Only in-scope items resolve; a hidden member is unresolved for this view
    // and survives in the saved state like any other unresolved key.
    const byKey = new Map();
    for (const i of this.active || []) byKey.set(keyOfClip(this.clips[i]), i);
    const result = this.piles.restore(state, (k) => (byKey.has(k) ? byKey.get(k) : -1));
    // Saved piles may share members too: place each clip in its smallest pile,
    // keep the full membership for spreading and the true count for the label.
    { const placed = new Set();
      for (const p of [...this.piles.piles].sort((a, b) => a.indices.length - b.indices.length)) {
        p.all = p.indices; p.count = p.indices.length;
        p.exclusive = p.all.filter(i => !placed.has(i)); for (const i of p.exclusive) placed.add(i);
        p.indices = p.exclusive;
      } }
    this.mode = 'piles';
    this.hybrid.promoteDistance = Infinity;
    this._generatedPiles = false;
    for (let p = 0; p < this.piles.piles.length; p++) this._collapsePile(p);
    this._labels();
    this.fit();
    return result;
  }

  /* --------------------------------------------------------- pointer ---- */

  _bindPointer() {
    const el = this.host;
    let down = null;
    const touches = new Map();
    let pinch = null;
    const touchPose = () => {
      const [a, b] = [...touches.values()];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
    };
    el.addEventListener('wheel', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.ctrlKey || e.metaKey) this.zoomBy(Math.exp(-e.deltaY * 0.008), e.clientX, e.clientY);
      else this.panBy(-e.deltaX, -e.deltaY);
    }, { passive: false });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('a, button')) return;
      e.stopPropagation();
      this._interruptCamera();
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size >= 2) {
          if (touches.size === 2) pinch = touchPose();
          down = null; this._dragged = true;
          el.setPointerCapture(e.pointerId);
          return;
        }
      }
      down = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false };
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size >= 2) {
          e.stopPropagation();
          const next = touchPose();
          if (pinch?.distance > 0 && next.distance > 0) {
            this.zoomBy(next.distance / pinch.distance, pinch.x, pinch.y);
            this.panBy(next.x - pinch.x, next.y - pinch.y);
          }
          pinch = next;
          return;
        }
      }
      if (!down) return;
      e.stopPropagation();
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) down.moved = true;
      if (down.moved) {
        this.panBy(e.clientX - down.lastX, e.clientY - down.lastY);
        el.setPointerCapture(e.pointerId);
      }
      down.lastX = e.clientX; down.lastY = e.clientY;
    });
    // Hover picks its own target rather than riding the drag handler above,
    // which returns early unless a button is down. pickAt measured 0.28 ms mean
    // / 0.4 ms p95 over 1793 instances (~1.6% of a 60fps frame), so the cost is
    // affordable — but pointermove fires several times per frame, so coalesce
    // to one pick per frame, and ask hoverEnabled() first so a field nobody is
    // previewing pays nothing at all.
    el.addEventListener('pointermove', (e) => {
      if (down || e.pointerType === 'touch' || e.buttons !== 0) return;
      // A promoted card owns its own hover, the same way pickAt() already skips
      // suppressed instances so the DOM twin takes the click. Without this the
      // field would pick -1 under every near card and cancel the preview the
      // card just started.
      if (e.target.closest?.('.sp-card')) return;
      if (!this.hoverEnabled()) { this._endHover(); return; }
      if (this._hoverFrame) return;
      const { clientX, clientY } = e;
      this._hoverFrame = requestAnimationFrame(() => {
        this._hoverFrame = 0;
        this._pickHover(clientX, clientY);
      });
    });
    el.addEventListener('pointerleave', () => this._endHover());
    el.addEventListener('pointercancel', (e) => {
      touches.delete(e.pointerId); pinch = null;
      down = null; this._endHover();
    });
    el.addEventListener('pointerup', (e) => {
      if (touches.delete(e.pointerId)) {
        if (touches.size < 2) pinch = null;
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      }
      if (!down) return;
      e.stopPropagation();
      const moved = down.moved; down = null;
      this._dragged = moved;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (moved || e.target.closest('.sp-card, a, button')) return;
      const r = el.getBoundingClientRect();
      const hit = this.field.pickAt(((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1, this.camera);
      if (hit >= 0) { this.nav.select(hit); this._activate(hit); }
    });
    el.addEventListener('click', (e) => {
      if (this._dragged) { e.preventDefault(); e.stopPropagation(); this._dragged = false; }
    }, true);
  }
}
