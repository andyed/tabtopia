/**
 * Similarity arrangement: each tile sits at its image's 2-D projection point
 * (clip.projection, x/y in [-1, 1], written at index time by
 * scripts/projection.py), so images that look alike form neighbourhoods.
 * Pure functions — no DOM, no state.
 *
 * Places are computed once for the whole corpus (`universe`) and a filtered
 * subset keeps them: filtering hides tiles, it never re-projects or re-spaces
 * the survivors, so a neighbourhood stays where it was when a facet changes.
 *
 * Projection points overlap freely (UMAP packs near-duplicates into tight
 * clumps), so two steps follow:
 *   1. Density: each axis is replaced by its rank, which spreads the clumps
 *      while keeping every point's left/right and above/below order.
 *   2. Spacing: a placement sweep accepts each tile only where it touches no
 *      tile already placed, otherwise the nearest free spot on rings of growing
 *      radius. Bounded, deterministic, and it guarantees no two tiles stack.
 * Measured 2026-10-14 against the raw points at the same fill (0.25): mean
 * displacement fell from 2.8 to 1.5 tile widths on the Music Atlas (1,793
 * covers) and from 1.3 to 0.7 on the Psychodeli Atlas (406); the share of each
 * item's ten nearest projection neighbours that stay among its ten nearest
 * tiles rose from 0.41 to 0.52 and from 0.64 to 0.69. A relaxation pass that
 * pushed overlapping pairs apart before the sweep cost time and lowered that
 * share, so it was dropped. The ring step is half the smallest tile side: a
 * third cost 540 ms at 10k against 305 ms for a half, for 0.1 tile more
 * displacement. Written from the general technique (rank
 * transform; greedy nearest-free placement), not from any peer's code.
 */

/** Arrangement keys, chosen where a grouping is chosen; '@' keeps them apart from facet names. */
export const SIMILARITY = '@similarity';
export const SIMILARITY_GRID = '@similarity-grid';
export const isSimilarity = key => key === SIMILARITY || key === SIMILARITY_GRID;

const DEFAULTS = { targetH: 240, gap: 14, blockGap: 64, fill: 0.25 };

