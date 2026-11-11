/** Experimental comparison view. Independent namespace; never writes wall pile state. */
import { canonical } from './permalink.mjs';
import { validateComparison } from './comparison-model.mjs';
import { validateObservations, OBSERVATIONS_FORMAT } from './observations.mjs';

const LIMIT = 32768;
const toBase64url = text => { let binary = ''; for (const b of new TextEncoder().encode(text)) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''); };
const fromBase64url = encoded => new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(encoded.replaceAll('-','+').replaceAll('_','/')), c=>c.charCodeAt(0)));
/** Observations travel with the view, so a copied link keeps the claims it was showing. */
const observationsOf = value => value == null ? null : validateObservations({ format: OBSERVATIONS_FORMAT, version: 1, ...value });
export function validateComparisonView(input) {
  const fail = message => { throw new Error(`Invalid comparison view: ${message}`); };
  if (!input || input.v !== 1) fail('unsupported version');
  const spec = validateComparison(input.spec);
  const p = input.presentation;
  if (!p || !['walls','depth','front','terraces'].includes(p.view) || !Number.isFinite(p.spread) || p.spread < 0 || p.spread > 1
    || !(p.slice === null || typeof p.slice === 'string' && spec.groups.includes(p.slice))) fail('presentation');
  if (p.travel !== undefined && (!Number.isFinite(p.travel) || p.travel < 0 || p.travel > 1)) fail('aisle position');
  const s = input.selection;
  const text = x => x === null || typeof x === 'string' && x.length <= 2000;
  if (!s || !text(s.value) || !(s.cohort === null || spec.groups.includes(s.cohort)) || !text(input.focus)) fail('selection');
  let observations = null;
  try { observations = observationsOf(input.observations); } catch (error) { fail(error.message); }
  const observation = s.observation ?? null;
  if (observation !== null && !observations?.observations.some(o => o.id === observation)) fail('selected observation');
  const camera = input.camera ?? null;
  const vector = v => Array.isArray(v) && v.length === 3 && v.every(n => Number.isFinite(n) && Math.abs(n) <= 1e6);
  if (camera !== null && (!vector(camera.position) || !vector(camera.target))) fail('camera');
  if(camera!==null){const distance=Math.hypot(...camera.position.map((n,i)=>n-camera.target[i]));if(distance<.1||distance>1000)fail('camera distance');}
  const state = {v:1,spec,presentation:{view:p.view,spread:p.spread,slice:p.slice},selection:{value:s.value,cohort:s.cohort,...(observation!==null?{observation}:{})},focus:input.focus,camera};
  if (observations) state.observations = { comparison: observations.comparison, observations: observations.observations };
  if (p.travel !== undefined) state.presentation.travel = p.travel;
  if (canonical(state).length > LIMIT) fail('view is too large for an inline link; use a smaller recipe');
  return state;
}
export function encodeComparisonView(view) {
  return toBase64url(canonical(validateComparisonView(view)));
}
export function decodeComparisonView(encoded) {
  if (typeof encoded !== 'string' || encoded.length > LIMIT * 4 || !/^[\w-]+$/.test(encoded)) throw new Error('Invalid or oversized comparison link');
  return validateComparisonView(JSON.parse(fromBase64url(encoded)));
}

