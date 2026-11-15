/**
 * wunderkammer — a pannable, zoomable wall of visual web excerpts.
 *
 * Reads a normalized clip index from /api/clips (whatever store the adapter
 * happens to be reading) and renders it as a filterable canvas. It never
 * writes: editing happens in Obsidian, one deep link away.
 *
 * SECURITY NOTE: every string here — titles, notes, tags, facet values —
 * originates from scraped third-party pages. All of it goes into the DOM via
 * textContent. There is no innerHTML path for clip-derived data anywhere in
 * this file, and there must not be one.
 */

import { sortClips } from './attributes.mjs';
import { createAttributeBrush } from './attribute-brush.mjs';
import { buildFacetModel } from './facet-model.mjs';
import { createFacetRail } from './facet-rail.mjs';
import { createPermalinks, canonical } from './permalink.mjs';
import { targetedViewURL, isWarehouseIntent } from './view-intent.mjs';
import { clipKey, filterScope, chooseCluster, contextClusters, valuesOf, matchesFacet } from './context-clusters.mjs';
import { layout, groupBy, frameAround, HEADER_H, SIMILARITY, SIMILARITY_GRID, isSimilarity } from './layout.mjs';
import { hasProjection, hasCell } from './similarity-layout.mjs';
import { Viewport } from './viewport.mjs';
import { createDetailPane } from './detail-pane.mjs';
import { zoomDetailCandidate } from './zoom-detail.mjs';
import { createReaderLift, createReaderMedia } from './reader-lift.mjs';
import { OverviewSurface, overviewSource, loadOverviewImage } from './overview-surface.mjs';
import { spriteCovers, isSpriteSource } from './sprite-covers.mjs';
import { animateLayout, captureLayoutMotion, movingNodes } from './layout-motion.mjs';
import { createImageWork } from './image-work.mjs';
import { ViewStateStore, mergePileState } from './view-state.mjs';
import { perf } from './instrument.mjs';
import { collectionSource, loadCollection, collectionViewState, notifyEmbedder, FROM_PARENT } from './collection-source.mjs';
import { setProxyAvailable } from './media-policy.mjs';
import { AXES, axisDimensions, ARRANGEMENT_LABELS } from './float-space.mjs';
import { figureOverrides, renderBand, renderGroups } from './figure.mjs';
import { arrangeMenu, MENU, STACKS } from './arrange-menu.mjs';
import { NEUTRAL_NOUNS, collectionNouns, counted } from './nouns.mjs';

/** `?chrome=none` shows the stage alone, for stills (docs/SHOTS.md). Set
 * before the first layout, so the stage is measured at its full size. */
const CHROMELESS = new URL(location.href).searchParams.get('chrome') === 'none';
// Details on zoom is off unless the address asks for it. It was on from 0.1.0
// and put away on 2026-11-14 as not working in use; TODO.md has what to settle
// before it comes back. `?zoomdetail=on` is how its tests and that work run it.
const ZOOM_DETAIL = new URL(location.href).searchParams.get('zoomdetail') === 'on';
if (CHROMELESS) document.documentElement.dataset.chrome = 'none';
/** A still's figure layer (wall/figure.mjs): a caption band under the stage, on by
 * default with chrome=none; figure=none leaves the stage alone. The band's
 * height is reserved now, so every Fit and framing already sees the shorter stage. */
const FIGURE = CHROMELESS && new URL(location.href).searchParams.get('figure') !== 'none';
if (FIGURE) document.documentElement.dataset.figure = 'band';
// Word overrides for the figure (title=, label.*=). A bad one fails the still, not the page.
let figureLabels = { title: null, lit: null, rest: null, groups: new Map(), axes: {} }, figureLabelError = null;
if (FIGURE) try { figureLabels = figureOverrides(new URL(location.href).searchParams); } catch (err) { figureLabelError = err.message; }

/** Facets hidden from browsing controls, including instance-specific additions. */
const FACET_BLOCKLIST = new Set(['dims', 'media', 'cover']);
/** Initial page of values; local facet search reaches the complete vocabulary. */
const FACET_CHIP_LIMIT = 24;
let facetOrder = ['tags', 'source', 'kind', 'captured'];

const state = {
  // What the collection calls its items (wall/nouns.mjs); set when the corpus loads.
  nouns: NEUTRAL_NOUNS,
  clips: [],
  facets: {},
  filtered: [],
  query: '',
  branches: null, // null = whole corpus; otherwise union of explicit membership snapshots
  scopeHistory: [],
  clusters: [],
  contextVisible: false, // background plane revealed (kept as ui.context in permalinks)
  background: { key: '', full: null, framed: null, mounted: false },
  contextBase: null, // the working set at the moment a search began: search results are focus, this is their context
  corpus: null,
  layoutAspect: null,
  renderAspect: 1,
  arrangementOverride: null,
  permalinkBar: false,
  scopeBarSeen: false,
  unresolvedFocus: null,
  detailMedia: null,
  facetLabels: {},
  active: new Map(),   // facetKey -> Set(values)
  groupKey: 'none',
  sort: { key: 'none', direction: 'asc' },
  selected: null,
  lit: null,           // item keys lit by identity (lit=); the rest of the scope recedes (docs/SHOTS.md)
  spatial: null,       // lazily constructed SpatialView
  mode: 'flat',
  get spatialOn() { return this.mode !== 'flat'; },
  aisle: null, aisleSnapshot: null,
  float: null, floatSnapshot: null,
  // The 3D button reopens the last 3D presentation: the floating space ('float')
  // until a reader chooses Stacks ('3d'), as the wall icon returns to the last grouping.
  last3d: 'float', stacksMenu: null,
  spatialLoading: false,
  flatDirty: false, spatialDirty: false, aisleDirty: true, floatDirty: true,
  detailReturn: null, trayReturn: null,
  clipKey: null,
  viewState: new ViewStateStore(),
  viewStateError: '',
  tileEls: new Map(),  // [group label, clip.id] occurrence -> element
  positions: new Map(), // occurrence -> {clip,x,y,w,h}
  preview: null,        // transiently shown in Dive by hover; never selection, never ViewSpec
  bgTileEls: new Map(), // background-plane occurrence -> element (mounted only while revealed)
  bgPositions: new Map()
};

const el = {
  stage: document.getElementById('stage'),
  spHost: document.getElementById('sp-host'),
  view3d: document.getElementById('view-3d'),
  viewAisle: document.getElementById('view-aisle'),
  aisleHost: document.getElementById('aisle-host'),
  floatHost: document.getElementById('float-host'),
  canvas: document.getElementById('canvas'),
  rail: document.getElementById('rail'),
  search: document.getElementById('search'),
  group: document.getElementById('group'),
  count: document.getElementById('count'),
  detail: document.getElementById('detail'),
  empty: document.getElementById('empty')
};
// The figure's two layers: the caption band below the stage, and group names over it.
const figureBand = FIGURE ? document.body.appendChild(Object.assign(document.createElement('div'), { className: 'figure-band' })) : null;
const figureGroups = FIGURE ? el.stage.appendChild(Object.assign(document.createElement('div'), { className: 'figure-groups' })) : null;

const detailPane = createDetailPane(el.detail, el.stage);
const viewport = new Viewport(el.stage, el.canvas, onViewportChange);
const readerLift = createReaderLift();
const readerMedia = createReaderMedia();
const imageWork = createImageWork();
// A cover that exists only as sprite-sheet cells has no file for the
// overview's per-source loader; the sheets crop it instead.
const overview = new OverviewSurface(el.stage, {
  loadImage: (src, options) => isSpriteSource(src) ? spriteCovers.overviewImage(src, options) : loadOverviewImage(src, options) });
/** Device pixels a draw of `cssPx` needs, at the DPR the overview also caps at. */
const devicePx = cssPx => cssPx * Math.min(Math.max(1, window.devicePixelRatio || 1), 2);
// A sheet level that failed to load withdraws its promise to cover tiles;
// re-run image loading so those tiles fetch their own files instead.
overview.onSheetsChange = level => { if (level.state === 'failed') updateVisibility(); };
// Gauges for the perf probe, read only at snapshot time (no per-frame cost).
perf.provide('flat', () => ({ tiles: state.tileEls.size, bgTiles: state.bgTileEls.size, filtered: state.filtered.length,
  corpus: state.clips.length, scale: Number(viewport.scale.toFixed(3)), domNodes: document.getElementsByTagName('*').length }));
perf.provide('images', () => ({ queued: imageWork.pending, decoding: imageWork.running }));
perf.provide('overview', () => ({ draws: overview.draws ?? 0, active: !!overview.active, atlas: overview.atlas?.stats ?? null }));
let overviewFrame = 0, layoutMotionUntil = 0, layoutMotionToken = 0;
// The stage's size for the overview, kept until the stage ResizeObserver clears
// it. Measuring each frame of camera motion forced a style and layout pass
// right after the camera wrote its transform (9-10 ms per gesture).
let stageSize = null;
function syncOverview() { perf.span('overview/sync', syncOverviewNow); }
function syncOverviewNow() {
  cancelAnimationFrame(overviewFrame); overviewFrame = 0;
  // The overview paints covers on a canvas, which a tile's own dimming cannot reach: a lens or a lit set needs the DOM images.
  const enabled = !state.spatialOn && !el.canvas.hasAttribute('data-brush-key') && !state.lit;
  // Leaving for the 3D view hides the flat stage, so its images can return at
  // once; a lens keeps the desk on screen and hands tiles back gradually.
  overview.setEnabled(enabled, { gradual: !state.spatialOn });
  if (!enabled) return;
  if (!stageSize) { const r = el.stage.getBoundingClientRect(); stageSize = { width: r.width, height: r.height }; }
  // Pinch and edge zoom have no ease end, so `zooming` marks them as motion too.
  const moving = performance.now() < viewport.settlesAt || viewport.zooming;
  overview.setViewport(viewport.visiblePose(), { ...stageSize, moving });
  if (moving) overviewFrame = requestAnimationFrame(syncOverview);
}
// The smallest useful scale: Fit of the foreground, or of the foreground plus
// the context plane when there is one. Below it there is only empty canvas.
viewport.scaleFloor = () => {
  const r = el.stage.getBoundingClientRect(), pad = viewport.fitPadding(r);
  let x = 0, y = 0, right = viewport.content.w, bottom = viewport.content.h;
  const b = state.background.framed?.bounds;
  if (b && b.w && b.h && state.filtered.length) { x = Math.min(x, b.x); y = Math.min(y, b.y); right = Math.max(right, b.x + b.w); bottom = Math.max(bottom, b.y + b.h); }
  return Math.min((r.width - 2 * pad) / Math.max(1, right - x), (r.height - 2 * pad) / Math.max(1, bottom - y));
};
let hydrating = false, links;
const brush = createAttributeBrush({
  canvas: el.canvas, stage: el.stage,
  legendHost: document.getElementById('review-tip'),
  getTiles: () => state.mode === 'aisle' || state.mode === 'float' ? [] : [...state.tileEls].map(([key, node]) => ({ node, clip: state.positions.get(key)?.clip })).filter(t => t.clip),
  getClips: () => state.filtered, getSort: () => state.sort,
  getLabel: key => state.facetLabels[key] || (key === 'title' ? 'Title' : key),
  onSort: (key, direction) => setSort(key, direction),
  onPinnedChange: key => { document.getElementById('attribute-lens').value = key || 'none'; syncLensValue(); },
  onActiveChange: active => { if(state.mode==='aisle')state.aisle?.setLens(active); },
});
new MutationObserver(syncOverview).observe(el.canvas, { attributes: true, attributeFilter: ['data-brush-key', 'data-brush-mode'] });
const header = document.querySelector('.bar');
new ResizeObserver(() => perf.span('resize/bar', () => document.documentElement.style.setProperty('--bar-h', `${header.getBoundingClientRect().height}px`))).observe(header);
const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
function linkNotice(message) {
  document.getElementById('link-message').textContent = message;
  document.getElementById('link-status').hidden = !message;
}
/**
 * The current view as a portable ViewSpec, or null when there is not yet a view
 * to describe.
 *
 * A stage with no layout box — an unrendered tab, a display:none ancestor, a
 * frame before first layout — is not an invalid view, it is a view that has not
 * happened yet. Returning {w:0,h:0} made validateView reject it as "Invalid or
 * unsupported view link", which is both the wrong diagnosis and, on the one
 * unguarded call site, fatal to the whole permalink layer for that page load.
 * Say "not yet" instead and let the caller come back.
 */
function captureView() {
  const r = el.stage.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return null;
  const preferred = parseFloat(document.body.style.getPropertyValue('--detail-preferred'));
  const spatial = state.spatial?.captureView() || null;
  const originalArrangement = state.arrangementOverride || state.viewState.doc;
  if (spatial && originalArrangement?.piles) {
    const merged = mergePileState(spatial.arrangement, originalArrangement, new Set(state.filtered.map(clipKey)));
    spatial.arrangement = { version: 1, piles: merged.piles };
  }
  return { v: 1, layoutVersion: 1, corpus: state.corpus,
    scope: { query: state.query, facets: [...state.active].filter(([, v]) => v.size).map(([k, v]) => [k, [...v].sort()]).sort(([a], [b]) => a.localeCompare(b)), branches: state.branches },
    presentation: { mode: state.mode, group: state.groupKey, pan: viewport.panMode, sort: { ...state.sort } },
    flat: { view: { ...viewport.snapshot(), ...(state.flatDirty ? { fitted: true } : {}) }, stage: { w: r.width, h: r.height }, aspect: state.renderAspect },
    spatial,
    ...((state.aisleSnapshot || state.aisle?.captureView()) ? {aisle:state.aisleSnapshot || state.aisle?.captureView()} : {}),
    ...((state.floatSnapshot || state.float?.captureView()) ? {float:state.floatSnapshot || state.float?.captureView()} : {}),
    ui: { lens: brush.getPinned(), ...(brush.getPinnedValue()!==null?{highlight:{key:brush.getPinned(),value:brush.getPinnedValue()}}:{}), mediaSource: state.detailMedia, rail: !el.rail.classList.contains('hidden'), context: state.contextVisible, scopeBar: !document.getElementById('scope-bar').hidden,
      focus: state.clips.find(c => c.id === state.selected) ? clipKey(state.clips.find(c => c.id === state.selected)) : state.unresolvedFocus,
      detailWidth: Number.isFinite(preferred) ? Math.min(1, preferred / window.innerWidth) : null,
      ...(state.lit ? { lit: [...state.lit] } : {}) },
  };
}
async function restoreView(spec, { intent = false } = {}) {
  if (spec.corpus.id !== state.corpus.id) throw new Error('This link belongs to a different corpus');
  // An axis this collection cannot carry is refused, never silently replaced by a default.
  const offered = () => new Set(axisDimensions(state.clips, attributeKeys(), key => state.facetLabels[key]).map(d => d.id));
  if (spec.float?.arrangement === 'axes' && spec.float.axes) {
    const dims = offered(), bad = AXES.find(axis => spec.float.axes[axis] !== undefined && !dims.has(spec.float.axes[axis]));
    if (bad) throw new Error(`${bad}=${spec.float.axes[bad]} is not a dimension this collection can place on an axis`);
  }
  if (spec.float?.front && !offered().has(spec.float.front.replace(/^-/, '')))
    throw new Error(`front=${spec.float.front} is not a dimension this collection can order by`);
  hydrating = true; document.body.inert = true; document.body.dataset.restoring = 'true'; cancelAnimationFrame(filterFrame); viewport.resetEdge();
  const warnings = [];
  if (spec.corpus.revision !== state.corpus.revision) warnings.push('Corpus changed since this link was made');
  const known = new Set(state.clips.map(clipKey));
  const missing = new Set([...(spec.scope.branches || []).flatMap(b => b.keys), ...(spec.spatial?.arrangement.piles || []).flatMap(p => p.keys)].filter(k => !known.has(k)));
  if (missing.size) warnings.push(`${missing.size} missing item identities retained in the link`);
  try {
    state.permalinkBar = !!spec.ui.scopeBar;
    state.scopeBarSeen = !!spec.ui.scopeBar;
    state.query = spec.scope.query; state.active = new Map(spec.scope.facets.map(([k, v]) => [k, new Set(v)]));
    state.branches = structuredClone(spec.scope.branches);
    state.sort = spec.presentation.sort || { key: 'none', direction: 'asc' };
    brush.clear(); brush.setPinned(spec.ui.lens || null, spec.ui.highlight?.value ?? null);
    state.lit = spec.ui.lit?.length ? new Set(spec.ui.lit) : null;
    state.aisleSnapshot=spec.aisle || null;
    state.floatSnapshot=spec.float || null;
    buildReviewControls();
    state.groupKey = spec.presentation.group; el.group.value = state.groupKey;
    if (el.group.value !== state.groupKey) { const option = document.createElement('option'); option.value = state.groupKey; option.textContent = state.groupKey; el.group.append(option); el.group.value = state.groupKey; }
    state.arrangementOverride = spec.spatial ? { ...spec.spatial.arrangement, mode: spec.spatial.mode } : null;
    el.search.value = state.query;
    el.rail.classList.toggle('hidden', !spec.ui.rail); el.stage.classList.toggle('full', !spec.ui.rail);
    document.getElementById('toggle-rail').setAttribute('aria-expanded', String(spec.ui.rail));
    viewport.panMode = spec.presentation.pan; document.getElementById('pan-behavior').value = viewport.panMode;
    if (spec.ui.detailWidth === null) document.body.style.removeProperty('--detail-preferred');
    else document.body.style.setProperty('--detail-preferred', `${spec.ui.detailWidth * window.innerWidth}px`);
    closeDetail();
    if (spec.ui.focus) { const focus = state.clips.find(c => clipKey(c) === spec.ui.focus); if (focus) {
      openDetail(focus);
      if (spec.ui.mediaSource) {
        state.detailMedia = spec.ui.mediaSource;
        const media = focus.media?.find(m => m.src === spec.ui.mediaSource);
        if (media && detailPane.content.querySelector('img')) detailPane.content.querySelector('img').src = media.src;
        else warnings.push('Selected media is unavailable');
      }
    } else { state.unresolvedFocus = spec.ui.focus; warnings.push('Focused item is unavailable'); } }
    state.layoutAspect = spec.flat.view.fitted ? null : spec.flat.aspect;
    state.filtered = filterScope(state.clips, state);
    state.flatDirty = state.spatialDirty = state.aisleDirty = state.floatDirty = true;
    clearTrayReturn();
    state.clusters = contextClusters(state.clips, state.filtered, state.facetLabels, state.active);
    renderScope(); renderContext(); buildFacetRail();
    await frames(); render();
    if (spec.spatial) {
      await toggleSpatial(true);
      if (!state.spatial?.built) throw new Error('Spatial renderer could not be loaded');
      // A live intent seeds a fitted camera, not a saved pile arrangement.
      // Keep the canonical grouped presentation when no saved arrangement exists.
      if(!(intent&&spec.spatial.fitted&&spec.spatial.mode==='mountain'&&!spec.spatial.arrangement.piles.length&&piled(state.groupKey)))state.spatial.restoreView(spec.spatial);
    }
    if(spec.presentation.mode==='aisle'){
      await toggleSpatial(true,'aisle');
      if(!state.aisle?.built)throw new Error('Aisle renderer could not be loaded');
      state.aisle.restoreView(spec.aisle);
    }else if(spec.presentation.mode==='float'){
      await toggleSpatial(true,'float');
      if(!state.float?.built)throw new Error('Floating space could not be loaded');
      state.float.restoreView(spec.float);state.floatSnapshot=null;
    }else await toggleSpatial(spec.presentation.mode==='3d');
    await frames();
    if (spec.flat.view.fitted) viewport.fit();
    else {
      const r = el.stage.getBoundingClientRect(), old = spec.flat.stage, view = spec.flat.view;
      const ratio = Math.min(r.width / old.w, r.height / old.h);
      const scale = view.scale * ratio;
      viewport.restore({ ...view, scale, x: r.width / 2 - (old.w / 2 - view.x) * ratio, y: r.height / 2 - (old.h / 2 - view.y) * ratio });
    }
    applyLit();
    // A live link may ask for a framing; the camera it makes is what the exact link keeps.
    if (intent && new URL(location.href).searchParams.get('frame') === 'evidence') await frameEvidence();
    setBackgroundRevealed(!!spec.ui.context);
    await frames();
    linkNotice(warnings.join(' · '));
  } finally { hydrating = false; document.body.inert = false; delete document.body.dataset.restoring; }
}

