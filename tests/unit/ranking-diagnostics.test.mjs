import test from "node:test";
import { decodeRankingDetails, encodeRankingDetails } from "../../src/lib/ranking-detail-codec.js";
import assert from "node:assert/strict";

import {
    DIAGNOSTICS_BUFFER_KEY,
    DIAGNOSTICS_PENDING_KEY,
    DIAGNOSTICS_ROLLUP_KEY,
    RANKING_STUDY_COHORT,
    DIAGNOSTICS_SETTING_KEY,
    RankingDiagnostics,
    summarizeRankingDiagnostics
} from "../../src/lib/ranking-diagnostics.js";

class MemoryStorage {
    constructor(values = {}) {
        this.values = structuredClone(values);
    }

    async get(keys) {
        return Object.fromEntries(
            keys.filter(key => key in this.values).map(key => [key, structuredClone(this.values[key])])
        );
    }

    async set(values) {
        for (const [key, value] of Object.entries(structuredClone(values))) {
            if (value === undefined) delete this.values[key];
            else this.values[key] = value;
        }
    }

    async remove(key) {
        delete this.values[key];
    }
}

test("compact details roundtrip losslessly, migrate old arrays and obey count and byte bounds", () => {
    const records = Array.from({ length: 6000 }, (_, i) => studyOutcome({
        timestamp: 1_000_000 + i, primaryHit: i % 2 === 0, mruHit: true, frecencyHit: false
    }));
    const encoded = encodeRankingDetails(records);
    assert.equal(decodeRankingDetails(encoded).length, 5000);
    assert.deepEqual(decodeRankingDetails(encoded).at(-1), records.at(-1));
    assert.deepEqual(decodeRankingDetails(records), records);
    const bounded = encodeRankingDetails(records, { maxBytes: 10000 });
    assert.ok(new TextEncoder().encode(JSON.stringify(bounded)).length <= 10000);
    assert.deepEqual(decodeRankingDetails(bounded).at(-1), records.at(-1));
});

test("normal installs default off and perform no diagnostic writes", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const diagnostics = await new RankingDiagnostics(local, session, { flushDelayMs: 1 }).init({
        installType: "normal"
    });

    assert.equal(diagnostics.isEnabled(), false);
    assert.equal(local.values[DIAGNOSTICS_SETTING_KEY], false);
    assert.equal(diagnostics.record({ event: "omnibox_selection", queryLength: 3 }), false);
    await diagnostics.flush();
    assert.equal(local.values[DIAGNOSTICS_BUFFER_KEY], undefined);
});

test("a flush migrates existing detail arrays without inventing historical aggregate observations", async () => {
    const old = studyOutcome({ timestamp: 1000, primaryHit: true });
    const local = new MemoryStorage({ [DIAGNOSTICS_BUFFER_KEY]: [old] });
    const diagnostics = await new RankingDiagnostics(local, null, { now: () => 2000, flushDelayMs: 60000 })
        .init({ installType: "development" });
    diagnostics.record(studyOutcome({ timestamp: 2000, primaryHit: false }));
    await diagnostics.flush();
    assert.equal(Array.isArray(local.values[DIAGNOSTICS_BUFFER_KEY]), false);
    assert.deepEqual(decodeRankingDetails(local.values[DIAGNOSTICS_BUFFER_KEY])[0], old);
    assert.equal((await diagnostics.getRecords()).length, 2);
    assert.equal((await diagnostics.getSummary()).study.outcomes, 1);
});

test("development installs default on but persisted choice wins", async () => {
    const local = new MemoryStorage();
    const diagnostics = await new RankingDiagnostics(local).init({ installType: "development" });
    assert.equal(diagnostics.isEnabled(), true);

    await diagnostics.setEnabled(false);
    const restarted = await new RankingDiagnostics(local).init({ installType: "development" });
    assert.equal(restarted.isEnabled(), false);
});

