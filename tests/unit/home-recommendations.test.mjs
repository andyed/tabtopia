import test from "node:test";
import assert from "node:assert/strict";
import {
  HOME_RECOMMENDATION_PREFS_KEY, recommendationIdentity, readHomeRecommendationPreferences,
  saveHomeRecommendationPreferences, buildHomeRecommendations, collectHomeRecommendationIdentities
} from "../../src/lib/home-recommendations.js";

const NOW = 1790520000000;
const storage = data => ({ data: data || {}, async get() { return this.data; }, async set(value) { Object.assign(this.data, value); } });
const context = results => ({ generatedAt: NOW - 1000, expiresAt: NOW + 60000, status: "live", context: { seedCount: 2 }, results });
const rank = values => buildHomeRecommendations({ now: NOW, ...values });
const item = (url, score = .7) => ({ url, title: new URL(url).hostname, score });

test("an unseen mobile placeholder receives one slot, survives quick openings, and yields after deeper reading", () => {
  const url = "https://phone.test/read-later";
  const mobile = { url, title: "Read later", mobileFolder: true, dateAdded: NOW - 10000 };
  const input = { preferences: { hubs: [0, 1, 2].map(i => ({ url: `https://hub${i}.test/` })) },
    bookmarks: [mobile], arm: "balanced" };
  const before = rank(input);
  assert.equal(before.length, 3);
  assert.equal(before.filter(row => row.features.mobilePending).length, 1);
  assert.equal(before[0].url, url);
  assert.ok(before[0].reasons.includes("From Mobile bookmarks"));
  assert.ok(rank({ ...input, bookmarks: [{ ...mobile, desktopOpenedAt: NOW - 1000 }] }).some(row => row.url === url));
  assert.equal(rank({ ...input, bookmarks: [{ ...mobile, desktopEngagedAt: NOW - 1000 }] }).some(row => row.url === url), false);
  assert.equal(rank({ ...input, feedback: { [url]: { snoozedUntil: NOW + 10000 } } }).some(row => row.url === url), false);
  assert.equal(rank({ ...input, context: { hiddenHosts: ["phone.test"] } }).some(row => row.url === url), false);
  assert.equal(rank({ ...input, openTabs: [{ url, id: 12 }] }).some(row => row.url === url), false);
});

test("mobile placeholders survive the candidate shortlist and never displace a locked visible slate", () => {
  const url = "https://phone.test/later";
  const bookmarks = Array.from({ length: 11000 }, (_, i) => ({ url: `https://old${i}.test/a.pdf` }));
  bookmarks.push({ url, mobileFolder: true, dateAdded: NOW });
  assert.ok(collectHomeRecommendationIdentities({ bookmarks }).includes(url));
  const locked = ["https://one.test/", "https://two.test/", "https://three.test/"];
  const results = rank({ bookmarks, preferences: { hubs: locked.map(url => ({ url })) }, lockedPages: locked });
  assert.deepEqual(results.map(row => row.url), locked);
});

test("preferences have no personal defaults on any install, persist explicit choices, and validate before writes", async () => {
  assert.deepEqual(await readHomeRecommendationPreferences({ storage: storage() }), { hubs: [], exploration: true });
  const defaults = await readHomeRecommendationPreferences({ storage: storage(), development: true });
  assert.deepEqual(defaults.hubs, []);
  const store = storage();
  await saveHomeRecommendationPreferences({ hubs: [], exploration: false }, { storage: store });
  assert.deepEqual(await readHomeRecommendationPreferences({ storage: store, development: true }), { hubs: [], exploration: false });
  for (const value of [{ hubs: [{ url: "javascript:evil()" }] }, { hubs: [{ url: "https://user:pass@example.com" }] },
    { hubs: Array(13).fill({ url: "https://example.com" }) }, { hubs: [], exploration: "yes" }]) {
    await assert.rejects(saveHomeRecommendationPreferences(value, { storage: store }), TypeError);
  }
  assert.equal(store.data[HOME_RECOMMENDATION_PREFS_KEY].exploration, false);
});

