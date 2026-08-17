import test from "node:test";
import assert from "node:assert/strict";

import {
  activityUrlLabel,
  buildActivityJourney,
  pageRoleIdentity
} from "../../src/lib/activity-journey.js";

const BASE = Date.UTC(2026, 6, 30, 16, 0, 0);

test("groups query variants into deterministic page roles and preserves evidence direction", () => {
  const journey = buildActivityJourney({
    items: [
      page("event", "Monthly Gathering", "https://www.meetup.com/group/events/42/?eventOrigin=group", 0),
      page("attendees-login", "Attendees", "https://www.meetup.com/group/events/42/attendees/?loginProvider=google", 1),
      page("attendees", "Attendees", "https://www.meetup.com/group/events/42/attendees/", 2),
      page("checkout-monthly", "Checkout", "https://www.meetup.com/subscription/checkout/?billing=monthly", 3),
      page("checkout-return", "Checkout", "https://www.meetup.com/subscription/checkout/?trigger=attendees", 4),
      page("groups", "Your groups", "https://www.meetup.com/groups/", 5)
    ],
    edges: [
      edge("event", "attendees-login", "referrer", BASE + 1000),
      edge("attendees-login", "checkout-monthly", "referrer", BASE + 2000),
      edge("checkout-monthly", "attendees", "referrer", BASE + 3000),
      edge("attendees", "checkout-return", "referrer", BASE + 4000),
      edge("checkout-return", "groups", "referrer", BASE + 5000)
    ]
  });

  assert.equal(journey.recordedPageCount, 6);
  assert.equal(journey.roleCount, 4);
  assert.equal(journey.structuralEdgeCount, 4);
  assert.deepEqual(journey.nodes.map(node => node.title), [
    "Monthly Gathering",
    "Attendees",
    "Checkout",
    "Your groups"
  ]);
  assert.equal(journey.nodes[1].recordedPages, 2);
  assert.equal(journey.nodes[1].internalTransitions, 0);
  assert.equal(journey.nodes[1].repeated, true);
  assert.deepEqual(
    journey.edges.map(item => [item.source, item.target, item.count]),
    [
      ["https://meetup.com/group/events/42", "https://meetup.com/group/events/42/attendees", 1],
      ["https://meetup.com/group/events/42/attendees", "https://meetup.com/subscription/checkout", 2],
      ["https://meetup.com/subscription/checkout", "https://meetup.com/group/events/42/attendees", 1],
      ["https://meetup.com/subscription/checkout", "https://meetup.com/groups", 1]
    ]
  );
});

test("uses favicons only at recorded domain-run boundaries", () => {
  const journey = buildActivityJourney({
    items: [
      page("one", "Meetup event", "https://meetup.com/event", 0),
      page("two", "Meetup login", "https://meetup.com/login", 1),
      page("three", "Google auth", "https://accounts.google.com/auth", 2),
      page("four", "Meetup return", "https://meetup.com/return", 3)
    ],
    edges: [
      edge("one", "two", "referrer", BASE + 1000),
      edge("two", "three", "referrer", BASE + 2000),
      edge("three", "four", "referrer", BASE + 3000)
    ]
  });

  assert.deepEqual(journey.nodes.map(node => node.showFavicon), [true, false, true, true]);
  assert.equal(journey.dominantDomain, "meetup.com");
});

test("keeps temporal evidence undirected and refuses temporal-only graphs", () => {
  const items = [
    page("one", "One", "https://one.example/a", 0),
    page("two", "Two", "https://two.example/b", 1),
    page("three", "Three", "https://three.example/c", 2)
  ];
  assert.equal(buildActivityJourney({
    items,
    edges: [
      edge("two", "one", "temporal", BASE + 1000),
      edge("three", "two", "temporal", BASE + 2000)
    ]
  }), null);

  const journey = buildActivityJourney({
    items,
    edges: [
      edge("one", "two", "referrer", BASE + 1000),
      edge("two", "three", "spawn", BASE + 2000),
      edge("three", "one", "temporal", BASE + 3000)
    ]
  });
  const temporal = journey.edges.find(item => item.kind === "temporal");
  assert.equal(temporal.source, "https://one.example/a");
  assert.equal(temporal.target, "https://three.example/c");
});

