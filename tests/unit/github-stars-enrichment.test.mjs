import test from "node:test";
import assert from "node:assert/strict";

import { buildGithubStarsEnrichment } from "../../src/lib/github-stars-enrichment.js";

const NOW = Date.UTC(2026, 6, 26, 20, 0, 0);

test("ranks archive- and context-related stars ahead of newer fallbacks", () => {
  const result = buildGithubStarsEnrichment({
    starItems: [
      star("newest/unrelated", NOW, { topics: ["cooking"] }),
      star("cognitive/act-r", NOW - 1000, { topics: ["cognitive-architecture", "working-memory"] }),
      star("browser/agent", NOW - 2000, { description: "A local browser agent" })
    ],
    interestTopics: [{ topic: "working memory" }],
    contextTitles: ["Building a browser agent"]
  });

  assert.deepEqual(result.items.map(item => item.title), [
    "cognitive/act-r",
    "browser/agent",
    "newest/unrelated"
  ]);
  assert.equal(result.items[0].matchKind, "related");
  assert.deepEqual(result.items[0].matchedTopics, ["working memory"]);
  assert.equal(result.items[2].matchKind, "recent");
});

test("falls back to newest explicit stars when there are no relevance signals", () => {
  const result = buildGithubStarsEnrichment({
    starItems: [star("older/repo", NOW - 10_000), star("newer/repo", NOW)]
  });

  assert.deepEqual(result.items.map(item => item.title), ["newer/repo", "older/repo"]);
  assert.equal(result.matchedCount, 0);
});

test("rejects foreign URLs, deduplicates, bounds output, and exposes no score", () => {
  const items = Array.from({ length: 20 }, (_, index) => star(`owner/repo-${index}`, NOW - index));
  items.unshift({ ...star("foreign/repo", NOW), url: "https://example.com/foreign/repo" });
  items.push(star("owner/repo-1", NOW + 100));

  const result = buildGithubStarsEnrichment({ starItems: items, limit: 100 });

  assert.equal(result.items.length, 12);
  assert.equal(new Set(result.items.map(item => item.url)).size, 12);
  assert.equal(result.items.every(item => item.relevance === undefined && item.score === undefined), true);
  assert.equal(result.items.every(item => item.action.verb === "open"), true);
});

function star(title, starredAt, overrides = {}) {
  return {
    id: `github-star:${title}`,
    title,
    url: `https://github.com/${title}`,
    description: "A useful repository",
    topics: ["tools"],
    stars: 50,
    starredAt,
    ...overrides
  };
}
