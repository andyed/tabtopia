import test from "node:test";
import assert from "node:assert/strict";

import { buildShadowPredictions, SHADOW_MODEL_VERSIONS } from "../../src/lib/shadow-ranking.js";
import { COMBINER_FEATURE_SETS } from "../../src/lib/learned-combiner.js";
import { LEARNED_COMBINER_FULL_V1 } from "../../src/lib/learned-combiner-weights.js";
import {
    FEATURE_SETS,
    combinerModels,
    featurize,
    fitConditionalLogit,
    heldOutScore
} from "../../scripts/replay-models/learned-combiner.mjs";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

// Reconstructed-replay-shaped candidates: the current tab (id 0) plus five.
function candidates() {
    const base = (tabId, minutesAgo, extra = {}) => ({
        tabId, windowId: 0, index: tabId + 2, domain: "d1",
        lastAccessed: NOW - minutesAgo * MINUTE, totalTimeSpent: 5 * MINUTE,
        firstSeen: NOW - (minutesAgo + 30) * MINUTE, pinned: false, audible: false,
        frecencyScore: -5, pageHistoryScore: -3, domainHistoryScore: -1.5, pageContextScore: 0,
        domainContextScore: -3, pageBayesianScore: -5, domainBayesianScore: -5, hierarchicalBayesianScore: -8,
        ...extra
    });
    return [
        { tabId: 0, windowId: 0, index: 2, domain: "d0", lastAccessed: NOW, totalTimeSpent: 0, firstSeen: 0 },
        base(1, 3, { index: 3 }),
        base(2, 1, { domain: "d0" }),
        base(3, 40, { windowId: 7, pageHistoryScore: Number.NaN, pageBayesianScore: Number.NaN }),
        base(4, 9, { lastAccessed: 0 }),
        base(5, 1, { pinned: true })
    ];
}

function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

test("featurize excludes the current tab and keeps every value finite", () => {
    const items = featurize(candidates(), { currentTabId: 0 });
    assert.deepEqual(items.map(item => item.candidate.tabId), [1, 2, 3, 4, 5]);
    const names = new Set(Object.values(FEATURE_SETS).flat());
    for (const item of items) {
        for (const name of names) assert.ok(Number.isFinite(item.features[name]), `${name} on tab ${item.candidate.tabId}`);
    }
    const byTab = Object.fromEntries(items.map(item => [item.candidate.tabId, item.features]));
    assert.equal(byTab[1].stripAdjacent, 1);
    assert.equal(byTab[1].stripRightNeighbor, 1);
    assert.equal(byTab[2].sameDomain, 1);
    assert.equal(byTab[3].sameWindow, 0);
    assert.equal(byTab[3].pageScoresMissing, 1);
    assert.equal(byTab[3].pageHistoryScore, 0);
    assert.equal(byTab[5].pinned, 1);
    // Never accessed is the oldest in the row, not age zero.
    assert.ok(byTab[4].logAccessAgeMin >= Math.max(...items.map(item => item.features.logAccessAgeMin)) - 1e-12);
});

test("featurize's MRU rank uses the live mru-v1 order, ties included", () => {
    const list = candidates();
    const live = buildShadowPredictions(list, { currentTabId: 0 }).models[SHADOW_MODEL_VERSIONS.mru].predictedTabIds;
    const items = featurize(list, { currentTabId: 0 });
    const byRank = [...items].sort((left, right) => left.features.logMruRank - right.features.logMruRank)
        .map(item => item.candidate.tabId);
    // Tabs 2 and 5 tie on recency; both orders break the tie by tab id.
    assert.deepEqual(byRank.slice(0, live.length), live);
    assert.equal(items.find(item => item.candidate.tabId === 2).features.isMru1, 1);
    assert.equal(items.find(item => item.candidate.tabId === 5).features.isMru2, 1);
});

