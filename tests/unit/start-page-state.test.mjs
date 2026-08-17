import test from "node:test";
import assert from "node:assert/strict";

import {
  DENSITY_REGIMES,
  createBrowsingSnapshot,
  densityRegimeForCount,
  isMeaningfulTab
} from "../../src/lib/browsing-snapshot.js";
import {
  START_PAGE_STATES,
  recognizeStartPageState
} from "../../src/lib/start-page-state.js";
import { startPageFixtures } from "../fixtures/start-page-states.mjs";

const HOUR = 60 * 60 * 1000;

for (const expectedState of Object.values(START_PAGE_STATES)) {
  test(`${expectedState} fixture produces deterministic, explainable recognition`, () => {
    const snapshot = createBrowsingSnapshot(startPageFixtures[expectedState]);
    const first = recognizeStartPageState(snapshot);
    const second = recognizeStartPageState(structuredClone(snapshot));

    assert.equal(first.state, expectedState);
    assert.deepEqual(second, first);
    assert.ok(first.confidence >= 0 && first.confidence <= 1);
    assert.ok(first.evidence.length >= 2);
    assert.ok(first.evidence.every(item => typeof item === "string" && item.length > 0));
  });
}

test("snapshot excludes Tabtopia, browser internals, and incognito tabs", () => {
  const snapshot = createBrowsingSnapshot({
    now: 1000,
    currentWindowId: 1,
    windows: [{
      id: 1,
      focused: true,
      tabs: [
        { id: 1, url: "chrome-extension://abc/src/newtab/newtab.html", title: "tabtopia" },
        { id: 2, url: "chrome://extensions/", title: "Extensions" },
        { id: 3, url: "https://visible.example/", title: "Visible" },
        { id: 4, url: "https://private.example/", title: "Private", incognito: true }
      ]
    }]
  });

  assert.deepEqual(snapshot.tabs.map(tab => tab.id), [3]);
  assert.equal(isMeaningfulTab({ url: "file:///tmp/report.pdf" }), true);
});

test("density regimes follow the per-neighborhood rendering contract", () => {
  assert.equal(densityRegimeForCount(0), DENSITY_REGIMES.EMPTY);
  assert.equal(densityRegimeForCount(2), DENSITY_REGIMES.DIRECT);
  assert.equal(densityRegimeForCount(7), DENSITY_REGIMES.ROUTE);
  assert.equal(densityRegimeForCount(15), DENSITY_REGIMES.MICROGRAPH);
  assert.equal(densityRegimeForCount(30), DENSITY_REGIMES.CLUSTER);
  assert.equal(densityRegimeForCount(31), DENSITY_REGIMES.NEIGHBORHOODS);
});

test("snapshot neighborhoods are connected components rather than windows", () => {
  const now = startPageFixtures.continuation.now;
  const snapshot = createBrowsingSnapshot({
    now,
    currentWindowId: 1,
    windows: [{
      id: 1,
      focused: true,
      tabs: [
        { id: 1, windowId: 1, title: "Source", url: "https://source.example/", lastAccessed: now - 60000 },
        { id: 2, windowId: 1, title: "Child", url: "https://child.example/", lastAccessed: now - 50000, openerTabId: 1 },
        { id: 3, windowId: 1, title: "Separate", url: "https://separate.example/", lastAccessed: now - (20 * 60000) }
      ]
    }]
  });

  assert.equal(snapshot.otherWindows.length, 0);
  assert.equal(snapshot.neighborhoods.length, 2);
  assert.deepEqual(snapshot.neighborhoods.map(item => item.itemCount), [2, 1]);
  assert.equal(snapshot.topology.structuralEdgeCount, 1);
});

test("handoff evidence stays device-agnostic", () => {
  const snapshot = createBrowsingSnapshot(startPageFixtures.handoff);
  const recognition = recognizeStartPageState(snapshot);
  const serialized = JSON.stringify(recognition);

  assert.equal(recognition.state, START_PAGE_STATES.HANDOFF);
  assert.equal(serialized.includes("phone"), false);
  assert.equal(serialized.includes("mobile"), false);
  assert.equal(recognition.signals.foreignVisitCount, 3);
});

test("foreign provenance is explicit rather than inferred from history alone", () => {
  const input = structuredClone(startPageFixtures.handoff);
  input.visitsByUrl = {};
  const snapshot = createBrowsingSnapshot(input);
  const recognition = recognizeStartPageState(snapshot);

  assert.equal(snapshot.availability.foreignProvenance, false);
  assert.notEqual(recognition.state, START_PAGE_STATES.HANDOFF);
});

test("recent local work outranks an older foreign trail", () => {
  const input = structuredClone(startPageFixtures.handoff);
  input.historyItems.push({
    id: "local",
    url: "https://local.example/current",
    title: "Local work",
    lastVisitTime: input.now - 1000,
    isLocal: true
  });
  const snapshot = createBrowsingSnapshot(input);
  const recognition = recognizeStartPageState(snapshot);

  assert.equal(recognition.state, START_PAGE_STATES.LAUNCH);
  assert.equal(recognition.signals.foreignVisitCount, 3);
});