/* ---------------------------------------------------------------- data --- */

async function boot() {
  let data;
  try {
    if (collection) {
      const loaded = await loadCollection(collection);
      data = loaded.data;
      state.viewState = new ViewStateStore(collectionViewState(loaded.viewState));
      for (const warning of loaded.warnings) console.warn(`[wunderkammer] collection: ${warning}`);
    } else {
      const res = await fetch('/api/clips');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    }
    perf.mark('boot/data');
  } catch (err) {
    showEmpty(collection ? 'Could not load the collection.' : 'Could not reach the wunderkammer server.', String(err.message || err));
    // Details go only to a parent that supplied the document itself. A URL is
    // fetched with this page's origin, so its problems can quote content the
    // embedder could not read; the frame still shows them to the person.
    notifyEmbedder({ type: 'wunderkammer:error', message: collection === FROM_PARENT
      ? String(err.message || err) : 'The collection could not be loaded; the wall shows why.' });
    return;
  }

  state.clips = Array.isArray(data.clips) ? data.clips : [];
  // Baked overview pages (scripts/sheets.py): the overview paints the whole
  // wall from a few of them instead of decoding every cover file. A
  // collection's own sheets (scripts/collection-sheets.py) also serve every
  // other tier for clips that have no cover file.
  spriteCovers.setCorpus(data.sheets, state.clips, { covers: data.images?.sheets === 'covers' });
  overview.setSheets(data.sheets, state.clips);
  // Production supplies a server-computed SHA revision. Legacy adapters and
  // fixture origins must still render when Web Crypto is unavailable.
  let revision = 'unversioned';
  if (!data.corpus && crypto.subtle) revision = [...new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(canonical(state.clips))))].map(b => b.toString(16).padStart(2, '0')).join('');
  state.corpus = data.corpus || { id: `legacy:${location.origin}:${data.ui?.title || ''}`, revision };
  state.facets = data.facets || {};
  state.facetLabels = data.ui?.facetLabels || {};
  state.nouns = collectionNouns({ clips: state.clips, ui: data.ui });
  if (typeof data.ui?.title === 'string') {
    document.title = data.ui.title;
    document.querySelector('.brand').textContent = data.ui.title;
  }
  if (Array.isArray(data.ui?.facetOrder)) facetOrder = data.ui.facetOrder.filter(k => typeof k === 'string');
  // Instance-specific fields can remain in clip data without appearing as browsing controls.
  if (Array.isArray(data.ui?.hiddenFacets)) {
    for (const key of data.ui.hiddenFacets) if (typeof key === 'string') FACET_BLOCKLIST.add(key);
  }
  buildGroupOptions();
  buildReviewControls();
  if ([...el.group.options].some(opt => opt.value === data.ui?.defaultGroup)) {
    state.groupKey = data.ui.defaultGroup;
    el.group.value = state.groupKey;
  }
  state.defaultGroup = state.groupKey;
  applyFilters();
  await frames();
  // Read before the first exact link replaces the address: ?view=warehouse arrives once.
  const warehouse = isWarehouseIntent(location.href);
  await links.start();
  document.body.dataset.viewReady = 'true';
  notifyEmbedder({ type: 'wunderkammer:view-ready' });
  if (warehouse && state.mode === 'aisle') void state.aisle?.playWarehouse({ nouns: state.nouns });
  perf.mark('boot/ready');
}

function scopeLabel() {
  const parts = [...state.active].filter(([, values]) => values.size).map(([key, values]) =>
    `${state.facetLabels[key] || key}: ${[...values].join(' or ')}`);
  if (state.query.trim()) parts.unshift(`Search: ${state.query.trim()}`);
  if (state.branches) parts.unshift(state.branches.map(b => b.label).join(' OR '));
  return parts.join(' · ') || 'All content';
}
/**
 * What this view shows, for an agent reading the page or a person handing it to
 * a conversation: scope, focus, the pinned highlight and the exact in-scope
 * items as identities and titles, in corpus order. Never notes or paths.
 */
function exportView() {
  const entry = clip => ({ key: clipKey(clip), title: String(clip.title || clipKey(clip)) });
  const focus = state.clips.find(c => c.id === state.selected) || null;
  const key = brush.getPinned(), value = brush.getPinnedValue();
  const highlighted = key && value !== null ? state.filtered.filter(clip => matchesFacet(clip, key, new Set([String(value)]))) : null;
  return {
    format: 'wunderkammer.export', version: 1,
    corpus: state.corpus ? { ...state.corpus } : null,
    scope: { label: scopeLabel(), query: state.query.trim(),
      facets: Object.fromEntries([...state.active].filter(([, v]) => v.size).map(([k, v]) => [k, [...v].sort()])),
      branches: state.branches ? state.branches.map(b => ({ label: b.label, count: b.keys.length })) : null },
    view: { mode: state.mode, group: state.groupKey },
    focus: focus ? entry(focus) : null,
    highlight: highlighted ? { key, value: String(value), count: highlighted.length, keys: highlighted.map(clipKey) } : null,
    lit: state.lit ? litSummary() : null,
    count: state.filtered.length, total: state.clips.length,
    evidence: state.filtered.map(entry),
  };
}
/* ------------------------------------------------------------------ lit --- */

/**
 * Items lit by identity (`lit=` in a live link, `ui.lit` in a view): the rest
 * of the scope recedes in place, so a shot can point at exactly the items a
 * claim cites (docs/SHOTS.md). Unlike a filter, nothing leaves the view; unlike
 * a lens value, the set is named item by item.
 */
function litSummary() {
  const keys = state.filtered.map(clipKey).filter(key => state.lit.has(key));
  const known = new Set(state.clips.map(clipKey));
  return { count: keys.length, keys, unresolved: [...state.lit].filter(key => !known.has(key)).length };
}
function markUnlit() {
  for (const [id, node] of state.tileEls) {
    const clip = state.positions.get(id)?.clip;
    node.classList.toggle('unlit', !!state.lit && !!clip && !state.lit.has(clipKey(clip)));
  }
  if (state.lit) el.canvas.dataset.lit = 'true'; else delete el.canvas.dataset.lit;
}
function applyLit() {
  markUnlit(); syncOverview(); state.float?.setLit(state.lit); renderCount();
}
function setLit(keys) {
  state.lit = keys && keys.size ? new Set(keys) : null;
  applyLit(); invalidatePreview();
}
/**
 * frame=evidence: point the camera at the evidence. That is the lit items, else
 * in the floating space a narrowed scope, else a pinned lens value. In the
 * floating space Fit frames those items; on the wall the camera zooms to their
 * tiles. Throws when there is nothing to frame, so a link asking for it fails
 * with a reason instead of showing the whole collection.
 */
async function frameEvidence() {
  const inScope = state.filtered;
  let keys = [];
  if (state.lit) keys = inScope.map(clipKey).filter(key => state.lit.has(key));
  else if (state.mode === 'float' && inScope.length < state.clips.length) keys = inScope.map(clipKey);
  else if (brush.getPinned() && brush.getPinnedValue() !== null) {
    const values = new Set([String(brush.getPinnedValue())]);
    keys = inScope.filter(clip => matchesFacet(clip, brush.getPinned(), values)).map(clipKey);
  }
  if (!keys.length) throw new Error('frame=evidence has nothing to frame: light items with lit=, narrow the scope, or pin a highlight');
  if (state.mode === 'float') state.float.frameItems(keys, { animate: false });
  else if (state.mode === 'flat') {
    const want = new Set(keys), boxes = [...state.positions.values()].filter(p => want.has(clipKey(p.clip)));
    if (!boxes.length) throw new Error('frame=evidence: none of the items to frame are on the wall');
    const x = Math.min(...boxes.map(p => p.x)), y = Math.min(...boxes.map(p => p.y));
    const w = Math.max(...boxes.map(p => p.x + p.w)) - x, h = Math.max(...boxes.map(p => p.y + p.h)) - y;
    const r = el.stage.getBoundingClientRect(), pad = viewport.fitPadding(r) * 2;
    viewport.focus({ x, y, w, h }, Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h));
  } else throw new Error(`frame=evidence works on the flat wall and in the floating space so far, not view=${state.mode}`);
  await frames();
}

/* --------------------------------------------------------------- stills --- */

/** Views a still can wait for: their renderers say when their pixels are final. */
const STILL_MODES = ['flat', 'float'];
/** What would still change the picture on screen. Empty means final. */
function stillPending({ allowUndrawn = false } = {}) {
  const out = [];
  if (document.body.dataset.viewReady !== 'true') return ['the view is still loading'];
  if (document.fonts && document.fonts.status !== 'loaded') out.push('fonts are loading');
  if (state.spatialLoading) out.push('the 3D renderer is loading');
  if (state.mode === 'float') out.push(...(state.float ? state.float.stillPending() : ['the floating space has not started']));
  else if (state.mode === 'flat') {
    if (viewport.zooming || performance.now() < viewport.settlesAt) out.push('the camera is moving');
    if (movingNodes().size) out.push('tiles are moving to a new layout');
    if (imageWork.pending || imageWork.running) out.push(`${imageWork.pending + imageWork.running} images are loading`);
    if (overview.busy) out.push('the overview is painting');
    // The queues only know the tiles already asked for: right after a layout,
    // a tile in view may not have been asked for yet. Its pixels decide.
    const undrawn = allowUndrawn ? 0 : undrawnTiles();
    if (undrawn) out.push(`${undrawn} tiles in view are not drawn yet`);
  }
  return out;
}
/** Flat wall: tiles in view that show neither their own image nor the overview's
 * pixels. revealTiles keeps `shown` current, so most tiles cost no measurement. */
function undrawnTiles() {
  const stage = el.stage.getBoundingClientRect();
  let undrawn = 0;
  for (const [id, node] of state.tileEls) {
    if (!state.positions.get(id)?.shown) continue;
    const r = node.getBoundingClientRect();
    if (!r.width || r.right <= stage.left || r.left >= stage.right || r.bottom <= stage.top || r.top >= stage.bottom) continue;
    if (node.classList.contains('no-media') || node.classList.contains('broken') || node.classList.contains('overview-painted')) continue;
    const img = node.querySelector(':scope > img');
    if (img?.complete && img.naturalWidth > 0) continue;
    undrawn++;
  }
  return undrawn;
}
/**
 * Resolves once the picture on screen is final, for a still: "view ready"
 * means the link is restored, not that every image has landed. It waits for
 * `quietFrames` frames in a row with nothing pending, and rejects after
 * `timeout` ms naming what is still pending, or at once for a view it cannot
 * judge. On the flat wall every tile in view must show its image or the
 * overview's pixels; `allowUndrawn` settles without that, and `undrawn` in the
 * result counts the tiles still showing only their tint.
 */
async function whenStill({ timeout = 30000, quietFrames = 3, allowUndrawn = false } = {}) {
  if (figureLabelError) throw new Error(figureLabelError);
  const start = performance.now();
  let quiet = 0, pending = [];
  for (;;) {
    await new Promise(resolve => requestAnimationFrame(resolve));
    pending = stillPending({ allowUndrawn });
    if (document.body.dataset.viewReady === 'true' && !STILL_MODES.includes(state.mode))
      throw new Error(`Stills support the flat wall and the floating space so far, not view=${state.mode}`);
    if (pending.includes('3D graphics are unavailable')) throw new Error('3D graphics are unavailable in this browser');
    quiet = pending.length ? 0 : quiet + 1;
    if (quiet >= quietFrames) break;
    if (performance.now() - start > timeout) throw new Error(`The view did not settle within ${timeout} ms: ${pending.join('; ')}`);
  }
  const undrawn = state.mode === 'flat' ? undrawnTiles() : 0;
  // The figure is drawn last, over a picture that no longer changes.
  const figure = FIGURE ? renderFigure() : null;
  if (figure) await frames();
  return { mode: state.mode, waitedMs: Math.round(performance.now() - start), undrawn, figure };
}

/* -------------------------------------------------------------- figure --- */

/**
 * What the figure says, from the page's own state: the count line, a legend
 * with counts, and a note naming the collection and the view. Overrides change
 * words, never numbers, and every text records whether it is the page's or an
 * override.
 */
function figureData() {
  const labels = figureLabels, nouns = state.nouns, total = state.clips.length, inScope = state.filtered.length;
  const narrowed = inScope < total, scope = narrowed ? ` · ${scopeLabel()}` : '';
  const source = text => text === null ? 'page' : 'override';
  const entry = (role, fallback, count) => ({ role, label: labels[role] ?? fallback, count, source: source(labels[role]) });
  let counts, legend = [];
  const pinned = brush.getPinned(), value = brush.getPinnedValue();
  if (state.lit) {
    const lit = litSummary().count;
    counts = `${lit} of ${counted(inScope, nouns)} lit${scope}`;
    // In the floating space the items outside the scope recede too.
    legend = [entry('lit', 'Lit', lit), entry('rest', 'Receded', (state.mode === 'float' ? total : inScope) - lit)];
  } else if (narrowed && state.mode === 'float') {
    counts = `${inScope} of ${counted(total, nouns)}${scope}`;
    legend = [entry('lit', 'In scope', inScope), entry('rest', 'Outside the scope', total - inScope)];
  } else if (pinned && value !== null) {
    const matches = state.filtered.filter(clip => matchesFacet(clip, pinned, new Set([String(value)]))).length;
    const name = `${state.facetLabels[pinned] || pinned}: ${value}`;
    counts = `${matches} of ${counted(inScope, nouns)} · ${name}${scope}`;
    legend = [entry('lit', name, matches), entry('rest', 'Other values', inScope - matches)];
  } else counts = narrowed ? `${inScope} of ${counted(total, nouns)}${scope}` : counted(total, nouns);
  return { headline: labels.title ?? counts, headlineSource: source(labels.title), counts, legend, notes: viewNotes(),
    groups: state.mode === 'flat' ? groupLabels() : [],
    axes: state.mode === 'float' ? Object.fromEntries(AXES.map(axis => [axis, labels.axes[axis] ? 'override' : 'page'])) : null };
}
/**
 * The collection's title and what the view does, in the page's words (axis
 * titles may be overridden), longest first: without the title, then with the
 * axis titles' detail dropped, then the arrangement's name alone. The band
 * shows the longest that fits.
 */
function viewNotes() {
  let view = '', brief = '', name = '';
  if (state.mode === 'float' && state.float) {
    const info = state.float.layout?.axisInfo, arrangement = state.float.arrangement;
    if (arrangement === 'axes' && info) {
      const title = axis => figureLabels.axes[axis] ?? info[axis].title;
      view = `Axes: ${AXES.map(axis => `${axis} ${title(axis)}`).join(' · ')}`;
      // "lightness (OKLab L)" → "lightness", "hue (OKLCH) from 220°" → "hue"; an override is kept whole.
      brief = `Axes: ${AXES.map(axis => `${axis} ${figureLabels.axes[axis] ?? title(axis).replace(/\s*\(.*?\)|\s+from\s+\d+°/g, '')}`).join(' · ')}`;
      name = 'Axes';
    } else if (arrangement === 'az') view = name = 'Shelved A–Z by title';
    else if (arrangement === 'cloud' || arrangement === 'mountain') {
      // The cloud's only claim is its order, and the mountain's too; the note says what decided it.
      const lead = state.lit ? 'the lit items in front, the rest behind' : state.filtered.length < state.clips.length ? 'the scope in front, the rest behind' : '';
      const order = state.float.describeFront();
      name = arrangement === 'cloud' ? 'Cloud' : 'Mountain';
      view = `${name}${lead || order ? ': ' : ''}${[lead, order && (lead ? `each ${order}` : order)].filter(Boolean).join('; ')}`;
    } else if (arrangement === 'sphere') {
      const { facing, cap } = state.float.sphereOptions();
      const shape = facing === 'in' ? `facing in${cap ? `, open ${cap}°` : ''}` : cap ? `open ${cap}°` : '';
      view = `Sphere${shape ? ` (${shape})` : ''}: lightest at the top, darkest at the bottom, hue around`;
      brief = 'Sphere: lightness up, hue around'; name = 'Sphere';
    }
    else { view = `Placed by dominant colour in ${ARRANGEMENT_LABELS[arrangement]}`; name = ARRANGEMENT_LABELS[arrangement]; }
  } else if (state.mode === 'flat') {
    const key = state.groupKey;
    view = name = key === SIMILARITY ? 'Similarity map' : key === SIMILARITY_GRID ? 'Similarity grid' : !key || key === 'none' ? 'Ungrouped' : `Grouped by ${state.facetLabels[key] || key}`;
  }
  const notes = [[document.title, view].filter(Boolean).join(' · '), view, brief, name].filter(Boolean);
  return [...new Set(notes)];
}
/** Group names for the wall's blocks in view, at their top-left corners on the stage. */
function groupLabels() {
  const r = el.stage.getBoundingClientRect(), s = viewport.scale;
  return (state.blocks || []).filter(b => b.label && b.label !== '—').map(b => {
    const left = b.x * s + viewport.x, top = b.y * s + viewport.y, width = b.w * s;
    return { label: b.label, text: figureLabels.groups.get(b.label) ?? b.label, count: b.count, source: figureLabels.groups.has(b.label) ? 'override' : 'page',
      left: Math.max(0, left) + 6, top: Math.max(0, top) + 6, width: Math.min(width, r.width - Math.max(0, left)) - 12, onStage: left < r.width && top < r.height && left + width > 0 && top + b.h * s > 0 };
  }).filter(g => g.onStage && g.width >= 60).map(({ onStage, ...g }) => g);
}
/** Draw the figure and say what it says; `clipped` lists any text that did not fit. */
function renderFigure() {
  const { notes, ...figure } = figureData();
  const band = renderBand(figureBand, { ...figure, notes }), groups = renderGroups(figureGroups, figure.groups);
  return { ...figure, note: band.note, noteFull: notes[0], groups: figure.groups.map(({ left, top, width, ...g }) => g), clipped: [...band.clipped, ...groups] };
}