export function hasProjection(clip) {
  const p = clip?.projection;
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/**
 * Spread on zoom (3D similarity map, after Collection Space Navigator /
 * umap-explorer's zoomScaler): a tile's on-screen size stays in this band
 * while zoom scales only the distances between tiles, so a dense
 * neighbourhood opens up instead of its covers growing. Reading size comes
 * from an explicit act — hover enlarges one tile to HOVER_PX, a click opens
 * the detail pane — never from zoom.
 */
export const SPREAD_BAND = Object.freeze({ min: 14, max: 28 });
export const HOVER_PX = 96;

/** Factor to apply to a tile whose natural on-screen size is `naturalPx`. */
export function spreadScale(naturalPx, band = SPREAD_BAND) {
  if (!(naturalPx > 0) || !Number.isFinite(naturalPx)) return 1;
  return Math.min(band.max, Math.max(band.min, naturalPx)) / naturalPx;
}

/** A grid cell assigned at index time (scripts/projection.py, snap_to_grid). */
export function hasCell(clip) {
  const p = clip?.projection;
  return !!p && Number.isInteger(p.col) && Number.isInteger(p.row) && p.col >= 0 && p.row >= 0;
}

/** Equal-area tiles: every image carries the same weight on the map, whatever its shape. */
function tileSize(clip, side) {
  const dim = String(clip.props?.dims?.[0] || clip.props?.dims || '');
  const m = dim.match(/^(\d+)x(\d+)$/);
  let a = m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : 1;
  if (!Number.isFinite(a) || a <= 0) a = 1;
  a = Math.min(4, Math.max(0.3, a));
  return { w: side * Math.sqrt(a), h: side / Math.sqrt(a) };
}

/** True when a and b are closer than `gap` on both axes. */
export const overlaps = (a, b, gap = 0) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/** Each value's rank, spread evenly over [-1, 1]; ties keep input order. */
function ranks(values) {
  const n = values.length, out = new Array(n);
  values.map((v, i) => i).sort((a, b) => values[a] - values[b] || a - b)
    .forEach((i, k) => { out[i] = n > 1 ? k / (n - 1) * 2 - 1 : 0; });
  return out;
}

/**
 * Remove overlap between rectangles {x, y, w, h} in place, in array order:
 * a rectangle stays put when it keeps `gap` from every earlier one, else it
 * moves to the nearest free point on rings of radius k·step around its
 * position. The search ends at a ring beyond the occupied bounds, which is
 * always free, so the pass is bounded and never leaves two rectangles stacked.
 * @returns {{ moved: number }} rectangles displaced
 */
export function separate(rects, opts = {}) {
  const gap = opts.gap ?? DEFAULTS.gap;
  if (rects.length < 2) return { moved: 0 };
  const cell = rects.reduce((m, r) => Math.max(m, r.w, r.h), 0) + gap;
  const step = Math.max(1, rects.reduce((m, r) => Math.min(m, r.w, r.h), Infinity) / 2);
  // Uniform grid keyed by top-left cell. Every rectangle fits in one cell, so
  // anything within `gap` of r starts in r's cell or one of its 8 neighbours.
  const cells = new Map();
  const key = (i, j) => i * 65536 + j;
  const free = r => {
    const i0 = Math.floor(r.x / cell), j0 = Math.floor(r.y / cell);
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) {
      const list = cells.get(key(i, j));
      if (list) for (const o of list) if (overlaps(r, o, gap)) return false;
    }
    return true;
  };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, moved = 0;
  for (const r of rects) {
    if (!free(r)) {
      const x = r.x, y = r.y;
      const reach = Math.max(x1 - x0, y1 - y0, Math.abs(x - x0), Math.abs(y - y0)) + cell * 2;
      let found = false;
      for (let k = 1; !found && (k - 1) * step <= reach; k++) {
        const rad = k * step, n = Math.max(8, Math.ceil(2 * Math.PI * k));
        for (let s = 0; s < n && !found; s++) {
          const t = s / n * 2 * Math.PI;
          r.x = x + rad * Math.cos(t); r.y = y + rad * Math.sin(t);
          found = free(r);
        }
      }
      if (!found) { r.x = x1 + gap; r.y = y; }   // past every placed rectangle: free by construction
      moved++;
    }
    const k = key(Math.floor(r.x / cell), Math.floor(r.y / cell));
    let list = cells.get(k); if (!list) cells.set(k, list = []); list.push(r);
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return { moved };
}

/**
 * The map is spaced once per universe at this aspect. A stage of another
 * aspect stretches one axis by a factor of at least 1, which only widens
 * gaps: positions stay put relative to each other when the scope bar or a
 * resize nudges the stage, and stretching apart can never create overlap.
 */
const BASE_ASPECT = 1.6;

/**
 * Base places for every clip of the universe: projected clips on the map, and
 * unprojected ones (still in scope, so still visible) in justified rows that
 * go beneath it. Memoised per universe array.
 */
const memo = new WeakMap();
function placeUniverse(universe, o, justify) {
  let bySize = memo.get(universe);
  if (!bySize) memo.set(universe, bySize = new Map());
  const memoKey = [o.targetH, o.gap, o.fill].join('|');
  if (bySize.has(memoKey)) return bySize.get(memoKey);

  const mapped = universe.filter(hasProjection);
  const rest = universe.filter(c => !hasProjection(c));
  const side = o.targetH;
  // Tiles cover about `fill` of the map (projection axes carry no meaning of their own).
  const S = Math.sqrt(mapped.length * side * side / o.fill);
  const sx = S * Math.sqrt(BASE_ASPECT) / 2, sy = S / Math.sqrt(BASE_ASPECT) / 2;
  const rx = ranks(mapped.map(c => c.projection.x)), ry = ranks(mapped.map(c => c.projection.y));
  const rects = mapped.map((clip, i) => {
    const { w, h } = tileSize(clip, side);
    // Screen y grows downward; projection y grows upward.
    return { clip, w, h, x: rx[i] * sx - w / 2, y: -ry[i] * sy - h / 2 };
  });
  separate(rects, o);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  const map = new Map(rects.map(r => [r.clip, { x: r.x - x0, y: r.y - y0, w: r.w, h: r.h }]));
  const strip = new Map();
  if (rest.length) {
    const width = rects.length ? x1 - x0 : Math.sqrt(rest.length) * side * 1.5;
    for (const t of justify(rest, Math.max(side * 4, width), o).tiles) strip.set(t.clip, t);
  }
  const placed = { map, strip, mapH: rects.length ? y1 - y0 : 0 };
  bySize.set(memoKey, placed);
  return placed;
}

/**
 * Lay out `clips` (the in-scope subset) at their places in opts.universe's
 * map, translated so the subset's bounds start at the origin. Clips missing
 * from the universe make the subset its own universe. `justify` is passed in
 * by layout.mjs to keep this module free of an import cycle.
 */
export function similarityLayout(clips, opts = {}, justify) {
  const o = { ...DEFAULTS, ...opts };
  if (!clips.length) return { tiles: [], blocks: [], width: 1, height: 1 };
  const aspect = Math.min(5, Math.max(0.2, Number(o.viewportAspect) || BASE_ASPECT));
  let u = placeUniverse(o.universe || clips, o, justify);
  if (clips.some(c => !u.map.has(c) && !u.strip.has(c))) u = placeUniverse(clips, o, justify);
  const kx = Math.max(1, aspect / BASE_ASPECT), ky = Math.max(1, BASE_ASPECT / aspect);
  const top = u.map.size ? u.mapH * ky + o.blockGap : 0;
  const placed = clips.map(clip => {
    const m = u.map.get(clip);
    if (m) return { clip, x: m.x * kx, y: m.y * ky, w: m.w, h: m.h };
    const t = u.strip.get(clip);
    return { clip, x: t.x, y: t.y + top, w: t.w, h: t.h };
  });
  let x0 = Infinity, y0 = Infinity;
  for (const t of placed) { x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y); }
  let width = 0, height = 0;
  for (const t of placed) {
    t.x -= x0; t.y -= y0;
    width = Math.max(width, t.x + t.w); height = Math.max(height, t.y + t.h);
  }
  return { tiles: placed, blocks: [], width, height };
}

