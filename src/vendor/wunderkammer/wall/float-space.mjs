/**
 * Positions for the floating space. Pure: no DOM, no three.js, no camera.
 *
 * Every position means something. In the colour arrangements an item sits at
 * its dominant colour (`palette[0]`, the largest median-cut cluster), so
 * nearness is colour similarity; in A–Z it sits in reading order. HotSauce
 * floated a folder tree in 3D and the depth restated what the tree already
 * said. Here the third axis is a third colour coordinate, or, for A–Z, absent:
 * an alphabetical order has one dimension and the wall says so. In Axes each
 * axis carries one chosen dimension, a colour coordinate or an attribute, and
 * an item without a value waits in a labelled slot before the axis starts.
 */
import { attributeModel, attributeMark } from './attributes.mjs';

/** World units per OKLab unit of lightness, and the length of every Axes axis. */
export const WORLD = 2000;
/** Upper bound on the a/b stretch (see chromaStretch). */
export const MAX_STRETCH = 4;
/** Cylinder radius for OKLCH and HSL. */
export const RADIUS = 700;
export const ARRANGEMENTS = Object.freeze(['oklab', 'oklch', 'hsl', 'az', 'axes', 'cloud']);
export const ARRANGEMENT_LABELS = Object.freeze({ oklab: 'OKLab', oklch: 'OKLCH', hsl: 'HSL', az: 'A–Z', axes: 'Axes', cloud: 'Cloud' });
export const isArrangement = value => ARRANGEMENTS.includes(value);
/** The arrangement the space opens in, from the 3D button or a link that names
 * none. Axes puts the collection's time, lightness and hue on three axes
 * (resolveAxes), so the first 3D view shows what the flat wall's groups do not:
 * every item's colour, along the collection's own timeline. */
export const DEFAULT_ARRANGEMENT = 'axes';

/** The three Axes slots, in toolbar and URL order. */
export const AXES = Object.freeze(['across', 'up', 'depth']);
export const AXIS_LABELS = Object.freeze({ across: 'Across', up: 'Up', depth: 'Depth' });
/** Colour dimensions, from `palette[0]`. These names are reserved: a facet
 * with one of them as its key is not offered as an axis. */
export const COLOUR_DIMENSIONS = Object.freeze(['lightness', 'chroma', 'hue']);
const COLOUR_LABELS = { lightness: 'Lightness', chroma: 'Chroma', hue: 'Hue' };
/** A categorical facet becomes planes only up to this many values: beyond it
 * the planes are thinner than a tile and their labels collide. */
export const MAX_PLANES = 12;
/** Where an item without a value waits: this share of the axis length before
 * the axis starts. The hue axis uses two slots, greys then no palette. */
export const MISSING_GAP = 0.12;
/** Below this OKLCH chroma a hue angle is noise (the reading order uses it too). */
export const GREY_CHROMA = 0.02;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
/** A syntactically valid dimension id: a colour name or a facet key. */
export const isAxisName = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value && !RESERVED.has(value);
/** `{ across?, up?, depth? }` with valid, distinct dimension ids. Any slot may be
 * left out; the view fills it with the collection's default. */
export function validAxes(axes) {
  if (!axes || typeof axes !== 'object' || Array.isArray(axes)) return false;
  const keys = Object.keys(axes);
  if (!keys.every(k => AXES.includes(k)) || !keys.every(k => isAxisName(axes[k]))) return false;
  return new Set(keys.map(k => axes[k])).size === keys.length;
}

const HEX = /^#([0-9a-f]{6})$/i;
/** `#rrggbb` → [r, g, b] in 0..1, or null. */
export function parseHex(hex) {
  const m = typeof hex === 'string' ? HEX.exec(hex) : null;
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
/** The colour an item is placed by: its palette's first (dominant) entry. */
export const dominantColor = clip => Array.isArray(clip?.palette) ? parseHex(clip.palette[0]) : null;

const linear = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
/** sRGB (0..1) → OKLab [L, a, b] (Ottosson 2020). */
export function oklab([r, g, b]) {
  const R = linear(r), G = linear(g), B = linear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
/** OKLab → [L, C, h°]. Hue is meaningless below a chroma of ~0.02; callers
 * that order by hue put those first. */
export function oklch(lab) {
  const [L, a, b] = lab, C = Math.hypot(a, b);
  return [L, C, (Math.atan2(b, a) * 180 / Math.PI + 360) % 360];
}
/** sRGB (0..1) → [h°, s, l]. */
export function hsl([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, Math.min(1, s), l];
}

/** Same fallback as layout.mjs: a clip with no usable dims is assumed 4:3. */
export function aspectOf(clip) {
  const m = String(clip?.props?.dims?.[0] || clip?.props?.dims || '').match(/^(\d+)x(\d+)$/);
  const w = Number(m?.[1]), h = Number(m?.[2]);
  return w > 0 && h > 0 ? Math.min(4, Math.max(0.3, w / h)) : 4 / 3;
}

/** The A–Z shelf a title belongs on. */
export function shelfOf(title) {
  const c = String(title || '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : /[0-9]/.test(c) ? '0–9' : '#';
}
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const SHELF_ORDER = shelf => shelf === '0–9' ? -1 : shelf === '#' ? 99 : shelf.charCodeAt(0);

/**
 * Tile edge for a space of `n` items: the square side a tile would have if the
 * items shared the colour volume evenly, shrunk so neighbours rarely touch.
 * Tiles keep this AREA whatever their aspect, so a panorama is not ten times
 * the presence of a portrait.
 */
export function tileEdge(n) { return Math.min(150, Math.max(30, WORLD * 0.34 / Math.cbrt(Math.max(1, n)))); }
const sized = (aspect, edge) => [edge * Math.sqrt(aspect), edge / Math.sqrt(aspect)];
const quantile = (values, p) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) * p)] : 0; };

