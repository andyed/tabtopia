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
  assert.equal(results[0].historyLastVisitedAt, NOW - (12 * 60 * 1000));
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

test("searches bookmark summaries and keeps saved matches ahead of History", () => {
  const results = buildStartPageSearchResults({
    query: "shader notebook",
    bookmarkItems: [bookmark(
      "Depthfield notes",
      "https://depthfield.example/camera",
      "A shader notebook for WebGL camera effects"
    )],
    historyItems: [history("Shader notebook in History", "https://history.example/shaders", 1)],
    now: NOW
  });

  assert.deepEqual(results.map(result => result.source), ["bookmark", "history"]);
  assert.equal(results[0].matchKind, "Summary");
  assert.equal(results[0].bookmarkSavedAt, NOW - (60 * 60 * 1000));
});

test("expands a query through shared archive tags before using History", () => {
  const results = buildStartPageSearchResults({
    query: "webgl",
    taggedItems: [
      tagged("WebGL shader guide", "https://archive.example/webgl", ["creative coding", "graphics"]),
      tagged("Depthfield camera effects", "https://archive.example/depthfield", ["graphics", "photography"])
    ],
    historyItems: [history("WebGL result from History", "https://history.example/webgl", 1)],
    now: NOW
  });

  assert.deepEqual(results.map(result => result.source), ["tag", "tag", "history"]);
  assert.equal(results[1].matchKind, "Related tag");
  assert.deepEqual(results[1].matchedTags, ["graphics"]);
  assert.equal(results[1].taggedAt, NOW - (24 * 60 * 60 * 1000));
});

test("retains URL-matched hero and summary provenance when sources merge", () => {
  const url = "https://depthfield.example/camera";
  const results = buildStartPageSearchResults({
    query: "camera shader",
    openItems: [openTab(42, "Depthfield camera", url, 7)],
    bookmarkItems: [{
      ...bookmark("Depthfield camera", url, "Camera shader effects for WebGL"),
      summarySource: "chrome-ai",
      heroImageUrl: "https://depthfield.example/hero.jpg",
      heroImageAlt: "Camera effect",
      heroImageScore: 88
    }],
    now: NOW
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].open, true);
  assert.equal(results[0].bookmarked, true);
  assert.equal(results[0].summarySource, "chrome-ai");
  assert.equal(results[0].heroImageUrl, "https://depthfield.example/hero.jpg");
  assert.equal(results[0].heroImageScore, 88);
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

function bookmark(title, url, summary = "") {
  return { title, url, summary, dateAdded: NOW - (60 * 60 * 1000) };
}

function tagged(title, url, tags) {
  return { title, url, tags, archivedAt: NOW - (24 * 60 * 60 * 1000) };
}
