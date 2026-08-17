import test from "node:test";
import assert from "node:assert/strict";

import { estimateNonReturnWindow } from "../../src/lib/non-return-window.js";

const MINUTE = 60 * 1000;

test("keeps the 30-minute fallback when evidence is sparse", () => {
  const estimate = estimateNonReturnWindow(seriesFromGaps([MINUTE, 2 * MINUTE, 3 * MINUTE]));

  assert.equal(estimate.status, "insufficient-data");
  assert.equal(estimate.boundaryMs, 30 * MINUTE);
  assert.equal(estimate.source, "fallback");
});

test("finds the separation between short bursts and later returns", () => {
  const short = Array.from({ length: 140 }, (_, index) => (20 + (index % 50)) * 1000);
  const later = Array.from({ length: 70 }, (_, index) => (2.5 + (index % 12) * 0.25) * 60 * MINUTE);
  const estimate = estimateNonReturnWindow(seriesFromGaps(interleave(short, later)));

  assert.equal(estimate.status, "ready");
  assert.equal(estimate.source, "qualified-access-mixture");
  assert.ok(estimate.boundaryMs >= 10 * MINUTE && estimate.boundaryMs <= 60 * MINUTE);
  assert.ok(estimate.windowStartMs < estimate.boundaryMs);
  assert.ok(estimate.windowEndMs > estimate.boundaryMs);
  assert.ok(estimate.components.withinBurstMedianMs < estimate.components.laterReturnMedianMs);
});

test("does not activate an estimate for a single broad mode", () => {
  const gaps = Array.from({ length: 160 }, (_, index) => (5 + (index % 50)) * MINUTE);
  const estimate = estimateNonReturnWindow(seriesFromGaps(gaps));

  assert.notEqual(estimate.status, "ready");
  assert.equal(estimate.boundaryMs, 30 * MINUTE);
});

test("is deterministic and ignores duplicate timestamps", () => {
  const short = Array.from({ length: 100 }, (_, index) => (30 + (index % 20)) * 1000);
  const later = Array.from({ length: 60 }, (_, index) => (3 + (index % 8)) * 60 * MINUTE);
  const timestamps = seriesFromGaps(interleave(short, later));
  const duplicated = timestamps.flatMap(timestamp => [timestamp, timestamp]);

  assert.deepEqual(estimateNonReturnWindow(duplicated), estimateNonReturnWindow(timestamps));
});

function seriesFromGaps(gaps) {
  const timestamps = [Date.UTC(2026, 0, 1)];
  for (const gap of gaps) timestamps.push(timestamps.at(-1) + gap);
  return timestamps;
}

function interleave(left, right) {
  const result = [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== undefined) result.push(left[index]);
    if (right[index] !== undefined) result.push(right[index]);
  }
  return result;
}
