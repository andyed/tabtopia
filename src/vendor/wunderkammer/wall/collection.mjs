/**
 * The collection document: what a producer, often an LLM, writes to show a
 * person a visual collection in wunderkammer without a wunderkammer server. Format
 * "wunderkammer.collection", version 1; docs/CONTRACT.md describes it.
 *
 * The validator is the trust boundary for ?collection= and mount(). A
 * collection can come from anywhere, so link and image schemes are checked
 * here; every string still reaches the DOM only through textContent
 * (wall.mjs). Problems are collected with their paths, so a producer sees all
 * of them at once instead of fixing one per reload.
 */
import { buildFacets } from './facet-counts.mjs';

export const COLLECTION_FORMAT = 'wunderkammer.collection';
export const COLLECTION_LIMITS = Object.freeze({ clips: 50000, problems: 25, sheets: 4096, sheetSlots: 8, sheetEdge: 4096, sheetPx: 16384 });

const TOP = ['format', 'version', 'corpus', 'ui', 'facetTypes', 'images', 'viewState', 'sheets', 'facets', 'clips'];
/** Keys a wunderkammer server payload carries that a portable document must not. */
const SERVER_ONLY = new Set(['vault', 'adapters', 'generated']);
const CLIP = ['id', 'url', 'title', 'cover', 'coverVariants', 'detailCover', 'media', 'sheetSlots', 'sourceUrl', 'sourceLabel',
  'note', 'tags', 'props', 'source', 'kind', 'captured', 'palette', 'projection'];
const UI = ['title', 'defaultGroup', 'facetOrder', 'facetLabels', 'hiddenFacets', 'nouns'];
const FACET_TYPES = ['categorical', 'ordinal', 'numeric', 'date'];
const SHEET_ROLES = ['overview', 'covers'];
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const CAPTURED = /^\d{4}(-\d{2}(-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?)?)?$/;

