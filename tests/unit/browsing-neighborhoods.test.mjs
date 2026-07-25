import test from "node:test";
import assert from "node:assert/strict";

import { buildBrowsingNeighborhoods } from "../../src/lib/browsing-neighborhoods.js";

const NOW = Date.UTC(2026, 6, 23, 18, 0, 0);
const MINUTE = 60 * 1000;

test("tab spawn produces a connected neighborhood inside one window", () => {
  const neighborhoods = buildBrowsingNeighborhoods({
    now: NOW,
    tabs: [
      tab(1, "Source", "https://source.example/", NOW - (20 * MINUTE)),
      { ...tab(2, "Child", "https://child.example/", NOW - (10 * MINUTE)), openerTabId: 1 },
      tab(3, "Unrelated", "https://unrelated.example/", NOW - MINUTE)
    ]
  });

  assert.deepEqual(neighborhoods.map(item => item.itemCount), [2, 1]);
  const connected = neighborhoods.find(item => item.itemCount === 2);
  assert.deepEqual(connected.items.map(item => item.id).sort(), [1, 2]);
  assert.equal(connected.relationCounts.spawn, 1);
  assert.equal(connected.openCount, 2);
  assert.equal(connected.recoveredCount, 0);
  assert.deepEqual(connected.edges[0].evidence[0], {
    type: "spawn",
    sourceKey: "tab:1",
    targetKey: "tab:2",
    origin: "chrome-opener"
  });
});

test("referrer evidence connects open pages without an opener id", () => {
  const neighborhoods = buildBrowsingNeighborhoods({
    now: NOW,
    tabs: [
      tab(1, "Search results", "https://search.example/results", NOW - (12 * MINUTE)),
      tab(2, "Article", "https://article.example/story", NOW - (8 * MINUTE))
    ],
    tabHistory: [[2, [{
      url: "https://article.example/story",
      referer: "https://search.example/results",
      timestamp: NOW - (8 * MINUTE)
    }]]]
  });

  assert.equal(neighborhoods.length, 1);
  assert.equal(neighborhoods[0].relationCounts.referrer, 1);
  assert.ok(neighborhoods[0].edges[0].types.includes("referrer"));
  assert.deepEqual(neighborhoods[0].edges[0].evidence[0], {
    type: "referrer",
    sourceKey: "tab:1",
    targetKey: "tab:2",
    origin: "navigation",
    timestamp: NOW - (8 * MINUTE)
  });
});

test("nearby activity creates a weak temporal neighborhood while older work stays separate", () => {
  const neighborhoods = buildBrowsingNeighborhoods({
    now: NOW,
    tabs: [
      tab(1, "First", "https://first.example/", NOW - (3 * MINUTE)),
      tab(2, "Second", "https://second.example/", NOW - MINUTE),
      tab(3, "Older", "https://older.example/", NOW - (45 * MINUTE))
    ]
  });

  assert.deepEqual(neighborhoods.map(item => item.itemCount), [2, 1]);
  const connected = neighborhoods.find(item => item.itemCount === 2);
  assert.equal(connected.relationCounts.temporal, 1);
  assert.equal(connected.relationCounts.spawn, 0);
  assert.equal(connected.relationCounts.referrer, 0);
  assert.deepEqual(connected.edges[0].evidence[0], {
    type: "temporal",
    sourceKey: "tab:1",
    targetKey: "tab:2",
    origin: "activity-overlap",
    distanceMs: 2 * MINUTE
  });
});

test("components can cross windows when provenance connects them", () => {
  const neighborhoods = buildBrowsingNeighborhoods({
    now: NOW,
    tabs: [
      tab(1, "Source", "https://source.example/", NOW - (8 * MINUTE), 1),
      tab(2, "Detached child", "https://child.example/", NOW - (7 * MINUTE), 2)
    ],
    tabRelationships: [[2, {
      referringTabId: 1,
      transitionType: "opener",
      timestamp: NOW - (7 * MINUTE)
    }]]
  });

  assert.equal(neighborhoods.length, 1);
  assert.deepEqual(neighborhoods[0].windowIds.sort(), [1, 2]);
  assert.equal(neighborhoods[0].relationCounts.spawn, 1);
});

test("a referral trail survives the tabs that made it", () => {
  const neighborhoods = buildBrowsingNeighborhoods({
    now: NOW,
    tabs: [],
    visits: [
      visit("v1", null, "Search", "https://search.example/q", NOW - (40 * MINUTE), "typed"),
      visit("v2", "v1", "Guide", "https://guide.example/intro", NOW - (38 * MINUTE)),
      visit("v3", "v2", "Reference", "https://guide.example/reference", NOW - (36 * MINUTE))
    ]
  });

  assert.equal(neighborhoods.length, 1);
  const trail = neighborhoods[0];
  assert.equal(trail.itemCount, 3);
  assert.equal(trail.openCount, 0);
  assert.equal(trail.recoveredCount, 3);
  assert.equal(trail.relationCounts.referrer, 2);
  assert.ok(trail.items.every(item => item.kind === "page" && item.open === false));
  assert.equal(trail.followedArrivals, 2);

  const firstHop = trail.edges
    .flatMap(edge => edge.evidence)
    .find(evidence => evidence.origin === "visit-referral"
      && evidence.targetKey === "page:https://guide.example/intro");
  assert.deepEqual(firstHop, {
    type: "referrer",
    sourceKey: "page:https://search.example/q",
    targetKey: "page:https://guide.example/intro",
    origin: "visit-referral",
    transition: "link",
    timestamp: NOW - (38 * MINUTE)
  });
});

