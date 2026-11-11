/**
 * A bounded, on-demand comparison renderer. The host owns membership, measures,
 * selection and camera persistence; depth never evaluates or alters a scope.
 * This spike is intentionally outside the vendored spatial renderer.
 */
import * as THREE from '../three/build/three.module.js';
import { remote } from './media-policy.mjs';
import { spriteCovers, spriteSource, isSpriteSource } from './sprite-covers.mjs';
import { OrbitControls } from '../three/examples/jsm/controls/OrbitControls.js';
import { AlbumWalls } from './album-walls.mjs';
import { listenSideScroll } from './aisle-wheel.mjs';
import { NEUTRAL_COPY } from './comparison-copy.mjs';

const COLORS = [0x90e4f4, 0xffda9c, 0xcbb7ff, 0xaaffaa, 0xffb8d0, 0xd7e7ff];
const HEIGHT = 4.4;
const STEP = 1.12;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const same = (a, b) => a?.value === b?.value && a?.cohort === b?.cohort && (a?.observation ?? null) === (b?.observation ?? null);
// An observation selects exactly its cited cells; otherwise a value and/or cohort.
const match = (pick, datum) => pick?.cells ? pick.cells.some(c => c.value === datum.value && c.cohort === datum.cohort)
  : (!pick?.value || pick.value === datum.value) && (!pick?.cohort || pick.cohort === datum.cohort);

/** A cover served by sprite-sheet cells becomes a texture from its cell. */
const coverSource = clip => spriteCovers.has(clip) ? spriteSource(clip) : fileSource(clip);

