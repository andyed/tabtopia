/**
 * Plays the image warehouse (warehouse.mjs) in a built AisleView, once, and
 * leaves the aisle exactly as it was: its own racks at rest, no copies, its
 * own dark, its camera. The aisle calls `beforeRender` each frame while the
 * show plays; a capture pauses it and seeks instead.
 */
import * as THREE from '../three/build/three.module.js';
import { TIMING, warehouseRows, warehouseFrame } from './warehouse.mjs';

const VOID = new THREE.Color('#ffffff'), FLOOR_LIT = new THREE.Color('#f3f3f5');
/** The floor under five lanes of shelving and the copies down the hall; it shrinks back as the lights go down. */
const FLOOR_SCALE = [6, 5];
/** Covers that have not arrived by now arrive as placeholders. */
const COVER_WAIT_MS = 2500;
/** A rack's height (album-walls.mjs: ROWS * PITCH). */
const RACK_HEIGHT = 8 * 1.04;
const capital = word => word.charAt(0).toLocaleUpperCase() + word.slice(1);
const element = (tag, className) => { const node = document.createElement(tag); node.className = className; return node; };

export class WarehouseShow {
  constructor(aisle, { nouns, onFinish = () => {} } = {}) {
    this.aisle = aisle; this.art = aisle.art; this.onFinish = onFinish;
    this.playing = false; this.finished = false; this.t = 0; this.t0 = null;
    const scene = aisle.scene, art = this.art;
    this.base = { background: scene.background.clone(), fogNear: scene.fog.near, fogFar: scene.fog.far,
      floor: art.floor?.material.color.clone(), floorScale: art.floor?.scale.clone(), gridOpacity: art.floorGrid?.material.opacity };
    // A link's own camera, when it was not the aisle's Fit, is where the show lands.
    this.landing = aisle.fitted ? null : { position: aisle.camera.position.toArray(), target: aisle.controls.target.toArray() };
    this.rows = warehouseRows({ racks: art.racks.length, depth: art.totalDepth, gap: art.gap });
    this.group = new THREE.Group(); this.group.name = 'Warehouse rows'; aisle.root.add(this.group);
    this.instances = this.rows.map(row => {
      const rack = art.racks[row.rack], sides = rack.walls.map(wall => wall.userData.side);
      return row.real ? { row, group: rack.group, walls: rack.walls, sides } : { row, ...this.copy(rack), sides };
    });
    this.caption = element('p', 'warehouse-caption'); this.caption.setAttribute('aria-hidden', 'true');
    this.name = element('span', 'warehouse-name'); this.lots = element('span', 'warehouse-lots');
    // Collection nouns are collection text: textContent only (AGENTS.md).
    this.name.textContent = `${capital(nouns.items)}.`; this.lots.textContent = `Lots of ${nouns.items}.`;
    this.caption.append(this.name, this.lots);
    aisle.host.append(this.caption); aisle.host.classList.add('warehouse-running');
  }

  /** A copy of a rack: the same geometry, materials and covers, none of its cover records. */
  copy(rack) {
    const source = []; rack.group.traverse(node => source.push(node));
    const saved = source.map(node => node.userData);
    // three.js deep-copies userData through JSON on clone, and a covers mesh's
    // userData.items reaches hundreds of MB for a large rack. Copies need none:
    // nothing picks, highlights or keys on them.
    for (const node of source) node.userData = {};
    let group;
    try { group = rack.group.clone(true); } finally { source.forEach((node, i) => { node.userData = saved[i]; }); }
    this.group.add(group);
    return { group, walls: rack.walls.map(wall => group.children[rack.group.children.indexOf(wall)]) };
  }

  /** Where the camera ends: the aisle's Fit at its travel, or the link's own camera. */
  entry() { return this.landing || this.art.cameraPose(this.aisle.travel, this.aisle.camera.aspect); }

  coversIn() { const d = this.art.getDiagnostics(); return d.pendingArtwork === 0; }

