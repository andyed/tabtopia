/**
 * The floating space: the whole corpus in 3D at positions that mean
 * something (float-space.mjs), drawn by the vendored muriel TileField.
 *
 * After meodai's 32,000 colour names (names.color.pizza), where a name floats
 * at its colour and the model switches between colour spaces. The corpus is
 * placed once per arrangement. Scope (search, facets) dims items in place and
 * never moves them, so the space keeps its shape while the question changes.
 *
 * Reaching an item never takes camera skill: click flies to it, the item
 * menu and [ ] keys fly through the scope, and Fit returns to the whole space.
 * Free flight (drag, wheel, keys) is for looking around.
 *
 * No innerHTML: titles and labels reach the DOM through textContent only.
 */
import * as THREE from '../three/build/three.module.js';
import { OrbitControls } from '../three/examples/jsm/controls/OrbitControls.js';
import { TileField } from './spatial/lib/instanced.js';
import { RETRY } from './spatial/lib/atlas.js';
import { sourceFor, proxied } from './spatial/spatial-view.mjs';
import { spriteCovers } from './sprite-covers.mjs';
import { clipKey } from './context-clusters.mjs';
import { perf } from './instrument.mjs';
import { parseFront, isFront, orderValues, isTimeKey } from './float-space.mjs';
import { ARRANGEMENTS, DEFAULT_ARRANGEMENT, isArrangement, arrange, AXES, AXIS_LABELS, axisDimensions, resolveAxes, validAxes, clipAttributeKeys, attributeAxis, nearestAlong, describeItem } from './float-space.mjs';
import { arrangeMenu, STACKS } from './arrange-menu.mjs';
import { NEUTRAL_NOUNS, counted } from './nouns.mjs';
import { Callout, JumpBox, announcer, titleMatches as matchTitles } from './keyboard-path.mjs';

/** Brightness of an item outside the scope. Dim, not gone: the space keeps its shape. */
export const FLOAT_DIM = 0.25;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
/** Words for "No more items …" when an arrow finds nothing that way. */
const EDGE_WORDS = { right: 'to the right', left: 'to the left', up: 'above', down: 'below', away: 'further away', toward: 'nearer' };
const vector = value => Array.isArray(value) && value.length === 3 && value.every(n => Number.isFinite(n) && Math.abs(n) <= 1e6);
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
/** Fit looks from the front, a little above and to the right, so all three
 * axes read. A–Z is a flat wall and is seen square on. Axes is seen more
 * nearly from the front: Across, usually time, then reads level and long, and
 * Depth recedes to the right along its own edge. */
const FIT_DIRECTION = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(70), THREE.MathUtils.degToRad(32));
const AXES_DIRECTION = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(74), THREE.MathUtils.degToRad(20));
const FRONT = new THREE.Vector3(0, 0, 1);
const fitDirection = arrangement => arrangement === 'az' || arrangement === 'cloud' ? FRONT : arrangement === 'axes' ? AXES_DIRECTION : FIT_DIRECTION;

/**
 * Dimming, patched into the vendored TileField fragment shader on this view's
 * material only (lib/ is a copy of muriel's and is not edited here). TileField
 * writes per-instance opacity as 1 or 0 and draws with the depth buffer, not
 * blending, so a fractional opacity would not show. Read it as brightness,
 * applied after each output line, to the colour the shader has already
 * encoded, so FLOAT_DIM is a share of displayed brightness. Take most of the
 * saturation with it: in a space arranged by colour, a dimmed tile must not
 * compete on colour.
 *
 * Both of the shader's outputs get the step, the sampled tile and the
 * emptyColor placeholder. Output encoding and the slot lookup used to be
 * patched here too; muriel fixed both upstream (99ea62b), so the anchors are
 * its encoded output lines and the encoding is upstream's, not ours.
 *
 * The patch fails loudly (dimMode 'hidden', a status line, failing tests) if
 * the source it expects is gone.
 */
const DIM = `
  {
    vec3 shown = gl_FragColor.rgb;
    if (vOpacity < 0.999) shown = mix(vec3(dot(shown, vec3(0.2126, 0.7152, 0.0722))), shown, 0.35);
    gl_FragColor = vec4(shown * vOpacity, 1.0);
  }`;
const FRAGMENT_PATCHES = [
  'gl_FragColor = linearToOutputTexel(vec4(c.rgb, c.a * vOpacity));',
  'gl_FragColor = linearToOutputTexel(vec4(emptyColor, 1.0));',
].map(output => [output, output + DIM]);
function patchFragment(material) {
  let source = material.fragmentShader;
  for (const [from, to] of FRAGMENT_PATCHES) { if (!source.includes(from)) return false; source = source.replace(from, to); }
  material.fragmentShader = source; material.needsUpdate = true;
  return true;
}

/**
 * Where a label's centre sits relative to its anchor, in pixels. A label with
 * a side sits beside its point, `gap` pixels away; `-start` and `-end` align
 * its left or right edge with the point instead of centring it.
 */
function labelOffset({ side, gap = 0, width = 0, height = 0 }) {
  if (!side) return [0, 0];
  const [edge, align] = side.split('-'), dx = align === 'start' ? width / 2 : align === 'end' ? -width / 2 : 0;
  if (edge === 'below') return [dx, gap + height / 2];
  if (edge === 'above') return [dx, -gap - height / 2];
  return [edge === 'left' ? -gap - width / 2 : gap + width / 2, 0];
}

/** Fetches in flight or queued, or canvas writes not yet on the GPU. Reads the
 * vendored atlas's private counters, as the 3D view's perf probe does. */
const atlasBusy = a => a._inflight > 0 || a._farQueue.length > 0 || a._nearQueue.length > 0 || a.far._dirty || a.near._dirty;

