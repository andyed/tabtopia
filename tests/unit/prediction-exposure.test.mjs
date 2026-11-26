import test from "node:test";
import assert from "node:assert/strict";

import {
    EXPOSED_ACTIVATION_WINDOW_MS,
    LIKELY_NEXT_THRESHOLD,
    PREDICTION_EXPOSURE_SETTING_KEY,
    PREDICTION_EXPOSURE_STORE_KEY,
    PREDICTION_MODEL_VERSION,
    PredictionExposureStore,
    assignArm,
    orderByTabIds,
    predictLikelyTabs
} from "../../src/lib/prediction-exposure.js";
import { SHADOW_MODEL_VERSIONS, buildShadowPredictions } from "../../src/lib/shadow-ranking.js";
import { RankingDiagnostics, summarizeRankingDiagnostics } from "../../src/lib/ranking-diagnostics.js";

class MemoryStorage {
    constructor(values = {}) { this.values = structuredClone(values); }
    async get(keys) {
        return Object.fromEntries(keys.filter(key => key in this.values)
            .map(key => [key, structuredClone(this.values[key])]));
    }
    async set(values) {
        for (const [key, value] of Object.entries(structuredClone(values))) {
            if (value === undefined) delete this.values[key];
            else this.values[key] = value;
        }
    }
    async remove(key) { delete this.values[key]; }
}

function candidate(tabId, overrides = {}) {
    return {
        tabId, windowId: 1, index: tabId - 1, domain: `site${tabId}.example`,
        title: `Private title ${tabId}`, url: `https://private.example/${tabId}`,
        lastAccessed: 1_000_000 + tabId * 1000, firstSeen: 900_000, totalTimeSpent: tabId * 5000,
        frecencyScore: tabId, pageHistoryScore: -tabId, domainHistoryScore: -tabId,
        pageContextScore: 0, domainContextScore: 0, pageContextAvailable: true, domainContextAvailable: true,
        pageBayesianScore: -tabId, domainBayesianScore: -tabId, hierarchicalBayesianScore: -tabId,
        ...overrides
    };
}

test("the shown order is exactly the shadow study's learned-combiner order", () => {
    const candidates = [1, 2, 3, 4, 5, 6].map(id => candidate(id, id === 2 ? { windowId: 2 } : {}));
    const shadow = buildShadowPredictions(candidates, { currentTabId: 3 })
        .models[SHADOW_MODEL_VERSIONS.learnedCombinerFull];
    const shown = predictLikelyTabs(candidates, { currentTabId: 3 });

    assert.equal(shown.modelVersion, PREDICTION_MODEL_VERSION);
    assert.deepEqual(shown.tabIds, shadow.predictedTabIds);
    assert.deepEqual(shown.probabilities, shadow.probabilities);
    assert.equal(shown.tabIds.includes(3), false);
    assert.equal(shown.labeled, shown.topProbability >= LIKELY_NEXT_THRESHOLD);
});

test("arms split 80/20 and a broken random source falls back to treatment", () => {
    assert.deepEqual(assignArm(() => 0.1), { arm: "treatment", propensity: 0.8 });
    assert.deepEqual(assignArm(() => 0.95), { arm: "control", propensity: 1 - 0.8 });
    assert.equal(assignArm(() => Number.NaN).arm, "treatment");
});

test("orderByTabIds is a stable reorder that keeps unranked items after ranked ones", () => {
    const items = [{ tabId: 1 }, { tabId: 2 }, { tabId: 3 }, { tabId: 4 }];
    assert.deepEqual(orderByTabIds(items, [3, 1]).map(item => item.tabId), [3, 1, 2, 4]);
    assert.deepEqual(orderByTabIds(items, []).map(item => item.tabId), [1, 2, 3, 4]);
});