/**
 * One factor applied to both a and b, so hue angles stay exact and only the
 * chroma-to-lightness proportion changes. Collections of covers and
 * screenshots span four times as much lightness as chroma (measured: 0.51 vs
 * 0.21 for the Psychodeli example, 0.90 vs 0.18 for a 1,793-album library),
 * and unstretched they stand in a needle down the middle of the stage. The
 * factor is rounded to a half and printed on the axis label; 1 means true
 * OKLab proportions.
 */
export function chromaStretch(labs) {
  if (labs.length < 2) return 1;
  const span = axis => quantile(labs.map(l => l[axis]), 0.95) - quantile(labs.map(l => l[axis]), 0.05);
  const ab = Math.max(span(1), span(2), 1e-3);
  return Math.min(MAX_STRETCH, Math.max(1, Math.round(0.8 * span(0) / ab * 2) / 2));
}

/**
 * Place every clip. Returns typed arrays indexed like `clips`:
 *   positions  — the arranged centre, after declumping
 *   exact      — the arranged centre before declumping (what the colour says)
 *   sizes      — tile width and height
 *   order      — indices in the arrangement's own reading order (hue, or title)
 * plus bounds, labels and guide geometry for the renderer.
 */
export function arrange(clips, arrangement, { edge = tileEdge(clips.length), axes, labelFor, priority } = {}) {
  if (!isArrangement(arrangement)) throw new Error(`Unknown arrangement: ${arrangement}`);
  const n = clips.length, positions = new Float32Array(n * 3), sizes = new Float32Array(n * 2);
  const labels = [], guides = [];
  let order, unplaced = [], stretch = 1;
  for (let i = 0; i < n; i++) { const [w, h] = sized(aspectOf(clips[i]), edge); sizes[i * 2] = w; sizes[i * 2 + 1] = h; }
  if (arrangement === 'axes') return arrangeAxes(clips, positions, sizes, edge, axes, labelFor);
  if (arrangement === 'cloud') return arrangeCloud(clips, positions, sizes, edge, priority);
  if (arrangement === 'az') {
    order = alphabetical(clips, positions, sizes, edge, labels);
  } else {
    const colors = clips.map(dominantColor), keys = new Array(n), labs = colors.filter(Boolean).map(oklab);
    // Chroma reference for OKLCH: the 95th percentile, so one neon outlier does
    // not press every muted cover against the axis.
    const cref = Math.max(0.04, quantile(labs.map(l => Math.hypot(l[1], l[2])), 0.95) || 0.2);
    if (arrangement === 'oklab') stretch = chromaStretch(labs);
    for (let i = 0; i < n; i++) {
      const rgb = colors[i];
      if (!rgb) { unplaced.push(i); continue; }
      const lab = oklab(rgb), [L, C, h] = oklch(lab);
      let x, y, z;
      if (arrangement === 'oklab') { x = lab[1] * WORLD * stretch; y = (L - 0.5) * WORLD; z = lab[2] * WORLD * stretch; }
      else if (arrangement === 'oklch') {
        // Same hue angle as OKLab's a/b plane, so switching between the two
        // moves items only radially. Radius is chroma relative to the
        // collection, which spreads muted covers out where hue can be read.
        const r = RADIUS * Math.sqrt(Math.min(1, C / cref)), t = h * Math.PI / 180;
        x = r * Math.cos(t); y = (L - 0.5) * WORLD; z = r * Math.sin(t);
      } else {
        // The HSL bicone: radius is HSL chroma (max − min), not saturation.
        // Saturation is unstable at the ends: #010300 has S = 1, and on a
        // cylinder it would sit at full radius beside the vivid colours.
        const [H, S, Lh] = hsl(rgb), r = RADIUS * S * (1 - Math.abs(2 * Lh - 1)), t = H * Math.PI / 180;
        x = r * Math.cos(t); y = (Lh - 0.5) * WORLD; z = r * Math.sin(t);
      }
      positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
      // Reading order around the wheel: achromatic first by lightness, then by hue.
      const hue = arrangement === 'hsl' ? hsl(rgb)[0] : h;
      keys[i] = [C < 0.02 ? -1 : hue, L];
    }
    order = [...Array(n).keys()].filter(i => keys[i]).sort((a, b) => keys[a][0] - keys[b][0] || keys[a][1] - keys[b][1] || a - b);
    colourGuides(arrangement, positions, order, stretch, labels, guides);
  }
  const exact = positions.slice();
  const declumped = arrangement === 'az' ? { moved: 0, maxShift: 0, meanShift: 0 }
    : declump(positions, order, edge * 0.6, edge * 0.6);
  if (unplaced.length) shelve(clips, unplaced, positions, exact, sizes, edge, labels);
  order = order.concat(unplaced);
  return { arrangement, edge, stretch, positions, exact, sizes, order, labels, guides, unplaced: unplaced.length,
    declumped, bounds: boundsOf(positions, sizes, n) };
}

