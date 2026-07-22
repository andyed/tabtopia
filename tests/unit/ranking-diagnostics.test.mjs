import test from "node:test";
import assert from "node:assert/strict";

import {
    DIAGNOSTICS_BUFFER_KEY,
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
    assert.equal(local.values[DIAGNOSTICS_BUFFER_KEY].length, 3);
    assert.equal(serialized.includes("private.example"), false);

    const summary = summarizeRankingDiagnostics(local.values[DIAGNOSTICS_BUFFER_KEY]);
    const bayes = summary.models.find(model => model.modelVersion === "bayes-v1");
    const frecency = summary.models.find(model => model.modelVersion === "frecency-v1");
    assert.equal(bayes.hit1, 1);
    assert.equal(frecency.hit1, 0);
    assert.equal(frecency.mrr, 0.5);
});
