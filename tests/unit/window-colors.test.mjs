import test from "node:test";
import assert from "node:assert/strict";

import {
  getWindowColor,
  getWindowColorPalette,
  resetWindowColors
} from "../../src/newtab/utility.js";

// Regression guard: getWindowColor and getWindowColorPalette used to share one
// Map keyed by windowId, but stored different types into it — a color object
// and a bare hue number. Whichever ran second read the other's value.

test("getWindowColor survives a prior getWindowColorPalette call for the same window", () => {
  resetWindowColors();

  getWindowColorPalette(7);
  const color = getWindowColor(7);

  assert.equal(typeof color, "object", "should be a color object, not a cached hue number");
  assert.equal(typeof color.getBorder, "function");
  assert.equal(typeof color.getTabColor, "function");
  assert.match(color.background, /^hsl\(\d+(\.\d+)?, \d+%, \d+%\)$/);
});

test("getWindowColorPalette survives a prior getWindowColor call for the same window", () => {
  resetWindowColors();

  getWindowColor(7);
  const palette = getWindowColorPalette(7);

  assert.equal(typeof palette.baseHue, "number", "baseHue must not be a color object");
  assert.ok(Number.isFinite(palette.baseHue));
  // The collision used to surface here as "hsl([object Object], 75%, 55%)".
  assert.match(palette.activeColor, /^hsl\(\d+(\.\d+)?, \d+%, \d+%\)$/);
  for (const c of palette.colors) {
    assert.match(c, /^hsl\(-?\d+(\.\d+)?, -?\d+(\.\d+)?%, -?\d+(\.\d+)?%\)$/);
  }
});

test("both functions agree on a window's hue, in either call order", () => {
  resetWindowColors();
  const colorFirst = getWindowColor(3).hue;
  const paletteAfter = getWindowColorPalette(3).baseHue;

  resetWindowColors();
  const paletteFirst = getWindowColorPalette(3).baseHue;
  const colorAfter = getWindowColor(3).hue;

  assert.equal(colorFirst, paletteAfter);
  assert.equal(paletteFirst, colorAfter);
  assert.equal(colorFirst, paletteFirst);
});

test("distinct windows get distinct hues", () => {
  resetWindowColors();
  const hues = [1, 2, 3, 4, 5].map(id => getWindowColor(id).hue);
  assert.equal(new Set(hues).size, hues.length);
});

test("a window keeps its color across repeated calls", () => {
  resetWindowColors();
  assert.equal(getWindowColor(11).base, getWindowColor(11).base);
});

// Second-order bug in the same cache: keying on windowId alone meant the first
// caller's options won permanently and later callers were silently ignored.
test("options are honored rather than served from the first caller's cache entry", () => {
  resetWindowColors();

  const bright = getWindowColor(9, { lightness: 70 });
  const dim = getWindowColor(9, { lightness: 30 });

  assert.notEqual(bright.base, dim.base, "distinct lightness must produce distinct colors");
  assert.ok(bright.base.endsWith("70%)"));
  assert.ok(dim.base.endsWith("30%)"));
  assert.equal(bright.hue, dim.hue, "hue stays stable per window regardless of options");
});

test("resetWindowColors clears every cache, not just the color objects", () => {
  resetWindowColors();
  const before = getWindowColorPalette(5).baseHue;
  resetWindowColors();
  // Recomputed from scratch; must be deterministic, and must not throw on a
  // half-cleared cache.
  assert.equal(getWindowColorPalette(5).baseHue, before);
});