test("a one-hour lunch interruption remains reinstatement", () => {
  const recognition = recognizeStartPageState(snapshotForGap(HOUR));

  assert.equal(recognition.state, START_PAGE_STATES.REINSTATEMENT);
  assert.equal(recognition.signals.crossedLocalDayBoundary, false);
});

test("a ready non-return estimate replaces only the reinstatement boundary", () => {
  const recognition = recognizeStartPageState(snapshotForGap(20 * 60 * 1000), {
    interruptionMs: 15 * 60 * 1000,
    nonReturnWindowEstimate: {
      status: "ready",
      source: "qualified-access-mixture",
      boundaryMs: 15 * 60 * 1000
    }
  });

  assert.equal(recognition.state, START_PAGE_STATES.REINSTATEMENT);
  assert.equal(recognition.signals.interruptionBoundaryMs, 15 * 60 * 1000);
  assert.equal(recognition.signals.interruptionBoundarySource, "qualified-access-mixture");
  assert.ok(recognition.evidence.includes("adaptive-non-return-window"));
});

test("an unready non-return estimate leaves the fallback boundary intact", () => {
  const recognition = recognizeStartPageState(snapshotForGap(20 * 60 * 1000), {
    nonReturnWindowEstimate: {
      status: "insufficient-data",
      source: "fallback",
      boundaryMs: 30 * 60 * 1000
    }
  });

  assert.equal(recognition.state, START_PAGE_STATES.THRESHOLD);
  assert.equal(recognition.signals.interruptionBoundaryMs, 30 * 60 * 1000);
  assert.equal(recognition.signals.interruptionBoundarySource, "fallback");
});

test("an eight-hour interruption becomes reorientation", () => {
  const recognition = recognizeStartPageState(snapshotForGap(8 * HOUR));

  assert.equal(recognition.state, START_PAGE_STATES.REORIENTATION);
  assert.ok(recognition.evidence.includes("extended-interruption"));
});

test("a substantial interruption crossing the local day becomes reorientation", () => {
  const now = Date.UTC(2026, 6, 22, 2, 0, 0);
  const recognition = recognizeStartPageState(snapshotForGap(5 * HOUR, now));

  assert.equal(recognition.state, START_PAGE_STATES.REORIENTATION);
  assert.equal(recognition.signals.crossedLocalDayBoundary, true);
  assert.ok(recognition.evidence.includes("crossed-local-day-boundary"));
});

test("a short interruption near midnight does not imply reorientation", () => {
  const now = Date.UTC(2026, 6, 22, 0, 30, 0);
  const recognition = recognizeStartPageState(snapshotForGap(HOUR, now));

  assert.equal(recognition.state, START_PAGE_STATES.REINSTATEMENT);
  assert.equal(recognition.signals.crossedLocalDayBoundary, true);
});

test("a one-window lunch return is reinstatement rather than continuation", () => {
  const recognition = recognizeStartPageState(snapshotForSingleWindowGap(HOUR));

  assert.equal(recognition.state, START_PAGE_STATES.REINSTATEMENT);
  assert.ok(recognition.evidence.includes("5-live-tabs-in-current-window"));
});

test("a one-window overnight return is reorientation rather than continuation", () => {
  const recognition = recognizeStartPageState(snapshotForSingleWindowGap(8 * HOUR));

  assert.equal(recognition.state, START_PAGE_STATES.REORIENTATION);
  assert.ok(recognition.evidence.includes("extended-interruption"));
});

function snapshotForGap(gapMs, now = startPageFixtures.reinstatement.now) {
  const input = structuredClone(startPageFixtures.reinstatement);
  input.now = now;
  input.timezoneOffsetMinutes = 0;
  input.historyItems = input.historyItems.map(item => ({
    ...item,
    lastVisitTime: now - gapMs
  }));
  input.windows = input.windows.map(window => ({
    ...window,
    tabs: window.tabs.map(tab => tab.url.startsWith("chrome-extension:") ? tab : {
      ...tab,
      lastAccessed: now - gapMs
    })
  }));
  return createBrowsingSnapshot(input);
}

function snapshotForSingleWindowGap(gapMs) {
  const input = structuredClone(startPageFixtures.continuation);
  input.historyItems = input.historyItems.map(item => ({
    ...item,
    lastVisitTime: input.now - gapMs
  }));
  input.windows = input.windows.map(window => ({
    ...window,
    tabs: window.tabs.map(tab => tab.url.startsWith("chrome-extension:") ? tab : {
      ...tab,
      lastAccessed: input.now - gapMs
    })
  }));
  return createBrowsingSnapshot(input);
}
