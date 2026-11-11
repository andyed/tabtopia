/**
 * Details on zoom, no click (peer-study ledger idea 27).
 *
 * Port of PivotViewer's rule, seajax@0293770 v2/app/pivot/PivotViewer.js:1618-1650
 * (BSD-2-Clause, Copyright (c) Microsoft Corporation): the view counts as
 * zoomed in when any visible item is wider than half the free width (the stage
 * minus the details rail) or taller than half the stage; the item nearest the
 * centre, shifted left by half the rail so the pane does not cover it, gets the
 * details. Zooming back out hides them.
 *
 * Wunderkammer's differences:
 * - Hysteresis. PivotViewer opens and closes at the same 50%, so a landing near
 *   it flaps. Here the pane opens above OPEN and stays until every visible item
 *   falls below CLOSE.
 * - Stickiness. The current item keeps the details while its rectangle still
 *   covers the adjusted centre, so two near-equal neighbours cannot trade it.
 * - The rail width is the pane's width whether or not it is open, so opening
 *   it changes neither the threshold nor the centre. The pane overlays a fixed
 *   stage; nothing here moves the camera.
 *
 * Pure: it reads geometry and returns a decision. wall.mjs decides when to ask
 * (when a zoom lands) and drives the preview path with the answer.
 */

/** Open when an item exceeds this share of the free view. */
export const ZOOM_DETAIL_OPEN = 0.5;
/** Once open, close only when every item is below this share. */
export const ZOOM_DETAIL_CLOSE = 0.4;

/**
 * @param {object} o
 * @param {Iterable<{clip:{id:string}, x:number, y:number, w:number, h:number}>} o.tiles world-space tiles
 * @param {{x:number, y:number, scale:number}} o.pose landed camera (stage-local translate)
 * @param {{width:number, height:number}} o.stage
 * @param {number} [o.rail] px of the stage's right edge the details pane covers when open
 * @param {string|null} [o.current] clip id currently shown by zoom, if any
 * @param {boolean} [o.open] whether zoom details are already showing (selects the close threshold)
 * @returns {{id:string, ratio:number}|null} the clip to show, or null when not zoomed in
 */
export function zoomDetailCandidate({ tiles, pose, stage, rail = 0, current = null, open = false }) {
  const W = stage?.width, H = stage?.height, s = pose?.scale;
  if (!(W > 0 && H > 0 && s > 0) || !Number.isFinite(pose.x) || !Number.isFinite(pose.y)) return null;
  const freeW = Math.max(1, W - Math.max(0, Math.min(W, rail || 0)));
  const cx = freeW / 2, cy = H / 2;
  let ratio = 0, best = null, bestDist = Infinity, keep = false;
  for (const t of tiles) {
    if (!t?.clip) continue;
    const left = pose.x + t.x * s, top = pose.y + t.y * s, w = t.w * s, h = t.h * s;
    if (!(w > 0 && h > 0) || left >= W || top >= H || left + w <= 0 || top + h <= 0) continue;
    ratio = Math.max(ratio, w / freeW, h / H);
    const d = Math.hypot(left + w / 2 - cx, top + h / 2 - cy);
    if (d < bestDist) { bestDist = d; best = t.clip.id; }
    if (current && t.clip.id === current && cx >= left && cx <= left + w && cy >= top && cy <= top + h) keep = true;
  }
  if (!best || ratio <= (open ? ZOOM_DETAIL_CLOSE : ZOOM_DETAIL_OPEN)) return null;
  return { id: keep ? current : best, ratio };
}
