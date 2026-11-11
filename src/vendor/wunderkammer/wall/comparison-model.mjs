/** Question-sized comparisons over the canonical scope and URL identity. No source writes. */
import { clipKey, filterScope, valuesOf } from './context-clusters.mjs';

export const UNKNOWN = '(Unknown)';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const fail = message => { throw new TypeError(`Comparison: ${message}`); };
function object(value, path, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${path} must be an object`);
  for (const key of Object.keys(value)) {
    if (forbidden.has(key) || fields && !fields.includes(key)) fail(`${path}.${key} is not supported`);
  }
  return value;
}
function string(value, path, { max = 240, empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    fail(`${path} must be ${empty ? 'a' : 'a non-empty'} string of at most ${max} characters`);
  }
  return value;
}
function field(value, path) {
  string(value, path, { max: 80 });
  if (forbidden.has(value)) fail(`${path} is not a supported attribute`);
  return value;
}
function strings(value, path, max) {
  if (!Array.isArray(value) || value.length > max) fail(`${path} must be an array of at most ${max} strings`);
  return [...new Set(value.map((item, index) => string(item, `${path}[${index}]`)))];
}

/** Strict portable v1 recipe; the host checks corpus identity/revision before applying. */
export function validateComparison(input) {
  object(input, 'spec', ['version', 'question', 'corpus', 'scope', 'groupBy', 'groups', 'measure', 'metric', 'categoryLimit', 'sort']);
  if (input.version !== 1) fail('version must be 1');
  object(input.corpus, 'corpus', ['id', 'revision']);
  object(input.scope, 'scope', ['query', 'facets']);
  object(input.scope.facets, 'scope.facets');
  if (Object.keys(input.scope.facets).length > 32) fail('scope.facets supports at most 32 attributes');
  const facets = {};
  for (const [key, values] of Object.entries(input.scope.facets)) {
    facets[field(key, 'facet key')] = strings(values, `scope.facets.${key}`, 100);
  }
  const groups = strings(input.groups, 'groups', 6);
  if (groups.length < 2 || groups.length !== input.groups.length) fail('groups must contain 2–6 distinct values');
  if (!['share', 'count'].includes(input.metric)) fail('metric must be share or count');
  if (!['difference', 'total', 'name'].includes(input.sort)) fail('sort must be difference, total, or name');
  if (!Number.isInteger(input.categoryLimit) || input.categoryLimit < 4 || input.categoryLimit > 20) fail('categoryLimit must be an integer from 4 to 20');
  return {
    version: 1, question: string(input.question, 'question', { max: 1000, empty: true }),
    corpus: { id: string(input.corpus.id, 'corpus.id'), revision: string(input.corpus.revision, 'corpus.revision') },
    scope: { query: string(input.scope.query, 'scope.query', { max: 1000, empty: true }), facets },
    groupBy: field(input.groupBy, 'groupBy'), groups,
    measure: field(input.measure, 'measure'), metric: input.metric,
    categoryLimit: input.categoryLimit, sort: input.sort,
  };
}

const distinctValues = (clip, key) => [...new Set(valuesOf(clip, key).filter(value => value.trim()))];
function identities(clips) {
  if (!Array.isArray(clips)) fail('clips must be an array');
  const map = new Map();
  let invalid = 0, duplicates = 0;
  for (const clip of clips) {
    if (!clip || typeof clip !== 'object' || !(clip.url || clip.id)) { invalid++; continue; }
    const key = clipKey(clip);
    if (map.has(key)) { duplicates++; continue; }
    map.set(key, clip);
  }
  return { map, invalid, duplicates };
}
function frequencies(clips, key) {
  const counts = new Map();
  for (const clip of clips) for (const value of distinctValues(clip, key)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Prefer the music question; otherwise choose observed dimensions with useful coverage. */
export function defaultComparison(clips, corpus) {
  const records = [...identities(clips).map.values()];
  const candidateKeys = [...new Set(['decade', 'source', 'kind', 'color', 'tags',
    ...records.flatMap(clip => Object.keys(clip.props || {}))])].filter(key => !forbidden.has(key));
  const groupBy = candidateKeys.find(key => frequencies(records, key).length >= 2) || 'decade';
  const available = frequencies(records, groupBy);
  const preferred = ['1970s', '1980s', '1990s', '2000s'].filter(value => available.some(([key]) => key === value));
  let groups = groupBy === 'decade' && preferred.length >= 2 ? preferred : available.slice(0, 4).map(([value]) => value);
  if (groupBy === 'decade') groups.sort((a, b) => a.localeCompare(b));
  // Explicitly empty comparison cohorts keep a tiny/empty corpus inspectable.
  if (groups.length < 2 && !groups.includes(UNKNOWN)) groups.push(UNKNOWN);
  if (groups.length < 2) groups.push('(No matching items)');
  const measure = ['genre', 'color', 'tags', 'kind', 'source', ...candidateKeys]
    .find(key => key !== groupBy && frequencies(records, key).length) || 'genre';
  return validateComparison({ version: 1,
    question: groupBy === 'decade' && measure === 'genre' ? 'How does genre distribution change across release decades?' : `How does ${measure} differ across ${groupBy}?`,
    corpus, scope: { query: '', facets: {} }, groupBy, groups, measure,
    metric: 'share', categoryLimit: 8, sort: 'difference' });
}

/** Shares are fractions [0, 1]; delta is signed last cohort minus first. */
export function buildComparison(clips, input) {
  const spec = validateComparison(input);
  const { map: clipsByKey, invalid, duplicates } = identities(clips);
  const scoped = filterScope([...clipsByKey.values()], {
    query: spec.scope.query,
    active: new Map(Object.entries(spec.scope.facets).map(([key, values]) => [key, new Set(values)])),
    branches: null,
  });
  const cohorts = spec.groups.map(key => ({ key, label: key, keys: [], count: 0 }));
  const cohortMap = new Map(cohorts.map(cohort => [cohort.key, cohort]));
  const rows = new Map(), included = new Set();
  let overlapCount = 0, missingGroupCount = 0, missingValueCount = 0, multiValueCount = 0;
  for (const clip of scoped) {
    const key = clipKey(clip), groupValues = distinctValues(clip, spec.groupBy);
    if (!groupValues.length) missingGroupCount++;
    const matched = (groupValues.length ? groupValues : [UNKNOWN]).filter(value => cohortMap.has(value));
    if (!matched.length) continue;
    included.add(key);
    if (matched.length > 1) overlapCount++;
    const rawValues = distinctValues(clip, spec.measure);
    if (!rawValues.length) missingValueCount++;
    if (rawValues.length > 1) multiValueCount++;
    for (const group of matched) {
      const cohort = cohortMap.get(group);
      cohort.keys.push(key); cohort.count++;
    }
    for (const value of rawValues.length ? rawValues : [UNKNOWN]) {
      if (!rows.has(value)) rows.set(value, { value, keys: new Set(), cells: new Map(cohorts.map(cohort => [cohort.key, []])) });
      const row = rows.get(value); row.keys.add(key);
      for (const group of matched) row.cells.get(group).push(key);
    }
  }
  const allRows = [...rows.values()].map(row => {
    const cells = cohorts.map(cohort => {
      const keys = row.cells.get(cohort.key);
      return { cohort: cohort.key, key: cohort.key, count: keys.length, share: cohort.count ? keys.length / cohort.count : 0, keys };
    });
    const countDelta = cells.at(-1).count - cells[0].count;
    const shareDelta = cells.at(-1).share - cells[0].share;
    return { value: row.value, total: row.keys.size, cells, countDelta, shareDelta,
      delta: spec.metric === 'share' ? shareDelta : countDelta };
  });
  allRows.sort((a, b) => (spec.sort === 'difference' ? Math.abs(b.delta) - Math.abs(a.delta) :
    spec.sort === 'total' ? b.total - a.total : 0) || a.value.localeCompare(b.value));
  const warnings = [];
  if (duplicates) warnings.push(`${duplicates} duplicate record${duplicates === 1 ? '' : 's'} ignored by URL identity; the first record is retained.`);
  if (invalid) warnings.push(`${invalid} record${invalid === 1 ? '' : 's'} without stable identity excluded.`);
  if (overlapCount) warnings.push(`${overlapCount} item${overlapCount === 1 ? '' : 's'} belong to more than one comparison group; cohorts are not disjoint.`);
  if (multiValueCount) warnings.push('Measure values overlap: shares are tag incidence and can sum above 100%.');
  if (missingGroupCount) warnings.push(`${missingGroupCount} scoped item${missingGroupCount === 1 ? '' : 's'} have no ${spec.groupBy}; they appear only when ${UNKNOWN} is a selected group.`);
  if (missingValueCount) warnings.push(`${missingValueCount} compared item${missingValueCount === 1 ? '' : 's'} have no ${spec.measure}; shown as ${UNKNOWN}.`);
  for (const cohort of cohorts) if (!cohort.count) warnings.push(`${cohort.label} has no items; its share and any share difference against it are unavailable.`);
  return { spec, cohorts, rows: allRows.slice(0, spec.categoryLimit), allRows,
    clipsByKey, scopedCount: scoped.length, uniqueCount: included.size, overlapCount,
    missingGroupCount, missingValueCount, multiValueCount, categoryCount: allRows.length,
    omittedCategoryCount: Math.max(0, allRows.length - spec.categoryLimit), warnings };
}

/** Exact evidence union in original corpus order; never sampled or ranked by the renderer. */
export function selectEvidence(model, { value = null, cohort = null } = {}) {
  const groups = cohort === null ? model.cohorts : model.cohorts.filter(group => group.key === cohort);
  const row = value === null ? null : model.allRows.find(candidate => candidate.value === value);
  const keys = new Set(value === null ? groups.flatMap(group => group.keys) :
    row ? row.cells.filter(cell => groups.some(group => group.key === cell.cohort)).flatMap(cell => cell.keys) : []);
  return [...model.clipsByKey].filter(([key]) => keys.has(key)).map(([, clip]) => clip);
}

/** Portable evidence: exact denominator, identity and title, without source paths or full notes. */
export function comparisonEvidence(model, selection = {}) {
  const { value = null, cohort = null } = selection;
  const selected = selectEvidence(model, { value, cohort });
  const rows = value === null ? model.rows : model.allRows.filter(row => row.value === value);
  const denominators = new Map(model.cohorts.map(group => [group.key, group.count]));
  const shareDeltaAvailable = model.cohorts[0].count > 0 && model.cohorts.at(-1).count > 0;
  return {
    version: 1, question: model.spec.question, corpus: { ...model.spec.corpus },
    comparison: model.spec, selection: { value, cohort },
    countingPolicy: {
      identity: 'Unique URL (ID fallback); duplicate records retain the first occurrence.',
      denominator: 'Unique scoped identities in each cohort, including items missing the measured attribute.',
      numerator: 'Unique cohort identities carrying each value; repeated tags count once.',
      multiValue: 'An item can belong to several cohorts and several measure values; shares need not sum to one.',
      missing: `Absent or blank attributes use ${UNKNOWN}; literal unknown tags remain authored values.`,
      difference: 'Signed last cohort minus first cohort; share deltas are fractions, multiply by 100 for percentage points.',
      empty: 'Zero-denominator shares are unavailable and exported as null. Share deltas are null when either endpoint cohort is empty; count deltas remain defined.',
    },
    cohorts: model.cohorts.map(({ key, label, count }) => ({ key, label, denominator: count })),
    rows: rows.map(row => ({ value: row.value, total: row.total,
      delta: model.spec.metric === 'share' && !shareDeltaAvailable ? null : row.delta,
      cells: row.cells.map(cell => ({ cohort: cell.cohort, count: cell.count,
        share: denominators.get(cell.cohort) > 0 ? cell.share : null, keys: [...cell.keys] })) })),
    evidenceCount: selected.length,
    evidence: selected.map(clip => ({ key: clipKey(clip), title: String(clip.title || clipKey(clip)) })),
    coverage: { scopedCount: model.scopedCount, uniqueCount: model.uniqueCount,
      overlapCount: model.overlapCount, omittedCategoryCount: model.omittedCategoryCount },
    warnings: [...model.warnings],
  };
}
