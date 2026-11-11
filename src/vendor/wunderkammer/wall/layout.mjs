/**
 * Layout math for the wall. Pure functions — no DOM, no state.
 *
 * Three regimes:
 *   ungrouped  → one justified-rows block, the whole wall
 *   grouped    → one block per facet value, packed as rows of blocks (strip treemap)
 *   similarity → tiles at projection points, overlap removed (similarity-layout.mjs)
 *   similarity grid → the same map snapped to index-time lattice cells
 *
 * Justified rows (rather than a fixed grid) because clippings arrive at wildly
 * different aspect ratios — a 3:1 banner and a 9:16 phone shot in the same
 * fixed grid either letterbox to mush or crop away the thing you clipped.
 * Justified rows preserve every aspect ratio and still give flush edges.
 */

import { SIMILARITY, SIMILARITY_GRID, isSimilarity, similarityLayout, similarityGrid } from './similarity-layout.mjs';
export { SIMILARITY, SIMILARITY_GRID, isSimilarity };

const DEFAULTS = { targetH: 240, gap: 14, headerH: 52, blockGap: 64 };
/** Height of a group block's heading band, in world units. */
export const HEADER_H = DEFAULTS.headerH;

/**
 * Fall back to 4:3 when a clip has no usable intrinsic dimensions.
 *
 * Memoised per clip object: layout() tries 25 candidate widths and each asks
 * for every clip's aspect several times, so at 1,800 clips this regex ran
 * ~150,000 times per render. A clip's dims do not change under the wall; a
 * replaced clip is a new object and misses the cache.
 */
const aspects = new WeakMap();
function aspectOf(clip) {
  let a = aspects.get(clip);
  if (a === undefined) { a = computeAspect(clip); if (clip && typeof clip === 'object') aspects.set(clip, a); }
  return a;
}
function computeAspect(clip) {
  const dim = String(clip.props?.dims?.[0] || clip.props?.dims || '');
  const m = dim.match(/^(\d+)x(\d+)$/);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (Number.isFinite(w) && Number.isFinite(h) && h > 0 && w > 0) {
      return clamp(w / h, 0.3, 4);
    }
  }
  return 4 / 3;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Justified rows: fill each row to `width` by scaling the row's target height.
 * @returns {{ tiles: Array, height: number }}
 */
export function justify(clips, width, opts = {}) {
  const { targetH, gap } = { ...DEFAULTS, ...opts };
  const tiles = [];
  let row = [];
  let rowAspect = 0;
  let y = 0;

  const flush = (isLast) => {
    if (!row.length) return;
    const gaps = gap * (row.length - 1);
    const avail = width - gaps;
    // The last row keeps the target height rather than stretching a lone tile
    // across the full width — a single 1200px-wide orphan reads as an error.
    let h = avail / rowAspect;
    if (isLast && h > targetH * 1.45) h = targetH;
    let x = 0;
    for (const clip of row) {
      const w = aspectOf(clip) * h;
      tiles.push({ clip, x, y, w, h });
      x += w + gap;
    }
    y += h + gap;
    row = [];
    rowAspect = 0;
  };

  for (const clip of clips) {
    row.push(clip);
    rowAspect += aspectOf(clip);
    // Commit the row once its natural height has fallen to the target.
    if ((width - gap * (row.length - 1)) / rowAspect <= targetH) flush(false);
  }
  flush(true);

  return { tiles, height: Math.max(0, y - gap) };
}

/**
 * A wall width that keeps the canvas roughly square.
 *
 * Total tile area is ~n · targetH² · avgAspect, so the square side is its root.
 * Without this, 850 clips at a fixed width produce a canvas tall enough that
 * fitting it requires a scale below MIN_SCALE — fit() then clamps, and content
 * sits off-screen with no way to reach it.
 */
export function naturalWallWidth(clips, opts = {}) {
  const { targetH, gap } = { ...DEFAULTS, ...opts };
  if (!clips.length) return 1200;
  const area = clips.reduce((sum, c) => {
    const w = aspectOf(c) * targetH + gap;
    return sum + w * (targetH + gap);
  }, 0);
  return Math.max(targetH, Math.round(Math.sqrt(area)));
}