function scopeSnapshot() {
  return { query: state.query, active: new Map([...state.active].map(([k, v]) => [k, new Set(v)])),
    branches: state.branches?.map(b => ({ label: b.label, keys: [...b.keys] })) ?? null,
    groupKey: state.groupKey, view: viewport.snapshot() };
}
function rememberScope() {
  if (links?.ready) { void links.flush(); return; }
  state.scopeHistory.push(scopeSnapshot());
  if (state.scopeHistory.length > 30) state.scopeHistory.shift();
}
function selectCluster(cluster, add) {
  rememberScope();
  // Freeze the exact previewed membership. Refinements are consumed into the base
  // branch before a union, so an old query cannot silently exclude added members.
  const plainUnion = state.branches && !state.query.trim() && ![...state.active.values()].some(v => v.size);
  state.branches = add && plainUnion
    ? [...state.branches, { label: cluster.label, keys: [...cluster.keys] }]
    : chooseCluster(state.filtered, cluster, add, scopeLabel());
  state.query = ''; state.active.clear(); el.search.value = '';
  closeDetail(); applyFilters();
  document.getElementById('scope-back').focus();
}
let filterFrame = 0;
function applyFilters(opts) { return perf.span('filter', () => applyFiltersNow(opts)); }
function applyFiltersNow({ restore = null } = {}) {
  if (!restore) state.layoutAspect = null;
  cancelAnimationFrame(filterFrame);
  if (!state.query.trim()) state.contextBase = null; // no search, no pre-search place
  setBackgroundRevealed(false);
  state.filtered = perf.span('filter/scope', () => filterScope(state.clips, state));
  state.clusters = perf.span('filter/clusters', () => contextClusters(state.clips, state.filtered, state.facetLabels, state.active));
  perf.span('filter/scope-ui', () => { renderScope(); renderContext(); buildFacetRail(); });
  invalidatePreview(); clearTrayReturn();
  if (state.selected && !state.filtered.some(c => c.id === state.selected)) closeDetail();
  state.flatDirty = state.spatialDirty = state.aisleDirty = state.floatDirty = true;
  // Scope is authoritative now; a hidden presentation materializes on entry.
  if (state.spatialOn) { refreshSpatial(); updateReviewOrder(); renderCount(); }
  else render();
  filterFrame = requestAnimationFrame(() => {
    if (!state.spatialOn) { if (restore) viewport.restore(restore); else viewport.fit(); }
  });
}
let scopeSummarySignature = null;
function renderScope() {
  const host = document.getElementById('scope-bar');
  const scoped = !!state.branches || !!state.query.trim() || [...state.active.values()].some(v => v.size);
  // Camera/detail history must not insert a new layout band beneath the desk.
  // Keep recovery available after actual scope work, including clearing it.
  state.scopeBarSeen ||= scoped;
  host.hidden = !state.permalinkBar && !state.scopeBarSeen;
  document.body.classList.toggle('has-scope', !host.hidden);
  document.getElementById('scope-back').disabled = links?.ready ? !links.canBack : !state.scopeHistory.length;
  const summary = document.getElementById('scope-summary');
  // History updates also follow camera/detail changes. Keep surviving controls
  // (and keyboard focus) intact when their displayed scope has not changed.
  const signature = JSON.stringify([state.query.trim(), state.branches?.map(b => b.label) ?? null,
    [...state.active].filter(([, values]) => values.size).map(([key, values]) =>
      [key, state.facetLabels[key] || key, [...values]])]);
  if (signature === scopeSummarySignature) return;
  scopeSummarySignature = signature;
  summary.replaceChildren();
  if (state.branches) for (const [index, branch] of state.branches.entries()) {
    if (index) summary.append(document.createTextNode(' OR '));
    const button = document.createElement('button'); button.className = 'btn scope-branch';
    button.textContent = `${branch.label} ×`;
    button.setAttribute('aria-label', `Remove ${branch.label}`);
    button.addEventListener('click', () => {
      rememberScope(); state.branches.splice(index, 1); applyFilters();
      document.getElementById('scope-back').focus();
    });
    summary.append(button);
  }
  if (state.branches?.length === 0) summary.append(document.createTextNode('Empty scope'));
  if (state.query.trim()) {
    const query = document.createElement('button'); query.type = 'button'; query.className = 'btn scope-query';
    query.textContent = `Search: ${state.query.trim()} ×`;
    query.setAttribute('aria-label', `Remove search: ${state.query.trim()}`);
    query.addEventListener('click', () => {
      rememberScope(); state.query = ''; el.search.value = ''; applyFilters();
      document.getElementById('scope-back').focus({ preventScroll: true });
    });
    summary.append(query);
  }
  for (const [key, values] of state.active) {
    if (!values.size) continue;
    const group = document.createElement('span'); group.className = 'scope-facet';
    group.setAttribute('role', 'group'); group.setAttribute('aria-label', `${state.facetLabels[key] || key}: any selected value`);
    const label = document.createElement('span'); label.textContent = `${state.facetLabels[key] || key}: `;
    group.append(label);
    for (const [index, value] of [...values].entries()) {
      if (index) group.append(document.createTextNode(' or '));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn scope-value';
      remove.dataset.scopeFacet = key; remove.dataset.scopeValue = value;
      remove.textContent = `${value} ×`; remove.setAttribute('aria-label', `Remove ${state.facetLabels[key] || key}: ${value}`);
      remove.addEventListener('click', () => removeFacetValue(key, value));
      group.append(remove);
    }
    if (summary.childNodes.length) summary.append(document.createTextNode(' · '));
    summary.append(group);
  }
  if (!summary.childNodes.length) summary.textContent = 'All content';
}

function renderContext() {
  const host = document.getElementById('context-clusters');
  host.hidden = true; // Cluster suggestions keep their mechanics; their placement is undecided.
  const list = document.getElementById('context-list'); list.replaceChildren();
  const hint = document.getElementById('context-preview');
  const instruction = '';
  hint.textContent = instruction;
  for (const cluster of state.clusters) {
    const card = document.createElement('article'); card.className = 'context-cluster'; card.dataset.cluster = cluster.id;
    const button = document.createElement('button'); button.className = 'cluster-select'; button.type = 'button';
    button.setAttribute('aria-label', `${cluster.label}: switch to ${cluster.keys.length} items outside the current scope`);
    const title = document.createElement('strong'); title.textContent = `${cluster.label} · ${cluster.keys.length}`;
    const reason = document.createElement('span'); reason.className = 'cluster-reason'; reason.textContent = cluster.reason;
    const montage = document.createElement('span'); montage.className = 'cluster-montage';
    const samples = Array.from({ length: Math.min(6, cluster.members.length) }, (_, i) =>
      cluster.members[Math.floor(i * cluster.members.length / Math.min(6, cluster.members.length))]);
    for (const clip of samples) {
      const sprite = spriteCovers.has(clip), src = clip.cover || clip.media?.[0]?.src;
      if (src || sprite) {
        const img = document.createElement('img'); img.alt = ''; img.draggable = false; montage.append(img);
        if (sprite) void spriteCovers.coverUrl(clip, devicePx(96), src).then(url => { if (url) img.src = url; }); else img.src = src;
      }
      else { const fallback = document.createElement('span'); fallback.textContent = clip.title || 'No image'; montage.append(fallback); }
    }
    button.append(title, montage, reason);
    const preview = () => { hint.textContent = `Switch: ${cluster.keys.length} items · Add: ${new Set([...state.filtered.map(clipKey), ...cluster.keys]).size} total`; };
    button.addEventListener('pointerenter', preview); button.addEventListener('focus', preview);
    card.addEventListener('pointerleave', () => { hint.textContent = instruction; });
    button.addEventListener('click', e => selectCluster(cluster, e.shiftKey));
    // Native Space activation loses modifier state in some engines; capture it explicitly.
    button.addEventListener('keydown', e => {
      if (e.shiftKey && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault(); selectCluster(cluster, true);
      }
    });
    const add = document.createElement('button'); add.type = 'button'; add.className = 'btn cluster-add'; add.textContent = 'Add';
    add.setAttribute('aria-label', `Add ${cluster.label}`); add.addEventListener('click', () => selectCluster(cluster, true));
    add.addEventListener('focus', preview);
    card.append(button, add); list.append(card);
  }
}
/* ---------------------------------------------------- background plane --- */

/**
 * The full corpus stays laid out behind a filtered foreground, framed around
 * the working subset with its own stable geometry. Zooming out below Fit
 * reveals it; Fit, a scope change or 3D dismiss it. It never changes Fit
 * content, the match count, or membership: it is context, not scope.
 */
const bgPlane = document.getElementById('bg-plane');
function contextClips() { return state.contextBase?.clips ?? state.clips; }
function backgroundKey() {
  const base = contextClips();
  return [state.groupKey, state.sort.key, state.sort.direction, state.renderAspect.toFixed(3), base.length,
    state.contextBase ? state.contextBase.label : 'all'].join('|');
}
function renderBackground(foreground, stageRect = null) {
  const base = contextClips();
  const inBase = new Set(base.map(clipKey));
  // Results that share nothing with the pre-search place have no context there: the plane fades away.
  const overlap = state.filtered.some(c => inBase.has(clipKey(c)));
  const wanted = state.filtered.length > 0 && state.filtered.length < base.length && overlap;
  if (!wanted) { state.background.framed = null; unmountBackground(); return; }
  const key = backgroundKey();
  if (state.background.key !== key || !state.background.full) {
    state.background.key = key;
    state.background.full = layout(sortClips(base, state.sort), state.groupKey, { viewportAspect: state.renderAspect, universe: state.clips });
  }
  state.background.framed = frameAround(state.background.full, { w: foreground.width, h: foreground.height });
  state.background.foreground = { w: foreground.width, h: foreground.height };
  if (state.contextVisible) mountBackground(stageRect); else unmountBackground();
}
/**
 * Depth and tilt of the plane, in world units so they scale with the camera.
 * The pivot is the foreground's centre line: above it the plane recedes, below
 * it comes forward but stays behind the foreground (depth exceeds the tilt's
 * forward reach at the plane's far edge). Parallax on pan follows for free.
 */
const BG_TILT_DEG = 10, BG_PERSPECTIVE = 1400;
function backgroundDepth() {
  const { framed, foreground } = state.background;
  if (!framed || !foreground) return null;
  const reach = (framed.bounds.h / 2 + Math.abs(framed.bounds.y)) * Math.sin(BG_TILT_DEG * Math.PI / 180);
  return { depth: Math.max(framed.bounds.h * 0.25, reach * 1.2), px: foreground.w / 2, py: foreground.h / 2 };
}
/**
 * The plane's internal scale: its content is laid out at roughly stage size in
 * CSS px and the transform multiplies back up. Chrome rasterises a perspective
 * layer at 1 CSS px per unit whatever the camera, so this bounds its texture
 * to about a screen instead of the full world (~10k px across).
 */
function planeScale(stage) {
  const b = state.background.framed?.bounds;
  if (!b || !b.w || !b.h) return 1;
  const base = Math.min(1, 1.25 * Math.min(stage.w / b.w, stage.h / b.h));
  // Zoomed into the plane, track the camera: a perspective layer rasterises at
  // its local size, so text set at 2px local never survives rasterisation
  // whatever the GPU scales it to. Local units at ~screen resolution keep
  // headings at their readable size and covers crisp.
  return Math.min(1, Math.max(base, viewport.scale));
}
function mirrorBackground(view, transition) {
  const d = backgroundDepth(), m = state.background.m, st = state.background.stage;
  if (!d || !m || !st) return;
  const k = view.scale / m;
  bgPlane.style.transition = [transition, 'opacity 0.35s ease'].filter(Boolean).join(', ');
  // Vanishing point at the stage centre, then the shared camera, then depth and
  // tilt about the foreground's centre line, all in the plane's internal units.
  bgPlane.style.transform = `translate(${st.w / 2}px, ${st.h / 2}px) perspective(${BG_PERSPECTIVE}px) translate(${-st.w / 2}px, ${-st.h / 2}px) `
    + `translate3d(${view.x.toFixed(2)}px, ${view.y.toFixed(2)}px, 0) scale3d(${k.toFixed(5)}, ${k.toFixed(5)}, ${k.toFixed(5)}) `
    + `translate(${d.px * m}px, ${d.py * m}px) translateZ(${-d.depth * m}px) rotateX(${BG_TILT_DEG}deg) translate(${-d.px * m}px, ${-d.py * m}px)`;
}
function planeLabelSizes(s) {
  const m = state.background.m; if (!m) return;
  const headingSize = Math.min(28, 14 + 5 * Math.log2(1 + s));
  bgPlane.style.setProperty('--group-heading-size', `${headingSize * m / s}px`);
  bgPlane.style.setProperty('--group-count-size', `${Math.max(12, headingSize * 0.74) * m / s}px`);
  bgPlane.style.setProperty('--group-label-unit', `${m / s}px`);
}
viewport.mirror = mirrorBackground;
function mountBackground(stageRect = null) {
  const framed = state.background.framed;
  if (!framed) return;
  const inScope = new Set(state.filtered.map(clipKey));
  const seen = new Set();
  state.bgPositions.clear();
  const r = stageRect || el.stage.getBoundingClientRect();
  state.background.stage = { w: r.width, h: r.height };
  const m = state.background.m = planeScale(state.background.stage);
  for (const stale of bgPlane.querySelectorAll('.block')) stale.remove();
  state.bgBlockEls = framed.blocks.map(b => { const node = buildBlock({ ...b, x: b.x * m, y: b.y * m, w: b.w * m, h: b.h * m }, { background: true }); bgPlane.append(node); return node; });
  for (const t of framed.tiles) {
    const key = JSON.stringify(['bg', t.group ?? '', t.clip.id]);
    seen.add(key); state.bgPositions.set(key, t); // world units, for culling
    let node = state.bgTileEls.get(key);
    if (!node) { node = buildTile(t.clip, { background: true }); state.bgTileEls.set(key, node); }
    if (!node.isConnected) bgPlane.append(node);
    node.classList.toggle('in-scope', inScope.has(clipKey(t.clip)));
    node.classList.toggle('selected', t.clip.id === state.selected);
    node.style.width = `${t.w * m}px`; node.style.height = `${t.h * m}px`;
    node.style.transform = `translate(${t.x * m}px, ${t.y * m}px)`;
  }
  planeLabelSizes(viewport.scale);
  for (const [key, node] of state.bgTileEls) if (!seen.has(key)) { node.remove(); state.bgTileEls.delete(key); }
  bgPlane.classList.toggle('search-context', !!state.contextBase);
  bgPlane.hidden = false;
  mirrorBackground({ x: viewport.x, y: viewport.y, scale: viewport.scale }, el.canvas.style.transition);
  state.background.mounted = true;
  // Bounded/edge pan may now reach the whole plane; Fit content stays the foreground.
  viewport.setItems([...state.positions.values(), ...framed.tiles]);
  updateVisibility({ rect: r });
}
function unmountBackground() {
  if (!state.background.mounted) return;
  bgPlane.hidden = true;
  for (const node of state.bgTileEls.values()) node.remove();
  for (const stale of bgPlane.querySelectorAll('.block')) stale.remove();
  state.bgPositions.clear();
  state.background.mounted = false;
  viewport.setItems([...state.positions.values()]);
}
function setBackgroundRevealed(on) {
  state.contextVisible = !!on;
  if (state.contextVisible) {
    mountBackground();
    // Mount first, then fade: a class set in the same frame as the mount skips the transition.
    requestAnimationFrame(() => { el.canvas.classList.toggle('bg-revealed', state.contextVisible); bgPlane.classList.toggle('revealed', state.contextVisible); });
  } else {
    el.canvas.classList.remove('bg-revealed'); bgPlane.classList.remove('revealed');
    unmountBackground();
  }
}
// Reveal latches on zooming out below Fit. Zooming back in keeps it, so a
// background item can be inspected; only Fit, a scope change or 3D clear it.
function updateBackgroundVisibility(r = el.stage.getBoundingClientRect()) {
  if (state.spatialOn || state.contextVisible || !state.background.framed) return;
  const pad = viewport.fitPadding(r);
  const fittedScale = Math.min((r.width - 2 * pad) / viewport.content.w, (r.height - 2 * pad) / viewport.content.h);
  const relativeScale = viewport.scale / Math.min(6, fittedScale);
  if (relativeScale < 0.9) setBackgroundRevealed(true);
}
// A revealed cluster can appear under the wheel pointer. Keep explicit canvas
// zoom routed to the same camera rather than falling through to browser zoom.
document.getElementById('context-clusters').addEventListener('wheel', e => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault(); viewport.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * .01));
  }
}, { passive: false });
document.getElementById('scope-back').addEventListener('click', () => {
  if (links?.ready) { links.back(); return; }
  const previous = state.scopeHistory.pop(); if (!previous) return;
  Object.assign(state, { query: previous.query, active: previous.active, branches: previous.branches, groupKey: previous.groupKey });
  el.search.value = state.query; el.group.value = state.groupKey;
  closeDetail(); applyFilters({ restore: previous.view });
});
document.getElementById('scope-clear').addEventListener('click', () => {
  rememberScope(); state.query = ''; state.active.clear(); state.branches = null;
  el.search.value = ''; closeDetail(); applyFilters();
});

