import test from "node:test";
import assert from "node:assert/strict";

import {
    SHADOW_MODEL_VERSIONS,
    buildShadowPredictions
} from "../../src/lib/shadow-ranking.js";

function candidate(tabId, overrides = {}) {
    return {
        tabId,
        windowId: 1,
        index: tabId - 1,
        domain: "beta.example",
        title: `Private title ${tabId}`,
        url: `https://private.example/${tabId}`,
        lastAccessed: 0,
        totalTimeSpent: 0,
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

test("shadow study runs the complete deterministic baseline matrix", () => {
    const predictions = buildShadowPredictions([
        candidate(1, { domain: "alpha.example", index: 1 }),
        candidate(2, {
            domain: "alpha.example",
            index: 2,
            lastAccessed: 400,
            totalTimeSpent: 10,
            frecencyScore: 2,
            pageHistoryScore: 2,
            domainHistoryScore: 1,
            pageContextScore: 1,
            domainContextScore: 4,
            pageBayesianScore: 3,
            domainBayesianScore: 5,
            hierarchicalBayesianScore: 6
        }),
        candidate(3, {
            index: 0,
            lastAccessed: 300,
            totalTimeSpent: 100,
            frecencyScore: 6,
            pageHistoryScore: 4,
            domainHistoryScore: 3,
            pageContextScore: 5,
            domainContextScore: 1,
            pageBayesianScore: 7,
            domainBayesianScore: 2,
            hierarchicalBayesianScore: 8
        }),
        candidate(4, {
            windowId: 2,
            index: 0,
            lastAccessed: 200,
            totalTimeSpent: 20,
            frecencyScore: 1,
            pageHistoryScore: 1,
            domainHistoryScore: 6,
            pageContextScore: 2,
            domainContextScore: 2,
            pageBayesianScore: 2,
            domainBayesianScore: 9,
            hierarchicalBayesianScore: 10
        })
    ], { currentTabId: 1 });

    assert.equal(Object.keys(predictions.models).length, 20);
    assert.equal(Object.keys(predictions.models).length, Object.keys(SHADOW_MODEL_VERSIONS).length);
    assert.equal(predictions.models[SHADOW_MODEL_VERSIONS.mru].predictedTabIds[0], 2);
    assert.equal(predictions.models[SHADOW_MODEL_VERSIONS.investment].predictedTabIds[0], 3);
    assert.deepEqual(predictions.models[SHADOW_MODEL_VERSIONS.sameDomain].predictedTabIds, [2]);
    assert.equal(predictions.models[SHADOW_MODEL_VERSIONS.stripNeighbor].predictedTabIds[0], 2);
    assert.equal(predictions.models[SHADOW_MODEL_VERSIONS.transitionPage].predictedTabIds[0], 3);
    assert.equal(predictions.models[SHADOW_MODEL_VERSIONS.transitionDomain].predictedTabIds[0], 2);
    assert.equal(predictions.models[SHADOW_MODEL_VERSIONS.frecency].predictedTabIds[0], 3);
    assert.equal(predictions.models[SHADOW_MODEL_VERSIONS.historyPage].predictedTabIds[0], 3);
    assert.equal(predictions.models[SHADOW_MODEL_VERSIONS.historyDomain].predictedTabIds[0], 4);
    assert.equal(predictions.models[SHADOW_MODEL_VERSIONS.bayesPage].predictedTabIds[0], 3);
    assert.equal(predictions.models[SHADOW_MODEL_VERSIONS.bayesDomain].predictedTabIds[0], 4);
    assert.equal(predictions.models[SHADOW_MODEL_VERSIONS.bayesHierarchical].predictedTabIds[0], 4);
});

test("shadow predictions contain ids and probabilities but no browsing content", () => {
    const predictions = buildShadowPredictions([
        candidate(1, { domain: "private.example" }),
        candidate(2, { lastAccessed: 20, frecencyScore: 2 }),
        candidate(3, { lastAccessed: 10, frecencyScore: 1 })
    ], { currentTabId: 1 });
    const serialized = JSON.stringify(predictions);

    assert.equal(serialized.includes("Private title"), false);
    assert.equal(serialized.includes("private.example"), false);
    for (const prediction of Object.values(predictions.models)) {
        const total = prediction.probabilities.reduce((sum, value) => sum + value, 0);
        if (prediction.predictedTabIds.length > 0) assert.ok(Math.abs(total - 1) < 1e-12);
        assert.equal(prediction.probabilities.length, prediction.predictedTabIds.length);
    }
});

test("evidence-dependent models abstain instead of inventing transition or History evidence", () => {
    const predictions = buildShadowPredictions([
        candidate(1, { pageContextAvailable: false, domainContextAvailable: false }),
        candidate(2, { pageContextAvailable: false, domainContextAvailable: false })
    ], { currentTabId: 1 });

    for (const version of [
        SHADOW_MODEL_VERSIONS.transitionPage,
        SHADOW_MODEL_VERSIONS.transitionDomain,
        SHADOW_MODEL_VERSIONS.historyPage,
        SHADOW_MODEL_VERSIONS.historyDomain,
        SHADOW_MODEL_VERSIONS.bayesPage,
        SHADOW_MODEL_VERSIONS.bayesDomain,
        SHADOW_MODEL_VERSIONS.bayesHierarchical
    ]) {
        assert.deepEqual(predictions.models[version].predictedTabIds, []);
    }
});
