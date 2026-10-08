// Example candidate models for scripts/replay-eval.mjs --models.
//
// A models module exports a default function with the buildShadowPredictions
// contract: (candidates, { currentTabId }) => { [modelVersion]: prediction }.
// Candidates are the reconstructed replay candidates (see
// src/lib/ranking-replay.js reconstructCandidates for the fields available);
// the current tab is in the list with tabId === currentTabId. Use rankBy from
// shadow-ranking so ranking ties, abstention, and relative-softmax confidence
// behave exactly as they do for the shipped models.
//
// These are illustrations (v0), not proposals. Copy the file, rename the
// versions, and keep the names stable across runs so results stay comparable.
import { rankBy } from "../../src/lib/shadow-ranking.js";

export default function exampleModels(candidates, { currentTabId = null } = {}) {
    const current = candidates.find(candidate => candidate.tabId === currentTabId) || null;
    const eligible = candidates.filter(candidate => candidate.tabId !== currentTabId);
    const models = {};

    // MRU, but a tab on the current tab's domain counts as ten minutes fresher.
    const sameDomainBoostMs = 10 * 60 * 1000;
    models["mru-domain-boost-v0"] = rankBy(eligible, candidate =>
        Number(candidate.lastAccessed || 0)
        + (current?.domain && candidate.domain === current.domain ? sameDomainBoostMs : 0),
    { identityResolution: "domain" });

    // MRU restricted to the current window first, then everything else by recency.
    const windowBonus = 1e15;
    models["mru-window-first-v0"] = rankBy(eligible, candidate =>
        Number(candidate.lastAccessed || 0) + (current && candidate.windowId === current.windowId ? windowBonus : 0),
    { identityResolution: "tab-strip" });

    // Recency with a frecency nudge: age in log-minutes, frecency where present.
    models["recency-frecency-blend-v0"] = rankBy(eligible, candidate => {
        const ageMinutes = Math.max(0, (Number(current?.lastAccessed || 0) - Number(candidate.lastAccessed || 0)) / 60000);
        const frecency = Number.isFinite(candidate.frecencyScore) ? candidate.frecencyScore : 0;
        return -Math.log1p(ageMinutes) + 0.5 * frecency;
    });

    return models;
}