/* ------------------------------------------------------------- spatial --- */

/**
 * The 3D view is loaded on demand. It costs a WebGL context, three.js off a
 * CDN and ~100 MB of texture atlas — none of which a session that never opens
 * it should pay for, and all of which would make the flat wall's first paint
 * slower for no reason.
 */
function activeSpatial() { return state.mode==='aisle'?state.aisle:state.mode==='float'?state.float:state.spatial; }
/** Both 3D presentations, the floating space and the stacks, belong to the 3D button. */
const threeD = mode => mode==='3d' || mode==='float';
/** Sort and the attribute lens arrange or recolour the evidence; the 3D views place it by other rules. */
const lensless = threeD;
async function toggleSpatial(on, kind='3d', { arrangement=null }={}) {
  if (state.spatialLoading) return;
  const next=on?kind:'flat';
  if (on && !(kind==='aisle'?state.aisle:kind==='float'?state.float:state.spatial)) {
    state.spatialLoading = true;
    try {
      const hooks={onOpen:openDetail,onHover:(clip,event)=>hoverPreview(clip,event),onInteraction:invalidatePreview,onHoverEnd:hoverEnd,hoverEnabled:()=>!!state.selected,onFlatWall:()=>toggleSpatial(false)};
      if(kind==='aisle'){
        const {AisleView}=await import('./aisle-view.mjs');
        state.aisle=new AisleView(el.aisleHost,hooks);
      }else if(kind==='float'){
        const {FloatView}=await import('./float-view.mjs');
        // The detail pane overlays the stage's right edge; fly-to lands beside it.
        // Stacks in its menu hands over to the stacks renderer.
        state.float=new FloatView(el.floatHost,{...hooks,axisKeys:attributeKeys,labelFor:key=>state.facetLabels[key]||key,obscuredRight:()=>el.detail.classList.contains('open')&&window.innerWidth>800?el.detail.getBoundingClientRect().width:0,onStacks:()=>toggleSpatial(true,'3d'),axisTitles:figureLabels.axes});
      }else{
        const {SpatialView,keyOfClip}=await import('./spatial/spatial-view.mjs');
        state.clipKey=keyOfClip;state.spatial=new SpatialView(el.spHost,hooks);
        await loadViewState();
      }
    } catch(err) {
      linkNotice(`Could not start ${kind==='aisle'?'the aisle':kind==='float'?'the floating space':'the spatial view'}: ${err.message}. The current view remains available.`);
      return;
    } finally { state.spatialLoading=false; }
  }
  viewport.resetEdge();viewport.enabled=!on;
  document.getElementById('edge-feedback').hidden=on;
  document.getElementById('pan-behavior').disabled=on;
  state.mode=next;document.body.dataset.viewMode=next;if(threeD(next))state.last3d=next;
  endPreview();state.spatial?._endHover?.();state.aisle?.cancelHover();state.float?.cancelHover();
  brush.setEnabled(!lensless(next));
  for(const id of ['sort-key','sort-direction','attribute-lens'])document.getElementById(id).disabled=lensless(next);
  updateSortDirection();syncLensValue();renderContext();
  if(on)setBackgroundRevealed(false);
  if(next==='3d')stacksMenu().set(STACKS);
  if(state.stacksMenu){state.stacksMenu.strip.hidden=next!=='3d';state.stacksMenu.sync();}
  el.spHost.hidden=next!=='3d';el.aisleHost.hidden=next!=='aisle';el.floatHost.hidden=next!=='float';
  state.aisle?.setVisible(next==='aisle');state.float?.setVisible(next==='float');
  el.canvas.style.visibility=on?'hidden':'';
  for(const [button,on3] of [[el.view3d,threeD(next)],[el.viewAisle,next==='aisle']]){button.setAttribute('aria-pressed',String(on3));button.classList.toggle('on',on3);}
  if(!on){if(state.flatDirty){render();viewport.fit();}updateBackgroundVisibility();}
  syncOverview();
  if(on){
    const refresh=(next==='aisle'?state.aisleDirty:next==='float'?state.floatDirty:state.spatialDirty)||!activeSpatial()?.built;
    if(refresh)refreshSpatial();
    if(next==='float'){
      if(state.floatSnapshot){state.float.restoreView(state.floatSnapshot);state.floatSnapshot=null;}
      // Chosen in the stacks' menu: applied after any saved snapshot, which it overrides.
      if(arrangement)state.float.setArrangement(arrangement,{animate:false});
      el.floatHost.querySelector('canvas')?.focus({preventScroll:true});
    }else if(next==='aisle'){
      if(state.aisleSnapshot){state.aisle.restoreView(state.aisleSnapshot);state.aisleSnapshot=null;}
      el.aisleHost.querySelector('canvas')?.focus({preventScroll:true});
    }else if(refresh)document.getElementById('sp-css3d')?.focus();
  }
  updateRowTitle(el.stage.getBoundingClientRect());
  trayReturnButton.hidden=trayFilterButton.hidden=on||!state.trayReturn;
}

/** Facet groupings become 3D piles; no grouping and the similarity arrangements are one field. */
const piled = key => !!key && key !== 'none' && !isSimilarity(key);

/**
 * The stacks' copy of the 3D menu, in a strip below them: the stacks renderer
 * has no toolbar of its own, and without this a reader who chose Stacks could
 * leave them only for the flat wall. The host ends above the strip, so the
 * stacks fit above it (SpatialView refits on resize).
 */
function stacksMenu() {
  if (state.stacksMenu) return state.stacksMenu;
  const strip = document.createElement('div');
  strip.className = 'sp-arrange'; strip.hidden = true;
  strip.setAttribute('role', 'group'); strip.setAttribute('aria-label', '3D space');
  const menu = arrangeMenu(MENU, name => { if (name !== STACKS) void toggleSpatial(true, 'float', { arrangement: name }); menu.set(STACKS); });
  strip.append(menu.node); el.stage.append(strip);
  // Set as the strip is shown, before the stacks first fit; the observer
  // follows later changes (a rotated phone rewraps the menu).
  const sync = () => el.stage.style.setProperty('--sp-arrange-h', `${strip.offsetHeight}px`);
  new ResizeObserver(sync).observe(strip);
  return state.stacksMenu = { strip, set: menu.set, sync };
}

/*
 * Arrangement icons (after PixPlot's layout icons): grouped wall, similarity
 * grid, similarity map. They drive the same #group select, so permalinks,
 * view state and the 3D field see one value. The wall icon returns to the
 * last facet grouping (or the instance default).
 */
const arrangeEl = document.getElementById('arrange');
let lastWallGroup = null;
function syncArrangement() {
  if (!arrangeEl) return;
  const has = key => [...el.group.options].some(o => o.value === key);
  arrangeEl.hidden = !has(SIMILARITY) && !has(SIMILARITY_GRID);
  if (!isSimilarity(state.groupKey)) lastWallGroup = state.groupKey;
  const current = state.groupKey === SIMILARITY ? 'map' : state.groupKey === SIMILARITY_GRID ? 'grid' : 'wall';
  for (const b of arrangeEl.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.arrange === current));
    if (b.dataset.arrange !== 'wall') b.hidden = !has(b.dataset.arrange === 'map' ? SIMILARITY : SIMILARITY_GRID);
  }
}
arrangeEl?.addEventListener('click', e => {
  const b = e.target.closest('button[data-arrange]');
  if (!b) return;
  const want = b.dataset.arrange === 'map' ? SIMILARITY : b.dataset.arrange === 'grid' ? SIMILARITY_GRID
    : lastWallGroup ?? state.defaultGroup ?? 'none';
  if (want === el.group.value) return;
  el.group.value = want;
  el.group.dispatchEvent(new Event('change'));
});

function refreshSpatial() {
  if(state.mode==='float'){
    // The whole corpus floats; scope only dims, so positions keep their meaning.
    state.floatDirty=false;
    state.float.setClips(state.clips,state.filtered,{nouns:state.nouns});
    state.float.setLit(state.lit);
    state.float.setFocused?.(state.clips.find(c=>c.id===state.selected)?clipKey(state.clips.find(c=>c.id===state.selected)):null);
    renderScopeEmpty();syncArrangement();return;
  }
  if(state.mode==='aisle'){
    state.aisleDirty=false;
    state.aisle.setClips(state.filtered,state.groupKey,{sort:state.sort,labelFor:key=>state.facetLabels[key]||key,nouns:state.nouns});
    brush.refresh();state.aisle.setLens(brush.getActive());syncLensValue();
    state.aisle.setFocused?.(state.clips.find(c=>c.id===state.selected)?clipKey(state.clips.find(c=>c.id===state.selected)):null);
    renderScopeEmpty();syncArrangement();return;
  }
  state.spatialDirty=false;
  // The scene and current clip map must exist BEFORE restoring URL-keyed piles.
  // The corpus and its revision: the field is built once per corpus and a
  // filter is membership, so narrowing and widening never reload a tile.
  state.spatial.setClips(state.filtered, state.groupKey, { corpus: state.clips, revision: state.corpus?.revision ?? 'unversioned' });
  const doc = state.arrangementOverride || state.viewState.doc;
  if (doc?.piles?.length && doc.mode !== 'mountain') state.spatial.restore(doc);
  else if (piled(state.groupKey)) state.spatial.showPiles(state.groupKey);
  renderScopeEmpty();
  syncArrangement();
}

function viewStateError(message, err) {
  state.viewStateError = message;
  console.warn(`[wunderkammer] ${message}:`, err.message);
  renderCount();
}

/** Pile membership persists as view state — never as a write to a note. */
async function loadViewState() {
  try {
    const doc = await state.viewState.load();
    if (!hydrating && [...el.group.options].some((opt) => opt.value === doc.groupKey)) {
      state.groupKey = doc.groupKey;
      el.group.value = doc.groupKey;
    }
    const known = new Set(state.clips.map(state.clipKey));
    const orphaned = (doc.piles || []).flatMap((p) => p.keys).filter((key) => !known.has(key));
    if (orphaned.length) {
      console.warn(`[wunderkammer] view state: ${orphaned.length} keys no longer resolve; retained in saved state`, orphaned.slice(0, 8));
    }
  } catch (err) {
    viewStateError('Saved piles not loaded — reload to retry', err);
  }
}

async function saveViewState() {
  if (!state.spatial || hydrating || state.mode==='aisle' || state.mode==='float') return;
  try {
    const doc = mergePileState({
      ...state.spatial.serialize(),
      mode: state.spatial.mode,
      groupKey: state.groupKey,
    }, state.viewState.doc, new Set(state.filtered.map(state.clipKey)));
    await state.viewState.save(doc);
    state.viewStateError = '';
    renderCount();
  } catch (err) {
    viewStateError('View not saved — change grouping to retry', err);
  }
}

/* -------------------------------------------------------------- render --- */

function updateReviewOrder() {
  // Review order remains available without laying out a hidden DOM wall.
  const seen = new Set();
  state.order = groupBy(sortClips(state.filtered, state.sort), state.groupKey).flatMap(g => g.clips).filter(clip => {
    if (seen.has(clip.id)) return false; seen.add(clip.id); return true;
  });
}
// The stage size the last render() laid out for. The stage ResizeObserver
// compares against it: when the scope bar appears, applyFilters has already
// rendered at the new size (renderScope runs first), so a refit would be a
// second identical render for one click.
let renderedStage = null;
function render() { perf.span('render', renderNow); }
function renderNow() {
  state.flatDirty = false;
  state.layoutEpoch = (state.layoutEpoch || 0) + 1;
  invalidatePreview();
  imageWork.clear();
  const previous = perf.span('render/capture-motion', () => captureLayoutMotion(state.positions));
  // One measurement, read before any write and threaded through everything
  // below. Each further getBoundingClientRect() after a style write forced a
  // synchronous layout of the whole wall; a filter change paid that four times.
  const bounds = perf.span('render/measure', () => el.stage.getBoundingClientRect());
  renderedStage = { w: bounds.width, h: bounds.height };
  stageSize = { width: bounds.width, height: bounds.height };
  const pad = viewport.fitPadding(bounds);
  state.renderAspect = state.layoutAspect || Math.max(1, bounds.width - pad * 2) / Math.max(1, bounds.height - pad * 2);
  const result = perf.span('render/layout', () => layout(sortClips(state.filtered, state.sort), state.groupKey, {
    // The similarity map places the corpus once; a filter hides, never re-projects.
    viewportAspect: state.renderAspect, universe: state.clips
  }));

  viewport.setContent(result.width, result.height, result.tiles);
  el.canvas.style.width = `${result.width}px`;
  el.canvas.style.height = `${result.height}px`;

  state.blocks = result.blocks;
  if (tour.on) setTour(false); // a new layout ends the flythrough; the user is steering
  // Review order for Dive traversal: the laid-out order, one entry per clip.
  { const seen = new Set(); state.order = []; for (const t of result.tiles) if (!seen.has(t.clip.id)) { seen.add(t.clip.id); state.order.push(t.clip); } }
  perf.span('render/blocks', () => renderBlocks(result.blocks));
  perf.span('render/tiles', () => renderTiles(result.tiles));
  const motionCount = perf.span('render/motion', () => animateLayout(previous, state.positions, state.tileEls, viewport.visiblePose(), bounds));
  layoutMotionUntil = motionCount ? performance.now() + 240 : 0;
  // The overview stays on through a layout change. Only the (at most 64)
  // travelling cards fall back to their DOM images until they land: switching
  // the whole overview off showed every hidden <img> at once, a ~500 ms cold
  // GPU upload on the Music Atlas (docs/PERF.md, finding 1).
  perf.span('render/overview-tiles', () => overview.setTiles([...state.positions].map(([key, t]) => ({ ...t, key, node: state.tileEls.get(key) }))));
  overview.setDomOnly(motionCount ? movingNodes() : null);
  const motionToken = ++layoutMotionToken;
  if (motionCount) setTimeout(() => { if (motionToken === layoutMotionToken) overview.setDomOnly(null); }, 250);
  syncOverview();
  perf.span('render/background', () => renderBackground(result, bounds));
  perf.span('render/brush', () => {brush.refresh();syncLensValue();});
  markUnlit();
  applyScaleStyles(viewport.scale, { force: true });

  renderCount();
  renderScopeEmpty();
  perf.span('render/visibility', () => updateVisibility({ rect: bounds }));
  syncArrangement();
}

/** Scope recovery belongs to both presentations, independently of tile layout. */
function renderScopeEmpty() {
  const nothing = state.filtered.length === 0;
  el.empty.classList.toggle('hidden', !nothing);
  if (nothing) {
    showEmpty(
      state.clips.length ? 'No clips match these filters.' : 'The vault is empty.',
      state.clips.length ? 'Clear the filters, or widen the search.' : null
    );
    if (state.clips.length) {
      const recover = document.createElement('button'); recover.type = 'button'; recover.className = 'btn';
      recover.textContent = 'Show all content';
      recover.addEventListener('click', () => {
        document.getElementById('scope-clear').click();
        document.getElementById('scope-back').focus({ preventScroll: true });
      });
      el.empty.append(recover);
    }
  }
}

function renderCount() {
  el.count.replaceChildren();
  const strong = document.createElement('b');
  strong.textContent = String(state.filtered.length);
  el.count.append(strong, document.createTextNode(` of ${counted(state.clips.length, state.nouns)}`));
  if (state.lit) el.count.append(document.createTextNode(` · ${litSummary().count} lit`));
  if (state.viewStateError) el.count.append(document.createTextNode(` · ${state.viewStateError}`));
}

function renderBlocks(blocks) {
  for (const stale of el.canvas.querySelectorAll(':scope > .block')) stale.remove();
  state.blockEls = blocks.map(b => { const node = buildBlock(b); el.canvas.append(node); return node; });
  updateTightBlocks(viewport.scale);
}

/**
 * A heading has a readable floor, so at overview scale a long tail of tiny
 * groups (one-album artists) would carry labels larger than their covers.
 * The rule is text size to image size: a block drops its heading when the
 * heading on screen would be taller than the covers it names (ratio above
 * TIGHT_TEXT_RATIO), or when the block is too narrow to fit a label at all.
 * The heading returns as zoom grows the covers past the text.
 */
const TIGHT_BLOCK_PX = 96, TIGHT_TEXT_RATIO = 1.2;
function headingScreenPx(s) { return Math.min(28, 14 + 5 * Math.log2(1 + s)); }
function updateTightBlocks(s) {
  const text = headingScreenPx(s);
  const mark = (blocks, nodes) => { if (!blocks || !nodes) return;
    for (let i = 0; i < nodes.length; i++) {
      const b = blocks[i];
      nodes[i].classList.toggle('tight', b.w * s < TIGHT_BLOCK_PX || text > (b.tileH || 240) * s * TIGHT_TEXT_RATIO || HEADER_H * s < text * 1.25 + 8);
    } };
  mark(state.blocks, state.blockEls);
  if (state.background.mounted) mark(state.background.framed?.blocks, state.bgBlockEls);
}

function buildBlock(b, { background = false } = {}) {
  const div = document.createElement('div');
  div.className = 'block';
  div.style.width = `${b.w}px`;
  div.style.height = `${b.h}px`;
  div.style.transform = `translate(${b.x}px, ${b.y}px)`;

  div.dataset.tileH = String(Math.round(b.tileH || 0));
  const h2 = document.createElement('h2');
  h2.textContent = b.label;                       // untrusted: textContent only
  // Foreground headings approach a tray; context headings explicitly pivot scope.
  if (b.label && b.label !== '—') {
    h2.tabIndex = 0; h2.setAttribute('role', 'button');
    h2.setAttribute('aria-label', `${b.label}: ${background ? 'filter to' : 'approach'} this group, ${counted(b.count, state.nouns)}`);
    h2.addEventListener('click', e => { if ((viewport.lastDragDistance || 0) > 4) return; if (background || e.shiftKey) selectGroup(b.label, e.shiftKey); else approachGroup(b); });
    h2.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (background || e.shiftKey) selectGroup(b.label, e.shiftKey); else approachGroup(b); } });
  }
  const n = document.createElement('span');
  n.textContent = String(b.count);
  h2.append(n);

  div.append(h2);
  return div;
}

