import test from "node:test";
import assert from "node:assert/strict";

import {
  prepareHabitCandidatePool,
  rankHabitDestinations
} from "../../src/lib/habit-destinations.js";

const now = Date.UTC(2026, 6, 25, 16);

test("shortlist takes both frequent and recent pages without using either as the final score", () => {
  const pool = prepareHabitCandidatePool([
    history("https://frequent.example/home", 80, now - 20 * 24 * 60 * 60 * 1000),
    history("https://recent.example/one", 1, now - 1000),
    history("https://middle.example/two", 10, now - 60_000)
  ], { maxScoredPages: 2 });

  assert.equal(pool.candidates.length, 2);
  assert.deepEqual(
    new Set(pool.candidates.map(candidate => candidate.domain)),
    new Set(["frequent.example", "recent.example"])
  );
  assert.equal(pool.truncated, true);
  assert.equal(pool.candidates.every(candidate => candidate.score === undefined), true);
});

test("domain ACT-R History ranks a frequent destination above a recent one-off", () => {
  const pool = prepareHabitCandidatePool([
    history("https://frequent.example/home", 80, now - 60_000),
    history("https://recent.example/one", 1, now - 1000)
  ]);
  const scores = pool.candidates.map(candidate => candidate.domain === "frequent.example"
    ? score(candidate.key, 1.8, 12, 1.2, 7)
    : score(candidate.key, 0.4, 1, 0.4, 1));

  const forecast = rankHabitDestinations({ pool, historyScores: scores, now });

  assert.equal(forecast.candidates[0].domain, "frequent.example");
  assert.equal(forecast.candidates[0].cues.accessCount, 12);
  assert.equal(forecast.candidates[0].cues.context, 0);
});

test("session neighbors cannot affect habit rank because the ranker accepts no topology input", () => {
  const pool = prepareHabitCandidatePool([
    history("https://linkedin.example/feed", 30, now - 1000),
    history("https://unrelated.example/action", 4, now - 2000)
  ]);
  const scores = pool.candidates.map(candidate => candidate.domain === "linkedin.example"
    ? score(candidate.key, 2.1, 14, 1.7, 10)
    : score(candidate.key, 0.2, 2, 0.2, 2));

  const first = rankHabitDestinations({
    pool,
    historyScores: scores,
    openTabs: [{ id: 9, url: "https://unrelated.example/action", lastAccessed: now }]
  });
  const permuted = rankHabitDestinations({
    pool,
    historyScores: scores,
    openTabs: [
      { id: 10, url: "https://third.example/", lastAccessed: now },
      { id: 9, url: "https://unrelated.example/action", lastAccessed: now - 500 }
    ]
  });

  assert.deepEqual(
    first.candidates.map(candidate => [candidate.domain, candidate.score]),
    permuted.candidates.map(candidate => [candidate.domain, candidate.score])
  );
  assert.equal(first.candidates[0].domain, "linkedin.example");
});

test("multiple pages on a domain yield one concrete destination chosen by page History", () => {
  const pool = prepareHabitCandidatePool([
    history("https://example.com/feed", 20, now - 2000, "Feed"),
    history("https://example.com/notifications", 18, now - 1000, "Notifications")
  ]);
  const scores = pool.candidates.map(candidate => candidate.url.endsWith("/notifications")
    ? score(candidate.key, 2.2, 20, 1.5, 9)
    : score(candidate.key, 2.2, 20, 0.8, 5));

  const forecast = rankHabitDestinations({ pool, historyScores: scores });

  assert.equal(forecast.candidates.length, 1);
  assert.equal(forecast.candidates[0].action.target.url, "https://example.com/notifications");
});

test("an exact open page produces Switch while another page on the domain does not", () => {
  const pool = prepareHabitCandidatePool([
    history("https://example.com/feed", 20, now - 1000, "Feed")
  ]);
  const [candidate] = pool.candidates;
  const scores = [score(candidate.key, 1.4, 8, 1.1, 6)];

  const exact = rankHabitDestinations({
    pool,
    historyScores: scores,
    openTabs: [{ id: 4, url: "https://example.com/feed#top", title: "Open Feed", lastAccessed: now }]
  });
  const otherPage = rankHabitDestinations({
    pool,
    historyScores: scores,
    openTabs: [{ id: 5, url: "https://example.com/settings", title: "Settings", lastAccessed: now }]
  });

  assert.equal(exact.candidates[0].action.verb, "switch");
  assert.equal(exact.candidates[0].action.target.id, 4);
  assert.equal(otherPage.candidates[0].action.verb, "open");
});

test("unsupported URLs and unknown History identities disappear cleanly", () => {
  const pool = prepareHabitCandidatePool([
    history("chrome://settings", 100, now),
    history("file:///tmp/private.html", 80, now),
    history("https://known.example/", 3, now)
  ]);

  assert.deepEqual(pool.candidates.map(candidate => candidate.domain), ["known.example"]);
  const forecast = rankHabitDestinations({
    pool,
    historyScores: [score(pool.candidates[0].key, null, 0, null, 0)]
  });
  assert.deepEqual(forecast.candidates, []);
});

test("shortlisting and tied rankings are deterministic and bounded", () => {
  const items = Array.from({ length: 20 }, (_, index) =>
    history(`https://domain-${index}.example/page`, 5, now - 5000, `Page ${index}`));
  const left = prepareHabitCandidatePool(items, { maxScoredPages: 8 });
  const right = prepareHabitCandidatePool(items.slice().reverse(), { maxScoredPages: 8 });

  assert.equal(left.candidates.length, 8);
  assert.deepEqual(
    left.candidates.map(candidate => candidate.normalizedPage),
    right.candidates.map(candidate => candidate.normalizedPage)
  );

  const tiedScores = left.candidates.map(candidate => score(candidate.key, 1, 3, 1, 3));
  const forecast = rankHabitDestinations({ pool: left, historyScores: tiedScores, limit: 8 });
  assert.deepEqual(
    forecast.candidates.map(candidate => candidate.domain),
    forecast.candidates.map(candidate => candidate.domain).slice().sort()
  );
});

function history(url, visitCount, lastVisitTime, title = url) {
  return {
    url,
    title,
    visitCount,
    typedCount: Math.floor(visitCount / 4),
    lastVisitTime
  };
}

function score(key, domainActivation, domainCount, pageActivation, pageCount) {
  return {
    key,
    domain: {
      activation: domainActivation,
      accessCount: domainCount,
      lastAccessAt: domainCount ? now - 1000 : 0
    },
    page: {
      activation: pageActivation,
      accessCount: pageCount,
      lastAccessAt: pageCount ? now - 1000 : 0
    }
  };
}