test("identities preserve loopback ports and general queries, while matching only Cartographer document variants", () => {
  assert.notEqual(recommendationIdentity("http://localhost:2527/").page, recommendationIdentity("http://localhost:8765/").page);
  assert.equal(recommendationIdentity("http://127.0.0.1:2527/").page, "http://localhost:2527/");
  assert.notEqual(recommendationIdentity("https://example.com/?q=one").page, recommendationIdentity("https://example.com/?q=two").page);
  const first = recommendationIdentity("http://localhost:2527/memory?file=%2Fnotes%2Fplan.md&days=7&project=one#section");
  const second = recommendationIdentity("http://127.0.0.1:2527/memory?days=30&file=%2Fnotes%2Fplan.md&nav=two");
  assert.equal(first.page, second.page);
  assert.equal(first.path, "/notes/plan.md");
  assert.equal(first.document, true);
  assert.notEqual(first.page, recommendationIdentity("http://localhost:2527/memory?file=%2Fnotes%2Fother.md").page);
  assert.match(recommendationIdentity("http://localhost:8765/memory?file=a.md&days=7").page, /days=7/);
  assert.match(recommendationIdentity("http://localhost:2527/memory?file=a.csv&days=7").page, /days=7/);
  assert.equal(recommendationIdentity("chrome://settings"), null);
});

test("hubs, documents, meaningful revisits and fresh contextual candidates merge into canonical actions", () => {
  const doc = "http://localhost:2527/memory?file=%2Fnotes%2Fplan.md&days=7";
  const results = rank({ preferences: { hubs: [{ url: "http://localhost:8765/", title: "Stats" }] },
    history: [{ url: doc, title: "Plan", visitCount: 4, lastVisitTime: NOW - 5000 },
      { url: "https://oneoff.test/", visitCount: 1, lastVisitTime: NOW - 1000 }],
    context: context([item("https://techmeme.com/")]),
    openTabs: [{ url: "http://127.0.0.1:2527/memory?file=%2Fnotes%2Fplan.md&days=30", id: 9, windowId: 2 }] });
  assert.equal(results.length, 3);
  assert.equal(results[0].features.hub, true);
  const document = results.find(result => result.features.document);
  assert.equal(document.verb, "switch");
  assert.equal(document.target.tabId, 9);
  assert.equal(document.target.windowId, 2);
  assert.deepEqual(results.map(result => result.rank), [1, 2, 3]);
  assert.ok(results.every(result => result.policy === "home-recs-v3" && !Object.hasOwn(result, "probability")));
  assert.equal(results.some(result => result.url.includes("oneoff")), false);
});

test("bookmark density counts distinct siblings with segment boundaries and smooths sparse evidence", () => {
  const result = rank({ context: context([item("https://example.com/docs/guide", .99)]),
    bookmarks: [item("https://example.com/docs/a"), item("https://example.com/docs/a#duplicate"),
      item("https://example.com/docs/b"), item("https://example.com/docs-other/c")] }).find(row => row.url.endsWith("/guide"));
  assert.equal(result.features.bookmarkSupport, 2);
  assert.equal(result.features.bookmarkDensity, 2.5 / 5);
  assert.ok(result.reasons.includes("2 bookmarks in this area"));
});

test("diversity prevents one site or path from consuming the slate; ports remain separate sites", () => {
  const results = rank({ context: context([
    item("https://example.com/docs/a", .99), item("https://example.com/docs/b", .98), item("https://example.com/news", .97),
    item("http://localhost:2527/", .7), item("http://localhost:8765/", .6)
  ]) });
  assert.equal(results.length, 3);
  assert.equal(results.filter(row => row.domain === "example.com").length, 1);
  assert.equal(new Set(results.map(row => row.domain)).size, 3);
});

test("exploration is seeded, reproducible, bounded to supported destinations and explicitly switchable", () => {
  const input = { context: context(Array.from({ length: 8 }, (_, i) => item(`https://site${i}.test/`, .9 - i / 100))), arm: "explore" };
  assert.deepEqual(rank({ ...input, seed: "one" }), rank({ ...input, seed: "one" }));
  const choices = new Set(Array.from({ length: 15 }, (_, i) => rank({ ...input, seed: `visit-${i}` })[2].url));
  assert.ok(choices.size >= 3);
  assert.deepEqual(rank({ ...input, preferences: { exploration: false } }), rank({ ...input, arm: "balanced" }));
  assert.equal(rank({ bookmarks: [item("https://unsafe.test/", .99)], arm: "explore" })[0].sources[0], "bookmark");
});

