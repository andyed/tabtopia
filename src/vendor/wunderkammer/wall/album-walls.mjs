/** Artwork-first comparison: every cohort identity has a place on two facing racks.
 * The host owns scope, camera/history and activation. This module only represents it.
 */
import * as THREE from '../three/build/three.module.js';
import { remote } from './media-policy.mjs';
import { spriteCovers, spriteSource, isSpriteSource } from './sprite-covers.mjs';
import { NEUTRAL_COPY } from './comparison-copy.mjs';

const COLORS = [0x90e4f4, 0xffda9c, 0xcbb7ff, 0xaaffaa, 0xffb8d0, 0xd7e7ff];
const ROWS = 8, PITCH = 1.04, TILE = .98, HEIGHT = ROWS * PITCH;
const ATLAS = 2048, PAD = 2;
/** A cover's cell in the atlas: 256 px for up to 400 covers, so a small collection
 * (a pet, a trip) stays sharp up close, else 128 px. Either way at most 128 MiB:
 * 400 covers fill 7 pages of 64, and 1,793 covers 8 pages of 256. */
const CELL = 128, SHARP_CELL = 256, SHARP_LIMIT = 400;
const cellFor = covers => (covers <= SHARP_LIMIT ? SHARP_CELL : CELL);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

/** A cover served by sprite-sheet cells is cropped from its sheet in _load. */
const coverSource = (clip, cell) => spriteCovers.has(clip) ? spriteSource(clip) : fileSource(clip, cell);

