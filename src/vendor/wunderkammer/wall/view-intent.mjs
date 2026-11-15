import { validateView, MAX_LIT } from './view-schema.mjs';
import { ARRANGEMENTS, DEFAULT_ARRANGEMENT, AXES, isAxisName, isFront, SPHERE_FACINGS, MAX_CAP } from './float-space.mjs';

// A readable live intent projects into the same ViewSpec as an exact permalink.
// It does not evaluate collection membership or carry frozen corpus revisions.
const SINGLE = new Set(['view', 'q', 'group', 'sort', 'direction', 'lens', 'travel', 'spread', 'arrange', 'focus', 'rail', 'frame', 'front', 'facing', 'cap', ...AXES]);
/** `lit` repeats, one item identity each: an identity is a URL and may hold a comma. */
const recognized = key => SINGLE.has(key) || key === 'lit' || key.startsWith('facet.') || key.startsWith('highlight.');
/** Camera framings a live link may ask for; the wall applies one after restoring the view. */
export const FRAMES = Object.freeze(['evidence']);
const invalid = message => { throw new Error(`Invalid targeted view: ${message}`); };
const field = value => {
  if (!value || value.length > 128 || ['__proto__', 'prototype', 'constructor'].includes(value)) invalid('invalid attribute name');
  return value;
};
const bounded = value => {
  if (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1) invalid('travel and spread must be between 0 and 1');
  return Number(value);
};
/**
 * `view=warehouse` opens the aisle with the image warehouse played over it
 * once (aisle-view.mjs, playWarehouse). It is an arrival, not a view: the
 * ViewSpec says aisle, so the exact link written after it, a reload and Back
 * open the aisle without replaying it. A saved view in the fragment wins.
 */
export function isWarehouseIntent(url) {
  const u = new URL(url), hash = new URLSearchParams(u.hash.slice(1));
  return !hash.has('s') && !hash.has('ref') && u.searchParams.get('view') === 'warehouse';
}
export function stripViewIntent(url) {
  const result = new URL(url);
  for (const key of [...result.searchParams.keys()]) if (recognized(key)) result.searchParams.delete(key);
  return result;
}
export function applyViewIntent(url, defaultView) {
  const u = new URL(url), hash = new URLSearchParams(u.hash.slice(1));
  // The saved view is authoritative even if its fragment is malformed: let the
  // permalink reader report that failure, never silently replace it with intent.
  if (hash.has('s') || hash.has('ref')) return null;
  const entries = [...u.searchParams].filter(([key]) => recognized(key));
  if (!entries.length) return null;
  if (entries.length > 1000 || entries.some(([key, value]) => key.length > 160 || value.length > 20000)) invalid('link is too large');
  if (!defaultView) invalid('the wall is not measurable yet');
  const view = structuredClone(validateView(defaultView)), p = u.searchParams;
  for (const key of SINGLE) if (p.getAll(key).length > 1) invalid(`${key} may appear only once`);
  if (p.has('view')) {
    const mode = p.get('view');
    if (!['flat', '3d', 'aisle', 'float', 'warehouse'].includes(mode)) invalid('unknown view');
    view.presentation.mode = mode === 'warehouse' ? 'aisle' : mode;
  }
  if (p.has('q')) view.scope.query = p.get('q');
  if (p.has('group')) view.presentation.group = field(p.get('group'));
  const facets = new Map();
  for (const [key, value] of entries) if (key.startsWith('facet.')) {
    const name = field(key.slice(6));
    if (!value) invalid('facet values must not be empty');
    if (!facets.has(name)) facets.set(name, new Set());
    facets.get(name).add(value);
  }
  if (facets.size) view.scope.facets = [...facets].map(([key, values]) => [key, [...values].sort()]).sort(([a], [b]) => a.localeCompare(b));
  if (p.has('sort') || p.has('direction')) {
    const key = p.has('sort') ? field(p.get('sort')) : view.presentation.sort?.key || 'none';
    const direction = p.has('direction') ? p.get('direction') : view.presentation.sort?.direction || 'asc';
    if (!['asc', 'desc'].includes(direction)) invalid('direction must be asc or desc');
    view.presentation.sort = { key, direction };
  }
  if (p.has('lens')) {
    view.ui.lens = p.get('lens') === 'none' ? null : field(p.get('lens'));
    if (view.ui.highlight?.key !== view.ui.lens) delete view.ui.highlight;
  }
  const highlights = entries.filter(([key]) => key.startsWith('highlight.'));
  if (highlights.length > 1) invalid('only one highlighted value is supported');
  if (highlights.length) {
    const [key, value] = highlights[0];
    if (!value) invalid('highlight must name a value');
    const name = field(key.slice(10));
    if (p.has('lens') && view.ui.lens !== name) invalid('highlight must use the selected lens');
    view.ui.lens = name; view.ui.highlight = { key: name, value };
  }
  if (p.has('focus')) view.ui.focus = p.get('focus') || null;
  if (p.has('lit')) {
    const lit = [...new Set(p.getAll('lit'))];
    if (lit.some(key => !key)) invalid('lit must name an item');
    if (lit.length > MAX_LIT) invalid(`lit may name at most ${MAX_LIT} items`);
    view.ui.lit = lit;
  }
  if (p.has('frame') && !FRAMES.includes(p.get('frame'))) invalid(`frame must be one of ${FRAMES.join(', ')}`);
  if (p.has('rail')) {
    if (!['0', '1'].includes(p.get('rail'))) invalid('rail must be 0 or 1');
    view.ui.rail = p.get('rail') === '1';
  }
  if (view.presentation.mode === 'aisle' || p.has('travel') || p.has('spread')) {
    view.aisle ??= { version: 1, travel: 0, spread: .65, position: [0, 4, 4], target: [0, 4, -6], fitted: true, selection: null };
    for (const key of ['travel', 'spread']) if (p.has(key)) { view.aisle[key] = bounded(p.get(key)); view.aisle.fitted = true; }
  }
  const axisParams = AXES.filter(axis => p.has(axis));
  const sphereParams = ['facing', 'cap'].filter(key => p.has(key));
  if (view.presentation.mode === 'float' || p.has('arrange') || axisParams.length || p.has('front') || sphereParams.length) {
    // A live link names the arrangement; the camera is the receiver's Fit.
    view.float ??= { version: 1, arrangement: DEFAULT_ARRANGEMENT, position: [0, 0, 4000], target: [0, 0, 0], fitted: true, selection: null };
    if (p.has('arrange')) {
      if (!ARRANGEMENTS.includes(p.get('arrange'))) invalid(`arrange must be one of ${ARRANGEMENTS.join(', ')}`);
      view.float.arrangement = p.get('arrange'); view.float.fitted = true;
    }
    // across, up and depth name Axes dimensions; any left out take the
    // collection's defaults, so they imply arrange=axes and no other.
    if (axisParams.length) {
      if (p.has('arrange') && p.get('arrange') !== 'axes') invalid('across, up and depth apply only to arrange=axes');
      const axes = {};
      for (const axis of axisParams) { if (!isAxisName(p.get(axis))) invalid(`${axis} must name a dimension`); axes[axis] = p.get(axis); }
      if (new Set(Object.values(axes)).size !== axisParams.length) invalid('across, up and depth must name different dimensions');
      view.float.axes = axes; view.float.arrangement = 'axes'; view.float.fitted = true;
    }
    // front orders a cloud, so it implies arrange=cloud and no other.
    if (p.has('front')) {
      if (p.has('arrange') && p.get('arrange') !== 'cloud' || axisParams.length) invalid('front applies only to arrange=cloud');
      if (!isFront(p.get('front'))) invalid('front must name a dimension, with - first for lowest first');
      view.float.front = p.get('front'); view.float.arrangement = 'cloud'; view.float.fitted = true;
    }
    // facing and cap shape the sphere, so they imply arrange=sphere and no other.
    if (sphereParams.length) {
      if (p.has('arrange') && p.get('arrange') !== 'sphere' || axisParams.length || p.has('front')) invalid('facing and cap apply only to arrange=sphere');
      const sphere = {};
      if (p.has('facing')) { if (!SPHERE_FACINGS.includes(p.get('facing'))) invalid(`facing must be one of ${SPHERE_FACINGS.join(', ')}`); sphere.facing = p.get('facing'); }
      if (p.has('cap')) {
        if (!/^\d{1,3}$/.test(p.get('cap')) || Number(p.get('cap')) > MAX_CAP) invalid(`cap must be whole degrees from 0 to ${MAX_CAP}`);
        sphere.cap = Number(p.get('cap'));
      }
      view.float.sphere = sphere; view.float.arrangement = 'sphere'; view.float.fitted = true;
    }
  }
  if (view.presentation.mode === '3d' && !view.spatial) view.spatial = {
    mode: 'mountain', arrangement: { version: 1, piles: [] }, spread: -1,
    position: [0, 4, 4], target: [0, 4, -6], fitted: true, aspect: view.flat.aspect, selection: null,
  };
  return validateView(view);
}