/** Group clips by a facet key; multi-valued keys place a clip in every group. */
export function groupBy(clips, key) {
  // The similarity map is an arrangement, not a grouping: one undivided set.
  if (!key || key === 'none' || isSimilarity(key)) return [{ label: '', clips }];

  const buckets = new Map();
  const put = (label, clip) => {
    const k = key === 'captured' ? String(label).slice(0, 7) : String(label);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(clip);
  };

  for (const clip of clips) {
    const raw = key in clip ? clip[key] : clip.props?.[key];
    const values = Array.isArray(raw) ? raw : [raw];
    const usable = values.filter((v) => v !== undefined && v !== null && v !== '');
    if (!usable.length) put('—', clip);
    else for (const v of new Set(usable.map(String))) put(v, clip);
  }

  return [...buckets.entries()]
    .map(([label, items]) => ({ label, clips: items }))
    .sort((a, b) => key === 'captured' ? b.label.localeCompare(a.label)
      : key === 'publication_period' ? a.label.localeCompare(b.label)
      : b.clips.length - a.clips.length || a.label.localeCompare(b.label));
}

/**
 * Pack group blocks as an order-preserving strip treemap (Bederson, Shneiderman
 * & Wattenberg 2002): rows of blocks that each span the wall, every block as
 * wide as its share of the row's area, so a row ends flush instead of leaving
 * a hole beside a short group. A row closes when adding the next group would
 * worsen the row's mean block aspect. Group order is reading order.
 *
 * Replaced skyline packing on 2026-10-13. Measured on the real corpora, the
 * fraction of the screen covered by tiles after Fit (grouped by decade /
 * capture month) rose from 52–60% to 79–83% at 1440x900, 2560x1440, 3840x2160
 * and portrait; skyline left holes beside short blocks and a ragged right edge.
 */
function packGroups(groups, wallWidth, o) {
  const pad = o.blockPad ?? 14;
  // Estimated block area: the tiles at target height plus the heading band and
  // padding, which grow with the block's side, not its area.
  const items = groups.map(g => {
    const tilesArea = g.clips.reduce((s, c) => s + (aspectOf(c) * o.targetH + o.gap) * (o.targetH + o.gap), 0);
    const side = Math.sqrt(tilesArea);
    return { g, a: tilesArea + (o.headerH * 1.3 + pad * 2) * side };
  });
  const meanAspect = row => {
    const W = wallWidth - o.blockGap * (row.length - 1), sum = row.reduce((s, r) => s + r.a, 0), h = sum / W;
    return row.reduce((m, r) => { const w = W * r.a / sum; return m + Math.max(w / h, h / w); }, 0) / row.length;
  };
  const tiles = [], blocks = [];
  let y = 0, widest = 0, i = 0;
  while (i < items.length) {
    const row = [items[i++]];
    while (i < items.length && meanAspect([...row, items[i]]) <= meanAspect(row)) row.push(items[i++]);
    const W = wallWidth - o.blockGap * (row.length - 1), sum = row.reduce((s, r) => s + r.a, 0);
    let x = 0, rowH = 0;
    row.forEach((r, k) => {
      // The last block takes the remainder so the row ends exactly at the wall edge.
      const w = k === row.length - 1 ? wallWidth - x : Math.round(W * r.a / sum);
      const inner = Math.max(o.minBlockWidth || 120, w - pad * 2);
      const { tiles: gt, height } = justify(r.g.clips, inner, o);
      const h = o.headerH + height + pad;
      for (const t of gt) tiles.push({ ...t, group: r.g.label, x: t.x + x + pad, y: t.y + y + o.headerH });
      // Typical cover height, so a renderer can compare label size to image size.
      const tileH = gt.length ? gt.reduce((s2, t) => s2 + t.h, 0) / gt.length : o.targetH;
      blocks.push({ label: r.g.label, count: r.g.clips.length, x, y, w: inner + pad * 2, h, tileH });
      widest = Math.max(widest, x + inner + pad * 2);
      rowH = Math.max(rowH, h);
      x += w + o.blockGap;
    });
    y += rowH + o.blockGap;
  }
  return { tiles, blocks, width: widest, height: Math.max(0, y - o.blockGap) };
}