test("fatigue, recent engagement, snooze, hidden subdomains and explicit exclusions override semantic similarity", () => {
  const candidates = [item("https://repeated.test/", .99), item("https://fresh.test/", .6), item("https://engaged.test/", .98),
    item("https://snoozed.test/", .97), item("https://sub.excluded.example.test/", .96), item("https://excluded.test/", .95)];
  const results = rank({ context: { ...context(candidates), hiddenHosts: ["excluded.example.test"] },
    feedback: { "https://repeated.test/": { impressions: 20, lastShownAt: NOW - 1000 },
      "https://engaged.test/": { engaged: 1, lastEngagedAt: NOW - 1000 },
      "https://snoozed.test/": { snoozedUntil: NOW + 10000 } }, excludePages: ["https://excluded.test/#hash"] });
  assert.equal(results[0].url, "https://fresh.test/");
  assert.equal(results.length, 3);
  assert.ok(results.find(row => row.url.includes("repeated")).features.fatigue > 2);
  assert.ok(results.find(row => row.url.includes("engaged")).features.engagementPenalty > 1);
});

test("stale, expired and future context cannot supply candidates; hubs stay independently usable", () => {
  for (const raw of [
    { ...context([item("https://context.test/")]), expiresAt: NOW },
    { ...context([item("https://context.test/")]), generatedAt: NOW - 31 * 60000 },
    { ...context([item("https://context.test/")]), generatedAt: NOW + 10000 }
  ]) {
    const results = rank({ context: raw, preferences: { hubs: [{ url: "http://localhost:8765/", title: "Stats" }] } });
    assert.equal(results.length, 1);
    assert.equal(results[0].features.hub, true);
    assert.equal(results[0].expiresAt, NOW + 30 * 60000);
  }
  const fresh = rank({ context: { ...context([item("https://context.test/")]), generatedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 10000).toISOString() } });
  assert.equal(fresh[0].expiresAt, NOW + 10000);
});

test("visible locked actions survive own feedback and late arrivals but not snooze or expiry", () => {
  const initial = rank({ context: context([item("https://a.test/", .9), item("https://b.test/", .8), item("https://c.test/", .7)]) });
  const lockedPages = initial.map(row => row.identity);
  const updated = rank({ context: context([item("https://new.test/", .99), item("https://a.test/", .9), item("https://b.test/", .8), item("https://c.test/", .7)]),
    feedback: { "https://a.test/": { impressions: 50, lastShownAt: NOW } }, lockedPages, arm: "explore" });
  assert.deepEqual(updated.map(row => row.identity), lockedPages);
  const snoozed = rank({ context: context([item("https://new.test/", .99), item("https://a.test/", .9), item("https://b.test/", .8), item("https://c.test/", .7)]),
    feedback: { "https://a.test/": { snoozedUntil: NOW + 10000 } }, lockedPages });
  assert.deepEqual(snoozed.map(row => row.identity), ["https://b.test/", "https://c.test/", "https://new.test/"]);
  assert.deepEqual(rank({ context: { ...context([item("https://a.test/")]), expiresAt: NOW }, lockedPages }), []);
});

test("shared bounded shortlist retains older documents and replaces generic Cartographer titles", () => {
  const history = Array.from({ length: 1500 }, (_, index) => ({ url: `https://site${index}.test/`, visitCount: 2, lastVisitTime: NOW - 1000 }));
  const doc = "http://localhost:2527/memory?file=%2Fnotes%2Fresearch-plan.md&days=180";
  history.push({ url: doc, title: "Session Cartographer", visitCount: 5, lastVisitTime: NOW - 90 * 86400000 });
  const bookmarks = Array.from({ length: 1600 }, (_, index) => item(`https://book${index}.test/`));
  const identities = collectHomeRecommendationIdentities({ history, bookmarks });
  assert.ok(identities.length <= 1624);
  assert.ok(identities.includes(recommendationIdentity(doc).page));
  const selected = rank({ history, bookmarks });
  const document = selected.find(row => row.features.document);
  assert.equal(document.title, "research-plan.md");
});

test("one selected hub may share a site with one document, preserving the newest navigation URL", () => {
  const older = "http://127.0.0.1:2527/memory?file=%2Fnotes%2Fplan.md&days=7";
  const newer = "http://127.0.0.1:2527/memory?file=%2Fnotes%2Fplan.md&days=30#evidence";
  const results = rank({ preferences: { hubs: [{ url: "http://127.0.0.1:2527/", title: "Cartographer" }] },
    history: [
      { url: newer, title: "SessionCartographer", visitCount: 5, lastVisitTime: NOW - 1000 },
      { url: older, title: "SessionCartographer", visitCount: 5, lastVisitTime: NOW - 5000 },
      { url: "http://localhost:2527/memory?file=other.md", title: "Other", visitCount: 3, lastVisitTime: NOW - 1000 }
    ], context: context([item("https://techmeme.com/")]) });
  const document = results.find(row => row.features.document);
  assert.equal(document.url, newer);
  assert.equal(document.target.url, newer);
  assert.equal(document.title, "plan.md");
  assert.equal(results.filter(row => row.domain === "localhost:2527").length, 2);
  assert.equal(results.find(row => row.features.hub).url, "http://127.0.0.1:2527/");
});

