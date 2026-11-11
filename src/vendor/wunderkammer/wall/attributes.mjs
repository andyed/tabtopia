/**
 * Pure attribute distribution and review sorting helpers.
 *
 * Attribute models are deliberately derived from the clips supplied to them.
 * Ordered values get a cyan → purple → warm gradient whose stops form an
 * explicit legend. Category colors are hashed from the category itself, so a
 * category keeps its color when the working scope changes. The category
 * palette is finite by design; it is a visual cue, not a claim that a large
 * vocabulary has one visually unique color per value.
 */
import { valuesOf } from './context-clusters.mjs';

const LOW = '#22d3ee';
const MID = '#8b5cf6';
const HIGH = '#f59e0b';
const MISSING_COLOR = '#64748b';

// A compact, deliberately finite palette. Hashing rather than indexing the
// current domain keeps category colors independent of scope and ordering.
const CATEGORY_COLORS = [
  '#22d3ee', '#f472b6', '#a3e635', '#fb7185', '#38bdf8', '#facc15',
  '#c084fc', '#2dd4bf', '#fb923c', '#818cf8', '#4ade80', '#f87171',
];
const FAMILY_COLORS = {
  red: '#ef4444', orange: '#f97316', yellow: '#eab308', green: '#22c55e',
  blue: '#3b82f6', purple: '#8b5cf6', violet: '#8b5cf6', pink: '#ec4899',
  magenta: '#ec4899', cyan: '#06b6d4', teal: '#14b8a6', brown: '#a16207',
  black: '#171717', white: '#f8fafc', gray: '#94a3b8', grey: '#94a3b8',
};

const ORDERED_KEYS = new Set(['year', 'captured', 'decade', 'complexity', 'repetition', 'compression']);
const COMPLEXITY_ORDER = ['low', 'medium', 'high'];
const REPETITION_ORDER = ['weak', 'moderate', 'strong'];
const COMPRESSION_ORDER = ['under 20%', '20–50%', '50–80%', '80% or more'];

const missingLegend = () => ({ label: 'Missing', color: MISSING_COLOR });

function rawValues(clip, key) {
  clip = clip || {};
  const raw = key in clip ? clip[key] : clip.props?.[key];
  return Array.isArray(raw) ? raw : raw == null ? [] : [raw];
}

function usable(value) {
  if (value == null) return false;
  const text = String(value).trim();
  return text !== '' && text.toLowerCase() !== 'unknown' && text.toLowerCase() !== 'uncertain';
}

function labelsOf(clip, key) {
  // Keep the shared normalization path for ordinary properties. Captured-date
  // brushing uses month values in context-clusters, but sorting and marks must
  // retain the original timestamp so two captures in one month still order.
  const labels = key === 'captured' ? rawValues(clip, key).map(String) : valuesOf(clip, key).map(String);
  return [...new Set(labels.filter(usable))];
}