test("disabling diagnostics clears buffered and pending data", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const diagnostics = await new RankingDiagnostics(local, session, { flushDelayMs: 60_000 }).init({
        installType: "development"
    });

    diagnostics.record({
        event: "omnibox_selection",
        queryLength: 4,
        queryTokenCount: 1,
        candidateCount: 5,
        selectedRank: 2,
        latencyMs: 4.5,
        rawQuery: "must never persist"
    });
    await diagnostics.setPendingPrediction({
        candidateCount: 3,
        models: { "bayes-v1": [3, 4, 5] }
    });
    await diagnostics.setEnabled(false);

    assert.equal(local.values[DIAGNOSTICS_BUFFER_KEY], undefined);
    assert.deepEqual(session.values, {});
});

test("records are bounded, sanitized, and summarize model lift", async () => {
    const local = new MemoryStorage();
    const diagnostics = await new RankingDiagnostics(local, null, {
        maxRecords: 3,
        flushDelayMs: 60_000
    }).init({ installType: "development" });

    for (let index = 0; index < 4; index += 1) {
        diagnostics.record({
            event: "next_tab_outcome",
        cohort: RANKING_STUDY_COHORT,
            modelVersion: index % 2 ? "frecency-v1" : "bayes-v1",
            candidateCount: 4,
            predictedTabIds: index % 2 ? [2, 1, 3] : [1, 2, 3],
            actualTabId: 1,
            qualifiedDwellMs: 2000,
            rawUrl: "https://private.example/"
        });
    }
    await diagnostics.flush();

    const serialized = JSON.stringify(local.values[DIAGNOSTICS_BUFFER_KEY]);
    assert.equal(decodeRankingDetails(local.values[DIAGNOSTICS_BUFFER_KEY]).length, 3);
    assert.equal(serialized.includes("private.example"), false);
    assert.equal(serialized.includes("predictedTabIds"), false);
    assert.equal(serialized.includes("actualTabId"), false);

    const summary = summarizeRankingDiagnostics(decodeRankingDetails(local.values[DIAGNOSTICS_BUFFER_KEY]));
    const bayes = summary.models.find(model => model.modelVersion === "bayes-v1");
    const frecency = summary.models.find(model => model.modelVersion === "frecency-v1");
    assert.equal(bayes.hit1, 1);
    assert.equal(frecency.hit1, 0);
    assert.equal(frecency.mrr, 0.5);
});

test("pending ids are consumed into one content-free outcome with censoring context", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const diagnostics = await new RankingDiagnostics(local, session, {
        flushDelayMs: 60_000
    }).init({ installType: "development" });
    const now = 10_000;

    await diagnostics.setPendingPrediction({
        sourceTabId: 1,
        eligibleTabIds: [2, 3],
        latencyMs: 4.5,
        models: {
            "mru-v1": {
                predictedTabIds: [2, 3],
                probabilities: [0.75, 0.25],
                identityResolution: "none",
                confidenceMethod: "relative-softmax-v1"
            }
        }
    }, now);
    const outcome = await diagnostics.takePendingPrediction(3, 2000, [1, 2, 3], now + 5000);

    assert.equal(session.values[DIAGNOSTICS_PENDING_KEY], undefined);
    assert.equal(outcome.censorReason, "");
    assert.equal(outcome.destinationClass, "existing-tab");
    assert.equal(outcome.openTabBand, "2-5");
    assert.equal(outcome.models[0].actualRank, 2);
    assert.equal(outcome.models[0].actualProbability, 0.25);
    assert.equal(JSON.stringify(outcome).includes("TabId"), false);

    diagnostics.record({ ...outcome, rawUrl: "https://private.example/path" });
    await diagnostics.flush();
    const serialized = JSON.stringify(local.values[DIAGNOSTICS_BUFFER_KEY]);
    assert.equal(serialized.includes("private.example"), false);
    assert.equal(serialized.includes("predictedTabIds"), false);
});

test("candidate changes and long inactivity are reported as censored outcomes", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const diagnostics = await new RankingDiagnostics(local, session, {
        maximumObservationAgeMs: 1000
    }).init({ installType: "development" });

    await diagnostics.setPendingPrediction({
        sourceTabId: 1,
        eligibleTabIds: [2, 3],
        models: { "mru-v1": [2, 3] }
    }, 1000);
    const changed = await diagnostics.takePendingPrediction(2, 2000, [1, 2, 4], 1500);
    assert.equal(changed.censorReason, "candidate-set-changed");

    await diagnostics.setPendingPrediction({
        sourceTabId: 1,
        eligibleTabIds: [2, 3],
        models: { "mru-v1": [2, 3] }
    }, 2000);
    const inactive = await diagnostics.takePendingPrediction(2, 2000, [1, 2, 3], 4000);
    assert.equal(inactive.censorReason, "inactivity");
});

