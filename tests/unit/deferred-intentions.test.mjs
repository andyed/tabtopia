import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDeferredIntentions,
  DEFERRED_INTENTION_DEFAULTS
} from "../../src/lib/deferred-intentions.js";

const NOW = Date.UTC(2026, 6, 25, 17);
const DAY = 24 * 60 * 60 * 1000;

test("bookmark recency remains continuous evidence", () => {
  const result = buildDeferredIntentions({
    now: NOW,
    bookmarks: [
      bookmark("new", "https://new.example/", NOW - DAY),
      bookmark("middle", "https://middle.example/", NOW - (10 * DAY)),
      bookmark("old", "https://old.example/", NOW - (20 * DAY))
    ]
  });

  const scores = result.candidates.map(candidate => candidate.cues.bookmarkRecency);
  assert.ok(scores[0] > scores[1]);
  assert.ok(scores[1] > scores[2]);
  assert.equal(new Set(scores).size, 3);
  assert.equal(scores.every(score => score > 0 && score < 1), true);
});

test("History flags a revisit after save without inventing low-dwell evidence", () => {
  const result = buildDeferredIntentions({
    now: NOW,
    bookmarks: [
      bookmark("revisited", "https://example.com/revisited", NOW - (5 * DAY)),
      bookmark("waiting", "https://example.com/waiting", NOW - (4 * DAY))
    ],
    historyItems: [
      { url: "https://example.com/revisited#section", lastVisitTime: NOW - DAY },
      { url: "https://example.com/waiting", lastVisitTime: NOW - (6 * DAY) }
    ]
  });

  const revisited = result.candidates.find(candidate => candidate.id === "star:revisited");
  const waiting = result.candidates.find(candidate => candidate.id === "star:waiting");
  assert.equal(revisited.cues.revisitedAfterSave, true);
  assert.equal(waiting.cues.revisitedAfterSave, false);
  assert.equal(JSON.stringify(result).includes("dwell"), false);
  assert.ok(revisited.reasons.some(reason => reason.includes("intent remains uncertain")));
});

test("duplicate bookmarks normalize to one page and retain the newest save", () => {
  const result = buildDeferredIntentions({
    now: NOW,
    bookmarks: [
      bookmark("older", "https://www.Example.com/article#old", NOW - (8 * DAY), "Old title"),
      bookmark("newer", "https://example.com/article#new", NOW - (2 * DAY), "New title")
    ]
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, "star:newer");
  assert.equal(result.candidates[0].action.target.title, "New title");
  assert.equal(result.candidates[0].cues.bookmarkCount, 2);
});

test("an exact open page switches while another page on the domain still opens", () => {
  const bookmarks = [bookmark("saved", "https://example.com/article", NOW - DAY)];
  const exact = buildDeferredIntentions({
    now: NOW,
    bookmarks,
    openTabs: [{ id: 4, url: "https://www.example.com/article#reading", title: "Open article", lastAccessed: NOW }]
  });
  const other = buildDeferredIntentions({
    now: NOW,
    bookmarks,
    openTabs: [{ id: 5, url: "https://example.com/other", title: "Other", lastAccessed: NOW }]
  });

  assert.equal(exact.candidates[0].action.verb, "switch");
  assert.equal(exact.candidates[0].action.target.id, 4);
  assert.equal(other.candidates[0].action.verb, "open");
});

test("only HTTP/S bookmarks are eligible, including inside bookmark trees", () => {
  const result = buildDeferredIntentions({
    now: NOW,
    bookmarks: [{
      id: "folder",
      children: [
        bookmark("https", "https://eligible.example/", NOW - DAY),
        bookmark("file", "file:///tmp/private", NOW - DAY),
        bookmark("chrome", "chrome://settings", NOW - DAY)
      ]
    }]
  });

  assert.deepEqual(result.candidates.map(candidate => candidate.id), ["star:https"]);
});

test("output is deterministic and bounded regardless of input order", () => {
  const bookmarks = Array.from({ length: 40 }, (_, index) =>
    bookmark(String(index), `https://site-${index}.example/`, NOW - (3 * DAY)));
  const left = buildDeferredIntentions({ now: NOW, bookmarks, limit: 1000 });
  const right = buildDeferredIntentions({ now: NOW, bookmarks: bookmarks.slice().reverse(), limit: 1000 });

  assert.equal(left.candidates.length, DEFERRED_INTENTION_DEFAULTS.maxResultLimit);
  assert.deepEqual(
    left.candidates.map(candidate => candidate.action.target.url),
    right.candidates.map(candidate => candidate.action.target.url)
  );
  assert.equal(left.suppressedCount, 16);
});

function bookmark(id, url, dateAdded, title = id) {
  return { id, url, dateAdded, title };
}