/**
 * Fit the composition to the viewport's aspect, preserving media proportions.
 * Candidate widths account for row breaks, group headers and packing gaps:
 * choose the one with the most actual tile area on screen after Fit. This is
 * bounded, deterministic layout math, independent of camera position or zoom.
 * Explicit wallWidth remains available for callers with a fixed world size.
 */
export function layout(clips, groupKey, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!clips.length) return { tiles: [], blocks: [], width: 1, height: 1 };
  // Places come from the index-time projection of opts.universe (the corpus),
  // so a filter hides tiles instead of moving the survivors.
  if (groupKey === SIMILARITY) return similarityLayout(clips, o, justify);
  if (groupKey === SIMILARITY_GRID) return similarityGrid(clips, o, justify);
  const grouped = groupKey && groupKey !== 'none';
  const groups = grouped ? groupBy(clips, groupKey) : [];
  const aspect = clamp(Number(o.viewportAspect) || 1, 0.2, 5);
  const make = (width) => {
    if (grouped) return packGroups(groups, width, o);
    const result = justify(clips, width, o);
    return { ...result, blocks: [], width: result.tiles.reduce((right, t) => Math.max(right, t.x + t.w), 0) };
  };
  if (o.wallWidth) return make(o.wallWidth);
  // Multi-valued facets occupy space in each group even though the count of
  // unique clips stays unchanged. Include every occurrence in the area budget.
  const occurrences = grouped ? groups.flatMap(g => g.clips) : clips;
  const base = naturalWallWidth(occurrences, o) * Math.sqrt(aspect);
  let best, bestScore = -Infinity;
  for (let i = 0; i <= 24; i++) {
    const result = make(Math.max(360, Math.round(base * (0.55 + i * 0.05))));
    const scale = Math.min(aspect / result.width, 1 / result.height);
    const area = result.tiles.reduce((sum, t) => sum + t.w * t.h, 0);
    const score = area * scale * scale;
    if (score > bestScore) { best = result; bestScore = score; }
  }
  return best;
}

/**
 * Frame a full-corpus layout around a compact foreground that sits at the origin.
 *
 * The background keeps its own geometry (so places stay recognisable across
 * filters); a horizontal gap opens at the cleanest row/block boundary nearest
 * its middle, wide enough for the foreground plus a margin, and the whole
 * plane is centred on the foreground. Nothing in the background may overlap
 * the foreground rectangle. Pure: no DOM, no camera.
 */
export function frameAround(background, foreground, opts = {}) {
  const fg = { w: Math.max(1, foreground.w), h: Math.max(1, foreground.h) };
  // The plane sits at depth behind the foreground and parallaxes on pan, so the
  // clearance scales with the foreground rather than staying a fixed gutter.
  const margin = opts.margin ?? Math.max(DEFAULTS.blockGap * 2, fg.h * 0.2);
  const { tiles, blocks, width, height } = background;
  const gapH = fg.h + margin * 2;
  // A clean boundary: no tile or block straddles it.
  const straddles = (y, list) => list.some(t => t.y < y - 0.01 && t.y + t.h > y + 0.01);
  const candidates = [...new Set([...tiles.map(t => t.y), ...blocks.map(b => b.y)])]
    .filter(y => y > 0.01 && y < height - 0.01)
    .filter(y => !straddles(y, tiles) && !straddles(y, blocks))
    .sort((a, b) => Math.abs(a - height / 2) - Math.abs(b - height / 2));
  const split = candidates.length ? candidates[0] : 0;   // fallback: everything below
  const offsetX = (fg.w - width) / 2;
  const offsetY = -(split + margin);
  const place = t => ({ ...t, x: t.x + offsetX, y: t.y + (t.y >= split - 0.01 ? gapH : 0) + offsetY });
  const placedTiles = tiles.map(place), placedBlocks = blocks.map(place);
  const xs = placedTiles.map(t => t.x), ys = placedTiles.map(t => t.y);
  const bounds = placedTiles.length ? {
    x: Math.min(...xs), y: Math.min(...ys),
    w: Math.max(...placedTiles.map(t => t.x + t.w)) - Math.min(...xs),
    h: Math.max(...placedTiles.map(t => t.y + t.h)) - Math.min(...ys)
  } : { x: 0, y: 0, w: 0, h: 0 };
  return { tiles: placedTiles, blocks: placedBlocks, split, gap: { y: split + offsetY, h: gapH }, bounds };
}