function renderTiles(tiles) {
  const seen = new Set();
  state.positions.clear();

  for (const t of tiles) {
    const { clip } = t;
    const key = JSON.stringify([t.group ?? '', clip.id]);
    seen.add(key);
    state.positions.set(key, t);

    let node = state.tileEls.get(key);
    if (!node) {
      node = buildTile(clip);
      state.tileEls.set(key, node);
      el.canvas.append(node);
    }
    node.classList.toggle('selected', clip.id === state.selected);
    node.style.width = `${t.w}px`;
    node.style.height = `${t.h}px`;
    node.style.transform = `translate(${t.x}px, ${t.y}px)`;
  }

  for (const [id, node] of state.tileEls) {
    if (!seen.has(id)) {
      node.remove();
      state.tileEls.delete(id);
    }
  }
  const orderedNodes = tiles.map(t => state.tileEls.get(JSON.stringify([t.group ?? '', t.clip.id])));
  const currentNodes = [...el.canvas.querySelectorAll(':scope > .tile')];
  if (orderedNodes.some((node, index) => node !== currentNodes[index])) {
    const focused = document.activeElement;
    for (const node of orderedNodes) el.canvas.append(node);
    if (focused?.classList.contains('tile') && focused.isConnected) focused.focus({ preventScroll: true });
  }

}