test("exposure defaults on only for development installs and a saved choice wins", async () => {
    const dev = await new PredictionExposureStore(new MemoryStorage()).init({ installType: "development" });
    const normal = await new PredictionExposureStore(new MemoryStorage()).init({ installType: "normal" });
    const saved = await new PredictionExposureStore(new MemoryStorage({ [PREDICTION_EXPOSURE_SETTING_KEY]: false }))
        .init({ installType: "development" });
    assert.equal(dev.isExposureEnabled(), true);
    assert.equal(normal.isExposureEnabled(), false);
    assert.equal(saved.isExposureEnabled(), false);
});

test("counts are content-free daily cells per surface and arm", async () => {
    const storage = new MemoryStorage();
    const now = Date.UTC(2026, 10, 26, 12);
    const store = await new PredictionExposureStore(storage, { now: () => now }).init({ installType: "development" });

    await store.recordImpression({ surface: "omnibox", arm: "treatment", labeled: true });
    await store.recordSelection({ surface: "omnibox", arm: "treatment", displayedRank: 1, labeled: true });
    await store.recordImpression({ surface: "omnibox", arm: "treatment", labeled: false });
    await store.recordSelection({ surface: "omnibox", arm: "treatment", displayedRank: 4, labeled: false });
    await store.recordImpression({ surface: "omnibox", arm: "control", labeled: false });
    await store.recordAbandonment({ surface: "omnibox", arm: "control" });
    assert.equal(await store.recordImpression({ surface: "sidebar", arm: "treatment" }), false);
    assert.equal(await store.recordSelection({ surface: "omnibox", arm: "treatment", displayedRank: 0 }), false);

    const summary = await store.getSummary();
    const treatment = summary.arms.find(arm => arm.arm === "treatment");
    const control = summary.arms.find(arm => arm.arm === "control");
    assert.equal(treatment.impressions, 2);
    assert.equal(treatment.labeled, 1);
    assert.equal(treatment.selections, 2);
    assert.equal(treatment.top1Selections, 1);
    assert.equal(treatment.labeledSelections, 1);
    assert.equal(treatment.reciprocalRankPerImpression, (1 + 0.25) / 2);
    assert.equal(control.abandonmentRate, 1);
    assert.equal(summary.windows[0].windowsAgo, 0);

    const serialized = JSON.stringify(storage.values[PREDICTION_EXPOSURE_STORE_KEY]);
    assert.equal(/tabId|url|title|example/.test(serialized), false);

    await store.clear();
    assert.equal(PREDICTION_EXPOSURE_STORE_KEY in storage.values, false);
});

test("an exposed activation is consumed once and expires", () => {
    let now = 1000;
    const store = new PredictionExposureStore(new MemoryStorage(), { now: () => now });
    store.markExposedActivation(7);
    assert.equal(store.consumeExposedActivation(8), false, "a different tab does not match");
    assert.equal(store.consumeExposedActivation(7), true);
    assert.equal(store.consumeExposedActivation(7), false, "consumed once");

    store.markExposedActivation(7);
    now += EXPOSED_ACTIVATION_WINDOW_MS + 1;
    assert.equal(store.consumeExposedActivation(7), false, "too late to credit");
});

test("a choice made from a shown prediction never enters the gate or the replay log", async () => {
    const diagnostics = await new RankingDiagnostics(new MemoryStorage(), new MemoryStorage())
        .init({ installType: "development" });
    await diagnostics.setPendingPrediction({
        sourceTabId: 1,
        eligibleTabIds: [2, 3],
        models: { [SHADOW_MODEL_VERSIONS.learnedCombinerFull]: { predictedTabIds: [2, 3], probabilities: [0.7, 0.3] } }
    }, 1000);
    const outcome = await diagnostics.takePendingPrediction(2, 2000, [1, 2, 3], 1500, { exposed: true });

    assert.equal(outcome.censorReason, "prediction-exposed");
    assert.equal(outcome.replay, undefined);
    const summary = summarizeRankingDiagnostics([outcome]);
    assert.equal(summary.study.eligibleOutcomes, 0);
    assert.deepEqual(summary.study.censorReasons.map(item => item.reason), ["prediction-exposed"]);
    assert.equal(summary.models.length, 0);
});
