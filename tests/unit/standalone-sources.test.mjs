import test from "node:test";
import assert from "node:assert/strict";
import { refreshArchive } from "../../src/lib/archive-provider.js";
import { refreshGithubStars } from "../../src/lib/github-stars-provider.js";
import { refreshRecentContext, readRecentContext } from "../../src/lib/recent-context-provider.js";

test("public supplemental refreshes never send browsing data or touch provider storage", async () => {
  const unexpected = () => { throw new Error("Unexpected provider I/O"); };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = unexpected;
  try {
    for (const refresh of [refreshArchive, refreshGithubStars, refreshRecentContext]) {
      assert.deepEqual(await refresh({ query: "Private page title", force: true,
        fetchImpl: unexpected, storage: { get: unexpected, set: unexpected } }),
      { changed: false, status: "disabled" });
    }
  } finally { globalThis.fetch = previousFetch; }
});

test("development and packaged installs have no personal site exclusions", async () => {
  const empty = { async get() { return {}; } };
  for (const development of [true, false]) {
    const result = await readRecentContext({ storage: empty, preferences: empty, development });
    assert.deepEqual(result.hiddenHosts, []);
    assert.deepEqual(result.results, []);
  }
});
