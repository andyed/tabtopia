/**
 * Contextual facet counts derived from the canonical scope evaluator.
 *
 * `available` removes only the facet being described. It is not a prediction of
 * an OR-toggle result. Query, other facets and the frozen union remain in force.
 * `inView` means current scope membership, never camera visibility.
 */
import { filterScope, matchesFacet, valuesOf } from './context-clusters.mjs';

const add = (bucket, value) => bucket.set(value, (bucket.get(value) || 0) + 1);
const popularity = (a, b) => b.total - a.total || a.value.localeCompare(b.value);
function displayOrder(key, a, b) {
  return key === 'captured' || key === 'year' ? b.value.localeCompare(a.value)
    : key === 'publication_period' ? a.value.localeCompare(b.value)
      : popularity(a, b);
}

/**
 * One record contributes at most once to a value, including overlapping dates.
 * Generating the bounded normalized date prefixes avoids scanning every value
 * for every clip, and exactly follows matchesFacet's startsWith predicate.
 */
function memberships(clip, key) {
  const values = new Set(valuesOf(clip, key));
  if (key !== 'captured') return { values, counted: values };
  const counted = new Set();
  for (const value of values) {
    for (let length = 0; length <= value.length; length++) counted.add(value.slice(0, length));
  }
  return { values, counted };
}

/**
 * Return Map<key, { key, scoped, total, inView, available, values }> with a `scoped`
 * boolean describing whether any scope constraint is active. Each values
 * row is { value, total, inView, available, active }.
 *
 * Caller supplies presentation `keys` to enforce hidden-facet policy. Hidden
 * active facets still constrain scope and availability. Catalog values are
 * retained, but catalog numbers are never used as count evidence. Observed and
 * restored active values missing from the catalog are included automatically.
 *
 * Counts require O(clips × requested/active facets) work plus value memberships,
 * not one corpus scan for each value. Captured normalization limits prefixes to
 * seven characters. Corpus clips and canonical scope are never mutated.
 */
export function buildFacetModel(clips, { query = '', active = new Map(), branches = null } = {}, options = {}) {
  const { catalog = {}, keys = [...new Set([...Object.keys(catalog), ...active.keys()])] } = options;
  const facetKeys = [...new Set(keys)];
  const scoped = Boolean(query.trim()) || [...active.values()].some(values => values.size > 0) || branches !== null;
  const model = new Map(facetKeys.map(key => [key, {
    key, scoped, total: clips.length, inView: 0, available: 0, values: [],
  }]));
  model.scoped = scoped;
  const buckets = new Map(facetKeys.map(key => [key, {
    domain: new Set([...Object.keys(catalog[key] || {}), ...(active.get(key) || [])]),
    total: new Map(), inView: new Map(), available: new Map(),
  }]));
  // filterScope owns the text and frozen-branch interpretation, including [].
  const queryAndBranch = new Set(filterScope(clips, { query, active: new Map(), branches }));
  const activeFacets = [...active].filter(([, values]) => values.size);
  let scopeCount = 0;
  for (const clip of clips) {
    const eligibleBase = queryAndBranch.has(clip);
    // With AND across facets, omitting a key helps only when it is the sole failure.
    // matchesFacet remains the sole owner of OR and captured-prefix predicates.
    const failed = eligibleBase ? activeFacets.filter(([key, values]) => !matchesFacet(clip, key, values)).map(([key]) => key) : null;
    const inView = eligibleBase && failed.length === 0;
    if (inView) scopeCount++;
    for (const key of facetKeys) {
      const bucket = buckets.get(key);
      const { values, counted } = memberships(clip, key);
      // Adapters use an empty string for absent dates/properties. Do not invent
      // a blank option; explicit catalog/restored values above stay reachable.
      for (const value of values) if (value !== '') bucket.domain.add(value);
      const available = eligibleBase && (failed.length === 0 || failed.length === 1 && failed[0] === key);
      if (available) model.get(key).available++;
      for (const value of counted) {
        add(bucket.total, value);
        if (inView) add(bucket.inView, value);
        if (available) add(bucket.available, value);
      }
    }
  }
  for (const [key, facet] of model) {
    const bucket = buckets.get(key), selected = active.get(key);
    facet.inView = scopeCount;
    facet.values = [...bucket.domain].map(value => ({
      value,
      total: bucket.total.get(value) || 0,
      inView: bucket.inView.get(value) || 0,
      available: bucket.available.get(value) || 0,
      active: selected?.has(value) || false,
    })).sort((a, b) => displayOrder(key, a, b));
  }
  return model;
}

/**
 * Search facet labels only; does not evaluate or alter the corpus query.
 * `limit` controls matching values before active values are retained. Increasing
 * it supports a progressive “show more” without changing ordering. Selected
 * values stay reachable even outside the search result or initial 24 values.
 */
export function selectFacetValues(facet, { search = '', limit = 24 } = {}) {
  const terms = String(search).trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = facet.values.filter(row => terms.every(term => row.value.toLowerCase().includes(term)));
  const matchingValues = new Set(matching.map(row => row.value));
  const count = limit === Infinity ? matching.length : Math.max(0, Math.floor(Number.isFinite(limit) ? limit : 24));
  const visible = new Set(matching.slice().sort(popularity).slice(0, count).map(row => row.value));
  for (const row of facet.values) if (row.active) visible.add(row.value);
  return {
    values: facet.values.filter(row => visible.has(row.value)),
    matchingCount: matching.length,
    hiddenCount: matching.filter(row => !visible.has(row.value)).length,
    totalCount: facet.values.length,
    retainedActiveCount: facet.values.filter(row => row.active && !matchingValues.has(row.value)).length,
  };
}
