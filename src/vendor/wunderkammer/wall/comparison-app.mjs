import { defaultComparison, validateComparison, buildComparison, selectEvidence, comparisonEvidence } from './comparison-model.mjs';
import { clipKey, valuesOf, filterScope } from './context-clusters.mjs';
import { validateComparisonView, comparisonURL, comparisonFromURL } from './comparison-view.mjs';
import { validateObservations, resolveObservation, observationEvidence, observationPacket, OBSERVATIONS_FORMAT } from './observations.mjs';
import { canonical } from './permalink.mjs';
import { collectionSource, loadCollection, notifyEmbedder, FROM_PARENT } from './collection-source.mjs';
import { setProxyAvailable } from './media-policy.mjs';
import { spriteCovers } from './sprite-covers.mjs';
import { comparisonCopy, startingPoints } from './comparison-copy.mjs';

const $ = id => document.getElementById(id);
const COLORS = ['#90e4f4','#ffda9c','#cbb7ff','#aaffaa','#ffb8d0','#d7e7ff'];
const EMPTY = {value:null,cohort:null};
const PAGE = 12;
// A collection document (?collection=, or a parent posting one) replaces the
// wunderkammer server: no /api/clips and no proxy. Without it, this route reads
// the instance as before.
const collection = collectionSource();
if (collection) setProxyAvailable(false);
let payload, state, model, scene, evidence = [], page = 0, restoring = false, preview = null, searchTimer;
// The collection's own nouns, a music library's, or neutral ones (comparison-copy.mjs).
let wording = comparisonCopy();
const el = (tag, text, cls) => { const node = document.createElement(tag); if(text !== undefined) node.textContent = text; if(cls) node.className = cls; return node; };
const labelFor = key => payload?.ui?.facetLabels?.[key] || ({decade:'Release decade',genre:'Genre',color:'Artwork color',source:'Source',complexity:'Visual detail',year:'Tagged year'}[key]) || key;
const fmt = (cell,metric=state.spec.metric) => metric === 'count' ? String(cell.count) : model.cohorts.find(c=>c.key===cell.cohort)?.count ? `${(cell.share*100).toFixed(1)}%` : '—';
const number = n => n.toLocaleString();
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
function announce(message) { $('announcement').textContent = message; }
function safeMedia(src) {
  if(typeof src!=='string'||!src.trim())return null;
  try { const u = new URL(src,location.href);
    // A collection's media were checked by validateCollection() and are the
    // author's to choose; an instance's remote media stay behind its proxy.
    if(collection)return u.protocol==='data:' ? (/^data:image\//i.test(src)?src:null) : ['http:','https:','blob:'].includes(u.protocol) ? u.href : null;
    return u.origin === location.origin && ['http:','https:'].includes(u.protocol) ? u.href : null; } catch { return null; }
}
/** Comparison links rebuild the query from state; the collection rides along. */
function withCollection(url){if(collection)url.searchParams.set('collection',collection);return url;}
function availableFields() {
  const fields = new Set(['source','kind','tags']);
  for(const clip of payload.clips) for(const key of Object.keys(clip.props || {})) fields.add(key);
  return [...fields].filter(key => !['dims','corpus'].includes(key)).sort((a,b)=>labelFor(a).localeCompare(labelFor(b)));
}
function choices(key) {
  const counts = new Map();
  const scoped = filterScope(payload.clips,{query:state.spec.scope.query,active:new Map(Object.entries(state.spec.scope.facets).map(([k,v])=>[k,new Set(v)])),branches:null});
  const seen = new Set();
  for(const clip of scoped) { const id=clipKey(clip); if(seen.has(id))continue;seen.add(id); const values=[...new Set(valuesOf(clip,key).filter(v=>v.trim()))];
    for(const value of values.length ? values : ['(Unknown)']) counts.set(value,(counts.get(value)||0)+1);
  }
  for(const g of state.spec.groups) if(key===state.spec.groupBy && !counts.has(g)) counts.set(g,0);
  return [...counts].sort((a,b) => ['decade','year','captured'].includes(key) ? a[0].localeCompare(b[0],undefined,{numeric:true}) : b[1]-a[1] || a[0].localeCompare(b[0]));
}
function persist(replace=false) {
  if(restoring)return;
  try { const url = withCollection(comparisonURL(state,location.href));
    if(url.href!==location.href) history[replace?'replaceState':'pushState']({},'',url);
  } catch(error) {notice(error.message);}
}
function changeSpec(patch,replace=false) {
  try { const next=validateComparison({...state.spec,...patch});buildComparison(payload.clips,next);
    const changesMembership=['groups','scope','groupBy','measure','version'].some(key=>key in patch);
    state.spec=next;
    if(changesMembership){state.selection={...EMPTY};state.focus=null;state.camera=null;state.presentation.slice=null;page=0;}
    render();persist(replace); }
  catch(error){renderControls();notice(error.message);}
}
function select(selection) {
  const same=state.selection.value===(selection.value??null) && state.selection.cohort===(selection.cohort??null) && (state.selection.observation??null)===(selection.observation??null);
  state.selection=same ? {...EMPTY} : {...EMPTY,...selection};
  state.focus=null; page=0;preview=null;renderSelection();renderEvidence();persist();
  announce($('evidence-summary').textContent);
}
function setPreview(selection) {
  preview=selection;
  scene?.setPreview(selection||EMPTY);
  for(const row of $('comparison-matrix').querySelectorAll('tbody tr')) row.classList.toggle('preview',!!selection && row.dataset.value===selection.value);
}
function renderControls() {
  $('question').textContent=state.spec.question;
  const corpusName=payload.ui?.title || 'Wunderkammer collection';
  $('coverage').textContent=`${corpusName} · ${number(payload.clips.length)} indexed items · ${number(model.uniqueCount)} in these groups${model.overlapCount?` · ${number(model.overlapCount)} in more than one group`:''}`;
  $('compare-search').value=state.spec.scope.query;
  for(const [id,value] of [['group-by',state.spec.groupBy],['measure',state.spec.measure]]) {
    const field=$ (id); field.replaceChildren();
    for(const key of [...new Set([...availableFields(),value])]) {const option=el('option',labelFor(key));option.value=key;field.append(option);}field.value=value;
  }
  $('metric').value=state.spec.metric;$('category-sort').value=state.spec.sort;
  if(![...$('category-limit').options].some(o=>Number(o.value)===state.spec.categoryLimit))$('category-limit').append(el('option',String(state.spec.categoryLimit)));
  $('category-limit').value=state.spec.categoryLimit;
  const options=$('group-options');options.replaceChildren();
  const allOptions=choices(state.spec.groupBy), visibleOptions=allOptions.slice(0,48);
  for(const option of allOptions)if(state.spec.groups.includes(option[0])&&!visibleOptions.some(([v])=>v===option[0]))visibleOptions.push(option);
  for(const [value,count] of visibleOptions) {
    const index=state.spec.groups.indexOf(value),button=el('button',undefined,'group-option');button.type='button';button.dataset.group=value;
    button.setAttribute('aria-pressed',String(index>=0));
    if(index>=0){const dot=el('i',undefined,'swatch');dot.style.background=COLORS[index];dot.setAttribute('aria-hidden','true');button.append(dot);}
    button.append(el('span',value),el('small',number(count)));
    button.addEventListener('click',()=>{const groups=state.spec.groups.includes(value)?state.spec.groups.filter(g=>g!==value):[...state.spec.groups,value];
      if(groups.length<2){notice('Keep at least two groups in the comparison.');return;}
      if(groups.length>6){notice('Compare up to six groups at once. Remove one before adding another.');return;}
      changeSpec({groups});});options.append(button);
  }
  $('depth-slice').replaceChildren(new Option('All groups',''),...model.cohorts.map(c=>new Option(c.label,c.key)));
  $('depth-slice').value=state.presentation.slice || '';$('depth-spread').value=Math.round(state.presentation.spread*100);
  for(const b of document.querySelectorAll('[data-view]'))b.setAttribute('aria-pressed',String(b.dataset.view===state.presentation.view));
  renderPresentation();
}
function renderPresentation() {
  const walls=state.presentation.view==='walls', changed=document.body.dataset.gallery!==String(walls);
  document.body.dataset.gallery=String(walls);
  if(changed)$('scope-panel').open=!walls;
  $('scene-title').textContent=walls?wording.walls:'Aligned in depth';
  $('scene-summary').textContent=walls?wording.wallsSummary(model.cohorts.reduce((n,c)=>n+c.count,0),model.cohorts.length):`${model.cohorts.length} planes · ${model.rows.length} categories`;
  $('walk-control').hidden=!walls;
  const travel=state.presentation.travel||0;
  $('aisle-travel').value=Math.round(travel*100);
  $('aisle-position').textContent=travel?`${Math.round(travel*100)}%`:'Entrance';
  $('scene-help').textContent=walls?wording.wallsHelp:'Drag to orbit · scroll or pinch to zoom · select a column to inspect its items. Arrow keys orbit; Home fits. Artwork strips are samples; exact items appear below.';
  for(const b of document.querySelectorAll('[data-view]'))b.setAttribute('aria-pressed',String(b.dataset.view===state.presentation.view));
}
function renderMatrix() {
  $('distribution-title').textContent=`${labelFor(state.spec.measure)} by ${labelFor(state.spec.groupBy).toLowerCase()}`;
  const table=el('table',undefined,'comparison-matrix'),head=el('thead'),hr=el('tr');
  hr.append(el('th',labelFor(state.spec.measure)));
  model.cohorts.forEach((c,i)=>{const th=el('th'),dot=el('i',undefined,'cohort-key');dot.style.background=COLORS[i];dot.setAttribute('aria-hidden','true');th.append(dot,document.createTextNode(` ${c.label}`),el('small',`n=${number(c.count)}`));hr.append(th);});
  const delta=el('th','Δ');delta.append(el('small','last − first'));delta.title=`${model.cohorts.at(-1)?.label} minus ${model.cohorts[0]?.label}`;hr.append(delta);head.append(hr);table.append(head);
  const body=el('tbody');
  for(const row of model.rows) {
    const tr=el('tr');tr.dataset.value=row.value;const title=el('td'),button=el('button',row.value,'category-button');button.type='button';button.dataset.category=row.value;button.setAttribute('aria-label',`Inspect ${row.value} across all groups`);
    button.addEventListener('click',()=>select({value:row.value,cohort:null}));title.append(button);tr.append(title);
    row.cells.forEach((cell,i)=>{const td=el('td'),b=el('button',undefined,'cell-button');b.type='button';b.dataset.value=row.value;b.dataset.cohort=model.cohorts[i].key;
      b.setAttribute('aria-label',`${row.value}, ${model.cohorts[i].label}: ${cell.count} of ${model.cohorts[i].count} items, ${model.cohorts[i].count?`${(cell.share*100).toFixed(1)}%`:'share unavailable'}`);
      b.style.setProperty('--cohort-color',COLORS[i]);b.style.setProperty('--share',`${Math.max(0,Math.min(100,cell.share*100))}%`);
      b.append(el('i'),el('span',fmt(cell)));b.addEventListener('click',()=>select({value:row.value,cohort:model.cohorts[i].key}));
      const p={value:row.value,cohort:model.cohorts[i].key};b.addEventListener('pointerenter',()=>setPreview(p));b.addEventListener('pointerleave',()=>setPreview(null));b.addEventListener('focus',()=>setPreview(p));b.addEventListener('blur',()=>setPreview(null));td.append(b);tr.append(td);});
    const a=row.cells[0],b=row.cells.at(-1),difference=state.spec.metric==='share'?(b.share-a.share)*100:b.count-a.count;
    const unavailable=state.spec.metric==='share'&&(!model.cohorts[0].count||!model.cohorts.at(-1).count);
    tr.append(el('td',unavailable?'—':`${difference>0?'+':''}${state.spec.metric==='share'?difference.toFixed(1):difference}${state.spec.metric==='share'?' pp':''}`,'difference'));body.append(tr);
  }
  table.append(body);$('comparison-matrix').replaceChildren(table);
  if(!model.rows.length)$('comparison-matrix').append(el('p','No matching items. Clear the search or edit the recipe scope.','policy'));
  $('counting-policy').textContent=state.spec.metric==='share'?'Share = items with this tag ÷ items in that group. Tags may overlap; shares need not total 100%.':'Counts are unique items per group and category. The same item can carry several tags.';
  if(model.retainedCategory)$('counting-policy').textContent+=` Selected category “${model.retainedCategory}” is retained at the top.`;
  const notes=$('data-notes');notes.replaceChildren();
  const messages=[`Showing ${model.rows.length} of ${model.categoryCount ?? model.rows.length} categories. Δ compares ${model.cohorts.at(-1)?.label} with ${model.cohorts[0]?.label}.`,
    `Scope: ${model.scopedCount} unique indexed items. Selected groups: ${model.uniqueCount} unique items. ${model.overlapCount} belong to multiple groups.`,
    `Missing ${labelFor(state.spec.groupBy)}: ${model.missingGroupCount}. Missing ${labelFor(state.spec.measure)} in selected groups: ${model.missingValueCount}.`,
    ...model.warnings];
  if(payload.clips.some(c=>c.kind==='album'))messages.push('Music Atlas covers albums with usable artwork; it is not the complete music library. Decades come from release-year tags, not listening or acquisition dates. Conflicting years and genres remain multi-valued.');
  messages.push(`Current corpus ${payload.corpus.id} · revision ${payload.corpus.revision.slice(0,16)}`);
  if(corpusMismatch())messages.push(`Requested corpus ${state.spec.corpus.id} · revision ${state.spec.corpus.revision}. Results were recomputed from the current index.`);
  for(const message of messages)notes.append(el('p',message));
}
function renderSelection() {
  if(model.retainedCategory && state.selection.value!==model.retainedCategory){render();return;}
  const cited=selectedObservation();
  scene?.setSelection(cited?{observation:cited.id,cells:cited.figures.map(({value,cohort})=>({value,cohort})),places:cited.places,items:cited.items}:state.selection);scene?.setPreview(EMPTY);
  for(const b of $('comparison-matrix').querySelectorAll('[data-category]'))b.setAttribute('aria-pressed',String(!cited && state.selection.value===b.dataset.category && state.selection.cohort===null));
  for(const b of $('comparison-matrix').querySelectorAll('.cell-button'))b.setAttribute('aria-pressed',String(cited ? cited.figures.some(f=>f.value===b.dataset.value&&f.cohort===b.dataset.cohort)
    : (state.selection.value!==null||state.selection.cohort!==null) && (!state.selection.value||state.selection.value===b.dataset.value) && (!state.selection.cohort || state.selection.cohort===b.dataset.cohort)));
  for(const b of $('observation-list').querySelectorAll('.observation-select'))b.setAttribute('aria-pressed',String(b.dataset.id===state.selection.observation));
  $('clear-selection').disabled=state.selection.value===null && state.selection.cohort===null && !state.selection.observation;
}
/** Observations apply only to the comparison they were written for. */
function observationsStale(){return !!state.observations && canonical(state.observations.comparison)!==canonical(state.spec);}
function resolvedObservations(){return state.observations && !observationsStale() ? state.observations.observations.map(o=>resolveObservation(model,o)) : [];}
function selectedObservation(){return state.selection.observation ? resolvedObservations().find(o=>o.id===state.selection.observation) || null : null;}
const figureText=f=>`${f.value} · ${f.cohort}: ${number(f.count)} of ${number(f.denominator)}${f.share===null?' · share unavailable':` · ${(f.share*100).toFixed(1)}%`}`;
function renderObservations() {
  const panel=$('observations'),list=$('observation-list');
  panel.hidden=!state.observations;list.replaceChildren();
  if(!state.observations)return;
  const stale=observationsStale();
  $('observations-stale').hidden=!stale;
  $('observations-stale-text').textContent=stale?`These observations were written for “${state.observations.comparison.question}”. The comparison has changed since, so their figures are not shown.`:'';
  const resolved=stale?state.observations.observations.map(o=>({id:o.id,text:o.text,figures:[],unresolved:[],keys:[]})):resolvedObservations();
  for(const o of resolved) {
    const li=el('li',undefined,'observation');li.dataset.id=o.id;
    // Authored text is third-party content: textContent only, never markup.
    const text=document.createElement('p');text.className='observation-text';text.textContent=o.text;li.append(text);
    if(!stale){
      const figures=el('ul',undefined,'observation-figures');
      for(const f of o.figures)figures.append(el('li',figureText(f)));
      for(const message of o.unresolved){const item=el('li',`Not found: ${message}`,'unresolved');figures.append(item);}
      li.append(figures);
      const button=el('button',o.keys.length?`Show the ${number(o.keys.length)} cited item${o.keys.length===1?'':'s'}`:'No cited items found','observation-select');
      button.type='button';button.dataset.id=o.id;button.disabled=!o.keys.length;button.setAttribute('aria-pressed',String(state.selection.observation===o.id));
      button.addEventListener('click',()=>select({observation:o.id}));li.append(button);
    }
    list.append(li);
  }
}
function renderEvidence() {
  const cited=selectedObservation();
  evidence=cited?observationEvidence(model,cited):selectEvidence(model,state.selection);
  page=Math.max(0,Math.min(page,Math.max(0,Math.ceil(evidence.length/PAGE)-1)));
  const context=cited ? `Cited by observation ${cited.id}` : state.selection.value ? `${state.selection.value}${state.selection.cohort?` · ${state.selection.cohort}`:' · all groups'}` : state.selection.cohort || 'All selected groups';
  $('evidence-title').textContent=cited?'Items cited by the observation':state.selection.value?`Inspect ${state.selection.value}`:'Items behind the comparison';
  $('evidence-summary').textContent=`${context} · ${number(evidence.length)} unique items`;
  $('evidence-page').textContent=evidence.length?`${page*PAGE+1}–${Math.min((page+1)*PAGE,evidence.length)} / ${number(evidence.length)}`:'0 items';
  $('previous-items').disabled=page===0;$('next-items').disabled=(page+1)*PAGE>=evidence.length;$('copy-evidence').disabled=!evidence.length;
  const host=$('evidence-items');host.replaceChildren();
  for(const clip of evidence.slice(page*PAGE,(page+1)*PAGE)) {
    const b=el('button',undefined,'evidence-item');b.type='button';b.dataset.key=clipKey(clip);b.setAttribute('aria-label',`Inspect ${clip.title}`);
    // A cover kept as sprite-sheet cells is cropped at the thumbnail's size.
    const sprite=spriteCovers.has(clip),src=safeMedia(clip.cover || clip.media?.[0]?.src);
    if(src||sprite){const img=el('img');img.alt='';img.loading='lazy';img.addEventListener('error',()=>img.replaceWith(el('span','Artwork unavailable','no-art')),{once:true});b.append(img);
      if(sprite)void spriteCovers.coverUrl(clip,192,src).then(url=>{if(url)img.src=url;else img.replaceWith(el('span','Artwork unavailable','no-art'));});else img.src=src;}
    else b.append(el('span','No local artwork','no-art'));
    b.append(el('span',clip.title,'item-name'),el('span',valuesOf(clip,state.spec.groupBy).join(' · '),'item-group'));b.addEventListener('click',()=>openItem(clipKey(clip)));host.append(b);
  }
  if(!evidence.length)host.append(el('p','No items in this selection. Clear selection or widen the search.','evidence-empty'));
}
function openItem(key,save=true) {
  const clip=model.clipsByKey.get(key);if(!clip){notice('This item is unavailable in the current corpus.');return;}
  state.focus=key;$('item-title').textContent=clip.title;const host=$('item-content');host.replaceChildren();
  const sprite=!clip.detailCover&&spriteCovers.has(clip),src=safeMedia(clip.detailCover || clip.cover || clip.media?.[0]?.src);
  if(sprite){const image=el('img');image.alt=clip.title;host.append(image);void spriteCovers.coverUrl(clip,Infinity,src).then(url=>{if(url&&image.isConnected)image.src=url;});}
  else if(src){const image=el('img');image.src=src;image.alt=clip.title;host.append(image);}
  const text=el('div');text.append(el('pre',clip.note || Object.entries(clip.props||{}).map(([k,v])=>`${labelFor(k)}: ${Array.isArray(v)?v.join(', '):v}`).join('\n')));
  if(src){const link=el('a','Open artwork');link.href=src;link.target='_blank';link.rel='noopener';text.append(el('p'),link);}host.append(text);
  if(!$('item-dialog').open)$('item-dialog').showModal();if(save)persist();
}
function render() {
  const camera=state.camera;
  model=buildComparison(payload.clips,state.spec);
  // A URL can select a long-tail value. Keep its comparison visible as well as
  // its evidence, even when the ordinary category budget would omit it.
  if(state.selection.value && !model.rows.some(row=>row.value===state.selection.value)){
    const selected=model.allRows.find(row=>row.value===state.selection.value);
    if(selected){model.rows=[selected,...model.rows.slice(0,Math.max(0,state.spec.categoryLimit-1))];model.retainedCategory=selected.value;}
  }
  const mismatch=state.spec.corpus.id!==payload.corpus.id || state.spec.corpus.revision!==payload.corpus.revision;
  notice(mismatch?'This recipe names a different corpus or revision. These are current-index results; historical membership is not reproduced.':'');
  if(state.selection.observation && !resolvedObservations().some(o=>o.id===state.selection.observation))state.selection={...EMPTY};
  renderControls();renderMatrix();renderObservations();scene?.setModel(model);scene?.setPresentation({...state.presentation,metric:state.spec.metric});
  if(camera)scene?.setCamera?.(camera);
  renderSelection();renderEvidence();
}
function corpusMismatch(){return state.spec.corpus.id!==payload.corpus.id||state.spec.corpus.revision!==payload.corpus.revision;}
function evidencePacket(){const cited=selectedObservation();const packet=cited?observationPacket(model,cited):comparisonEvidence(model,state.selection);
  packet.requestedCorpus={...state.spec.corpus};packet.corpus={...payload.corpus};
  packet.comparison={...packet.comparison,corpus:{...payload.corpus}};
  if(corpusMismatch())packet.warnings.push('Recomputed from the current corpus; requested corpus/revision differs and historical membership is not reproduced.');
  return packet;
}
function setPresentation(patch,replace=false) {
  state.presentation={...state.presentation,...patch};state.camera=null;
  scene?.setPresentation({...state.presentation,metric:state.spec.metric});
  renderPresentation();
  persist(replace);
}
/** The aisle was walked by sideways scroll, and the scene has already moved.
 * Travel is written as the Walk aisle slider writes it; the camera is written
 * only when it is not the fitted pose for that travel. */
function walked(travel,camera) {
  if(restoring)return;
  state.presentation={...state.presentation,travel};state.camera=camera;
  renderPresentation();persist(true);
}
async function copy(text,button) {
  try{await navigator.clipboard.writeText(text);const old=button.textContent;button.textContent='Copied';announce('Copied');setTimeout(()=>{button.textContent=old;},1500);}
  catch {notice('Clipboard access was unavailable. Open Comparison recipe to select and copy the JSON, or use Download recipe.');}
}
/** Starting points are offered only for the attributes they name; with none, the control is hidden. */
function renderStartingPoints() {
  const points=startingPoints(payload.clips);
  $('preset').replaceChildren(...points.map(point=>new Option(point.label,point.id)));
  $('preset-control').hidden=!points.length;
}
function applyPreset(name) {
  const point=startingPoints(payload.clips).find(p=>p.id===name);
  if(point)changeSpec(point.apply(defaultComparison(payload.clips,payload.corpus)));
}
/** Wording that depends on the collection, not on the comparison. */
function renderCopy() {
  wording=comparisonCopy(payload);
  document.querySelector('[data-view="walls"]').textContent=wording.walls;
  $('compare-search').placeholder=wording.search;
  renderStartingPoints();
}
function bind() {
  $('preset').addEventListener('change',e=>applyPreset(e.target.value));
  $('compare-search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>changeSpec({scope:{...state.spec.scope,query:$('compare-search').value}},true),220);});
  $('group-by').addEventListener('change',e=>{const groupBy=e.target.value;changeSpec({groupBy,groups:choices(groupBy).slice(0,4).map(([v])=>v),question:`How does ${labelFor(state.spec.measure).toLowerCase()} vary across ${labelFor(groupBy).toLowerCase()} groups?`});});
  $('measure').addEventListener('change',e=>changeSpec({measure:e.target.value,question:`How does ${labelFor(e.target.value).toLowerCase()} vary across ${labelFor(state.spec.groupBy).toLowerCase()} groups?`}));
  $('metric').addEventListener('change',e=>changeSpec({metric:e.target.value}));
  $('category-sort').addEventListener('change',e=>changeSpec({sort:e.target.value}));
  $('category-limit').addEventListener('change',e=>changeSpec({categoryLimit:Number(e.target.value)}));
  $('aisle-travel').addEventListener('input',e=>setPresentation({travel:Number(e.target.value)/100},true));
  $('depth-spread').addEventListener('input',e=>setPresentation({spread:Number(e.target.value)/100},true));
  $('depth-slice').addEventListener('change',e=>setPresentation({slice:e.target.value || null}));
  for(const b of document.querySelectorAll('[data-view]'))b.addEventListener('click',()=>setPresentation({view:b.dataset.view}));
  $('reset-camera').addEventListener('click',()=>{state.camera=null;scene?.reset();persist();});
  $('clear-selection').addEventListener('click',()=>{state.selection={...EMPTY};page=0;renderSelection();renderEvidence();persist();});
  $('previous-items').addEventListener('click',()=>{page--;renderEvidence();});$('next-items').addEventListener('click',()=>{page++;renderEvidence();});
  $('recipe-open').addEventListener('click',()=>{$('recipe-text').value=JSON.stringify(state.observations&&!observationsStale()?{format:OBSERVATIONS_FORMAT,version:1,comparison:state.spec,observations:state.observations.observations}:state.spec,null,2);$('recipe-error').textContent='';
    const url=withCollection(comparisonURL(state,location.href));for(const key of ['corpus','revision','camera','focus','question','compare'])url.searchParams.delete(key);
    $('live-url').value=url.href;$('recipe-dialog').showModal();});
  $('copy-live-url').addEventListener('click',()=>copy($('live-url').value,$('copy-live-url')));
  $('apply-recipe').addEventListener('click',()=>{try{const parsed=JSON.parse($('recipe-text').value);
    if(parsed?.format===OBSERVATIONS_FORMAT){const envelope=validateObservations(parsed);buildComparison(payload.clips,envelope.comparison);state.observations={comparison:envelope.comparison,observations:envelope.observations};changeSpec(envelope.comparison);}
    else{const next=validateComparison(parsed);buildComparison(payload.clips,next);changeSpec(next);}
    $('recipe-dialog').close();}catch(error){$('recipe-error').textContent=error.message;}});
  $('observations-restore').addEventListener('click',()=>{if(state.observations)changeSpec(state.observations.comparison);});
  $('copy-recipe').addEventListener('click',()=>copy($('recipe-text').value,$('copy-recipe')));
  $('download-recipe').addEventListener('click',()=>{const blob=new Blob([$('recipe-text').value],{type:'application/json'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download='wunderkammer-comparison.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  $('copy-link').addEventListener('click',()=>{persist(true);copy(location.href,$('copy-link'));});
  $('copy-evidence').addEventListener('click',()=>copy(JSON.stringify(evidencePacket(),null,2),$('copy-evidence')));
  $('item-dialog').addEventListener('close',()=>{if(state.focus){state.focus=null;persist();}});
  window.addEventListener('popstate',()=>restoreURL());
  window.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('item-dialog').open&&!$('recipe-dialog').open && (state.selection.value!==null||state.selection.cohort!==null)){state.selection={...EMPTY};page=0;renderSelection();renderEvidence();persist();}});
}
function defaultView(){return {v:1,spec:defaultComparison(payload.clips,payload.corpus),presentation:{view:'walls',spread:.65,slice:null},selection:{...EMPTY},focus:null,camera:null};}
function readURL() {return comparisonFromURL(location.href,defaultView());}
function restoreURL() {
  try {const next=readURL();if(!next)return;restoring=true;state=next;page=0;render();
    if(state.camera)scene?.setCamera?.(state.camera);
    if(state.focus)openItem(state.focus,false);else if($('item-dialog').open)$('item-dialog').close();
  }catch(error){notice(error.message);}finally{restoring=false;}
}
async function boot() {
  if(collection){const loaded=await loadCollection(collection);payload=loaded.data;for(const warning of loaded.warnings)console.warn(`[wunderkammer] collection: ${warning}`);
    if(collection!==FROM_PARENT){const wall=new URL('../index.html',location.href);wall.searchParams.set('collection',new URL(collection,location.href).href);document.querySelector('.wordmark').href=wall.href;}}
  else{const response=await fetch('/api/clips');if(!response.ok)throw new Error(`Collection unavailable (HTTP ${response.status})`);payload=await response.json();}
  if(!Array.isArray(payload.clips)||!payload.corpus)throw new Error('The collection has no records or corpus identity.');
  spriteCovers.setCorpus(payload.sheets,payload.clips,{covers:payload.images?.sheets==='covers'});
  renderCopy();
  state=defaultView();
  let linkError='';try{state=readURL() || state;}catch(error){linkError=error.message;}
  // ?observations=<url>: an envelope written elsewhere, often by an LLM. Its
  // comparison replaces the one in the URL; a failure leaves the comparison usable.
  const observationsURL=new URLSearchParams(location.search).get('observations');
  let observationsError='';
  if(observationsURL){try{const response=await fetch(new URL(observationsURL,location.href));if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const envelope=validateObservations(await response.json());
      state={...state,spec:envelope.comparison,observations:{comparison:envelope.comparison,observations:envelope.observations},selection:{...EMPTY},focus:null,camera:null};
    }catch(error){observationsError=`Observations could not be loaded from ${observationsURL}: ${error.message}`;}}
  // A failed load keeps the address as it was, so a reload retries it.
  state=validateComparisonView(state);bind();render();if(!linkError&&!observationsError)persist(true);
  const problem=[linkError,observationsError].filter(Boolean).join('\n');if(problem)notice(problem);
  document.body.dataset.comparisonReady='true';
  notifyEmbedder({type:'wunderkammer:view-ready'});
  // The agent-readable state of this view: the exact evidence packet for the
  // current selection, an observation's computed figures included.
  window.wunderkammer=Object.freeze({export:()=>structuredClone(evidencePacket())});
  window.comparisonDebug=()=>({observations:resolvedObservations().map(({places,...o})=>o),observationsStale:observationsStale(),spec:structuredClone(state.spec),selection:{...state.selection},presentation:{...state.presentation},focus:state.focus,cohorts:model.cohorts,rows:model.rows,evidenceKeys:evidence.map(clipKey),evidencePacket:evidencePacket(),scene:scene?.getDiagnostics?.()||null});
  try {
    const {ComparisonScene}=await import('./comparison-scene.mjs');
    scene=new ComparisonScene($('comparison-stage'),{wording,onSelect:select,onInspect:openItem,onPreview:setPreview,onCameraChange:camera=>{if(!restoring){state.camera=camera;persist(true);}},onWalk:walked});
    scene.setModel(model);scene.setPresentation({...state.presentation,metric:state.spec.metric});scene.setSelection(state.selection);if(state.camera)scene.setCamera?.(state.camera);
    document.body.dataset.sceneReady='true';
  }catch(error){$('comparison-stage').replaceChildren(el('p',`Depth view unavailable: ${error.message}. The exact comparison and item inspection remain available below.`,'scene-loading'));}
  if(state.focus)openItem(state.focus,false);
}
boot().catch(error=>{notice(error.message);$('question').textContent='The collection could not be opened';
  $('coverage').textContent=collection?'Check the collection document and reload.':'Check the local instance and reload.';
  // Problem text goes only to a parent that posted the document (see wall.mjs).
  notifyEmbedder({type:'wunderkammer:error',message:collection===FROM_PARENT?String(error.message||error):'The collection could not be loaded; the page shows why.'});});