test("out-of-set destinations remain visible as a separate censored segment", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const diagnostics = await new RankingDiagnostics(local, session).init({ installType: "development" });

    await diagnostics.setPendingPrediction({
        sourceTabId: 1,
        eligibleTabIds: [2, 3],
        models: { "mru-v1": [2, 3] }
    }, 1000);
    const outcome = await diagnostics.takePendingPrediction(4, 2000, [1, 2, 3, 4], 1500);
    const summary = summarizeRankingDiagnostics([outcome]);

    assert.equal(outcome.censorReason, "outcome-not-candidate");
    assert.equal(outcome.destinationClass, "out-of-set");
    assert.deepEqual(summary.segments.destinationClasses, [{
        band: "out-of-set",
        outcomes: 1,
        eligibleOutcomes: 0,
        censoringRate: 1,
        models: []
    }]);
});

test("aggregate report excludes outcomes from earlier unversioned cohorts", () => {
    const current = studyOutcome({
        timestamp: 10_000,
        primaryHit: true,
        mruHit: false,
        frecencyHit: false
    });
    current.cohort = RANKING_STUDY_COHORT;
    const legacy = studyOutcome({
        timestamp: 9_000,
        primaryHit: false,
        mruHit: true,
        frecencyHit: true
    });

    delete legacy.cohort;
    const summary = summarizeRankingDiagnostics([legacy, current]);

    assert.equal(summary.study.outcomes, 1);
    assert.equal(summary.study.cohort, RANKING_STUDY_COHORT);
    assert.equal(summary.models.find(model => model.modelVersion === "bayes-domain-v1").hit1, 1);
});

test("aggregate report gates exposure on two winning windows, coverage, calibration, and latency", () => {
    const week = 7 * 24 * 60 * 60 * 1000;
    const records = [];
    for (let windowIndex = 0; windowIndex < 2; windowIndex += 1) {
        for (let index = 0; index < 50; index += 1) {
            records.push(studyOutcome({
                timestamp: (100 + windowIndex) * week + index,
                primaryHit: index < 40,
                mruHit: index < 25,
                frecencyHit: index < 20,
                openTabBand: index % 2 ? "6-10" : "11-25",
                sessionAgeBand: index % 2 ? "15-60m" : "1-4h"
            }));
        }
    }
    records.push({
        ...studyOutcome({ timestamp: 102 * week, primaryHit: true, mruHit: true, frecencyHit: true }),
        censorReason: "candidate-set-changed"
    });

    const summary = summarizeRankingDiagnostics(records);
    const primary = summary.models.find(model => model.modelVersion === "bayes-domain-v1");

    assert.equal(summary.study.outcomes, 101);
    assert.equal(summary.study.eligibleOutcomes, 100);
    assert.equal(summary.study.censoredOutcomes, 1);
    assert.deepEqual(summary.study.censorReasons, [{
        reason: "candidate-set-changed",
        count: 1,
        rate: 1 / 101
    }]);
    assert.equal(summary.study.evaluationWindows, 2);
    assert.equal(primary.hit1, 0.8);
    assert.equal(primary.mrr, 0.9);
    assert.ok(primary.lift["mru-v1"].hit1 > 0);
    assert.ok(primary.lift["frecency-v1"].mrr > 0);
    assert.ok(primary.calibrationError < 1e-12);
    assert.equal(summary.segments.openTabBands.length, 2);
    assert.equal(summary.segments.sessionAgeBands.length, 2);
    assert.equal(summary.exposureGate.winningWindows, 2);
    assert.equal(summary.exposureGate.ready, true);
    assert.equal(summary.exposureGate.automaticUiChange, false);
});

