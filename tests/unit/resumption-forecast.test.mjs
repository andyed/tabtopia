import test from "node:test";
import assert from "node:assert/strict";

import { createBrowsingSnapshot } from "../../src/lib/browsing-snapshot.js";
import { recognizeStartPageState, START_PAGE_STATES } from "../../src/lib/start-page-state.js";
import { forecastResumption } from "../../src/lib/resumption-forecast.js";

const NOW = Date.UTC(2026, 6, 23, 18, 0, 0);
const MINUTE = 60 * 1000;

test("a clean window after a restart still predicts the trail it lost", () => {
  const snapshot = snapshotOf({
    windows: [{ id: 1, focused: true, tabs: [] }],
    visits: [
      visit("v1", null, "Search", "https://search.example/q", NOW - (25 * MINUTE), "typed"),
      visit("v2", "v1", "Spec", "https://spec.example/intro", NOW - (24 * MINUTE)),
      visit("v3", "v2", "Spec details", "https://spec.example/details", NOW - (22 * MINUTE))
    ]
  });

  assert.equal(snapshot.topology.recoveredItemCount, 3);
  const forecast = forecastResumption(snapshot, { state: START_PAGE_STATES.REORIENTATION });

  assert.equal(forecast.candidates.length, 1);
  const top = forecast.candidates[0];
  assert.equal(top.itemCount, 3);
  assert.equal(top.openCount, 0);
  assert.equal(top.provenance, "local");
  assert.ok(top.score > 0, "a recovered trail must be rankable at all");
  assert.ok(top.reasons.some(reason => reason.includes("recovered from history")));
});

test("reorientation targets the entry point so an abandoned branch is recoverable", () => {
  const snapshot = snapshotOf({
    windows: [{ id: 1, focused: true, tabs: [] }],
    visits: [
      visit("v1", null, "Hub", "https://hub.example/index", NOW - (90 * MINUTE), "typed"),
      visit("v2", "v1", "Branch A", "https://hub.example/a", NOW - (88 * MINUTE)),
      visit("v3", "v1", "Branch B", "https://hub.example/b", NOW - (86 * MINUTE)),
      visit("v4", "v1", "Branch C", "https://hub.example/c", NOW - (84 * MINUTE))
    ]
  });

  const reorientation = forecastResumption(snapshot, { state: START_PAGE_STATES.REORIENTATION });
  const top = reorientation.candidates[0];
  assert.equal(top.action.verb, "restart");
  assert.equal(top.action.target.url, "https://hub.example/index", "the hub is the restart point");
  assert.equal(top.action.resumePoint.url, "https://hub.example/c", "the endpoint is still reported");

  const reinstatement = forecastResumption(snapshot, { state: START_PAGE_STATES.REINSTATEMENT });
  assert.equal(
    reinstatement.candidates[0].action.target.url,
    "https://hub.example/c",
    "reinstatement resumes at the endpoint instead"
  );
});

test("handoff ranks the foreign trail above comparably recent local work", () => {
  const snapshot = snapshotOf({
    windows: [{ id: 1, focused: true, tabs: [] }],
    visits: [
      visit("f1", null, "Phone docs", "https://foreign.example/a", NOW - (11 * MINUTE), "typed", false),
      visit("f2", "f1", "Phone docs next", "https://foreign.example/b", NOW - (10 * MINUTE), "link", false),
      visit("l1", null, "Local notes", "https://local.example/a", NOW - (25 * MINUTE), "typed", true),
      visit("l2", "l1", "Local notes next", "https://local.example/b", NOW - (24 * MINUTE), "link", true)
    ]
  });

  const recognition = recognizeStartPageState(snapshot);
  assert.equal(recognition.state, START_PAGE_STATES.HANDOFF);

  const forecast = forecastResumption(snapshot, { state: recognition.state });
  assert.equal(forecast.candidates[0].provenance, "foreign");
  assert.equal(forecast.candidates[0].action.verb, "continue");
  assert.ok(
    forecast.candidates[0].score > forecast.candidates[1].score,
    "the foreign trail must outrank the local one under handoff"
  );

  const launch = forecastResumption(snapshot, { state: START_PAGE_STATES.LAUNCH });
  assert.equal(launch.candidates[0].provenance, "local", "the same policy must not apply off handoff");
});

test("still-open work is damped, and named a switch rather than a resume", () => {
  const snapshot = snapshotOf({
    windows: [{
      id: 1,
      focused: true,
      tabs: [
        openTab(1, "Open source", "https://open.example/a", NOW - (12 * MINUTE)),
        { ...openTab(2, "Open child", "https://open.example/b", NOW - (11 * MINUTE)), openerTabId: 1 }
      ]
    }],
    visits: [
      visit("c1", null, "Closed source", "https://closed.example/a", NOW - (40 * MINUTE), "typed"),
      visit("c2", "c1", "Closed child", "https://closed.example/b", NOW - (39 * MINUTE))
    ]
  });

  const forecast = forecastResumption(snapshot, { state: START_PAGE_STATES.CONTINUATION });
  const open = forecast.candidates.find(candidate => candidate.openCount === 2);
  const closed = forecast.candidates.find(candidate => candidate.openCount === 0);

  assert.equal(open.action.verb, "switch");
  assert.equal(closed.action.verb, "reopen");
  assert.ok(open.reasons.some(reason => reason.includes("already open")));
  assert.ok(closed.score > open.score, "closed work is what resumption means");
});

test("confidence stays low when only coincidence joins the pages", () => {
  const snapshot = snapshotOf({
    windows: [{ id: 1, focused: true, tabs: [] }],
    visits: [
      visit("t1", null, "Alpha", "https://alpha.example/", NOW - (15 * MINUTE), "typed"),
      visit("t2", null, "Beta", "https://beta.example/", NOW - (14 * MINUTE), "typed")
    ]
  });

  const forecast = forecastResumption(snapshot, { state: START_PAGE_STATES.REORIENTATION });
  const top = forecast.candidates[0];

  assert.equal(top.itemCount, 2);
  assert.equal(top.cues.structuralEdges, 0);
  assert.ok(top.confidence <= 0.6, `temporal-only evidence claimed ${top.confidence}`);
  assert.ok(top.reasons.some(reason => reason.includes("no followed link")));
});

test("an empty profile produces no predictions rather than an invented one", () => {
  const forecast = forecastResumption(snapshotOf({
    windows: [{ id: 1, focused: true, tabs: [] }],
    visits: []
  }), { state: START_PAGE_STATES.LAUNCH });

  assert.deepEqual(forecast.candidates, []);
  assert.equal(forecast.suppressedCount, 0);
});

function snapshotOf({ windows, visits }) {
  const byUrl = new Map();
  for (const item of visits) {
    if (!byUrl.has(item.url)) byUrl.set(item.url, []);
    byUrl.get(item.url).push(item);
  }

  return createBrowsingSnapshot({
    now: NOW,
    currentWindowId: 1,
    windows,
    historyItems: [...byUrl.entries()].map(([url, entries]) => ({
      url,
      title: entries.at(-1).title,
      lastVisitTime: Math.max(...entries.map(entry => entry.visitTime))
    })),
    visitsByUrl: Object.fromEntries(byUrl)
  });
}

function openTab(id, title, url, lastAccessed) {
  return { id, windowId: 1, title, url, lastAccessed, active: id === 1 };
}

function visit(visitId, referringVisitId, title, url, visitTime, transition = "link", isLocal = true) {
  return { visitId, referringVisitId, title, url, visitTime, transition, isLocal };
}
