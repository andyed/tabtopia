const MAX_CANDIDATES = 1000;
const SOFTMAX_SPREAD = 4;

export const SHADOW_MODEL_VERSIONS = Object.freeze({
    mru: "mru-v1",
    investment: "investment-v1",
    sameDomain: "same-domain-mru-v1",
    stripNeighbor: "strip-neighbor-v1",
    transitionPage: "transition-page-v1",
    transitionDomain: "transition-domain-v1",
    frecency: "frecency-v1",
    historyPage: "history-page-v1",
    historyDomain: "history-domain-v1",
    bayesPage: "bayes-page-v1",
    bayesDomain: "bayes-domain-v1",
    bayesHierarchical: "bayes-hierarchical-v1"
});

/**
 * Build every next-tab study model from one immutable open-tab snapshot.
 * The returned object is safe for short-lived chrome.storage.session use: it
 * contains tab ids, relative probabilities, and model labels, but no titles,
 * URLs, domains, or queries.
 */
export function buildShadowPredictions(candidates, { currentTabId = null } = {}) {
    const bounded = (Array.isArray(candidates) ? candidates : [])
        .filter(candidate => Number.isFinite(Number(candidate?.tabId)))
        .slice(0, MAX_CANDIDATES);
    const current = bounded.find(candidate => candidate.tabId === currentTabId) || null;
    const eligible = bounded.filter(candidate => candidate.tabId !== currentTabId);
    const models = {};

    addModel(models, SHADOW_MODEL_VERSIONS.mru, rankBy(eligible, candidate => candidate.lastAccessed));
    addModel(models, SHADOW_MODEL_VERSIONS.investment, rankBy(
        eligible,
        candidate => candidate.totalTimeSpent
    ));
    addModel(models, SHADOW_MODEL_VERSIONS.sameDomain, rankBy(
        eligible.filter(candidate => current?.domain && candidate.domain === current.domain),
        candidate => candidate.lastAccessed,
        { identityResolution: "domain" }
    ));
    addModel(models, SHADOW_MODEL_VERSIONS.stripNeighbor, rankStripNeighbors(eligible, current));
    addModel(models, SHADOW_MODEL_VERSIONS.transitionPage, rankEvidence(
        eligible,
        candidate => candidate.pageContextScore,
        candidate => candidate.pageContextAvailable,
        "page"
    ));
    addModel(models, SHADOW_MODEL_VERSIONS.transitionDomain, rankEvidence(
        eligible,
        candidate => candidate.domainContextScore,
        candidate => candidate.domainContextAvailable,
        "domain"
    ));
    addModel(models, SHADOW_MODEL_VERSIONS.frecency, rankEvidence(
        eligible,
        candidate => candidate.frecencyScore
    ));
    addModel(models, SHADOW_MODEL_VERSIONS.historyPage, rankEvidence(
        eligible,
        candidate => candidate.pageHistoryScore,
        null,
        "page"
    ));
    addModel(models, SHADOW_MODEL_VERSIONS.historyDomain, rankEvidence(
        eligible,
        candidate => candidate.domainHistoryScore,
        null,
        "domain"
    ));
    addModel(models, SHADOW_MODEL_VERSIONS.bayesPage, rankEvidence(
        eligible,
        candidate => candidate.pageBayesianScore,
        null,
        "page"
    ));
    addModel(models, SHADOW_MODEL_VERSIONS.bayesDomain, rankEvidence(
        eligible,
        candidate => candidate.domainBayesianScore,
        null,
        "domain"
    ));
    addModel(models, SHADOW_MODEL_VERSIONS.bayesHierarchical, rankEvidence(
        eligible,
        candidate => candidate.hierarchicalBayesianScore,
        null,
        "hierarchical"
    ));

    return {
        sourceTabId: Number.isFinite(Number(currentTabId)) ? Number(currentTabId) : null,
        eligibleTabIds: eligible.map(candidate => candidate.tabId),
        candidateCount: eligible.length,
        models
    };
}

function rankEvidence(candidates, score, available = null, identityResolution = "none") {
    if (available && !candidates.some(available)) return emptyPrediction(identityResolution);
    return rankBy(candidates, score, { identityResolution });
}

function rankStripNeighbors(candidates, current) {
    if (!current || !Number.isFinite(Number(current.index))) return emptyPrediction("tab-strip");
    const sameWindow = candidates.filter(candidate =>
        candidate.windowId === current.windowId && Number.isFinite(Number(candidate.index)));
    return rankBy(sameWindow, candidate => {
        const distance = Math.abs(Number(candidate.index) - Number(current.index));
        const rightSideTieBreak = Number(candidate.index) > Number(current.index) ? 0.001 : 0;
        return -distance + rightSideTieBreak;
    }, { identityResolution: "tab-strip" });
}

/**
 * Exported for replay experiments: a candidate model written against the
 * replay feature set can reuse the live ranking, tie-break, and confidence
 * rules so its metrics are comparable with the shipped models.
 */
export function rankBy(candidates, score, { identityResolution = "none" } = {}) {
    const ranked = candidates
        .map(candidate => ({ candidate, score: Number(score(candidate)) }))
        .filter(item => Number.isFinite(item.score))
        .sort((left, right) => (right.score - left.score)
            || (Number(right.candidate.lastAccessed || 0) - Number(left.candidate.lastAccessed || 0))
            || (Number(left.candidate.tabId) - Number(right.candidate.tabId)));
    if (ranked.length === 0) return emptyPrediction(identityResolution);

    const probabilities = relativeSoftmax(ranked.map(item => item.score));
    return {
        identityResolution,
        confidenceMethod: "relative-softmax-v1",
        predictedTabIds: ranked.map(item => item.candidate.tabId),
        probabilities
    };
}

function relativeSoftmax(scores) {
    const minimum = Math.min(...scores);
    const maximum = Math.max(...scores);
    if (minimum === maximum) return scores.map(() => 1 / scores.length);

    const logits = scores.map(score => SOFTMAX_SPREAD * ((score - minimum) / (maximum - minimum)));
    const largest = Math.max(...logits);
    const weights = logits.map(logit => Math.exp(logit - largest));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    return weights.map(weight => weight / total);
}

function addModel(models, version, prediction) {
    models[version] = prediction;
}

function emptyPrediction(identityResolution) {
    return {
        identityResolution,
        confidenceMethod: "relative-softmax-v1",
        predictedTabIds: [],
        probabilities: []
    };
}