test("hiding one local app does not hide another port", () => {
  const results = rank({ context: { ...context([]), hiddenHosts: ["localhost:8765"] }, preferences: { hubs: [
    { url: "http://127.0.0.1:8765/", title: "Stats" }, { url: "http://localhost:2527/", title: "Cartographer" }
  ] } });
  assert.equal(results.length, 1);
  assert.equal(results[0].domain, "localhost:2527");
});

test("bookmark support includes tree pages beyond the bounded action shortlist", () => {
  const bookmarks = Array.from({ length: 900 }, (_, index) => item(`https://other${index}.test/`));
  bookmarks.push(item("https://docs.test/research/a"), item("https://docs.test/research/b"),
    item("https://docs.test/research/b#duplicate"), item("https://docs.test/research-other/c"));
  const result = rank({ context: context([item("https://docs.test/research/plan.md", .99)]), bookmarks })
    .find(row => row.features.document);
  assert.equal(result.features.bookmarkSupport, 2);
  assert.equal(result.features.bookmarkDensity, 2.5 / 5);
  assert.equal(collectHomeRecommendationIdentities({ bookmarks }).includes("https://docs.test/research/a"), false);
});

test("a normal recommendation never switches to an incognito tab", () => {
  const results = rank({ preferences: { hubs: [{ url: "https://example.com/", title: "Hub" }] },
    openTabs: [{ id: 77, windowId: 88, url: "https://example.com/", incognito: true }] });
  assert.equal(results[0].verb, "open");
  assert.equal(results[0].target.tabId, undefined);
});

test("history alone surfaces frequent hubs at arbitrary addresses without selected defaults", () => {
  // Counts from the screenshot, addresses deliberately unrelated to personal defaults.
  const history = [
    { url: "http://localhost:4321/", title: "My dashboard", visitCount: 141, lastVisitTime: NOW - 60000 },
    { url: "http://localhost:6789/", title: "My workspace", visitCount: 29, lastVisitTime: NOW - 120000 },
    { url: "https://code.test/someone", title: "Someone", visitCount: 77, lastVisitTime: NOW - 300000 },
    ...Array.from({ length: 20 }, (_, index) => ({ url: `https://noise${index}.test/`, visitCount: 2, lastVisitTime: NOW }))
  ];
  const results = rank({ history });
  assert.deepEqual(new Set(results.map(row => row.url)), new Set(history.slice(0, 3).map(row => row.url)));
  assert.ok(results.every(row => row.features.inferredHub && !row.features.selectedHub));
  assert.ok(results.every(row => !row.sources.includes("selected-hub")));
  assert.deepEqual(rank({ history: [] }), []);
});

test("path hub detection needs repeat history, separates branches and ports, and does not invent ancestors", () => {
  const visit = (url, visits = 3, age = 1000) => ({ url, visitCount: visits, lastVisitTime: NOW - age });
  const history = [visit("https://code.test/owner"), visit("https://code.test/owner/a"), visit("https://code.test/owner/b"),
    visit("https://code.test/owner-other/c"), visit("http://localhost:7654/", 3),
    visit("http://localhost:6543/a"), visit("http://localhost:6543/b")];
  const results = rank({ history });
  const owner = results.find(row => row.url === "https://code.test/owner");
  assert.equal(owner.features.inferredHub, true);
  assert.equal(owner.features.branchPages, 2);
  assert.equal(results.find(row => row.url === "http://localhost:7654/").features.inferredHub, false);
  assert.ok(results.every(row => history.some(raw => raw.url === row.url)));
  assert.equal(rank({ history: [visit("https://stale.test/", 1000, 29 * 86400000)] }).length, 0);
});

test("a profile hub only receives bookmark evidence from its own subtree", () => {
  const results = rank({ history: [{ url: "https://code.test/owner", title: "Owner", visitCount: 77, lastVisitTime: NOW }],
    bookmarks: [item("https://code.test/owner/a"), item("https://code.test/owner/b"),
      item("https://code.test/owner-other/c"), item("https://code.test/unrelated/d")] });
  const owner = results.find(row => row.url === "https://code.test/owner");
  assert.equal(owner.features.bookmarkPath, "/owner");
  assert.equal(owner.features.bookmarkSupport, 2);
  assert.ok(owner.reasons.includes("2 bookmarks in this area"));
});