/** Rows of a flat wall, one shelf per initial, alphabetical within it. */
function alphabetical(clips, positions, sizes, edge, labels) {
  const order = [...clips.keys()].sort((a, b) => SHELF_ORDER(shelfOf(clips[a].title)) - SHELF_ORDER(shelfOf(clips[b].title))
    || collator.compare(String(clips[a].title || ''), String(clips[b].title || '')) || a - b);
  const cellW = edge * 1.55, cellH = edge * 1.15, n = clips.length;
  const cols = Math.max(6, Math.ceil(Math.sqrt(n * 1.6 * cellH / cellW)));
  const rows = [];
  let shelf = null, col = cols, row = -1;
  for (const i of order) {
    const s = shelfOf(clips[i].title);
    if (s !== shelf || col >= cols) {
      row += s !== shelf && shelf !== null ? 1.35 : 1; col = 0;
      if (s !== shelf) { labels.push({ text: s, kind: 'shelf', row }); shelf = s; }
    }
    rows.push([i, col++, row]);
    // Contain the tile in its cell: the wall is a grid, so sizes may shrink.
    const w = sizes[i * 2], h = sizes[i * 2 + 1], k = Math.min(1, cellW * 0.92 / w, cellH * 0.9 / h);
    sizes[i * 2] = w * k; sizes[i * 2 + 1] = h * k;
  }
  const width = cols * cellW, height = (row + 1) * cellH;
  for (const [i, c, r] of rows) {
    positions[i * 3] = -width / 2 + (c + 0.5) * cellW;
    positions[i * 3 + 1] = height / 2 - (r + 0.5) * cellH;
    positions[i * 3 + 2] = 0;
  }
  for (const label of labels) label.point = [-width / 2 - cellW * 0.45, height / 2 - (label.row + 0.5) * cellH, 0];
  return order;
}

/** Items with no palette cannot be placed by colour. They wait on a shelf below
 * the space, named, rather than being dropped or parked at the origin. */
function shelve(clips, indices, positions, exact, sizes, edge, labels) {
  let minY = Infinity, minYSet = false;
  for (let i = 0; i < clips.length; i++) if (!indices.includes(i)) { minY = Math.min(minY, positions[i * 3 + 1]); minYSet = true; }
  if (!minYSet) minY = -WORLD / 2;
  const cell = edge * 1.6, cols = Math.max(4, Math.ceil(Math.sqrt(indices.length * 2.5)));
  const top = minY - edge * 3;
  indices.forEach((i, k) => {
    const c = k % cols, r = Math.floor(k / cols);
    positions[i * 3] = exact[i * 3] = (c - (cols - 1) / 2) * cell;
    positions[i * 3 + 1] = exact[i * 3 + 1] = top - r * cell * 0.8;
    positions[i * 3 + 2] = exact[i * 3 + 2] = 0;
    const w = sizes[i * 2], h = sizes[i * 2 + 1], k2 = Math.min(1, cell * 0.9 / w, cell * 0.7 / h);
    sizes[i * 2] = w * k2; sizes[i * 2 + 1] = h * k2;
  });
  labels.push({ text: `No palette · ${indices.length}`, kind: 'shelf', point: [-(cols / 2 + 0.6) * cell, top, 0] });
}

/* ------------------------------------------------------------------ Axes --- */

const TIME_KEYS = ['captured', 'year', 'decade'];
const keyLabel = (labelFor, key) => (typeof labelFor === 'function' && labelFor(key)) || key;
/** The captured facet filters by month, but its axis places the exact time. */
const axisLabel = (labelFor, key) => key === 'captured' ? 'capture date' : keyLabel(labelFor, key);

/**
 * One attribute as an axis, or null when it cannot be one. Ordered facets
 * (attributeModel) with a numeric or date range are continuous; ranked ones
 * (complexity, compression) and single-valued categoricals of 2–12 values are
 * planes. A multi-valued categorical (colour family, genre) is refused: an
 * item can stand in only one plane, and choosing one of its values would be
 * arbitrary.
 */
export function attributeAxis(clips, key, label = key) {
  if (!isAxisName(key) || COLOUR_DIMENSIONS.includes(key)) return null;
  const model = attributeModel(clips, key, label);
  if (model.domain.length < 2) return null;
  if (model.kind === 'ordered') {
    const continuous = model.min != null && model.max != null && model.max > model.min;
    return { id: key, label, group: 'attribute', kind: continuous ? 'continuous' : 'planes', model };
  }
  if (model.domain.length > MAX_PLANES || model.multiValueRule) return null;
  return { id: key, label, group: 'attribute', kind: 'planes', model };
}

/** Facet keys found on the clips themselves, for callers with no facet list. */
export function clipAttributeKeys(clips) {
  const keys = new Set(clips.some(c => c?.captured) ? ['captured'] : []);
  for (const clip of clips) for (const key of Object.keys(clip?.props || {})) keys.add(key);
  return [...keys];
}

/** Every dimension the collection can put on an axis: the three colour
 * coordinates, then each attribute `attributeAxis` accepts, in `keys` order. */
export function axisDimensions(clips, keys = clipAttributeKeys(clips), labelFor) {
  const dims = COLOUR_DIMENSIONS.map(id => ({ id, label: COLOUR_LABELS[id], group: 'colour', kind: 'continuous' }));
  for (const key of new Set(keys)) {
    const dim = attributeAxis(clips, key, axisLabel(labelFor, key));
    if (dim) dims.push({ id: dim.id, label: dim.label, group: 'attribute', kind: dim.kind });
  }
  return dims;
}