test("a visit to an open page merges into that tab rather than duplicating it", () => {
  const neighborhoods = buildBrowsingNeighborhoods({
    now: NOW,
    tabs: [tab(7, "Guide", "https://guide.example/intro", NOW - (5 * MINUTE))],
    visits: [
      visit("v1", null, "Search", "https://search.example/q", NOW - (9 * MINUTE), "typed"),
      visit("v2", "v1", "Guide", "https://guide.example/intro", NOW - (8 * MINUTE)),
      visit("v3", null, "Guide", "https://guide.example/intro#later", NOW - (5 * MINUTE))
    ]
  });

  assert.equal(neighborhoods.length, 1);
  const merged = neighborhoods[0];
  assert.equal(merged.itemCount, 2);
  assert.equal(merged.openCount, 1);
  assert.equal(merged.recoveredCount, 1);

  const guide = merged.items.find(item => item.title === "Guide");
  assert.equal(guide.kind, "tab");
  assert.equal(guide.open, true);
  assert.equal(guide.visitCount, 2, "the fragment-only URL is the same page identity");
});

test("foreign visits are counted so a handoff trail is distinguishable", () => {
  const neighborhoods = buildBrowsingNeighborhoods({
    now: NOW,
    tabs: [],
    visits: [
      visit("v1", null, "Docs", "https://docs.example/a", NOW - (20 * MINUTE), "typed", false),
      visit("v2", "v1", "Docs next", "https://docs.example/b", NOW - (19 * MINUTE), "link", false)
    ]
  });

  assert.equal(neighborhoods.length, 1);
  assert.equal(neighborhoods[0].foreignVisitCount, 2);
  assert.equal(neighborhoods[0].visitCount, 2);
});

test("temporal overlap cannot chain a browsing afternoon into one component", () => {
  const budgetMs = 30 * MINUTE;
  const visits = [];
  for (let step = 0; step < 40; step += 1) {
    visits.push(visit(
      `v${step}`,
      null,
      `Page ${step}`,
      `https://drift.example/${String(step).padStart(2, "0")}`,
      NOW - ((120 - (step * 3)) * MINUTE),
      "typed"
    ));
  }

  const neighborhoods = buildBrowsingNeighborhoods({
    now: NOW,
    tabs: [],
    visits,
    temporalSpanBudgetMs: budgetMs
  });

  assert.ok(neighborhoods.length > 1, "a two-hour drift must not become one hairball");
  assert.equal(neighborhoods.reduce((sum, item) => sum + item.itemCount, 0), 40);

  // The budget bounds what temporal merging may join. It cannot bound a single
  // page's own span — one URL revisited across an afternoon is still one page —
  // so the invariant is only meaningful for components that were actually merged.
  for (const neighborhood of neighborhoods.filter(item => item.itemCount > 1)) {
    assert.ok(
      neighborhood.spanMs <= budgetMs,
      `component ${neighborhood.id} spans ${neighborhood.spanMs}ms over the ${budgetMs}ms budget`
    );
  }
});

test("a page revisited all afternoon stays one node instead of merging outward", () => {
  const neighborhoods = buildBrowsingNeighborhoods({
    now: NOW,
    tabs: [],
    visits: [
      visit("v1", null, "Inbox", "https://mail.example/thread", NOW - (70 * MINUTE), "typed"),
      visit("v2", null, "Inbox", "https://mail.example/thread", NOW - (10 * MINUTE), "typed"),
      visit("v3", null, "Aside", "https://aside.example/", NOW - (9 * MINUTE), "typed")
    ],
    temporalSpanBudgetMs: 30 * MINUTE
  });

  const inbox = neighborhoods.find(item => item.items.some(page => page.url === "https://mail.example/thread"));
  assert.equal(inbox.itemCount, 1, "its own 60m span must not drag a neighbour in");
  assert.equal(inbox.items[0].visitCount, 2);
  assert.ok(inbox.spanMs > 30 * MINUTE, "a single node may exceed the merge budget");
});

test("structural evidence may exceed the temporal span budget", () => {
  const neighborhoods = buildBrowsingNeighborhoods({
    now: NOW,
    tabs: [],
    visits: [
      visit("v1", null, "Start", "https://long.example/start", NOW - (200 * MINUTE), "typed"),
      visit("v2", "v1", "End", "https://long.example/end", NOW - (10 * MINUTE))
    ],
    temporalSpanBudgetMs: 30 * MINUTE
  });

  assert.equal(neighborhoods.length, 1, "a followed link is a real join regardless of elapsed time");
  assert.equal(neighborhoods[0].relationCounts.referrer, 1);
  assert.ok(neighborhoods[0].spanMs > 30 * MINUTE);
});

test("visits outside the horizon are dropped rather than clustered", () => {
  const neighborhoods = buildBrowsingNeighborhoods({
    now: NOW,
    tabs: [],
    visits: [
      visit("v1", null, "Yesterday", "https://stale.example/", NOW - (30 * 60 * MINUTE), "typed"),
      visit("v2", null, "Today", "https://fresh.example/", NOW - (5 * MINUTE), "typed")
    ]
  });

  assert.equal(neighborhoods.length, 1);
  assert.equal(neighborhoods[0].items[0].url, "https://fresh.example/");
});

function tab(id, title, url, lastAccessed, windowId = 1) {
  return { id, windowId, title, url, lastAccessed, active: id === 1 };
}

function visit(visitId, referringVisitId, title, url, visitTime, transition = "link", isLocal = true) {
  return { visitId, referringVisitId, title, url, visitTime, transition, isLocal };
}
