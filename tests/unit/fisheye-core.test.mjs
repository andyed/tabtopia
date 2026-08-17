import test from "node:test";
import assert from "node:assert/strict";

import {
  computeDefaultHeights,
  computeFisheyeHeights
} from "../../src/vendor/fisheye-menu/fisheye-core.js";

test("vendored fisheye lens grows the target while preserving its footprint", () => {
  const count = 8;
  const total = count * 96;
  const heights = computeFisheyeHeights(count, 4, total, {
    baseHeight: 96,
    maxExpand: 1.7,
    minHeight: 76,
    falloffRadius: 3
  });

  assert.equal(heights.length, count);
  assert.ok(heights[4] > heights[0]);
  assert.ok(heights.every(height => height >= 76));
  assert.ok(Math.abs(heights.reduce((sum, height) => sum + height, 0) - total) < 0.01);
});

test("default fisheye layout remains uniform", () => {
  assert.deepEqual(computeDefaultHeights(4, 400), [100, 100, 100, 100]);
});
