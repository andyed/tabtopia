import test from "node:test";
import assert from "node:assert/strict";

import {
  SNAPSHOT_VERSION,
  archiveQueryForState,
  readCachedArchive
} from "../../src/lib/archive-provider.js";

const STORAGE_KEY = "tabtopiaArchiveProviderV1";
const NOW = Date.UTC(2026, 6, 26, 16, 0, 0);
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

test("cached archive is available for first paint without a network call", async () => {
  const storage = new MemoryStorage({
    [STORAGE_KEY]: storedSnapshot({
      archiveRows: [archiveRow("Cached reference", "https://example.test/cached")],
      archiveFetchedAt: NOW - MINUTE,
      query: "Cached topic",
      hits: [searchHit("Cached match", "https://example.test/match")],
      relatedFetchedAt: NOW - MINUTE
    })
  });

  const result = await readCachedArchive({ storage, now: NOW });

  assert.equal(result.status, "cached");
  assert.equal(result.changed, false);
  assert.equal(result.archive[0].title, "Cached reference");
  assert.equal(result.related[0].title, "Cached match");
  assert.deepEqual(result.freshness, { archive: "fresh", related: "fresh" });
  assert.equal(storage.getCount, 1);
});

test("a snapshot from an older version is discarded, not served", async () => {
  // This is the mechanism the SNAPSHOT_VERSION bump relies on. When cached rows
  // change meaning — as they did when the archive endpoint stopped attaching
  // tags by a query-stripped URL key, which had been serving one bookmark's
  // tags to every ...com/watch?v= URL — the stale snapshot must not survive.
  // Without invalidation, Home keeps painting the old tags for ARCHIVE_TTL_MS,
  // which is 24 hours.
  const storage = new MemoryStorage({
    [STORAGE_KEY]: {
      ...storedSnapshot({
        archiveRows: [archiveRow("Stale reference", "https://example.test/stale")],
        archiveFetchedAt: NOW - MINUTE
      }),
      version: SNAPSHOT_VERSION - 1
    }
  });

  const result = await readCachedArchive({ storage, now: NOW });

  assert.equal(result.archive.length, 0, "old-version rows must not reach the view");
  assert.notEqual(result.status, "cached");
});

test("state query includes recent foreign titles but never URL or body fields", () => {
  const longTitle = `A useful title ${"z".repeat(180)}`;
  const query = archiveQueryForState({
    snapshot: {
      body: "SECRET BODY",
      history: {
        foreignItems: [
          {
            title: "Older foreign trail",
            url: "https://private.test/foreign-old",
            body: "FOREIGN OLD BODY",
            visitTime: NOW - (3 * MINUTE)
          },
          {
            title: "Recent foreign trail",
            url: "https://private.test/foreign-new",
            body: "FOREIGN NEW BODY",
            visitTime: NOW - MINUTE
          }
        ]
      },
      currentWindow: {
        tabs: [
          { active: true, title: "Focused research", url: "https://private.test/secret", body: "TAB BODY" },
          { active: false, title: longTitle, url: "https://private.test/other", lastAccessed: 20 }
        ]
      }
    },
    forecast: {
      candidates: [
        { action: { target: { title: "Focused research", url: "https://private.test/duplicate" } } },
        { action: { target: { title: "Possible continuation", body: "FORECAST BODY" } } },
        { title: "Habit destination", url: "https://private.test/habit" }
      ]
    }
  });

  assert.ok(query.includes("Focused research"));
  assert.ok(query.includes("Recent foreign trail"));
  assert.ok(query.includes("Older foreign trail"));
  assert.ok(query.indexOf("Recent foreign trail") < query.indexOf("Older foreign trail"));
  assert.ok(query.includes("Possible continuation"));
  assert.equal(query.match(/Focused research/g).length, 1);
  assert.equal(query.includes("private.test"), false);
  assert.equal(query.includes("BODY"), false);
  assert.ok(query.length <= 320);
});

test("storage failures degrade to an empty offline result", async () => {
  const result = await readCachedArchive({
    storage: { async get() { throw new Error("storage unavailable"); } }, now: NOW
  });
  assert.equal(result.status, "offline");
  assert.deepEqual(result.archive, []);
  assert.deepEqual(result.related, []);
});

class MemoryStorage {
  constructor(values = {}) {
    this.values = structuredClone(values);
    this.getCount = 0;
  }

  async get(key) {
    this.getCount += 1;
    return key in this.values ? { [key]: structuredClone(this.values[key]) } : {};
  }

  async set(values) {
    Object.assign(this.values, structuredClone(values));
  }
}

function storedSnapshot({
  archiveRows = [],
  archiveFetchedAt = 0,
  query = "",
  hits = [],
  relatedFetchedAt = 0
} = {}) {
  const queries = query ? {
    [query.toLowerCase()]: { query, fetchedAt: relatedFetchedAt, hits }
  } : {};
  return {
    // Follows the module rather than duplicating it: a SNAPSHOT_VERSION bump
    // must invalidate real caches without silently breaking these fixtures.
    version: SNAPSHOT_VERSION,
    updatedAt: Math.max(archiveFetchedAt, relatedFetchedAt),
    archive: { fetchedAt: archiveFetchedAt, rows: archiveRows },
    queries,
    lastQuery: query
  };
}

function archiveRow(title, url, overrides = {}) {
  return {
    title,
    url,
    tags: ["research"],
    date_added: "2026-07-25T12:00:00Z",
    visitCount: 7,
    lastVisitTime: NOW - (2 * MINUTE),
    type: "article",
    _layer: "cold_landmark",
    ...overrides
  };
}

function searchHit(title, url, overrides = {}) {
  return {
    title,
    url,
    score: 0.8,
    date: "2026-07-25T12:00:00Z",
    type: "article",
    ...overrides
  };
}

function response(payload, ok = true) {
  return {
    ok,
    async json() {
      return structuredClone(payload);
    }
  };
}
