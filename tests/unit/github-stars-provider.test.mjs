import test from "node:test";
import assert from "node:assert/strict";

import {
  parseGithubStars,
  readCachedGithubStars
} from "../../src/lib/github-stars-provider.js";

const STORAGE_KEY = "tabtopiaGithubStarsProviderV1";
const NOW = Date.UTC(2026, 6, 26, 20, 0, 0);
const HOUR = 60 * 60 * 1000;

test("parses, sorts, and bounds the explicit GitHub-star surface", () => {
  const items = parseGithubStars({ items: [
    star("older/repo", { date_added: "2026-07-20T10:00:00Z", topics: ["AI", "ai", "browser-extension"] }),
    star("newer/repo", { date_added: "2026-07-25T10:00:00Z" }),
    { ...star("not/a-star"), type: "repo" },
    star("foreign/repo", { url: "https://example.com/foreign/repo" }),
    star("deep/path", { url: "https://github.com/deep/path/issues" }),
    star("duplicate/repo"),
    star("duplicate/repo")
  ] });

  assert.deepEqual(items.map(item => item.title), ["newer/repo", "duplicate/repo", "older/repo"]);
  assert.deepEqual(items.at(-1).topics, ["ai", "browser-extension"]);
  assert.equal(items.every(item => item.type === undefined && item.source === undefined), true);
});

test("cached GitHub stars are first-paint data and never fetch", async () => {
  const storage = new MemoryStorage({
    [STORAGE_KEY]: snapshot({ fetchedAt: NOW - HOUR, items: [star("cached/repo")] })
  });

  const result = await readCachedGithubStars({ storage, now: NOW });

  assert.equal(result.status, "cached");
  assert.equal(result.freshness, "fresh");
  assert.equal(result.items[0].title, "cached/repo");
  assert.equal(storage.getCount, 1);
});

function star(title, overrides = {}) {
  return {
    title,
    url: `https://github.com/${title}`,
    description: `${title} description`,
    topics: ["testing"],
    stars: 42,
    date_added: "2026-07-24T12:00:00Z",
    source: "GitHub",
    type: "star",
    ...overrides
  };
}

function snapshot({ fetchedAt, items }) {
  return { version: 1, fetchedAt, sourceUpdatedAt: fetchedAt, items };
}

function response(payload) {
  return { ok: true, json: async () => payload };
}

class MemoryStorage {
  constructor(initial = {}) {
    this.values = structuredClone(initial);
    this.getCount = 0;
  }

  async get(key) {
    this.getCount += 1;
    return { [key]: structuredClone(this.values[key]) };
  }

  async set(values) {
    Object.assign(this.values, structuredClone(values));
  }
}
