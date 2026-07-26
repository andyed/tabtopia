import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStartPageFeed,
  compositionModeForState,
  HOME_COMPOSITION_MODES
} from "../../src/lib/start-page-feed.js";
import { START_PAGE_STATES } from "../../src/lib/start-page-state.js";

test("composition modes follow the recognized state", () => {
  for (const state of [START_PAGE_STATES.LAUNCH, START_PAGE_STATES.THRESHOLD]) {
    assert.equal(compositionModeForState(state), HOME_COMPOSITION_MODES.QUIET);
  }
  assert.equal(compositionModeForState(START_PAGE_STATES.CONTINUATION), HOME_COMPOSITION_MODES.ENGAGED);
  for (const state of [
    START_PAGE_STATES.REINSTATEMENT,
    START_PAGE_STATES.REORIENTATION,
    START_PAGE_STATES.HANDOFF
  ]) {
    assert.equal(compositionModeForState(state), HOME_COMPOSITION_MODES.RETURN);
  }
});

test("habit-only input fills actions in its existing source order", () => {
  const habits = [
    pageCandidate("habit", "one", "https://one.example/", -9),
    pageCandidate("habit", "two", "https://two.example/", -10),
    pageCandidate("habit", "three", "https://three.example/", -11)
  ];
  const feed = buildStartPageFeed({ habitDestinations: habits });

  assert.deepEqual(feed.actions.map(action => action.pageIdentity), habits.map(item => item.action.target.url));
  assert.equal(feed.actions.every(action => action.sources.includes("habit")), true);
});

test("star-only input fills actions in its existing source order", () => {
  const stars = [
    pageCandidate("star", "one", "https://one.example/", 0.9),
    pageCandidate("star", "two", "https://two.example/", 0.8)
  ];
  const feed = buildStartPageFeed({ deferredIntentions: { candidates: stars } });

  assert.deepEqual(feed.actions.map(action => action.pageIdentity), stars.map(item => item.action.target.url));
  assert.equal(feed.actions.every(action => action.sources.includes("star")), true);
});

test("both sources use explicit alternating slots instead of comparing raw scores", () => {
  const habits = [
    pageCandidate("habit", "h1", "https://habit-1.example/", -100),
    pageCandidate("habit", "h2", "https://habit-2.example/", -200)
  ];
  const stars = [
    pageCandidate("star", "s1", "https://star-1.example/", 0.999),
    pageCandidate("star", "s2", "https://star-2.example/", 0.998)
  ];
  const feed = buildStartPageFeed({
    habitDestinations: { candidates: habits },
    deferredIntentions: stars,
    actionLimit: 4
  });

  assert.deepEqual(feed.actions.map(action => action.sources[0]), ["habit", "star", "habit", "star"]);
  assert.equal(feed.actions.every(action => action.score === undefined), true);
});

test("overlapping habit and star endpoints merge sources and evidence once", () => {
  const habit = pageCandidate("habit", "habit-linkedin", "https://www.linkedin.com/feed#top", -4.2);
  const star = pageCandidate("star", "star-linkedin", "https://linkedin.com/feed", 0.91);
  const feed = buildStartPageFeed({ habitDestinations: [habit], deferredIntentions: [star] });

  assert.equal(feed.actions.length, 1);
  assert.deepEqual(feed.actions[0].sources, ["habit", "star"]);
  assert.deepEqual(feed.actions[0].evidence.map(item => item.score), [-4.2, 0.91]);
  assert.equal(feed.actions[0].score, undefined);
});

test("matching activity contributes evidence without donating score or remaining separate", () => {
  const action = pageCandidate("habit", "habit-docs", "https://docs.example/work", -3);
  const matching = activity("matching", "https://docs.example/work#resume", 0.95);
  const distinct = activity("distinct", "https://other.example/task", 0.4);
  const neighborhoods = [{ id: "n1" }];
  const feed = buildStartPageFeed({
    state: START_PAGE_STATES.REORIENTATION,
    habitDestinations: [action],
    resumptionActivities: { candidates: [matching, distinct] },
    neighborhoods
  });

  assert.deepEqual(feed.actions[0].sources, ["habit", "activity"]);
  assert.equal(feed.actions[0].score, undefined);
  assert.equal(feed.actions[0].evidence.find(item => item.source === "activity").score, 0.95);
  assert.equal(feed.primaryActivity.id, "distinct");
  assert.deepEqual(feed.neighborhoods, neighborhoods);
  assert.equal(feed.mode, "return");
});

test("an unmatched resumption activity remains the primary activity", () => {
  const primary = activity("resume", "https://work.example/end", 0.7);
  const feed = buildStartPageFeed({
    state: START_PAGE_STATES.CONTINUATION,
    resumptionActivities: [primary]
  });

  assert.deepEqual(feed.actions, []);
  assert.equal(feed.primaryActivity.id, "resume");
  assert.deepEqual(feed.primaryActivity.sources, ["activity"]);
  assert.equal(feed.mode, "engaged");
});

test("action order and source evidence are deterministic and bounded", () => {
  const habits = Array.from({ length: 20 }, (_, index) =>
    pageCandidate("habit", `h${index}`, `https://h-${index}.example/`, -index));
  const stars = Array.from({ length: 20 }, (_, index) =>
    pageCandidate("star", `s${index}`, `https://s-${index}.example/`, 1 - index / 100));
  const input = {
    habitDestinations: habits,
    deferredIntentions: stars,
    actionLimit: 1000
  };
  const left = buildStartPageFeed(input);
  const right = buildStartPageFeed(input);

  assert.equal(left.actions.length, 24);
  assert.deepEqual(left.actions, right.actions);
  assert.deepEqual(left.sourceSlots, ["habit", "star", "habit", "star", "habit", "star"]);
});

test("the default feed retains enough actions for a below-fold discovery layer", () => {
  const habits = Array.from({ length: 12 }, (_, index) =>
    pageCandidate("habit", `h${index}`, `https://h-${index}.example/`, -index));
  const feed = buildStartPageFeed({ habitDestinations: habits });

  assert.equal(feed.actions.length, 12);
});

function pageCandidate(source, id, url, score) {
  return {
    id,
    kind: source === "habit" ? "habit-destination" : "deferred-intention",
    score,
    action: { verb: "open", target: { url, title: id, open: false } },
    cues: { sourceCue: id },
    reasons: [`${source} evidence`]
  };
}

function activity(id, url, score) {
  return {
    id,
    kind: "resumption-activity",
    score,
    confidence: 0.5,
    action: { verb: "reopen", target: { url, title: id, open: false } },
    cues: { structure: 0.5 },
    reasons: ["activity evidence"]
  };
}
