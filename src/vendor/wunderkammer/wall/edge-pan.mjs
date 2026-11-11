// Screen-space pan constraint and a gesture-local zoom conversion. The
// Viewport remains the camera owner; this object returns candidate transforms.
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// Edge zoom has to be pushed for. 32 px of travel past an edge was a flick: a
// drag that merely arrived in a corner zoomed, and the landing opened details
// on zoom (Andy, 2026-10-20). 120 px is a deliberate push past the edge cue.
export const DEAD_ZONE = 120;
export const ZOOM_DISTANCE = 320;
// Only motion aimed into the edge is push: within about 53° of straight in.
// A pan along an edge drifts into it (a fitting axis is frozen, so every pixel
// of drift is blocked), and that drift must not add up to a zoom. Judged per
// event on the raw pointer motion; pulling back always counts, so reversal
// still unwinds at once.
export const PUSH_ALIGNMENT = 0.6;

/**
 * Constrain a camera so a pan only ever reveals clipped content.
 *
 * Per axis, `a` puts the collection's near edge at the margin and `b` its far
 * edge at the opposite margin. When the collection overflows the stage
 * (b < a) any position between them shows something that was clipped, so the
 * range is open. When it fits (a ≤ b) there is nothing to reveal, and sliding
 * a fully visible collection around inside the stage is motion without
 * information — so, given the position the gesture started `from`, the axis
 * is frozen: a fully visible axis does not move, and a partly clipped one may
 * move only toward full visibility, never past it. Without `from` (an anchored
 * zoom, which has no prior position on the new scale) the old clamp applies.
 */
export function boundPan(view, area, bounds, from = null) {
  const margin = Math.min(24, area.w * 0.04, area.h * 0.04);
  const axis = (position, current, lo, hi, length) => {
    const a = margin - lo * view.scale;
    const b = length - margin - hi * view.scale;
    if (from === null || b < a) return clamp(position, Math.min(a, b), Math.max(a, b));
    if (current < a) return clamp(position, current, a);   // near edge clipped: may come back, not go further
    if (current > b) return clamp(position, b, current);   // far edge clipped: likewise
    return current;                                         // fully visible: nothing to reveal
  };
  return { x: axis(view.x, from?.x, bounds.x, bounds.x + bounds.w, area.w),
    y: axis(view.y, from?.y, bounds.y, bounds.y + bounds.h, area.h), scale: view.scale };
}

export class EdgePan {
  constructor() { this.latch = null; }
  reset() { this.latch = null; }

  move(view, dx, dy, { area, bounds, items, point, zoom, maxScale }) {
    if (!bounds) return { ...view, x: view.x + dx, y: view.y + dy, phase: '' };
    if (!zoom) {
      this.reset();
      const next = boundPan({ ...view, x: view.x + dx, y: view.y + dy }, area, bounds, view);
      return { ...next, phase: next.x !== view.x + dx || next.y !== view.y + dy ? 'limit' : '' };
    }
    const travel = Math.hypot(dx, dy);
    if (!this.latch) {
      const proposed = { ...view, x: view.x + dx, y: view.y + dy };
      const base = boundPan(proposed, area, bounds, view);
      const ox = proposed.x - base.x, oy = proposed.y - base.y;
      const length = Math.hypot(ox, oy);
      if (length < 0.01) return { ...base, phase: '' };
      const normal = { x: ox / length, y: oy / length };
      // A blocked event that is not aimed at the edge is drift: pan, no latch.
      if (dx * normal.x + dy * normal.y < PUSH_ALIGNMENT * travel) return { ...base, phase: '' };
      // Pick real content at the approached edge, not an empty pointer anchor.
      const query = {
        x: Math.abs(normal.x) > 0.1 ? (normal.x > 0 ? bounds.x : bounds.x + bounds.w) : (point.x - base.x) / base.scale,
        y: Math.abs(normal.y) > 0.1 ? (normal.y > 0 ? bounds.y : bounds.y + bounds.h) : (point.y - base.y) / base.scale,
      };
      let anchor = query, nearest = Infinity;
      for (const item of items) {
        const x = clamp(query.x, item.x, item.x + item.w);
        const y = clamp(query.y, item.y, item.y + item.h);
        const distance = Math.hypot(x - query.x, y - query.y);
        if (distance < nearest) { anchor = { x, y }; nearest = distance; }
      }
      this.latch = { base, normal, anchor, pressure: 0 };
      // Only the blocked portion of this event contributes to edge pressure.
      dx = ox; dy = oy;
    }

    const l = this.latch;
    const normalDelta = dx * l.normal.x + dy * l.normal.y;
    // The first event's delta is already its blocked part, so it passed the gate above.
    const aimed = normalDelta < 0 || normalDelta >= PUSH_ALIGNMENT * Math.hypot(dx, dy);
    const pressure = l.pressure + (aimed ? normalDelta : 0);
    const corner = Math.abs(l.normal.x) > 0.001 && Math.abs(l.normal.y) > 0.001;
    // Tangential motion still travels along the boundary. Clamp against the
    // latched scale so changing scale cannot alternate pan/zoom every frame.
    l.base = boundPan({ ...l.base,
      x: l.base.x + (corner ? 0 : dx - normalDelta * l.normal.x),
      y: l.base.y + (corner ? 0 : dy - normalDelta * l.normal.y) }, area, bounds, l.base);
    if (pressure < 0) {
      const next = boundPan({ ...l.base,
        x: l.base.x + l.normal.x * pressure,
        y: l.base.y + l.normal.y * pressure }, area, bounds, l.base);
      this.reset();
      return { ...next, phase: '' };
    }
    const limit = Math.max(1, Math.min(2, maxScale / l.base.scale));
    // Discard excess pressure at the cap: reversing should respond at once.
    l.pressure = Math.min(pressure, DEAD_ZONE + ZOOM_DISTANCE * Math.log(limit));
    const factor = Math.exp(Math.max(0, l.pressure - DEAD_ZONE) / ZOOM_DISTANCE);
    const scale = l.base.scale * factor;
    return { x: l.base.x + l.anchor.x * (l.base.scale - scale),
      y: l.base.y + l.anchor.y * (l.base.scale - scale), scale,
      phase: factor > 1 ? 'zoom' : limit === 1 ? 'limit' : 'edge' };
  }
}
