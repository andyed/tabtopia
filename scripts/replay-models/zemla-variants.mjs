// Model variants suggested by re-reading Zemla, Tossell, Kortum & Byrne (2015)
// against the V3 shadow-study numbers. See docs/research/zemla2015-review.md.
//
// Run: node scripts/replay-eval.mjs <dump-dir> --models scripts/replay-models/zemla-variants.mjs --split <ISO>
//
// Three families:
// 1. Weighted History/Context. The paper combines the two terms with equal
//    weight ("as suggested by a naive Bayes model") and names a weighting
//    parameter as the obvious next step. On V3, context alone
//    (transition-domain-v1) out-predicted the equal-weight combination
//    (bayes-domain-v1), so the weight is worth sweeping.
// 2. Rank fusion with MRU. MRU is the model to beat on open-tab switching;
//    reciprocal-rank fusion asks whether a behavioural model adds anything
//    once recency is already in the mix, without scale juggling.
// 3. Recency-first disambiguation: MRU order, with ties and near-ties (same
//    minute) broken by page history. Tests whether behaviour helps only in
//    the narrow case where recency is uninformative.
//
// All variants use rankBy so ties, abstention on non-finite scores, and
// relative-softmax confidence match the shipped models. Version strings end in
// -v0: these are hypotheses to run, not proposals.
import { rankBy } from "../../src/lib/shadow-ranking.js";

const RRF_K = 60;

export default function zemlaVariants(candidates, { currentTabId = null } = {}) {
    const eligible = candidates.filter(candidate => candidate.tabId !== currentTabId);
    const models = {};

    // --- 1. Weighted History/Context, domain and page identity -------------
    for (const weight of [0.25, 0.5, 2, 4]) {
        models[`history-context-w${weight}-domain-v0`] = rankBy(eligible,
            candidate => combine(candidate.domainHistoryScore, candidate.domainContextScore, weight),
            { identityResolution: "domain" });
        models[`history-context-w${weight}-page-v0`] = rankBy(eligible,
            candidate => combine(candidate.pageHistoryScore, candidate.pageContextScore, weight),
            { identityResolution: "page" });
    }

    // --- 2. Reciprocal-rank fusion of MRU with one behavioural model --------
    const mruRank = ranks(eligible, candidate => candidate.lastAccessed);
    const fusions = {
        "rrf-mru-bayes-page-v0": [candidate => candidate.pageBayesianScore, "page"],
        "rrf-mru-bayes-domain-v0": [candidate => candidate.domainBayesianScore, "domain"],
        "rrf-mru-context-domain-v0": [candidate => candidate.domainContextScore, "domain"],
        "rrf-mru-frecency-v0": [candidate => candidate.frecencyScore, "none"]
    };
    for (const [version, [score, identityResolution]] of Object.entries(fusions)) {
        const otherRank = ranks(eligible, score);
        models[version] = rankBy(eligible, candidate =>
            1 / (RRF_K + mruRank.get(candidate.tabId)) + 1 / (RRF_K + otherRank.get(candidate.tabId)),
        { identityResolution });
    }

    // --- 3. MRU with same-minute ties broken by page history ---------------
    models["mru-minute-then-history-v0"] = rankBy(eligible, candidate => {
        const minute = Math.floor(Number(candidate.lastAccessed || 0) / 60000);
        const history = Number.isFinite(candidate.pageHistoryScore) ? candidate.pageHistoryScore : -50;
        // History is log-activation, bounded well inside (-50, 50) in practice;
        // squeezing it into (0, 1) keeps the minute the primary key.
        return minute + (1 / (1 + Math.exp(-history / 10)));
    }, { identityResolution: "page" });

    return models;
}

// History must be present (the live model abstains without it); missing
// context is neutral evidence, as in scoreContext.
function combine(history, context, weight) {
    if (!Number.isFinite(history)) return Number.NaN;
    return history + weight * (Number.isFinite(context) ? context : 0);
}

// 1-based rank by descending score; non-finite scores rank last, tied.
function ranks(eligible, score) {
    const scored = eligible.map(candidate => ({ tabId: candidate.tabId, value: Number(score(candidate)) }));
    const finite = scored.filter(item => Number.isFinite(item.value))
        .sort((left, right) => right.value - left.value || left.tabId - right.tabId);
    const result = new Map(finite.map((item, index) => [item.tabId, index + 1]));
    for (const item of scored) if (!result.has(item.tabId)) result.set(item.tabId, finite.length + 1);
    return result;
}
