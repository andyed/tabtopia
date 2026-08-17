import test from "node:test";
import assert from "node:assert/strict";

import {
  SNAPSHOT_VERSION,
  archiveQueryForState,
  readCachedArchive,
  refreshArchive
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

test("a stale-version snapshot refetches immediately rather than waiting out the TTL", async () => {
  // emptySnapshot() carries fetchedAt: 0, so the discarded snapshot reads as
  // stale and the very next refresh goes to the network.
  const storage = new MemoryStorage({
    [STORAGE_KEY]: {
      ...storedSnapshot({
        archiveRows: [archiveRow("Stale reference", "https://example.test/stale")],
        archiveFetchedAt: NOW - MINUTE
      }),
      version: SNAPSHOT_VERSION - 1
    }
  });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return response(url.includes("/api/search")
      ? { results: [] }
      : [archiveRow("Fresh reference", "https://example.test/fresh")]);
  };

  const result = await refreshArchive({ storage, now: NOW, fetchImpl });

  assert.ok(calls.some(u => u.includes("/api/history/adaptive")), "expected an archive refetch");
  assert.equal(result.archive[0].title, "Fresh reference");
});

test("live refresh stores only bounded tagged archive rows and semantic hits", async () => {
  const storage = new MemoryStorage();
  const calls = [];
  const archiveItems = Array.from({ length: 110 }, (_, index) => archiveRow(
    `Reference ${index}`,
    `https://example.test/archive/${index}`,
    { tags: index === 109 ? [] : ["research", "research"] }
  ));
  archiveItems.push({ title: "No tags", url: "https://example.test/no-tags" });
  const hits = Array.from({ length: 20 }, (_, index) => searchHit(
    `Match ${index}`,
    `https://example.test/search/${index}`,
    { score: 1 - (index / 100), description: "must not be retained" }
  ));
  const fetchImpl = async url => {
    calls.push(url);
    return response(url.includes("/api/search") ? { results: hits } : archiveItems);
  };

  const result = await refreshArchive({
    query: "adaptive memory",
    storage,
    fetchImpl,
    now: NOW
  });

  assert.equal(result.status, "live");
  assert.equal(result.changed, true);
  assert.equal(result.archive.length, 96);
  assert.equal(result.related.length, 12);
  assert.deepEqual(result.archive[0].tags, ["research"]);
  assert.equal(result.archive[0].visitCount, 7);
  assert.equal(result.archive[0].lastVisitTime, NOW - (2 * MINUTE));
  assert.equal(result.archive[0].archivedAt, Date.parse("2026-07-25T12:00:00Z"));
  assert.equal("description" in result.related[0], false);
  assert.equal(calls.length, 2);

  const cached = await readCachedArchive({ storage, now: NOW + MINUTE });
  assert.equal(cached.status, "cached");
  assert.equal(cached.archive.length, 96);
  assert.equal(cached.related.length, 12);
});

test("offline refresh returns the cached snapshot and never throws", async () => {
  const storage = new MemoryStorage({
    [STORAGE_KEY]: storedSnapshot({
      archiveRows: [archiveRow("Offline reference", "https://example.test/offline")],
      archiveFetchedAt: NOW - DAY - MINUTE,
      query: "Offline topic",
      hits: [searchHit("Offline match", "https://example.test/offline-match")],
      relatedFetchedAt: NOW - (11 * MINUTE)
    })
  });

  const result = await refreshArchive({
    query: "Offline topic",
    storage,
    fetchImpl: async () => { throw new Error("localhost unavailable"); },
    now: NOW
  });

  assert.equal(result.status, "offline");
  assert.equal(result.changed, false);
  assert.equal(result.archive[0].title, "Offline reference");
  assert.equal(result.related[0].title, "Offline match");
});

test("daily archive and per-query ten-minute TTLs refresh independently", async () => {
  const storage = new MemoryStorage();
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    return response(url.includes("/api/search")
      ? { results: [searchHit("Related", "https://example.test/related")] }
      : [archiveRow("Archive", "https://example.test/archive")]);
  };

  await refreshArchive({ query: "topic", storage, fetchImpl, now: NOW });
  assert.equal(calls.length, 2);

  const cached = await refreshArchive({ query: "topic", storage, fetchImpl, now: NOW + (9 * MINUTE) });
  assert.equal(cached.status, "cached");
  assert.equal(calls.length, 2);

  await refreshArchive({ query: "topic", storage, fetchImpl, now: NOW + (11 * MINUTE) });
  assert.equal(calls.length, 3);
  assert.ok(calls[2].includes("/api/search"));

  await refreshArchive({ query: "topic", storage, fetchImpl, now: NOW + DAY + MINUTE });
  assert.equal(calls.length, 5);
  assert.ok(calls.slice(3).some(url => url.includes("/api/history/adaptive")));
  assert.ok(calls.slice(3).some(url => url.includes("/api/search")));
});

