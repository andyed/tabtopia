// Replay-only variants from re-reading Zemla, Tossell, Kortum & Byrne (2015);
// see docs/research/zemla2015-review.md.
//
// Run: node scripts/replay-eval.mjs <dump-dir> --models scripts/replay-models/zemla-variants.mjs --split <ISO>
//
// Seven of the paper-derived variants run live in shadow-ranking.js since
// 2026-10-07 (history-context w2/w4 at domain and page identity, RRF of MRU
// with bayes-page and with context-domain, and mru-minute-then-history). This
// file keeps the rest of the sweep so the replay evaluator can fill in the
// curve around the live points without adding more live models:
//   - context weights 0.25, 0.5 and 8, at both identities
//   - RRF of MRU with bayes-domain and with frecency
// Version strings end in -v0: hypotheses to run, not proposals.
import { rankBy, rankPositions } from "../../src/lib/shadow-ranking.js";

const RRF_K = 60;

export default function zemlaVariants(candidates, { currentTabId = null } = {}) {
    const eligible = candidates.filter(candidate => candidate.tabId !== currentTabId);
    const models = {};

    for (const weight of [0.25, 0.5, 8]) {
        models[`history-context-w${weight}-domain-v0`] = rankBy(eligible,
            candidate => combine(candidate.domainHistoryScore, candidate.domainContextScore, weight),
            { identityResolution: "domain" });
        models[`history-context-w${weight}-page-v0`] = rankBy(eligible,
            candidate => combine(candidate.pageHistoryScore, candidate.pageContextScore, weight),
            { identityResolution: "page" });
    }

    const mruRank = rankPositions(eligible, candidate => candidate.lastAccessed);
    const fusions = {
        "rrf-mru-bayes-domain-v0": [candidate => candidate.domainBayesianScore, "domain"],
        "rrf-mru-frecency-v0": [candidate => candidate.frecencyScore, "none"]
    };
    for (const [version, [score, identityResolution]] of Object.entries(fusions)) {
        const otherRank = rankPositions(eligible, score);
        models[version] = rankBy(eligible, candidate =>
            1 / (RRF_K + mruRank.get(candidate.tabId)) + 1 / (RRF_K + otherRank.get(candidate.tabId)),
        { identityResolution });
    }

    return models;
}

// History must be present (the live model abstains without it); missing
// context is neutral evidence, as in scoreContext.
function combine(history, context, weight) {
    if (!Number.isFinite(history)) return Number.NaN;
    return history + weight * (Number.isFinite(context) ? context : 0);
}