/**
 * A full `{ across, up, depth }` from a partial request. A requested id the
 * collection offers is kept; every other slot takes its default, skipping
 * ids already used. Across defaults to time (captured, year, decade), then any
 * other attribute, then chroma; up to lightness; depth to hue.
 */
export function resolveAxes(dims, requested = {}) {
  const ids = dims.map(d => d.id), offered = new Set(ids), used = new Set(), out = {};
  for (const axis of AXES) {
    const want = requested?.[axis];
    if (offered.has(want) && !used.has(want)) { out[axis] = want; used.add(want); }
  }
  const attributes = dims.filter(d => d.group === 'attribute');
  const byKind = kind => attributes.filter(d => d.kind === kind).map(d => d.id);
  const prefer = {
    across: [...TIME_KEYS, ...byKind('continuous'), ...byKind('planes'), 'chroma', 'lightness', 'hue'],
    up: ['lightness', 'chroma', 'hue', ...ids],
    depth: ['hue', 'chroma', 'lightness', ...ids],
  };
  for (const axis of AXES) if (!out[axis]) {
    const pick = prefer[axis].find(id => offered.has(id) && !used.has(id));
    out[axis] = pick; used.add(pick);
  }
  return out;
}

/**
 * The hue where the hue axis starts: the centre of the emptiest 30° window of
 * the collection's chromatic items, so no populated hue family is split across
 * the two ends of the axis. Rounded to 5°; ties go to the lowest angle.
 */
export function hueCut(hues) {
  if (!hues.length) return 0;
  const bins = new Array(360).fill(0);
  for (const h of hues) bins[Math.floor(((h % 360) + 360) % 360)]++;
  let best = Infinity, cut = 0;
  for (let start = 0; start < 360; start++) {
    let count = 0; for (let k = 0; k < 30; k++) count += bins[(start + k) % 360];
    if (count < best) { best = count; cut = start + 15; }
  }
  return (Math.round(cut / 5) * 5) % 360;
}

/** Up to about six round values in [lo, hi]. */
function niceTicks(lo, hi) {
  const span = hi - lo; if (!(span > 0)) return [lo];
  const raw = span / 5, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw);
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Month or year starts between two timestamps (milliseconds, UTC dates).
 * Months are short ("Dec"); January also names its year. */
function dateTicks(lo, hi) {
  const a = new Date(lo), b = new Date(hi), months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
  const out = [];
  if (months <= 24) {
    const step = months <= 12 ? 1 : 3;
    for (let y = a.getUTCFullYear(), m = a.getUTCMonth(); ; m++) {
      if (m > 11) { m = 0; y++; }
      const t = Date.UTC(y, m, 1); if (t > hi) break;
      if (t >= lo && m % step === 0) out.push([t, m ? MONTHS[m] : `${MONTHS[m]} ${y}`]);
    }
  } else {
    for (const year of niceTicks(a.getUTCFullYear(), b.getUTCFullYear())) {
      const t = Date.UTC(year, 0, 1); if (t >= lo && t <= hi) out.push([t, String(year)]);
    }
  }
  return out;
}

/**
 * One axis's coordinate for every clip, as u: 0 at the axis start, 1 at its
 * end, negative in a missing-value slot. Also the slots, ticks, title, and
 * whether declumping may move items along it (colour axes only).
 */