function buildTile(clip, { background = false } = {}) {
  const node = document.createElement('div');
  node.className = background ? 'tile bg' : 'tile';
  // Background items are mouse-reachable context, not a second tab order
  // through the whole corpus; the facet rail remains the keyboard route.
  node.tabIndex = background ? -1 : 0;
  node.setAttribute('role', 'button');
  node.setAttribute('aria-label', clip.title || 'clip');

  // A cover served by sprite-sheet cells gets its <img> source at reveal time,
  // cropped at the size the tile is drawn (revealSprite). Its file, if it has
  // one, waits in data-file(-srcset), not data-src: the overview's handoff
  // starts every data-src it finds, and the file is only for a cell whose
  // page fails to load (revealTiles moves it over then).
  const sprite = spriteCovers.has(clip);
  const src = clip.cover || clip.media?.[0]?.src || '';
  if (src || sprite) {
    const img = document.createElement('img');
    img.alt = '';                    // decorative; the caption carries the name
    const srcset = Array.isArray(clip.coverVariants) && clip.coverVariants.length
      ? clip.coverVariants.filter(v => typeof v.src === 'string' && Number.isFinite(v.width) && v.width > 0)
        .map(v => `${v.src} ${Math.round(v.width)}w`).join(', ') : '';
    if (sprite) {
      img.dataset.sprite = '0';
      if (src) img.dataset.file = src;
      if (srcset) img.dataset.fileSrcset = srcset;
    } else {
      if (src) img.dataset.src = src;
      if (srcset) img.dataset.srcset = srcset;
    }
    img.draggable = false; // native image dragging cancels the canvas pointer gesture
    img.decoding = 'async';
    // A dead attachment must not leave an invisible hole in the wall.
    img.addEventListener('error', () => node.classList.add('broken'), { once: true });
    node.append(img);
    // Until the image decodes, the cell shows the image's dominant colour, so
    // a section reads as a colour field at once instead of a grid of empty
    // slots that fills in over seconds. Palettes are sorted by share, so [0]
    // is the dominant one. Only where there is an image: a no-media tile puts
    // its title text on the tile ground, and that must stay the dark panel.
    const tint = Array.isArray(clip.palette) ? clip.palette[0] : null;
    if (typeof tint === 'string' && /^#[0-9a-f]{6}$/i.test(tint)) node.style.setProperty('--tile-tint', tint);
  } else {
    node.classList.add('no-media');
    const fb = document.createElement('div');
    fb.className = 'fallback';
    fb.textContent = clip.title || clip.url || '';
    node.append(fb);
  }

  const cap = document.createElement('div');
  cap.className = 'cap';
  const t = document.createElement('div');
  t.className = 't';
  t.textContent = clip.title || '(untitled)';
  const m = document.createElement('div');
  m.className = 'm';
  m.textContent = [clip.source, clip.captured, (clip.tags || []).join(' · ')]
    .filter(Boolean)
    .join('  ·  ');
  cap.append(t, m);
  node.append(cap);

  const open = () => openDetail(clip, { sourceNode: node });
  node.addEventListener('click', () => {
    // Suppress the click that ends a pan; 4px of slop covers a shaky trackpad.
    if ((viewport.lastDragDistance || 0) > 4) return;
    open();
  });
  node.addEventListener('pointermove', (e) => hoverPreview(clip, e));
  node.addEventListener('pointerleave', hoverEnd);
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return node;
}

/* ------------------------------------------------- visibility & zoom  --- */

let labelScaleApplied = 0, scaleStyleTimer = 0;
/** The caption tier the camera last landed in: 'far' hides captions, 'near' adds the metadata line. */
let captionTier = 'mid';
/**
 * Everything whose CSS depends on the camera scale: label sizes, the caption
 * zoom tiers, tight-block headings and the context plane's internal scale.
 *
 * Each of these invalidates style on every tile — the label variables sit on
 * the stage and feed every caption and heading — so one application costs a
 * full restyle and layout of the wall (~15 ms at 1,800 tiles). Applied on
 * every wheel tick of a zoom that was 20 such passes per gesture, 340 ms of
 * style and 370 ms of layout, with 12 long tasks. Now it runs once, when the
 * eased zoom lands (see updateVisibility for the same rule on image loads);
 * mid-flight the compositor scales the existing raster, which is what a
 * gesture should look like anyway. Reduced motion has no transition, so the
 * pass is immediate there and the tests' expectations hold unchanged.
 */
function applyScaleStyles(s = viewport.scale, { force = false } = {}) {
  clearTimeout(scaleStyleTimer); scaleStyleTimer = 0;
  // Screen-space label sizes are expressed in world units, so they would change
  // on every frame. Re-apply them only once the zoom has drifted ~8% from the
  // last applied value.
  if (force || !labelScaleApplied || Math.abs(Math.log(s / labelScaleApplied)) > 0.08) {
    const done = perf.begin('scale-styles');
    labelScaleApplied = s;
    // A stage-level inherited variable restyled every descendant. Headings
    // belong to the small group set; captions upgrade only in visible tiles.
    const headingSize = headingScreenPx(s);
    for (const node of state.blockEls || []) {
      node.style.setProperty('--group-heading-size', `${headingSize / s}px`);
      node.style.setProperty('--group-count-size', `${Math.max(12, headingSize * 0.74) / s}px`);
      node.style.setProperty('--group-label-unit', `${1 / s}px`);
    }
    if (state.background.mounted) {
      // Re-layout the plane at a new internal scale once the camera has drifted
      // a factor of two from it (only while zoomed in past its base scale).
      const m = state.background.m;
      if (m < 1 && Math.abs(Math.log2(s / m)) > 1 && Math.max(s, m) > planeScale(state.background.stage) * 0.99 + 1e-9 && s !== m) mountBackground();
      else planeLabelSizes(s);
    }
    updateTightBlocks(s);
    done();
  }
  const tier = captionTierFor(s);
  if (tier === captionTier) return;
  captionTier = tier;
  // A canvas-level class here restyled all 1,800 tiles in one 55 ms frame
  // (audit 2026-10-13, finding 5). Restyle only the tiles on screen now;
  // revealTiles gives every other tile the tier as it comes into view.
  const done = perf.begin('scale-tier');
  for (const [id, node] of state.tileEls) if (state.positions.get(id)?.shown) applyCaptionTier(node);
  done();
}
/** The caption tier for a scale, with hysteresis so a zoom resting on a threshold cannot flap. */
function captionTierFor(s) {
  if (s < (captionTier === 'far' ? 0.36 : 0.30)) return 'far';
  return s > (captionTier === 'near' ? 1.10 : 1.20) ? 'near' : 'mid';
}
/** Give one tile a caption tier. A settled tile costs one property compare. */
function applyCaptionTier(node, tier = captionTier) {
  if (node._captionTier === tier) return;
  node._captionTier = tier;
  node.classList.toggle('z-far', tier === 'far');
  node.classList.toggle('z-near', tier === 'near');
}
function onViewportChange(v, stageRect) { perf.span('camera/change', () => onViewportChangeNow(v, stageRect)); }
function onViewportChangeNow(v, stageRect = el.stage.getBoundingClientRect()) {
  // A hover preview ends when the camera moves. A zoom preview stays through
  // the gesture and is decided again when it lands, so a pinch cannot flicker it.
  if (previewByZoom) previewPoint = null; else invalidatePreview();
  scheduleZoomDetail();
  syncOverview();
  const s = v.scale;
  const now = performance.now();
  if (now < viewport.settlesAt) {
    // A zoom is easing: apply the scale-dependent styles once it lands.
    clearTimeout(scaleStyleTimer);
    scaleStyleTimer = setTimeout(() => applyScaleStyles(viewport.scale), viewport.settlesAt - now + 20);
  } else if (viewport.zooming) {
    // A pinch or edge zoom writes every frame and has no landing time; its end
    // calls back here once more, and the styles apply then.
    clearTimeout(scaleStyleTimer); scaleStyleTimer = 0;
  } else applyScaleStyles(s);
  if (state.background.mounted) state.background.stage = { w: stageRect.width, h: stageRect.height };
  updateVisibility({ rect: stageRect, defer: true });
  updateBackgroundVisibility(stageRect);
  updateRowTitle(stageRect);
}

/** A facet value as a control: click narrows to items sharing it, Shift-click adds it to the facet's values. */
function exampleChip(key, value) {
  const c = document.createElement('button'); c.type = 'button'; c.className = 'chip example';
  c.dataset.exampleFacet = key; c.dataset.exampleValue = value;
  c.textContent = value;
  c.setAttribute('aria-pressed', String(state.active.get(key)?.has(value) || false));
  c.setAttribute('aria-label', `${state.facetLabels[key] || key}: ${value}. Show items sharing this`);
  c.addEventListener('click', e => selectFacetValue(key, value, e.shiftKey));
  return c;
}
function selectFacetValue(key, value, add = false) {
  rememberScope();
  const current = state.active.get(key);
  const next = add && current ? new Set(current) : new Set();
  if (add && current?.has(value)) next.delete(value); else next.add(value);
  state.active.set(key, next);
  applyFilters();
}

/** Narrow the working set to one group of the current grouping (Shift adds it to the current values). */
function selectGroup(value, add = false) {
  const key = state.groupKey;
  if (!key || key === 'none') return;
  rememberScope();
  const current = state.active.get(key);
  const next = add && current ? new Set(current) : new Set();
  next.add(value);
  state.active.set(key, next);
  closeDetail(); applyFilters();
}

/* ----------------------------------------------------------------- tour --- */

/**
 * Tour: a guided flythrough of the current layout. From Fit, the camera eases
 * into each group at a readable scale, sweeps across it, returns to Fit, and
 * moves on, looping until any input (pointer, wheel, key, filter) takes control
 * back. It only moves the camera: scope, layout and identities are untouched.
 */
const tourButton = document.getElementById('tour');
const tour = { on: false, timer: 0, plan: [], step: 0 };
function tourPlan() {
  const r = el.stage.getBoundingClientRect();
  const heights = [...state.positions.values()].map(p => p.h).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 240;
  const blocks = state.blocks?.length ? state.blocks : [{ x: 0, y: 0, w: viewport.content.w, h: viewport.content.h, tileH: median }];
  const plan = [{ kind: 'fit', duration: 1200, hold: 1400 }];
  for (const b of blocks) {
    // Enter at whichever is larger: tiles readable (~110px) or the block framed; capped so tiny groups do not balloon.
    const blockFit = Math.min(r.width / (b.w + 48), r.height / (b.h + 48));
    const s = Math.min(2, Math.max(110 / (b.tileH || median), blockFit));
    const winW = r.width / s, winH = r.height / s;
    const x0 = 12 - b.x * s, y0 = 12 - b.y * s; // the group's heading in the top-left corner
    plan.push({ kind: 'view', x: x0, y: y0, scale: s, duration: 1500, hold: 900 });
    const dx = Math.max(0, b.w - winW), dy = Math.max(0, b.h - winH);
    if (dx > 20 || dy > 20) {
      const dist = Math.hypot(dx, dy) * s; // screen px travelled
      plan.push({ kind: 'view', x: x0 - dx * s, y: y0 - dy * s, scale: s, duration: Math.min(9000, Math.max(2500, dist * 4)), hold: 700 });
    }
    plan.push({ kind: 'fit', duration: 1200, hold: 1200 });
  }
  return plan;
}
function tourStep() {
  if (!tour.on || state.spatialOn) return;
  if (tour.step >= tour.plan.length) { tour.plan = tourPlan(); tour.step = 0; }
  const step = tour.plan[tour.step++];
  if (step.kind === 'fit') { const v = viewport.fitTarget(); if (v) { viewport.animateTo(v.x, v.y, v.scale, { duration: step.duration }); viewport.fitted = true; } }
  else viewport.animateTo(step.x, step.y, step.scale, { duration: step.duration });
  tour.timer = setTimeout(tourStep, step.duration + step.hold);
}
function setTour(on) {
  tour.on = on;
  tourButton.setAttribute('aria-pressed', String(on)); tourButton.classList.toggle('on', on);
  clearTimeout(tour.timer); tour.timer = 0;
  if (on) { tour.plan = tourPlan(); tour.step = 0; tourStep(); }
}
tourButton.addEventListener('click', () => setTour(!tour.on));
// Any input takes control back.
for (const type of ['pointerdown', 'wheel']) el.stage.addEventListener(type, () => { if (tour.on) setTour(false); }, { passive: true, capture: true });
for (const id of ['zoom-in', 'zoom-out', 'zoom-fit']) document.getElementById(id).addEventListener('click', () => { if (tour.on) setTour(false); }, { capture: true });

/* ------------------------------------------------------------ row title --- */

/**
 * When zooming in crops a group's heading off the top of the stage, name the
 * group under the viewport in screen space. The title follows the block at a
 * third of pan speed, is pushed off by the next block's top edge, and steps to
 * the neighbouring group on activation. It reads the camera; it never sets
 * layout, membership or the camera except through an explicit step.
 */
const rowTitle = document.getElementById('row-title');
let rowTitleLabel = '', rowTitleWidth = 0;
/** Foreground blocks in screen space, plus the context plane's blocks projected
 *  by its depth (an approximation along the pivot line; the tilt is ignored). */
function screenBlocks(stageRect) {
  const s = viewport.scale;
  const flat = (state.blocks || []).map(b => ({ b, layer: 'focus', x: b.x * s + viewport.x, y: b.y * s + viewport.y, w: b.w * s, h: b.h * s }));
  if (!state.background.mounted || !state.background.framed) return flat;
  const d = backgroundDepth(); if (!d) return flat;
  const f = BG_PERSPECTIVE / (BG_PERSPECTIVE + d.depth * s), cx = stageRect.width / 2, cy = stageRect.height / 2;
  const plane = state.background.framed.blocks.map(b => ({ b, layer: 'context',
    x: cx + (b.x * s + viewport.x - cx) * f, y: cy + (b.y * s + viewport.y - cy) * f, w: b.w * s * f, h: b.h * s * f }));
  return flat.concat(plane);
}
function dominantBlock(stageRect, blocks = screenBlocks(stageRect)) {
  const W = stageRect.width, H = stageRect.height;
  let best = null, bestArea = 0;
  for (const r of blocks) {
    const area = Math.max(0, Math.min(W, r.x + r.w) - Math.max(0, r.x)) * Math.max(0, Math.min(H, r.y + r.h) - Math.max(0, r.y));
    if (area > bestArea) { bestArea = area; best = r; }
  }
  return best;
}
function updateRowTitle(stageRect) {
  const grouped = state.groupKey && state.groupKey !== 'none';
  const blocks = !state.spatialOn && grouped ? screenBlocks(stageRect) : [];
  const best = blocks.length ? dominantBlock(stageRect, blocks) : null;
  // The pinned title appears once the block's own heading is cropped off the top,
  // or (on the context plane) its label's left edge is off the stage.
  const headingOff = best && (best.y + HEADER_H * viewport.scale > 0 ? false : true);
  const leftOff = best && best.layer === 'context' && best.x < 0;
  const overviewLabels = HEADER_H * viewport.scale < headingScreenPx(viewport.scale) * 1.25 + 8;
  if (!best || !(headingOff || leftOff || overviewLabels)) { rowTitle.hidden = true; return; }
  const list = best.layer === 'context' ? state.background.framed.blocks : state.blocks;
  const index = list.indexOf(best.b), n = list.length;
  const label = `${best.layer}\u0000${best.b.label || 'Ungrouped'}\u0000${best.b.count}\u0000${index + 1}/${n}`;
  if (label !== rowTitleLabel) {
    rowTitleLabel = label;
    rowTitle.querySelector('strong').textContent = best.b.label || 'Ungrouped';
    rowTitle.querySelector('.n').textContent = String(best.b.count);
    rowTitle.querySelector('.pos').textContent = `${index + 1} of ${n}`;
    rowTitle.querySelector('.rt-focus').setAttribute('aria-label', `${best.b.label}, ${counted(best.b.count, state.nouns)}, group ${index + 1} of ${n}${best.layer === 'context' ? ', on the context plane. Filter to this group' : '. Approach this group'}`);
    rowTitle.dataset.layer = best.layer;
    rowTitle.hidden = false;
    rowTitleWidth = rowTitle.offsetWidth; // measured only when the text changes
  }
  rowTitle.dataset.index = String(index);
  rowTitle.dataset.label = best.b.label || '';
  // Sticky push-off: the next block's top edge pushes the title up and away.
  let push = 0;
  for (const r of blocks) if (r !== best && r.y > 0 && r.y < 46) push = Math.max(push, 46 - r.y);
  // Parallax: drift with the block's left edge at a third of its speed, kept on stage.
  const x = Math.max(12, Math.min(stageRect.width - rowTitleWidth - 12, 12 + best.x * 0.35));
  rowTitle.style.transform = `translate(${x.toFixed(1)}px, ${(-push).toFixed(1)}px)`;
  rowTitle.hidden = false;
}
/** Ease the camera so the neighbouring group's heading sits just below the stage top. */
function stepGroup(delta) {
  if (state.spatialOn || !state.blocks?.length) return;
  const r = el.stage.getBoundingClientRect(), s = viewport.scale;
  const current = dominantBlock(r);
  const i = current ? state.blocks.indexOf(current.b) : -1, n = state.blocks.length;
  const b = state.blocks[((i + delta) % n + n) % n];
  const x = b.w * s < r.width ? (r.width - b.w * s) / 2 - b.x * s : 12 - b.x * s;
  viewport.panTo(x, 12 - b.y * s, { duration: 420 });
}
rowTitle.querySelector('.rt-next').addEventListener('click', e => stepGroup(e.shiftKey ? -1 : 1));
rowTitle.querySelector('.rt-focus').addEventListener('click', e => {
  if (!rowTitle.dataset.label) return;
  if (rowTitle.dataset.layer === 'context' || e.shiftKey) selectGroup(rowTitle.dataset.label, e.shiftKey);
  else { const b = state.blocks.find(b => b.label === rowTitle.dataset.label); if (b) approachGroup(b); }
});
document.getElementById('group-filter').addEventListener('click', e => {
  if (rowTitle.dataset.label) selectGroup(rowTitle.dataset.label, e.shiftKey);
});
const trayReturnButton = document.getElementById('tray-return');
const trayFilterButton = document.getElementById('tray-filter');
function clearTrayReturn() { state.trayReturn = null; state.trayLabel = null; trayReturnButton.hidden = trayFilterButton.hidden = true; }
function approachGroup(block) {
  invalidatePreview();
  if (!state.trayReturn) state.trayReturn = viewport.visiblePose();
  const r = el.stage.getBoundingClientRect(), pad = viewport.fitPadding(r);
  const scale = Math.min(6, (r.width - 2 * pad) / block.w, (r.height - 2 * pad) / block.h);
  viewport.animateTo((r.width - block.w * scale) / 2 - block.x * scale,
    (r.height - block.h * scale) / 2 - block.y * scale, scale, { duration: 300 });
  trayReturnButton.hidden = false;
  state.trayLabel = block.label;
  trayFilterButton.hidden = false;
  trayFilterButton.setAttribute('aria-label', `Filter to ${block.label}`);
  trayReturnButton.setAttribute('aria-label', 'Return to collection');
}
function returnFromTray() {
  if (!state.trayReturn) return false;
  const pose = state.trayReturn; clearTrayReturn(); invalidatePreview();
  viewport.animateTo(pose.x, pose.y, pose.scale, { duration: 300 }); viewport.fitted = pose.fitted;
  return true;
}
trayReturnButton.addEventListener('click', returnFromTray);
trayFilterButton.addEventListener('click', e => { if (state.trayLabel) selectGroup(state.trayLabel, e.shiftKey); });

/**
 * Load images only once they can be seen, and hide the ones that cannot.
 * A vault of a few thousand clippings would otherwise open several thousand
 * concurrent requests on first paint.
 */
let loadTimer = 0, lastLoadFlush = 0;
/**
 * Culling is immediate. Image loads during a gesture are deferred until the
 * camera has been quiet for a moment (bounded to every 250ms mid-gesture), so
 * decodes do not compete with rasterising the zoom itself.
 */
function updateVisibility({ rect = null, defer = false } = {}) {
  const r = viewport.visibleRect(400, rect || undefined);
  const now = performance.now();
  // While an eased zoom is still landing, decodes would pop in mid-flight.
  const motionEnd = Math.max(viewport.settlesAt, layoutMotionUntil);
  const inFlight = now < motionEnd;
  // A pinch or edge zoom has no landing time; its end calls updateVisibility
  // again through the camera, so nothing is scheduled while it runs.
  const zooming = viewport.zooming;
  const load = !inFlight && !zooming && (!defer || now - lastLoadFlush > 250);
  if (load) { lastLoadFlush = now; clearTimeout(loadTimer); loadTimer = 0; }
  else if (zooming) { clearTimeout(loadTimer); loadTimer = 0; }
  else { clearTimeout(loadTimer); loadTimer = setTimeout(() => { loadTimer = 0; updateVisibility(); }, inFlight ? motionEnd - now + 30 : 120); }
  perf.span(load ? 'camera/reveal+load' : 'camera/reveal', () => revealTiles(r, state.tileEls, state.positions, load));
  if (state.background.mounted) {
    // Perspective shrinks the plane toward the stage centre, so a world rect
    // that is off the flat canvas can still be on screen: cull generously.
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, grow = 2;
    revealTiles({ x: cx - r.w * grow / 2, y: cy - r.h * grow / 2, w: r.w * grow, h: r.h * grow }, state.bgTileEls, state.bgPositions, load);
  }
}
function revealTiles(r, tileEls, positions, load) {
  // This runs on every frame of a pan, over every tile. Each write below is
  // guarded so a settled tile costs one rectangle test and nothing else: a
  // redundant `visibility` write still dirties style, and querySelector on
  // 1,800 tiles per frame was a measurable slice of every pan.
  // A tile entering view while a zoom is still travelling takes the tier it
  // will land in, so the landing does not restyle it a second time; tiles
  // already in view keep theirs until the landing.
  const travelling = performance.now() < viewport.settlesAt || viewport.zooming;
  const tier = travelling ? captionTierFor(viewport.scale) : captionTier;
  for (const [id, node] of tileEls) {
    const p = positions.get(id);
    if (!p) continue;
    const visible = p.x < r.x + r.w && p.x + p.w > r.x && p.y < r.y + r.h && p.y + p.h > r.y;
    // The caption tier lands only on tiles in view (applyScaleStyles); a tile
    // takes it here, before the visibility write, so it is never seen stale.
    // Background tiles never show captions.
    if (visible && tileEls === state.tileEls && !(travelling && p.shown)) applyCaptionTier(node, tier);
    if (p.shown !== visible) { p.shown = visible; node.style.visibility = visible ? '' : 'hidden'; }
    if (!visible || !load) continue;
    if (viewport.scale >= 0.30) {
      const labelScale = String(Math.max(1, 1 / viewport.scale));
      if (node.style.getPropertyValue('--label-scale') !== labelScale) node.style.setProperty('--label-scale', labelScale);
    }
    if (p.loaded) continue;
    // The <img> is the tile's first child when it has one; cache it on the
    // position record, which is rebuilt with every layout.
    const img = p.img ?? (p.img = node.firstElementChild?.tagName === 'IMG' ? node.firstElementChild : null);
    if (!img) { p.loaded = true; continue; }
    if (img.dataset.sprite !== undefined) {
      if (spriteCovers.serves(p.clip, devicePx(Math.max(p.w, p.h) * viewport.scale))) { revealSprite(node, id, p, positions); continue; }
      // Its cells' pages failed: the file loads below. With no file there is nothing left to show.
      if (img.dataset.file) { img.dataset.src = img.dataset.file; delete img.dataset.file; }
      if (img.dataset.fileSrcset) { img.dataset.srcset = img.dataset.fileSrcset; delete img.dataset.fileSrcset; }
      if (!img.dataset.src && !img.dataset.srcset && !img.currentSrc) { node.classList.add('broken'); p.loaded = true; continue; }
    }
    const sizes = `${Math.max(1, Math.ceil(p.w * viewport.scale))}px`;
    if (!img.dataset.src && (!img.dataset.srcset || (img.srcset && img.sizes === sizes))) continue;
    // The overview paints this tile from a baked page at this zoom; its own
    // file waits for a reading zoom (docs/PERF.md, "Overview sheets"). Not
    // marked loaded, so zooming in re-evaluates it.
    if (!img.currentSrc && overview.coversWithoutDom(node, p.sheetSource ??= overviewSource(p.clip), p.w * viewport.scale, viewport.scale)) continue;
    // Spend decode slots on the biggest visible imagery, not DOM insertion order.
    const current = () => node.isConnected && p.shown && positions.get(id) === p
      && positions === (node.classList.contains('bg') ? state.bgPositions : state.positions);
    imageWork.add(node, p.w * p.h * viewport.scale ** 2,
      current,
      async () => {
        // A preceding job may have exchanged the image while this one queued.
        const img = p.img;
        if (!img || node.firstElementChild !== img || (img.srcset && img.sizes === sizes && !img.dataset.src)) return;
        // Changing a displayed srcset/sizes can discard the old decoded request
        // before the next one arrives. Keep that exact artwork in place while
        // a bounded worker decodes its replacement, then exchange only pixels.
        if (img.naturalWidth > 0 && img.dataset.srcset) {
          const next = img.cloneNode(false);
          next.sizes = sizes; next.srcset = img.dataset.srcset;
          if (img.dataset.src) next.src = img.dataset.src;
          delete next.dataset.src;
          try { await next.decode(); } catch { return; }
          if (!current() || node.firstElementChild !== img
            || sizes !== `${Math.max(1, Math.ceil(p.w * viewport.scale))}px`) return;
          next.addEventListener('error', () => node.classList.add('broken'), { once: true });
          img.replaceWith(next); p.img = next;
          overview.replaceImage(node, next);
          return;
        }
        if (img.dataset.srcset) { img.sizes = sizes; img.srcset = img.dataset.srcset; }
        else p.loaded = true;
        if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
        try { await img.decode(); } catch {} // The tile's existing error placeholder is authoritative.
      });
  }
}

/**
 * A tile whose cover exists only as sprite-sheet cells (sprite-covers.mjs).
 * Its <img> gets the cell of the smallest level that holds the tile's drawn
 * size, and moves up a level, never down, when a zoom needs more pixels.
 * `data-sprite` records the level edge on screen (0: none yet).
 */
function revealSprite(node, id, p, positions) {
  const need = devicePx(Math.max(p.w, p.h) * viewport.scale);
  const cell = spriteCovers.cellFor(p.clip, need);
  if (!cell) { p.loaded = true; return; }
  const shown = Number(p.img.dataset.sprite) || 0;
  if (shown >= cell.edge) { if (shown >= spriteCovers.maxEdge(p.clip)) p.loaded = true; return; }
  // The overview paints this tile from the sheets at this zoom.
  if (!shown && overview.coversWithoutDom(node, p.sheetSource ??= overviewSource(p.clip), p.w * viewport.scale, viewport.scale)) return;
  const current = () => node.isConnected && p.shown && positions.get(id) === p
    && positions === (node.classList.contains('bg') ? state.bgPositions : state.positions);
  imageWork.add(node, p.w * p.h * viewport.scale ** 2, current, async () => {
    // Boot and every filter reveal at the old scale and fit in the same next
    // frame this work starts in. Wait one frame more and leave a moving camera
    // to its landing, which reveals again: at the fitted scale the overview
    // paints every tile, and a full-size page would be fetched for nothing.
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (performance.now() < viewport.settlesAt || viewport.zooming || !current()) return;
    const img = p.img;
    const scale = viewport.scale, need = devicePx(Math.max(p.w, p.h) * scale), on = Number(img?.dataset.sprite) || 0;
    if (!on && overview.coversWithoutDom(node, p.sheetSource ??= overviewSource(p.clip), p.w * scale, scale)) return;
    const cell = spriteCovers.cellFor(p.clip, need);
    if (!cell) { updateVisibility(); return; } // its page failed meanwhile: the file, or another level
    if (!img || node.firstElementChild !== img || on >= cell.edge) return;
    const url = await spriteCovers.url(p.clip, need);
    // A page that failed withdrew its cells; revealing again picks another
    // level, or the clip's file.
    if (!url) { if (current()) updateVisibility(); return; }
    if (!current() || node.firstElementChild !== img) return;
    if (img.naturalWidth > 0) {
      // Keep the smaller cell on screen until the larger one has decoded.
      const next = img.cloneNode(false);
      next.dataset.sprite = String(cell.edge); next.src = url;
      try { await next.decode(); } catch { return; }
      if (!current() || node.firstElementChild !== img) return;
      next.addEventListener('error', () => node.classList.add('broken'), { once: true });
      img.replaceWith(next); p.img = next;
      overview.replaceImage(node, next);
      return;
    }
    img.dataset.sprite = String(cell.edge); img.src = url;
    try { await img.decode(); } catch {} // The tile's error placeholder is authoritative.
  });
}

/* -------------------------------------------------------------- facets --- */

let facetRail = null;
function buildFacetRail() { perf.span('rail/update', () => {
  facetRail ||= createFacetRail({ host: el.rail, brush,
    getLabel: key => state.facetLabels[key] || key,
    onToggle: toggleFacet, onClear: clearFacet, pageSize: FACET_CHIP_LIMIT });
  const keys = [...new Set([
    ...facetOrder.filter(key => state.facets[key]),
    ...Object.keys(state.facets), ...state.active.keys()
  ])].filter(key => !FACET_BLOCKLIST.has(key));
  facetRail.update(buildFacetModel(state.clips, state, { keys, catalog: state.facets }));
}); }

function toggleFacet(key, value) {
  rememberScope();
  const next = new Set(state.active.get(key));
  if (next.has(value)) next.delete(value); else next.add(value);
  if (next.size) state.active.set(key, next); else state.active.delete(key);
  applyFilters();
  closeRailIfNarrow();
}

function clearFacet(key) {
  if (!state.active.get(key)?.size) return;
  rememberScope(); state.active.delete(key); applyFilters();
}

function removeFacetValue(key, value) {
  if (!state.active.get(key)?.has(value)) return;
  toggleFacet(key, value);
  document.getElementById('scope-back').focus({ preventScroll: true });
}

function buildGroupOptions() {
  const keys = ['none', ...facetOrder.filter((k) => state.facets[k] && !FACET_BLOCKLIST.has(k))];
  for (const k of Object.keys(state.facets)) {
    if (FACET_BLOCKLIST.has(k) || keys.includes(k)) continue;
    // Grouping by a near-unique key produces one block per clip; useless.
    if (Object.keys(state.facets[k]).length <= 24) keys.push(k);
  }
  // Arrangements rather than facets: offered when the index carries projection points / grid cells.
  if (state.clips.some(hasCell)) keys.splice(1, 0, SIMILARITY_GRID);
  if (state.clips.some(hasProjection)) keys.splice(1, 0, SIMILARITY);
  el.group.replaceChildren();
  for (const k of keys) {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = k === 'none' ? 'no grouping' : k === SIMILARITY ? 'similarity map' : k === SIMILARITY_GRID ? 'similarity grid' : state.facetLabels[k] || k;
    el.group.append(opt);
  }
}

/** Attributes a reader can sort, lens or place on a floating-space axis by, in facet order. */
const attributeKeys = () => [...new Set([...facetOrder, ...Object.keys(state.facets)].filter(k => !FACET_BLOCKLIST.has(k) && Object.keys(state.facets[k] || {}).length))];
function buildReviewControls() {
  const keys = ['title', ...attributeKeys()];
  for (const [id, value, label] of [['sort-key', state.sort.key, 'Original order'], ['attribute-lens', brush.getPinned() || 'none', 'No lens']]) {
    const select = document.getElementById(id); select.replaceChildren();
    for (const key of ['none', ...keys, ...(!keys.includes(value) && value !== 'none' ? [value] : [])]) {
      const option = document.createElement('option'); option.value = key;
      option.textContent = key === 'none' ? label : state.facetLabels[key] || (key === 'title' ? 'Title' : key);
      select.append(option);
    }
    select.value = value;
  }
  updateSortDirection();syncLensValue();
}
function syncLensValue() {
  const select=document.getElementById('lens-value'),key=brush.getPinned(),value=brush.getPinnedValue();
  select.hidden=!key || lensless(state.mode);
  if(!key){select.replaceChildren();return;}
  select.replaceChildren(new Option('All values',''));
  // Values use the filter's canonical form (captured dates are month prefixes).
  const values=[...new Set(state.filtered.flatMap(clip=>valuesOf(clip,key)).map(String).filter(v=>v.trim()))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  if(value!==null&&!values.includes(value))values.unshift(value);
  for(const label of values)select.append(new Option(label,label));
  select.value=value||'';
}
document.getElementById('lens-value').addEventListener('change',e=>brush.setPinned(brush.getPinned(),e.target.value||null));
function updateSortDirection() {
  const button = document.getElementById('sort-direction');
  const asc = state.sort.direction === 'asc';
  button.textContent = asc ? '↑' : '↓';
  button.setAttribute('aria-label', asc ? 'Sort ascending; reverse to descending' : 'Sort descending; reverse to ascending');
  button.disabled = lensless(state.mode) || state.sort.key === 'none';
}
function setSort(key, direction = state.sort.direction) {
  if (lensless(state.mode)) return;
  rememberScope();
  clearTrayReturn(); invalidatePreview();
  state.sort = { key, direction };state.aisleDirty=true;
  document.getElementById('sort-key').value = key;
  updateSortDirection();
  state.layoutAspect = null;
  if(state.mode==='aisle'){state.flatDirty=true;refreshSpatial();updateReviewOrder();}
  else {render();viewport.fit();}
}
document.getElementById('sort-key').addEventListener('change', e => setSort(e.target.value));
document.getElementById('sort-direction').addEventListener('click', () => setSort(state.sort.key, state.sort.direction === 'asc' ? 'desc' : 'asc'));
document.getElementById('attribute-lens').addEventListener('change', e => { brush.setPinned(e.target.value === 'none' ? null : e.target.value); syncOverview(); });

/* -------------------------------------------------------------- detail --- */

/* Hover preview -------------------------------------------------------------
 * Once Dive is open, hovering a tile shows that clip in the pane instead of the
 * selected one, and a click commits it. The preview is transient BY
 * CONSTRUCTION, not by convention: it writes only `state.preview`, which
 * nothing serialises. `state.selected` is what reaches ViewSpec.ui.focus, so a
 * hover cannot change the permalink (PERMALINKS.md: "Do not record hover"),
 * cannot move a tile, and cannot move the `.selected` ring off the committed
 * clip — the ring is how you can still see what you will return to.
 */
// A DWELL, not a hover. The pane sits to the right of the wall, so the pointer
// reaches its links — Open original, YouTube Music, Apple Music — by crossing
// whatever tiles lie between. At a tooltip-length delay each of those counted
// as a hover and swapped the pane out from under the cursor, which made the
// links in it unclickable. The pointer must now stop and stay stopped.
const PREVIEW_DWELL = 500;
// And leaving a tile does not end the preview immediately, because the journey
// to the pane starts by leaving a tile. The pane's own pointerenter cancels
// this; the grace only has to outlast the gap between the two.
const PREVIEW_LINGER = 320;
let previewTimer = null, previewMedia = null, previewPoint = null;
// True while the preview was opened by zooming in rather than by a hover dwell.
// It is still only `state.preview`: no selection, no ViewSpec, no camera move.
let previewByZoom = false;
function invalidatePreview() {
  previewPoint = null;
  endPreview();
}


function hoverPreview(clip, e) {
  if (!state.selected) return;                              // nothing to override outside Dive
  if (e && (e.buttons !== 0 || e.pointerType === 'touch')) return;  // a pan is not a hover
  if (performance.now() < viewport.settlesAt && !state.spatialOn) return;
  if (e) {
    if (e.type !== 'pointermove') return;
    if (previewPoint && Math.hypot(e.clientX - previewPoint.x, e.clientY - previewPoint.y) < 2) return;
    previewPoint = { x: e.clientX, y: e.clientY };
  }
  clearTimeout(previewTimer);
  if (clip.id === state.selected) { endPreview(); return; } // hovering home returns home
  if (state.preview === clip.id) return;
  previewTimer = setTimeout(() => showPreview(clip), PREVIEW_DWELL);
}

function showPreview(clip) {
  if (!state.selected || clip.id === state.selected) return;
  if (state.preview === null) previewMedia = state.detailMedia;  // hold the committed frame
  previewByZoom = false;
  state.preview = clip.id;
  state.detailMedia = null;
  el.detail.dataset.preview = 'true';
  renderDetail(clip);
}

/** Leaving a tile ends the preview, unless the pointer is on its way into the pane. */
function hoverEnd() {
  clearTimeout(previewTimer);
  if (previewByZoom) return;                                // zooming out ends a zoom preview, not the pointer
  previewTimer = setTimeout(() => endPreview(), PREVIEW_LINGER);
}

function endPreview({ silent = false } = {}) {
  clearTimeout(previewTimer);
  if (state.preview === null) return;
  const byZoom = previewByZoom;
  state.preview = null; previewByZoom = false;
  state.detailMedia = previewMedia; previewMedia = null;
  delete el.detail.dataset.preview;
  if (silent) return;                                       // caller renders its own clip next
  if (byZoom && !state.selected) { detailPane.close(); return; }  // the pane was the preview's alone
  const clip = state.clips.find(c => c.id === state.selected);
  if (clip) renderDetail(clip);
}

/* Details on zoom (ledger idea 27; rule in zoom-detail.mjs) ----------------
 * OFF BY DEFAULT since 2026-11-14 (see ZOOM_DETAIL above and TODO.md).
 *
 * Zooming in until one cover dominates the free view previews it in the pane
 * with no click; zooming out ends that preview. It is decided only once the
 * camera has been still for ZOOM_DETAIL_QUIET after a zoom lands, never per
 * frame of a pinch or wheel run. It rides the preview path, so it commits no
 * selection, scope, view state or permalink, and it never moves the camera:
 * the pane overlays the fixed stage and the rule centres on the uncovered part.
 * Without a selection the pane opens for the preview alone and closes with it.
 * The 3D view has no equivalent: approach there promotes covers to DOM cards
 * that already carry title, source, date and tags (docs/ZOOM_DETAIL.md).
 */
const ZOOM_DETAIL_QUIET = 120;
let zoomDetailTimer = 0;
// An item whose zoom preview the user dismissed (Escape, ×). It stays dismissed
// until the view zooms out past the close threshold or centres another item.
let zoomDismissed = null;
function scheduleZoomDetail() {
  clearTimeout(zoomDetailTimer); zoomDetailTimer = 0;
  if (!ZOOM_DETAIL) return;
  if (state.spatialOn || viewport.zooming) return;          // a pinch's end calls back here once more
  const wait = Math.max(0, viewport.settlesAt - performance.now()) + ZOOM_DETAIL_QUIET;
  zoomDetailTimer = setTimeout(applyZoomDetail, wait);
}
function applyZoomDetail() {
  zoomDetailTimer = 0;
  if (state.preview && !previewByZoom) return;              // a hover preview is the user's more recent intent
  const stage = el.stage.getBoundingClientRect();
  // 3D, the full-window mobile reader and hydration never preview by zoom, and
  // nor does a still: a pane opened by the zoom would cover the shot.
  // Zoomed all the way out is never zoomed in, however few items fill the view.
  const floor = viewport.scaleFloor?.(), atFloor = viewport.fitted || (floor > 0 && viewport.scale <= floor * 1.01);
  // The rule weighs foreground tiles only. With the selection on the context
  // plane its pick would be whichever foreground cover sits near the centre,
  // replacing the item being read after every step along the plane.
  const offForeground = state.selected && !(state.order || []).some(c => c.id === state.selected);
  const pick = state.spatialOn || hydrating || CHROMELESS || atFloor || offForeground || window.innerWidth <= 800 ? null
    : zoomDetailCandidate({
      tiles: state.positions.values(), pose: viewport.snapshot(), stage,
      // The pane's width whether or not it is open, so opening it moves nothing.
      rail: stage.right - (window.innerWidth - el.detail.offsetWidth),
      current: previewByZoom ? state.preview : zoomDismissed,
      open: previewByZoom || !!zoomDismissed,
    });
  if (!pick) { zoomDismissed = null; if (previewByZoom) endPreview(); return; }
  if (pick.id === zoomDismissed) return;
  zoomDismissed = null;
  if (pick.id === state.selected) { if (previewByZoom) endPreview(); return; }
  if (previewByZoom && pick.id === state.preview) return;
  const clip = state.clips.find(c => c.id === pick.id);
  if (clip) showZoomPreview(clip);
}
function showZoomPreview(clip) {
  if (state.selected) { showPreview(clip); previewByZoom = true; return; }
  clearTimeout(previewTimer);
  if (state.preview === null) previewMedia = state.detailMedia;
  state.preview = clip.id; previewByZoom = true;
  state.detailMedia = null;
  el.detail.dataset.preview = 'true';
  renderDetail(clip);
  detailPane.open();
}
/** The user put a zoom preview away; do not reopen it at the next landing. */
function dismissZoomPreview() { if (previewByZoom) zoomDismissed = state.preview; }

/** Promote the previewed clip to the selection. */
function commitPreview() {
  const clip = state.preview && state.clips.find(c => c.id === state.preview);
  if (clip) openDetail(clip);
  return !!clip;
}

// Reading the preview keeps it: the pointer entering the pane cancels the end.
// Clicking a non-interactive part of it commits, so the pane itself is a target
// for "yes, this one" without going back to the tile.
el.detail.addEventListener('pointerenter', () => clearTimeout(previewTimer));
el.detail.addEventListener('pointerdown', e => { if (e.target.closest('.detail-resize')) invalidatePreview(); });
el.detail.addEventListener('pointerleave', () => { if (state.preview) hoverEnd(); });
el.detail.addEventListener('click', (e) => {
  if (state.preview && !e.target.closest('a, button, .thumbs img')) commitPreview();
});

function itemSource(clip, pose = null, sourceNode = null) {
  if (state.spatialOn) return { sourceRect: activeSpatial()?.originRectangle(clip), sourceSrc: spriteCovers.peekUrl(clip) || clip.cover };
  const hintedImage = sourceNode?.isConnected && sourceNode.querySelector('img');
  if (hintedImage && !pose) return { source: hintedImage, sourceRect: hintedImage.getBoundingClientRect(),
    sourceSrc: hintedImage.currentSrc || hintedImage.src || spriteCovers.peekUrl(clip) || clip.cover };
  // Background perspective is not flat world geometry. The lift retains its
  // captured origin for exact return instead of borrowing a foreground copy.
  if (pose && sourceNode?.classList.contains('bg')) return {};
  const entries = [...state.positions].filter(([, t]) => t.clip.id === clip.id);
  const r = el.stage.getBoundingClientRect(), camera = pose || viewport.visiblePose();
  const found = entries.find(([key]) => state.tileEls.get(key) === sourceNode) || entries.find(([, t]) =>
    t.x * camera.scale + camera.x >= 0 && t.x * camera.scale + camera.x < r.width &&
    t.y * camera.scale + camera.y >= 0 && t.y * camera.scale + camera.y < r.height) || entries[0];
  if (!found) return {};
  const [key, t] = found, source = state.tileEls.get(key)?.querySelector('img');
  return { source: pose ? null : source,
    sourceRect: { left: r.left + camera.x + t.x * camera.scale, top: r.top + camera.y + t.y * camera.scale,
      width: t.w * camera.scale, height: t.h * camera.scale },
    sourceSrc: source?.currentSrc || source?.src || spriteCovers.peekUrl(clip) || clip.cover };
}
function exposeReadingItem(clip, sourceNode = null) {
  if (state.spatialOn || window.innerWidth <= 800 || sourceNode?.classList.contains('bg')) return;
  const entries = [...state.positions].filter(([, t]) => t.clip.id === clip.id);
  // Multi-valued grouping repeats one identity in several places. Expose the
  // occurrence that lent its image to the reader, not its first other copy.
  const p = (entries.find(([key]) => state.tileEls.get(key) === sourceNode) || entries[0])?.[1];
  if (!p) return;
  const stage = el.stage.getBoundingClientRect(), pane = el.detail.getBoundingClientRect();
  const width = Math.max(120, pane.left - stage.left), scale = viewport.scale;
  const left = viewport.x + p.x * scale, right = left + p.w * scale;
  if (right > width - 16 || left < 16) {
    viewport.panTo(width / 2 - (p.x + p.w / 2) * scale, viewport.y, { duration: 220 });
  }
}
/** Commit a clip as the selection and show it. The only path that writes state.selected. */
function openDetail(clip, opts) { perf.span('detail/open', () => openDetailNow(clip, opts)); }
function openDetailNow(clip, { sourceNode = null } = {}) {
  const origin = itemSource(clip, null, sourceNode);
  if (!state.selected) state.detailReturn = { camera: viewport.visiblePose(), epoch: state.layoutEpoch,
    focus: document.activeElement, sourceNode, selected: clip.id, width: window.innerWidth, height: window.innerHeight };
  if (!state.spatialOn) viewport.fitted = false;
  readerLift.cancel(); readerMedia.cancel();
  activeSpatial()?.cancelHover?.();
  previewPoint = null;
  endPreview({ silent: true });
  state.unresolvedFocus = null; state.detailMedia = null;
  state.selected = clip.id;
  state.aisle?.setFocused?.(clipKey(clip));
  state.float?.setFocused?.(clipKey(clip));
  for (const [key, node] of state.tileEls) node.classList.toggle('selected', state.positions.get(key)?.clip.id === clip.id);
  for (const [key, node] of state.bgTileEls) node.classList.toggle('selected', state.bgPositions.get(key)?.clip.id === clip.id);
  renderDetail(clip);
  detailPane.open();
  const image = detailPane.content.querySelector(':scope > img');
  if (image && !hydrating) void readerLift.open({ ...origin, image });
  exposeReadingItem(clip, sourceNode);
}

/** Paint one clip into the pane. Says nothing about selection — a preview renders through here too. */
function renderDetail(clip) {
  readerMedia.cancel(); readerLift.cancel();
  const d = detailPane.content;
  d.replaceChildren();

  const close = document.createElement('button');
  close.className = 'close';
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', closeDetail);
  d.append(close);

  // Traverse the review order without leaving Dive: buttons, arrow keys, or a swipe.
  // A context-plane item counts its place in the plane's walk (walkFrom).
  const order = walkFrom(clip.id)?.order || [], at = order.findIndex(c => c.id === clip.id);
  if (order.length > 1 && at >= 0) {
    const nav = document.createElement('div'); nav.className = 'detail-nav';
    const prev = document.createElement('button'); prev.type = 'button'; prev.className = 'btn'; prev.textContent = '‹'; prev.setAttribute('aria-label', 'Previous item'); prev.addEventListener('click', () => stepDetail(-1));
    const pos = document.createElement('span'); pos.className = 'pos'; pos.textContent = `${at + 1} of ${order.length}`;
    const next = document.createElement('button'); next.type = 'button'; next.className = 'btn'; next.textContent = '›'; next.setAttribute('aria-label', 'Next item'); next.addEventListener('click', () => stepDetail(1));
    nav.append(prev, pos, next); d.append(nav);
  }

  // A cover served by sprite-sheet cells shows what the tile already holds,
  // then the largest cell, or the file if that cell's page fails. A
  // detailCover file still wins.
  const sprite = !clip.detailCover && spriteCovers.has(clip);
  const cover = clip.detailCover || clip.cover || clip.media?.[0]?.src;
  if (clip.video) {
    // A video item plays here, muted and looping as on its tile, with controls
    // for sound and scrubbing; its cover is the poster until the first frame.
    const video = document.createElement('video');
    video.muted = true; video.loop = true; video.autoplay = true; video.playsInline = true; video.controls = true;
    if (cover) video.poster = cover;
    video.src = clip.video;
    d.append(video);
  } else if (cover || sprite) {
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    d.append(img);
    const origin = itemSource(clip);
    if (sprite) {
      if (origin.sourceSrc) img.src = origin.sourceSrc;
      void spriteCovers.coverUrl(clip, Infinity, cover).then(src => {
        if (src && img.isConnected) void readerMedia.prepareImage(img, clip, { thumbnail: img.getAttribute('src') || src, src });
      });
    } else void readerMedia.prepareImage(img, clip, { thumbnail: origin.sourceSrc || clip.cover });
    if (order.length && at >= 0) {
      const near = [order[(at + 1) % order.length], order[(at - 1 + order.length) % order.length]];
      // Cells are prefetched as cells, not as the files they stand in for.
      readerMedia.prefetch(near.filter(next => !spriteCovers.has(next) || next.detailCover));
      for (const next of near) if (spriteCovers.has(next) && !next.detailCover) void spriteCovers.url(next);
    }
  }

  const h2 = document.createElement('h2');
  h2.textContent = clip.title || '(untitled)';
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = [clip.source, clip.captured, clip.kind].filter(Boolean).join('  ·  ');
  d.append(h2, meta);

  if (clip.tags?.length) {
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const t of clip.tags) chips.append(exampleChip('tags', t));
    d.append(chips);
  }
  // Filter by example: every facet value this item carries is a chip. Click
  // narrows the working set to items sharing it; Shift-click adds the value.
  const facetKeys = Object.keys(clip.props || {}).filter(k => !FACET_BLOCKLIST.has(k) && state.facets[k] && Object.keys(state.facets[k]).length > 1);
  if (facetKeys.length) {
    const attrs = document.createElement('dl'); attrs.className = 'attrs';
    for (const key of facetKeys) {
      const values = [].concat(clip.props[key]).filter(v => v !== '' && v !== null && v !== undefined).map(String);
      if (!values.length) continue;
      const dt = document.createElement('dt'); dt.textContent = state.facetLabels[key] || key;
      const dd = document.createElement('dd'); dd.className = 'chips';
      for (const v of values) dd.append(exampleChip(key, v));
      attrs.append(dt, dd);
    }
    d.append(attrs);
  }

  // Listen: an album (and each track) opens a search on YouTube Music or
  // Apple Music. Search links need no keys and Apple's page hands off to the
  // app on macOS and iOS. Local playback (Psychodeli) is a later hook; the
  // record already carries the file locations for it.
  if (clip.artist && clip.album) {
    const listen = document.createElement('div'); listen.className = 'listen';
    for (const [text, href] of listenLinks(`${clip.artist} ${clip.album}`)) listen.append(linkButton(text, href, true));
    d.append(listen);
    if (clip.tracks?.length) {
      const list = document.createElement('ol'); list.className = 'tracks';
      for (const track of clip.tracks) {
        const li = document.createElement('li');
        const name = document.createElement('span'); name.className = 'track'; name.textContent = track;
        li.append(name);
        for (const [text, href, service] of listenLinks(`${clip.artist} ${track}`)) {
          const a = document.createElement('a'); a.className = 'btn play'; a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
          a.textContent = text === 'YouTube Music ↗' ? '▶' : '';
          a.setAttribute('aria-label', `Play ${track} on ${service}`);
          li.append(a);
        }
        list.append(li);
      }
      d.append(list);
    }
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  if (clip.sourceUrl || clip.url) actions.append(linkButton(clip.sourceLabel || 'Open source ↗', clip.sourceUrl || clip.url, true));
  // The whole point of the Obsidian bootstrap: corrections happen over there.
  if (clip.editUri) actions.append(linkButton('Edit in Obsidian', clip.editUri, false));
  d.append(actions);

  // Duplicates the server collapsed into this tile (lib/dedupe.mjs) stay reachable here.
  if (Array.isArray(clip.alsoAt) && clip.alsoAt.length) {
    const also = document.createElement('details');
    also.className = 'also-at';
    const summary = document.createElement('summary');
    summary.textContent = `${clip.alsoAt.length} more with the same page or image`;
    const list = document.createElement('ul');
    for (const other of clip.alsoAt) {
      if (!/^https?:\/\//i.test(String(other?.url))) continue;
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = other.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = other.title || other.url;
      li.append(a);
      if (other.source || other.captured) li.append(document.createTextNode(` · ${[other.source, other.captured].filter(Boolean).join(' · ')}`));
      list.append(li);
    }
    also.append(summary, list);
    d.append(also);
  }

  if (Array.isArray(clip.palette)) {
    const palette = document.createElement('div');
    palette.className = 'palette';
    palette.setAttribute('aria-label', 'Extracted palette');
    for (const hex of clip.palette.filter(value => /^#[0-9a-f]{6}$/i.test(value))) {
      const item = document.createElement('span');
      const swatch = document.createElement('i');
      swatch.style.backgroundColor = hex;
      swatch.setAttribute('aria-hidden', 'true');
      item.append(swatch, document.createTextNode(hex));
      palette.append(item);
    }
    d.append(palette);
  }

  if (clip.note) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = clip.note;
    d.append(note);
  }

  if (clip.media?.length > 1) {
    const thumbs = document.createElement('div');
    thumbs.className = 'thumbs';
    for (const m of clip.media) {
      const img = document.createElement('img');
      img.src = m.src;
      img.alt = '';
      img.addEventListener('click', () => { state.detailMedia = m.src; d.querySelector('img').src = m.src; });
      thumbs.append(img);
    }
    d.append(thumbs);
  }

  // A media choice outlives a re-render: endPreview() repaints the committed
  // clip and must land on the frame the user had picked, not back on the cover.
  if (state.detailMedia) {
    const img = d.querySelector('img');
    if (img && clip.media?.some(m => m.src === state.detailMedia)) img.src = state.detailMedia;
  }
}

/** Search deep links per service: [label, href, service name]. */
function listenLinks(query) {
  const q = encodeURIComponent(query);
  return [
    ['YouTube Music ↗', `https://music.youtube.com/search?q=${q}`, 'YouTube Music'],
    ['Apple Music ↗', `https://music.apple.com/us/search?term=${q}`, 'Apple Music'],
  ];
}

function linkButton(text, href, external) {
  const a = document.createElement('a');
  a.className = 'btn';
  a.textContent = text;
  a.href = href;
  if (external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  return a;
}

/**
 * What the arrows walk from an item: the layer it lives on. An item in scope
 * walks the review order over the foreground's tiles. One that exists only on
 * the context plane walks the plane in its layout order, over the plane's
 * tiles. The plane's walk leaves out what the foreground holds, so a step
 * never hands the selection to the other layer and switches orders mid-walk.
 * Null when the item is on neither (the plane is dismissed).
 */
function walkFrom(id) {
  const order = state.order || [];
  if (order.some(c => c.id === id)) return { order, tiles: [...state.positions.values()], centre: centreOnTile };
  const framed = state.background.mounted && state.background.framed;
  if (!framed) return null;
  const inScope = new Set(state.filtered.map(clipKey));
  const tiles = framed.tiles.filter(t => !inScope.has(clipKey(t.clip)));
  if (!tiles.some(t => t.clip.id === id)) return null;
  const seen = new Set(), plane = [];
  for (const t of tiles) if (!seen.has(t.clip.id)) { seen.add(t.clip.id); plane.push(t.clip); }
  return { order: plane, tiles, centre: centreOnPlaneTile };
}
/** Open the neighbouring item in review order and bring its tile under the camera at the current scale. */
function stepDetail(delta) { perf.span('detail/step', () => stepDetailNow(delta)); }
function stepDetailNow(delta) {
  const walk = walkFrom(state.selected), order = walk?.order || [];
  const i = order.findIndex(c => c.id === state.selected);
  if (i < 0 || order.length < 2) return;
  const clip = order[((i + delta) % order.length + order.length) % order.length];
  openDetail(clip);
  if (state.spatialOn) return;
  const p = walk.tiles.find(t => t.clip.id === clip.id);
  if (p) walk.centre(p);
}
/** Bring a laid-out tile under the camera, centred in the area left of the pane. */
function centreOnTile(p) {
  const r = el.stage.getBoundingClientRect(), s = viewport.scale;
  const width = Math.max(120, Math.min(r.width, el.detail.getBoundingClientRect().left - r.left));
  viewport.panTo(width / 2 - (p.x + p.w / 2) * s, r.height / 2 - (p.y + p.h / 2) * s, { duration: 220 });
}
/**
 * centreOnTile for a context-plane tile. The plane is not flat world geometry:
 * mirrorBackground pushes it back, tilts it about the foreground's centre line
 * and projects it about the stage centre. Solve that projection for the camera
 * that lands the tile's centre on the same target. A pan moves the camera
 * inside the projection, so it leaves the tile's depth, and its scale factor f,
 * unchanged; the solve is closed-form.
 */
function centreOnPlaneTile(p) {
  const d = backgroundDepth(), st = state.background.stage;
  if (!d || !st) return;
  const r = el.stage.getBoundingClientRect(), s = viewport.scale, tilt = BG_TILT_DEG * Math.PI / 180;
  const width = Math.max(120, Math.min(r.width, el.detail.getBoundingClientRect().left - r.left));
  const wx = p.x + p.w / 2, wy = p.y + p.h / 2;
  const z = s * ((wy - d.py) * Math.sin(tilt) - d.depth);    // rotateX: above the pivot recedes
  const f = BG_PERSPECTIVE / (BG_PERSPECTIVE - z);
  const x = (width / 2 - st.w / 2) / f + st.w / 2 - s * wx;
  const y = (r.height / 2 - st.h / 2) / f + st.h / 2 - s * (d.py + (wy - d.py) * Math.cos(tilt));
  if (Number.isFinite(x) && Number.isFinite(y)) viewport.panTo(x, y, { duration: 220 });
}
/**
 * Up/Down with a detail open: move to the nearest tile above or below the
 * selection in the laid-out grid, as Left/Right walk the review order. "Nearest"
 * prefers tiles whose column overlaps the current one, then the smallest gap,
 * so a step lands on the visible neighbour rather than the next item in order.
 * A context-plane selection walks the plane's grid (walkFrom). Flat wall only;
 * the spatial view has no grid to walk. No-op at the edge.
 */
function stepDetailVertical(dir) {
  if (state.spatialOn) return;
  const walk = walkFrom(state.selected);
  if (!walk) return;
  const tiles = walk.tiles;
  const from = tiles.find(t => t.clip.id === state.selected);
  if (!from) return;
  const fromMid = from.x + from.w / 2;
  let best = null, bestScore = Infinity;
  for (const t of tiles) {
    if (t.clip.id === state.selected) continue;
    const gap = dir > 0 ? t.y - (from.y + from.h) : from.y - (t.y + t.h);
    if (gap < -1) continue;                                  // not beyond the edge in that direction
    const apart = Math.max(0, Math.max(t.x, from.x) - Math.min(t.x + t.w, from.x + from.w));
    const score = gap + 3 * apart + 0.1 * Math.abs(t.x + t.w / 2 - fromMid);
    if (score < bestScore) { bestScore = score; best = t; }
  }
  if (!best) return;
  openDetail(best.clip);
  walk.centre(best);
}
// Swipe across the detail pane steps through the review order (phones).
{ let start = null;
  el.detail.addEventListener('pointerdown', e => { start = e.pointerType === 'touch' && !e.target.closest('.detail-resize') ? { x: e.clientX, y: e.clientY } : null; });
  el.detail.addEventListener('pointerup', e => { if (!start) return; const dx = e.clientX - start.x, dy = e.clientY - start.y; start = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) stepDetail(dx < 0 ? 1 : -1); });
  el.detail.addEventListener('pointercancel', () => { start = null; }); }

function closeDetail() { perf.span('detail/close', closeDetailNow); }
function closeDetailNow() {
  // Closing while zoomed in must not have the next landing reopen what was just put away.
  zoomDismissed = (previewByZoom && state.preview) || state.selected || zoomDismissed;
  const clip = state.clips.find(c => c.id === state.selected), back = state.detailReturn;
  const recover = back && back.epoch === state.layoutEpoch && back.width === window.innerWidth && back.height === window.innerHeight;
  endPreview();
  if (clip) void readerLift.close({ ...itemSource(clip, recover && !state.spatialOn ? back.camera : null, back?.selected === clip.id ? back.sourceNode : null), image: detailPane.content.querySelector(':scope > img') });
  else readerLift.cancel();
  readerMedia.cancel(); previewPoint = null;
  endPreview({ silent: true });
  state.unresolvedFocus = null; state.detailMedia = null;
  detailPane.close();
  state.selected = null; state.detailReturn = null;
  if (recover && !state.spatialOn && !hydrating) viewport.restore(back.camera);
  if (back?.focus?.isConnected && !hydrating) back.focus.focus?.({ preventScroll: true });
  for (const node of state.tileEls.values()) node.classList.remove('selected');
  for (const node of state.bgTileEls.values()) node.classList.remove('selected');
}

function showEmpty(title, detail) {
  el.empty.replaceChildren();
  const h2 = document.createElement('h2');
  h2.textContent = title;
  el.empty.append(h2);
  if (detail) {
    const p = document.createElement('p');
    p.style.whiteSpace = 'pre-line'; // a collection's problems arrive one per line
    p.textContent = detail;
    el.empty.append(p);
  }
  if (!state.clips.length) {
    const code = document.createElement('code');
    code.textContent = 'node clip.mjs "https://…" --tags govee,game-room --shot';
    el.empty.append(code);
  }
  el.empty.classList.remove('hidden');
}

/* --------------------------------------------------------------- input --- */

// At most one filter per frame, with the latest value. Filtering inside each
// keystroke's handler made the next key queue behind the whole filter and render
// (the third key of three waited 137 ms before its handler ran).
let searchFrame = 0;
el.search.addEventListener('input', () => {
  if (!searchFrame) searchFrame = requestAnimationFrame(applySearch);
});
function applySearch() {
  searchFrame = 0;
  // A restore or a cluster choice may have set the query since the keystroke.
  if (el.search.value === state.query) return;
  if (!state.scopeHistory.length || state.scopeHistory.at(-1).query === state.query) rememberScope();
  // Search is the first focus: the place you searched from becomes the context
  // plane, results are the focus, and matches light up where they were.
  if (!state.query.trim() && el.search.value.trim()) state.contextBase = { clips: state.filtered.slice(), label: scopeLabel() };
  state.query = el.search.value;
  applyFilters();
}

el.group.addEventListener('change', () => {
  clearTrayReturn(); invalidatePreview();
  state.arrangementOverride = null; state.layoutAspect = null;
  state.groupKey = el.group.value;
  state.spatialDirty = state.aisleDirty = true;
  if(state.mode==='aisle')refreshSpatial();
  else if (state.spatialOn && state.spatial) {
    if (piled(state.groupKey)) state.spatial.showPiles(state.groupKey);
    else state.spatial.showMountain(state.groupKey);
    saveViewState();
  }
  syncArrangement();
  if (state.spatialOn) { state.flatDirty = true; updateReviewOrder(); }
  else { render(); requestAnimationFrame(() => viewport.fit()); }
});

const panBehavior = document.getElementById('pan-behavior');
const edgeFeedback = document.getElementById('edge-feedback');
const edgeUndo = document.getElementById('edge-undo');
panBehavior.addEventListener('change', () => {
  viewport.setPanMode(panBehavior.value);
  const url = new URL(location.href);
  if (panBehavior.value === 'edge') url.searchParams.delete('pan');
  else url.searchParams.set('pan', panBehavior.value);
  history.replaceState(history.state, '', url);
});
edgeUndo.addEventListener('click', () => viewport.undoEdge());
el.stage.addEventListener('edge-pan', ({ detail }) => {
  const labels = { limit: 'Collection edge', edge: 'Edge reached · keep pushing into it to zoom',
    zoom: 'Edge zoom · reverse this drag to undo', done: 'Edge zoom applied · Esc or Undo restores the previous view' };
  edgeFeedback.textContent = labels[detail.phase] || (detail.mode === 'edge'
    ? 'Push a drag past an edge to zoom · wheel scrolling stays bounded'
    : detail.mode === 'bounded' ? 'Panning stops at collection edges' : '');
  edgeUndo.hidden = !detail.canUndo;
});

document.getElementById('zoom-in').addEventListener('click', () => zoomBy(1.3));
document.getElementById('zoom-out').addEventListener('click', () => zoomBy(1 / 1.3));
function zoomBy(factor) {
  if (state.spatialOn) activeSpatial().zoomBy(factor);
  else viewport.zoomBy(factor);
}
function fitWall() {
  clearTrayReturn(); invalidatePreview();
  state.layoutAspect = null;
  if (state.spatialOn) activeSpatial().fitView();
  else { setBackgroundRevealed(false); render(); viewport.fit(); }
}
document.getElementById('zoom-fit').addEventListener('click', fitWall);
/** Phones: the rail is an overlay that starts closed and closes after a choice. */
const narrow = () => matchMedia('(max-width: 700px)').matches; // Tabtopia: keep narrow windows usable too
function closeRailIfNarrow() {
  if (narrow() && !el.rail.classList.contains('hidden')) {
    const ownsFocus = el.rail.contains(document.activeElement);
    el.rail.classList.add('hidden'); el.stage.classList.add('full');
    document.getElementById('toggle-rail').setAttribute('aria-expanded', 'false');
    if (ownsFocus) document.getElementById('toggle-rail').focus({ preventScroll: true });
  }
}
matchMedia('(max-width: 700px)').addEventListener('change', closeRailIfNarrow);
if (narrow()) {
  el.rail.classList.add('hidden'); el.stage.classList.add('full');
  document.getElementById('toggle-rail').setAttribute('aria-expanded', 'false');
}
document.getElementById('toggle-rail').addEventListener('click', () => {
  el.rail.classList.toggle('hidden');
  el.stage.classList.toggle('full');
  document.getElementById('toggle-rail').setAttribute('aria-expanded', String(!el.rail.classList.contains('hidden')));
});

el.view3d.addEventListener('click', () => toggleSpatial(!threeD(state.mode), state.last3d));
el.viewAisle.addEventListener('click',()=>toggleSpatial(state.mode!=='aisle','aisle'));
window.addEventListener('keydown', (e) => {
  // '3' only when not typing — the search box owns every printable key.
  if (e.key === '3' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement || e.target.isContentEditable)
      && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    toggleSpatial(!threeD(state.mode), state.last3d);
  }
});

el.stage.addEventListener('dblclick', (e) => { if (!state.spatialOn) viewport.zoomAt(e.clientX, e.clientY, 1.9); });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el.detail.classList.contains('open')) {
    // Escape unwinds one level at a time: drop the preview back to the selected
    // clip first, and only close the pane once there is no preview to drop.
    if (state.preview) { dismissZoomPreview(); endPreview(); } else closeDetail();
    e.stopPropagation();
  }
}, true);