/** Readable parameters project the same validated view, with no second scope evaluator. */
export function comparisonURL(view, base) {
  const v=validateComparisonView(view),u=new URL(base),p=new URLSearchParams();
  p.set('compare','1');p.set('groupBy',v.spec.groupBy);
  for(const group of v.spec.groups)p.append('group',group);
  p.set('measure',v.spec.measure);p.set('metric',v.spec.metric);
  if(v.spec.scope.query)p.set('q',v.spec.scope.query);
  for(const [key,values] of Object.entries(v.spec.scope.facets))for(const value of values)p.append(`facet.${key}`,value);
  p.set('sort',v.spec.sort);p.set('limit',String(v.spec.categoryLimit));
  p.set('view',v.presentation.view);p.set('spread',String(v.presentation.spread));
  if(v.presentation.travel !== undefined)p.set('travel',String(v.presentation.travel));
  if(v.presentation.slice!==null)p.set('slice',v.presentation.slice);
  if(v.selection.value!==null)p.set('category',v.selection.value);
  if(v.selection.cohort!==null)p.set('within',v.selection.cohort);
  if(v.observations)p.set('obs',toBase64url(canonical(v.observations)));
  if(v.selection.observation)p.set('observation',v.selection.observation);
  if(v.focus!==null)p.set('focus',v.focus);
  if(v.camera)p.set('camera',[...v.camera.position,...v.camera.target].map(n=>Math.round(n*1e5)/1e5).join(','));
  p.set('question',v.spec.question);p.set('corpus',v.spec.corpus.id);p.set('revision',v.spec.corpus.revision);
  u.hash='';u.search=p.toString();
  if(u.href.length>LIMIT*4)throw new Error('Comparison URL is too large. Narrow the recipe before copying.');
  return u;
}
export function comparisonFromURL(base, defaults) {
  const u=new URL(base),p=u.searchParams,h=new URLSearchParams(u.hash.slice(1));
  if(u.href.length>LIMIT*4)throw new Error('Comparison URL is too large');
  let view=structuredClone(defaults);
  if(h.has('s')){if(h.get('compare')!=='1')throw new Error('Unsupported comparison link');view=decodeComparisonView(h.get('s'));}
  if(p.has('compare')&&p.get('compare')!=='1')throw new Error('Unsupported comparison URL version');
  const spec=view.spec;
  for(const [param,key] of [['groupBy','groupBy'],['measure','measure'],['metric','metric'],['sort','sort'],['question','question']])if(p.has(param))spec[key]=p.get(param);
  if(p.has('group'))spec.groups=p.getAll('group');
  if(p.has('q'))spec.scope.query=p.get('q');
  const facetKeys=[...new Set([...p.keys()].filter(k=>k.startsWith('facet.')))];
  if(facetKeys.length){spec.scope.facets={};for(const key of facetKeys){const name=key.slice(6);if(['__proto__','constructor','prototype'].includes(name))throw new Error('Unsupported facet field');Object.defineProperty(spec.scope.facets,name,{value:p.getAll(key),enumerable:true,configurable:true,writable:true});}}
  if(p.has('limit'))spec.categoryLimit=Number(p.get('limit'));
  if(p.has('corpus'))spec.corpus.id=p.get('corpus');if(p.has('revision'))spec.corpus.revision=p.get('revision');
  if(p.has('view'))view.presentation.view=p.get('view');if(p.has('spread'))view.presentation.spread=Number(p.get('spread'));
  if(p.has('travel')){if(!p.get('travel').trim())throw new Error('Aisle position requires a number');view.presentation.travel=Number(p.get('travel'));}
  if(p.has('slice'))view.presentation.slice=p.get('slice');
  if(p.has('category'))view.selection.value=p.get('category');if(p.has('within'))view.selection.cohort=p.get('within');
  if(p.has('obs')){const raw=p.get('obs');if(!/^[\w-]+$/.test(raw))throw new Error('Observations in this link are not readable');
    let parsed;try{parsed=JSON.parse(fromBase64url(raw));}catch{throw new Error('Observations in this link are not readable');}view.observations=parsed;}
  if(p.has('observation'))view.selection.observation=p.get('observation');
  if(p.has('focus'))view.focus=p.get('focus');
  if(p.has('camera')){const parts=p.get('camera').split(',');if(parts.length!==6||parts.some(v=>!v.trim()))throw new Error('Camera requires six finite coordinates');const nums=parts.map(Number);view.camera={position:nums.slice(0,3),target:nums.slice(3)};}
  if(!p.has('question')&&(p.has('groupBy')||p.has('measure')))spec.question=`How does ${spec.measure} vary across ${spec.groupBy} groups?`;
  return validateComparisonView(view);
}
