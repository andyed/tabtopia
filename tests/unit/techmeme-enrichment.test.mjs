import test from "node:test";
import assert from "node:assert/strict";

import { buildTechmemeEnrichment } from "../../src/lib/techmeme-enrichment.js";

test("filters Techmeme against archive topics and current title vocabulary", () => {
  const result = buildTechmemeEnrichment({
    feedItems: [
      headline("AI memory systems arrive", "p1"),
      headline("Browser agents gain local models", "p2"),
      headline("Shein files for an IPO", "p3")
    ],
    interestTopics: [{ topic: "working memory" }],
    contextTitles: ["Building a browser agent"],
    limit: 8
  });

  assert.deepEqual(result.items.map(item => item.title), [
    "AI memory systems arrive",
    "Browser agents gain local models"
  ]);
  assert.deepEqual(result.items[0].matchedTopics, ["working memory"]);
  assert.equal(result.items[1].matchedTopics.length, 0);
  assert.equal(result.matchedCount, 2);
});

test("does not fall back to unrelated news when there is no relevance signal", () => {
  const result = buildTechmemeEnrichment({
    feedItems: [headline("Quarterly retail earnings", "p4")],
    interestTopics: ["cognitive science"],
    contextTitles: ["ACT-R reference"]
  });

  assert.deepEqual(result.items, []);
});

test("rejects foreign links, deduplicates, and keeps output bounded and score-free", () => {
  const feedItems = Array.from({ length: 20 }, (_, index) => headline(`AI item ${index}`, `p${index}`));
  feedItems.unshift({ title: "AI foreign", url: "https://example.com/foreign" });
  feedItems.push(headline("AI duplicate", "p1"));

  const result = buildTechmemeEnrichment({
    feedItems,
    interestTopics: ["AI"],
    limit: 100
  });

  assert.equal(result.items.length, 12);
  assert.equal(result.items.every(item => item.action.verb === "open"), true);
  assert.equal(result.items.every(item => item.score === undefined && item.relevance === undefined), true);
  assert.equal(new Set(result.items.map(item => item.url)).size, result.items.length);
});

function headline(title, slug) {
  return {
    id: `techmeme:${slug}`,
    title,
    url: `https://www.techmeme.com/260726/${slug}#a260726${slug}`,
    publishedAt: Date.UTC(2026, 6, 26, 20, 0, 0)
  };
}