window.addEventListener('keydown', (e) => {
  if(e.defaultPrevented)return;
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  if (e.key === 'Escape') {
    if (!state.spatialOn && viewport.undoEdge()) { e.preventDefault(); return; }
    if (!state.spatialOn && returnFromTray()) { e.preventDefault(); return; }
    // Esc closes the detail pane first (the capture handler above), then puts out a lit set.
    if (state.lit && !el.detail.classList.contains('open')) { e.preventDefault(); setLit(null); return; }
    closeDetail(); el.search.blur(); return;
  }
  if (typing) return;
  // Native controls and tile handlers own Enter. A zoom/hover preview must not
  // intercept a focused scope-removal button or another deliberate action.
  if (state.preview && e.key === 'Enter' && !e.defaultPrevented &&
      !e.target.closest?.('button, a, input, select, textarea, [role="button"], [contenteditable]')) {
    e.preventDefault(); commitPreview(); return;
  }

  if (state.selected && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.target.closest?.('.detail-resize')) {
    // The arrows walk the review order from the SELECTION, so a hover in flight
    // is dropped rather than silently becoming the thing you stepped from.
    e.preventDefault(); endPreview(); stepDetail(e.key === 'ArrowRight' ? 1 : -1); return;
  }
  // Up/Down walk the grid. Inside the pane they stay native, so a long note scrolls.
  if (state.selected && !state.spatialOn && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.target.closest?.('#detail')) {
    e.preventDefault(); endPreview(); stepDetailVertical(e.key === 'ArrowDown' ? 1 : -1); return;
  }

  if (e.key === '/') { e.preventDefault(); el.search.focus(); }
  else if (e.key === '0') fitWall();
  else if (e.key === '=' || e.key === '+') zoomBy(1.3);
  else if (e.key === '-') zoomBy(1 / 1.3);
  else if (e.key === ']') stepGroup(1);
  else if (e.key === 't') setTour(!tour.on);
  else if (tour.on) setTour(false);
  else if (e.key === '[') stepGroup(-1);
});

