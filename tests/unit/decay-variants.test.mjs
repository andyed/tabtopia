import test from "node:test";
import assert from "node:assert/strict";

import { RevisitStore } from "../../src/lib/revisit-store.js";
import { buildRecallCandidate } from "../../src/lib/tab-recall.js";
import { buildShadowPredictions, SHADOW_MODEL_VERSIONS } from "../../src/lib/shadow-ranking.js";
import {
    REPLAY_CURRENT_TAB_ID,
    captureReplayFeatures,
    decodeReplayRows,
    encodeReplayRows,
    finalizeReplayRow,
    reconstructCandidates
} from "../../src/lib/ranking-replay.js";
import { RANKING_STUDY_COHORT } from "../../src/lib/ranking-diagnostics.js";
import decayVariants, { DECAYS, historyFromAges, ordinalHistory, ordinalRanks } from "../../scripts/replay-models/decay-variants.mjs";

class MemoryStorage {
    constructor() { this.values = {}; }
    async get(keys) { return Object.fromEntries(keys.filter(key => key in this.values).map(key => [key, this.values[key]])); }
    async set(values) { Object.assign(this.values, structuredClone(values)); }
}

const NOW = 1_800_000_000_000;
const TABS = [
    { id: 11, url: "https://alpha.example/one", title: "one", windowId: 1, index: 0 },
    { id: 12, url: "https://alpha.example/two", title: "two", windowId: 1, index: 1 },
    { id: 13, url: "https://beta.example/three", title: "three", windowId: 1, index: 2 },
    { id: 14, url: "https://gamma.example/never", title: "never", windowId: 1, index: 3 },
    { id: 15, url: "https://delta.example/busy", title: "busy", windowId: 1, index: 4 }
];
const CURRENT = { id: 10, url: "https://home.example/", title: "home", windowId: 1, index: 5, active: true };

// Mirrors the behaviour object src/background.js hands buildRecallCandidate.
function behaviourOf(score) {
    return {
        lastAccessed: NOW - 1000,
        bayesianScore: score.score,
        frecencyScore: 0.5,
        historyScore: score.history,
        pageBayesianScore: score.pageScore,
        domainBayesianScore: score.domainScore,
        hierarchicalBayesianScore: score.hierarchicalScore,
        pageHistoryScore: score.pageHistory,
        domainHistoryScore: score.domainHistory,
        pageContextScore: score.pageContext,
        domainContextScore: score.domainContext,
        pageContextAvailable: score.pageContextAvailable,
        domainContextAvailable: score.domainContextAvailable,
        pageAccessAges: score.pageAccessAges,
        domainAccessAges: score.domainAccessAges,
        source: score.source
    };
}

async function replayedFixture() {
    const store = await new RevisitStore(new MemoryStorage()).init();
    // Irregular, non-round ages so a coincidental match is implausible. One
    // tab seen once half an hour ago against one seen six times over the
    // afternoon: shallow decay prefers the six, steep decay the one, so the
    // sweep has something to disagree about.
    const pageOne = [1_800_017];
    const pageTwo = [7_200_005, 10_800_000, 14_400_000, 18_000_000, 21_600_000, 25_200_000];
    const pageThree = [86_400_000 * 20 + 999];
    // Thirteen accesses: more than the cap, so the recompute is an approximation there.
    const busy = Array.from({ length: 13 }, (_, visit) => (visit + 1) * 7_200_000 + visit);
    const accesses = [
        ...pageOne.map(age => [TABS[0].url, "", age]),
        ...pageTwo.map(age => [TABS[1].url, TABS[0].url, age]),
        ...pageThree.map(age => [TABS[2].url, "", age]),
        ...busy.map(age => [TABS[4].url, "", age])
    ];
    // Recorded in clock order: the store prunes anything later than the
    // access it is recording, as a clock only moves forward.
    accesses.sort((left, right) => right[2] - left[2]);
    for (const [url, previous, age] of accesses) await store.recordAccess(url, previous, NOW - age);

    const scores = await store.scoreTabs([CURRENT, ...TABS], CURRENT.url, NOW);
    const byTab = new Map(scores.map(score => [score.tabId, score]));
    const candidates = [CURRENT, ...TABS].map(tab => buildRecallCandidate(tab, behaviourOf(byTab.get(tab.id))));
    const live = buildShadowPredictions(candidates, { currentTabId: CURRENT.id });
    const capture = captureReplayFeatures(candidates, live, { now: NOW + 45_000 });
    const row = finalizeReplayRow(capture, { outcomeIndex: 0, timestamp: NOW + 50_000, cohort: RANKING_STUDY_COHORT });
    const [decoded] = decodeReplayRows(encodeReplayRows([row]));
    const reconstructed = reconstructCandidates(decoded);
    return { store, scores, byTab, candidates, live, reconstructed, expectedAges: { pageOne, pageTwo, pageThree } };
}

