/** An artwork aisle over the wall's already-evaluated scope. No filter or pile ownership. */
import * as THREE from '../three/build/three.module.js';
import { OrbitControls } from '../three/examples/jsm/controls/OrbitControls.js';
import { AlbumWalls } from './album-walls.mjs';
import { listenSideScroll } from './aisle-wheel.mjs';
import { groupBy } from './layout.mjs';
import { clipKey, matchesFacet } from './context-clusters.mjs';
import { sortClips, attributeMark } from './attributes.mjs';
import { NEUTRAL_NOUNS, wallLabel } from './nouns.mjs';
import { Callout, JumpBox, announcer, titleMatches as matchTitles } from './keyboard-path.mjs';
import { aisleMove, AISLE_EDGES } from './aisle-keys.mjs';

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const vector = value => Array.isArray(value) && value.length === 3 && value.every(n => Number.isFinite(n) && Math.abs(n) <= 1e6);
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };

export class AisleView {
  constructor(host, callbacks = {}) {
    this.host = host; this.callbacks = callbacks; this.visible = true; this.built = false;
    this.travel = 0; this.spread = .65; this.fitted = true; this.selection = null; this.nouns = NEUTRAL_NOUNS;
    this.clipsByKey = new Map(); this.cohorts = []; this.labels = []; this.listeners = []; this.show = null; this.lastShow = null;
    this.host.classList.add('aisle-host'); this.host.replaceChildren();
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color('#050510');
    // Fog far beyond anything the camera can reach, so it changes nothing here. The
    // warehouse (warehouse-show.mjs) pulls it in for its white void; adding fog
    // there instead would recompile every material as the show starts and ends.
    this.scene.fog = new THREE.Fog('#050510', 1e6, 2e6);
    this.camera = new THREE.PerspectiveCamera(42, 1, .05, 2000);
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.status = element('p', 'aisle-status'); this.status.setAttribute('role', 'status');
    this.overlay = element('div', 'aisle-labels'); this.overlay.setAttribute('aria-hidden', 'true');
    this.toolbar = element('div', 'aisle-toolbar'); this.toolbar.setAttribute('aria-label', 'Aisle navigation');
    const travelLabel = element('label', 'aisle-travel', 'Walk aisle');
    this.slider = element('input'); this.slider.type = 'range'; this.slider.min = '0'; this.slider.max = '1'; this.slider.step = '.001'; this.slider.value = '0';
    this.slider.setAttribute('aria-label', 'Walk aisle'); travelLabel.append(this.slider);
    this.toolbar.append(travelLabel);
    // The keyboard path to items is the aisle itself (aisle-keys.mjs): arrows walk a
    // rack's walls and rows, Page Up and Page Down change rack, / jumps to a title,
    // Enter opens. A ring and a callout mark the cover; a hidden live region speaks.
    this.callout = new Callout('aisle-callout');
    this.announcer = announcer('aisle-announcer');
    this.jump = new JumpBox('aisle-jump', { matches: q => matchTitles([...this.clipsByKey].map(([key, clip]) => [key, clip.title || key]), q),
      onPick: key => { const place = this.placeOf(key); if (place) this.keyChoose(place); },
      onClose: refocus => { if (refocus) this.canvas?.focus({ preventScroll: true }); }, listen: (node, type, fn) => this.listen(node, type, fn) });
    this.ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]].map(([x, y]) => new THREE.Vector3(0, y, x))),
      new THREE.LineBasicMaterial({ color: 0xaaffaa, depthTest: false }));
    this.ring.renderOrder = 10; this.ring.visible = false; this.scene.add(this.ring);
    this.fallback = element('button', 'view-fallback', 'Show the flat wall'); this.fallback.type = 'button';
    this.help = element('p', 'aisle-help', 'Drag to look · Scroll to zoom, sideways to walk · Arrows move along a rack, Shift+arrows turn · Page Up/Down: racks · / jumps · Home: entrance');
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.canvas = this.renderer.domElement; this.canvas.className = 'aisle-canvas'; this.canvas.tabIndex = 0;
      this.canvas.setAttribute('role', 'img'); this.canvas.setAttribute('aria-label', 'Artwork aisle. Arrow keys move between covers: right goes deeper along the left wall and back along the right one, up and down change row, Page Up and Page Down change rack, slash jumps to a title, Enter opens the cover; Shift with arrows turns, plus and minus zoom, scroll sideways to walk, Home for entrance.');
      this.host.append(this.canvas);
      // Sideways scroll is a walk along the aisle; vertical scroll stays OrbitControls' zoom.
      this.unlistenWheel = listenSideScroll(this.canvas, { walk: distance => this.walk(distance) });
      this.controls = new OrbitControls(this.camera, this.canvas); this.controls.enableDamping = false;
      this.controls.enablePan = false; this.controls.minDistance = .5; this.controls.maxDistance = 80;
      this.controls.minPolarAngle = .15; this.controls.maxPolarAngle = Math.PI * .9;
      this.controls.rotateSpeed = .55; this.controls.zoomSpeed = .65;
      this.controls.addEventListener('change', () => { this.invalidate(); if (!this.programmatic) { this.fitted = false; this.cancelHover(); this.interact(); } });
      // The nouns arrive with setClips, after this; the label reads them when each rack is built.
      this.art = new AlbumWalls(this.root, () => this.invalidate(), { onProgress: () => this.updateStatus(), wallLabel: (label, count) => wallLabel(label, count, this.nouns) });
      this.raycaster = new THREE.Raycaster();
      this.listen(this.canvas, 'pointerdown', e => { this.cancelHover(); this.down = e.isPrimary ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null; if (this.keyboardPlace) { this.keyboardPlace = null; this.syncMark(); } });
      this.listen(this.canvas, 'pointerup', e => {
        if (this.down?.id === e.pointerId && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 5) {
          const hit = this.pick(e); if (hit) this.open(hit.key);
        }
        this.down = null;
      });
      this.listen(this.canvas, 'pointermove', e => {
        if (e.buttons || e.pointerType === 'touch') return;
        const hit = this.pick(e); this.canvas.style.cursor = hit ? 'pointer' : 'grab';
        if (hit?.key !== this.hoverKey) {
          this.cancelHover();
          if (hit && (this.callbacks.hoverEnabled?.() ?? true)) { this.hoverKey = hit.key; this.callbacks.onHover?.(this.clipsByKey.get(hit.key), e); }
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
    this.listen(this.slider, 'input', () => { this.travel = Number(this.slider.value); this.fitted = true; this.applyPose(); this.cancelHover(); this.interact(); });
    this.listen(this.fallback, 'click', () => this.callbacks.onFlatWall?.());
    // Any touch, wheel or key ends the warehouse at once, before the aisle acts
    // on it, so the gesture lands on the aisle as it is left.
    for (const type of ['pointerdown', 'wheel', 'keydown']) this.listen(this.host, type, () => { if (this.show?.playing) this.show.finish('skipped'); }, { capture: true, passive: true });
    // Debug handle, as in the floating space (window.__cwFloat): the camera,
    // spread and travel live in WebGL, so probes and seeked captures reach them here.
    window.__cwAisle = this;
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(host); this.resize();
  }

  listen(node, name, fn, options) { node.addEventListener(name, fn, options); this.listeners.push([node, name, fn, options]); }
  interact() { if (!this.programmatic && !this.disposed) this.callbacks.onInteraction?.(); }

  setClips(filtered, groupKey, { sort = { key: 'none', direction: 'asc' }, labelFor, nouns = NEUTRAL_NOUNS } = {}) {
    // The warehouse's copies are of the racks being replaced.
    this.show?.finish('rebuilt');
    this.nouns = nouns;
    const sorted = sortClips(filtered, sort);
    this.clipsByKey = new Map(sorted.map(clip => [clipKey(clip), clip]));
    this.cohorts = groupBy(sorted, groupKey).filter(group => group.clips.length).map((group, i) => ({
      key: group.label || '__all__', label: group.label ? (labelFor?.(group.label) || group.label) : `All ${nouns.items}`,
      keys: [...new Set(group.clips.map(clipKey))], count: new Set(group.clips.map(clipKey)).size, unit: nouns.items,
    }));
    this.art?.setModel({ cohorts: this.cohorts, clipsByKey: this.clipsByKey, allRows: [] }, { preserveOrder: true });
    this.art?.setPresentation({ spread: this.spread, slice: null });
    this.camera.far = Math.max(2000, (this.art?.totalDepth || 0) * 2 + 100); this.camera.updateProjectionMatrix();
    this.overlay.replaceChildren(); this.labels = [];
    for (const anchor of this.art?.labelAnchors || []) { const node = element('span', 'aisle-cohort-label'); this.overlay.append(node); this.labels.push({ anchor, node }); }
    if (!this.clipsByKey.has(this.selection)) this.selection = null;
    // A rebuilt aisle has new places; a keyboard mark follows its cover if the cover is still here.
    if (this.keyboardPlace) this.keyboardPlace = this.placeOf(this.keyboardPlace.key, this.keyboardPlace.cohort);
    this.syncMark(); this.slider.disabled = !sorted.length;
    this.built = true; this.setLens(this.lens); this.updateStatus(); if (this.fitted) this.applyPose(); this.resize(); this.invalidate();
  }

  setLens(active) {
    this.lens = active || null; const marks = new Map(), exact = active && active.value != null;
    for (const [key, clip] of this.clipsByKey) {
      const match = exact ? matchesFacet(clip, active.key || active.model?.key, new Set([String(active.value)])) : true;
      marks.set(key, { match, color: active && !exact && active.model ? attributeMark(clip, active.model).color : undefined });
    }
    this.lensMatchKeys=exact?[...marks].filter(([,mark])=>mark.match).map(([key])=>key):[...this.clipsByKey.keys()];
    const colors = active ? new Map([...marks].map(([key, mark]) => {
      const color = mark.color ? new THREE.Color(mark.color).lerp(new THREE.Color(1, 1, 1), .55) : new THREE.Color(mark.match ? 1 : .17, mark.match ? 1 : .17, mark.match ? 1 : .17);
      return [key, color.getHex()];
    })) : null;
    this.art?.setHighlightColors(colors);
    for (const { anchor, node } of this.labels) {
      const group = this.cohorts.find(group => group.key === anchor.cohort);
      const matched = group.keys.filter(key => marks.get(key)?.match).length;
      node.textContent = exact ? `${group.label} · ${matched} / ${group.count} match` : anchor.text;
      node.title = node.textContent;
    }
    this.invalidate();
  }

  updateStatus() {
    // Without graphics the flat wall is the way to every item; the button takes the visitor there.
    if (this.contextLost) this.status.replaceChildren('3D graphics are unavailable here. ', this.fallback);
    else if (!this.clipsByKey.size) this.status.textContent = 'No items in this scope. Change the search or filters to continue.';
    else this.status.textContent = '';
    this.status.hidden = !this.status.textContent;
  }

  /** Racks as aisle-keys.mjs reads them: each wall's grid of places, and whether it is shown. */
  keyRacks() { return (this.art?.racks || []).map(rack => ({ grid: rack.grid, visible: rack.group.visible })); }
  /** A cover's place (album-walls.mjs): in `cohort` when given, else its first shown rack. */
  placeOf(key, cohort = null) {
    const racks = this.art?.racks || [];
    return (this.art?.places || []).find(p => p.key === key && (cohort ? p.cohort === cohort : racks[p.rack]?.group.visible)) || null;
  }
  /** The ring and callout at a keyboard-chosen cover; returns the spoken text, or null when there is none. */
  syncMark() {
    const place = this.keyboardPlace, clip = place && this.clipsByKey.get(place.key);
    this.ring.visible = !!clip;
    if (!clip) { this.callout.hide(); this.invalidate(); return null; }
    this.art.worldOf(place, this.ring.position); this.ring.position.x -= place.side * .03; this.ring.scale.setScalar(1.08);
    const title = String(clip.title || place.key), rack = this.cohorts.find(group => group.key === place.cohort)?.label || '';
    const wall = place.side === -1 ? 'left' : 'right', row = place.row + 1, column = place.column + 1;
    this.callout.show(title, [rack, `${wall} wall`, `row ${row}`, `column ${column}`].filter(Boolean).join(' · '));
    this.invalidate();
    return `${title}. ${rack ? `${rack}, ` : ''}${wall} wall, row ${row}, column ${column} from the front.`;
  }
  /**
   * A keyboard move or jump: face the cover's wall from across the aisle, a step
   * before it, so the cover sits mid-frame with its neighbours around it; mark it
   * and say where it is. Looking straight down the aisle would leave a wall cover
   * outside the view, beyond its 21° half-height and a phone's narrower width.
   */
  keyChoose(place) {
    if (!place || !this.clipsByKey.has(place.key)) return false;
    this.keyboardPlace = place; this.selection = place.key;
    this.travel = this.art.travelFor(place); this.slider.value = String(this.travel);
    const cover = this.art.worldOf(place), across = Math.min(this.art.gap * .8, 5.5) * (this.camera.aspect < 1 ? 1.35 : 1);
    this.fitted = false; this.setCamera([cover.x - place.side * across, cover.y, cover.z + 1.2], cover.toArray());
    const text = this.syncMark(); if (text) this.announcer.textContent = text;
    this.interact(); return true;
  }
  /**
   * Arrow and Page keys (aisle-keys.mjs). The first press takes a cover in the
   * rack the camera stands in, a few steps ahead at eye level, on the left wall
   * where it has covers: the middle of the view is the vanishing point, racks away.
   */
  moveSelection(direction) {
    if (!this.art?.places.length) return;
    let at = this.keyboardPlace || (this.selection && this.placeOf(this.selection));
    if (!at) {
      const ahead = -this.camera.position.z + 3, racks = this.art.racks;
      const rack = racks.findIndex(r => r.group.visible && r.start + r.length > ahead - 3), index = rack < 0 ? racks.findIndex(r => r.group.visible) : rack;
      const inRack = this.art.places.filter(p => p.rack === index), side = inRack.some(p => p.side === -1) ? -1 : 1;
      at = inRack.filter(p => p.side === side).sort((a, b) => Math.abs(a.depth - ahead) + Math.abs(a.row - 3) - (Math.abs(b.depth - ahead) + Math.abs(b.row - 3)))[0];
      this.keyChoose(at); return;
    }
    const next = aisleMove(this.keyRacks(), at, direction);
    if (!next) { this.announcer.textContent = AISLE_EDGES[direction]; return; }
    this.keyChoose(next);
  }
  choose(key) { this.keyChoose(this.placeOf(key)); }
  /**
   * The image warehouse (warehouse.mjs, warehouse-show.mjs): racks rush in
   * from a white void, then the lights go down on this aisle as it stands.
   * Plays once; a reduced-motion setting, or an aisle with nothing to show,
   * skips it and says why in `lastShow`. Resolves to the show, or null.
   */
  async playWarehouse({ nouns = this.nouns } = {}) {
    if (this.show) return this.show;
    if (!this.built || this.contextLost || !this.renderer || !this.art?.racks.length || this.disposed) { this.lastShow = { reason: 'unavailable' }; return null; }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { this.lastShow = { reason: 'reduced-motion' }; return null; }
    const { WarehouseShow } = await import('./warehouse-show.mjs');
    if (this.show || this.disposed || !this.visible) return this.show;
    this.show = new WarehouseShow(this, { nouns, onFinish: info => { this.show = null; this.lastShow = info; } });
    this.show.start(); this.invalidate();
    return this.show;
  }
  open(key) { const clip = this.clipsByKey.get(key); if (!clip) return; this.selection = key; this.cancelHover(); this.callbacks.onOpen?.(clip); }
  pick(event) {
    if (!this.art || this.contextLost) return null;
    const rect = this.canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return null;
    this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), this.camera);
    return this.art.pick(this.raycaster);
  }
  cancelHover() { if (this.hoverKey != null) { this.hoverKey = null; this.callbacks.onHoverEnd?.(); } }
  originRectangle() { return null; }

  applyPose() {
    if (!this.art || !this.controls) return;
    const pose = this.art.cameraPose(this.travel, this.camera.aspect); this.setCamera(pose.position, pose.target);
  }
  setCamera(position, target) {
    this.programmatic = true; this.camera.position.fromArray(position); this.controls?.target.fromArray(target); this.controls?.update(); this.camera.position.fromArray(position); this.camera.lookAt(new THREE.Vector3().fromArray(target)); this.camera.updateMatrixWorld(true); this.programmatic = false; this.invalidate();
  }
  /** Walk `distance` world units deeper (negative: back toward the entrance).
   * Travel moves as the slider moves it, but the camera keeps its angle to the
   * walls: a fitted view takes the pose at the new travel, a turned or zoomed
   * one slides along the aisle with its target. */
  walk(distance) {
    if (!this.art || !this.controls || !this.clipsByKey.size || !Number.isFinite(distance)) return false;
    const { length } = this.art.travelSpan(), from = this.travel;
    if (!(length > 0)) return false;
    const travel = Math.round(clamp(from + distance / length, 0, 1) * 1e5) / 1e5;
    if (travel === from) return false;
    this.travel = travel; this.slider.value = String(travel);
    if (this.fitted) this.applyPose();
    else {
      const step = new THREE.Vector3(0, 0, (from - travel) * length);
      this.setCamera(this.camera.position.clone().add(step).toArray(), this.controls.target.clone().add(step).toArray());
    }
    this.cancelHover(); this.interact(); return true;
  }
  fitView() { this.travel = 0; this.slider.value = '0'; this.fitted = true; this.applyPose(); this.cancelHover(); this.interact(); }
  zoomBy(factor) {
    if (!this.controls || !Number.isFinite(factor) || factor <= 0) return;
    const offset = this.camera.position.clone().sub(this.controls.target), length = clamp(offset.length() / factor, .5, 80);
    offset.setLength(length); this.camera.position.copy(this.controls.target).add(offset); this.controls.update(); this.fitted = false; this.invalidate(); this.interact();
  }
  keydown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || !this.controls) return;
    if (event.key === 'Home') { event.preventDefault(); this.fitView(); return; }
    if (event.key === 'Enter' && this.selection) { event.preventDefault(); this.open(this.selection); return; }
    if (event.key === '/') { event.preventDefault(); this.jump.show(); return; }
    if (event.key === 'PageUp' || event.key === 'PageDown') { event.preventDefault(); this.moveSelection(event.key === 'PageUp' ? 'away' : 'toward'); return; }
    if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); this.zoomBy(event.key === '-' ? 1 / 1.15 : 1.15); return; }
    const arrow = { ArrowRight: 'right', ArrowLeft: 'left', ArrowUp: 'up', ArrowDown: 'down' }[event.key];
    if (arrow && !event.shiftKey) { event.preventDefault(); this.moveSelection(arrow); return; }
    // Shift+arrows turn; plain arrows move between covers (above).
    if (!arrow) return;
    event.preventDefault(); const sphere = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    if (event.key === 'ArrowLeft') sphere.theta -= .1;
    if (event.key === 'ArrowRight') sphere.theta += .1;
    if (event.key === 'ArrowUp') sphere.phi -= .08;
    if (event.key === 'ArrowDown') sphere.phi += .08;
    sphere.phi = clamp(sphere.phi, .15, Math.PI * .9);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(sphere)); this.controls.update(); this.fitted = false; this.invalidate(); this.interact();
  }

  capture() { return { version: 1, travel: this.travel, spread: this.spread, position: this.camera.position.toArray(), target: this.controls?.target.toArray() || [0, 0, -10], fitted: this.fitted, selection: this.selection }; }
  restore(state) {
    if (!state || state.version !== 1) return false;
    if (!Number.isFinite(state.travel) || !Number.isFinite(state.spread) || !vector(state.position) || !vector(state.target)) return false;
    const distance = new THREE.Vector3().fromArray(state.position).distanceTo(new THREE.Vector3().fromArray(state.target));
    if (distance < .1 || distance > 1000) return false;
    this.travel = clamp(state.travel, 0, 1); this.spread = clamp(state.spread, 0, 1); this.slider.value = String(this.travel); this.fitted = state.fitted === true;
    this.selection = this.clipsByKey.has(state.selection) ? state.selection : null; this.keyboardPlace = null; this.syncMark();
    this.art?.setPresentation({ spread: this.spread, slice: null });
    if (this.fitted) this.applyPose(); else this.setCamera(state.position, state.target);
    return true;
  }
  // Aliases keep the adapter easy to use alongside the existing spatial view.
  captureView() { return this.capture(); }
  restoreView(state) { return this.restore(state); }
  setFocused(key) { this.selection = this.clipsByKey.has(key) ? key : null; if (this.keyboardPlace && this.keyboardPlace.key !== this.selection) { this.keyboardPlace = null; this.syncMark(); } }
  captureState() { return this.capture(); }
  restoreState(state) { return this.restore(state); }
  resize() {
    if (this.disposed) return;
    const rect = this.host.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    this.width = rect.width; this.height = rect.height; this.camera.aspect = rect.width / rect.height; this.camera.updateProjectionMatrix();
    this.renderer?.setSize(rect.width, rect.height, false); if (this.fitted) this.applyPose(); this.invalidate();
  }
  setVisible(on) { if (!on) this.show?.finish('hidden'); this.visible = !!on; this.host.hidden = !on; if (this.controls) this.controls.enabled = !!on; if (on) this.resize(); else { this.cancelHover(); if (this.frame) cancelAnimationFrame(this.frame); this.frame = null; } }
  invalidate() { if (this.frame || this.disposed || !this.visible || this.contextLost || !this.renderer) return; this.frame = requestAnimationFrame(() => { this.frame = null; this.render(); }); }
  render() {
    if (this.disposed || !this.visible || this.contextLost || !this.renderer) return;
    // The ring follows its cover: the walls move apart with the spread.
    if (this.keyboardPlace && this.ring.visible) { this.art.worldOf(this.keyboardPlace, this.ring.position); this.ring.position.x -= this.keyboardPlace.side * .03; }
    // A playing warehouse moves the racks and camera for this frame, and asks for the next.
    this.show?.beforeRender(performance.now());
    this.renderer.render(this.scene, this.camera); this.renderCount = (this.renderCount || 0) + 1;
    if (this.show?.playing) this.invalidate();
    const occupied = [], point = new THREE.Vector3();
    for (const { anchor, node } of this.labels) {
      point.copy(anchor.point).project(this.camera);
      const x = clamp((point.x + 1) / 2 * this.width, 12, Math.max(12, this.width - Math.min(250, this.width - 24)));
      const y = clamp((1 - point.y) / 2 * this.height, 12, this.height - 150);
      const visible = point.z > -1 && point.z < 1 && Math.abs(point.x) < 1.2 && !occupied.some(p => Math.abs(p.y - y) < 38 && Math.abs(p.x - x) < 250);
      node.hidden = !visible; if (visible) { node.style.left = `${x}px`; node.style.top = `${y}px`; occupied.push({ x, y }); }
    }
    this.placeCallout();
  }
  /** The callout beside the marked cover: a cover's width runs along the aisle, its height up the wall. */
  placeCallout() {
    const place = this.keyboardPlace; if (!place || this.callout.node.hidden) return;
    const c = this.art.worldOf(place), along = c.clone().add(new THREE.Vector3(0, 0, .49)), up = c.clone().add(new THREE.Vector3(0, .49, 0));
    c.project(this.camera); along.project(this.camera); up.project(this.camera);
    const px = v => (v + 1) / 2 * this.width, py = v => (1 - v) / 2 * this.height, cx = px(c.x), cy = py(c.y), t = this.toolbar;
    this.callout.place({ cx, cy, halfW: Math.abs(px(along.x) - cx), halfH: Math.abs(py(up.y) - cy), width: this.width, height: this.height,
      floor: (t.offsetWidth ? t.offsetTop : this.height) - 8, onScreen: c.z > -1 && c.z < 1 && Math.abs(c.x) < 1.1 && Math.abs(c.y) < 1.1 });
  }
  getDiagnostics() { return { built: this.built, visible: this.visible, contextLost: !!this.contextLost, itemCount: this.clipsByKey.size, cohortCount: this.cohorts.length, lensMatchKeys:this.lensMatchKeys || [],
    cohorts: this.cohorts.map(group => ({ ...group })), state: this.capture(), renderCount: this.renderCount || 0,
    ...(this.art?.getDiagnostics() || {}), pickTargets: this.art && !this.contextLost ? this.art.getPickTargets(this.camera) : [],
    labels: this.labels.map(({node}) => node.textContent), selection: this.selection, graphicsError: this.graphicsError || null,
    place: this.keyboardPlace ? { cohort: this.keyboardPlace.cohort, side: this.keyboardPlace.side, column: this.keyboardPlace.column, row: this.keyboardPlace.row, rack: this.keyboardPlace.rack } : null,
    callout: this.callout.text, announcement: this.announcer.textContent,
    warehouse: this.show?.diagnostics() || null, lastWarehouse: this.lastShow,
    markScreen: this.keyboardPlace && this.art ? (({ x, y, z }) => ({ x, y, z }))(this.art.worldOf(this.keyboardPlace).project(this.camera)) : null }; }
  dispose() {
    if (this.disposed) return; this.show?.finish('disposed'); this.disposed = true; this.cancelHover(); if (this.frame) cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect(); this.unlistenWheel?.(); for (const [node, name, fn, options] of this.listeners) node.removeEventListener(name, fn, options);
    this.controls?.dispose(); this.art?.dispose(); this.renderer?.dispose(); this.renderer?.forceContextLoss(); this.host.replaceChildren();
  }
}