function axisCoordinates(clips, id, labelFor, colours) {
  const n = clips.length, u = new Float64Array(n), slots = [], ticks = [];
  const slot = (text, at, members) => { for (const i of members) u[i] = at; if (members.length) slots.push({ text: `${text} · ${members.length}`, u: at, count: members.length }); };
  if (COLOUR_DIMENSIONS.includes(id)) {
    const lch = colours.map(rgb => rgb ? oklch(oklab(rgb)) : null), placed = lch.filter(Boolean);
    const none = [...lch.keys()].filter(i => !lch[i]);
    let title, hueStart = null, greys = [];
    if (id === 'lightness') {
      // Absolute OKLab L, as in the colour arrangements: switching between
      // them and Axes with lightness up moves no item vertically.
      lch.forEach((c, i) => { if (c) u[i] = c[0]; });
      if (placed.length) {
        const lo = Math.min(...placed.map(c => c[0])), hi = Math.max(...placed.map(c => c[0]));
        ticks.push({ u: hi, text: `L ${hi.toFixed(2)} · lightest` }, { u: lo, text: `L ${lo.toFixed(2)} · darkest` });
        for (const v of [0.2, 0.4, 0.6, 0.8]) if (v > lo + 0.05 && v < hi - 0.05) ticks.push({ u: v, text: `L ${v.toFixed(1)}` });
      }
      title = 'lightness (OKLab L)';
    } else if (id === 'chroma') {
      // √ of chroma relative to the most saturated item: covers crowd at low
      // chroma, and the root spreads them where differences can be read.
      const cmax = Math.max(1e-6, ...placed.map(c => c[1]));
      lch.forEach((c, i) => { if (c) u[i] = Math.sqrt(c[1] / cmax); });
      ticks.push({ u: 1, text: `C ${cmax.toFixed(2)} · most saturated` }, { u: 0, text: 'C 0 · grey' });
      for (const v of niceTicks(0, cmax)) if (v > cmax * 0.15 && v < cmax * 0.85) ticks.push({ u: Math.sqrt(v / cmax), text: `C ${v}` });
      title = 'chroma (√ scale)';
    } else {
      // One turn of OKLCH hue from the collection's emptiest 30° window. A
      // grey's hue is noise, so greys wait in their own slot.
      hueStart = hueCut(placed.filter(c => c[1] >= GREY_CHROMA).map(c => c[2]));
      lch.forEach((c, i) => { if (c && c[1] < GREY_CHROMA) greys.push(i); else if (c) u[i] = ((c[2] - hueStart + 360) % 360) / 360; });
      ticks.push({ u: 0, text: `${hueStart}°` }, { u: 1, text: `${hueStart}° again` });
      for (const [hue, deg] of OKLCH_HUES) ticks.push({ u: ((deg - hueStart + 360) % 360) / 360, text: `${hue} · ${deg}°` });
      title = `hue (OKLCH) from ${hueStart}°`;
    }
    slot('Grey, no hue', -MISSING_GAP, greys);
    slot('No palette', id === 'hue' ? -2 * MISSING_GAP : -MISSING_GAP, none);
    return { u, slots, ticks, title, free: true, kind: 'continuous', ...(hueStart != null ? { hueCut: hueStart } : {}) };
  }
  const dim = attributeAxis(clips, id, axisLabel(labelFor, id));
  if (!dim) throw new Error(`${id} cannot be placed on an axis`);
  const { model, label } = dim, missing = [];
  const several = model.multiValueRule ? (TIME_KEYS.includes(id) ? ', earliest of several' : ', lowest of several') : '';
  if (dim.kind === 'continuous') {
    // attributeMark's rank is (value − min) / (max − min): linear in time or number.
    clips.forEach((clip, i) => { const mark = attributeMark(clip, model); if (mark.missing || mark.rank == null) missing.push(i); else u[i] = mark.rank; });
    const at = value => (value - model.min) / (model.max - model.min);
    if (id === 'captured') {
      // The first and last dates, then month or year starts between them.
      const day = t => new Date(t).toISOString().slice(0, 10);
      ticks.push({ u: 0, text: `${day(model.min)} · first` }, { u: 1, text: `${day(model.max)} · last` });
      for (const [t, text] of dateTicks(model.min, model.max)) ticks.push({ u: at(t), text });
    }
    else if (model.domain.length <= MAX_PLANES) for (const value of model.domain) ticks.push({ u: attributeMark({ [id]: value }, model).rank ?? 0, text: value });
    else for (const v of niceTicks(model.min, model.max)) ticks.push({ u: at(v), text: String(v) });
    if (ticks.length < 2) ticks.push({ u: 0, text: model.domain[0] }, { u: 1, text: model.domain.at(-1) });
  } else {
    // Planes: evenly spaced, in the model's order (ranked, or alphabetical).
    const counts = new Map(model.domain.map(v => [v, 0])), k = model.domain.length;
    clips.forEach((clip, i) => {
      const mark = attributeMark(clip, model), index = mark.missing ? -1 : model.domain.indexOf(mark.valueLabel);
      if (index < 0) { missing.push(i); return; }
      u[i] = (index + 0.5) / k; counts.set(mark.valueLabel, counts.get(mark.valueLabel) + 1);
    });
    model.domain.forEach((value, index) => ticks.push({ u: (index + 0.5) / k, text: `${value} · ${counts.get(value)}` }));
  }
  slot(`No ${label}`, -MISSING_GAP, missing);
  return { u, slots, ticks, title: `${label}${several}`, free: false, kind: dim.kind };
}

/**
 * Axes: across = x, up = y, depth = z, each axis WORLD long, growing right,
 * up and away from the camera; missing-value slots sit before the start of
 * Across and Up, and beyond the far end of Depth. Attribute values are
 * exact, so declumping moves items only along colour axes (falling back to
 * continuous attribute axes, then to all three, when there is no colour axis).
 */
