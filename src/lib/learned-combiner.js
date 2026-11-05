// Learned next-tab combiner: a conditional logit over row-relative candidate
// features. The fitter lives in scripts/replay-models/learned-combiner.mjs and
// is dev-only; this module holds what the live shadow study needs to score a
// snapshot with frozen weights (src/lib/learned-combiner-weights.js).
//
// Every feature is a function of the open-tab snapshot alone. Ages are taken
// against the newest access or first-seen time among the eligible tabs, not
// against the wall clock, so a replay row (which stores ages, not times)
// reconstructs the same features the live run saw, and the replay fidelity
// check can hold this model to the same zero-mismatch bar as the others.
//
// Privacy: features are numbers derived from timestamps, window/strip
// membership, same-domain flags and the behavioural scores already computed
// for the other models. No URL, title or domain string enters a feature.

const MINUTE_MS = 60_000;

// historyScore duplicates pageHistoryScore and bayesianScore duplicates
// domainBayesianScore on every candidate, so only the distinct ones are fitted.
export const BEHAVIOUR_SCORES = Object.freeze([
    "frecencyScore",
    "pageHistoryScore",
    "domainHistoryScore",
    "pageContextScore",
    "domainContextScore",
    "pageBayesianScore",
    "domainBayesianScore",
    "hierarchicalBayesianScore"
]);

const RECENCY = Object.freeze(["logAccessAgeMin", "logMruRank", "isMru1", "isMru2"]);
const STRUCTURE = Object.freeze([
    "sameWindow", "sameDomain", "stripAdjacent", "stripRightNeighbor", "logStripDistance",
    "pinned", "audible", "logFirstSeenAgeMin", "logTimeSpentMin"
]);
const BEHAVIOUR = Object.freeze([
    ...BEHAVIOUR_SCORES,
    "pageScoresMissing", "domainScoresMissing", "contextMissing"
]);

// Nested: each set adds one family to the previous one, so the lift between
// neighbours is that family's contribution with the earlier ones controlled.
export const COMBINER_FEATURE_SETS = Object.freeze({
    recency: RECENCY,
    structure: Object.freeze([...RECENCY, ...STRUCTURE]),
    full: Object.freeze([...RECENCY, ...STRUCTURE, ...BEHAVIOUR]),
    behaviourOnly: Object.freeze([...STRUCTURE, ...BEHAVIOUR])
});

const positiveTime = value => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
};
const ageMinutes = (reference, time) => Math.max(0, (reference - time) / MINUTE_MS);

/**
 * Row-relative features for each eligible candidate, in input order:
 * [{ candidate, features }]. Every value is finite; a missing score becomes 0
 * with its family's missing flag set, so the fitted flag weight absorbs the
 * imputation.
 */
export function combinerFeatures(eligible, current = null) {
    const list = Array.isArray(eligible) ? eligible : [];
    let reference = 0;
    for (const candidate of list) {
        reference = Math.max(reference, positiveTime(candidate.lastAccessed) ?? 0, positiveTime(candidate.firstSeen) ?? 0);
    }

    // MRU rank with the tie-break rankBy uses: recency, then tab id.
    const mruOrder = [...list].sort((left, right) =>
        (Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))
        || (Number(left.tabId) - Number(right.tabId)));
    const mruRank = new Map(mruOrder.map((candidate, index) => [candidate.tabId, index + 1]));
    let oldestAgeMin = 0;
    for (const candidate of list) {
        const accessed = positiveTime(candidate.lastAccessed);
        if (accessed !== null) oldestAgeMin = Math.max(oldestAgeMin, ageMinutes(reference, accessed));
    }
    const currentIndex = Number(current?.index);

    return list.map(candidate => {
        const accessed = positiveTime(candidate.lastAccessed);
        const firstSeen = positiveTime(candidate.firstSeen);
        // A never-accessed tab counts as the row's oldest, not as age zero.
        const accessAgeMin = accessed === null ? oldestAgeMin : ageMinutes(reference, accessed);
        const firstSeenAgeMin = firstSeen === null ? accessAgeMin : ageMinutes(reference, firstSeen);
        const sameWindow = current !== null && candidate.windowId === current.windowId;
        const index = Number(candidate.index);
        const offset = sameWindow && candidate.index !== null && candidate.index !== undefined
            && Number.isFinite(index) && current.index !== null && current.index !== undefined && Number.isFinite(currentIndex)
            ? index - currentIndex : null;
        const rank = mruRank.get(candidate.tabId);

        const features = {
            logAccessAgeMin: Math.log1p(accessAgeMin),
            logMruRank: Math.log(rank),
            isMru1: rank === 1 ? 1 : 0,
            isMru2: rank === 2 ? 1 : 0,
            sameWindow: sameWindow ? 1 : 0,
            sameDomain: current?.domain && candidate.domain === current.domain ? 1 : 0,
            stripAdjacent: offset !== null && Math.abs(offset) === 1 ? 1 : 0,
            stripRightNeighbor: offset === 1 ? 1 : 0,
            logStripDistance: offset === null ? 0 : Math.log1p(Math.abs(offset)),
            pinned: candidate.pinned ? 1 : 0,
            audible: candidate.audible ? 1 : 0,
            logFirstSeenAgeMin: Math.log1p(firstSeenAgeMin),
            logTimeSpentMin: Math.log1p(Math.max(0, Number(candidate.totalTimeSpent) || 0) / MINUTE_MS),
            pageScoresMissing: Number.isFinite(candidate.pageHistoryScore) ? 0 : 1,
            domainScoresMissing: Number.isFinite(candidate.domainHistoryScore) ? 0 : 1,
            contextMissing: Number.isFinite(candidate.domainContextScore) ? 0 : 1
        };
        for (const name of BEHAVIOUR_SCORES) {
            const value = Number(candidate[name]);
            features[name] = Number.isFinite(value) ? value : 0;
        }
        return { candidate, features };
    });
}

/** Linear score of one feature object under a fitted { names, mean, sd, weights }. */
export function scoreCombinerFeatures(model, features) {
    let score = 0;
    for (let j = 0; j < model.names.length; j += 1) {
        score += model.weights[j] * ((Number(features[model.names[j]]) || 0) - model.mean[j]) / model.sd[j];
    }
    return score;
}

/** Combiner score per eligible tab id. */
export function learnedCombinerScores(eligible, current, model) {
    const scores = new Map();
    if (!model || !Array.isArray(model.names)) return scores;
    for (const { candidate, features } of combinerFeatures(eligible, current)) {
        scores.set(candidate.tabId, scoreCombinerFeatures(model, features));
    }
    return scores;
}

/**
 * Replace a rankBy prediction's relative-softmax confidence with the fitted
 * softmax over the same scores. The order is untouched; only the reported
 * probabilities change, which is what makes the calibration columns describe
 * the model rather than a fixed spread.
 */
export function withFittedProbabilities(prediction, scores) {
    if (!prediction || !Array.isArray(prediction.predictedTabIds) || prediction.predictedTabIds.length === 0) return prediction;
    const values = prediction.predictedTabIds.map(tabId => scores.get(tabId));
    const top = Math.max(...values);
    const weights = values.map(value => Math.exp(value - top));
    const total = weights.reduce((sum, value) => sum + value, 0);
    return { ...prediction, confidenceMethod: "conditional-logit-v1", probabilities: weights.map(value => value / total) };
}