function studyOutcome({
    timestamp,
    primaryHit,
    mruHit,
    frecencyHit,
    openTabBand = "6-10",
    sessionAgeBand = "15-60m"
}) {
    return {
        event: "next_tab_outcome",
        cohort: RANKING_STUDY_COHORT,
        timestamp,
        candidateCount: 8,
        qualifiedDwellMs: 2000,
        observationAgeMs: 5000,
        predictionLatencyMs: 5,
        openTabBand,
        sessionAgeBand,
        censorReason: "",
        models: [
            outcomeModel("bayes-domain-v1", primaryHit, 0.8),
            outcomeModel("mru-v1", mruHit, 0.5),
            outcomeModel("frecency-v1", frecencyHit, 0.4)
        ]
    };
}

function outcomeModel(modelVersion, hit, confidence) {
    return {
        modelVersion,
        identityResolution: modelVersion.includes("domain") ? "domain" : "none",
        confidenceMethod: "relative-softmax-v1",
        predictedCount: 8,
        actualRank: hit ? 1 : 2,
        actualProbability: hit ? confidence : 1 - confidence,
        top1Probability: confidence
    };
}

test("same-tab navigation and refocus do not become next-tab misses", async () => {
    const diagnostics = await new RankingDiagnostics(new MemoryStorage(), new MemoryStorage())
        .init({ installType: "development" });
    const prediction = { sourceTabId: 1, eligibleTabIds: [2, 3], models: { "mru-v1": [2, 3] } };
    await diagnostics.setPendingPrediction(prediction, 1000);
    assert.equal(await diagnostics.takePendingPrediction(1, 2000, [1, 2, 3], 1500), null);
    await diagnostics.setPendingPrediction(prediction, 2000);
    assert.equal((await diagnostics.takePendingPrediction(2, 2000, [1, 2, 3], 2500)).models[0].actualRank, 1);
});

test("old pending predictions and old-only raw buffers cannot enter the corrected cohort", async () => {
    const session = new MemoryStorage({
        [DIAGNOSTICS_PENDING_KEY]: {
            cohort: "next-tab-matrix-v2", sourceTabId: 1, eligibleTabIds: [2],
            timestamp: 1000, models: { "mru-v1": [2] }
        }
    });
    const diagnostics = await new RankingDiagnostics(new MemoryStorage(), session)
        .init({ installType: "development" });
    assert.equal(await diagnostics.takePendingPrediction(2, 2000, [1, 2], 1500), null);
    const old = { ...studyOutcome({ timestamp: 1000, primaryHit: true }), cohort: "next-tab-matrix-v2" };
    assert.equal(summarizeRankingDiagnostics([old]).study.outcomes, 0);
});

test("daily aggregates preserve full multi-week metrics after raw records roll off and the worker restarts", async () => {
    const day = 86400000;
    const now = 710 * day;
    const local = new MemoryStorage();
    const diagnostics = await new RankingDiagnostics(local, null, { maxRecords: 5, now: () => now })
        .init({ installType: "development" });
    const records = Array.from({ length: 1200 }, (_, index) => ({
        ...studyOutcome({
            timestamp: (index < 600 ? 700 : 707) * day + index,
            primaryHit: index % 5 !== 0,
            mruHit: index % 2 === 0,
            frecencyHit: index % 3 === 0,
            openTabBand: index % 2 ? "6-10" : "11-25",
            sessionAgeBand: index % 2 ? "15-60m" : "1-4h"
        }),
        censorReason: index % 17 === 0 ? "outcome-not-candidate" : ""
    }));
    for (let index = 0; index < records.length; index += 1) {
        diagnostics.record(records[index]);
        if (index % 150 === 149) await diagnostics.flush();
    }
    await diagnostics.flush();
    assert.equal(decodeRankingDetails(local.values[DIAGNOSTICS_BUFFER_KEY]).length, 5);
    const restarted = await new RankingDiagnostics(local, null, { now: () => now })
        .init({ installType: "development" });
    const summary = await restarted.getSummary();
    const expected = summarizeRankingDiagnostics(records);
    assert.equal(summary.study.outcomes, 1200);
    assert.equal(summary.study.retainedDays, 2);
    assert.equal(summary.study.evaluationWindows, 2);
    // Grouping floating-point sums by day changes their final few bits.
    const stableNumbers = value => JSON.parse(JSON.stringify(value, (_key, item) =>
        typeof item === "number" ? Number(item.toFixed(10)) : item));
    assert.deepEqual(stableNumbers(summary.models), stableNumbers(expected.models));
    assert.deepEqual(stableNumbers(summary.segments), stableNumbers(expected.segments));
    assert.deepEqual(summary.exposureGate, expected.exposureGate);
    assert.deepEqual(summary.study.censorReasons, expected.study.censorReasons);
    assert.equal(summary.study.predictionP95Ms, expected.study.predictionP95Ms);
    assert.ok(JSON.stringify(local.values[DIAGNOSTICS_ROLLUP_KEY]).length < 100000);
});