export class CollectionError extends TypeError {
  constructor(problems, overflow = 0) {
    const more = overflow ? `\n- …and ${overflow} more` : '';
    super(`Collection is not valid (${problems.length + overflow} problem${problems.length + overflow === 1 ? '' : 's'}):\n- ${problems.join('\n- ')}${more}`);
    this.name = 'CollectionError';
    this.problems = problems;
  }
}

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * Validate and normalize a collection document. Relative media and link URLs
 * resolve against `baseUrl` (the document's own URL), as CSS URLs do.
 * Returns { collection, warnings }; throws CollectionError listing every
 * problem found, up to COLLECTION_LIMITS.problems.
 */
export function validateCollection(input, { baseUrl = null } = {}) {
  const problems = [], warnings = [];
  let overflow = 0;
  const problem = (path, message) => {
    if (problems.length < COLLECTION_LIMITS.problems) problems.push(`${path} ${message}`); else overflow++;
  };
  const text = (value, path, { max = 240, empty = false } = {}) => {
    if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || CONTROL.test(value)) {
      problem(path, `must be ${empty ? 'a' : 'a non-empty'} string of at most ${max} characters`);
      return null;
    }
    return value;
  };
  const field = (value, path) => {
    const v = text(value, path, { max: 80 });
    if (v !== null && FORBIDDEN.has(v)) { problem(path, 'is not a supported attribute name'); return null; }
    return v;
  };
  const keys = (value, path, allowed) => {
    if (!plain(value)) { problem(path, 'must be an object'); return false; }
    for (const key of Object.keys(value)) {
      if (FORBIDDEN.has(key)) problem(`${path}.${key}`, 'is not allowed');
      else if (allowed && !allowed.includes(key)) problem(`${path}.${key}`, `is not supported (supported: ${allowed.join(', ')})`);
    }
    return true;
  };
  const fields = (value, path, max) => {
    if (!Array.isArray(value) || value.length > max) { problem(path, `must be an array of at most ${max} attribute names`); return []; }
    return value.map((v, i) => field(v, `${path}[${i}]`)).filter(v => v !== null);
  };
  /** An image source: http(s), data:image/ or blob:, after resolving relative paths. */
  const image = (value, path) => {
    if (text(value, path, { max: 1 << 20 }) === null) return null;
    let url;
    try { url = baseUrl ? new URL(value, baseUrl) : new URL(value); } catch {
      // Without a base, a relative path stays relative to the page, as the static demo uses it.
      if (!baseUrl && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//')) return value;
      problem(path, 'must be a valid URL'); return null;
    }
    if (url.protocol === 'data:' ? !/^data:image\//i.test(value) : !['http:', 'https:', 'blob:'].includes(url.protocol)) {
      problem(path, 'must be an http(s), data:image/ or blob: URL'); return null;
    }
    return url.protocol === 'data:' ? value : url.href;
  };
  /** A link a person can follow: http(s) only. */
  const link = (value, path) => {
    if (text(value, path, { max: 4096 }) === null) return null;
    let url;
    try { url = baseUrl ? new URL(value, baseUrl) : new URL(value); } catch { problem(path, 'must be an absolute http(s) URL'); return null; }
    if (!['http:', 'https:'].includes(url.protocol)) { problem(path, 'must be an http(s) URL'); return null; }
    return url.href;
  };

  if (!keys(input, 'collection')) throw new CollectionError(problems);
  for (const key of Object.keys(input)) {
    if (SERVER_ONLY.has(key)) problem(`collection.${key}`, 'belongs to a wunderkammer server response; a collection document does not carry it');
    else if (!TOP.includes(key) && !FORBIDDEN.has(key)) problem(`collection.${key}`, `is not supported (supported: ${TOP.join(', ')})`);
  }
  if (input.format !== COLLECTION_FORMAT) problem('format', `must be "${COLLECTION_FORMAT}"`);
  if (input.version !== 1) problem('version', 'must be 1');

  const out = { format: COLLECTION_FORMAT, version: 1 };

  if (keys(input.corpus, 'corpus', ['id', 'revision'])) {
    out.corpus = { id: text(input.corpus.id, 'corpus.id', { max: 200 }) };
    if (input.corpus.revision !== undefined) out.corpus.revision = text(input.corpus.revision, 'corpus.revision', { max: 200 });
  }

  out.ui = {};
  if (input.ui !== undefined && keys(input.ui, 'ui', UI)) {
    const ui = input.ui;
    if (ui.title !== undefined) out.ui.title = text(ui.title, 'ui.title', { max: 200 });
    if (ui.defaultGroup !== undefined) out.ui.defaultGroup = field(ui.defaultGroup, 'ui.defaultGroup');
    if (ui.facetOrder !== undefined) out.ui.facetOrder = fields(ui.facetOrder, 'ui.facetOrder', 64);
    if (ui.hiddenFacets !== undefined) out.ui.hiddenFacets = fields(ui.hiddenFacets, 'ui.hiddenFacets', 64);
    if (ui.facetLabels !== undefined && keys(ui.facetLabels, 'ui.facetLabels')) {
      out.ui.facetLabels = {};
      for (const [k, v] of Object.entries(ui.facetLabels)) {
        if (field(k, `ui.facetLabels key "${k}"`) !== null) out.ui.facetLabels[k] = text(v, `ui.facetLabels.${k}`, { max: 120 });
      }
    }
    // What the comparison page calls one item and several; both, since a plural cannot be guessed.
    if (ui.nouns !== undefined && keys(ui.nouns, 'ui.nouns', ['item', 'items'])) {
      const item = text(ui.nouns.item, 'ui.nouns.item', { max: 40 }), items = text(ui.nouns.items, 'ui.nouns.items', { max: 40 });
      if (item !== null && items !== null) out.ui.nouns = { item, items };
    }
  }

  // Validated and carried; the wall does not yet order or bin by them.
  if (input.facetTypes !== undefined && keys(input.facetTypes, 'facetTypes')) {
    out.facetTypes = {};
    const entries = Object.entries(input.facetTypes);
    if (entries.length > 64) problem('facetTypes', 'supports at most 64 attributes');
    for (const [k, v] of entries.slice(0, 64)) {
      const path = `facetTypes.${k}`;
      if (field(k, `facetTypes key "${k}"`) === null || !keys(v, path, ['type', 'order'])) continue;
      if (!FACET_TYPES.includes(v.type)) { problem(`${path}.type`, `must be one of ${FACET_TYPES.join(', ')}`); continue; }
      const type = { type: v.type };
      if (v.order !== undefined) {
        if (v.type !== 'ordinal') problem(`${path}.order`, 'is only meaningful for an ordinal facet');
        else if (!Array.isArray(v.order) || v.order.length > 500) problem(`${path}.order`, 'must be an array of at most 500 values');
        else type.order = v.order.map((o, i) => text(o, `${path}.order[${i}]`, { max: 200 }));
      }
      out.facetTypes[k] = type;
    }
  }

  if (input.images !== undefined && keys(input.images, 'images', ['cors', 'sheets'])) {
    out.images = {};
    if (input.images.cors !== undefined) {
      if (typeof input.images.cors !== 'boolean') problem('images.cors', 'must be true or false');
      else out.images.cors = input.images.cors;
    }
    // What a clip's cells are when it also names a file: "overview" (they feed
    // only the overview canvas, as a server's pages do) or "covers" (they serve
    // every view; the file stands in only for a page that fails to load).
    if (input.images.sheets !== undefined) {
      if (!SHEET_ROLES.includes(input.images.sheets)) problem('images.sheets', `must be one of ${SHEET_ROLES.join(', ')}`);
      else out.images.sheets = input.images.sheets;
    }
  }

  if (input.viewState !== undefined && keys(input.viewState, 'viewState', ['version', 'mode', 'groupKey', 'piles'])) {
    const vs = input.viewState;
    if (vs.version !== 1) problem('viewState.version', 'must be 1');
    if (vs.mode !== undefined) text(vs.mode, 'viewState.mode', { max: 40 });
    if (vs.groupKey !== undefined) field(vs.groupKey, 'viewState.groupKey');
    if (vs.piles !== undefined && (!Array.isArray(vs.piles) || vs.piles.length > 1000 || !vs.piles.every(plain))) {
      problem('viewState.piles', 'must be an array of at most 1000 pile objects');
    }
    out.viewState = structuredClone(vs);
  }

  // Sprite sheets: a few images that hold every cover, instead of one file per
  // item (docs/CONTRACT.md, "Sprite sheets"). Clips point into them with
  // sheetSlots, checked against these bounds below.
  if (input.sheets !== undefined) {
    const L = COLLECTION_LIMITS;
    if (!Array.isArray(input.sheets) || !input.sheets.length || input.sheets.length > L.sheets) {
      problem('sheets', `must be an array of 1 to ${L.sheets} { src, edge, width, height } objects`);
    } else {
      out.sheets = input.sheets.map((sheet, i) => {
        const p = `sheets[${i}]`;
        if (!keys(sheet, p, ['src', 'edge', 'width', 'height'])) return null;
        const src = image(sheet.src, `${p}.src`);
        let ok = src !== null;
        if (!Number.isInteger(sheet.edge) || sheet.edge < 1 || sheet.edge > L.sheetEdge) { problem(`${p}.edge`, `must be an integer from 1 to ${L.sheetEdge}`); ok = false; }
        for (const k of ['width', 'height']) {
          if (!Number.isInteger(sheet[k]) || sheet[k] < 1 || sheet[k] > L.sheetPx) { problem(`${p}.${k}`, `must be an integer from 1 to ${L.sheetPx}`); ok = false; }
        }
        return ok ? { src, edge: sheet.edge, width: sheet.width, height: sheet.height } : null;
      });
    }
  }
  const usedSheets = new Set();

  out.clips = [];
  if (!Array.isArray(input.clips) || !input.clips.length || input.clips.length > COLLECTION_LIMITS.clips) {
    problem('clips', `must be an array of 1 to ${COLLECTION_LIMITS.clips} items`);
  } else {
    const seen = new Map();
    let unknownReported = false;
    input.clips.forEach((clip, i) => {
      const path = `clips[${i}]`;
      if (!plain(clip)) { problem(path, 'must be an object'); return; }
      for (const key of Object.keys(clip)) {
        if (CLIP.includes(key)) continue;
        if (FORBIDDEN.has(key)) problem(`${path}.${key}`, 'is not allowed');
        else if (!unknownReported) { unknownReported = true; problem(`${path}.${key}`, `is not supported (supported: ${CLIP.join(', ')}; put other attributes in props)`); }
        else problem(`${path}.${key}`, 'is not supported');
      }
      const c = {};
      c.id = text(clip.id, `${path}.id`, { max: 300 });
      if (clip.url !== undefined) {
        // url is identity first; it is followed only when no sourceUrl is given.
        if (typeof clip.url === 'string' && /^urn:[a-z0-9][a-z0-9-]{0,31}:\S+$/i.test(clip.url) && clip.url.length <= 4096) c.url = clip.url;
        else c.url = link(clip.url, `${path}.url`);
      }
      const key = String(c.url || c.id);
      if (seen.has(key)) problem(path, `repeats the identity of clips[${seen.get(key)}] (${c.url ? 'url' : 'id'} "${key.slice(0, 80)}")`);
      else seen.set(key, i);
      c.title = clip.title === undefined ? c.id : text(clip.title, `${path}.title`, { max: 500, empty: true });
      for (const name of ['cover', 'detailCover']) if (clip[name] !== undefined) c[name] = image(clip[name], `${path}.${name}`);
      if (clip.coverVariants !== undefined) {
        if (!Array.isArray(clip.coverVariants) || clip.coverVariants.length > 8) problem(`${path}.coverVariants`, 'must be an array of at most 8 { src, width } objects');
        else c.coverVariants = clip.coverVariants.map((v, j) => {
          const p = `${path}.coverVariants[${j}]`;
          if (!keys(v, p, ['src', 'width'])) return null;
          if (!Number.isInteger(v.width) || v.width < 1 || v.width > 8192) problem(`${p}.width`, 'must be an integer from 1 to 8192');
          return { src: image(v.src, `${p}.src`), width: v.width };
        });
      }
      if (clip.media !== undefined) {
        if (!Array.isArray(clip.media) || clip.media.length > 32) problem(`${path}.media`, 'must be an array of at most 32 { src } objects');
        else c.media = clip.media.map((m, j) => keys(m, `${path}.media[${j}]`, ['src']) ? { src: image(m.src, `${path}.media[${j}].src`) } : null);
      }
      if (clip.sheetSlots !== undefined) {
        const p = `${path}.sheetSlots`, L = COLLECTION_LIMITS;
        if (!out.sheets) problem(p, 'needs a top-level sheets list to point into');
        else if (!Array.isArray(clip.sheetSlots) || !clip.sheetSlots.length || clip.sheetSlots.length > L.sheetSlots) {
          problem(p, `must be an array of 1 to ${L.sheetSlots} [sheet, x, y, w, h] cells`);
        } else {
          const edges = new Set();
          c.sheetSlots = clip.sheetSlots.map((cell, j) => {
            const q = `${p}[${j}]`;
            if (!Array.isArray(cell) || cell.length !== 5 || !cell.every(Number.isInteger)) { problem(q, 'must be [sheet, x, y, w, h], five integers'); return null; }
            const [index, x, y, w, h] = cell, sheet = out.sheets[index];
            if (!sheet) { problem(q, index >= 0 && index < out.sheets.length ? `points at sheets[${index}], which is not valid` : `points at sheets[${index}], which does not exist`); return null; }
            if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > sheet.width || y + h > sheet.height) { problem(q, `must lie inside sheets[${index}] (${sheet.width}×${sheet.height})`); return null; }
            // Tiers pick a cell by its level's edge, so a cell may not exceed it.
            if (Math.max(w, h) > sheet.edge) { problem(q, `is larger than its sheet's edge (${sheet.edge})`); return null; }
            if (edges.has(sheet.edge)) { problem(q, `repeats the ${sheet.edge} px level; give one cell per level`); return null; }
            edges.add(sheet.edge); usedSheets.add(index);
            return [index, x, y, w, h];
          });
        }
      }
      if (clip.sourceUrl !== undefined) c.sourceUrl = link(clip.sourceUrl, `${path}.sourceUrl`);
      if (clip.sourceLabel !== undefined) c.sourceLabel = text(clip.sourceLabel, `${path}.sourceLabel`, { max: 100 });
      if (clip.note !== undefined) c.note = text(clip.note, `${path}.note`, { max: 20000, empty: true });
      c.tags = [];
      if (clip.tags !== undefined) {
        if (!Array.isArray(clip.tags) || clip.tags.length > 200) problem(`${path}.tags`, 'must be an array of at most 200 strings');
        else c.tags = clip.tags.map((t, j) => text(t, `${path}.tags[${j}]`, { max: 200 }));
      }
      for (const name of ['source', 'kind']) if (clip[name] !== undefined) c[name] = text(clip[name], `${path}.${name}`, { max: 200 });
      if (clip.captured !== undefined) {
        if (typeof clip.captured !== 'string' || !CAPTURED.test(clip.captured)) problem(`${path}.captured`, 'must be an ISO date: YYYY, YYYY-MM, YYYY-MM-DD or a date-time');
        else c.captured = clip.captured;
      }
      if (clip.props !== undefined && keys(clip.props, `${path}.props`)) {
        const entries = Object.entries(clip.props);
        if (entries.length > 128) problem(`${path}.props`, 'supports at most 128 attributes');
        c.props = {};
        for (const [k, v] of entries.slice(0, 128)) {
          const p = `${path}.props.${k}`;
          if (field(k, `${path}.props key "${k}"`) === null) continue;
          // valuesOf() reads a clip's own field before props, so these would be invisible.
          if (CLIP.includes(k)) { problem(p, `is hidden by the clip's own ${k} field; rename the attribute`); continue; }
          const scalar = (x, q) => (typeof x === 'string' ? text(x, q, { max: 500, empty: true }) !== null
            : typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) || (problem(q, 'must be a string, finite number or boolean'), false);
          if (v === null) c.props[k] = null;
          else if (Array.isArray(v)) {
            if (v.length > 200) problem(p, 'supports at most 200 values');
            else if (v.every((x, j) => scalar(x, `${p}[${j}]`))) c.props[k] = [...v];
          } else if (scalar(v, p)) c.props[k] = v;
        }
      }
      if (clip.palette !== undefined) {
        if (!Array.isArray(clip.palette) || clip.palette.length > 16 || !clip.palette.every(h => typeof h === 'string' && /^#[0-9a-f]{6}$/i.test(h))) {
          problem(`${path}.palette`, 'must be an array of at most 16 #rrggbb colors');
        } else c.palette = [...clip.palette];
      }
      if (clip.projection !== undefined && keys(clip.projection, `${path}.projection`, ['x', 'y', 'col', 'row'])) {
        const pr = clip.projection, unit = n => typeof n === 'number' && n >= -1 && n <= 1;
        if (!unit(pr.x) || !unit(pr.y)) problem(`${path}.projection`, 'needs x and y numbers from -1 to 1');
        for (const k of ['col', 'row']) if (pr[k] !== undefined && !(Number.isInteger(pr[k]) && pr[k] >= 0)) problem(`${path}.projection.${k}`, 'must be a non-negative integer');
        c.projection = { ...pr };
      }
      out.clips.push(c);
    });
  }

  if (problems.length || overflow) throw new CollectionError(problems, overflow);

  if (out.sheets) {
    const unused = out.sheets.map((_, i) => i).filter(i => !usedSheets.has(i));
    if (unused.length) warnings.push(`sheets ${unused.slice(0, 10).map(i => `[${i}]`).join(', ')}${unused.length > 10 ? ' …' : ''} hold no clip's cell; nothing loads them`);
  }

  // Counts are derived so they cannot disagree with the clips.
  out.facets = buildFacets(out.clips);
  if (input.facets !== undefined && !sameCounts(input.facets, out.facets)) {
    warnings.push('facets differ from the counts derived from clips; the derived counts are used');
  }
  return { collection: out, warnings };
}

/**
 * Every image source a collection names, as [path, src] pairs: each clip's
 * cover, detailCover, coverVariants and media, then the sheet pages. A check
 * that a document's files exist walks this list, so a new image field is
 * added here once rather than in each checker.
 */
export function collectionImages(collection) {
  const found = [];
  const add = (where, src) => { if (typeof src === 'string') found.push([where, src]); };
  for (const [i, clip] of (collection.clips || []).entries()) {
    const at = `clips[${i}]`;
    add(`${at}.cover`, clip?.cover);
    add(`${at}.detailCover`, clip?.detailCover);
    for (const [j, v] of (clip?.coverVariants || []).entries()) add(`${at}.coverVariants[${j}].src`, v?.src);
    for (const [j, m] of (clip?.media || []).entries()) add(`${at}.media[${j}].src`, m?.src);
  }
  for (const [i, sheet] of (collection.sheets || []).entries()) add(`sheets[${i}].src`, sheet?.src);
  return found;
}

function sameCounts(a, b) {
  if (!plain(a)) return false;
  const norm = f => JSON.stringify(Object.keys(f).sort().map(k => [k, Object.entries(f[k] || {}).sort()]));
  try { return norm(a) === norm(b); } catch { return false; }
}

/**
 * Convert a wunderkammer server payload (/api/clips) into a collection document.
 * Server-only keys are dropped and clip fields outside the format are
 * removed and counted, so an export never silently ships private fields.
 */
export function toCollection(payload, { viewState } = {}) {
  const removed = {};
  const clips = (payload.clips || []).map(clip => {
    const c = {};
    for (const [k, v] of Object.entries(clip)) {
      // A server's sheetSlots index its own /media/sheets pages, which an
      // export does not carry; scripts/collection-sheets.py bakes portable ones.
      if (CLIP.includes(k) && k !== 'sheetSlots') c[k] = v; else removed[k] = (removed[k] || 0) + 1;
    }
    return c;
  });
  const doc = { format: COLLECTION_FORMAT, version: 1, corpus: { ...payload.corpus }, ui: { ...(payload.ui || {}) }, clips };
  for (const k of Object.keys(doc.ui)) if (!UI.includes(k)) { removed[`ui.${k}`] = 1; delete doc.ui[k]; }
  if (viewState) doc.viewState = viewState;
  return { collection: doc, removed };
}
