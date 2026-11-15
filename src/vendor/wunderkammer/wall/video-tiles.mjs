/**
 * Video on tiles: an item with a `video` plays it where its cover sits.
 *
 * A tile field (spatial/lib/instanced.js) draws every cover from one atlas in
 * one draw call, and an atlas slot is a poor home for a moving picture: a slot
 * upload costs about 1 ms of main thread and flushes are throttled to one per
 * 120 ms (atlas.js), so video through the atlas would run at a few frames a
 * second and stall everything else. Instead each playing video gets its own
 * quad, laid over its tile every frame from the field's own placement
 * (worldCentre, worldOrientation, size) and drawn just in front of it with a
 * polygon offset. The cover in the atlas stays underneath as the poster: a
 * video not yet decoded, paused for the budget, or failed shows it.
 *
 * Only `budget` videos play at once, the nearest in view; the rest hold their
 * poster. Frames drive rendering: a playing video asks for a render each time
 * it presents a frame (requestVideoFrameCallback), so an on-demand view renders
 * at the video's rate, and a view with no video in sight renders nothing new.
 *
 * Capture: `seek(t)` pauses every video in view at its own phase of a shared
 * clock and resolves once each has the frame, so a seeked capture gets the
 * same pixels on every run whatever the machine's speed.
 */
import * as THREE from '../three/build/three.module.js';

/** Longest a capture waits on one video's frame before drawing what it has. */
const SEEK_TIMEOUT_MS = 4000;
/**
 * After 'seeked', how long to wait for the frame to be presented. A seek that
 * lands on the frame already showing presents nothing new, so the callback
 * never comes; the element holds the right frame by then either way.
 */
const PRESENT_GRACE_MS = 50;
/** Seek to the middle of a frame (at 30 fps), so rounding cannot pick its neighbour. */
const HALF_FRAME = 1 / 60;

/** A stable phase in [0, 1) per key, so a wall of loops does not pulse in step. */
export function phaseOf(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10007) / 10007;
}

/** Texture repeat and offset that fill a quad of `quad` aspect with a `media` aspect picture, cropping the overflow. */
export function coverFit(quad, media) {
  if (!(quad > 0) || !(media > 0)) return { rx: 1, ry: 1, ox: 0, oy: 0 };
  if (media > quad) { const rx = quad / media; return { rx, ry: 1, ox: (1 - rx) / 2, oy: 0 }; }
  const ry = media / quad; return { rx: 1, ry, ox: 0, oy: (1 - ry) / 2 };
}

/**
 * Where a tile field's item is drawn now, for VideoTiles: its world centre,
 * orientation (including a row's sweep) and size, and its opacity, which folds
 * in membership, a DOM twin standing in, and dimming.
 */
export function fieldPlacement(field) {
  return {
    get count() { return field.count; },
    place(i, centre, quaternion, size) {
      const strength = field.aOpacity.array[i];
      if (!(strength > 0)) return 0;
      field.worldCentre(i, centre); field.worldOrientation(i, quaternion);
      size.set(field.sizes[i * 2], field.sizes[i * 2 + 1], 1);
      return strength;
    },
  };
}

export class VideoTiles {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene  world-space parent for the video quads
   * @param {{ count:number, place:(i:number, centre:THREE.Vector3, quaternion:THREE.Quaternion, size:THREE.Vector3) => number }} opts.placement
   *   where item i is drawn now, in world space, as a unit plane facing +z
   *   scaled by `size`; returns how strongly it is drawn (0 = not at all,
   *   1 = full). See fieldPlacement().
   * @param {(index:number) => (string|null)} opts.sourceOf  the item's video URL, or null
   * @param {(index:number) => string} [opts.keyOf]  stable identity, for the phase
   * @param {() => void} [opts.onFrame]  a video presented a new frame: render
   * @param {number} [opts.budget]  how many may play at once
   * @param {number} [opts.resident]  how many <video> elements may exist at once
   * @param {() => Iterable<[number, HTMLVideoElement]>} [opts.standIns]  videos
   *   playing elsewhere for an item (a DOM card standing in for its tile),
   *   which seek() holds on the same clock
   */
  constructor({ scene, placement, sourceOf, keyOf = String, onFrame = () => {}, budget = 24, resident = 40, standIns = () => [] }) {
    this.scene = scene; this.placement = placement; this.onFrame = onFrame; this.standIns = standIns;
    this.budget = budget; this.resident = Math.max(budget, resident);
    this.keyOf = keyOf;
    this.sources = new Map();
    for (let i = 0; i < placement.count; i++) { const src = sourceOf(i); if (src) this.sources.set(i, src); }
    this.entries = new Map();   // index -> { video, texture, mesh, phase, used }
    this.frozen = false;        // capture: nothing plays on its own
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this._c = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._n = new THREE.Vector3();
    this._f = new THREE.Vector3(); this._d = new THREE.Vector3();
    this._frustum = new THREE.Frustum(); this._pv = new THREE.Matrix4(); this._sphere = new THREE.Sphere();
    this._frame = 0;
  }