  start(now = performance.now()) { this.playing = true; this.waitUntil = now + COVER_WAIT_MS; this.apply(0); }

  /** Called by the aisle before each render while the show plays. */
  beforeRender(now) {
    if (!this.playing || this.finished) return;
    if (this.t0 === null) {
      if (!this.coversIn() && now < this.waitUntil) return;
      this.t0 = now;
    }
    const t = (now - this.t0) / 1000;
    if (t >= TIMING.end) { this.finish('done'); return; }
    this.apply(t);
  }

  pause() { this.playing = false; }
  /** One frame of the show, for a capture; it stays paused. */
  seek(t) { if (this.finished) return; this.playing = false; this.apply(Math.min(Math.max(0, Number(t) || 0), TIMING.end)); }

  apply(t) {
    const aisle = this.aisle, art = this.art, scene = aisle.scene;
    const f = warehouseFrame(t, this.rows, { entry: this.entry(), gap: art.gap, gapSpread: 4.8 + 6, height: RACK_HEIGHT });
    this.t = t; this.frame = f;
    this.instances.forEach((inst, i) => {
      const r = f.racks[i]; inst.group.position.set(r.x, r.y, r.z);
      inst.walls.forEach((wall, j) => { wall.position.x = inst.sides[j] * f.gap / 2; });
    });
    art.root.updateMatrixWorld(true); this.group.updateMatrixWorld(true);
    scene.background.copy(this.base.background).lerp(VOID, f.light);
    scene.fog.color.copy(scene.background); scene.fog.near = f.fog.near; scene.fog.far = f.fog.far;
    if (art.floor) {
      art.floor.material.color.copy(this.base.floor).lerp(FLOOR_LIT, f.light);
      art.floor.scale.set(1 + (FLOOR_SCALE[0] - 1) * f.light, 1 + (FLOOR_SCALE[1] - 1) * f.light, 1);
    }
    if (art.floorGrid) art.floorGrid.material.opacity = this.base.gridOpacity * (1 - f.light);
    this.name.style.opacity = String(f.caption.name); this.lots.style.opacity = String(f.caption.lots);
    aisle.setCamera(f.position, f.target);
  }

  /** Ends the show, played out or not: the aisle is left exactly as it opened. */
  finish(reason = 'done') {
    if (this.finished) return;
    this.finished = true; this.playing = false;
    const aisle = this.aisle, art = this.art, scene = aisle.scene;
    for (const inst of this.instances) {
      if (inst.row.real) inst.group.position.set(0, 0, 0);
      // A copy's instance buffers are its own; its geometry and materials are the aisle's and stay.
      else inst.group.traverse(node => { if (node.isInstancedMesh) node.dispose(); });
    }
    this.group.removeFromParent(); this.instances = [];
    scene.background.copy(this.base.background); scene.fog.color.copy(this.base.background);
    scene.fog.near = this.base.fogNear; scene.fog.far = this.base.fogFar;
    if (art.floor) { art.floor.material.color.copy(this.base.floor); art.floor.scale.copy(this.base.floorScale); }
    if (art.floorGrid) art.floorGrid.material.opacity = this.base.gridOpacity;
    art.setPresentation({ spread: aisle.spread });
    this.caption.remove(); aisle.host.classList.remove('warehouse-running');
    if (this.landing) aisle.setCamera(this.landing.position, this.landing.target); else aisle.applyPose();
    this.onFinish({ reason, at: Math.round(this.t * 1000) / 1000, rows: this.rows.length });
    aisle.invalidate();
  }

  diagnostics() {
    return { playing: this.playing, started: this.t0 !== null, t: this.t, rows: this.rows.length,
      copies: this.instances.filter(inst => !inst.row.real).length, lanes: [...new Set(this.rows.map(row => row.lane))].length,
      light: this.frame?.light ?? 1, caption: [this.name.textContent, this.lots.textContent], duration: TIMING.end };
  }
}