/** A compact, live collection link. Exact cameras and frozen member selections
 * belong to Copy view's permalink; rejecting branches prevents scope widening. */
export function targetedViewURL(view, base) {
  validateView(view);
  if (view.scope.branches !== null) throw new Error('This view contains a frozen selection. Use Copy view to preserve its exact members.');
  const u = stripViewIntent(base); u.hash = '';
  const p = u.searchParams;
  p.set('view', view.presentation.mode);
  p.set('group', field(view.presentation.group));
  if (view.scope.query) p.set('q', view.scope.query);
  for (const [key, values] of view.scope.facets) for (const value of values) {
    field(key); if (!value) invalid('facet values must not be empty'); p.append(`facet.${key}`, value);
  }
  if (view.presentation.sort?.key && view.presentation.sort.key !== 'none') {
    p.set('sort', view.presentation.sort.key); p.set('direction', view.presentation.sort.direction);
  }
  if (view.ui.lens) p.set('lens', view.ui.lens);
  if (view.ui.highlight) p.set(`highlight.${view.ui.highlight.key}`, view.ui.highlight.value);
  if (view.ui.focus) p.set('focus', view.ui.focus);
  for (const key of view.ui.lit || []) p.append('lit', key);
  if (!view.ui.rail) p.set('rail', '0');
  if (view.presentation.mode === 'aisle') {
    p.set('travel', String(view.aisle.travel)); p.set('spread', String(view.aisle.spread));
  }
  if (view.presentation.mode === 'float') p.set('arrange', view.float.arrangement);
  if (view.presentation.mode === 'float' && view.float.arrangement === 'axes') for (const axis of AXES) if (view.float.axes?.[axis]) p.set(axis, view.float.axes[axis]);
  if (view.presentation.mode === 'float' && view.float.arrangement === 'cloud' && view.float.front) p.set('front', view.float.front);
  if (view.presentation.mode === 'float' && view.float.arrangement === 'sphere' && view.float.sphere) {
    if (view.float.sphere.facing) p.set('facing', view.float.sphere.facing);
    if (view.float.sphere.cap !== undefined) p.set('cap', String(view.float.sphere.cap));
  }
  return u;
}