function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim().replace(/,/g, '');
  if (!text || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function dateOf(value) {
  const text = String(value).trim();
  if (!/^\d{4}(?:-\d{2}(?:-\d{2})?)?(?:T.*)?$/.test(text)) return null;
  const time = Date.parse(text.length === 4 ? `${text}-01-01` : text.length === 7 ? `${text}-01` : text);
  return Number.isFinite(time) ? time : null;
}

function normalizedLabel(key, value) {
  const text = String(value).trim();
  if (key === 'decade') {
    const n = numberOf(text.replace(/s$/i, ''));
    return n == null ? text : `${n}s`;
  }
  if (key === 'complexity' || key === 'repetition' || key === 'compression') return text.toLowerCase();
  return text;
}

function qualitativeRank(key, value) {
  const text = normalizedLabel(key, value);
  if (key === 'complexity') return COMPLEXITY_ORDER.indexOf(text);
  if (key === 'repetition') return REPETITION_ORDER.indexOf(text);
  if (key === 'compression') {
    const direct = COMPRESSION_ORDER.indexOf(text);
    if (direct >= 0) return direct;
    const n = numberOf(text.replace(/%$/, ''));
    if (n != null) return n <= 1 ? n * 100 >= 80 ? 3 : n * 100 >= 50 ? 2 : n * 100 >= 20 ? 1 : 0 : n >= 80 ? 3 : n >= 50 ? 2 : n >= 20 ? 1 : 0;
  }
  return -1;
}

function validOrderedLabel(key, value) {
  if (!usable(value)) return false;
  const text = normalizedLabel(key, value);
  if (key === 'captured') return dateOf(text) != null;
  if (key === 'year' || key === 'decade') return numberOf(text.replace(/s$/i, '')) != null;
  if (key === 'complexity' || key === 'repetition') return qualitativeRank(key, text) >= 0;
  if (key === 'compression') return qualitativeRank(key, text) >= 0 || numberOf(text.replace(/%$/, '')) != null;
  return numberOf(text) != null;
}

function scalarOf(key, value) {
  const text = normalizedLabel(key, value);
  if (key === 'captured') return dateOf(text);
  if (key === 'year' || key === 'decade') return numberOf(text.replace(/s$/i, ''));
  if (key === 'complexity' || key === 'repetition') return qualitativeRank(key, text);
  if (key === 'compression') {
    const n = numberOf(text.replace(/%$/, ''));
    if (n != null) return n <= 1 ? n * 100 : n;
    return qualitativeRank(key, text);
  }
  return numberOf(text);
}

function orderedValue(key, labels) {
  const values = labels.map(value => normalizedLabel(key, value)).filter(value => validOrderedLabel(key, value));
  if (!values.length) return null;
  if (key === 'captured') {
    const dated = values.map(value => ({ value, n: dateOf(value) })).filter(item => item.n != null);
    return dated.length ? dated.reduce((a, b) => a.n <= b.n ? a : b).value : null;
  }
  if (key === 'year' || key === 'decade') {
    const numeric = values.map(value => ({ value, n: numberOf(value.replace(/s$/i, '')) })).filter(item => item.n != null);
    return numeric.length ? numeric.reduce((a, b) => a.n <= b.n ? a : b).value : null;
  }
  if (ORDERED_KEYS.has(key)) {
    const ranked = values.map(value => ({ value, n: qualitativeRank(key, value) })).filter(item => item.n >= 0);
    if (ranked.length) return ranked.reduce((a, b) => a.n <= b.n ? a : b).value;
  }
  const numeric = values.map(value => ({ value, n: numberOf(value) })).filter(item => item.n != null);
  return numeric.length ? numeric.reduce((a, b) => a.n <= b.n ? a : b).value : values.slice().sort()[0];
}

function isOrdered(clips, key, labels) {
  if (ORDERED_KEYS.has(key)) return true;
  if (!labels.length) return false;
  // Numeric properties are ordered even when their values arrived as strings.
  return clips.flatMap(clip => labelsOf(clip, key)).every(value => numberOf(value) != null);
}

function compareOrdered(key, a, b) {
  if (key === 'captured') return (dateOf(a) ?? Infinity) - (dateOf(b) ?? Infinity);
  if (key === 'year' || key === 'decade') return (numberOf(a.replace(/s$/i, '')) ?? Infinity) - (numberOf(b.replace(/s$/i, '')) ?? Infinity);
  const ar = qualitativeRank(key, a), br = qualitativeRank(key, b);
  if (ar >= 0 || br >= 0) return (ar < 0 ? Infinity : ar) - (br < 0 ? Infinity : br);
  const an = numberOf(a), bn = numberOf(b);
  if (an != null || bn != null) return (an ?? Infinity) - (bn ?? Infinity);
  return String(a).localeCompare(String(b));
}

function hash(text) {
  let h = 2166136261;
  for (const char of String(text)) {
    h ^= char.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function categoryColor(label, key) {
  if (key === 'color' && FAMILY_COLORS[String(label).trim().toLowerCase()]) {
    return FAMILY_COLORS[String(label).trim().toLowerCase()];
  }
  return CATEGORY_COLORS[hash(label) % CATEGORY_COLORS.length];
}

function hex(color) {
  const value = color.replace('#', '');
  return [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16));
}

function colorHex(parts) {
  return `#${parts.map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
}

function mix(a, b, t) {
  const aa = hex(a), bb = hex(b);
  return colorHex(aa.map((value, i) => value + (bb[i] - value) * t));
}

function gradientColor(rank) {
  if (rank <= 0.5) return mix(LOW, MID, rank * 2);
  return mix(MID, HIGH, (rank - 0.5) * 2);
}

function multiRule(key, ordered) {
  if (!ordered) return 'All category values are shown; colors repeat for large vocabularies.';
  return key === 'captured' ? 'Minimum value; for dates this is the earliest date.' : 'Minimum value across multiple values.';
}

function colorRank(model, value, index = -1) {
  if (model.min != null && model.max != null) {
    const scalar = scalarOf(model.key, value);
    if (scalar != null) {
      return model.max === model.min ? 0.5 : Math.max(0, Math.min(1, (scalar - model.min) / (model.max - model.min)));
    }
  }
  return index < 0 ? null : model.domain.length < 2 ? 0.5 : index / (model.domain.length - 1);
}

/** Build a serializable model and legend for one attribute over a scope. */
export function attributeModel(clips = [], key, label = key) {
  const list = Array.isArray(clips) ? clips : [];
  const allLabels = [...new Set(list.flatMap(clip => labelsOf(clip, key)).filter(value =>
    !ORDERED_KEYS.has(key) || validOrderedLabel(key, value)))];
  const ordered = isOrdered(list, key, allLabels);
  const representatives = ordered ? [...new Set(list.map(clip => orderedValue(key, labelsOf(clip, key))).filter(value => value != null && validOrderedLabel(key, value)))] : allLabels;
  const domain = ordered
    ? representatives.sort((a, b) => compareOrdered(key, a, b))
    : allLabels.slice().sort((a, b) => a.localeCompare(b));
  const continuous = ordered && domain.length > 0 && (key === 'captured' || key === 'year' || key === 'decade' ||
    !ORDERED_KEYS.has(key));
  const scalars = continuous ? domain.map(value => scalarOf(key, value)).filter(value => value != null) : [];
  const min = scalars.length ? Math.min(...scalars) : null;
  const max = scalars.length ? Math.max(...scalars) : null;
  const stops = domain.map((value, i) => ({
    label: value,
    color: ordered ? gradientColor(colorRank({ key, domain, min, max }, value, i)) : categoryColor(value, key),
  }));
  const multi = list.some(clip => labelsOf(clip, key).length > 1);
  const model = { key, label, kind: ordered ? 'ordered' : 'categorical', domain, stops, missing: missingLegend() };
  // The legend uses the same piecewise interpolation as every tile, even
  // when observed values are unevenly spaced or omit the midpoint.
  if (ordered) model.gradient = domain.length === 1
    ? [{ color: MID, rank: 0 }, { color: MID, rank: 1 }]
    : [{ color: LOW, rank: 0 }, { color: MID, rank: 0.5 }, { color: HIGH, rank: 1 }];
  if (min != null && max != null) { model.min = min; model.max = max; }
  if (multi) model.multiValueRule = multiRule(key, ordered);
  return model;
}

/** Mark a clip according to a model. The result contains no mutable clip data. */
export function attributeMark(clip = {}, model) {
  if (!model || typeof model !== 'object') throw new TypeError('attributeMark requires an attribute model');
  const labels = labelsOf(clip, model.key);
  if (!labels.length) return {
    color: model.missing?.color || MISSING_COLOR,
    colors: [], valueLabel: model.missing?.label || 'Missing', missing: true, rank: null,
  };
  if (model.kind === 'categorical') {
    const colors = labels.map(value => categoryColor(value, model.key));
    return { color: colors[0], colors, valueLabel: labels.join(' · '), missing: false, rank: null };
  }
  const value = orderedValue(model.key, labels);
  if (value == null) return {
    color: model.missing?.color || MISSING_COLOR,
    colors: [], valueLabel: model.missing?.label || 'Missing', missing: true, rank: null,
  };
  const index = model.domain.indexOf(value);
  const rank = index < 0 ? null : colorRank(model, value, index);
  if (rank == null) return {
    color: model.missing?.color || MISSING_COLOR,
    colors: [], valueLabel: value, missing: true, rank: null,
  };
  const color = gradientColor(rank);
  return { color, colors: [color], valueLabel: value, missing: false, rank };
}

function sortValue(clip, model) {
  const labels = labelsOf(clip, model.key);
  if (!labels.length) return { missing: true, value: null };
  if (model.kind === 'ordered') {
    const value = orderedValue(model.key, labels);
    return { missing: value == null, value };
  }
  return { missing: false, value: labels.slice().sort((a, b) => a.localeCompare(b))[0] };
}

function tieValue(clip) {
  return String(clip?.url || clip?.id || '');
}

/** Sort a copy of clips by an attribute; membership and input order are untouched. */
export function sortClips(clips = [], options = {}, model) {
  const input = Array.isArray(clips) ? clips : [];
  const key = options?.key || 'none';
  if (key === 'none') return input.slice();
  const direction = options?.direction === 'desc' ? -1 : 1;
  const activeModel = model || attributeModel(input, key, key);
  return input.map((clip, index) => ({ clip, index, sort: sortValue(clip, activeModel) }))
    .sort((a, b) => {
      if (a.sort.missing !== b.sort.missing) return a.sort.missing ? 1 : -1;
      if (!a.sort.missing && activeModel.kind === 'ordered') {
        const compared = compareOrdered(activeModel.key, a.sort.value, b.sort.value);
        if (compared) return direction * compared;
      } else if (!a.sort.missing) {
        const compared = String(a.sort.value).localeCompare(String(b.sort.value));
        if (compared) return direction * compared;
      }
      return tieValue(a.clip).localeCompare(tieValue(b.clip)) || a.index - b.index;
    }).map(item => item.clip);
}

export { valuesOf };
