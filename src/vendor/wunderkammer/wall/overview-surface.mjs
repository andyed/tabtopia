/** A bounded picture of the flat wall. Geometry, focus and hit targets remain
 * owned by the real tiles; this surface replaces only successfully drawn images.
 * Feed setViewport the visible pose, not the destination of a CSS transition. */

import { perf } from './instrument.mjs';
import { OverviewAtlas } from './overview-atlas.mjs';
import { OverviewSheets } from './overview-sheets.mjs';
import { spriteSource } from './sprite-covers.mjs';

const DEFAULTS = { enterPx: 72, exitPx: 96, motionPx: 160, maxDpr: 2,
  maxCanvasPixels: 4_194_304, maxImagePixels: 16_777_216, maxImages: 4096,
  maxImageEdge: 96, concurrency: 3, frameBudgetMs: 4,
  // Copies into the atlas are the only per-source raster cost left in a paint,
  // and Chrome pays it at flush, after the elapsed-time check has passed. A
  // count is the bound that can see it: ~0.06 ms each on the 2026-10-13 laptop.
  // Draws from resident atlas pages cost ~2 µs each to record and almost
  // nothing to flush, so an atlas-only repaint gets a wider slice: finishing in
  // one frame matters more, because a tile left for the next slice shows its
  // DOM image meanwhile, and a long-hidden <img> is a cold GPU upload.
  atlasEdge: 128, atlasUploadsPerFrame: 160, atlasFrameBudgetMs: 12,
  // Handing tiles back to the DOM: a long-hidden <img> is a cold GPU upload
  // (~0.2 ms each, all in one frame when 400–1,800 appear together). The
  // canvas keeps covering while it draws this many outgoing tiles per frame
  // straight from their <img>, which warms them, and shows each one only once
  // it is warm. Warmth is short-lived; Chrome evicts under budget pressure.
  handoffWarmPerFrame: 64, warmMs: 1500,
  // Unloaded <img>s a handoff starts per frame (see _watchImage).
  handoffLoadsPerFrame: 128 };

export function overviewEligible(wasActive, projectedSize, moving = false, options = {}) {
  const o = { ...DEFAULTS, ...options };
  return Number.isFinite(projectedSize) && projectedSize > 0 &&
    projectedSize <= (moving ? o.motionPx : wasActive ? o.exitPx : o.enterPx);
}

export function backingSize(width, height, dpr = 1, maxPixels = DEFAULTS.maxCanvasPixels, maxDpr = 2) {
  if (!(width > 0 && height > 0)) return { width: 1, height: 1, dpr: 1 };
  const ratio = Math.min(Math.max(1, dpr), maxDpr, Math.sqrt(maxPixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)), dpr: ratio };
}

/** A cached viewport is safe only while its transformed rectangle covers the
 * whole current viewport. Newly exposed edges always require a fresh picture. */
export function pictureTransform(picture, pose, area) {
  const transform = picturePoseTransform(picture, pose, area);
  if (!transform || transform.scale < 1) return null;
  const { x, y, scale } = transform;
  if (x > 0 || y > 0 || x + picture.width * scale < area.width || y + picture.height * scale < area.height) return null;
  return transform;
}

function picturePoseTransform(picture, pose, area) {
  if (!picture || picture.width !== area.width || picture.height !== area.height || picture.dpr !== area.dpr) return null;
  const scale = pose.scale / picture.pose.scale;
  if (!(scale > 0 && Number.isFinite(scale))) return null;
  const x = pose.x - picture.pose.x * scale, y = pose.y - picture.pose.y * scale;
  return { x, y, scale };
}

