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