// Repack an overview when its usable area changes, including the filter rail.
// While exploring at a custom zoom, preserve the user's camera and positions;
// the next Fit explicitly recomposes for the new viewport.
new ResizeObserver(() => perf.span('resize/stage', () => {
  stageSize = null;
  if (hydrating || links?.restoring) return;
  if (!state.spatialOn && viewport.fitted) {
    const r = el.stage.getBoundingClientRect(); // layout is clean when observers run, so this does not force one
    if (r.width === renderedStage?.w && r.height === renderedStage?.h) return;
    fitWall();
  }
  else { updateVisibility(); updateBackgroundVisibility(); }
})).observe(el.stage);

// A collection document (?collection=, a meta tag or an embedding page) replaces
// the server: no /api/clips, no proxy, no snapshot store, view state in memory.
const collection = collectionSource();
if (collection) setProxyAvailable(false);
// Edge zoom is the default flat-canvas behaviour; ?pan=free|bounded remain for comparison.
const initialPan = new URL(location.href).searchParams.get('pan');
const startPan = ['free', 'bounded', 'edge'].includes(initialPan) ? initialPan : 'edge';
panBehavior.value = startPan;
viewport.panMode = startPan;
links = createPermalinks({ capture: captureView, restore: restoreView, notice: linkNotice, onHistory: renderScope, snapshots: !collection });
document.getElementById('copy-view').addEventListener('click', () => links.copy().catch(err => linkNotice(err.message)));
document.getElementById('copy-live-view').addEventListener('click',async()=>{try{const spec=captureView();if(!spec)throw new Error('The view is not ready');await navigator.clipboard.writeText(targetedViewURL(spec,location.href).href);linkNotice('Live view link copied · opens the current collection');}catch(error){linkNotice(error.message);}});
// Read-only diagnostics for the explicit-target rendering proof.
window.wunderkammer = Object.freeze({ export: exportView, whenStill });
window.wunderkammerAisleDebug=()=>({mode:state.mode,scopeKeys:state.filtered.map(clipKey),view:captureView(),scene:state.aisle?.getDiagnostics()||null});
window.wunderkammerFloatDebug=()=>({mode:state.mode,scopeKeys:state.filtered.map(clipKey),view:captureView(),scene:state.float?.getDiagnostics()||null});
document.getElementById('new-view').addEventListener('click', () => { links.newView(); linkNotice(''); });
boot();
