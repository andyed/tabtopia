/**
 * A sideways wheel or trackpad scroll is a walk along a hallway's length.
 *
 * Both hallways (the wall page's aisle and the comparison page's album walls)
 * use three.js OrbitControls, which reads only a wheel's deltaY, as a dolly.
 * This listener runs before it, in the capture phase on the same canvas, and
 * handles the gestures whose motion is mostly sideways. The host's walk()
 * moves the camera along the aisle without turning it, so a view at an angle
 * to a wall slides along that wall.
 *
 * A gesture is held to the axis it starts on until the wheel rests for
 * REST_MS. A vertical swipe that jitters sideways is never a walk, and a
 * sideways swipe that jitters vertically is never a zoom.
 */
export const REST_MS = 200;
// World units walked per pixel of deltaX: a cover column (1.04) per ~64 px.
export const WALK_PER_PIXEL = 1 / 64;

/** A wheel delta in pixels. Line and page modes scale as OrbitControls scales deltaY. */
export function wheelPixels(delta, mode) {
  const n = Number(delta);
  if (!Number.isFinite(n)) return 0;
  return mode === 1 ? n * 16 : mode === 2 ? n * 100 : n;
}

/**
 * Walk on sideways scroll. `walk(distance)` receives world units, positive
 * deeper into the aisle (deltaX > 0, the direction the Walk aisle slider
 * increases). `active()` false leaves every wheel event to OrbitControls.
 * Returns a function that removes the listener.
 */
export function listenSideScroll(canvas, { walk, active = () => true }) {
  let axis = null, last = -Infinity;
  const onWheel = event => {
    // A trackpad pinch arrives as ctrl+wheel; it stays a zoom.
    if (event.ctrlKey || !active()) { axis = null; return; }
    const x = wheelPixels(event.deltaX, event.deltaMode), y = wheelPixels(event.deltaY, event.deltaMode);
    if (axis === null || event.timeStamp - last > REST_MS) axis = Math.abs(x) > Math.abs(y) ? 'x' : 'y';
    last = event.timeStamp;
    if (axis !== 'x') return;
    // Consumed even at either end of the aisle: an unhandled sideways swipe
    // would otherwise become the browser's Back or Forward gesture.
    event.preventDefault();
    event.stopImmediatePropagation();
    walk(x * WALK_PER_PIXEL);
  };
  canvas.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => canvas.removeEventListener('wheel', onWheel, { capture: true });
}