function arrangeAxes(clips, positions, sizes, edge, requested, labelFor) {
  const n = clips.length, colours = clips.map(dominantColor);
  const axes = requested && AXES.every(a => isAxisName(requested[a])) && validAxes(requested)
    ? { ...requested } : resolveAxes(axisDimensions(clips, clipAttributeKeys(clips), labelFor), requested || {});
  const coords = AXES.map(axis => axisCoordinates(clips, axes[axis], labelFor, colours));
  // Depth's slots go beyond its far end instead of before its start: a large
  // missing group (45% of one music library is grey) must not stand between
  // the camera and everything else.
  const depth = coords[2], behind = u => u < 0 ? 1 - u : u;
  depth.u = depth.u.map(behind); for (const s of depth.slots) s.u = behind(s.u);
  const world = [u => (u - 0.5) * WORLD, u => (u - 0.5) * WORLD, u => (0.5 - u) * WORLD];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) positions[i * 3 + k] = world[k](coords[k].u[i]);
  const exact = positions.slice(), all = [...Array(n).keys()];
  let free = coords.map(c => c.free);
  if (!free.some(Boolean)) free = coords.map(c => c.kind === 'continuous');
  if (!free.some(Boolean)) free = [true, true, true];
  const declumped = declump(positions, all, edge * 0.6, edge * 0.6, 4, free);
  // Reading order: along Across, then top to bottom, then front to back.
  const order = all.sort((a, b) => coords[0].u[a] - coords[0].u[b] || coords[1].u[b] - coords[1].u[a] || coords[2].u[a] - coords[2].u[b] || a - b);
  // Each axis line runs along the box edge that faces the Fit camera (front,
  // above, right), so ticks fall outside the cloud: Across on the front-bottom
  // edge, Up on the front-left edge, Depth on the right-bottom edge going back.
  const labels = [], guides = [];
  const base = [[null, world[1](0), world[2](0)], [world[0](0), null, world[2](0)], [world[0](1), world[1](0), null]];
  const along = (k, u) => base[k].map((v, j) => j === k ? world[k](u) : v);
  // Labels sit beside their point on the axis, on the side away from the
  // cloud, by a gap in screen pixels: a world offset would shrink with distance.
  // Across's title ends at the axis's near end, its lowest point on screen,
  // a row below the ticks; its slot labels run left from their slot. Depth's
  // title stands beyond its slots, which share its far end.
  const side = ['below', 'left', 'right'], slotSide = ['below-end', 'left', 'right'];
  const titleAt = [[1, 'below-end', 40], [1, 'above', 12], [Math.max(1, ...depth.slots.map(s => s.u)) + 0.08, 'above', 24]];
  // Labels are listed in priority order: placeLabels hides later ones that would overlap.
  coords.forEach((c, k) => {
    guides.push([along(k, 0), along(k, 1)]);
    const [u, at, gap] = titleAt[k];
    labels.push({ text: `${AXIS_LABELS[AXES[k]]} · ${c.title}`, kind: 'axis', axis: AXES[k], point: along(k, u), side: at, gap });
  });
  coords.forEach((c, k) => {
    for (const s of c.slots) {
      guides.push([along(k, s.u - 0.025), along(k, s.u + 0.025)]);
      labels.push({ text: s.text, kind: 'shelf', point: along(k, s.u), side: slotSide[k], gap: 8 });
    }
  });
  coords.forEach((c, k) => { for (const t of c.ticks) labels.push({ text: t.text, kind: 'tick', point: along(k, t.u), side: side[k], gap: 8 }); });
  const info = Object.fromEntries(AXES.map((axis, k) => [axis, { id: axes[axis], title: coords[k].title, kind: coords[k].kind, free: !!free[k],
    missing: coords[k].slots.reduce((sum, s) => sum + s.count, 0), ...(coords[k].hueCut != null ? { hueCut: coords[k].hueCut } : {}) }]));
  return { arrangement: 'axes', edge, stretch: 1, positions, exact, sizes, order, labels, guides, unplaced: 0, axes, axisInfo: info,
    declumped, bounds: boundsOf(positions, sizes, n) };
}

const OKLCH_HUES = [['red', 29], ['yellow', 110], ['green', 142], ['cyan', 195], ['blue', 264], ['magenta', 328]];
const HSL_HUES = [['red', 0], ['yellow', 60], ['green', 120], ['cyan', 180], ['blue', 240], ['magenta', 300]];
/**
 * Axis and hue-ring labels, and the line segments drawn under them. They span
 * the collection's own range and print its extremes, so the guides say where
 * this collection sits, not where colour space could reach.
 */
function colourGuides(arrangement, positions, placed, stretch, labels, guides) {
  if (!placed.length) return;
  const range = axis => { let lo = Infinity, hi = -Infinity; for (const i of placed) { lo = Math.min(lo, positions[i * 3 + axis]); hi = Math.max(hi, positions[i * 3 + axis]); } return [lo, hi]; };
  const [bottom, top] = range(1), mid = (bottom + top) / 2, lightness = y => (y / WORLD + 0.5).toFixed(2);
  const name = arrangement === 'hsl' ? 'HSL lightness' : 'L';
  guides.push([[0, bottom, 0], [0, top, 0]]);
  labels.push({ text: `${name} ${lightness(top)} · lightest`, kind: 'axis', point: [0, top + 50, 0] },
    { text: `${name} ${lightness(bottom)} · darkest`, kind: 'axis', point: [0, bottom - 50, 0] });
  if (arrangement === 'oklab') {
    const [a0, a1] = range(0), [b0, b1] = range(2), times = stretch === 1 ? '' : ` (a, b ×${stretch})`;
    guides.push([[a0, mid, 0], [a1, mid, 0]], [[0, mid, b0], [0, mid, b1]]);
    labels.push({ text: `+a · red${times}`, kind: 'axis', point: [a1 + 40, mid, 0] }, { text: '−a · green', kind: 'axis', point: [a0 - 40, mid, 0] },
      { text: '+b · yellow', kind: 'axis', point: [0, mid, b1 + 40] }, { text: '−b · blue', kind: 'axis', point: [0, mid, b0 - 40] });
    return;
  }
  const ring = [], steps = 72;
  for (let k = 0; k <= steps; k++) { const t = k / steps * Math.PI * 2; ring.push([RADIUS * Math.cos(t), mid, RADIUS * Math.sin(t)]); }
  for (let k = 0; k < steps; k++) guides.push([ring[k], ring[k + 1]]);
  for (const [hue, deg] of arrangement === 'hsl' ? HSL_HUES : OKLCH_HUES) {
    const t = deg * Math.PI / 180, r = RADIUS + 70;
    labels.push({ text: `${hue} · ${deg}°`, kind: 'hue', point: [r * Math.cos(t), mid, r * Math.sin(t)] });
  }
  labels.push({ text: arrangement === 'hsl' ? 'radius · HSL chroma' : 'radius · relative chroma', kind: 'axis', point: [RADIUS * 0.5, mid - 40, 0] });
}

/**
 * Pull apart tiles that would sit on top of each other: identical dominant
 * colours are common (black covers, white screenshots) and would z-fight.
 * Bounded so a tile never leaves the neighbourhood its colour gives it:
 * no tile moves more than `cap` from its exact position.
 */
