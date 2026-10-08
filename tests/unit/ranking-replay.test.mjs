import test from "node:test";
import assert from "node:assert/strict";

import { buildShadowPredictions, SHADOW_MODEL_VERSIONS } from "../../src/lib/shadow-ranking.js";
import {
    DIAGNOSTICS_REPLAY_KEY,
    RANKING_STUDY_COHORT,
    RankingDiagnostics,
    summarizeRankingDiagnostics
} from "../../src/lib/ranking-diagnostics.js";
import {
    MAX_REPLAY_CANDIDATES,
    REPLAY_CURRENT_TAB_ID,
    REPLAY_FEATURES,
    captureReplayFeatures,
    decodeReplayRows,
    encodeReplayRows,
    finalizeReplayRow,
    reconstructCandidates,
    replayOutcome
} from "../../src/lib/ranking-replay.js";

class MemoryStorage {
    constructor(values = {}) { this.values = structuredClone(values); }
    async get(keys) {
        return Object.fromEntries(keys.filter(key => key in this.values)
            .map(key => [key, structuredClone(this.values[key])]));
    }
    async set(values) {
        for (const [key, value] of Object.entries(structuredClone(values))) {
            if (value === undefined) delete this.values[key]; else this.values[key] = value;
        }
    }
    async remove(key) { delete this.values[key]; }
}

const NOW = 1_800_000_000_000;

function candidate(tabId, overrides = {}) {
    return {
        tabId,
        windowId: 1,
        index: tabId / 10,
        domain: "beta.example",
        title: `Private title ${tabId}`,
        url: `https://private.example/${tabId}`,
        pinned: false,
        audible: false,
        lastAccessed: NOW - tabId * 1000,
        totalTimeSpent: tabId,
        firstSeen: NOW - 86_400_000,
        frecencyScore: Number.NEGATIVE_INFINITY,
        pageHistoryScore: Number.NEGATIVE_INFINITY,
        domainHistoryScore: Number.NEGATIVE_INFINITY,
        pageContextScore: 0,
        domainContextScore: 0,
        pageContextAvailable: true,
        domainContextAvailable: true,
        pageBayesianScore: Number.NEGATIVE_INFINITY,
        domainBayesianScore: Number.NEGATIVE_INFINITY,
        hierarchicalBayesianScore: Number.NEGATIVE_INFINITY,
        ...overrides
    };
}

// Deliberately awkward: ties on lastAccessed, a candidate with no index, one
// in another window, one with no domain, abstaining models (-Infinity), a
// current tab that is not the first candidate, and unsorted tab ids.
function fixture() {
    const candidates = [
        candidate(50, { domain: "alpha.example", frecencyScore: 0.25, pageBayesianScore: 0.1, lastAccessed: NOW - 5000 }),
        candidate(30, { domain: "alpha.example", index: 3, frecencyScore: 0.5 }), // current
        candidate(10, { windowId: 2, index: 0, frecencyScore: 0.4, domainBayesianScore: 0.3, lastAccessed: NOW - 5000 }),
        candidate(40, { index: null, domain: "", pageContextScore: 0.7, domainContextScore: 0.2 }),
        candidate(20, { pinned: true, audible: true, hierarchicalBayesianScore: 0.9, frecencyScore: 0.4, lastAccessed: 0 }),
        candidate(60, { domain: "gamma.example", pageContextAvailable: false, domainContextAvailable: false })
    ];
    return { candidates, currentTabId: 30 };
}

// Replay numbers eligible tabs by their live tab-id rank, so a live tab id maps
// to (its rank among eligible ids) + 1.
function positionsOf(prediction, eligibleTabIds) {
    const sorted = [...eligibleTabIds].sort((left, right) => left - right);
    return prediction.predictedTabIds.map(tabId => sorted.indexOf(tabId) + 1);
}