test("scoreTabs exposes the newest qualified-access ages, most recent first, capped at eight", async () => {
    const { byTab, expectedAges } = await replayedFixture();
    assert.deepEqual(byTab.get(11).pageAccessAges, expectedAges.pageOne);
    assert.deepEqual(byTab.get(12).pageAccessAges, expectedAges.pageTwo);
    assert.deepEqual(byTab.get(13).pageAccessAges, expectedAges.pageThree);
    assert.deepEqual(byTab.get(14).pageAccessAges, []);
    assert.deepEqual(byTab.get(14).domainAccessAges, []);
    // alpha.example carries both of its pages' accesses at domain resolution.
    assert.deepEqual(byTab.get(11).domainAccessAges, [...expectedAges.pageOne, ...expectedAges.pageTwo].sort((a, b) => a - b));
    const busy = byTab.get(15).pageAccessAges;
    assert.equal(busy.length, 8);
    assert.deepEqual(busy, [...busy].sort((a, b) => a - b));
    assert.equal(busy[0], 7_200_000);
});

test("d = 0.5 recomputed from the replayed ages reproduces the live History scores", async () => {
    const { reconstructed, byTab, live } = await replayedFixture();
    let checked = 0;
    live.eligibleTabIds.forEach((tabId, position) => {
        const twin = reconstructed[position + 1];
        const score = byTab.get(tabId);
        if (score.pageAccessAges.length === 0) {
            assert.deepEqual(twin.pageAccessAges, []);
            assert.ok(Number.isNaN(historyFromAges(twin.pageAccessAges, 0.5)));
            return;
        }
        if (score.pageAccessAges.length < 8) {
            // The row survived capture, encode and decode; the ages it carries
            // must still produce the score the live model consumed.
            const page = historyFromAges(twin.pageAccessAges, 0.5);
            assert.ok(Math.abs(page - score.pageHistory) < 1e-6, `tab ${tabId} page ${page} vs ${score.pageHistory}`);
            assert.ok(Math.abs(page - twin.pageHistoryScore) < 1e-6, `tab ${tabId} stored page score`);
            checked += 1;
        }
        if (score.domainAccessAges.length < 8) {
            const domain = historyFromAges(twin.domainAccessAges, 0.5);
            assert.ok(Math.abs(domain - score.domainHistory) < 1e-6, `tab ${tabId} domain ${domain} vs ${score.domainHistory}`);
        }
    });
    assert.ok(checked >= 3, "fixture must exercise several identities with real histories");

    // Over the cap the ages are the newest prefix of the history, so the
    // recompute is strictly below the live score (every dropped term is
    // positive) but by less than ln(13/8), the gap thirteen equal terms would
    // leave, since t^-0.5 makes the dropped, older accesses the smallest.
    const busyPosition = live.eligibleTabIds.indexOf(15);
    const busy = reconstructed[busyPosition + 1];
    assert.equal(busy.pageAccessAges.length, 8);
    const approximate = historyFromAges(busy.pageAccessAges, 0.5);
    assert.ok(approximate < byTab.get(15).pageHistory);
    assert.ok(byTab.get(15).pageHistory - approximate < Math.log(13 / 8));
});

test("the d = 0.5 variant ranks exactly as the live history-page model when no identity exceeds the cap", async () => {
    const { reconstructed } = await replayedFixture();
    // Drop the over-cap tab so the variant and the live model see the same evidence.
    const comparable = reconstructed.filter(candidate => candidate.pageAccessAges.length < 8);
    const live = buildShadowPredictions(comparable, { currentTabId: REPLAY_CURRENT_TAB_ID });
    const variants = decayVariants(comparable, { currentTabId: REPLAY_CURRENT_TAB_ID });
    const reference = live.models[SHADOW_MODEL_VERSIONS.historyPage];
    const twin = variants["history-page-d0.5-v0"];
    assert.deepEqual(twin.predictedTabIds, reference.predictedTabIds);
    assert.ok(reference.predictedTabIds.length >= 3, "the comparison must cover several ranked tabs");
    // Stored scores carry nine significant digits; the recompute is exact, so
    // the softmax agrees to the same 1e-6 the score fidelity is held to.
    reference.probabilities.forEach((probability, index) => {
        assert.ok(Math.abs(probability - twin.probabilities[index]) < 1e-6, `probability ${index}`);
    });
    for (const decay of DECAYS) assert.ok(variants[`history-page-d${decay}-v0`], `d=${decay}`);
    assert.ok(variants["history-page-ordinal-d0.5-v0"]);
    assert.equal(Object.keys(variants).length, 5);
    // Steeper decay must change the ranking somewhere on this fixture, or the
    // sweep is a no-op and the table would hide it.
    assert.notDeepEqual(variants["history-page-d2-v0"].predictedTabIds, variants["history-page-d0.25-v0"].predictedTabIds);
});

test("ordinal time ranks pooled accesses most-recent-first with ties sharing a rank", () => {
    const pooled = [50, 10, 30, 30, 70];
    assert.deepEqual(ordinalRanks([10, 30, 70], pooled), [1, 2, 5]);
    assert.deepEqual(ordinalRanks([30], pooled), [2]);
    // Rank r is scored as r elapsed seconds, so rank 1 sits on scoreHistory's floor.
    assert.ok(Math.abs(ordinalHistory([10], pooled, 0.5) - Math.log(1)) < 1e-12);
    assert.ok(Math.abs(ordinalHistory([10, 30, 70], pooled, 0.5) - Math.log(1 + 2 ** -0.5 + 5 ** -0.5)) < 1e-12);
    assert.ok(Number.isNaN(ordinalHistory([], pooled, 0.5)));
});
