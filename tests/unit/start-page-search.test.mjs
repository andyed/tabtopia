import test from "node:test";
import assert from "node:assert/strict";

import { buildStartPageSearchResults } from "../../src/lib/start-page-search.js";

const NOW = Date.UTC(2026, 7, 1, 16, 0, 0);

test("finds a matching closed recent page that is absent from open tabs", () => {
  const results = buildStartPageSearchResults({
    query: "flight review",
    openItems: [openTab(1, "Unrelated", "https://example.com/open")],
    historyItems: [history("App Store flight review", "https://developer.apple.com/flight-review", 5)],
    now: NOW
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].title, "App Store flight review");
  assert.equal(results[0].open, false);
  assert.equal(results[0].matchKind, "Title");
});

test("merges an open tab with the same History page and retains switch identity", () => {
  const url = "https://example.com/recent?q=one";
  const results = buildStartPageSearchResults({
    query: "recent",
    openItems: [openTab(42, "Recent page open", url, 7)],
    historyItems: [history("Recent page in history", url, 12, 8)],
    now: NOW
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].open, true);
  assert.equal(results[0].tabId, 42);
  assert.equal(results[0].windowId, 7);
  assert.equal(results[0].visitCount, 8);
});

test("text is an admission gate while recency breaks matching ambiguity", () => {
  const results = buildStartPageSearchResults({
    query: "release notes",
    historyItems: [
      history("Release notes", "https://old.example/release", 20),
      history("Release notes", "https://new.example/release", 2),
      history("Very recent but unrelated", "https://other.example/today", 1)
    ],
    now: NOW
  });

  assert.deepEqual(results.map(result => result.domain), ["new.example", "old.example"]);
});

test("requires every query token and rejects internal browser URLs", () => {
  const results = buildStartPageSearchResults({
    query: "app store",
    openItems: [openTab(1, "App dashboard", "https://example.com/app")],
    historyItems: [
      history("App Store Connect", "https://appstoreconnect.apple.com/apps", 3),
      history("App Store internal", "chrome://history/", 1)
    ],
    now: NOW
  });

  assert.deepEqual(results.map(result => result.title), ["App Store Connect"]);
});

test("bounds output deterministically", () => {
  const historyItems = Array.from({ length: 70 }, (_, index) =>
    history(`Common page ${index}`, `https://example.com/${index}`, index + 1)
  );
  const results = buildStartPageSearchResults({ query: "common", historyItems, now: NOW, limit: 500 });
  assert.equal(results.length, 50);
  assert.equal(results[0].title, "Common page 0");
});

function openTab(id, title, url, windowId = 1) {
  return { id, windowId, title, url, lastAccessed: NOW - (3 * 60 * 1000) };
}

function history(title, url, minutesAgo, visitCount = 1) {
  return {
    title,
    url,
    lastVisitTime: NOW - (minutesAgo * 60 * 1000),
    visitCount
  };
}
