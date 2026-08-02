import assert from "node:assert/strict";
import test from "node:test";

import { buildSearchEvidence } from "../../src/newtab/search-evidence.js";

const NOW = Date.UTC(2026, 7, 1, 16, 0, 0);

test("a direct saved-title match shows useful save timing, not taxonomy", () => {
  assert.deepEqual(buildSearchEvidence({
    source: "bookmark",
    bookmarked: true,
    matchKind: "Title",
    bookmarkSavedAt: NOW - (167 * 24 * 60 * 60 * 1000),
    visitCount: 1
  }, NOW), [
    { text: "Saved 167d ago", kind: "saved" }
  ]);
});

test("tag expansion names the relationship that admitted the result", () => {
  assert.deepEqual(buildSearchEvidence({
    source: "tag",
    tagged: true,
    matchKind: "Related tag",
    matchedTags: ["graphics"]
  }, NOW), [
    { text: "Related via graphics", kind: "related" }
  ]);
});

test("summary recall names both the match surface and honest provenance", () => {
  assert.deepEqual(buildSearchEvidence({
    source: "bookmark",
    bookmarked: true,
    matchKind: "Summary",
    summarySource: "chrome-ai",
    bookmarkSavedAt: NOW - (2 * 60 * 60 * 1000)
  }, NOW), [
    { text: "Matched in Chrome AI summary", kind: "ai" },
    { text: "Saved 2h ago", kind: "saved" }
  ]);
});

test("History evidence combines recurrence and recency", () => {
  assert.deepEqual(buildSearchEvidence({
    source: "history",
    history: true,
    matchKind: "Title",
    visitCount: 6,
    historyLastVisitedAt: NOW - (3 * 24 * 60 * 60 * 1000)
  }, NOW), [
    { text: "Opened 6× · 3d ago", kind: "history" }
  ]);
});

test("an open saved result exposes both actionable and durable state", () => {
  assert.deepEqual(buildSearchEvidence({
    source: "bookmark",
    open: true,
    bookmarked: true,
    matchKind: "Title",
    bookmarkSavedAt: NOW - (10 * 60 * 1000)
  }, NOW), [
    { text: "Open now", kind: "open" },
    { text: "Saved 10m ago", kind: "saved" }
  ]);
});