test("a replayed row reproduces every live model's ranking and confidence", () => {
    const { candidates, currentTabId } = fixture();
    const live = buildShadowPredictions(candidates, { currentTabId });
    const capture = captureReplayFeatures(candidates, live, { now: NOW });
    assert.equal(capture.matrix.length, live.eligibleTabIds.length);
    assert.equal(capture.features.length, REPLAY_FEATURES.length);
    for (const values of capture.matrix) {
        for (const value of values) assert.ok(value === null || (typeof value === "number" && Number.isFinite(value)));
    }
    // Nothing identifying survives into the capture.
    const text = JSON.stringify(capture);
    for (const needle of ["example", "private", "Private", "https", "tabId", "title"]) assert.ok(!text.includes(needle), needle);

    const row = finalizeReplayRow(capture, { outcomeIndex: 2, timestamp: NOW + 4000, cohort: RANKING_STUDY_COHORT });
    const [decoded] = decodeReplayRows(encodeReplayRows([row]));
    assert.deepEqual(decoded.matrix, row.matrix);
    assert.equal(decoded.cohort, RANKING_STUDY_COHORT);

    const replayed = buildShadowPredictions(reconstructCandidates(decoded), { currentTabId: REPLAY_CURRENT_TAB_ID });
    assert.deepEqual(Object.keys(replayed.models), Object.keys(live.models));
    for (const version of Object.values(SHADOW_MODEL_VERSIONS)) {
        const expected = live.models[version];
        const actual = replayed.models[version];
        assert.deepEqual(actual.predictedTabIds, positionsOf(expected, live.eligibleTabIds), version);
        assert.equal(actual.identityResolution, expected.identityResolution, version);
        assert.equal(actual.probabilities.length, expected.probabilities.length, version);
        expected.probabilities.forEach((probability, index) => {
            assert.ok(Math.abs(probability - actual.probabilities[index]) < 1e-9, `${version} probability ${index}`);
        });
    }
    // The fixture must actually exercise abstention and the strip model, or
    // the equality above proves less than it claims.
    assert.equal(live.models[SHADOW_MODEL_VERSIONS.bayesPage].predictedTabIds.length, 1);
    assert.ok(live.models[SHADOW_MODEL_VERSIONS.stripNeighbor].predictedTabIds.length >= 2);
    assert.ok(live.models[SHADOW_MODEL_VERSIONS.sameDomain].predictedTabIds.length >= 1);
});

test("replayOutcome agrees with takePendingPrediction on every model's actual rank", async () => {
    const { candidates, currentTabId } = fixture();
    const live = buildShadowPredictions(candidates, { currentTabId });
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const diagnostics = await new RankingDiagnostics(local, session, { now: () => NOW, flushDelayMs: 1 })
        .init({ installType: "development" });
    await diagnostics.setPendingPrediction({
        ...live, latencyMs: 1, replay: captureReplayFeatures(candidates, live, { now: NOW })
    }, NOW);
    const record = await diagnostics.takePendingPrediction(10, 2000, candidates.map(item => item.tabId), NOW + 3000);
    assert.equal(record.censorReason, "");
    assert.ok(record.replay, "eligible outcome carries a replay row");
    assert.equal(record.replay.outcomeIndex, live.eligibleTabIds.indexOf(10));
    assert.equal(record.replay.timestamp, record.timestamp);

    const replayed = replayOutcome(record.replay);
    assert.equal(replayed.models.length, record.models.length);
    for (const model of record.models) {
        const twin = replayed.models.find(item => item.modelVersion === model.modelVersion);
        assert.equal(twin.actualRank, model.actualRank, model.modelVersion);
        assert.equal(twin.predictedCount, model.predictedCount, model.modelVersion);
        assert.ok(Math.abs(twin.actualProbability - model.actualProbability) < 1e-9, model.modelVersion);
    }
    assert.ok(record.models.some(model => model.actualRank === 1), "fixture has at least one hit");
    assert.ok(record.models.some(model => model.actualRank > 1), "fixture has at least one miss");
});

test("diagnostics persist replay rows for eligible outcomes only, report them, and clear them", async () => {
    const { candidates, currentTabId } = fixture();
    const live = buildShadowPredictions(candidates, { currentTabId });
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const diagnostics = await new RankingDiagnostics(local, session, { now: () => NOW, flushDelayMs: 1 })
        .init({ installType: "development" });
    const capture = captureReplayFeatures(candidates, live, { now: NOW });

    await diagnostics.setPendingPrediction({ ...live, latencyMs: 1, replay: capture }, NOW);
    diagnostics.record(await diagnostics.takePendingPrediction(10, 2000, candidates.map(item => item.tabId), NOW + 1000));
    // Out-of-set destination: censored, so no row.
    await diagnostics.setPendingPrediction({ ...live, latencyMs: 1, replay: capture }, NOW + 2000);
    diagnostics.record(await diagnostics.takePendingPrediction(999, 2000, candidates.map(item => item.tabId), NOW + 3000));
    // Matrix width does not match the eligible set: capture is dropped, outcome still recorded.
    await diagnostics.setPendingPrediction({
        ...live, latencyMs: 1, replay: { ...capture, matrix: capture.matrix.slice(1) }
    }, NOW + 4000);
    diagnostics.record(await diagnostics.takePendingPrediction(20, 2000, candidates.map(item => item.tabId), NOW + 5000));
    await diagnostics.flush();

    const rows = decodeReplayRows(local.values[DIAGNOSTICS_REPLAY_KEY]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcomeIndex, live.eligibleTabIds.indexOf(10));
    const summary = await diagnostics.getSummary();
    assert.equal(summary.study.outcomes, 3);
    assert.equal(summary.study.replayRows, 1);

    await diagnostics.clear();
    assert.equal(local.values[DIAGNOSTICS_REPLAY_KEY], undefined);
});