export class FloatView {
  constructor(host, callbacks = {}) {
    this.host = host; this.callbacks = callbacks; this.visible = true; this.built = false;
    this.arrangement = DEFAULT_ARRANGEMENT; this.fitted = true; this.selection = null; this.count = 0;
    // Axes: what was asked for (a link, a select) and what the collection
    // resolves it to. The request survives a corpus change; the resolution not.
    this.requestedAxes = {}; this.axes = null; this.dimensions = [];
    this.clips = []; this.keys = []; this.indexOf = new Map(); this.inScope = new Uint8Array(0); this.scopeCount = 0;
    // Items lit by identity (docs/SHOTS.md): null lights the whole scope.
    this.lit = null;
    // The cloud's order within each tier (front=): a dimension id, '-' first for lowest first.
    this.front = null; this.frontCache = null;
    this.layout = null; this.labels = []; this.listeners = []; this.frameTimes = []; this.renderCount = 0;
    this.host.classList.add('float-host'); this.host.replaceChildren();
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color('#050510');
    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 60000);
    // Guides draw first and under everything: the grey axis runs through the
    // neutral covers, and a line across a cover is a scratch on the evidence.
    this.guides = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x3d474a, depthTest: false, depthWrite: false }));
    this.guides.renderOrder = -1; this.scene.add(this.guides);
    this.ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-.5, -.5, 0), new THREE.Vector3(.5, -.5, 0), new THREE.Vector3(.5, .5, 0), new THREE.Vector3(-.5, .5, 0)]),
      new THREE.LineBasicMaterial({ color: 0xaaffaa, depthTest: false }));
    this.ring.renderOrder = 10; this.ring.visible = false; this.scene.add(this.ring);
    this.status = element('p', 'float-status'); this.status.setAttribute('role', 'status'); this.status.hidden = true;
    this.overlay = element('div', 'float-labels'); this.overlay.setAttribute('aria-hidden', 'true');
    this.toolbar = element('div', 'float-toolbar'); this.toolbar.setAttribute('role', 'group'); this.toolbar.setAttribute('aria-label', '3D space');
    // Stacks is offered only when the page can show them (callbacks.onStacks):
    // a different renderer draws them, so choosing it hands over rather than
    // moving these items.
    this.menu = arrangeMenu(callbacks.onStacks ? [...ARRANGEMENTS, STACKS] : ARRANGEMENTS, name => {
      if (name === STACKS) { this.syncRadios(); this.callbacks.onStacks(); return; }
      this.setArrangement(name); this.interact();
    });
    this.arrangeGroup = this.menu.node; this.arrangeGroup.classList.add('float-arrange'); this.radios = this.menu.radios;
    // Three dimension menus, shown while Axes is the arrangement.
    this.axesGroup = element('div', 'float-axes'); this.axesGroup.setAttribute('role', 'group'); this.axesGroup.setAttribute('aria-label', 'Axes');
    this.axisSelects = new Map();
    for (const axis of AXES) {
      const label = element('label'), select = element('select');
      select.setAttribute('aria-label', `${AXIS_LABELS[axis]} axis`);
      label.append(element('span', '', AXIS_LABELS[axis]), select); this.axesGroup.append(label); this.axisSelects.set(axis, select);
    }
    this.scopeNote = element('span', 'float-scope');
    this.toolbar.append(this.arrangeGroup, this.axesGroup, this.scopeNote);
    // The keyboard path to items is the space itself: arrows move the selection
    // along the arrangement's axes, / jumps to a title, Enter opens. A callout at
    // the selected item says where it sits in the arrangement's terms, and a
    // visually hidden live region says the same to a screen reader. Neither
    // takes room in the toolbar, so nothing moves when focus comes and goes.
    this.callout = new Callout('float-callout');
    this.announcer = announcer('float-announcer');
    this.jump = new JumpBox('float-jump', { matches: q => this.titleMatches(q), onPick: i => this.keyChoose(this.keys[i]),
      onClose: refocus => { if (refocus) this.canvas?.focus({ preventScroll: true }); }, listen: (node, type, fn) => this.listen(node, type, fn) });
    this.fallback = element('button', 'view-fallback', 'Show the flat wall'); this.fallback.type = 'button';
    this.help = element('p', 'float-help', 'Drag to orbit · Arrows move between items, Shift+arrows orbit · / jumps to a title · Enter opens · W A S D fly · Home fits');
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.canvas = this.renderer.domElement; this.canvas.className = 'float-canvas'; this.canvas.tabIndex = 0;
      this.canvas.setAttribute('role', 'img');
      this.canvas.setAttribute('aria-label', '3D space: every item placed by the arrangement below. Arrow keys move between items along its axes, Page Up and Page Down move in depth, slash jumps to a title, Enter opens the item; Shift with arrows orbits, W A S D fly, Home fits.');
      this.host.append(this.canvas);
      this.controls = new OrbitControls(this.camera, this.canvas);
      Object.assign(this.controls, { enableDamping: false, zoomToCursor: true, screenSpacePanning: true, rotateSpeed: .6, zoomSpeed: .8, minDistance: 8 });
      this.controls.addEventListener('change', () => { if (!this.programmatic) { this.tween = null; this.fitted = false; this.cancelHover(); this.interact(); } this.invalidate(); });
      this.listen(this.canvas, 'pointerdown', e => { this.cancelHover(); this.down = e.isPrimary ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null; if (this.keyboardSelection) { this.keyboardSelection = false; this.syncCallout(); } });
      this.listen(this.canvas, 'pointerup', e => {
        if (this.down?.id === e.pointerId && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 5) {
          const index = this.pick(e.clientX, e.clientY); if (index >= 0) this.open(this.keys[index], { fly: true });
        }
        this.down = null;
      });
      this.listen(this.canvas, 'pointermove', e => {
        if (e.buttons || e.pointerType === 'touch') return;
        const index = this.pick(e.clientX, e.clientY), key = index >= 0 ? this.keys[index] : null;
        this.canvas.style.cursor = key ? 'pointer' : 'grab';
        if (key !== this.hoverKey) {
          this.cancelHover();
          if (key) { this.hoverKey = key; this.invalidate(); if (this.callbacks.hoverEnabled?.() ?? true) this.callbacks.onHover?.(this.clips[index], e); }
        }
      });
      this.listen(this.canvas, 'pointerleave', () => { this.down = null; this.cancelHover(); });
      this.listen(this.canvas, 'pointercancel', () => { this.down = null; this.cancelHover(); });
      this.listen(this.canvas, 'keydown', e => this.keydown(e));
      this.listen(this.canvas, 'webglcontextlost', e => { e.preventDefault(); this.contextLost = true; this.host.dataset.graphicsState = 'lost'; this.updateStatus(); });
      this.listen(this.canvas, 'webglcontextrestored', () => { this.contextLost = false; this.host.dataset.graphicsState = 'ready'; this.updateStatus(); this.invalidate(); });
      this.host.dataset.graphicsState = 'ready';
    } catch (error) { this.contextLost = true; this.host.dataset.graphicsState = 'unavailable'; this.graphicsError = error.message; }
    this.host.append(this.overlay, this.callout.node, this.status, this.jump.node, this.toolbar, this.help, this.announcer);
    for (const [axis, select] of this.axisSelects) this.listen(select, 'change', () => { if (this.chooseAxis(axis, select.value)) this.interact(); });
    this.listen(this.fallback, 'click', () => this.callbacks.onFlatWall?.());
    this.syncRadios();
    // Debug handle, as in the 3D view (window.__cwSpatial): atlas failures and
    // GPU output are invisible from the DOM, so tests and probes reach them here.
    window.__cwFloat = this;
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(host); this.resize();
    this.updateStatus();
  }

  listen(node, name, fn) { node.addEventListener(name, fn); this.listeners.push([node, name, fn]); }
  interact() { if (!this.programmatic && !this.disposed) this.callbacks.onInteraction?.(); }

  /**
   * `corpus` is every item; `scope` the subset the wall's search and facets
   * selected. The field is built once per corpus: scope only dims.
   */
  setClips(corpus, scope = corpus, { nouns = NEUTRAL_NOUNS } = {}) {
    this.nouns = nouns;
    const keys = corpus.map(clipKey), identity = keys.join('\n');
    if (identity !== this.identity || !this.field) this.build(corpus, keys, identity);
    this.setScope(scope);
    this.built = true; this.updateStatus(); this.invalidate();
  }

  build(corpus, keys, identity) {
    this.identity = identity; this.clips = corpus.slice(); this.keys = keys; this.count = corpus.length;
    // Dimensions follow the corpus: the attributes it carries, offered in the wall's facet order.
    const attributeKeys = this.callbacks.axisKeys?.() ?? clipAttributeKeys(this.clips);
    this.dimensions = axisDimensions(this.clips, attributeKeys, this.callbacks.labelFor);
    this.indexOf = new Map(keys.map((key, i) => [key, i])); this.inScope = new Uint8Array(this.count).fill(1);
    this.field?.dispose(); this.field = null;
    if (!this.renderer) return;
    if (spriteCovers.available) { spriteCovers.warm(64); spriteCovers.warm(160); }
    const clips = this.clips;
    this.field = new TileField({
      scene: this.scene, count: Math.max(1, this.count), nearDistance: 1200, nearSlots: 64,
      resolve: (i, tier) => { const src = sourceFor(clips[i], tier === 'near' ? 256 : 64); return src ? proxied(src) : null; },
      // Sprite-sheet cells, as in the 3D view: a cell-only cover has no URL,
      // and RETRY waits for its page; a failed page falls back to the file.
      resolveSource: spriteCovers.available ? (i, tier) => {
        if (!spriteCovers.has(clips[i])) return null;
        const need = tier === 'near' ? 160 : 64;
        return spriteCovers.serves(clips[i], need) ? spriteCovers.source(clips[i], need) ?? RETRY : null;
      } : null,
    });
    this.field.count = this.count; this.field.mesh.count = this.count;
    this.field.setRenderer(this.renderer);
    this.dimMode = patchFragment(this.field.material) ? 'brightness' : 'hidden';
    this.resolveAxes();
    this.layout = arrange(this.clips, this.arrangement, this.arrangeOptions());
    const q = this.camera.quaternion, p = this.layout.positions, s = this.layout.sizes;
    for (let i = 0; i < this.count; i++) this.field.place(i, p[i * 3], p[i * 3 + 1], p[i * 3 + 2], s[i * 2], s[i * 2 + 1], q);
    this.field.layout(); this.applyLayoutDecor();
    this.selection = this.indexOf.has(this.selection) ? this.selection : null;
    if (this.fitted) this.fitView({ animate: false, quiet: true });
  }

  /** Dim what is outside the scope. Nothing moves; picking and stepping skip dimmed items. */
  setScope(scope) {
    const wanted = new Set(scope.map(clipKey));
    this.scopeCount = 0;
    for (let i = 0; i < this.count; i++) { const on = wanted.has(this.keys[i]) ? 1 : 0; this.inScope[i] = on; this.scopeCount += on; }
    this.applyOpacity();
    // The cloud's order is the scope's: it moves items when the scope changes, as no other arrangement does.
    if (this.arrangement === 'cloud' && this.field) this.relayout({ animate: false });
    if (!this.inScopeKey(this.selection)) this.selection = null;
    this.syncCallout();
    this.updateScopeNote();
    if (this.hoverKey && !this.inScopeKey(this.hoverKey)) this.cancelHover();
    this.updateStatus(); this.invalidate();
  }
  inScopeKey(key) { const i = this.indexOf.get(key); return i !== undefined && this.inScope[i] === 1; }
  /** Full brightness for what is in scope and lit; the rest dims in place. */
  applyOpacity() {
    if (!this.field) return;
    const opacity = this.field.aOpacity.array, dim = this.dimMode === 'brightness' ? FLOAT_DIM : 0;
    for (let i = 0; i < this.count; i++) opacity[i] = this.inScope[i] && (!this.lit || this.lit.has(this.keys[i])) ? 1 : dim;
    this.field.aOpacity.needsUpdate = true;
  }
  updateScopeNote() {
    const lit = this.lit ? this.keys.filter((key, i) => this.inScope[i] && this.lit.has(key)).length : null;
    this.scopeNote.textContent = (this.scopeCount === this.count ? `All ${counted(this.count, this.nouns ?? NEUTRAL_NOUNS)}` : `${this.scopeCount} of ${this.count} in scope · the rest are dimmed`)
      + (lit === null ? '' : ` · ${lit} lit`);
  }
  /**
   * Light only these items, by key; the rest of the scope dims as items outside
   * it do. Nothing moves. Null or an empty set lights the whole scope again.
   */
  setLit(keys) {
    this.lit = keys && keys.size ? new Set(keys) : null;
    this.applyOpacity(); this.updateScopeNote();
    if (this.arrangement === 'cloud' && this.field) this.relayout({ animate: false });
    this.invalidate();
  }

  /** Move every item to its place in another arrangement, animated by the field's own motion. */
  setArrangement(name, { animate = true } = {}) {
    if (!isArrangement(name)) return false;
    const changed = name !== this.arrangement;
    this.arrangement = name; this.syncRadios();
    if (!this.field || !changed) return true;
    this.relayout({ animate });
    return true;
  }
  /**
   * Put one dimension on one axis. A dimension already on another axis swaps
   * with this axis's current one, so the three axes always differ.
   */
  chooseAxis(axis, id, { animate = true } = {}) {
    if (!AXES.includes(axis) || !this.axes || !this.dimensions.some(d => d.id === id)) { this.syncRadios(); return false; }
    if (this.axes[axis] === id) return false;
    const next = { ...this.axes }, other = AXES.find(a => a !== axis && next[a] === id);
    if (other) next[other] = next[axis];
    next[axis] = id;
    this.requestedAxes = next; this.axes = next; this.syncRadios();
    if (this.field && this.arrangement === 'axes') this.relayout({ animate });
    return true;
  }
  /** Request axes (a link): ids the collection lacks fall back to its defaults. */
  setAxes(requested, { animate = true } = {}) {
    if (requested !== undefined && !validAxes(requested)) return false;
    this.requestedAxes = { ...(requested || {}) };
    const before = JSON.stringify(this.axes); this.resolveAxes(); this.syncRadios();
    if (this.field && this.arrangement === 'axes' && JSON.stringify(this.axes) !== before) this.relayout({ animate });
    return true;
  }
  resolveAxes() { this.axes = resolveAxes(this.dimensions, this.requestedAxes); this.fillAxisMenus(); }
  arrangeOptions() { return { axes: this.axes, labelFor: this.callbacks.labelFor, priority: this.arrangement === 'cloud' ? this.cloudPriority() : undefined }; }
  /**
   * Who stands in front of the cloud: lit items, then the rest of the scope,
   * then everything outside it. Within each tier, `front` orders them (highest
   * first, or lowest with '-'), items without a value last; collection order
   * breaks ties.
   */
  cloudPriority() {
    const tier = i => this.lit && this.lit.has(this.keys[i]) ? 0 : this.inScope[i] ? 1 : 2;
    const values = this.frontValues(), descending = this.front ? parseFront(this.front).descending : true;
    const by = (a, b) => {
      if (!values) return 0;
      const x = values[a], y = values[b];
      if (x === y) return 0; if (x === null) return 1; if (y === null) return -1;
      return descending ? y - x : x - y;
    };
    return [...this.keys.keys()].sort((a, b) => tier(a) - tier(b) || by(a, b) || a - b);
  }
  /** The `front` values for this corpus, cached; null without a usable `front`. */
  frontValues() {
    if (!this.front) return null;
    const { id } = parseFront(this.front);
    if (!this.dimensions.some(d => d.id === id)) return null;
    if (this.frontCache?.front !== this.front || this.frontCache.identity !== this.identity)
      this.frontCache = { front: this.front, identity: this.identity, values: orderValues(this.clips, id, this.callbacks.labelFor) };
    return this.frontCache.values;
  }
  /** Order the cloud by a dimension (front=); null for collection order. */
  setFront(front, { animate = true } = {}) {
    if (front !== null && !isFront(front)) return false;
    this.front = front;
    if (this.field && this.arrangement === 'cloud') this.relayout({ animate });
    return true;
  }
  /** The order in words, for the figure: "by capture date, latest first". */
  describeFront() {
    if (!this.front) return null;
    const { id, descending } = parseFront(this.front), dim = this.dimensions.find(d => d.id === id);
    if (!dim) return null;
    const first = isTimeKey(id) ? (descending ? 'latest' : 'earliest') : (descending ? 'highest' : 'lowest');
    return `by ${dim.group === 'colour' ? dim.label.toLowerCase() : dim.label}, ${first} first`;
  }
  fillAxisMenus() {
    for (const [axis, select] of this.axisSelects) {
      const groups = [['colour', 'Dominant colour'], ['attribute', 'Attributes']].map(([group, label]) => {
        const node = document.createElement('optgroup'); node.label = label;
        for (const d of this.dimensions.filter(d => d.group === group)) node.append(new Option(d.label, d.id));
        return node;
      }).filter(node => node.children.length);
      select.replaceChildren(...groups); select.value = this.axes?.[axis] || '';
    }
  }
  relayout({ animate = true } = {}) {
    this.layout = arrange(this.clips, this.arrangement, this.arrangeOptions());
    this.syncCallout(); // a new arrangement reads the item differently
    const p = this.layout.positions, s = this.layout.sizes, q = this.camera.quaternion, still = !animate || reducedMotion();
    for (let i = 0; i < this.count; i++) {
      if (still) { this.field.place(i, p[i * 3], p[i * 3 + 1], p[i * 3 + 2], s[i * 2], s[i * 2 + 1], q); continue; }
      this.field.moveTo(i, p[i * 3], p[i * 3 + 1], p[i * 3 + 2], s[i * 2], s[i * 2 + 1], q);
    }
    if (still) this.field.layout();
    this.applyLayoutDecor();
    if (this.fitted) this.fitView({ animate: !still, quiet: true });
    this.invalidate();
  }
  syncRadios() {
    for (const [name, input] of this.radios) input.checked = name === this.arrangement;
    this.axesGroup.hidden = this.arrangement !== 'axes';
    for (const [axis, select] of this.axisSelects) select.value = this.axes?.[axis] || '';
  }

  applyLayoutDecor() {
    const points = (this.layout?.guides || []).flat().flat();
    this.guides.geometry.dispose(); this.guides.geometry = new THREE.BufferGeometry();
    this.guides.geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.overlay.replaceChildren(); this.labels = [];
    // A shot may rename an axis (callbacks.axisTitles, docs/SHOTS.md): the words change, the axis does not.
    const titles = this.callbacks.axisTitles || {};
    for (const label of this.layout?.labels || []) {
      const text = label.axis && titles[label.axis] ? `${AXIS_LABELS[label.axis]} · ${titles[label.axis]}` : label.text;
      const node = element('span', `float-label float-label-${label.kind}`, text); this.overlay.append(node);
      this.labels.push({ point: new THREE.Vector3().fromArray(label.point), node, kind: label.kind, side: label.side, gap: label.gap || 0 });
    }
    // Measured once, now, so Fit can frame each label's own box.
    for (const label of this.labels) { label.width = label.node.offsetWidth; label.height = label.node.offsetHeight; }
    const maxDistance = (this.layout?.bounds.radius || 1000) * 8;
    if (this.controls) this.controls.maxDistance = maxDistance;
    this.camera.far = Math.max(60000, maxDistance * 2); this.camera.updateProjectionMatrix();
  }

  updateStatus() {
    // Without graphics the flat wall is the way to every item; the button takes the visitor there.
    if (this.contextLost) this.status.replaceChildren('3D graphics are unavailable here. ', this.fallback);
    else if (this.built && !this.count) this.status.textContent = 'This collection has no items.';
    else if (this.built && !this.scopeCount) this.status.textContent = 'No items in this scope. Every item is dimmed; change the search or filters to continue.';
    else if (this.dimMode === 'hidden') this.status.textContent = 'Dimming is unavailable in this build, so items outside the scope are hidden.';
    else this.status.textContent = '';
    this.status.hidden = !this.status.textContent;
  }

  /* ---------------------------------------------------------- reaching --- */

  /** An attribute axis's model for the whole collection, built once per corpus. */
  modelFor(id) {
    if (!this.models || this.models.identity !== this.identity) this.models = { identity: this.identity, byId: new Map() };
    if (!this.models.byId.has(id)) this.models.byId.set(id, attributeAxis(this.clips, id)?.model || null);
    return this.models.byId.get(id);
  }
  /** In-scope indices. */
  scoped() { return [...this.inScope.keys()].filter(i => this.inScope[i]); }
  /**
   * The callout at a keyboard-chosen item: its title and where it sits in the
   * arrangement's terms (describeItem). Returns the spoken text, or null when
   * the callout is off (no keyboard choice, or the item left the scope).
   */
  syncCallout() {
    const index = this.keyboardSelection ? this.indexOf?.get(this.selection) : undefined;
    const on = index !== undefined && this.inScope?.[index] === 1;
    if (!on) { this.callout.hide(); return null; }
    const clip = this.clips[index], title = String(clip.title || this.keys[index]);
    const where = describeItem(clip, this.arrangement, { axes: this.axes, modelFor: id => this.modelFor(id), labelFor: this.callbacks.labelFor });
    this.callout.show(title, where.short.join(' · '));
    this.invalidate();
    return where.spoken ? `${title}. ${where.spoken}.` : `${title}.`;
  }
  /** A keyboard move or jump: select, fly, and say where the item is. */
  keyChoose(key) {
    this.keyboardSelection = true;
    if (!this.choose(key)) return false;
    const text = this.syncCallout(); if (text) this.announcer.textContent = text;
    return true;
  }
  /**
   * Arrow and Page keys: the next in-scope item along the arrangement axis that
   * points `screen` way (right, left, up, down, away, toward) from where the
   * camera is now. With nothing selected, the first move takes the item
   * nearest the point the camera looks at.
   */
  moveSelection(screen) {
    if (!this.layout || !this.field) return;
    const scoped = this.scoped(); if (!scoped.length) return;
    const p = this.layout.positions, from = this.indexOf.get(this.selection);
    if (from === undefined || !this.inScope[from]) {
      const t = this.controls?.target || new THREE.Vector3();
      let near = scoped[0], best = Infinity;
      for (const i of scoped) { const d = (p[i * 3] - t.x) ** 2 + (p[i * 3 + 1] - t.y) ** 2 + (p[i * 3 + 2] - t.z) ** 2; if (d < best) { best = d; near = i; } }
      this.keyChoose(this.keys[near]); return;
    }
    const { k, sign } = this.screenAxis(screen), next = nearestAlong(p, scoped, from, k, sign);
    if (next < 0) { this.announcer.textContent = `No more items ${EDGE_WORDS[screen]}.`; return; }
    this.keyChoose(this.keys[next]);
  }
  /** Which arrangement axis, and which way along it, points `screen` way on screen now. */
  screenAxis(screen) {
    const e = this.camera.matrixWorld.elements, right = [e[0], e[1], e[2]], up = [e[4], e[5], e[6]], back = [e[8], e[9], e[10]];
    const pick = (v, taken) => [0, 1, 2].filter(i => !taken.includes(i)).reduce((a, b) => Math.abs(v[b]) > Math.abs(v[a]) ? b : a);
    const kr = pick(right, []), ku = pick(up, [kr]), kd = 3 - kr - ku, sgn = x => Math.sign(x) || 1;
    return {
      right: { k: kr, sign: sgn(right[kr]) }, left: { k: kr, sign: -sgn(right[kr]) },
      up: { k: ku, sign: sgn(up[ku]) }, down: { k: ku, sign: -sgn(up[ku]) },
      away: { k: kd, sign: -sgn(back[kd]) }, toward: { k: kd, sign: sgn(back[kd]) },
    }[screen];
  }
  /** In-scope items whose title starts with, then contains, `query`; punctuation is ignored. */
  titleMatches(query) { return matchTitles(this.scoped().map(i => [i, this.clips[i].title || this.keys[i]]), query); }

  /** Fly to an item without opening it (arrow keys, jump). */
  choose(key) {
    if (!this.inScopeKey(key)) return false;
    this.selection = key;
    this.flyTo(key); this.interact(); return true;
  }
  /** Open an item in the detail pane; `fly` also brings the camera to it. */
  open(key, { fly = false } = {}) {
    const index = this.indexOf.get(key); if (index === undefined) return;
    this.selection = key; this.syncCallout(); this.cancelHover();
    this.callbacks.onOpen?.(this.clips[index]);
    // After onOpen: the detail pane is now open and its width known, so the
    // flight can land the item beside it rather than under it.
    if (fly) this.flyTo(key);
    this.invalidate();
  }

  /** Where the camera ends up to look at item `index`: on the line from where it is now. */
  poseFor(index) {
    const centre = this.centreOf(index, new THREE.Vector3());
    const w = this.field.sizes[index * 2], h = this.field.sizes[index * 2 + 1];
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)), tanH = tanV * this.camera.aspect;
    const distance = Math.max(h / (2 * tanV * 0.38), w / (2 * tanH * 0.5), 30);
    const from = this.camera.position.clone().sub(centre);
    if (from.lengthSq() < 1e-6) from.copy(FIT_DIRECTION);
    const direction = from.normalize(), position = centre.clone().addScaledVector(direction, distance), target = centre.clone();
    // Land beside the detail pane when it covers part of the stage.
    const obscured = clamp(this.callbacks.obscuredRight?.() || 0, 0, this.width * 0.7);
    if (obscured > 0 && this.width) {
      const right = new THREE.Vector3().crossVectors(direction.clone().negate(), this.camera.up).normalize();
      const shift = (obscured / this.width) * distance * tanH;
      position.addScaledVector(right, shift); target.addScaledVector(right, shift);
    }
    return { position, target };
  }
  flyTo(key) {
    const index = this.indexOf.get(key); if (index === undefined || !this.field) return false;
    const { position, target } = this.poseFor(index);
    this.fitted = false; this.moveCamera(position, target, { animate: true });
    return true;
  }

  /** The whole space, from the canonical direction, framed in the stage above the toolbar. */
  fitView({ animate = true, quiet = false } = {}) {
    this.fitted = true;
    if (!this.layout || !this.width) { if (!quiet) this.interact(); return; }
    const { position, target } = this.fitPose();
    this.moveCamera(position, target, { animate });
    if (!quiet) this.interact();
  }
  /**
   * Frame a set of items, by key, from the arrangement's Fit direction: the
   * evidence fills the stage and the rest of the space stays around it. One
   * item gets fly-to's framing. Not "fitted", so a resize keeps this camera,
   * and an exact link carries it. False when no key names an item.
   */
  frameItems(keys, { animate = false } = {}) {
    const indices = [...new Set(keys)].map(key => this.indexOf.get(key)).filter(i => i !== undefined);
    if (!indices.length || !this.layout || !this.width) return false;
    let pose;
    if (indices.length === 1) {
      const i = indices[0], centre = new THREE.Vector3().fromArray(this.layout.positions, i * 3);
      const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)), tanH = tanV * this.camera.aspect;
      const distance = Math.max(this.layout.sizes[i * 2 + 1] / (2 * tanV * 0.38), this.layout.sizes[i * 2] / (2 * tanH * 0.5), 30);
      pose = { position: centre.clone().addScaledVector(fitDirection(this.arrangement), distance), target: centre };
    } else pose = this.fitPose({ only: indices, labels: false });
    this.fitted = false; this.tween = null;
    this.moveCamera(pose.position, pose.target, { animate });
    return true;
  }
  /**
   * The camera that frames `only` (item indices; default every item) from the
   * arrangement's Fit direction, and the guide labels too when `labels`.
   */
  fitPose({ only = null, labels = true } = {}) {
    const probe = this.camera.clone(), direction = fitDirection(this.arrangement);
    // Frame what is drawn: every tile at its destination, and the guide labels
    // as the boxes placeLabels will draw, beside their anchors, in pixels.
    const points = [], sizes = this.layout.sizes, p = this.layout.positions;
    for (const i of only || this.keys.keys()) points.push([p[i * 3], p[i * 3 + 1], p[i * 3 + 2], sizes[i * 2] / 2, sizes[i * 2 + 1] / 2]);
    let c = new THREE.Vector3().fromArray(this.layout.bounds.centre), radius = this.layout.bounds.radius;
    if (only) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const [x, y, z, hw, hh] of points) {
        lo[0] = Math.min(lo[0], x - hw); hi[0] = Math.max(hi[0], x + hw); lo[1] = Math.min(lo[1], y - hh); hi[1] = Math.max(hi[1], y + hh);
        lo[2] = Math.min(lo[2], z); hi[2] = Math.max(hi[2], z);
      }
      c = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
      radius = Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
    }
    const free = this.freeBand(), half = (free.top - free.bottom) / 2, focal = 1 / Math.tan(THREE.MathUtils.degToRad(probe.fov / 2));
    const ndc = !labels ? [] : this.labels.map(label => {
      const w = label.width || 8 * label.node.textContent.length + 16, h = label.height || 26, [ox, oy] = labelOffset({ ...label, width: w, height: h });
      return [label.point, 2 * ox / this.width, -2 * oy / this.height, w / this.width, h / this.height];
    });
    const fits = d => {
      probe.position.copy(c).addScaledVector(direction, d); probe.lookAt(c); probe.updateMatrixWorld(true);
      const e = probe.matrixWorldInverse.elements;
      const project = (x, y, z) => { const depth = -(e[2] * x + e[6] * y + e[10] * z + e[14]); return [depth, (e[0] * x + e[4] * y + e[8] * z + e[12]) * focal / (depth * probe.aspect), (e[1] * x + e[5] * y + e[9] * z + e[13]) * focal / depth]; };
      return points.every(([x, y, z, hw, hh]) => {
        const [depth, nx, ny] = project(x, y, z); if (depth <= probe.near) return false;
        return Math.abs(nx) + hw * focal / (depth * probe.aspect) <= 0.94 && Math.abs(ny) + hh * focal / depth <= half;
      }) && ndc.every(([a, ox, oy, hw, hh]) => {
        const [depth, nx, ny] = project(a.x, a.y, a.z); if (depth <= probe.near) return false;
        // placeLabels keeps a label's width on the stage itself; Fit needs the
        // anchor on screen and the label's rows inside the band.
        return Math.abs(nx) <= 0.98 && Math.abs(ny + oy) + hh <= half;
      });
    };
    let lo = 1, hi = radius * 20; for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
    // Raise the content into the band above the toolbar.
    const shift = (free.top + free.bottom) / 2 * hi / focal;
    const up = new THREE.Vector3().copy(probe.up).applyQuaternion(probe.quaternion);
    const target = c.clone().addScaledVector(up, -shift), position = target.clone().addScaledVector(direction, hi);
    return { position, target };
  }
  /** NDC rows not covered by the toolbar and help line. */
  freeBand() {
    const covered = this.height ? Math.max(0, this.height - Math.min(this.toolbar.offsetTop || this.height, this.height)) : 0;
    return { top: 0.94, bottom: clamp(-1 + 2 * (covered + 10) / Math.max(1, this.height), -0.94, 0.2) };
  }
  zoomBy(factor) {
    if (!this.controls || !Number.isFinite(factor) || factor <= 0) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    offset.setLength(clamp(offset.length() / factor, this.controls.minDistance, this.controls.maxDistance));
    this.tween = null; this.fitted = false;
    this.setCamera(this.controls.target.clone().add(offset).toArray(), this.controls.target.toArray()); this.interact();
  }
  moveCamera(position, target, { animate = true } = {}) {
    if (!animate || reducedMotion() || !this.visible) { this.tween = null; this.setCamera(position.toArray(), target.toArray()); return; }
    this.tween = { from: [this.camera.position.clone(), this.controls?.target.clone() || new THREE.Vector3()], to: [position, target], start: performance.now(), duration: 650 };
    this.invalidate();
  }
  tickCamera(now) {
    if (!this.tween) return false;
    const { from, to, start, duration } = this.tween, t = clamp((now - start) / duration, 0, 1), k = ease(t);
    this.setCamera(from[0].clone().lerp(to[0], k).toArray(), from[1].clone().lerp(to[1], k).toArray());
    if (t >= 1) this.tween = null;
    return true;
  }
  setCamera(position, target) {
    this.programmatic = true;
    this.camera.position.fromArray(position); this.controls?.target.fromArray(target); this.controls?.update();
    this.camera.position.fromArray(position); this.camera.lookAt(new THREE.Vector3().fromArray(target)); this.camera.updateMatrixWorld(true);
    this.programmatic = false; this.invalidate();
  }

  keydown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || !this.controls) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === 'Home' || key === '0') { event.preventDefault(); this.tween = null; this.fitView(); return; }
    if (key === 'Enter' && this.selection) { event.preventDefault(); this.open(this.selection, { fly: true }); return; }
    if (key === '/') { event.preventDefault(); this.jump.show(); return; }
    if (key === 'PageUp' || key === 'PageDown') { event.preventDefault(); this.moveSelection(key === 'PageUp' ? 'away' : 'toward'); return; }
    const arrow = { ArrowRight: 'right', ArrowLeft: 'left', ArrowUp: 'up', ArrowDown: 'down' }[key];
    if (arrow && !event.shiftKey) { event.preventDefault(); this.moveSelection(arrow); return; }
    if (['+', '=', '-'].includes(key)) { event.preventDefault(); this.zoomBy(key === '-' ? 1 / 1.15 : 1.15); return; }
    const target = this.controls.target, offset = this.camera.position.clone().sub(target);
    const forward = offset.clone().negate().normalize(), right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward), speed = Math.max(15, offset.length() * 0.06);
    const fly = { w: forward, s: forward.clone().negate(), d: right, a: right.clone().negate(), e: up, q: up.clone().negate() }[key];
    if (fly) {
      // Flight moves the eye and the point it orbits together; it never turns.
      event.preventDefault(); this.tween = null; this.fitted = false;
      const move = fly.clone().multiplyScalar(speed);
      this.setCamera(this.camera.position.clone().add(move).toArray(), target.clone().add(move).toArray()); this.interact(); return;
    }
    // Shift+arrows orbit; plain arrows move between items (above).
    if (!arrow) return;
    event.preventDefault(); this.tween = null; this.fitted = false;
    const sphere = new THREE.Spherical().setFromVector3(offset);
    if (key === 'ArrowLeft') sphere.theta -= .1;
    if (key === 'ArrowRight') sphere.theta += .1;
    if (key === 'ArrowUp') sphere.phi -= .08;
    if (key === 'ArrowDown') sphere.phi += .08;
    sphere.phi = clamp(sphere.phi, .05, Math.PI - .05);
    this.setCamera(target.clone().add(new THREE.Vector3().setFromSpherical(sphere)).toArray(), target.toArray()); this.interact();
  }

  /* ---------------------------------------------------------- picking --- */

  centreOf(index, out) { return this.field ? this.field.worldCentre(index, out) : out.set(0, 0, 0); }
  /**
   * The in-scope tile under a client point, nearest first. Tiles face the
   * camera, so a projected centre and a projected half-size are exact. Dimmed
   * tiles are skipped: a click passes through them to what the scope holds.
   */
  pick(clientX, clientY) {
    if (!this.field || this.contextLost || !this.width) return -1;
    const rect = this.canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return -1;
    const x = (clientX - rect.left) / rect.width * 2 - 1, y = -(clientY - rect.top) / rect.height * 2 + 1;
    const v = new THREE.Vector3(), e = this.camera.matrixWorldInverse.elements;
    const focal = 1 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    let best = -1, bestDepth = Infinity;
    for (let i = 0; i < this.count; i++) {
      if (!this.inScope[i]) continue;
      this.centreOf(i, v);
      const depth = -(e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14]);
      if (depth <= this.camera.near) continue;
      v.project(this.camera);
      const hw = this.field.sizes[i * 2] / 2 * focal / depth / this.camera.aspect, hh = this.field.sizes[i * 2 + 1] / 2 * focal / depth;
      if (Math.abs(x - v.x) <= hw && Math.abs(y - v.y) <= hh && depth < bestDepth) { best = i; bestDepth = depth; }
    }
    return best;
  }
  cancelHover() { if (this.hoverKey != null) { this.hoverKey = null; this.callbacks.onHoverEnd?.(); this.invalidate(); } }
  /** The tile's rectangle on screen, for the detail pane's lift from it. */
  originRectangle(clip) {
    const index = this.indexOf.get(clipKey(clip)); if (index === undefined || !this.field || !this.width) return null;
    const v = this.centreOf(index, new THREE.Vector3()), e = this.camera.matrixWorldInverse.elements;
    const depth = -(e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14]); if (depth <= this.camera.near) return null;
    v.project(this.camera); if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
    const rect = this.canvas.getBoundingClientRect(), scale = rect.height / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / depth;
    const width = this.field.sizes[index * 2] * scale, height = this.field.sizes[index * 2 + 1] * scale;
    return { left: rect.left + (v.x + 1) / 2 * rect.width - width / 2, top: rect.top + (1 - v.y) / 2 * rect.height - height / 2, width, height };
  }

  /* ------------------------------------------------------------ state --- */

  capture() {
    return { version: 1, arrangement: this.arrangement, ...(this.axes ? { axes: { ...this.axes } } : {}), ...(this.front ? { front: this.front } : {}), position: this.camera.position.toArray(),
      target: this.controls?.target.toArray() || [0, 0, 0], fitted: this.fitted, selection: this.selection };
  }
  restore(state) {
    if (!state || state.version !== 1 || !isArrangement(state.arrangement) || !vector(state.position) || !vector(state.target)) return false;
    if (state.axes !== undefined && !validAxes(state.axes)) return false;
    if (state.front !== undefined && !isFront(state.front)) return false;
    const distance = new THREE.Vector3().fromArray(state.position).distanceTo(new THREE.Vector3().fromArray(state.target));
    if (distance < .1 || distance > 1e5) return false;
    // Axes first, quietly: the arrangement change below then lays out once.
    const relaid = this.arrangement === state.arrangement && state.arrangement === 'axes';
    if (state.axes !== undefined) {
      if (relaid) this.setAxes(state.axes, { animate: false });
      else { this.requestedAxes = { ...state.axes }; if (this.field) this.resolveAxes(); this.syncRadios(); }
    }
    // The cloud's order, quietly too: a cloud staying a cloud lays out here, any other change below.
    if (this.arrangement === 'cloud' && state.arrangement === 'cloud') this.setFront(state.front ?? null, { animate: false });
    else this.front = state.front ?? null;
    this.setArrangement(state.arrangement, { animate: false });
    this.selection = this.indexOf.has(state.selection) ? state.selection : null;
    this.keyboardSelection = false; this.syncCallout();
    this.tween = null; this.fitted = state.fitted === true;
    if (this.fitted) this.fitView({ animate: false, quiet: true }); else this.setCamera(state.position, state.target);
    return true;
  }
  captureView() { return this.capture(); }
  /**
   * What would still change the picture, for stills (wall.mjs whenStill):
   * empty once every tile has landed in the atlas, nothing travels or flies,
   * and no frame is waiting to be drawn.
   */
  stillPending() {
    if (this.contextLost) return ['3D graphics are unavailable'];
    const out = [];
    if (!this.built || !this.field) out.push('the floating space is building');
    else {
      if (atlasBusy(this.field.atlases)) out.push('covers are loading');
      if (this.field.moving) out.push('items are moving');
    }
    if (this.tween) out.push('the camera is flying');
    if (this.dirty || this.frame) out.push('a frame is waiting to be drawn');
    return out;
  }
  restoreView(state) { return this.restore(state); }
  setFocused(key) {
    this.selection = this.indexOf.has(key) ? key : null;
    this.syncCallout(); this.invalidate();
  }

  /* ------------------------------------------------------------ frame --- */

  resize() {
    if (this.disposed) return;
    const rect = this.host.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    this.width = rect.width; this.height = rect.height; this.camera.aspect = rect.width / rect.height; this.camera.updateProjectionMatrix();
    this.renderer?.setSize(rect.width, rect.height, false);
    if (this.fitted) this.fitView({ animate: false, quiet: true });
    this.invalidate();
  }
  setVisible(on) {
    this.visible = !!on; this.host.hidden = !on; if (this.controls) this.controls.enabled = !!on;
    if (on) { this.resize(); this.invalidate(); } else { this.cancelHover(); this.tween = null; if (this.frame) cancelAnimationFrame(this.frame); this.frame = null; }
  }
  /**
   * Render on demand, but keep a frame loop while anything can change what is
   * drawn: a flight, items travelling between arrangements, or tiles still
   * landing in the atlas. An idle, loaded space schedules nothing.
   */
  invalidate() {
    this.dirty = true;
    // Inside tick() the frame decides at its end whether to run again. A
    // request from here as well would start a second loop beside it, and every
    // flight step would double them (measured: 81,924 renders for one
    // arrangement change in headed Chrome).
    if (this.frame || this.ticking || this.disposed || !this.visible || this.contextLost || !this.renderer) return;
    this.frame = requestAnimationFrame(now => this.tick(now));
  }
  tick(now) {
    this.frame = null;
    if (this.disposed || !this.visible || this.contextLost || !this.field && !this.dirty) return;
    this.ticking = true;
    try { this.frameStep(now); } finally { this.ticking = false; }
  }
  frameStep(now) {
    const dt = Math.min(100, now - (this.lastTick ?? now)); this.lastTick = now;
    const started = performance.now();
    const flying = this.tickCamera(now), moving = this.field ? this.field.tick(dt) > 0 : false;
    if (flying || moving || this.dirty) {
      this.dirty = false;
      const endPass = perf.begin('float/pass');
      this.billboard();
      this.field?.update(this.camera, now);
      this.field?.takeDirty();
      endPass();
      this.render();
      this.frameTimes.push(performance.now() - started); if (this.frameTimes.length > 600) this.frameTimes.shift();
    } else if (this.field) {
      const uploaded = this.field.flush(now), changed = this.field.takeDirty();
      if (uploaded || changed) this.render();
    }
    this.lastTick = now;
    // Keep ticking while the atlas still has tiles to fetch, or drawn tiles
    // waiting for their throttled upload: stopping before that last flush
    // leaves placeholders on screen over pixels the atlas already holds.
    const loading = this.field && atlasBusy(this.field.atlases);
    if (flying || moving || loading || this.tween || this.dirty) this.frame = requestAnimationFrame(t => this.tick(t));
    else this.lastTick = undefined;
  }
  /** Every tile faces the camera: a cover seen edge-on carries no information. */
  billboard() {
    if (!this.field) return;
    const q = this.camera.quaternion, f = this.field, c = f.centres, s = f.sizes, target = f.targetRot;
    for (let i = 0; i < this.count; i++) {
      f.place(i, c[i * 3], c[i * 3 + 1], c[i * 3 + 2], s[i * 2], s[i * 2 + 1], q);
      target[i * 4] = q.x; target[i * 4 + 1] = q.y; target[i * 4 + 2] = q.z; target[i * 4 + 3] = q.w;
    }
    f.mesh.instanceMatrix.needsUpdate = true;
  }
  render() {
    if (this.disposed || !this.visible || this.contextLost || !this.renderer) return;
    const done = perf.begin('float/render');
    const ringKey = this.hoverKey || this.selection, ringIndex = ringKey != null ? this.indexOf.get(ringKey) : undefined;
    this.ring.visible = ringIndex !== undefined && !!this.field;
    if (this.ring.visible) {
      this.centreOf(ringIndex, this.ring.position); this.ring.quaternion.copy(this.camera.quaternion);
      this.ring.scale.set(this.field.sizes[ringIndex * 2] * 1.08, this.field.sizes[ringIndex * 2 + 1] * 1.08, 1);
    }
    this.renderer.render(this.scene, this.camera); this.renderCount++;
    done();
    this.placeLabels();
  }
  placeLabels() {
    const point = new THREE.Vector3(), t = this.toolbar;
    // The toolbar counts as taken: a label half under it reads as broken.
    const occupied = t.offsetWidth ? [{ x: t.offsetLeft + t.offsetWidth / 2, y: t.offsetTop + t.offsetHeight / 2, w: t.offsetWidth / 2, h: t.offsetHeight / 2 }] : [];
    this.placeCallout(occupied, t);
    for (const label of this.labels) {
      const { point: anchor, node } = label;
      point.copy(anchor).project(this.camera);
      let x = (point.x + 1) / 2 * this.width, y = (1 - point.y) / 2 * this.height;
      // Measured once, as a label's text never changes. Labels are listed in
      // priority order, and a later one that would touch an earlier one hides.
      if (!label.width) { node.hidden = false; label.width = node.offsetWidth; label.height = node.offsetHeight; }
      // A label with a side sits beside its point rather than centred on it.
      const [ox, oy] = labelOffset(label); x += ox; y += oy;
      x = clamp(x, label.width / 2 + 4, Math.max(label.width / 2 + 4, this.width - label.width / 2 - 4));
      const box = { x, y, w: label.width / 2 + 4, h: label.height / 2 + 2 };
      const visible = point.z > -1 && point.z < 1 && x > 8 && x < this.width - 8 && y > 8 && y < this.height - 8
        && !occupied.some(o => Math.abs(o.y - y) < o.h + box.h && Math.abs(o.x - x) < o.w + box.w);
      node.hidden = !visible;
      if (!visible) continue;
      node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`; occupied.push(box);
    }
  }

  /**
   * The keyboard callout sits beside the selected item, on whichever side has
   * room, above the toolbar. It goes first, so axis labels that would touch it
   * hide rather than cover it.
   */
  placeCallout(occupied, t) {
    if (this.callout.node.hidden || !this.field) return;
    const index = this.indexOf.get(this.selection); if (index === undefined) return;
    const c = this.centreOf(index, new THREE.Vector3()), q = this.camera.quaternion;
    const right = c.clone().addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(q), this.field.sizes[index * 2] / 2);
    const top = c.clone().addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(q), this.field.sizes[index * 2 + 1] / 2);
    c.project(this.camera); right.project(this.camera); top.project(this.camera);
    const px = v => (v + 1) / 2 * this.width, py = v => (1 - v) / 2 * this.height, cx = px(c.x), cy = py(c.y);
    const box = this.callout.place({ cx, cy, halfW: Math.abs(px(right.x) - cx), halfH: Math.abs(py(top.y) - cy), width: this.width, height: this.height,
      floor: (t.offsetWidth ? t.offsetTop : this.height) - 8, onScreen: c.z > -1 && c.z < 1 });
    if (box) occupied.push({ x: box.x + box.w / 2, y: box.y + box.h / 2, w: box.w / 2 + 4, h: box.h / 2 + 2 });
  }

  /** Read one pixel at an item's centre straight after drawing it (tests). */
  samplePixel(key) {
    const index = this.indexOf.get(key); if (index === undefined || !this.renderer) return null;
    this.billboard(); this.field.update(this.camera); this.render();
    const v = this.centreOf(index, new THREE.Vector3()).project(this.camera), gl = this.renderer.getContext();
    const x = Math.round((v.x + 1) / 2 * gl.drawingBufferWidth), y = Math.round((v.y + 1) / 2 * gl.drawingBufferHeight), out = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return [...out.slice(0, 3)];
  }
  /**
   * Draw one item alone and read an n × n grid across its tile, inset from the
   * edges (tests). Catches a tile that samples part of another slot, which a
   * single centre pixel or an atlas readback cannot see.
   */
  isolatedSamples(key, n = 5) {
    const index = this.indexOf.get(key); if (index === undefined || !this.renderer) return null;
    const opacity = this.field.aOpacity.array, saved = opacity.slice();
    for (let i = 0; i < this.count; i++) if (i !== index) opacity[i] = 0;
    this.field.aOpacity.needsUpdate = true; this.guides.visible = false;
    this.billboard(); this.field.update(this.camera); this.render();
    const gl = this.renderer.getContext(), e = this.camera.matrixWorldInverse.elements, v = this.centreOf(index, new THREE.Vector3());
    const depth = -(e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14]), focal = 1 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    v.project(this.camera);
    const hw = this.field.sizes[index * 2] / 2 * focal / depth / this.camera.aspect, hh = this.field.sizes[index * 2 + 1] / 2 * focal / depth, out = [], px = new Uint8Array(4);
    for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
      const x = v.x + hw * 0.7 * (2 * col / (n - 1) - 1), y = v.y + hh * 0.7 * (2 * row / (n - 1) - 1);
      gl.readPixels(Math.round((x + 1) / 2 * gl.drawingBufferWidth), Math.round((y + 1) / 2 * gl.drawingBufferHeight), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      out.push([px[0], px[1], px[2]]);
    }
    opacity.set(saved); this.field.aOpacity.needsUpdate = true; this.guides.visible = true; this.render();
    return out;
  }
  getDiagnostics() {
    const f = this.field, byKey = (fn) => Object.fromEntries(this.keys.map((key, i) => [key, fn(i)]));
    const r = n => Math.round(n * 1000) / 1000, v = new THREE.Vector3();
    const pickTargets = [];
    if (f && !this.contextLost) for (let i = 0; i < this.count; i++) {
      if (!this.inScope[i]) continue;
      this.centreOf(i, v).project(this.camera);
      if (v.z > -1 && v.z < 1 && Math.abs(v.x) < 0.8 && Math.abs(v.y) < 0.6) pickTargets.push({ key: this.keys[i], x: v.x, y: v.y });
    }
    let farResident = 0; if (f) for (let i = 0; i < this.count; i++) if (f.atlases.farSlot[i] >= 0) farResident++;
    // Where each item is on screen: NDC x, y, camera depth, and the share of
    // the stage height its tile covers.
    const e = this.camera.matrixWorldInverse.elements, tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const screen = f ? byKey(i => {
      this.centreOf(i, v); const depth = -(e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14]); v.project(this.camera);
      return [r(v.x), r(v.y), r(depth), r(f.sizes[i * 2 + 1] / (2 * depth * tanV))];
    }) : {};
    return { built: this.built, visible: this.visible, contextLost: !!this.contextLost, graphicsError: this.graphicsError || null,
      arrangement: this.arrangement, itemCount: this.count, scopeCount: this.scopeCount, dimMode: this.dimMode || null,
      inScope: this.keys.filter((_, i) => this.inScope[i]),
      positions: f ? byKey(i => [r(f.centres[i * 3]), r(f.centres[i * 3 + 1]), r(f.centres[i * 3 + 2])]) : {},
      targets: this.layout ? byKey(i => [r(this.layout.positions[i * 3]), r(this.layout.positions[i * 3 + 1]), r(this.layout.positions[i * 3 + 2])]) : {},
      exact: this.layout ? byKey(i => [r(this.layout.exact[i * 3]), r(this.layout.exact[i * 3 + 1]), r(this.layout.exact[i * 3 + 2])]) : {},
      opacity: f ? byKey(i => r(f.aOpacity.array[i])) : {}, screen, stretch: this.layout?.stretch ?? 1,
      moving: f?.moving || 0, flying: !!this.tween, edge: this.layout?.edge || 0, declumped: this.layout?.declumped || null,
      unplaced: this.layout?.unplaced || 0, labels: this.labels.map(l => l.node.textContent),
      axes: this.axes, axisInfo: this.layout?.axisInfo || null,
      callout: this.callout.text, announcement: this.announcer.textContent, dimensions: this.dimensions.map(d => d.id), lit: this.lit ? [...this.lit] : null,
      state: this.capture(), selection: this.selection, renderCount: this.renderCount, farResident,
      failed: f?.atlases._failed?.size ?? 0, loading: f ? (f.atlases._inflight || 0) + f.atlases._farQueue.length + f.atlases._nearQueue.length + (f.atlases.far._dirty || f.atlases.near._dirty ? 1 : 0) : 0,
      pickTargets, frameTimes: this.frameTimes.slice() };
  }
  dispose() {
    if (this.disposed) return; this.disposed = true; this.cancelHover(); if (this.frame) cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect(); for (const [node, name, fn] of this.listeners) node.removeEventListener(name, fn);
    this.controls?.dispose(); this.field?.dispose(); this.guides.geometry.dispose(); this.ring.geometry.dispose();
    this.renderer?.dispose(); this.renderer?.forceContextLoss(); this.host.replaceChildren();
  }
}