const median = values => { const v = values.slice().sort((a, b) => a - b); return v.length ? v[v.length >> 1] : 1; };
const aspectOf = clip => { const { w, h } = tileSize(clip, 1); return w / h; };

/**
 * Similarity grid: the map snapped to a lattice at index time, one record per
 * cell, so it needs no spacing pass and cannot overlap. Cells take the
 * corpus's median aspect (a screenshot archive gets landscape cells, covers
 * square ones); each image is contained in its cell. A filter leaves holes
 * rather than re-packing: survivors keep their cells, so a colour region
 * stays where it was, and re-packing would mean solving an assignment in the
 * client. Fit reframes the subset's bounds. Unlike the map, the grid is not
 * stretched to the stage: uneven gaps would break the lattice.
 */
export function similarityGrid(clips, opts = {}, justify) {
  const o = { ...DEFAULTS, ...opts };
  if (!clips.length) return { tiles: [], blocks: [], width: 1, height: 1 };
  const universe = o.universe || clips;
  let a = medianAspects.get(universe);
  if (a === undefined) {
    a = Math.min(2.5, Math.max(0.4, median(universe.filter(hasCell).map(aspectOf))));
    if (typeof universe === 'object') medianAspects.set(universe, a);
  }
  const cw = o.targetH * Math.sqrt(a), ch = o.targetH / Math.sqrt(a);
  const tiles = [], rest = [];
  for (const clip of clips) {
    if (!hasCell(clip)) { rest.push(clip); continue; }
    const r = aspectOf(clip), fit = Math.min(cw / r, ch);   // contain: height that fits the cell
    const w = fit * r, h = fit;
    tiles.push({ clip, w, h, x: clip.projection.col * (cw + o.gap) + (cw - w) / 2, y: clip.projection.row * (ch + o.gap) + (ch - h) / 2 });
  }
  let x0 = Infinity, y0 = Infinity, x1 = 0, y1 = 0;
  for (const t of tiles) { x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y); }
  for (const t of tiles) { t.x -= x0; t.y -= y0; x1 = Math.max(x1, t.x + t.w); y1 = Math.max(y1, t.y + t.h); }
  if (rest.length) {
    const top = tiles.length ? y1 + o.blockGap : 0;
    for (const t of justify(rest, Math.max(o.targetH * 4, x1 || Math.sqrt(rest.length) * o.targetH * 1.5), o).tiles) {
      tiles.push({ ...t, y: t.y + top }); x1 = Math.max(x1, t.x + t.w); y1 = Math.max(y1, t.y + top + t.h);
    }
  }
  // Keep the caller's order (sort / Dive traversal), not grid order.
  const at = new Map(tiles.map(t => [t.clip, t]));
  return { tiles: clips.map(c => at.get(c)), blocks: [], width: x1, height: y1 };
}
const medianAspects = new WeakMap();