test("does not invent direction from a structural edge without evidence", () => {
  const items = [
    page("one", "One", "https://one.example/a", 0),
    page("two", "Two", "https://two.example/b", 1),
    page("three", "Three", "https://three.example/c", 2)
  ];
  assert.equal(buildActivityJourney({
    items,
    edges: [
      { source: "one", target: "two", types: ["referrer"] },
      { source: "two", target: "three", types: ["spawn"] }
    ]
  }), null);
});

test("bounds graph density and rejects non-web page roles", () => {
  assert.equal(pageRoleIdentity("chrome://newtab/"), "");
  assert.equal(pageRoleIdentity("https://Example.com/a/?q=one#part"), "https://example.com/a");

  const items = Array.from({ length: 11 }, (_, index) =>
    page(`page-${index}`, `Page ${index}`, `https://example.com/${index}`, index)
  );
  const edges = items.slice(1).map((_, index) =>
    edge(`page-${index}`, `page-${index + 1}`, "referrer", BASE + index)
  );
  assert.equal(buildActivityJourney({ items, edges }), null);
});

test("uses a two-row serpentine layout once a graph has four roles", () => {
  const items = Array.from({ length: 5 }, (_, index) =>
    page(`page-${index}`, `Page ${index}`, `https://example.com/${index}`, index)
  );
  const edges = items.slice(1).map((_, index) =>
    edge(`page-${index}`, `page-${index + 1}`, "referrer", BASE + index)
  );
  const journey = buildActivityJourney({ items, edges });
  assert.deepEqual(journey.nodes.map(node => node.position), [
    { x: 10, y: 28 },
    { x: 50, y: 28 },
    { x: 90, y: 28 },
    { x: 90, y: 74 },
    { x: 50, y: 74 }
  ]);
});

test("describes app URLs when their document titles do not distinguish the pages", () => {
  assert.equal(
    activityUrlLabel("https://www.google.com/maps/place/Blueberry+Dr/@37.05012,-122.01234,17z/data=!4m2"),
    "Place · Blueberry Dr · 17z near 37.0501, -122.0123"
  );
  assert.equal(
    activityUrlLabel("https://www.google.com/maps/dir/Santa+Cruz/Blueberry+Dr/@37.05,-122.01,12.5z"),
    "Directions · Santa Cruz → Blueberry Dr · 12.5z near 37.0500, -122.0100"
  );
  assert.equal(
    activityUrlLabel("https://example.com/catalog/results?q=blueberries"),
    "Search · blueberries"
  );
  assert.equal(
    activityUrlLabel("https://meetup.com/subscription/checkout/?billing=monthly&utm_source=email"),
    "meetup.com · subscription / checkout · billing · monthly"
  );
  assert.equal(
    activityUrlLabel("https://example.com/account/callback?code=secret&state=private"),
    "example.com · account / callback"
  );
  assert.equal(activityUrlLabel("chrome://history/"), "");
});

function page(key, title, url, minute) {
  return {
    key,
    title,
    url,
    visitCount: 1,
    timestamps: [BASE + (minute * 60_000)],
    lastActivityAt: BASE + (minute * 60_000),
    open: minute === 5,
    active: minute === 5
  };
}

function edge(sourceKey, targetKey, type, timestamp) {
  return {
    source: sourceKey,
    target: targetKey,
    types: [type],
    evidence: [{
      type,
      sourceKey,
      targetKey,
      origin: type === "temporal" ? "activity-overlap" : "visit-referral",
      timestamp
    }]
  };
}
