import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRecallSearchSources,
  decorateRecallItem
} from "../../src/newtab/recall-search-sources.js";

test("builds one decorated corpus from open tabs, nested bookmarks, and tagged recall", () => {
  const url = "https://example.com/depthfield";
  const sources = buildRecallSearchSources({
    windows: [{ id: 9, tabs: [{ id: 4, title: "Open depthfield", url }] }],
    bookmarkTree: [{ children: [{ children: [{ id: "b1", title: "Saved depthfield", url }] }] }],
    taggedItems: [{ title: "Tagged depthfield", url, tags: ["graphics"] }],
    summaries: {
      [url]: { summary: "WebGL camera shader notes", source: "chrome-ai", timestamp: 12 }
    },
    heroImages: {
      [url]: {
        title: "Depthfield",
        images: [
          { src: "https://example.com/low.jpg", score: 20 },
          { src: "https://example.com/hero.jpg", score: 80, alt: "Camera shader" }
        ]
      }
    }
  });

  assert.equal(sources.openItems[0].windowId, 9);
  assert.equal(sources.bookmarkItems.length, 1);
  assert.equal(sources.taggedItems.length, 1);
  for (const item of [sources.openItems[0], sources.bookmarkItems[0], sources.taggedItems[0]]) {
    assert.equal(item.summary, "WebGL camera shader notes");
    assert.equal(item.summarySource, "chrome-ai");
    assert.equal(item.heroImageUrl, "https://example.com/hero.jpg");
    assert.equal(item.heroImageAlt, "Camera shader");
    assert.equal(item.heroImageScore, 80);
  }
});

test("marks historical chrome-summarizer records as unknown instead of claiming AI provenance", () => {
  const item = decorateRecallItem(
    { title: "Legacy", url: "https://example.com/legacy" },
    {
      summaryRecords: {
        "https://example.com/legacy": {
          summary: "Older cached text",
          source: "chrome-summarizer"
        }
      }
    }
  );

  assert.equal(item.summary, "Older cached text");
  assert.equal(item.summarySource, "legacy-unknown");
});

test("rejects internal bookmarks and invalid hero image URLs", () => {
  const sources = buildRecallSearchSources({
    bookmarkTree: [{ children: [
      { title: "History", url: "chrome://history/" },
      { title: "Public", url: "https://example.com/public" }
    ] }],
    heroImages: {
      "https://example.com/public": {
        images: [{ src: "javascript:alert(1)", score: 100 }]
      }
    }
  });

  assert.deepEqual(sources.bookmarkItems.map(item => item.title), ["Public"]);
  assert.equal(sources.bookmarkItems[0].heroImageUrl, "");
});
