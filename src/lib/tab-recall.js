import { normalizeIdentity } from "./revisit-model.js";

const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

export function normalizeQuery(query) {
    return String(query || "")
        .normalize("NFKC")
        .toLocaleLowerCase()
        .split(TOKEN_SPLIT)
        .filter(Boolean);
}

export function buildRecallCandidate(tab, behavior = {}) {
    const identity = normalizeIdentity(tab.url || "");
    let path = "";
    try {
        const parsed = new URL(tab.url || "");
        path = `${parsed.pathname || ""} ${parsed.search || ""}`;
    } catch {
        path = "";
    }

    return {
        tabId: tab.id,
        windowId: tab.windowId,
        title: tab.title || "Untitled tab",
        url: tab.url || "",
        domain: identity?.domain || "",
        path,
        active: Boolean(tab.active),
        pinned: Boolean(tab.pinned),
        audible: Boolean(tab.audible),
        index: Number.isFinite(Number(tab.index)) ? Number(tab.index) : null,
        lastAccessed: Number(tab.lastAccessed || behavior.lastAccessed || 0),
        totalTimeSpent: Number(behavior.totalTimeSpent || 0),
        firstSeen: Number(behavior.firstSeen || 0),
        bayesianScore: Number(behavior.bayesianScore),
        frecencyScore: Number(behavior.frecencyScore),
        historyScore: Number(behavior.historyScore),
        pageBayesianScore: Number(behavior.pageBayesianScore),
        domainBayesianScore: Number(behavior.domainBayesianScore),
        hierarchicalBayesianScore: Number(behavior.hierarchicalBayesianScore),
        pageHistoryScore: Number(behavior.pageHistoryScore),
        domainHistoryScore: Number(behavior.domainHistoryScore),
        pageContextScore: Number(behavior.pageContextScore),
        domainContextScore: Number(behavior.domainContextScore),
        pageContextAvailable: Boolean(behavior.pageContextAvailable),
        domainContextAvailable: Boolean(behavior.domainContextAvailable),
        // Replay-log inputs from RevisitStore.scoreTabs; no ranking reads them.
        pageAccessAges: accessAges(behavior.pageAccessAges),
        domainAccessAges: accessAges(behavior.domainAccessAges),
        behaviorSource: behavior.source || "none"
    };
}

function accessAges(value) {
    return Array.isArray(value) ? value.filter(age => Number.isFinite(age) && age >= 0) : [];
}

export function scoreText(query, candidate) {
    const tokens = Array.isArray(query) ? query : normalizeQuery(query);
    if (tokens.length === 0) return { score: 0, reason: "" };

    const title = searchable(candidate.title);
    const domain = searchable(candidate.domain);
    const path = searchable(candidate.path);
    let score = 0;
    let strongest = { weight: 0, reason: "" };

    for (const token of tokens) {
        const titleMatch = matchField(token, title, 10);
        const domainMatch = matchField(token, domain, 7);
        const pathMatch = matchField(token, path, 3);
        const best = [titleMatch, domainMatch, pathMatch].sort((a, b) => b.weight - a.weight)[0];
        if (best.weight === 0) return { score: 0, reason: "" };
        score += best.weight;
        if (best.weight > strongest.weight) strongest = best;
    }

    const phrase = tokens.join(" ");
    if (title.includes(phrase)) score += 6;
    if (domain.includes(phrase)) score += 4;
    return { score, reason: strongest.reason };
}

export function rankTabs(query, candidates, { limit = 5, currentTabId = null } = {}) {
    const tokens = normalizeQuery(query);
    const scored = candidates.map(candidate => {
        const text = scoreText(tokens, candidate);
        return { candidate, text, behavior: candidate.bayesianScore };
    });

    const eligible = tokens.length > 0
        ? scored.filter(item => item.text.score > 0)
        : scored.filter(item => item.candidate.tabId !== currentTabId);

    const textRange = finiteRange(eligible.map(item => item.text.score));
    const behaviorRange = finiteRange(eligible.map(item => item.behavior));

    return eligible
        .map(item => {
            const textNormalized = normalizeWithin(item.text.score, textRange);
            const behaviorNormalized = normalizeWithin(item.behavior, behaviorRange);
            let finalScore = tokens.length > 0
                ? (0.75 * textNormalized) + (0.25 * behaviorNormalized)
                : behaviorNormalized;
            if (tokens.length > 0 && item.candidate.tabId === currentTabId) finalScore -= 0.05;
            return {
                ...item.candidate,
                finalScore,
                textScore: item.text.score,
                reason: item.text.reason || behaviorReason(item.candidate)
            };
        })
        .sort(compareRanked)
        .slice(0, limit);
}

export function rankTabsByFrecency(candidates, { limit = 10, currentTabId = null } = {}) {
    return candidates
        .filter(candidate => candidate.tabId !== currentTabId)
        .map(candidate => ({
            ...candidate,
            finalScore: Number.isFinite(candidate.frecencyScore)
                ? candidate.frecencyScore
                : Number.NEGATIVE_INFINITY,
            reason: "frequently used"
        }))
        .sort((a, b) => finiteDifference(b.finalScore, a.finalScore)
            || (b.lastAccessed - a.lastAccessed)
            || (a.tabId - b.tabId))
        .slice(0, limit);
}

export function escapeOmniboxText(value) {
    return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}

export function formatRelativeAccess(timestamp, now = Date.now()) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "access time unknown";
    const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
    if (seconds < 60) return "accessed just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `accessed ${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `accessed ${hours}h ago`;
    const days = Math.round(hours / 24);
    return `accessed ${days}d ago`;
}

function searchable(value) {
    return String(value || "").normalize("NFKC").toLocaleLowerCase();
}

function matchField(token, field, baseWeight) {
    if (!field || !field.includes(token)) return { weight: 0, reason: "" };
    const exact = field === token;
    const prefix = field.startsWith(token) || field.split(TOKEN_SPLIT).some(part => part.startsWith(token));
    const weight = baseWeight + (exact ? 4 : prefix ? 2 : 0);
    return {
        weight,
        reason: baseWeight >= 10 ? "title match" : baseWeight >= 7 ? "domain match" : "URL match"
    };
}

function finiteRange(values) {
    const finite = values.filter(Number.isFinite);
    if (finite.length === 0) return null;
    return { min: Math.min(...finite), max: Math.max(...finite) };
}

function normalizeWithin(value, range) {
    if (!Number.isFinite(value) || !range) return 0;
    if (range.max === range.min) return range.max === 0 ? 0 : 1;
    return (value - range.min) / (range.max - range.min);
}

function behaviorReason(candidate) {
    if (candidate.behaviorSource === "bayesian") return "often follows this site";
    if (candidate.behaviorSource === "history") return "often revisited";
    if (candidate.behaviorSource === "frecency") return "frequently used";
    return "recent";
}

function compareRanked(a, b) {
    return (b.finalScore - a.finalScore)
        || finiteDifference(b.bayesianScore, a.bayesianScore)
        || (b.lastAccessed - a.lastAccessed)
        || (a.tabId - b.tabId);
}

function finiteDifference(a, b) {
    const safeA = Number.isFinite(a) ? a : Number.NEGATIVE_INFINITY;
    const safeB = Number.isFinite(b) ? b : Number.NEGATIVE_INFINITY;
    if (safeA === safeB) return 0;
    return safeA > safeB ? 1 : -1;
}