  get count() { return this.sources.size; }

  _entry(i) {
    let e = this.entries.get(i);
    if (e) return e;
    const video = document.createElement('video');
    // Muted, inline and looping: the only autoplay a browser allows without a
    // gesture, and a tile has no sound to give anyway.
    video.muted = true; video.loop = true; video.playsInline = true; video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.src = this.sources.get(i);
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter; texture.generateMipmaps = false;
    const material = new THREE.MeshBasicMaterial({
      map: texture, toneMapped: false,
      // Coplanar with its tile: pull it toward the camera in depth so it wins
      // the depth test without moving it, which would show at a grazing angle.
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.matrixAutoUpdate = false; mesh.visible = false; mesh.renderOrder = 1; mesh.frustumCulled = false;
    mesh.userData.videoIndex = i;
    this.scene.add(mesh);
    e = { index: i, video, texture, material, mesh, phase: phaseOf(this.keyOf(i)), used: 0, ready: false, failed: false, fit: '' };
    video.addEventListener('loadeddata', () => { e.ready = true; this.onFrame(); }, { once: true });
    video.addEventListener('error', () => { e.failed = true; mesh.visible = false; this.onFrame(); }, { once: true });
    // A frame presented is a frame worth drawing; the loop re-arms itself while
    // the entry lives and stops on dispose.
    const presented = () => { if (e.disposed) return; this.onFrame(); e.rvfc = video.requestVideoFrameCallback?.(presented); };
    e.rvfc = video.requestVideoFrameCallback?.(presented);
    this.entries.set(i, e);
    return e;
  }

  _dispose(e) {
    e.disposed = true;
    if (e.rvfc !== undefined) e.video.cancelVideoFrameCallback?.(e.rvfc);
    e.video.pause(); e.video.removeAttribute('src'); e.video.load();
    this.scene.remove(e.mesh); e.texture.dispose(); e.material.dispose();
    this.entries.delete(e.index);
  }

  /** Lay a video's quad exactly over its tile, as placed by the last update(). */
  _place(e, centre, quaternion, size) {
    const w = size.x, h = size.y;
    e.mesh.matrix.compose(centre, quaternion, size);
    e.mesh.matrixWorldNeedsUpdate = true;
    const vw = e.video.videoWidth, vh = e.video.videoHeight;
    const key = `${w / h}:${vw}x${vh}`;
    if (vw && vh && key !== e.fit) {
      e.fit = key;
      const { rx, ry, ox, oy } = coverFit(w / h, vw / vh);
      e.texture.repeat.set(rx, ry); e.texture.offset.set(ox, oy);
    }
  }

  /**
   * Per rendered frame, after the field's own update: choose who plays (the
   * nearest `budget` in view and drawn at full strength), lay their quads over
   * their tiles, and pause the rest on their posters.
   */
  update(camera) {
    if (!this.sources.size) return;
    this._frame++;
    camera.updateMatrixWorld();
    this._pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._pv);
    const cam = camera.position, places = new Map();
    const seen = [];
    for (const i of this.sources.keys()) {
      // A tile drawn at less than full strength (hidden, stood in for by a DOM
      // twin, dimmed) keeps its poster.
      if (i >= this.placement.count || this.placement.place(i, this._c, this._q, this._n) < 0.99) continue;
      this._sphere.set(this._c, Math.hypot(this._n.x, this._n.y) / 2);
      if (!this._frustum.intersectsSphere(this._sphere)) continue;
      // Tiles draw front faces only, as do these quads: a tile showing the
      // camera its back (the far side of the floating space's sphere) is not
      // drawn, so it spends no decoder from the budget.
      if (this._f.set(0, 0, 1).applyQuaternion(this._q).dot(this._d.subVectors(this._c, cam)) >= 0) continue;
      seen.push([this._c.distanceToSquared(cam), i]);
      places.set(i, [this._c.clone(), this._q.clone(), this._n.clone()]);
    }
    seen.sort((a, b) => a[0] - b[0]);
    const playing = new Set(seen.slice(0, this.budget).map(([, i]) => i));
    for (const [i, e] of this.entries) if (!playing.has(i)) { e.mesh.visible = false; if (!e.video.paused) e.video.pause(); }
    for (const i of playing) {
      const e = this._entry(i);
      e.used = this._frame;
      if (e.failed) continue;
      this._place(e, ...places.get(i));
      e.mesh.visible = e.ready;
      if (!this.frozen && e.video.paused) e.video.play().catch(() => {});
    }
    // Decoders are the scarce thing: keep the most recently used and let the rest go.
    if (this.entries.size > this.resident) {
      const idle = [...this.entries.values()].filter(e => !playing.has(e.index)).sort((a, b) => a.used - b.used);
      for (const e of idle.slice(0, this.entries.size - this.resident)) this._dispose(e);
    }
  }

  /**
   * Capture: hold every video and show each one's frame at `seconds` on a
   * shared clock, offset by its phase. Call update() first, so the set in view
   * is current; resolves when every visible video has the frame decoded.
   */
  async seek(seconds) {
    this.frozen = true;
    const waits = [];
    for (const e of this.entries.values()) {
      if (e.used !== this._frame || e.failed) continue;   // only the ones update() chose
      waits.push(this._seekVideo(e.video, e.phase, seconds).then(() => {
        // A video that timed out before its first frame keeps its poster.
        if (e.failed || e.video.readyState < 2) return;
        e.texture.needsUpdate = true; e.mesh.visible = true;
      }));
    }
    // A DOM card standing in for a tile plays its own <video>: hold it on the
    // same clock, or a capture shows it running at wall-clock speed.
    for (const [i, video] of this.standIns()) waits.push(this._seekVideo(video, phaseOf(this.keyOf(i)), seconds));
    await Promise.all(waits);
  }

  /** A video's first frame, or its failure, or the timeout: a capture never hangs on one file. */
  _loaded(video) {
    if (video.readyState >= 2) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(resolve, SEEK_TIMEOUT_MS);
      const done = () => { clearTimeout(timer); resolve(); };
      video.addEventListener('loadeddata', done, { once: true });
      video.addEventListener('error', done, { once: true });
    });
  }

  /** Pause `video` on its frame at `seconds` on the shared clock, offset by its phase. */
  async _seekVideo(video, phase, seconds) {
    video.pause();
    await this._loaded(video);
    const d = video.duration;
    if (!(d > 0) || video.error) return;
    video.pause();
    const t = Math.min(d - HALF_FRAME, ((seconds + phase * d) % d + d) % d + HALF_FRAME);
    if (Math.abs(video.currentTime - t) < 1e-3) return;
    await new Promise(resolve => {
      let settled = false;
      const done = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
      // A page that is not compositing (hidden, or a backgrounded pane) never
      // presents the frame; draw what the element holds rather than hang.
      const timer = setTimeout(done, SEEK_TIMEOUT_MS);
      video.addEventListener('seeked', () => {
        // 'seeked' can fire before the frame is ready to sample; the next
        // presented frame is the one at the new time, unless it was already showing.
        video.requestVideoFrameCallback?.(done);
        setTimeout(done, PRESENT_GRACE_MS);
      }, { once: true });
      video.currentTime = t;
    });
  }

  /** Leave capture: every video in view plays on from where it stands. */
  release() {
    this.frozen = false;
    for (const [, video] of this.standIns()) video.play().catch(() => {});
    this.onFrame();
  }

  stats() {
    let ready = 0, playing = 0, failed = 0, visible = 0;
    for (const e of this.entries.values()) {
      if (e.ready) ready++; if (!e.video.paused) playing++; if (e.failed) failed++; if (e.mesh.visible) visible++;
    }
    return { items: this.sources.size, resident: this.entries.size, ready, playing, visible, failed, frozen: this.frozen };
  }

  dispose() {
    for (const e of [...this.entries.values()]) this._dispose(e);
    this.geometry.dispose();
  }
}