function fileSource(clip) {
  const variants = (clip?.coverVariants || []).filter(v => v?.src && v.width > 0)
    .sort((a, b) => a.width - b.width);
  const source = (variants.find(v => v.width >= 128) || variants.at(-1))?.src || clip?.cover;
  if (!source) return null;
  try {
    const url = new URL(source, location.href);
    if (!['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) return null;
    if (url.origin !== location.origin && ['http:', 'https:'].includes(url.protocol))
      return remote(url.href);
    return source;
  } catch { return null; }
}

export class ComparisonScene {
  constructor(host, { wording = NEUTRAL_COPY, onSelect = () => {}, onInspect = () => {}, onPreview = () => {}, onCameraChange = () => {}, onWalk = () => {} } = {}) {
    this.host = host;
    this.wording = wording;
    this.host.replaceChildren();
    this.callbacks = { onSelect, onInspect, onPreview, onCameraChange, onWalk };
    this.presentation = { spread: 0.65, view: 'depth', slice: null, metric: 'share' };
    this.selection = { value: null, cohort: null };
    this.preview = { value: null, cohort: null };
    this.bars = [];
    this.planes = [];
    this.labels = [];
    this.textureRecords = new Map();
    this.rendered = false;
    this.disposed = false;
    this.generation = 0;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#050510');
    this.camera = new THREE.PerspectiveCamera(37, 1, 0.1, 180);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x050510, 1);
    this.canvas = this.renderer.domElement;
    Object.assign(this.canvas.style, { width: '100%', height: '100%', display: 'block', touchAction: 'none' });
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Interactive 3D comparison. Drag to orbit, scroll to zoom. Arrow keys orbit; plus and minus zoom; Home resets. Exact values and selection are available in the adjacent comparison table.');
    this.host.append(this.canvas);
    this.overlay = document.createElement('div');
    this.overlay.className = 'comparison-scene-labels';
    this.overlay.setAttribute('aria-hidden', 'true');
    Object.assign(this.overlay.style, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none' });
    this.host.append(this.overlay);
    this.scene.add(new THREE.HemisphereLight(0xc8edff, 0x182623, 2.5));
    const key = new THREE.DirectionalLight(0xffffff, 3.1);
    key.position.set(-6, 12, 10);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x7bd6ff, 1.7);
    rim.position.set(8, 4, -8);
    this.scene.add(rim);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    // On the album walls, sideways scroll is a walk along the aisle; vertical scroll stays a zoom.
    this.unlistenWheel = listenSideScroll(this.canvas, { active: () => this.presentation.view === 'walls' && !!this.artWalls, walk: distance => this.walk(distance) });
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.enablePan = false;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 48;
    this.controls.minPolarAngle = 0.3;
    this.controls.maxPolarAngle = Math.PI * 0.56;
    this.controls.minAzimuthAngle = -Math.PI * 0.46;
    this.controls.maxAzimuthAngle = Math.PI * 0.46;
    this.controls.zoomSpeed = 0.65;
    this.controls.rotateSpeed = 0.6;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._onChange = () => { this.invalidate(); if (this.programmaticCamera) return; this.fitted = false; if (this.model) this.callbacks.onCameraChange(this.getCamera()); };
    this.controls.addEventListener('change', this._onChange);
    this._onDown = e => { this.down = e.isPrimary ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null; };
    this._onUp = e => {
      if (this.down?.id === e.pointerId && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 5) {
        const hit = this.pick(e);
        if (hit?.key) this.callbacks.onInspect(hit.key);
        else if (hit) this.callbacks.onSelect({ value: hit.value, cohort: hit.cohort });
      }
      this.down = null;
    };
    this._onMove = e => {
      if (e.buttons) return;
      const hit = this.pick(e);
      const next = { value: hit?.value || null, cohort: hit?.cohort || null };
      this.canvas.style.cursor = hit ? 'pointer' : 'grab';
      this.canvas.title=hit?.key?(this.model?.clipsByKey.get(hit.key)?.title||this.wording.inspect):'';
      if (!same(next, this.hover)) { this.hover = next; this.callbacks.onPreview(next); }
    };
    this._onLeave = () => {
      this.down = null;
      this.hover = { value: null, cohort: null };
      this.callbacks.onPreview(this.hover);
    };
    this._onKey = e => {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === 'Home') { e.preventDefault(); this.reset(); return; }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-'].includes(e.key)) return;
      e.preventDefault();
      const offset = this.camera.position.clone().sub(this.controls.target);
      const sphere = new THREE.Spherical().setFromVector3(offset);
      if (e.key === 'ArrowLeft') sphere.theta -= 0.1;
      if (e.key === 'ArrowRight') sphere.theta += 0.1;
      if (e.key === 'ArrowUp') sphere.phi -= 0.08;
      if (e.key === 'ArrowDown') sphere.phi += 0.08;
      if (e.key === '+' || e.key === '=') sphere.radius *= 0.9;
      if (e.key === '-') sphere.radius *= 1.1;
      sphere.theta = clamp(sphere.theta, this.controls.minAzimuthAngle, this.controls.maxAzimuthAngle);
      sphere.phi = clamp(sphere.phi, this.controls.minPolarAngle, this.controls.maxPolarAngle);
      sphere.radius = clamp(sphere.radius, this.controls.minDistance, this.controls.maxDistance);
      this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(sphere));
      this.controls.update();
    };
    for (const [name, fn] of [['pointerdown', this._onDown], ['pointerup', this._onUp], ['pointermove', this._onMove], ['pointerleave', this._onLeave], ['pointercancel', this._onLeave], ['keydown', this._onKey]]) this.canvas.addEventListener(name, fn);
    this._onContextLost = e => {
      e.preventDefault();
      this.rendered = false;
      this.canvas.setAttribute('aria-label', '3D graphics unavailable. Use the comparison table or reload to restore the scene.');
      this.host.dataset.graphicsState = 'lost';
      if (!this.errorNode) {
        this.errorNode = document.createElement('p');
        this.errorNode.setAttribute('role', 'status');
        this.errorNode.textContent = '3D graphics were interrupted. The comparison table and item evidence remain available. Reload to restore depth.';
        Object.assign(this.errorNode.style, { position: 'absolute', left: '16px', right: '16px', top: '16px', padding: '12px', color: '#f3f3f7', background: '#181821', border: '1px solid #aaa', zIndex: '2' });
        this.host.append(this.errorNode);
      }
    };
    this._onContextRestored = () => { this.host.dataset.graphicsState = 'ready'; this.errorNode?.remove(); this.errorNode = null; this.invalidate(); };
    this.canvas.addEventListener('webglcontextlost', this._onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this._onContextRestored);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.reset();
  }

  resize() {
    const { width, height } = this.host.getBoundingClientRect();
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height, false);
    this.invalidate();
  }

  label(text, point, { color = '#eaf5f3', kind = 'cohort', group = null } = {}) {
    const node = document.createElement('span');
    node.className = `comparison-scene-label comparison-scene-label--${kind}`;
    node.textContent = text;
    Object.assign(node.style, { position: 'absolute', color, whiteSpace: 'nowrap', font: '16px system-ui, sans-serif', fontWeight: kind === 'cohort' ? '650' : '500', background: 'rgba(8,17,21,.94)', padding: kind === 'category' ? '3px 5px' : '5px 8px', borderRadius: '4px', maxWidth: kind === 'category' ? '210px' : '240px', overflow: 'hidden', textOverflow: 'ellipsis', border: kind === 'cohort' ? `1px solid ${color}55` : 'none' });
    this.overlay.append(node);
    const leader = kind === 'cohort' ? document.createElement('i') : null;
    if (leader) {
      Object.assign(leader.style, { position: 'absolute', height: '1px', background: color, opacity: '0.4', transformOrigin: '0 50%' });
      this.overlay.prepend(leader);
    }
    const label = { node, point, group, kind, leader };
    this.labels.push(label);
    return label;
  }

  clearModel(preserveWalls=false) {
    const retained=preserveWalls?this.artWalls:null;
    if(retained)this.root.remove(retained.group);
    else {this.artWalls?.dispose();this.artWalls=null;}
    this.generation++;
    this.root.traverse(object => {
      object.geometry?.dispose();
      if (Array.isArray(object.material)) object.material.forEach(m => m.dispose());
      else object.material?.dispose();
    });
    this.root.clear();
    if(retained)this.root.add(retained.group);
    this.overlay.replaceChildren();
    this.labels = [];
    this.planes = [];
    this.bars = [];
    for (const record of this.textureRecords.values()) record.texture?.dispose();
    this.textureRecords.clear();
  }

  setModel(model) {
    this.clearModel(true);
    this.model = model;
    this.artWalls?.setModel(model);
    const rows = model?.rows || [];
    const cohorts = model?.cohorts || [];
    this.sceneWidth = Math.max(3, rows.length * STEP);
    this.countMax = Math.max(1, ...rows.flatMap(r => r.cells.map(c => c.count)));
    this.shareMax = Math.max(0.1, ...rows.flatMap(r => r.cells.map(c => c.share)));
    // Shares use one common, human-readable scale across every cohort.
    this.shareMax = Math.min(1, Math.ceil(this.shareMax * 10) / 10);
    const left = -this.sceneWidth / 2;
    cohorts.forEach((cohort, ci) => {
      const group = new THREE.Group();
      this.root.add(group);
      const color = new THREE.Color(COLORS[ci % COLORS.length]);
      const vertices = [];
      for (let i = 0; i <= 4; i++) vertices.push(left - 0.15, HEIGHT * i / 4, -0.23, -left + 0.15, HEIGHT * i / 4, -0.23);
      for (let i = 0; i <= rows.length; i++) vertices.push(left + i * STEP, 0, -0.23, left + i * STEP, HEIGHT, -0.23);
      const grid = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false }));
      group.add(grid);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(this.sceneWidth + 0.3, 0.8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(0, -0.025, 0.1);
      group.add(floor);
      const baseline = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(left - 0.15, 0, 0), new THREE.Vector3(-left + 0.15, 0, 0)]), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }));
      group.add(baseline);
      const plane = { group, color, cohort, ci, grid, floor, baseline, artworks: [] };
      plane.label = this.label(`${cohort.label} · ${cohort.count}`, new THREE.Vector3(left - 0.2, -0.36, 0), { color: `#${color.getHexString()}`, group });
      this.planes.push(plane);
      rows.forEach((row, ri) => {
        const cell = row.cells.find(c => c.cohort === cohort.key);
        if (!cell) return;
        const material = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.15, emissive: color, emissiveIntensity: 0.06, transparent: true, opacity: 0.94 });
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.72, 1, 0.34), material);
        const data = { value: row.value, cohort: cohort.key, cell, ri, ci, mesh, color };
        mesh.userData.comparison = data;
        group.add(mesh);
        this.bars.push(data);
      });
    });
    rows.forEach((row, ri) => this.label(row.value, new THREE.Vector3(left + (ri + 0.5) * STEP, -1.35, 0), { kind: 'category' }));
    this.scaleLabel = this.label('', new THREE.Vector3(left - 0.2, HEIGHT + 0.22, 0), { kind: 'scale' });
    this.updateLayout();
    this.updateEmphasis();
    this.updateArtworks();
    this.reset();
  }

  setPresentation(next = {}) {
    const oldView = this.presentation.view, oldTravel=this.presentation.travel||0, oldSpread=this.presentation.spread, oldSlice=this.presentation.slice;
    this.presentation = { ...this.presentation, ...next };
    this.presentation.spread = clamp(Number(this.presentation.spread) || 0, 0, 1);
    this.updateLayout();
    this.updateEmphasis();
    if(oldView==='walls' && this.presentation.view!=='walls')this.updateArtworks();
    if (oldView !== this.presentation.view || (this.presentation.view==='walls' && (oldTravel!==(this.presentation.travel||0) || oldSpread!==this.presentation.spread || oldSlice!==this.presentation.slice))) this.reset();
    this.invalidate();
  }

  updateLayout() {
    if (!this.model) return;
    const { view, spread, slice, metric } = this.presentation;
    const walls=view==='walls';
    this.camera.fov=walls?62:37;this.camera.far=walls?1500:180;this.camera.updateProjectionMatrix();
    this.controls.minDistance=walls?2:5;
    this.controls.minAzimuthAngle=walls?-Infinity:-Math.PI*.46;
    this.controls.maxAzimuthAngle=walls?Infinity:Math.PI*.46;
    if(walls && !this.artWalls){
      this.artWalls=new AlbumWalls(this.root,()=>this.invalidate(),{wallLabel:this.wording.wallLabel});
      this.artWalls.setModel(this.model);
    }
    if(this.artWalls && !this.labels.some(label=>label.kind==='wall')){
      for(const anchor of this.artWalls.labelAnchors) {
        const label=this.label(anchor.text,anchor.point.clone(),{color:`#${new THREE.Color(anchor.color).getHexString()}`,kind:'wall'});
        label.cohort=anchor.cohort;label.wallAnchor=anchor;
      }
    }
    if(this.artWalls){this.artWalls.setPresentation({...this.presentation,visible:walls});this.artWalls.group.visible=walls;}
    this.canvas.setAttribute('aria-label',walls?this.wording.wallsAria:'Interactive 3D comparison. Drag or arrow keys to orbit, scroll to zoom. Exact values and selection are available in the comparison table.');
    const n = this.planes.length;
    const separation = 0.65 + spread * 3.05;
    const max = metric === 'count' ? this.countMax : this.shareMax;
    this.planes.forEach(plane => {
      const { group, ci } = plane;
      group.position.set(0, view === 'terraces' ? ci * 0.66 : 0, view === 'front' ? 0 : (ci - (n - 1) / 2) * separation);
      group.visible = !walls && (slice == null || slice === '' || slice === plane.cohort.key);
      const showAxis = view !== 'front' || (slice ? slice === plane.cohort.key : ci === 0);
      plane.grid.visible = showAxis;
      plane.floor.visible = showAxis;
      plane.baseline.visible = showAxis;
      plane.label.point.y = view === 'front' ? -0.33 - ci * 0.23 : -0.32;
    });
    this.bars.forEach(bar => {
      const value = metric === 'count' ? bar.cell.count : bar.cell.share;
      const height = Math.max(0.018, value / max * HEIGHT);
      const widthScale = view === 'front' ? 0.9 / Math.max(1, n) : 1;
      const x = -this.sceneWidth / 2 + (bar.ri + 0.5) * STEP + (view === 'front' ? (bar.ci - (n - 1) / 2) * 0.82 / n : 0);
      bar.mesh.position.set(x, height / 2, view === 'front' ? bar.ci * 0.005 : 0);
      bar.mesh.scale.set(widthScale, height, 1);
      bar.mesh.visible = bar.cell.count > 0;
    });
    const frontZ = view === 'front' ? 0 : (n - 1) / 2 * separation;
    this.labels.filter(l => l.kind === 'category').forEach(l => { l.point.z = frontZ + 0.4; l.point.y = view === 'front' ? -1.9 : -1.35; });
    if (this.scaleLabel) {
      this.scaleLabel.node.textContent = metric === 'count' ? `${max} items` : `${Math.round(max * 100)}% of each cohort`;
      this.scaleLabel.point.z = frontZ;
    }
    this.planes.forEach(p => p.artworks.forEach(tile => { tile.visible = view !== 'front'; }));
    this.invalidate();
  }

  setSelection(selection = {}) {
    const next = { value: selection.value || null, cohort: selection.cohort || null,
      ...(selection.observation ? { observation: selection.observation, cells: selection.cells || [], places: selection.places || new Set(), items: selection.items || [] } : {}) };
    const changed = !same(this.selection, next);
    this.selection = next;
    this.updateEmphasis();
    if (changed) this.updateArtworks();
  }

  setPreview(preview = {}) {
    this.preview = { value: preview.value || null, cohort: preview.cohort || null };
    this.updateEmphasis();
  }

  updateEmphasis() {
    const active = this.preview.value || this.preview.cohort ? this.preview : this.selection;
    const hasActive = !!(active.value || active.cohort || active.observation);
    this.artWalls?.setSelection(this.selection);
    this.artWalls?.setPreview(this.preview);
    this.bars.forEach(bar => {
      const lit = !hasActive || match(active, bar);
      bar.mesh.material.opacity = lit ? 0.96 : 0.17;
      bar.mesh.material.emissiveIntensity = hasActive && lit ? 0.48 : 0.06;
    });
    this.invalidate();
  }

  updateArtworks() {
    if (!this.model || this.presentation.view==='walls') return;
    const usedSources = new Set();
    this.planes.forEach(plane => {
      plane.artworks.forEach(tile => { plane.group.remove(tile); tile.geometry.dispose(); tile.material.dispose(); });
      plane.artworks = [];
      const selectedRow = this.model.rows.find(row => row.value === this.selection.value);
      const keys = selectedRow?.cells.find(c => c.cohort === plane.cohort.key)?.keys || (selectedRow ? [] : plane.cohort.keys) || [];
      const covers = keys.map(key => ({ key, clip: this.model.clipsByKey?.get(key) })).filter(item => coverSource(item.clip)).slice(0, 6);
      covers.forEach(({ clip }, i) => {
        const source = coverSource(clip);
        usedSources.add(source);
        const material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
        const tile = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.58), material);
        tile.position.set(-this.sceneWidth / 2 + 0.3 + i * 0.66, -0.86, 0.08);
        tile.visible = this.presentation.view !== 'front';
        plane.group.add(tile);
        plane.artworks.push(tile);
        let record = this.textureRecords.get(source);
        if (!record) {
          record = { texture: null, ready: false, failed: false };
          this.textureRecords.set(source, record);
          const generation = this.generation;
          if (isSpriteSource(source)) {
            record.texture = new THREE.Texture();
            record.texture.colorSpace = THREE.SRGBColorSpace;
            void spriteCovers.bitmap(clip, 128).then(bitmap => {
              if (this.disposed || generation !== this.generation || this.textureRecords.get(source) !== record) { bitmap?.close?.(); return; }
              if (!bitmap) {
                // The cell's page failed: the clip's own file, when it has one.
                const file = fileSource(clip);
                if (!file) { record.failed = true; this.invalidate(); return; }
                new THREE.TextureLoader().load(file, texture => {
                  if (this.disposed || generation !== this.generation || this.textureRecords.get(source) !== record) { texture.dispose(); return; }
                  record.texture.image = texture.image; record.texture.needsUpdate = true; record.ready = true; this.invalidate();
                }, undefined, () => { record.failed = true; this.invalidate(); });
                return;
              }
              // A canvas, not the bitmap: WebGL ignores flipY for an ImageBitmap.
              const canvas = document.createElement('canvas');
              canvas.width = bitmap.width; canvas.height = bitmap.height;
              canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close?.();
              record.texture.image = canvas; record.texture.needsUpdate = true; record.ready = true; this.invalidate();
            });
          } else record.texture = new THREE.TextureLoader().load(source, texture => {
            if (this.disposed || generation !== this.generation || this.textureRecords.get(source) !== record) { texture.dispose(); return; }
            texture.colorSpace = THREE.SRGBColorSpace;
            record.ready = true;
            this.invalidate();
          }, undefined, () => { record.failed = true; this.invalidate(); });
          record.texture.colorSpace = THREE.SRGBColorSpace;
        }
        material.map = record.texture;
        tile.userData.textureRecord = record;
      });
    });
    // Keep GPU texture residency bounded to the currently visible contact strips.
    for (const [source, record] of this.textureRecords) {
      if (!usedSources.has(source)) { record.texture?.dispose(); this.textureRecords.delete(source); }
    }
    this.invalidate();
  }

  pick(event) {
    if (this.disposed) return null;
    const box = this.canvas.getBoundingClientRect();
    this.pointer.set((event.clientX - box.left) / box.width * 2 - 1, -(event.clientY - box.top) / box.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if(this.presentation.view==='walls')return this.artWalls?.pick(this.raycaster)||null;
    const visible = this.bars.filter(b => b.mesh.visible && b.mesh.parent.visible).map(b => b.mesh);
    return this.raycaster.intersectObjects(visible, false)[0]?.object.userData.comparison || null;
  }

  reset() {
    if(this.presentation.view==='walls' && this.artWalls){
      const pose=this.artWalls.cameraPose(this.presentation.travel||0,this.camera.aspect);
      this.controls.maxDistance=200;
      this.setCamera(pose);this.fitted=true;return;
    }
    const width = this.sceneWidth || 10;
    const count = this.planes.length || 4;
    const depth = (count - 1) * (0.65 + this.presentation.spread * 3.05);
    const front = this.presentation.view === 'front';
    const terrace = this.presentation.view === 'terraces' ? (count - 1) * 0.66 : 0;
    this.controls.target.set(-0.4, 1.2 + terrace / 2, 0);
    const direction = front ? new THREE.Vector3(0, 0.015, 1) : new THREE.Vector3(0.34, 0.43, 0.85).normalize();
    // Fit actual near/far corners: a width-only fit crops the nearest depth
    // plane under perspective, especially with six widely separated cohorts.
    const corners = [];
    for (const x of [-width / 2 - 2.2, width / 2 + 0.4])
      for (const y of [-2.05, HEIGHT + terrace + 0.5])
        for (const z of front ? [0] : [-depth / 2 - 0.4, depth / 2 + 0.5]) corners.push(new THREE.Vector3(x, y, z));
    let distance = 10;
    for (let attempt = 0; attempt < 45; attempt++, distance *= 1.07) {
      this.camera.position.copy(this.controls.target).addScaledVector(direction, distance);
      this.camera.lookAt(this.controls.target);
      this.camera.updateMatrixWorld();
      const fits = corners.every(point => {
        const p = point.clone().project(this.camera);
        return Math.abs(p.x) < 0.9 && Math.abs(p.y) < 0.9 && p.z > -1 && p.z < 1;
      });
      if (fits) break;
    }
    this.controls.maxDistance = Math.max(48, distance * 2);
    this.programmaticCamera = true;
    this.controls.update();
    this.programmaticCamera = false;
    this.fitted = true;
    this.invalidate();
  }

  /**
   * Walk the album walls' aisle `distance` world units deeper (negative: back
   * toward the entrance), keeping the camera's angle to the walls. A fitted
   * camera takes the pose at the new travel; a turned or zoomed one slides
   * along the aisle with its target. The host hears the new travel, and the
   * camera when it is not fitted, as it does from the Walk aisle slider.
   */
  walk(distance) {
    if (this.presentation.view !== 'walls' || !this.artWalls || !Number.isFinite(distance)) return false;
    const { length } = this.artWalls.travelSpan(), from = this.presentation.travel || 0;
    if (!(length > 0)) return false;
    const travel = Math.round(clamp(from + distance / length, 0, 1) * 1e5) / 1e5;
    if (travel === from) return false;
    this.presentation = { ...this.presentation, travel };
    if (this.fitted) this.reset();
    else {
      const step = (travel - from) * length;
      this.camera.position.z -= step;
      this.controls.target.z -= step;
      this.programmaticCamera = true;
      this.controls.update();
      this.programmaticCamera = false;
      this.invalidate();
    }
    this.callbacks.onWalk(travel, this.fitted ? null : this.getCamera());
    return true;
  }

  getCamera() {
    return { position: this.camera.position.toArray(), target: this.controls.target.toArray() };
  }

  setCamera(value) {
    if (!value || ![value.position, value.target].every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))) return false;
    this.camera.position.fromArray(value.position);
    this.controls.target.fromArray(value.target);
    this.programmaticCamera = true;
    this.controls.update();
    this.programmaticCamera = false;
    this.fitted = false;
    this.invalidate();
    return true;
  }

  invalidate() {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.disposed) return;
      this.planes.forEach(p => p.artworks.forEach(tile => { tile.visible = this.presentation.view !== 'front' && !!tile.userData.textureRecord?.ready; }));
      this.renderer.render(this.scene, this.camera);
      const projected = new THREE.Vector3();
      const positions = this.labels.map(label => {
        if(label.wallAnchor)label.point.copy(label.wallAnchor.point);
        projected.copy(label.point);
        if (label.group) label.group.localToWorld(projected);
        projected.project(this.camera);
        const walls=this.presentation.view==='walls';
        const visible = projected.z >= -1 && projected.z <= 1 && (!label.group || label.group.visible)
          && (walls ? label.kind==='wall' && (!this.presentation.slice || label.cohort===this.presentation.slice) && Math.abs(projected.x)<1.1 : label.kind!=='wall');
        return { label, visible, x: (projected.x * 0.5 + 0.5) * this.width, y: (-projected.y * 0.5 + 0.5) * this.height };
      });
      // Screen-space type stays readable as geometry recedes. Resolve cohort
      // label collisions independently of the measured bars, with fine leaders.
      let previousY = -100;
      positions.filter(p => p.visible && ['cohort','wall'].includes(p.label.kind)).sort((a, b) => a.y - b.y).forEach(p => {
        p.labelY = clamp(Math.max(p.y, previousY + 35), 18, this.height - 18);
        previousY = p.labelY;
      });
      const categories = positions.filter(p => p.label.kind === 'category');
      const categorySpacing = categories.length > 1 ? Math.abs(categories.at(-1).x - categories[0].x) / (categories.length - 1) : 100;
      const categoryStep = Math.max(1, Math.ceil(90 / categorySpacing));
      positions.forEach(({ label, visible, x, y, labelY }) => {
        if (label.kind === 'category') {
          const index = categories.findIndex(p => p.label === label);
          visible &&= index % categoryStep === 0 || label.node.textContent === this.selection.value;
        }
        label.node.style.display = visible ? '' : 'none';
        const categoryHalf = label.kind === 'category' ? Math.min(label.node.offsetWidth / 2 + 12, this.width / 2) : 0;
        const screenX = label.kind === 'category' ? clamp(x, categoryHalf, this.width - categoryHalf) : clamp(x, label.node.offsetWidth + 8, this.width - 8);
        const categoryRoom = label.kind === 'category' ? label.node.offsetWidth * Math.sin(Math.PI * 24 / 180) / 2 + 26 : 18;
        const desiredY = label.kind === 'category' ? Math.max(y, previousY + 35) : (labelY ?? y);
        const screenY = clamp(desiredY, categoryRoom, this.height - categoryRoom);
        label.node.style.left = `${screenX}px`;
        label.node.style.top = `${screenY}px`;
        label.node.style.transform = label.kind === 'category' ? 'translate(-50%,0) rotate(-24deg)' : 'translate(-100%,-50%)';
        if (label.leader) {
          const dx = x - screenX, dy = y - screenY;
          label.leader.style.display = visible ? '' : 'none';
          label.leader.style.left = `${screenX}px`;
          label.leader.style.top = `${screenY}px`;
          label.leader.style.width = `${Math.hypot(dx, dy)}px`;
          label.leader.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
        }
      });
      this.rendered = true;
    });
  }

  getDiagnostics() {
    if(this.presentation.view==='walls' && this.artWalls)return {rendered:this.rendered,bars:0,...this.artWalls.getDiagnostics(),pickTargets:this.artWalls.getPickTargets(this.camera),renderCalls:this.renderer.info.render.calls,camera:this.getCamera()};
    return { rendered: this.rendered, bars: this.bars.length, visibleMeshCount: this.bars.filter(b => b.mesh.visible && b.mesh.parent.visible).length, visibleCohorts: this.planes.filter(p => p.group.visible).length, loadedArtwork: [...this.textureRecords.values()].filter(t => t.ready).length, failedArtwork: [...this.textureRecords.values()].filter(t => t.failed).length, renderCalls: this.renderer.info.render.calls, camera: this.getCamera() };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.unlistenWheel();
    this.controls.removeEventListener('change', this._onChange);
    this.controls.dispose();
    for (const [name, fn] of [['pointerdown', this._onDown], ['pointerup', this._onUp], ['pointermove', this._onMove], ['pointerleave', this._onLeave], ['pointercancel', this._onLeave], ['keydown', this._onKey], ['webglcontextlost', this._onContextLost], ['webglcontextrestored', this._onContextRestored]]) this.canvas.removeEventListener(name, fn);
    this.clearModel();
    this.renderer.dispose();
    this.canvas.remove();
    this.overlay.remove();
    this.errorNode?.remove();
  }
}