export function declump(positions, indices, minDist, cap, iterations = 4, free = [1, 1, 1]) {
  if (!(minDist > 0) || indices.length < 2) return { moved: 0, maxShift: 0, meanShift: 0 };
  const [fx, fy, fz] = free.map(f => f ? 1 : 0);
  const origin = new Map(indices.map(i => [i, [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]]));
  const cell = minDist, keyOf = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let pass = 0; pass < iterations; pass++) {
    const grid = new Map();
    for (const i of indices) {
      const k = keyOf(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
    }
    let pushed = 0;
    for (const i of indices) {
      const cx = Math.floor(positions[i * 3] / cell), cy = Math.floor(positions[i * 3 + 1] / cell), cz = Math.floor(positions[i * 3 + 2] / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) || []) {
          if (j <= i) continue;
          const gap = Math.hypot(positions[i * 3] - positions[j * 3], positions[i * 3 + 1] - positions[j * 3 + 1], positions[i * 3 + 2] - positions[j * 3 + 2]);
          if (gap >= minDist) continue;
          // Push only along free axes: an item in Axes never leaves its date,
          // year or category plane.
          let vx = (positions[i * 3] - positions[j * 3]) * fx, vy = (positions[i * 3 + 1] - positions[j * 3 + 1]) * fy, vz = (positions[i * 3 + 2] - positions[j * 3 + 2]) * fz;
          let d = Math.hypot(vx, vy, vz);
          if (d < 1e-6) {
            // Coincident on the free axes: a fixed direction from the pair, so
            // the result is the same on every load.
            const a = (i * 12.9898 + j * 78.233) % (Math.PI * 2);
            vx = Math.cos(a) * fx; vy = Math.sin(a) * 0.5 * fy; vz = Math.sin(a) * fz; d = Math.hypot(vx, vy, vz);
            if (d < 1e-6) { vx = fx; vy = fx ? 0 : fy; vz = fx || fy ? 0 : fz; d = Math.hypot(vx, vy, vz) || 1; }
          }
          vx /= d; vy /= d; vz /= d;
          const push = (minDist - gap) / 2;
          positions[i * 3] += vx * push; positions[i * 3 + 1] += vy * push; positions[i * 3 + 2] += vz * push;
          positions[j * 3] -= vx * push; positions[j * 3 + 1] -= vy * push; positions[j * 3 + 2] -= vz * push;
          pushed++;
        }
      }
    }
    for (const i of indices) {
      const o = origin.get(i), dx = positions[i * 3] - o[0], dy = positions[i * 3 + 1] - o[1], dz = positions[i * 3 + 2] - o[2];
      const d = Math.hypot(dx, dy, dz);
      if (d > cap) { const k = cap / d; positions[i * 3] = o[0] + dx * k; positions[i * 3 + 1] = o[1] + dy * k; positions[i * 3 + 2] = o[2] + dz * k; }
    }
    if (!pushed) break;
  }
  let moved = 0, maxShift = 0, total = 0;
  for (const i of indices) {
    const o = origin.get(i), d = Math.hypot(positions[i * 3] - o[0], positions[i * 3 + 1] - o[1], positions[i * 3 + 2] - o[2]);
    if (d > 1e-3) moved++; maxShift = Math.max(maxShift, d); total += d;
  }
  return { moved, maxShift, meanShift: total / indices.length };
}

/**
 * A cloud's order key (`front=`): a dimension id, highest first, or with a
 * leading `-`, lowest first ("-captured": the earliest capture first).
 */
export const parseFront = front => front.startsWith('-') ? { id: front.slice(1), descending: false } : { id: front, descending: true };
export const isFront = front => typeof front === 'string' && isAxisName(front) && isAxisName(parseFront(front).id);
/**
 * Values to order a cloud by, one per clip: the item's place along that
 * dimension's axis, 0 to 1, so dates, numbers, ranks and the colour
 * coordinates all compare the way Axes would place them; null where the item
 * has no value (no date, a grey's hue). Throws for a dimension the collection
 * cannot carry.
 */
export function orderValues(clips, id, labelFor) {
  const { u } = axisCoordinates(clips, id, labelFor, clips.map(dominantColor));
  return Array.from(u, v => v < 0 ? null : v);
}
/** Is this dimension a time (capture date, year, decade)? Its order reads latest or earliest first. */
export const isTimeKey = id => TIME_KEYS.includes(id);

/**
 * Cloud: a picture, not a measurement. Items spiral out from the centre in
 * priority order (`priority`: indices, first is front; the rest follow in
 * collection order), each one a golden angle on from the last, so the front of
 * the order holds the middle. Rank also sets depth and size: the first items
 * stand closest to the camera and largest, and the cloud thins and recedes
 * behind them. Nothing here encodes a value; the order is the only claim, and
 * the figure says what decided it.
 */