function fileSource(clip, cell = CELL) {
  const variants = (clip?.coverVariants || []).filter(v => v?.src && v.width > 0)
    .sort((a, b) => a.width - b.width);
  const source = (variants.find(v => v.width >= cell) || variants.at(-1))?.src || clip?.cover;
  if (!source) return null;
  try {
    const url = new URL(source, location.href);
    // Corpus media uses the same instance proxy as the existing comparison scene.
    if (!['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) return null;
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== location.origin)
      return remote(url.href);
    return url.href;
  } catch { return null; }
}

export class AlbumWalls {
  constructor(root, invalidate = () => {}, { onProgress = () => {}, wallLabel = NEUTRAL_COPY.wallLabel } = {}) {
    this.parent = root;
    this.invalidate = invalidate;
    this.onProgress = onProgress;
    // Each group's label: its value, its count and the collection's noun for its items.
    this.wallLabel = wallLabel;
    this.root = new THREE.Group();
    this.root.name = 'Artwork aisle';
    this.group = this.root;
    root.add(this.root);
    this.presentation = { spread: .65, slice: null };
    this.selection = { value: null, cohort: null };
    this.preview = { value: null, cohort: null };
    this.generation = 0;
    this.disposed = false;
    this.pages = [];
    this.racks = []; this.places = [];
    this.meshes = [];
    this.labelAnchors = [];
    this.requests = new Set();
    this.resources = new Set();
    this.loadedArtwork = 0;
    this.failedArtwork = 0;
    this.totalTiles = 0;
    this.totalDepth = 1;
    this.cell = CELL;
  }

  _own(resource) { this.resources.add(resource); return resource; }

  _clear() {
    this.generation++;
    for (const image of this.requests) {
      image.onload = image.onerror = null;
      image.src = '';
    }
    this.requests.clear();
    this.root.clear();
    for (const resource of this.resources) resource.dispose();
    this.resources.clear();
    for (const page of this.pages) { page.canvas.width = page.canvas.height = 1; }
    this.pages = []; this.racks = []; this.meshes = []; this.labelAnchors = []; this.places = []; this.floor = this.floorGrid = null;
    this.loadedArtwork = 0; this.failedArtwork = 0; this.totalTiles = 0;
    this.highlightedTiles = 0;
  }

  _page() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ATLAS;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#26333b'; ctx.fillRect(0, 0, ATLAS, ATLAS);
    const cell = this.cell, perRow = ATLAS / cell, perPage = perRow ** 2, k = cell / CELL;
    // Distinct, honest placeholders remain when artwork is unavailable.
    for (let slot = 0; slot < perPage; slot++) {
      const x = slot % perRow * cell, y = Math.floor(slot / perRow) * cell;
      ctx.strokeStyle = '#6b7c83'; ctx.lineWidth = 2 * k;
      ctx.strokeRect(x + 32 * k, y + 32 * k, 64 * k, 64 * k);
      ctx.beginPath(); ctx.moveTo(x + 40 * k, y + 86 * k); ctx.lineTo(x + 61 * k, y + 62 * k);
      ctx.lineTo(x + 84 * k, y + 86 * k); ctx.stroke();
    }
    const texture = this._own(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const material = this._own(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    material.onBeforeCompile = shader => {
      shader.vertexShader = `attribute vec2 atlasOffset; varying vec2 vAtlasOffset;\n${shader.vertexShader}`;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvAtlasOffset = atlasOffset;');
      shader.fragmentShader = `varying vec2 vAtlasOffset;\n${shader.fragmentShader}`;
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        #ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D(map, vAtlasOffset + vMapUv * ${((cell - 2 * PAD) / ATLAS).toFixed(10)});
          diffuseColor *= sampledDiffuseColor;
        #endif`);
    };
    material.customProgramCacheKey = () => `wunderkammer-cover-atlas-v1-${cell}`;
    const page = { canvas, ctx, texture, material, slots: 0, perRow, perPage };
    this.pages.push(page);
    return page;
  }

  setModel(model, { preserveOrder = false } = {}) {
    if (this.disposed) return;
    // Metric, category rank and lens changes reuse decoded images and stable geometry.
    const keys = [...new Set(model.cohorts.flatMap(group => group.keys))].sort();
    const cell = cellFor(keys.length);
    const sources = new Map(keys.map(key => [key, coverSource(model.clipsByKey.get(key), cell)]));
    const signature = JSON.stringify([model.cohorts.map(group => [group.key, group.label, group.count, preserveOrder ? group.keys : [...group.keys].sort()]), [...sources]]);
    if (signature === this.signature) { this.model = model; this._highlight(); return; }
    this._clear(); this.model = model; this.signature = signature; this.cell = cell;
    const generation = this.generation;
    const slots = new Map(), queue = [];
    // Stable identity order is independent of metric, category ranking and hover.
    for (const key of keys) {
      let page = this.pages.at(-1);
      if (!page || page.slots === page.perPage) page = this._page();
      const slot = page.slots++, x = slot % page.perRow * cell, y = Math.floor(slot / page.perRow) * cell;
      const record = { key, page, x, y, u: (x + PAD) / ATLAS, v: 1 - (y + cell - PAD) / ATLAS };
      slots.set(key, record);
      const source = sources.get(key);
      const clip = model.clipsByKey.get(key);
      if (source) queue.push({ ...record, source, clip, file: isSpriteSource(source) ? fileSource(clip) : source }); else this.failedArtwork++;
    }
    const backingMaterial = this._own(new THREE.MeshBasicMaterial({ color: 0x10151e }));
    const floorMaterial = this._own(new THREE.MeshBasicMaterial({ color: 0x0c111b, side: THREE.DoubleSide }));
    const matrix = new THREE.Matrix4(), dummy = new THREE.Object3D();
    let depth = 0;
    model.cohorts.forEach((cohort, cohortIndex) => {
      const sorted = preserveOrder ? [...cohort.keys] : [...cohort.keys].sort();
      const leftCount = Math.ceil(sorted.length / 2);
      const columns = Math.max(1, Math.ceil(leftCount / ROWS));
      const bayDepth = columns * PITCH;
      const rack = new THREE.Group(); rack.userData.cohort = cohort.key;
      this.root.add(rack);
      const walls = [], color = COLORS[cohortIndex % COLORS.length];
      // Each cover's place, for keyboard moves: columns[c][r] per wall, column 0 nearest the entrance, row 0 at the top.
      const grid = { [-1]: [], [1]: [] };
      for (const side of [-1, 1]) {
        const wall = new THREE.Group(); wall.userData.side = side; rack.add(wall); walls.push(wall);
        const background = new THREE.Mesh(this._own(new THREE.PlaneGeometry(bayDepth + .12, HEIGHT + .16)), backingMaterial);
        background.rotation.y = side === -1 ? Math.PI / 2 : -Math.PI / 2;
        background.position.set(side * .025, HEIGHT / 2, -depth - bayDepth / 2 + PITCH / 2);
        wall.add(background);
        const railMaterial = this._own(new THREE.MeshBasicMaterial({ color, toneMapped: false }));
        for (const y of [-.1, HEIGHT + .1]) {
          const rail = new THREE.Mesh(this._own(new THREE.BoxGeometry(.045, .045, bayDepth + .25)), railMaterial);
          rail.position.set(0, y, -depth - bayDepth / 2 + PITCH / 2); wall.add(rail);
        }
        const sideKeys = side === -1 ? sorted.slice(0, leftCount) : sorted.slice(leftCount);
        const byPage = new Map();
        sideKeys.forEach((key, index) => {
          const slot = slots.get(key), column = Math.floor(index / ROWS), row = index % ROWS;
          if (!byPage.has(slot.page)) byPage.set(slot.page, []);
          byPage.get(slot.page).push({ key, cohort: cohort.key, slot, column, row });
        });
        for (const [page, items] of byPage) {
          const geometry = this._own(new THREE.PlaneGeometry(TILE, TILE));
          const offsets = new Float32Array(items.length * 2);
          const mesh = this._own(new THREE.InstancedMesh(geometry, page.material, items.length));
          mesh.name = `${cohort.label} covers`;
          mesh.userData.items = items;
          items.forEach((item, i) => {
            const place = { key: item.key, cohort: cohort.key, rack: cohortIndex, side, column: item.column, row: item.row, depth: depth + item.column * PITCH, mesh, index: i };
            (grid[side][item.column] ||= [])[item.row] = place; this.places.push(place);
            dummy.position.set(0, HEIGHT - PITCH * (item.row + .5), -depth - item.column * PITCH);
            dummy.rotation.set(0, side === -1 ? Math.PI / 2 : -Math.PI / 2, 0);
            dummy.scale.set(1, 1, 1); dummy.updateMatrix(); matrix.copy(dummy.matrix);
            mesh.setMatrixAt(i, matrix); mesh.setColorAt(i, new THREE.Color(1, 1, 1));
            offsets[i * 2] = item.slot.u; offsets[i * 2 + 1] = item.slot.v;
          });
          geometry.setAttribute('atlasOffset', new THREE.InstancedBufferAttribute(offsets, 2));
          mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
          mesh.computeBoundingBox(); mesh.computeBoundingSphere();
          wall.add(mesh); this.meshes.push(mesh); this.totalTiles += items.length;
        }
      }
      const label = { text: this.wallLabel(cohort.label, cohort.count),
        point: new THREE.Vector3(0, HEIGHT + .6, -depth), cohort: cohort.key, color, visible: true };
      this.labelAnchors.push(label);
      this.racks.push({ group: rack, walls, cohort: cohort.key, start: depth, length: bayDepth, label, grid });
      depth += bayDepth + 1.2;
    });
    this.totalDepth = Math.max(1, depth - 1.2);
    const floor = new THREE.Mesh(this._own(new THREE.PlaneGeometry(40, this.totalDepth + 18)), floorMaterial);
    floor.rotation.x = -Math.PI / 2; floor.position.set(0, -.18, -this.totalDepth / 2 + 3);
    this.root.add(floor); this.floor = floor;
    const lineMaterial = this._own(new THREE.LineBasicMaterial({ color: 0x23303c, transparent: true, opacity: .8 }));
    const points = [];
    for (let z = 6; z > -this.totalDepth - 2; z -= PITCH * 2) {
      points.push(new THREE.Vector3(-12, -.17, z), new THREE.Vector3(12, -.17, z));
    }
    const lines = new THREE.LineSegments(this._own(new THREE.BufferGeometry().setFromPoints(points)), lineMaterial);
    // The floor and its grid, for the warehouse (warehouse-show.mjs), which lights them for the white void.
    this.root.add(lines); this.floorGrid = lines;
    this.setPresentation(this.presentation); this._highlight();
    this._load(queue, generation); this.invalidate();
  }

  _load(queue, generation) {
    let next = 0;
    const run = () => {
      if (this.disposed || generation !== this.generation || next >= queue.length) return;
      const item = queue[next++];
      if (isSpriteSource(item.source)) {
        // Crop the cell at the rack's cell size, then draw it like a file. A
        // page that fails leaves the clip's own file, when it has one.
        this.pendingSprites = (this.pendingSprites || 0) + 1;
        void spriteCovers.bitmap(item.clip, this.cell).then(bitmap => {
          this.pendingSprites--;
          if (this.disposed || generation !== this.generation) { bitmap?.close?.(); return; }
          if (!bitmap && item.file) { loadFile(item, item.file); return; }
          if (bitmap) this._drawArtwork(item, bitmap, bitmap.width, bitmap.height); else this.failedArtwork++;
          bitmap?.close?.();
          this.invalidate(); this.onProgress(this.getDiagnostics()); run();
        });
        return;
      }
      loadFile(item, item.source);
    };
    const loadFile = (item, source) => {
      const image = new Image();
      this.requests.add(image); image.decoding = 'async';
      const done = okay => {
        this.requests.delete(image); image.onload = image.onerror = null;
        if (this.disposed || generation !== this.generation) return;
        if (okay && image.naturalWidth && image.naturalHeight) this._drawArtwork(item, image, image.naturalWidth, image.naturalHeight);
        else this.failedArtwork++;
        this.invalidate(); this.onProgress(this.getDiagnostics()); run();
      };
      // Without the instance proxy a remote cover loads directly, and an atlas
      // texture drawn from it must be requested with CORS or the upload fails.
      if (/^https?:/i.test(source) && new URL(source).origin !== location.origin) image.crossOrigin = 'anonymous';
      image.onload = () => done(true); image.onerror = () => done(false); image.src = source;
    };
    for (let i = 0; i < Math.min(8, queue.length); i++) run();
  }

  /** The centre square of an artwork, filling its whole cell with edge bleed
   * around the sampled interior. */
  _drawArtwork(item, image, width, height) {
    const edge = Math.min(width, height);
    const sx = (width - edge) / 2, sy = (height - edge) / 2;
    try {
      item.page.ctx.drawImage(image, sx, sy, edge, edge, item.x, item.y, this.cell, this.cell);
      item.page.texture.needsUpdate = true; this.loadedArtwork++;
    } catch { this.failedArtwork++; }
  }

  setPresentation({ spread = this.presentation.spread, slice = this.presentation.slice } = {}) {
    this.presentation = { spread: clamp(Number(spread) || 0, 0, 1), slice };
    this.gap = 4.8 + this.presentation.spread * 6;
    for (const rack of this.racks) {
      rack.group.visible = slice === null || rack.cohort === slice;
      rack.label.visible = rack.group.visible;
      for (const wall of rack.walls) wall.position.x = wall.userData.side * this.gap / 2;
    }
    this.root.updateMatrixWorld(true); this.invalidate();
  }

  setSelection(pick) { this.selection = pick || {}; this._highlight(); }
  setPreview(pick) { this.preview = pick || {}; this._highlight(); }

  _matches(pick) {
    // An observation: the exact (group, item) places its cells cite, plus cited items wherever they sit.
    if (pick?.observation) { const items = new Set(pick.items || []); return item => !!pick.places?.has(`${item.cohort}\u0000${item.key}`) || items.has(item.key); }
    if (pick?.key) return item => item.key === pick.key && (!pick.cohort || pick.cohort === item.cohort);
    if (!pick?.value && !pick?.cohort) return null;
    if (!pick.value) return item => item.cohort === pick.cohort;
    const row = this.model?.allRows.find(row => row.value === pick.value);
    const sets = new Map((row?.cells || []).map(cell => [cell.cohort, new Set(cell.keys)]));
    return item => (!pick.cohort || item.cohort === pick.cohort) && !!sets.get(item.cohort)?.has(item.key);
  }

  setHighlightColors(colors = null) { this.highlightColors = colors; this._highlight(); }

  _highlight() {
    const selected = this._matches(this.selection), preview = this._matches(this.preview);
    this.highlightedTiles = 0;
    const color = new THREE.Color();
    for (const mesh of this.meshes) {
      mesh.userData.items.forEach((item, i) => {
        const active = preview ? preview(item) : selected ? selected(item) : true;
        if (active) this.highlightedTiles++;
        const shade = active ? 1 : .17;
        const tint = this.highlightColors?.get(item.key);
        mesh.setColorAt(i, tint === undefined ? color.setRGB(shade, shade, shade) : color.set(tint));
      });
      mesh.instanceColor.needsUpdate = true;
    }
    this.invalidate();
  }

  pick(raycaster) {
    if (!this.root.visible) return null;
    this.root.updateMatrixWorld(true);
    const visible = this.meshes.filter(mesh => mesh.parent?.parent?.visible);
    for (const hit of raycaster.intersectObjects(visible, false)) {
      const item = hit.object.userData.items[hit.instanceId];
      if (item) return { key: item.key, cohort: item.cohort, value: null };
    }
    return null;
  }

  getPickTargets(camera) {
    this.root.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    const point = new THREE.Vector3(), matrix = new THREE.Matrix4(), raycaster = new THREE.Raycaster();
    const targets = [];
    for (const mesh of this.meshes) {
      if (!mesh.parent?.parent?.visible || !this.root.visible) continue;
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        point.setFromMatrixPosition(matrix).applyMatrix4(mesh.matrixWorld).project(camera);
        if (point.z < -1 || point.z > 1 || Math.abs(point.x) > .92 || Math.abs(point.y) > .88) continue;
        raycaster.setFromCamera(new THREE.Vector2(point.x, point.y), camera);
        const item = mesh.userData.items[i], hit = this.pick(raycaster);
        if (hit?.key === item.key && hit.cohort === item.cohort) {
          targets.push({ key: item.key, cohort: item.cohort, x: point.x, y: point.y, z: point.z });
          if (targets.length >= 24) return targets;
        }
      }
    }
    return targets;
  }

  /** A cover's centre in world space; walls move apart with the spread. */
  worldOf(place, out = new THREE.Vector3()) {
    const matrix = new THREE.Matrix4(); place.mesh.getMatrixAt(place.index, matrix); this.root.updateMatrixWorld(true);
    return out.setFromMatrixPosition(matrix).applyMatrix4(place.mesh.matrixWorld);
  }
  /** The travel (0..1) that stands the camera a few steps before a cover's column. */
  travelFor(place) {
    const { start, length } = this.travelSpan();
    return length ? clamp((place.depth - start - 1.5) / length, 0, 1) : 0;
  }

  /** Where the shown racks begin, and the world units travel 0..1 walks past them. */
  travelSpan() {
    const shown = this.racks.filter(rack => rack.group.visible);
    const first = shown[0], last = shown.at(-1);
    const start = first?.start || 0, end = last ? last.start + last.length : this.totalDepth;
    return { start, length: Math.max(0, end - start - 3.2) };
  }

  cameraPose(travel = 0, aspect = 1.5) {
    const { start, length } = this.travelSpan();
    const amount = clamp(Number(travel) || 0, 0, 1);
    // The entry pose fills the frame with recognizable covers and a long vanishing aisle.
    const portrait = aspect < 1;
    const z = 3.9 - start - amount * length;
    const y = HEIGHT * .49;
    const x = portrait ? -this.gap * .12 : -this.gap * .045;
    return { position: [x, y, z], target: [portrait ? this.gap * .16 : 0, y + .08, z - (portrait ? 8 : 10)] };
  }

  getDiagnostics() {
    return { totalTiles: this.totalTiles, loadedArtwork: this.loadedArtwork, failedArtwork: this.failedArtwork,
      atlasPages: this.pages.length, visibleCohorts: this.racks.filter(rack => rack.group.visible).length,
      highlightedTiles: this.highlightedTiles, pendingArtwork: this.requests.size + (this.pendingSprites || 0),
      visibleMeshCount: this.meshes.filter(mesh => mesh.parent?.parent?.visible).length,
      atlasBytes: this.pages.length * ATLAS * ATLAS * 4, cellSize: this.cell, perPage: (ATLAS / this.cell) ** 2, drawMeshes: this.meshes.length,
      totalDepth: this.totalDepth, gap: this.gap || 0, travelLength: this.travelSpan().length };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this._clear(); this.parent.remove(this.root); this.model = null;
  }
}