test("fitConditionalLogit recovers the generating weights", () => {
    const random = seededRandom(7);
    const truth = [1.5, -0.8];
    const groups = [];
    for (let g = 0; g < 3000; g += 1) {
        const x = Array.from({ length: 5 }, () => [random() * 2 - 1, random() * 4]);
        const scores = x.map(row => truth[0] * row[0] + truth[1] * row[1]);
        const top = Math.max(...scores);
        const weights = scores.map(score => Math.exp(score - top));
        const total = weights.reduce((sum, value) => sum + value, 0);
        let draw = random() * total;
        let chosen = 0;
        while (chosen < weights.length - 1 && draw > weights[chosen]) { draw -= weights[chosen]; chosen += 1; }
        groups.push({ x, chosen });
    }
    const model = fitConditionalLogit(groups, ["a", "b"], { l2: 0.01 });
    // Weights are per SD of each feature; convert back to raw units.
    const raw = model.weights.map((weight, j) => weight / model.sd[j]);
    assert.ok(Math.abs(raw[0] - truth[0]) < 0.15, `a: ${raw[0]}`);
    assert.ok(Math.abs(raw[1] - truth[1]) < 0.1, `b: ${raw[1]}`);
    assert.ok(model.iterations < 30);
    const score = heldOutScore(model, groups);
    assert.ok(score.meanLogLikelihood > -Math.log(5), "beats the uniform guess");
});

test("a recency-only fit ranks like mru-v1 and its probabilities sum to one", () => {
    const list = candidates();
    const items = featurize(list, { currentTabId: 0 });
    const names = FEATURE_SETS["combiner-recency-v1"];
    const model = {
        names: [...names],
        mean: names.map(() => 0),
        sd: names.map(() => 1),
        weights: names.map(name => (name === "logMruRank" ? -1 : 0))
    };
    const predictions = combinerModels({ models: { "combiner-recency-v1": model } })(list, { currentTabId: 0 });
    const prediction = predictions["combiner-recency-v1"];
    const live = buildShadowPredictions(list, { currentTabId: 0 }).models[SHADOW_MODEL_VERSIONS.mru];
    assert.deepEqual(prediction.predictedTabIds, live.predictedTabIds);
    assert.equal(prediction.predictedTabIds.length, items.length);
    assert.equal(prediction.confidenceMethod, "conditional-logit-v1");
    const total = prediction.probabilities.reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(total - 1) < 1e-12);
    for (let i = 1; i < prediction.probabilities.length; i += 1) {
        assert.ok(prediction.probabilities[i] <= prediction.probabilities[i - 1] + 1e-15);
    }
});

test("features ignore the wall clock and the current tab's own timestamps", () => {
    // Replay rows store ages, not times, and give the reconstructed current tab
    // the capture instant as lastAccessed. Features must not move with either,
    // or the live model could not be replayed faithfully.
    const list = candidates();
    const shift = 123_456_789;
    const shifted = list.map(candidate => ({
        ...candidate,
        lastAccessed: candidate.lastAccessed ? candidate.lastAccessed + shift : 0,
        firstSeen: candidate.firstSeen ? candidate.firstSeen + shift : 0
    }));
    shifted[0].lastAccessed = NOW + 10 * shift; // current tab's clock is arbitrary
    const before = featurize(list, { currentTabId: 0 }).map(item => item.features);
    const after = featurize(shifted, { currentTabId: 0 }).map(item => item.features);
    assert.deepEqual(after, before);
});

test("the frozen weights match the full feature set and are finite", () => {
    const model = LEARNED_COMBINER_FULL_V1;
    assert.deepEqual(model.names, [...COMBINER_FEATURE_SETS.full]);
    assert.deepEqual(model.names, [...FEATURE_SETS[model.source]]);
    for (const key of ["mean", "sd", "weights"]) {
        assert.equal(model[key].length, model.names.length, key);
        for (const value of model[key]) assert.ok(Number.isFinite(value), `${key} has ${value}`);
    }
    for (const value of model.sd) assert.ok(value > 0);
    assert.ok(model.trainingRows >= 100);
});

test("the live shadow study runs the learned combiner with fitted probabilities", () => {
    const list = candidates();
    const prediction = buildShadowPredictions(list, { currentTabId: 0 }).models[SHADOW_MODEL_VERSIONS.learnedCombinerFull];
    assert.equal(SHADOW_MODEL_VERSIONS.learnedCombinerFull, "learned-combiner-full-v1");
    assert.equal(prediction.confidenceMethod, "conditional-logit-v1");
    assert.deepEqual([...prediction.predictedTabIds].sort(), [1, 2, 3, 4, 5]);
    const total = prediction.probabilities.reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(total - 1) < 1e-12);
    // The replay module, given the same frozen weights, ranks identically.
    const replayed = combinerModels({ models: { live: LEARNED_COMBINER_FULL_V1 } })(list, { currentTabId: 0 }).live;
    assert.deepEqual(replayed.predictedTabIds, prediction.predictedTabIds);
    assert.deepEqual(replayed.probabilities, prediction.probabilities);
});