/** Source/destination rectangles matching CSS object-fit, including portraits. */
export function imageRect(iw, ih, x, y, w, h, fit = 'cover') {
  if (!(iw > 0 && ih > 0 && w > 0 && h > 0)) return null;
  if (fit === 'contain') {
    const s = Math.min(w / iw, h / ih);
    return [0, 0, iw, ih, x + (w - iw * s) / 2, y + (h - ih * s) / 2, iw * s, ih * s];
  }
  const s = Math.max(w / iw, h / ih), sw = w / s, sh = h / s;
  return [(iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h];
}

/** The cell ground under a cover: its image's dominant colour (palette[0],
 * as buildTile sets --tile-tint), so contain-fit letterboxes match the DOM
 * tile; else the panel colour. Read once per layout, never per frame. */
export function tileTint(clip = {}) {
  const tint = Array.isArray(clip?.palette) ? clip.palette[0] : null;
  return typeof tint === 'string' && /^#[0-9a-f]{6}$/i.test(tint) ? tint : null;
}

export function overviewSource(clip = {}) {
  const variants = (clip.coverVariants || []).filter(v => v?.src && Number.isFinite(v.width) && v.width > 0);
  let smallest = null;
  for (const v of variants) if (!smallest || v.width < smallest.width) smallest = v;
  if (smallest?.src || clip.cover) return smallest?.src || clip.cover;
  // A collection's cover that exists only as sprite-sheet cells has no file to
  // name; it is keyed by identity (sprite-covers.mjs).
  if (Array.isArray(clip.sheetSlots) && clip.sheetSlots.length) return spriteSource(clip);
  return clip.media?.[0]?.src || '';
}

/** Each worker owns at most one decoder. Completed large images become bounded
 * bitmaps; original Image resources are released after that handoff. */
export function loadOverviewImage(src, { signal, maxEdge = 96 } = {}) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    let finished = false;
    const clean = () => { image.onload = image.onerror = null; signal?.removeEventListener('abort', abort); };
    const abort = () => {
      if (finished) return;
      finished = true; clean(); image.removeAttribute('src');
      reject(new DOMException('Image request cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    image.onerror = () => { if (finished) return; finished = true; clean(); reject(new Error('Overview image unavailable')); };
    image.onload = async () => {
      try {
        await image.decode();
        if (finished) return;
        const ratio = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
        let resource = image;
        if (typeof createImageBitmap === 'function' && ratio < 1) {
          resource = await createImageBitmap(image, { resizeWidth: Math.max(1, Math.round(image.naturalWidth * ratio)),
            resizeHeight: Math.max(1, Math.round(image.naturalHeight * ratio)), resizeQuality: 'low' });
        }
        if (finished) { if (resource !== image) resource.close(); return; }
        finished = true; clean();
        const width = resource.width || image.naturalWidth, height = resource.height || image.naturalHeight;
        if (resource !== image) image.removeAttribute('src');
        resolve({ image: resource, width, height, close: () => resource === image ? image.removeAttribute('src') : resource.close() });
      } catch (error) { if (!finished) { finished = true; clean(); image.removeAttribute('src'); reject(error); } }
    };
    image.src = src;
  });
}

export class OverviewSurface {
  constructor(stage, options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.stage = stage;
    this.canvas = options.canvas || document.createElement('canvas');
    this.canvas.className = 'overview-surface';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.hidden = true;
    this.context = this.canvas.getContext('2d', { alpha: true });
    this.background = options.background || (typeof getComputedStyle === 'function' && getComputedStyle(stage).getPropertyValue('--panel-2').trim()) || '#14141f';
    stage.prepend(this.canvas);
    this._raf = options.requestFrame || (fn => requestAnimationFrame(fn));
    this._cancel = options.cancelFrame || (id => cancelAnimationFrame(id));
    this._now = options.now || (() => performance.now());
    this._load = options.loadImage || loadOverviewImage;
    this.tiles = []; this.cache = new Map(); this.pending = new Map(); this.failed = new Set();
    this.painted = new Set(); this.active = false; this.enabled = true; this.disposed = false;
    this.pose = { x: 0, y: 0, scale: 1 }; this.area = { width: 0, height: 0 };
    this.frame = 0; this.epoch = 0; this.draws = 0; this.pixelCount = 0;
    this._dirty = true; this._work = []; this._cursor = 0; this._wanted = new Set();
    this._handoff = false; this._imageWatches = new Map(); this._imageErrors = new WeakSet();
    this._picture = null; this._compositing = false;
    this._domFallback = false;
    this._drawnTiles = new Set();
    this._domOnly = null; this._blurred = false; this._ratio = 1;
    this._warmAt = new WeakMap(); this._gradualExit = true;
    // Sources outlive layouts (search, scope and detail re-render the same
    // covers), so the atlas is kept across setTiles and reset only when full.
    this.atlas = options.atlas === false ? null
      : options.atlas || new OverviewAtlas({ createCanvas: options.createAtlasCanvas, maxEdge: this.options.atlasEdge });
    // Baked pages from the server (overview-sheets.mjs): a second slot source
    // that needs no DOM image at all, so the wall can leave covered tiles'
    // <img>s unloaded until a reading zoom. `onSheetsChange` lets the host
    // re-run its image loading when a level fails (fall back to files).
    this.sheets = options.sheets === false ? null
      : options.sheets || new OverviewSheets({ loadPage: options.loadSheetPage, onChange: level => this._onSheets(level) });
    this.onSheetsChange = options.onSheetsChange || null;
    this._sourceTiles = new Map(); this._nodeTiles = new Map(); this._imageSources = new WeakMap(); this._visibleTiles = new Set(); this._queued = new Set();
    this._onImageLoad = event => {
      const source = this._imageSources.get(event.target);
      if (source) { this._enqueueSource(source); this._schedule(); }
    };
    stage.addEventListener?.('load', this._onImageLoad, true);
  }

  setTiles(tiles = []) {
    this.epoch++;
    this._picture = null; this._compositing = false;
    for (const clean of [...this._imageWatches.values()]) clean();
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear(); this.failed.clear();
    // Painted markers survive into the next paint, which keeps every tile it
    // redraws hidden and restores only the rest. Clearing them here would show
    // every <img> for a frame, and with the atlas those are cold GPU uploads
    // (~500 ms for the Music Atlas). Anything that ends the overview instead
    // (inactive, disabled, DOM fallback) still clears them immediately.
    if (this.atlas?.full) this.atlas.reset();
    this.tiles = tiles.filter(t => [t.x, t.y, t.w, t.h].every(Number.isFinite) && t.w > 0 && t.h > 0)
      .map(t => ({ ...t, source: t.source || overviewSource(t.clip), image: t.node?.querySelector('img'), tint: tileTint(t.clip) }));
    this._sourceTiles = new Map(); this._nodeTiles = new Map(); this._imageSources = new WeakMap();
    for (const tile of this.tiles) {
      if (!this._sourceTiles.has(tile.source)) this._sourceTiles.set(tile.source, []);
      this._sourceTiles.get(tile.source).push(tile);
      if (tile.node) this._nodeTiles.set(tile.node, tile);
      if (tile.image) this._imageSources.set(tile.image, tile.source);
    }
    this._visibleTiles.clear(); this._queued.clear();
    const sources = new Set(this.tiles.map(t => t.source));
    for (const [source, entry] of this.cache) if (!sources.has(source)) this._evict(source, entry);
    // The median limits a single poster or tiny outlier's influence on switching.
    const sizes = this.tiles.map(t => Math.max(t.w, t.h)).sort((a, b) => a - b);
    this.typicalSize = sizes[Math.floor(sizes.length / 2)] || 0;
    this._dirty = true;
    this.setViewport(this.pose, this.area);
  }

  /** Point the baked pages at a corpus: `sheets` and per-clip `sheetSlots`
   * from /api/clips. Slots are keyed by the same source string tiles use. */
  setSheets(sheets, clips) {
    if (!this.sheets) return;
    this.sheets.setCorpus(sheets, clips, overviewSource);
    this._dirty = true;
    if (this.active) this.setViewport(this.pose, this.area);
  }

  /** Whether the host may leave this tile's <img> unloaded for now: the
   * overview would be showing at `scale`, and a baked level holds the cover
   * at no worse than 2× upsampling for a `cssPx`-wide draw. Travelling cards
   * (setDomOnly) always load, because the DOM draws them. */
  coversWithoutDom(node, source, cssPx, scale) {
    if (!this.enabled || !this.sheets?.available || !source || this._domOnly?.has(node)) return false;
    if (!overviewEligible(this.active, this.typicalSize * scale, false, this.options)) return false;
    const dpr = Math.min(Math.max(1, this.area.dpr || globalThis.devicePixelRatio || 1), this.options.maxDpr);
    return this.sheets.covers(source, cssPx * dpr);
  }

  _onSheets(level) {
    // A page arrived (draw from it) or a level failed (fall back to files).
    this._dirty = true;
    if (this.active && !this._compositing) this._schedule();
    this.onSheetsChange?.(level);
  }

  /** Nodes the DOM must draw for now (cards in layout motion travel on their
   * own transforms). The overview leaves them unpainted; null releases them. */
  setDomOnly(nodes = null) {
    const next = nodes && nodes.size ? nodes : null;
    if (!next && !this._domOnly) return;
    this._domOnly = next; this._dirty = true;
    if (this.active) this.setViewport(this.pose, this.area);
  }

  /** The host atomically replaces an already decoded image inside the same
   * semantic tile. Refresh only that occurrence; its cached pixels remain valid. */
  replaceImage(node, image) {
    const tile = this._nodeTiles.get(node);
    if (!tile || !image?.complete || !(image.naturalWidth > 0)) return false;
    const previous = tile.image;
    if (previous) { this._imageWatches.get(previous)?.(); this._imageSources.delete(previous); }
    tile.image = image; this._imageSources.set(image, tile.source);
    if (this._visibleTiles.has(tile) && !this.painted.has(node) && !this._queued.has(tile)) {
      this._work.push(tile); this._queued.add(tile); this._schedule();
    }
    if (this._handoff && !this._imageWatches.size) this.setViewport(this.pose, this.area);
    return true;
  }

  setViewport(pose, { width, height, moving = false, dpr = globalThis.devicePixelRatio || 1 } = {}) {
    if (this.disposed || ![pose.x, pose.y, pose.scale].every(Number.isFinite) || pose.scale <= 0) return;
    const changed = pose.x !== this.pose.x || pose.y !== this.pose.y || pose.scale !== this.pose.scale ||
      width !== this.area.width || height !== this.area.height || dpr !== this.area.dpr;
    this.pose = { x: pose.x, y: pose.y, scale: pose.scale };
    this.area = { width, height, moving, dpr };
    const eligible = this.enabled && !!this.context && width > 0 && height > 0 &&
      overviewEligible(this.active, this.typicalSize * pose.scale, moving, this.options);
    // Request the baked level this zoom draws from (no-op once loaded).
    if (eligible) this.sheets?.ensure(this.typicalSize * pose.scale * Math.min(Math.max(1, dpr), this.options.maxDpr));
    // Reading images may still be decoding when the camera crosses the exit
    // threshold. Keep their already-visible pixels until the DOM can take over.
    let handoff = false;
    if ((this.enabled || this._gradualExit) && !eligible && width > 0 && height > 0) {
      for (const node of this.painted) {
        const img = node.querySelector('img');
        if (!img || this._domReady(img)) continue;
        // A tile that left the layout or the viewport costs nothing to reveal.
        const tile = this._nodeTiles.get(node);
        if (!tile || !this._onScreen(tile)) continue;
        handoff = true;
        if (!this._domLoaded(img)) this._watchImage(img);
      }
    }
    if (handoff !== this._handoff) this._dirty = true;
    // The tiles hidden when a handoff begins stay in every handoff picture
    // (revealed ones on their atlas copy, under their visible <img>), so the
    // retained picture is still complete for a later zoom-out reentry.
    if (handoff && !this._handoff) this._handoffNodes = new Set(this.painted);
    else if (!handoff) {
      this._handoffNodes = null;
      // Load watches exist only to finish a handoff; one that ended another
      // way must not keep listeners (and detached images) alive.
      for (const clean of [...this._imageWatches.values()]) clean();
    }
    this._handoff = handoff;
    const active = eligible || handoff;
    if (active !== this.active) {
      this.active = active; this._dirty = true;
      this.canvas.hidden = !active;
      if (!active) this._clearPainted();
      this.options.onState?.({ active });
    }
    if (!active) {
      if (this.frame) this._cancel(this.frame);
      // Visibility/representation changed, but these pixels still represent the
      // same layout. Retain their complete snapshot for a cheap zoom-out return;
      // setTiles and actual raster changes remain the invalidation boundaries.
      this.frame = 0; this._compositing = false; this._domFallback = false;
      this.canvas.style.transform = 'none';
      return;
    }
    if (changed) this._dirty = true;
    this._domFallback = false;
    const transform = moving && !handoff && picturePoseTransform(this._picture, this.pose, this.area);
    if (moving) perf.count(!this._picture ? 'overview/moving-no-picture' : !transform ? 'overview/moving-picture-mismatch' : 'overview/moving-has-picture');
    if (transform && this._motionCoverage()) {
      perf.count('overview/moving-composite');
      if (this.frame) this._cancel(this.frame);
      this.frame = 0; this._compositing = true; this._dirty = true;
      this.canvas.hidden = false;
      this.canvas.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
      return;
    }
    this._compositing = false;
    if (moving && !handoff && this._visibleDomReady() && !this._atlasCovers()) {
      // A moving camera must not keep restarting a partial raster. The real
      // images already provide a complete picture here, so let their existing
      // compositor layer carry the gesture and build our bitmap only at rest.
      if (this.frame) this._cancel(this.frame);
      perf.count('overview/moving-dom');
      this.frame = 0; this._domFallback = true; this._dirty = true;
      this._clearPainted(); this.canvas.hidden = true;
      return;
    }
    this.canvas.hidden = false;
    if (this._dirty && moving) {
      // The host already sampled the visible pose in this animation frame.
      // Deferring its picture to the next rAF leaves pixels one frame behind
      // the unchanged DOM hit targets. Spend only our bounded slice now.
      if (this.frame) this._cancel(this.frame);
      perf.count('overview/moving-repaint');
      this.frame = 0; this._render();
    } else if (this._dirty) this._schedule();
  }

  _visibleDomReady() {
    const p = this.pose, { width, height } = this.area;
    for (const tile of this.tiles) {
      if (!tile.source || tile.x * p.scale + p.x >= width || (tile.x + tile.w) * p.scale + p.x <= 0 ||
        tile.y * p.scale + p.y >= height || (tile.y + tile.h) * p.scale + p.y <= 0) continue;
      if (!(tile.image?.complete && tile.image.naturalWidth > 0)) return false;
    }
    return true;
  }

  /** Every visible imaged tile already has atlas pixels, so a repaint costs a
   * few milliseconds of resident-texture draws. Prefer that to the DOM
   * fallback: showing ~1,800 long-hidden <img>s at once is the expensive path. */
  _atlasCovers() {
    if (!this.atlas?.slots.size && !this.sheets?.available) return false;
    const p = this.pose, { width, height } = this.area;
    for (const tile of this.tiles) {
      if (!tile.source || tile.x * p.scale + p.x >= width || (tile.x + tile.w) * p.scale + p.x <= 0 ||
        tile.y * p.scale + p.y >= height || (tile.y + tile.h) * p.scale + p.y <= 0) continue;
      if (!this.atlas?.get(tile.source) && !this.sheets?.slot(tile.source) && !this._domOnly?.has(tile.node)) return false;
    }
    return true;
  }

  _motionCoverage() {
    const picture = this._picture, p = this.pose, area = this.area, q = picture.pose;
    const oldLeft = -q.x / q.scale, oldTop = -q.y / q.scale;
    const oldRight = (picture.width - q.x) / q.scale, oldBottom = (picture.height - q.y) / q.scale;
    const left = -p.x / p.scale, top = -p.y / p.scale;
    const right = (area.width - p.x) / p.scale, bottom = (area.height - p.y) / p.scale;
    const changes = [];
    for (const tile of this.tiles) {
      const l = Math.max(tile.x, left), r = Math.min(tile.x + tile.w, right);
      const t = Math.max(tile.y, top), b = Math.min(tile.y + tile.h, bottom);
      if (r <= l || b <= t || !tile.source) continue;
      const covered = l >= oldLeft && r <= oldRight && t >= oldTop && b <= oldBottom && picture.tiles.has(tile) &&
        !this._domOnly?.has(tile.node);
      // Newly exposed imagery stays on its already decoded DOM image. If that
      // fallback is unavailable, use the ordinary bounded paint/load path.
      // A tile the baked sheets hold is the exception: its <img> was never
      // loaded, so it shows its dominant-colour placeholder for the rest of
      // the gesture and is painted at rest. Repainting the whole overview on
      // every tick instead cost 50 paints per zoom-out (156 ms of script
      // against 73 ms, Music Atlas, 2026-10-13).
      if (!covered && !(tile.image?.complete && tile.image.naturalWidth > 0) && !this.sheets?.slot(tile.source)) return false;
      if (tile.node && covered !== this.painted.has(tile.node)) changes.push([tile.node, covered]);
    }
    // Validate every fallback before changing any marker. Most frames cross no
    // tile boundary, so they perform no style writes and no image draws.
    for (const [node, covered] of changes) {
      if (covered) { this.painted.add(node); node.classList.add('overview-painted'); }
      else { this.painted.delete(node); node.classList.remove('overview-painted'); }
    }
    return true;
  }

  /** `gradual: false` reveals the DOM at once (the host is hiding the flat
   * stage anyway, so nothing will be rastered); otherwise disabling hands
   * tiles back through the warming handoff, like leaving the overview range. */
  setEnabled(enabled, { gradual = true } = {}) {
    enabled = !!enabled;
    const abrupt = !gradual && this._gradualExit;
    this._gradualExit = gradual;
    if (enabled === this.enabled) {
      // Already off, now with nothing left to show (e.g. a lens, then the 3D
      // view): end any gradual handoff instead of letting it hold the tiles.
      if (!enabled && abrupt) this.setViewport(this.pose, this.area);
      return;
    }
    this.enabled = enabled;
    this.setViewport(this.pose, this.area);
    if (!this.enabled) {
      this.epoch++;
      for (const controller of this.pending.values()) controller.abort();
      this.pending.clear();
    }
  }

  /** A paint is scheduled or a cover is still loading. Stills wait on this
   * (wall.mjs whenStill); a failed cover does not keep it busy. */
  get busy() { return !!(this.frame || this._srcFrame) || this.pending.size > 0 || (this.active && this._dirty); }

  _schedule() {
    if (this.frame || !this.active || this.disposed || this._compositing || this._domFallback) return;
    this.frame = this._raf(() => { this.frame = 0; this._render(); });
  }

  _render() {
    if (!this.active || this.disposed) return;
    const done = perf.begin('overview/paint');
    try { this._paint(); } finally { done(); }
  }

  _paint() {
    const ctx = this.context, { width, height, dpr } = this.area, p = this.pose;
    const start = this._now();
    if (this._dirty) {
      this._picture = null;
      this.canvas.style.transform = 'none';
      const size = backingSize(width, height, dpr, this.options.maxCanvasPixels, this.options.maxDpr);
      if (this.canvas.width !== size.width) this.canvas.width = size.width;
      if (this.canvas.height !== size.height) this.canvas.height = size.height;
      this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`;
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      this._ratio = size.dpr;
      ctx.clearRect(0, 0, width, height);
      const visible = this.tiles.filter(t => t.x * p.scale + p.x < width && (t.x + t.w) * p.scale + p.x > 0 &&
        t.y * p.scale + p.y < height && (t.y + t.h) * p.scale + p.y > 0);
      this._visibleTiles = new Set(visible); this._queued = new Set(visible); this._work = visible;
      this._wanted = new Set(visible.map(t => t.source));
      // Decode center-first, but retain layout order for drawing.
      this._queue = visible.filter(t => t.source).map(t => ({ source: t.source,
        distance: Math.hypot((t.x + t.w / 2) * p.scale + p.x - width / 2, (t.y + t.h / 2) * p.scale + p.y - height / 2) }))
        .sort((a, b) => a.distance - b.distance);
      this._cursor = 0; this._loadCursor = 0; this._dirty = false;
      this._resetPainted = this.painted; this.painted = new Set();
      // Reveal together: each partial reveal invalidates the tile layer and
      // re-rasters every image under it (~100 ms a frame at 64 per frame on
      // the Music Atlas). Warm in batches while covered, then show all loaded
      // tiles in one raster pass; tiles still loading keep their own watch.
      this._handoffReveal = this._handoff && this._handoffWarm();
      this._drawnTiles = new Set();
    }
    const added = new Set();
    let uploads = 0, direct = false, warmed = 0;
    while (this._cursor < this._work.length) {
      const tile = this._work[this._cursor++];
      this._queued.delete(tile);
      const dom = tile.image;
      // While handing off, only tiles that were hidden need covering, and
      // only until their own image is ready to show.
      let revealed = false;
      if (this._handoff) {
        if (!this._handoffNodes?.has(tile.node)) continue;
        revealed = this._handoffReveal && this._domReady(dom);
        if (revealed && !this.atlas?.get(tile.source) && !this.sheets?.slot(tile.source)) continue;
      }
      if (this._domOnly?.has(tile.node)) continue;
      const entry = this.cache.get(tile.source);
      const image = dom?.complete && dom.naturalWidth > 0 ? dom : entry?.image;
      const border = tile.border ?? 1, s = p.scale;
      const x = (tile.x + border) * s + p.x, y = (tile.y + border) * s + p.y;
      const w = Math.max(0, tile.w - border * 2) * s, h = Math.max(0, tile.h - border * 2) * s;
      // A baked slot draws with no image at all; at the right level it is
      // also cheaper than copying the DOM image into the atlas.
      const need = Math.max(w, h) * this._ratio;
      const page = this.sheets?.slot(tile.source, need);
      const baked = page ? { canvas: page.image, x: page.x, y: page.y, w: page.w, h: page.h } : null;
      if (image || baked) {
        const iw = image ? image.naturalWidth || entry?.width || image.width : baked.w;
        const ih = image ? image.naturalHeight || entry?.height || image.height : baked.h;
        // As sharp as the atlas would copy: ≤ 2× upsampled, or the whole source.
        const bakedSharp = !!baked && (page.edge * 2 >= need || page.edge >= Math.max(iw, ih));
        // Draw from the atlas copy when there is one. Copy in (or sharpen) now
        // if this frame's allowance permits; past it, a tile with no copy waits
        // for the next frame, and one with a softer copy draws that and is
        // sharpened by a follow-up pass.
        let slot = null, warming = false;
        const fromDom = image === dom;
        if (this._handoff) {
          // Outgoing tile: draw its own <img>, which warms it for the reveal
          // next frame, while this frame's allowance lasts; else hold it on
          // its resident copy. No new atlas work while handing off.
          if (!revealed && fromDom && (this.atlas || baked) && warmed < this.options.handoffWarmPerFrame && !this._domReady(dom)) { warmed++; warming = true; }
          slot = this.atlas?.get(tile.source) || baked;
        } else if (this.atlas) {
          slot = this.atlas.get(tile.source);
          const sharp = slot && this.atlas.isSharp(slot, iw, ih, need);
          if (!sharp && bakedSharp) slot = baked;
          else if (!sharp && !image) slot = slot || baked;
          else if (!sharp && !this.atlas.full && !this.atlas.disabled) {
            if (uploads < this.options.atlasUploadsPerFrame) {
              let fresh = null;
              try { fresh = this.atlas.put(tile.source, image, iw, ih, need); } catch { fresh = null; }
              if (fresh) { slot = fresh; uploads++; perf.count('overview/atlas-upload'); if (fromDom) this._warmAt.set(dom, this._now()); }
            } else if (!slot && baked) { slot = baked; this._blurred = true; }
            else if (!slot) { this._cursor--; this._queued.add(tile); break; }
            else this._blurred = true;
          }
        } else slot = bakedSharp || !image ? baked : null;
        if (warming && slot) {
          // Warm without showing it: one unclipped draw at the image's own
          // pixel size (so the cache holds full resolution, not a mip), under
          // the tile's atlas copy, which the clipped draw below covers.
          try { ctx.drawImage(dom, x, y, Math.min(w, iw / this._ratio), Math.min(h, ih / this._ratio)); this._warmAt.set(dom, this._now()); }
          catch { /* a released decoder stays cold; the reveal pays for it */ }
        }
        if (!slot && !warming) direct = true;
        const rect = slot ? imageRect(slot.w, slot.h, x, y, w, h, tile.fit || 'cover') : imageRect(iw, ih, x, y, w, h, tile.fit || 'cover');
        if (rect && slot) { rect[0] += slot.x; rect[1] += slot.y; }
        if (rect) {
          const clip = 4 * s >= 1 && typeof ctx.roundRect === 'function';
          try {
            if (clip) { ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.min(4 * s, w / 2, h / 2)); ctx.clip(); }
            ctx.fillStyle = tile.tint || this.background; ctx.fillRect(x, y, w, h);
            ctx.drawImage(slot ? slot.canvas : image, ...rect); this.draws++;
            if (slot === baked) perf.count('overview/sheet-draw');
            if (!slot && fromDom) this._warmAt.set(dom, this._now());
            this._drawnTiles.add(tile);
            if (entry) { this.cache.delete(tile.source); this.cache.set(tile.source, entry); }
            if (tile.node && !revealed && !this.painted.has(tile.node)) { this.painted.add(tile.node); added.add(tile.node); }
          } catch { /* Keep the existing DOM image if its decoder was released. */ }
          finally { if (clip) ctx.restore(); }
        }
      }
      if (this._now() - start >= (direct ? this.options.frameBudgetMs : this.options.atlasFrameBudgetMs)) break;
    }
    // A tile's DOM image disappears only after pixels exist at this exact pose.
    if (this._resetPainted) for (const node of this._resetPainted) if (!this.painted.has(node)) node.classList.remove('overview-painted');
    for (const node of added) if (!this._resetPainted?.has(node)) node.classList.add('overview-painted');
    this._resetPainted = null;
    if (!this._handoff) this._pump();
    if (this._cursor < this._work.length) this._schedule();
    else {
      this._picture = { pose: { ...p }, width, height, dpr, tiles: this._drawnTiles };
      this._work = []; this._cursor = 0;
      if (this._handoff && !this.painted.size) this.setViewport(this.pose, this.area);
      else if (this._handoff && warmed) { this._dirty = true; this._schedule(); }
      else if (this._blurred) { this._blurred = false; this._dirty = true; this._schedule(); }
    }
  }

  _enqueueSource(source) {
    for (const tile of this._sourceTiles.get(source) || []) {
      if (!this._visibleTiles.has(tile) || this._queued.has(tile) || this.painted.has(tile.node)) continue;
      this._work.push(tile); this._queued.add(tile);
    }
  }

  _domLoaded(img) { return !img || (img.complete && img.naturalWidth > 0) || this._imageErrors.has(img); }

  /** Loaded, and (once the atlas is in use) recently drawn from its own <img>
   * so that revealing it does not stall a frame on a cold upload. */
  _domReady(img) {
    if (!img || this._imageErrors.has(img)) return true;
    if (!(img.complete && img.naturalWidth > 0)) return false;
    // Baked pages count as the atlas being in use: the <img> they stood in
    // for is just as cold on its first showing.
    if ((!this.atlas || this.atlas.disabled || !this.atlas.slots.size) && !this.sheets?.available) return true;
    const at = this._warmAt.get(img);
    return at !== undefined && this._now() - at < this.options.warmMs;
  }

  _handoffWarm() {
    for (const node of this._handoffNodes || []) {
      const tile = this._nodeTiles.get(node);
      if (!tile || !this._onScreen(tile)) continue;
      if (this._domLoaded(tile.image) && !this._domReady(tile.image)) return false;
    }
    return true;
  }

  _onScreen(tile) {
    const p = this.pose, { width, height } = this.area;
    return tile.x * p.scale + p.x < width && (tile.x + tile.w) * p.scale + p.x > 0 &&
      tile.y * p.scale + p.y < height && (tile.y + tile.h) * p.scale + p.y > 0;
  }

  _watchImage(img) {
    if (this._imageWatches.has(img) || !img.addEventListener) return;
    const done = event => {
      clean();
      if (event.type === 'error') this._imageErrors.add(img);
      this._dirty = true;
      this.setViewport(this.pose, this.area);
    };
    const clean = () => { img.removeEventListener('load', done); img.removeEventListener('error', done); this._imageWatches.delete(img); };
    this._imageWatches.set(img, clean);
    img.addEventListener('load', done); img.addEventListener('error', done);
    // The wall normally requests this in its visible reading neighborhood;
    // initiate it here only if crossing the threshold got there first. With
    // baked sheets most <img>s were never loaded, and a lens or a filter can
    // start a handoff for ~1,800 at once: assigning every src inside that one
    // handler cost ~30 ms (chip hover 57 vs 27 ms). Start them in batches.
    if (!img.getAttribute('src') && img.dataset?.src) {
      (this._srcQueue ||= []).push(img);
      if (!this._srcFrame) this._srcFrame = this._raf(() => this._startLoads());
    }
  }

  _startLoads() {
    this._srcFrame = 0;
    const queue = this._srcQueue || [];
    const batch = queue.splice(0, this.options.handoffLoadsPerFrame);
    for (const img of batch) {
      // Skip images whose watch already ended (handoff over) or that the host
      // has meanwhile started itself.
      if (!this._imageWatches.has(img) || img.getAttribute('src') || !img.dataset?.src) continue;
      img.src = img.dataset.src;
    }
    if (queue.length) this._srcFrame = this._raf(() => this._startLoads());
  }

  _pump() {
    const need = this.typicalSize * this.pose.scale * this._ratio;
    while (this._loadCursor < (this._queue?.length || 0) && this.pending.size < this.options.concurrency) {
      const { source } = this._queue[this._loadCursor++];
      if (this.cache.has(source) || this.pending.has(source) || this.failed.has(source)) continue;
      // The baked pages already hold this cover; a per-file decode is waste.
      if (this.sheets?.covers(source, need)) continue;
      const images = this._sourceTiles.get(source) || [];
      // Native load capture will queue only these occurrences. Do not issue a
      // second Image/decode for a source the wall has already requested.
      if (images.some(t => t.image?.naturalWidth > 0 || (!t.image?.complete && (t.image?.currentSrc || t.image?.getAttribute?.('src'))))) continue;
      const controller = new AbortController(), epoch = this.epoch;
      this.pending.set(source, controller);
      Promise.resolve().then(() => this._load(source, { signal: controller.signal, maxEdge: this.options.maxImageEdge }))
        .then(entry => {
          if (this.disposed || controller.signal.aborted || epoch !== this.epoch) { entry.close?.(); return; }
          const pixels = entry.width * entry.height;
          if (!(pixels > 0) || pixels > this.options.maxImagePixels) { entry.close?.(); this.failed.add(source); return; }
          this.cache.set(source, { ...entry, close: entry.close?.bind(entry), pixels }); this.pixelCount += pixels;
          this._trim(); this._enqueueSource(source);
        }, error => { if (!controller.signal.aborted && epoch === this.epoch) this.failed.add(source); })
        .finally(() => {
          if (this.pending.get(source) === controller) this.pending.delete(source);
          if (!this.disposed && epoch === this.epoch) this._schedule();
        });
    }
  }

  _trim() {
    const over = () => this.cache.size > this.options.maxImages || this.pixelCount > this.options.maxImagePixels;
    if (!over()) return;
    for (const [source, entry] of this.cache) if (over() && !this._wanted.has(source)) this._evict(source, entry);
    for (const [source, entry] of this.cache) {
      if (!over()) break;
      this._evict(source, entry);
      // An oversubscribed overview must settle, not evict/reload forever. The
      // original DOM image remains the fallback until the next layout changes.
      this.failed.add(source);
    }
  }

  _evict(source, entry) { this.cache.delete(source); this.pixelCount -= entry.pixels; entry.close?.(); }
  _clearPainted() { for (const node of this.painted) node.classList.remove('overview-painted'); this.painted.clear(); }
  get stats() { return { active: this.active, images: this.cache.size, pending: this.pending.size,
    decodedPixels: this.pixelCount, canvasPixels: this.canvas.width * this.canvas.height,
    painted: this.painted.size, draws: this.draws, scheduled: !!this.frame, compositing: this._compositing, domFallback: this._domFallback,
    atlas: this.atlas?.stats ?? null, sheets: this.sheets?.stats ?? null }; }

  dispose() {
    this.disposed = true; this.epoch++;
    if (this.frame) this._cancel(this.frame);
    if (this._srcFrame) this._cancel(this._srcFrame);
    this.frame = 0; this._srcFrame = 0; this._srcQueue = [];
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear(); this._clearPainted();
    this.stage.removeEventListener?.('load', this._onImageLoad, true);
    for (const clean of [...this._imageWatches.values()]) clean();
    for (const [source, entry] of this.cache) this._evict(source, entry);
    this.atlas?.dispose();
    this.sheets?.dispose();
    this.canvas.remove();
  }
}
