import test from "node:test";
import assert from "node:assert/strict";

import { truncateHomeTitle } from "../../src/lib/home-title.js";

test("short titles remain exact after whitespace normalization", () => {
  assert.deepEqual(truncateHomeTitle("  A useful\n page  ", { maxGraphemes: 40 }), {
    full: "A useful page",
    display: "A useful page",
    truncated: false,
    strategy: "complete"
  });
});

test("publication suffixes yield before the meaningful title", () => {
  const result = truncateHomeTitle(
    "How working memory supports browsing predictions | Cognitive Science Review",
    { maxGraphemes: 52 }
  );

  assert.equal(result.display, "How working memory supports browsing predictions…");
  assert.equal(result.strategy, "service-suffix");
  assert.equal(result.truncated, true);
});

test("long titles end on a useful word boundary and stay within budget", () => {
  const result = truncateHomeTitle(
    "A practical account of memory activation across several browsing contexts and devices",
    { maxGraphemes: 48 }
  );

  assert.equal(result.display, "A practical account of memory activation…");
  assert.ok([...result.display].length <= 48);
  assert.equal(/[\s,;:|·•/\-–—]…$/u.test(result.display), false);
});

test("unbroken Unicode titles do not split joined emoji graphemes", () => {
  const family = "👩‍👩‍👧‍👦";
  const result = truncateHomeTitle(family.repeat(30), { maxGraphemes: 16 });

  assert.equal(result.display.endsWith("…"), true);
  assert.equal(result.display.slice(0, -1), family.repeat(15));
});

test("unsafe or extreme limits are bounded deterministically", () => {
  const title = "x".repeat(220);
  assert.equal(truncateHomeTitle(title, { maxGraphemes: 2 }).display.length, 16);
  assert.equal(truncateHomeTitle(title, { maxGraphemes: 500 }).display.length, 160);
  assert.deepEqual(
    truncateHomeTitle(title, { maxGraphemes: Number.NaN }),
    truncateHomeTitle(title)
  );
});
