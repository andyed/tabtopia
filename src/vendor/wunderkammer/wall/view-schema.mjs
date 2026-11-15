/** Portable view contract, shared by the browser and immutable snapshot endpoint. */
import { ARRANGEMENTS, validAxes, isFront, validSphere } from './float-space.mjs';
export const MAX_VIEW_BYTES = 4 * 1024 * 1024;
/** Most items one view may light by identity (`ui.lit`, `lit=` in a live link). */
export const MAX_LIT = 10000;
export function canonical(value) {
  return JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
}
export function validateView(v) {
  const fail = () => { throw new Error('Invalid or unsupported view link'); };
  const obj = x => x && typeof x === 'object' && !Array.isArray(x);
  const str = x => typeof x === 'string' && x.length <= 20000;
  const num = x => Number.isFinite(x) && Math.abs(x) <= 1e9;
  const vec = x => Array.isArray(x) && x.length === 3 && x.every(num);
  if (!obj(v) || v.v !== 1 || v.layoutVersion !== 1 || !obj(v.corpus) || !str(v.corpus.id) || !str(v.corpus.revision)
      || !obj(v.scope) || !str(v.scope.query) || !Array.isArray(v.scope.facets)
      || !v.scope.facets.every(f => Array.isArray(f) && f.length === 2 && str(f[0]) && Array.isArray(f[1]) && f[1].every(str))
      || !(v.scope.branches === null || Array.isArray(v.scope.branches) && v.scope.branches.every(b => obj(b) && str(b.label) && Array.isArray(b.keys) && b.keys.every(str)))
      || !obj(v.presentation) || !['flat', '3d', 'aisle', 'float'].includes(v.presentation.mode) || !str(v.presentation.group)
      || !['free', 'bounded', 'edge'].includes(v.presentation.pan)
      || !(v.presentation.sort === undefined || obj(v.presentation.sort) && str(v.presentation.sort.key) && ['asc', 'desc'].includes(v.presentation.sort.direction))
      || !obj(v.flat) || !obj(v.flat.view) || !['x', 'y', 'scale'].every(k => num(v.flat.view[k]))
      || v.flat.view.scale < .015 || v.flat.view.scale > 6 || typeof v.flat.view.fitted !== 'boolean'
      || !num(v.flat.aspect) || v.flat.aspect <= 0 || !obj(v.flat.stage) || !['w', 'h'].every(k => num(v.flat.stage[k]) && v.flat.stage[k] > 0)
      || !obj(v.ui) || typeof v.ui.rail !== 'boolean' || typeof v.ui.context !== 'boolean'
      || !(v.ui.lens === undefined || v.ui.lens === null || str(v.ui.lens))
      || !(v.ui.highlight === undefined || v.ui.highlight === null || obj(v.ui.highlight) && str(v.ui.highlight.key) && v.ui.highlight.key.length > 0 && str(v.ui.highlight.value) && v.ui.highlight.key === v.ui.lens)
      || !(v.ui.mediaSource === undefined || v.ui.mediaSource === null || str(v.ui.mediaSource))
      || !(v.ui.scopeBar === undefined || typeof v.ui.scopeBar === 'boolean')
      // Items lit by identity: the rest of the scope recedes (docs/SHOTS.md). Optional, so older links mean what they did.
      || !(v.ui.lit === undefined || Array.isArray(v.ui.lit) && v.ui.lit.length >= 1 && v.ui.lit.length <= MAX_LIT
        && v.ui.lit.every(k => str(k) && k.length > 0) && new Set(v.ui.lit).size === v.ui.lit.length)
      || !(v.ui.focus === null || str(v.ui.focus)) || !(v.ui.detailWidth === null || num(v.ui.detailWidth) && v.ui.detailWidth > 0 && v.ui.detailWidth <= 1)) fail();
  if (v.spatial !== null) {
    const s = v.spatial;
    if (!obj(s) || !['mountain', 'piles'].includes(s.mode) || !obj(s.arrangement) || s.arrangement.version !== 1
        || !Array.isArray(s.arrangement.piles) || !s.arrangement.piles.every(p => obj(p) && str(p.label) && num(p.u) && num(p.v)
          && Array.isArray(p.keys) && p.keys.every(str) && (p.w === undefined || num(p.w) && p.w > 0) && (p.h === undefined || num(p.h) && p.h > 0))
        || !Number.isInteger(s.spread) || s.spread < -1 || s.spread >= s.arrangement.piles.length
        || !vec(s.position) || !vec(s.target) || typeof s.fitted !== 'boolean'
        || !num(s.aspect) || s.aspect <= 0 || !(s.selection === null || str(s.selection))) fail();
  }
  if (v.aisle !== undefined && v.aisle !== null) {
    const a = v.aisle;
    if (!obj(a) || a.version !== 1 || !['travel', 'spread'].every(k => num(a[k]) && a[k] >= 0 && a[k] <= 1)
        || !vec(a.position) || !vec(a.target) || [...a.position, ...a.target].some(n => Math.abs(n) > 1e6)
        || Math.hypot(...a.position.map((n, i) => n - a.target[i])) < .1
        || Math.hypot(...a.position.map((n, i) => n - a.target[i])) > 1000
        || typeof a.fitted !== 'boolean' || !(a.selection === null || str(a.selection))) fail();
  }
  if (v.float !== undefined && v.float !== null) {
    const f = v.float, distance = vec(f.position) && vec(f.target) ? Math.hypot(...f.position.map((n, i) => n - f.target[i])) : NaN;
    if (!obj(f) || f.version !== 1 || !ARRANGEMENTS.includes(f.arrangement) || !(f.axes === undefined || validAxes(f.axes)) || !(f.front === undefined || isFront(f.front))
        || !(f.sphere === undefined || validSphere(f.sphere))
        || !vec(f.position) || !vec(f.target) || [...f.position, ...f.target].some(n => Math.abs(n) > 1e6)
        || !(distance >= .1 && distance <= 1e5)
        || typeof f.fitted !== 'boolean' || !(f.selection === null || str(f.selection))) fail();
  }
  if (v.presentation.mode === 'aisle' && !v.aisle) fail();
  if (v.presentation.mode === 'float' && !v.float) fail();
  if (v.presentation.mode === '3d' && !v.spatial) fail();
  if (new TextEncoder().encode(canonical(v)).length > MAX_VIEW_BYTES) throw new Error('View exceeds the 4 MiB limit');
  return v;
}
