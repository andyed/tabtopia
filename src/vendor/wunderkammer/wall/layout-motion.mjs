/** Bounded FLIP: layout once, animate only the visible reading neighbourhood. */
const active = new Map();
const MAX_ANIMATIONS = 64;

function localRectangle(transform, to) {
  const match = /^matrix(3d)?\(([^)]+)\)$/.exec(transform || '');
  if (!match) return null;
  const values = match[2].split(',').map(Number);
  const is3d = !!match[1];
  if (values.length !== (is3d ? 16 : 6) || values.some(v => !Number.isFinite(v))) return null;
  // Our keyframes contain only positive axis-aligned scale and translation.
  const sx = values[0], sy = values[is3d ? 5 : 3];
  if (!(sx > 0 && sy > 0)) return null;
  return { x: values[is3d ? 12 : 4], y: values[is3d ? 13 : 5], w: to.w * sx, h: to.h * sy };
}

function cancelActive() {
  const records = [...active.values()];
  active.clear();
  for (const { animation } of records) animation.cancel();
}

/** Call BEFORE writing the next layout. Only the at-most-64 animations we own
 * need a computed-style read; their local matrices exclude the camera's scale.
 * Finish every read before cancellation so reads never follow our own writes. */
export function captureLayoutMotion(previous, { readTransform = node => getComputedStyle(node).transform } = {}) {
  const captured = new Map(previous);
  for (const [key, { node, animation, to }] of active) {
    if (!captured.has(key) || node.isConnected === false || animation.playState === 'finished') continue;
    const rect = localRectangle(readTransform(node), to);
    if (rect) captured.set(key, { ...captured.get(key), ...rect });
  }
  // Include removed and now-offscreen nodes: otherwise an old fill effect can
  // keep overriding their new transform after a rapid regroup.
  cancelActive();
  return captured;
}

/** Nodes travelling on a layout animation right now. Their transforms move
 * them independently of the laid-out geometry, so a picture of the wall must
 * leave them to the DOM until they land. */
export function movingNodes() { return new Set([...active.values()].map(entry => entry.node)); }

export function animateLayout(previous, next, nodes, view, stage, { limit = 64, duration = 220 } = {}) {
  // captureLayoutMotion normally already cancelled them. This also prevents
  // stale effects when a caller switches to reduced motion or an empty layout.
  cancelActive();
  if (!previous.size || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) return 0;
  const visible = t => t.x * view.scale + view.x < stage.width && (t.x + t.w) * view.scale + view.x > 0
    && t.y * view.scale + view.y < stage.height && (t.y + t.h) * view.scale + view.y > 0;
  const candidates = [...next].filter(([key, t]) => previous.has(key) && visible(t))
    .sort((a, b) => b[1].w * b[1].h - a[1].w * a[1].h).slice(0, Math.max(0, Math.min(MAX_ANIMATIONS, limit)));
  let count = 0;
  for (const [key, to] of candidates) {
    const from = previous.get(key), node = nodes.get(key);
    if (!node || (from.x === to.x && from.y === to.y && from.w === to.w && from.h === to.h)) continue;
    const animation = node.animate([
      { transform: `translate(${from.x}px, ${from.y}px) scale(${from.w / to.w}, ${from.h / to.h})`, transformOrigin: '0 0' },
      { transform: `translate(${to.x}px, ${to.y}px) scale(1, 1)`, transformOrigin: '0 0' },
    ], { duration, easing: 'cubic-bezier(.22,.7,.2,1)' });
    active.set(key, { node, animation, to });
    const release = () => { if (active.get(key)?.animation === animation) active.delete(key); };
    animation.onfinish = release;
    animation.oncancel = release;
    count++;
  }
  return count;
}
