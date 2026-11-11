/**
 * Pan/zoom transform for the wall.
 *
 * Input grammar follows design-tool convention rather than map convention:
 * scroll pans, ctrl/cmd-scroll zooms (which is also what a trackpad pinch
 * emits), drag pans. Anyone arriving from Figma/Sketch already knows it, and
 * plain-scroll-to-zoom makes a trackpad unusable.
 */

import { EdgePan, boundPan } from './edge-pan.mjs';

const MIN_SCALE = 0.015;
const MAX_SCALE = 6;
/** Movement below this stays a click; above it becomes a pan. */
const DRAG_SLOP = 4;
/**
 * Zoom is eased by a CSS transition on the canvas transform, so the compositor
 * interpolates and nothing re-rasterises until the camera lands. Translate is
 * affine in scale for an anchored zoom, so the point under the cursor stays
 * pinned through the interpolation. Buttons take a longer arc than wheel ticks,
 * which must not lag the fingers.
 */
const ZOOM_MS = { wheel: 140, button: 260 };
const ZOOM_EASE = 'cubic-bezier(0.22, 0.7, 0.2, 1)';
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Viewport {
  /**
   * @param {HTMLElement} stage clipping viewport
   * @param {HTMLElement} canvas transformed content
   * @param {(v: Viewport) => void} onChange
   */
  constructor(stage, canvas, onChange) {
    this.stage = stage;
    this.canvas = canvas;
    this.onChange = onChange || (() => {});
    this.x = 0;
    this.y = 0;
    this.scale = 1;
    this.fitted = false;
    this.content = { w: 1, h: 1 };
    this.items = [];
    this.bounds = null;
    this.panMode = 'free';
    this.enabled = true;
    this.edge = new EdgePan();
    this.edgeUndo = null;
    this._edgePhase = '';
    this._frame = 0;
    this._drag = null;
    this._touches = new Map(); // active touch pointers, for pinch zoom
    this._pinch = null;        // { dist, mid } of the previous two-finger frame
    this.mirror = null;  // optional (transform, transition) => void for layers that share the camera
    this.scaleFloor = null; // optional () => number: the smallest useful scale (Fit of what there is to show)
    this.settlesAt = 0;  // performance.now() at which the current transition lands
    this._transition = 0; // duration of the transition to apply on the next write
    this._bind();
    new ResizeObserver(() => this.resetEdge()).observe(stage);
  }

  /** Guard every write — one NaN in the transform blanks the entire wall. */
  _set(x, y, scale) {
    this.fitted = false;
    const s = Number.isFinite(scale) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)) : this.scale;
    this.x = Number.isFinite(x) ? x : this.x;
    this.y = Number.isFinite(y) ? y : this.y;
    this.scale = s;
    this._schedule();
  }

  _schedule() {
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = 0;
      const now = performance.now();
      // A write during a running transition keeps easing (a pan mid-zoom stays
      // smooth); a write after it lands is immediate.
      const ms = this._transition || (now < this.settlesAt ? Math.max(40, this.settlesAt - now) : 0);
      this._transition = 0;
      this.canvas.style.transition = ms ? `transform ${Math.round(ms)}ms ${ZOOM_EASE}` : 'none';
      if (ms) this.settlesAt = Math.max(this.settlesAt, now + ms);
      // Measure the stage BEFORE writing the transform. A rect read after the
      // write forces style recalculation on every frame of a gesture; read
      // first, the frame's layout is already clean and the read is free. The
      // rect is handed to onChange so it need not measure again.
      const rect = this.stage.getBoundingClientRect();
      // Keep the canvas strictly 2D: Chrome cannot pick a raster scale for a
      // layer whose screen transform has perspective and falls back to full
      // world resolution, which is hundreds of MB for this many tiles.
      this.canvas.style.transform = `translate3d(${this.x.toFixed(2)}px, ${this.y.toFixed(2)}px, 0) scale(${this.scale.toFixed(4)})`;
      this.mirror?.({ x: this.x, y: this.y, scale: this.scale }, this.canvas.style.transition);
      this.onChange(this, rect);
    });
  }

  /** A direct zoom gesture is under way (a touch pinch, or an edge drag that
   *  is enlarging the wall). Its writes are immediate, so settlesAt cannot say
   *  when it lands; the gesture's end notifies onChange once more instead. */
  get zooming() {
    return !!this._pinch || (!!this._drag && this._edgePhase === 'zoom');
  }

  /** Land any transition now: the next write is immediate. */
  _cancelZoom() { this._transition = 0; this.settlesAt = 0; }

  /** Read compositor motion when interrupting an eased action. Direct gesture
   * deltas may share a pending frame; their accumulated input pose is already
   * authoritative and must not be replaced by the preceding painted frame. */
  visiblePose() {
    if (!this._transition && performance.now() >= this.settlesAt) return this.snapshot();
    const matrix = new DOMMatrixReadOnly(getComputedStyle(this.canvas).transform);
    return { x: matrix.e, y: matrix.f, scale: matrix.a, fitted: this.fitted };
  }

  interrupt() {
    const pose = this.visiblePose();
    this._cancelZoom();
    this.x = pose.x; this.y = pose.y; this.scale = pose.scale;
    this.canvas.style.transition = 'none';
    this.canvas.style.transform = `translate3d(${pose.x}px, ${pose.y}px, 0) scale(${pose.scale})`;
    return pose;
  }

  setContent(w, h, items = []) {
    this.resetEdge(); this._cancelZoom();
    this.content = { w: Math.max(1, w), h: Math.max(1, h) };
    this.setItems(items);
  }

  /** Replace the pannable item set without disturbing Fit content or a live gesture. */
  setItems(items = []) {
    this.items = items.map(({ x, y, w, h }) => ({ x, y, w, h }));
    this.bounds = null;
    if (this.items.length) {
      let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
      for (const t of this.items) {
        x = Math.min(x, t.x); y = Math.min(y, t.y);
        right = Math.max(right, t.x + t.w); bottom = Math.max(bottom, t.y + t.h);
      }
      this.bounds = { x, y, w: right - x, h: bottom - y };
    }
  }

  snapshot() { return { x: this.x, y: this.y, scale: this.scale, fitted: this.fitted }; }

  restore(view) {
    this.resetEdge(); this._cancelZoom();
    this._set(view.x, view.y, view.scale);
    this.fitted = view.fitted;
  }

  setPanMode(mode) {
    this.panMode = ['free', 'bounded', 'edge'].includes(mode) ? mode : 'free';
    this.fit();
  }

  _feedback(phase) {
    const canUndo = !!this.edgeUndo;
    if (phase === this._edgePhase && canUndo === this._canUndo && this.panMode === this._reportedPanMode) return;
    this._edgePhase = phase; this._canUndo = canUndo; this._reportedPanMode = this.panMode;
    this.stage.dataset.edgePan = phase;
    this.stage.dispatchEvent(new CustomEvent('edge-pan', { detail: { phase, canUndo, mode: this.panMode } }));
  }

  resetEdge() {
    if (this._drag) {
      this.lastDragDistance = this._drag.moved;
      if (this.stage.hasPointerCapture?.(this._drag.id)) this.stage.releasePointerCapture(this._drag.id);
      this._drag = null;
      this.stage.classList.remove('dragging');
    }
    this.edge.reset();
    this.edgeUndo = null;
    this._gestureStart = null;
    this._feedback('');
  }

  undoEdge() {
    if (!this.edgeUndo) return false;
    const view = this.edgeUndo;
    this.resetEdge(); this._cancelZoom();
    this._set(view.x, view.y, view.scale);
    this.fitted = view.fitted;
    return true;
  }

  _pan(dx, dy, { drag = false, point = null } = {}) {
    if (this._transition || performance.now() < this.settlesAt) this.interrupt();
    if (this.panMode === 'free' || !this.bounds) {
      this._set(this.x + dx, this.y + dy, this.scale);
      return;
    }
    const r = this.stage.getBoundingClientRect();
    const next = this.edge.move(this.snapshot(), dx, dy, {
      area: { w: r.width, h: r.height }, bounds: this.bounds, items: this.items,
      point: point || { x: r.width / 2, y: r.height / 2 },
      zoom: drag && this.panMode === 'edge', maxScale: MAX_SCALE,
    });
    if (next.phase === 'zoom' && !this.edgeUndo) this.edgeUndo = this._gestureStart;
    this._set(next.x, next.y, next.scale);
    this._feedback(next.phase);
  }

  /** Canvas-space rect currently visible, for culling and lazy loading.
   *  Pass a stage rect read earlier in the frame to avoid a forced layout. */
  visibleRect(margin = 400, r = this.stage.getBoundingClientRect()) {
    return {
      x: (-this.x - margin) / this.scale,
      y: (-this.y - margin) / this.scale,
      w: (r.width + margin * 2) / this.scale,
      h: (r.height + margin * 2) / this.scale
    };
  }

  zoomAt(clientX, clientY, factor, { duration = ZOOM_MS.wheel } = {}) {
    this.resetEdge();
    const r = this.stage.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    // Keep the canvas point under the cursor pinned across the scale change.
    // `scale` is already the landing value of any transition in flight, so
    // rapid ticks compose onto one target and the compositor eases between.
    const visible = this.visiblePose();
    const cx = (px - visible.x) / visible.scale;
    const cy = (py - visible.y) / visible.scale;
    // Zooming out stops at Fit of what there is to show: a canvas of empty space says nothing.
    const floor = Math.max(MIN_SCALE, Math.min(this.scale, this.scaleFloor?.() ?? MIN_SCALE));
    const next = Math.min(MAX_SCALE, Math.max(floor, this.scale * factor));
    // Clamped at the floor (or ceiling) the zoom cannot change, so it must not
    // write at all. Re-anchoring at the same scale still moved the camera by
    // rounding (~0.1 px through the eased visible pose), which cleared
    // `fitted`, restarted the ease, and repainted the whole overview: ten
    // zoom-out ticks at Fit cost 109 overview paints, ~27,000 draws and 28
    // frames over 33 ms on the Music Atlas (2026-10-13).
    if (Math.abs(next - this.scale) <= this.scale * 1e-9) return;
    let view = { x: px - cx * next, y: py - cy * next, scale: next };
    if (this.panMode !== 'free' && this.bounds) view = boundPan(view, { w: r.width, h: r.height }, this.bounds);
    this._transition = reducedMotion() ? 0 : duration;
    if (!duration || reducedMotion()) this._cancelZoom(); // direct pinch/reduced motion lands now
    this._set(view.x, view.y, view.scale);
  }

  /** Two touch points: zoom about their midpoint by the change in spread, and pan by the midpoint's motion. */
  _pinchMove() {
    const [a, b] = [...this._touches.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (this._pinch && this._pinch.dist > 0) {
      // Scale around the previous anchor, then carry it to the new midpoint.
      // Scaling around the new midpoint first would count its travel twice.
      this.zoomAt(this._pinch.mid.x, this._pinch.mid.y, dist / this._pinch.dist, { duration: 0 });
      this._pan(mid.x - this._pinch.mid.x, mid.y - this._pinch.mid.y);
    }
    this._pinch = { dist, mid };
  }

  /** Ease the camera to a new position at the current scale (a "scroll to"). */
  panTo(x, y, { duration = ZOOM_MS.button } = {}) {
    this.resetEdge();
    this._transition = reducedMotion() ? 0 : duration;
    if (!duration || reducedMotion()) this._cancelZoom();
    this._set(x, y, this.scale);
  }

  zoomBy(factor) {
    const r = this.stage.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor, { duration: ZOOM_MS.button });
  }

  panBy(dx, dy) {
    this.resetEdge();
    this._pan(-dx, -dy);
  }

  /** Modest screen-space margin, also used by the layout's aspect calculation. */
  fitPadding(r = this.stage.getBoundingClientRect()) {
    return Math.min(24, Math.min(r.width, r.height) * 0.04);
  }

  /** The view that frames the whole canvas with padding, without applying it. */
  fitTarget(pad = this.fitPadding()) {
    const r = this.stage.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const s = Math.min((r.width - pad * 2) / this.content.w, (r.height - pad * 2) / this.content.h);
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
    return { x: (r.width - this.content.w * scale) / 2, y: (r.height - this.content.h * scale) / 2, scale };
  }

  /** Frame the whole canvas with padding. */
  fit(pad = this.fitPadding()) {
    this.resetEdge(); this._cancelZoom();
    const view = this.fitTarget(pad);
    if (!view) return;
    this._set(view.x, view.y, view.scale);
    this.fitted = true;
  }

  /** Ease to an arbitrary camera (translate and scale interpolate together, so an anchored zoom stays anchored). */
  animateTo(x, y, scale, { duration = ZOOM_MS.button } = {}) {
    this.resetEdge();
    this._transition = reducedMotion() ? 0 : duration;
    if (!duration || reducedMotion()) this._cancelZoom();
    this._set(x, y, scale);
  }

  /** Centre a canvas-space rect, optionally choosing a scale to frame it. */
  focus(rect, targetScale) {
    this.resetEdge(); this._cancelZoom();
    const r = this.stage.getBoundingClientRect();
    const scale = targetScale
      ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, targetScale))
      : Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(r.width / (rect.w + 160), r.height / (rect.h + 160))));
    this._set(
      r.width / 2 - (rect.x + rect.w / 2) * scale,
      r.height / 2 - (rect.y + rect.h / 2) * scale,
      scale
    );
  }

  _bind() {
    this.stage.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // Trackpad pinch arrives here as ctrl+wheel with small deltas.
        this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      } else if (e.shiftKey) {
        this.panBy(e.deltaY, 0);
      } else {
        this.panBy(e.deltaX, e.deltaY);
      }
    }, { passive: false });

    this.stage.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      if (e.button !== 0 && e.button !== 1) return;
      // Capture is deliberately NOT taken here. Capturing on pointerdown
      // retargets the subsequent `click` to the capturing element, so every
      // tile click would be swallowed by the stage and nothing would ever
      // open. Capture is taken lazily in pointermove, once the gesture has
      // proven itself a drag.
      // Controls overlaid on the stage (undo, row title) are not gesture starts.
      if (e.target.closest?.('.edge-undo, .row-title, .review-tip, .tray-return, .tray-filter, .group-filter')) return;
      if (e.pointerType === 'touch') {
        this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this._touches.size === 2) {
          // A second finger turns the drag into a pinch; the tap/drag state is abandoned.
          this.resetEdge(); this._drag = null; this._pinch = null; this.lastDragDistance = 99;
          try { this.stage.setPointerCapture(e.pointerId); } catch {}
          this._pinchMove();
          return;
        }
        if (this._touches.size > 2) return;
      }
      this.resetEdge();
      this._gestureStart = this.snapshot();
      this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0, captured: false };
    });

    this.stage.addEventListener('pointermove', (e) => {
      if (!this.enabled) return;
      if (e.pointerType === 'touch' && this._touches.has(e.pointerId)) {
        this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this._touches.size >= 2) { this._pinchMove(); return; }
      }
      if (!this._drag || this._drag.id !== e.pointerId) return;
      const dx = e.clientX - this._drag.x;
      const dy = e.clientY - this._drag.y;
      this._drag.x = e.clientX;
      this._drag.y = e.clientY;
      this._drag.moved += Math.abs(dx) + Math.abs(dy);

      if (!this._drag.captured && this._drag.moved > DRAG_SLOP) {
        this._drag.captured = true;
        this.stage.setPointerCapture(e.pointerId);
        this.stage.classList.add('dragging');
      }
      if (!this._drag.captured) return;   // still ambiguous; could be a click
      const r = this.stage.getBoundingClientRect();
      this._pan(dx, dy, { drag: true, point: { x: e.clientX - r.left, y: e.clientY - r.top } });
    });

    const end = (e) => {
      if (e.pointerType === 'touch' && this._touches.has(e.pointerId)) {
        this._touches.delete(e.pointerId);
        const pinched = !!this._pinch;
        if (this._touches.size < 2) this._pinch = null;
        if (this.stage.hasPointerCapture?.(e.pointerId)) this.stage.releasePointerCapture(e.pointerId);
        if (pinched && !this._pinch) this._schedule(); // the pinch has landed
      }
      if (!this._drag || this._drag.id !== e.pointerId) return;
      // Report drag distance so a click handler can tell a tap from a pan.
      this.lastDragDistance = this._drag.moved;
      const wasCaptured = this._drag.captured;
      const edgeZoomed = this._edgePhase === 'zoom';
      this._drag = null;
      this.edge.reset();
      this._gestureStart = null;
      this._feedback(this.edgeUndo ? 'done' : '');
      this.stage.classList.remove('dragging');
      if (wasCaptured && this.stage.hasPointerCapture?.(e.pointerId)) {
        this.stage.releasePointerCapture(e.pointerId);
      }
      if (edgeZoomed) this._schedule(); // the edge zoom has landed
    };
    this.stage.addEventListener('pointerup', end);
    this.stage.addEventListener('pointercancel', end);
  }
}