test("unchanged forced refresh cannot drive a changed-triggered refresh loop", async () => {
  const storage = new MemoryStorage();
  const fetchImpl = async url => response(url.includes("/api/search")
    ? { results: [searchHit("Stable match", "https://example.test/stable-match")] }
    : [archiveRow("Stable archive", "https://example.test/stable-archive")]);

  const first = await refreshArchive({ query: "stable", storage, fetchImpl, now: NOW });
  const forced = await refreshArchive({
    query: "stable",
    storage,
    fetchImpl,
    now: NOW + MINUTE,
    force: true
  });
  const triggered = await refreshArchive({
    query: "stable",
    storage,
    fetchImpl,
    now: NOW + (2 * MINUTE)
  });

  assert.equal(first.changed, true);
  assert.equal(forced.status, "live");
  assert.equal(forced.changed, false);
  assert.equal(triggered.status, "cached");
  assert.equal(triggered.changed, false);
});

test("switching semantic queries updates the visible cached lane exactly once", async () => {
  const storage = new MemoryStorage();
  const fetchImpl = async url => response(url.includes("/api/search")
    ? { results: [searchHit(
        url.includes("second") ? "Second match" : "First match",
        url.includes("second")
          ? "https://example.test/second-match"
          : "https://example.test/first-match"
      )] }
    : [archiveRow("Archive", "https://example.test/archive")]);

  await refreshArchive({ query: "first", storage, fetchImpl, now: NOW });
  await refreshArchive({ query: "second", storage, fetchImpl, now: NOW + MINUTE });
  await refreshArchive({ query: "first", storage, fetchImpl, now: NOW + (2 * MINUTE) });

  const switched = await refreshArchive({
    query: "second",
    storage,
    fetchImpl,
    now: NOW + (3 * MINUTE)
  });
  const cached = await readCachedArchive({ storage, now: NOW + (3 * MINUTE) });
  const settled = await refreshArchive({
    query: "second",
    storage,
    fetchImpl,
    now: NOW + (4 * MINUTE)
  });

  assert.equal(switched.status, "cached");
  assert.equal(switched.changed, true);
  assert.equal(cached.query, "second");
  assert.equal(cached.related[0].title, "Second match");
  assert.equal(settled.changed, false);
});

test("an empty result clears previously visible semantic recall", async () => {
  const storage = new MemoryStorage();
  const fetchImpl = async url => response(url.includes("/api/search")
    ? { results: url.includes("empty") ? [] : [searchHit("Old match", "https://example.test/old-match")] }
    : [archiveRow("Archive", "https://example.test/archive")]);

  await refreshArchive({ query: "old", storage, fetchImpl, now: NOW });
  const cleared = await refreshArchive({
    query: "empty",
    storage,
    fetchImpl,
    now: NOW + MINUTE
  });
  const cached = await readCachedArchive({ storage, now: NOW + (2 * MINUTE) });

  assert.equal(cleared.changed, true);
  assert.equal(cached.query, "empty");
  assert.deepEqual(cached.related, []);
});

test("semantic query is encoded, length-bounded, and requests twelve hits", async () => {
  const storage = new MemoryStorage();
  const calls = [];
  const longQuery = `AI & memory ${"x".repeat(500)}`;
  const fetchImpl = async url => {
    calls.push(url);
    return response(url.includes("/api/search") ? { results: [] } : []);
  };

  const result = await refreshArchive({ query: longQuery, storage, fetchImpl, now: NOW });
  const search = new URL(calls.find(url => url.includes("/api/search")));

  assert.equal(result.status, "live");
  assert.equal(search.origin, "http://127.0.0.1:8889");
  assert.equal(search.searchParams.get("limit"), "12");
  assert.ok(search.search.includes("%26"));
  assert.ok(search.searchParams.get("q").length <= 320);
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

test("malformed live responses retain cached data with offline status", async () => {
  const storage = new MemoryStorage({
    [STORAGE_KEY]: storedSnapshot({
      archiveRows: [archiveRow("Safe archive", "https://example.test/safe")],
      archiveFetchedAt: NOW - DAY - MINUTE,
      query: "safe query",
      hits: [searchHit("Safe hit", "https://example.test/safe-hit")],
      relatedFetchedAt: NOW - (11 * MINUTE)
    })
  });
  const fetchImpl = async url => response(url.includes("/api/search")
    ? { results: [{ body: "missing title and URL" }] }
    : { unexpected: [] });

  const result = await refreshArchive({ query: "safe query", storage, fetchImpl, now: NOW });

  assert.equal(result.status, "offline");
  assert.equal(result.changed, false);
  assert.equal(result.archive[0].title, "Safe archive");
  assert.equal(result.related[0].title, "Safe hit");
});

test("storage failures degrade to an empty offline result", async () => {
  const result = await readCachedArchive({
    storage: { async get() { throw new Error("storage unavailable"); } },
    now: NOW
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
