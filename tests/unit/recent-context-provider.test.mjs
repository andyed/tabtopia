import test from "node:test";
import assert from "node:assert/strict";
import { readRecentContext, buildFeaturedContext, setContextSiteHidden } from "../../src/lib/recent-context-provider.js";
const NOW = 1790520000000;
const KEY = "tabtopiaRecentContextV1";
const storage = initial => ({ data: initial || {}, async get() { return this.data; }, async set(data) { Object.assign(this.data, data); } });
const payload = () => ({ status: "live", generatedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 60000).toISOString(), context: { seedCount: 2 }, results: [
  { title: "Techmeme", url: "https://techmeme.com/", score: .78 },
  { title: "Excluded example", url: "https://excluded.example.test/", score: .73 },
  { title: "Duplicate", url: "https://www.techmeme.com/#today", score: .7 },
  { title: "Reference", url: "https://example.com/reference", score: .69 },
  { title: "Unsafe", url: "javascript:alert(1)", score: 1 }
] });

test("centroid cache stays off first-paint network path; explicit exclusions and open-tab actions are respected", async () => {
  const cache = storage(); const prefs = storage();
  cache.data[KEY] = { ...payload(), version: 1, generatedAt: NOW, expiresAt: NOW + 60000 };
  prefs.data.tabtopiaContextHiddenSitesV1 = ["excluded.example.test"];
  const context = await readRecentContext({ storage: cache, preferences: prefs, now: NOW, development: true });
  const featured = buildFeaturedContext(context, [{ id: 8, windowId: 3, url: "https://techmeme.com/" }], NOW);
  assert.deepEqual(featured.map(x => x.title), ["Techmeme", "Reference"]);
  assert.equal(featured[0].verb, "switch"); assert.equal(featured[0].target.tabId, 8);
  assert.equal(featured[1].verb, "open");
  assert.deepEqual(buildFeaturedContext(context, [], NOW + 60001), []);
  assert.deepEqual((await readRecentContext({ storage: cache, now: NOW + 60001 })).results, []);
});

test("site dismissals persist with subdomain filtering and explicit undo, without default exclusions", async () => {
  const prefs = storage();
  await setContextSiteHidden("https://techmeme.com/", true, { preferences: prefs });
  const context = { ...payload(), generatedAt: NOW, expiresAt: NOW + 60000, hiddenHosts: prefs.data.tabtopiaContextHiddenSitesV1 };
  assert.deepEqual(buildFeaturedContext(context, [], NOW).map(x => x.title), ["Excluded example", "Reference"]);
  await setContextSiteHidden("techmeme.com", false, { preferences: prefs });
  assert.deepEqual(prefs.data.tabtopiaContextHiddenSitesV1, []);
  assert.deepEqual((await readRecentContext({ preferences: storage(), storage: storage(), development: false })).hiddenHosts, []);
});

test("local apps retain port identity and do not switch to another hub's open tab", () => {
  const context = { context: { seedCount: 2 }, generatedAt: NOW, expiresAt: NOW + 60000, results: [
    { title: "Stats", url: "http://127.0.0.1:8765/" },
    { title: "Cartographer", url: "http://127.0.0.1:2527/" }
  ] };
  const featured = buildFeaturedContext(context, [{ id: 12, windowId: 3, url: "http://127.0.0.1:2527/" }], NOW);
  assert.equal(featured.length, 2);
  assert.equal(featured[0].verb, "open");
  assert.equal(featured[1].verb, "switch");
  assert.equal(featured[1].target.tabId, 12);
});