function arrangeCloud(clips, positions, sizes, edge, priority = []) {
  const n = clips.length, seen = new Set(), order = [];
  for (const i of priority) if (Number.isInteger(i) && i >= 0 && i < n && !seen.has(i)) { seen.add(i); order.push(i); }
  for (let i = 0; i < n; i++) if (!seen.has(i)) order.push(i);
  const golden = Math.PI * (3 - Math.sqrt(5)), spacing = edge * 0.95, depth = WORLD * 0.9 / Math.max(1, n), front = Math.max(4, n * 0.06);
  order.forEach((i, rank) => {
    // Prominence falls from 1.9 to 0.7 over the front of the order.
    const scale = 0.7 + 1.2 * Math.exp(-rank / front), r = spacing * Math.sqrt(rank) * (0.6 + 0.4 * scale), t = rank * golden;
    positions[i * 3] = r * Math.cos(t); positions[i * 3 + 1] = r * Math.sin(t); positions[i * 3 + 2] = -rank * depth;
    sizes[i * 2] *= scale; sizes[i * 2 + 1] *= scale;
  });
  return { arrangement: 'cloud', edge, stretch: 1, positions, exact: positions.slice(), sizes, order, labels: [], guides: [], unplaced: 0,
    declumped: { moved: 0, maxShift: 0, meanShift: 0 }, bounds: boundsOf(positions, sizes, n) };
}

function boundsOf(positions, sizes, n) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const half = k === 2 ? 0 : sizes[i * 2 + k] / 2;
    min[k] = Math.min(min[k], positions[i * 3 + k] - half); max[k] = Math.max(max[k], positions[i * 3 + k] + half);
  }
  if (!n) { min.fill(-WORLD / 2); max.fill(WORLD / 2); }
  const centre = min.map((v, k) => (v + max[k]) / 2);
  const radius = Math.max(1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  return { min, max, centre, radius };
}

/* ------------------------------------------------- keyboard navigation --- */

/**
 * The next item from `from` along world axis `k` (0 across, 1 up, 2 depth) in
 * direction `sign`, among `candidates` (indices). An item further along the
 * axis is preferred when it stays close on the other two: the score is the
 * distance along the axis plus twice the distance off it, so → walks a row
 * rather than leaping to whatever is nearest in a straight line. −1 when
 * nothing lies that way.
 */
export const OFF_AXIS_WEIGHT = 2;
export function nearestAlong(positions, candidates, from, k, sign) {
  const p = [positions[from * 3], positions[from * 3 + 1], positions[from * 3 + 2]];
  let best = -1, bestScore = Infinity;
  for (const j of candidates) {
    if (j === from) continue;
    const d = [positions[j * 3] - p[0], positions[j * 3 + 1] - p[1], positions[j * 3 + 2] - p[2]];
    const along = sign * d[k]; if (!(along > 1e-6)) continue;
    const score = along + OFF_AXIS_WEIGHT * Math.hypot(d[(k + 1) % 3], d[(k + 2) % 3]);
    if (score < bestScore || score === bestScore && j < best) { best = j; bestScore = score; }
  }
  return best;
}

/** The named OKLCH hue nearest `degrees`, as the hue axis labels its ticks. */
export function hueName(degrees) {
  let best = OKLCH_HUES[0][0], gap = Infinity;
  for (const [name, at] of OKLCH_HUES) { const d = Math.abs(((degrees - at + 540) % 360) - 180); if (d < gap) { gap = d; best = name; } }
  return best;
}

/**
 * Where an item sits, in the arrangement's own terms: one short reading per
 * axis, for the keyboard callout (`short`) and its spoken twin (`spoken`).
 * Axes reads the three chosen dimensions; the colour arrangements read
 * lightness, hue and chroma; A–Z reads the title's shelf. `modelFor(id)`
 * returns the collection's attribute model for an attribute axis (attributeAxis).
 */
export function describeItem(clip, arrangement, { axes = null, modelFor = () => null, labelFor } = {}) {
  const rgb = dominantColor(clip), lch = rgb ? oklch(oklab(rgb)) : null;
  const colour = id => {
    if (!lch) return { short: 'no palette', spoken: 'no palette' };
    if (id === 'lightness') return { short: `L ${lch[0].toFixed(2)}`, spoken: `lightness ${lch[0].toFixed(2)}` };
    if (id === 'chroma') return { short: `C ${lch[1].toFixed(2)}`, spoken: `chroma ${lch[1].toFixed(2)}` };
    const name = lch[1] < GREY_CHROMA ? 'grey' : hueName(lch[2]);
    return { short: name, spoken: name === 'grey' ? 'grey, no hue' : `hue ${name}` };
  };
  const attribute = id => {
    const model = modelFor(id), label = axisLabel(labelFor, id);
    if (!model) return { short: '', spoken: '' };
    const mark = attributeMark(clip, model);
    if (mark.missing) return { short: `no ${label}`, spoken: `no ${label}` };
    const value = TIME_KEYS.includes(id) && /^\d{4}-\d{2}-\d{2}/.test(mark.valueLabel) ? mark.valueLabel.slice(0, 10) : mark.valueLabel;
    return { short: value, spoken: `${label} ${value}` };
  };
  let parts;
  if (arrangement === 'axes' && axes) parts = AXES.map(axis => COLOUR_DIMENSIONS.includes(axes[axis]) ? colour(axes[axis]) : attribute(axes[axis]));
  else if (arrangement === 'az') { const shelf = shelfOf(String(clip.title || '')); parts = [{ short: `shelf ${shelf}`, spoken: `shelf ${shelf}` }]; }
  else parts = ['lightness', 'hue', 'chroma'].map(colour);
  // A reading the title already starts with (a capture date, for timestamped titles) is said once.
  const title = String(clip.title || '');
  // Repeats collapse too: an item with no palette has one reading for its three colour coordinates.
  parts = parts.filter((p, i, all) => p.short && !title.startsWith(p.short) && all.findIndex(q => q.short === p.short) === i);
  return { short: parts.map(p => p.short), spoken: parts.map(p => p.spoken).join(', ') };
}