test("large snapshots truncate to the most recent candidates plus the outcome, and the codec honours its byte budget", () => {
    const candidates = Array.from({ length: 400 }, (_, i) => candidate(1000 + i * 10, {
        lastAccessed: NOW - (400 - i) * 60_000, index: i
    }));
    const currentTabId = 1000;
    const live = buildShadowPredictions(candidates, { currentTabId });
    const capture = captureReplayFeatures(candidates, live, { now: NOW });
    // Outcome is the oldest eligible tab, which recency alone would drop.
    const outcomeIndex = 0;
    const row = finalizeReplayRow(capture, { outcomeIndex, timestamp: NOW, cohort: RANKING_STUDY_COHORT });
    assert.equal(row.truncated, 1);
    assert.equal(row.matrix.length, MAX_REPLAY_CANDIDATES);
    assert.equal(row.totalCandidates, 399);
    assert.deepEqual(row.matrix[row.outcomeIndex], capture.matrix[outcomeIndex]);
    assert.equal(row.positions[row.outcomeIndex], outcomeIndex);
    // Kept rows stay in original order so tab-id tie-breaks replay.
    assert.deepEqual([...row.positions].sort((a, b) => a - b), row.positions);
    const ageColumn = REPLAY_FEATURES.indexOf("accessAgeMs");
    const keptAges = row.positions.filter(position => position !== outcomeIndex).map(position => capture.matrix[position][ageColumn]);
    const droppedAges = capture.matrix.map((values, position) => [position, values[ageColumn]])
        .filter(([position]) => !row.positions.includes(position)).map(([, age]) => age);
    assert.ok(Math.max(...keptAges) <= Math.min(...droppedAges), "kept candidates are the most recent");

    const many = Array.from({ length: 50 }, (_, i) => ({ ...row, timestamp: NOW + i }));
    const bounded = encodeReplayRows(many, { maxBytes: 60_000 });
    assert.ok(new TextEncoder().encode(JSON.stringify(bounded)).byteLength <= 60_000);
    const decoded = decodeReplayRows(bounded);
    assert.ok(decoded.length > 0 && decoded.length < 50);
    assert.equal(decoded.at(-1).timestamp, NOW + 49, "oldest rows are dropped first");
    assert.equal(decodeReplayRows(encodeReplayRows(many, { maxRows: 7 })).length, 7);
});

test("decode maps columns by name so a row written with another feature list still loads", () => {
    const { candidates, currentTabId } = fixture();
    const live = buildShadowPredictions(candidates, { currentTabId });
    const capture = captureReplayFeatures(candidates, live, { now: NOW });
    const row = finalizeReplayRow(capture, { outcomeIndex: 0, timestamp: NOW, cohort: RANKING_STUDY_COHORT });
    const encoded = encodeReplayRows([row]);
    // Simulate an older writer that lacked the last column and stored one extra unknown column first.
    const older = {
        ...encoded,
        features: ["mystery", ...encoded.features.slice(0, -1)],
        rows: encoded.rows.map(entry => [...entry.slice(0, -1), entry.at(-1).map(values => [42, ...values.slice(0, -1)])])
    };
    const [decoded] = decodeReplayRows(older);
    const reencoded = encodeReplayRows([decoded]);
    const [normalized] = decodeReplayRows(reencoded);
    assert.deepEqual(normalized.features, [...REPLAY_FEATURES]);
    const last = REPLAY_FEATURES.at(-1);
    const lastIndex = REPLAY_FEATURES.indexOf(last);
    for (const values of normalized.matrix) assert.equal(values[lastIndex], null);
    for (const feature of REPLAY_FEATURES.slice(0, -1)) {
        const index = REPLAY_FEATURES.indexOf(feature);
        normalized.matrix.forEach((values, position) => assert.equal(values[index], row.matrix[position][index], feature));
    }
    assert.ok(decodeReplayRows({ format: "something-else", features: [], rows: [] }).length === 0);
});

test("replayed records feed the study summarizer like live ones", () => {
    const { candidates, currentTabId } = fixture();
    const live = buildShadowPredictions(candidates, { currentTabId });
    const capture = captureReplayFeatures(candidates, live, { now: NOW });
    const records = live.eligibleTabIds.map((tabId, outcomeIndex) => replayOutcome(
        finalizeReplayRow(capture, { outcomeIndex, timestamp: NOW + outcomeIndex, cohort: RANKING_STUDY_COHORT })
    ));
    const summary = summarizeRankingDiagnostics(records);
    assert.equal(summary.study.outcomes, records.length);
    assert.equal(summary.study.eligibleOutcomes, records.length);
    const mru = summary.models.find(model => model.modelVersion === SHADOW_MODEL_VERSIONS.mru);
    assert.ok(mru && mru.observations === records.length);
    assert.ok(mru.hit1 > 0 && mru.hit1 < 1, "every candidate was the outcome once, so MRU is neither perfect nor useless");
});