test("retention expires by time on reads, preserves 90 days, and never duplicates raw outcomes", async () => {
    const day = 86400000;
    let now = 800 * day;
    const local = new MemoryStorage();
    const diagnostics = await new RankingDiagnostics(local, null, { now: () => now })
        .init({ installType: "development" });
    for (let offset = 0; offset < 100; offset += 1) {
        diagnostics.record(studyOutcome({ timestamp: now - offset * day, primaryHit: true }));
    }
    let summary = await diagnostics.getSummary();
    assert.equal(summary.study.outcomes, 90);
    assert.equal(summary.study.retainedDays, 90);
    assert.equal((await diagnostics.getSummary()).study.outcomes, 90);
    now += 89 * day;
    summary = await diagnostics.getSummary();
    assert.equal(summary.study.outcomes, 1);
    assert.equal(summary.study.firstOutcomeAt, 800 * day);
    now += day;
    assert.equal((await diagnostics.getSummary()).study.outcomes, 0);
});

test("aggregate p95 uses a conservative bounded histogram and persists no content or tab ids", async () => {
    const now = 1_000_000;
    const local = new MemoryStorage();
    const diagnostics = await new RankingDiagnostics(local, null, { now: () => now })
        .init({ installType: "development" });
    diagnostics.record({
        ...studyOutcome({ timestamp: now, primaryHit: true }), predictionLatencyMs: 50.01,
        rawUrl: "https://private.example/path", title: "Secret title", actualTabId: 77,
        predictedTabIds: [77], query: "secret query"
    });
    const summary = await diagnostics.getSummary();
    assert.equal(summary.study.predictionP95Ms, 75);
    assert.ok(summary.exposureGate.reasons.some(reason => reason.includes("p95")));
    const serialized = JSON.stringify(local.values[DIAGNOSTICS_ROLLUP_KEY]);
    for (const forbidden of ["private.example", "Secret title", "actualTabId", "predictedTabIds", "secret query"]) {
        assert.equal(serialized.includes(forbidden), false);
    }
    await diagnostics.setEnabled(false);
    assert.equal(local.values[DIAGNOSTICS_ROLLUP_KEY], undefined);
    assert.equal(local.values[DIAGNOSTICS_BUFFER_KEY], undefined);
    assert.equal((await diagnostics.getSummary()).records, 0);
});

test("a failed storage write can retry without losing outcomes or double-counting aggregates", async () => {
    const now = 1_000_000;
    const local = new MemoryStorage();
    const diagnostics = await new RankingDiagnostics(local, null, { now: () => now, flushDelayMs: 60000 })
        .init({ installType: "development" });
    const set = local.set.bind(local);
    let fail = true;
    local.set = async values => {
        if (fail) { fail = false; throw new Error("temporary write failure"); }
        return set(values);
    };
    diagnostics.record(studyOutcome({ timestamp: now, primaryHit: true }));
    await assert.rejects(diagnostics.flush(), /temporary write failure/);
    diagnostics.record(studyOutcome({ timestamp: now + 1, primaryHit: false }));
    const summary = await diagnostics.getSummary();
    assert.equal(summary.study.outcomes, 2);
    assert.equal(summary.models.find(model => model.modelVersion === "bayes-domain-v1").hit1, 0.5);
    assert.equal(decodeRankingDetails(local.values[DIAGNOSTICS_BUFFER_KEY]).length, 2);
});
