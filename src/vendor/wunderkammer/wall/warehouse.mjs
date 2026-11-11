/**
 * The image warehouse, also asked for as the "matrix guns view": "Cats. Lots
 * of cats." Rows of the aisle's racks rush out of a white void and lock into
 * shelving around the camera, which drops from above into the aisle's
 * entrance. Then the lights go down, the extra rows sink through the floor,
 * and what is left is the aisle as it would have opened, ready to browse.
 * docs/AISLE.md, "The warehouse".
 *
 * Timing and placement only, with no three.js: warehouse-show.mjs plays these
 * frames live, and scripts/warehouse-video.mjs seeks the same frames one at a
 * time. Times are seconds from the moment the covers are in.
 */
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
/** Exact at both ends, so the last frame is the aisle's own camera to the last bit. */
const lerp = (a, b, t) => a * (1 - t) + b * t;
const lerp3 = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
export const expoOut = t => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
export const cubicInOut = t => (t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const between = (t, t0, t1) => cubicInOut(clamp((t - t0) / (t1 - t0)));

export const TIMING = Object.freeze({
  fly: 1,             // seconds for one rack to arrive
  far: 140,           // world units down the hall a rack starts
  wide: 2.2,          // outer rows start this many times their lane offset out
  narrow: 1.8,        // by now the aisle has narrowed from fully spread to its own spread
  drop: 3.4,          // the camera's descent from above into the entrance
  name: [0, .9],      // "Cats.", also shown while the covers load
  lots: [1.1, 3.4],   // "Lots of cats."
  dim: 3.6,           // the lights start to go down and the extra rows sink
  end: 4.8,
  fade: .25,          // a caption's fade in or out
});

/** Most racks one show draws, real and copied: the long reel drew 228 smoothly. */
export const RACK_BUDGET = 240;
/** How far down the hall copies reach: past the white fog's far edge (80). */
const REACH = 90;
/** Lanes of shelving, centre first out; lane 0 is the aisle itself. */
const LANES = [-2, -1, 0, 1, 2];

/**
 * Every rack the show draws. The aisle's own racks are lane 0, copy 0
 * (`real`); the rest are copies of them: the centre lane repeats down the
 * hall, and two parallel rows each side start one hallway behind the entrance
 * and one further on, at a different point in the rack order so the copies do
 * not line up. Racks arrive nearest first, then outward and deeper.
 *
 * `racks` and `depth` are the aisle's (AlbumWalls `racks.length`,
 * `totalDepth`); `gap` is the distance between a rack's walls once settled.
 */
export function warehouseRows({ racks, depth, gap, budget = RACK_BUDGET }) {
  if (!(Number.isInteger(racks) && racks > 0) || !(depth > 0) || !(gap > 0)) return [];
  const period = depth + 4, laneX = gap + 2.4;
  let ahead = clamp(Math.ceil(REACH / period), 1, 4), behind = 1, lanes = LANES;
  const copies = lane => (lane === 0 ? [0, ahead - 1] : [-behind, ahead]);
  const count = () => lanes.reduce((n, lane) => { const [a, b] = copies(lane); return n + racks * (b - a + 1); }, 0);
  // Over budget, shed in this order: copies down the hall past two, the
  // outermost rows, the last copies, the rows behind the entrance, the side rows.
  // Five lanes are the long reel's look, so they outlast depth.
  while (count() > budget) {
    if (ahead > 2) ahead--;
    else if (lanes.length === 5) lanes = [-1, 0, 1];
    else if (ahead > 1) ahead--;
    else if (behind) behind = 0;
    else if (lanes.length === 3) lanes = [0];
    else break;
  }
  const stagger = Math.min(.05, .6 / racks), rows = [];
  for (const lane of lanes) {
    const [first, last] = copies(lane);
    const phase = lane === 0 ? 0 : (((lane * .37 + .5) % 1) + 1) % 1 * period;
    for (let copy = first; copy <= last; copy++) for (let rack = 0; rack < racks; rack++) rows.push({
      lane, copy, rack, real: lane === 0 && copy === 0, x: lane * laneX, z: -(copy * period + phase),
      start: .1 + stagger * rack + .22 * Math.max(0, copy) + .18 * Math.abs(lane) + (copy < 0 ? .1 : 0),
    });
  }
  return rows;
}

/**
 * The scene at time `t`. `entry` is the camera the aisle ends on, `{ position,
 * target }`; `gap` the settled distance between a rack's walls; `gapSpread`
 * the distance at full spread, where the show starts; `height` a rack's height,
 * which the copies sink by and one more.
 *
 * Returns each row's position (`racks`, in `rows` order), the walls' `gap`,
 * the camera, `light` (1 the white void, 0 the aisle's own dark), the fog's
 * near and far, each caption's opacity, and `done`.
 */
export function warehouseFrame(t, rows, { entry, gap, gapSpread, height }) {
  const time = Number.isFinite(t) ? Math.max(0, t) : 0;
  const sink = clamp((time - TIMING.dim) / (TIMING.end - TIMING.dim)) ** 3 * (height + 1);
  const racks = rows.map(row => {
    const k = expoOut(clamp((time - row.start) / TIMING.fly));
    return { x: row.x * lerp(TIMING.wide, 1, k), y: row.real ? 0 : -sink, z: row.z - TIMING.far * (1 - k) };
  });
  // From high above and behind the entrance, down into it.
  const high = { position: [entry.position[0], entry.position[1] + 10, entry.position[2] + 30], target: [0, 0, entry.position[2] - 25] };
  const drop = between(time, 0, TIMING.drop);
  const light = 1 - between(time, TIMING.dim, TIMING.end);
  const [n0, n1] = TIMING.name, [l0, l1] = TIMING.lots, f = TIMING.fade;
  return {
    racks,
    gap: lerp(gapSpread, gap, between(time, 0, TIMING.narrow)),
    position: lerp3(high.position, entry.position, drop),
    target: lerp3(high.target, entry.target, drop),
    light,
    // White fog hides the far rows until they arrive; it thins as the lights go down.
    fog: { near: lerp(400, 10, light), far: lerp(2000, 80, light) },
    caption: {
      name: time <= n0 ? 1 : 1 - clamp((time - (n1 - f)) / f),
      lots: Math.min(clamp((time - l0) / f), 1 - clamp((time - (l1 - f)) / f)),
    },
    done: time >= TIMING.end,
  };
}
