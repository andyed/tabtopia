// Replay log for the next-tab shadow study.
//
// Why this exists: the shadow study keeps, per outcome, only each model's rank
// of the chosen tab. That is enough to score the models that were running at
// the time and nothing else. Trying a new ranking idea meant editing the
// extension, reloading it, and waiting weeks for ~20 eligible outcomes a day.
// A replay row keeps the content-free numeric features of every candidate at
// prediction time plus which candidate was chosen, so any model written as a
// function of those features can be scored against months of outcomes in
// seconds, and the live models can be re-run verbatim as a fidelity check.
//
// Privacy contract (same as ranking-diagnostics): no tab ids, URLs, titles,
// domains, or queries survive into the durable row. Domains and windows are
// reduced to per-row group numbers (0 = shares the current tab's), identities
// to positions, timestamps to ages. Every stored value is a number or null.
import { buildShadowPredictions } from "./shadow-ranking.js";

export const REPLAY_FORMAT = "ranking-replay-v1";
export const DEFAULT_MAX_REPLAY_ROWS = 2000;
export const DEFAULT_MAX_REPLAY_BYTES = 4 * 1024 * 1024;
// Rows with more candidates than this keep the most recently accessed ones plus
// the outcome, flagged `truncated`, because a 1,000-tab snapshot would spend
// the whole byte budget on one row. Truncated rows are still useful for model
// development but are excluded from fidelity assertions.
export const MAX_REPLAY_CANDIDATES = 120;
// Nine significant digits keeps scores comparable to the live run (ties below
// 1e-9 relative are not real ties) while roughly halving the stored bytes.
const SCORE_PRECISION = 9;
// The reconstructed current tab. Eligible candidates get tabId = tabRank + 1,
// their rank in the live tab-id order, so rankBy's tab-id tie-break replays
// identically even though the live ids themselves are never stored.
export const REPLAY_CURRENT_TAB_ID = 0;

// Per-candidate columns. Order is the storage order; decode maps by name so a
// row written by an older or newer feature list still loads (missing → null).
export const REPLAY_FEATURES = Object.freeze([
    "tabRank",                // 0-based rank of the live tab id among eligible candidates (tie-break order only)
    "accessAgeMs",            // capturedAt - lastAccessed; null when never accessed
    "firstSeenAgeMs",         // capturedAt - firstSeen; null when unknown
    "totalTimeSpent",
    "domainGroup",            // 0 = current tab's domain; other ints are per-row groups; null = no domain
    "windowGroup",            // 0 = current tab's window
    "stripOffset",            // index - current index, same window only; null otherwise
    "pinned",
    "audible",
    "frecencyScore",
    "bayesianScore",
    "historyScore",
    "pageHistoryScore",
    "domainHistoryScore",
    "pageContextScore",
    "domainContextScore",
    "pageContextAvailable",
    "domainContextAvailable",
    "pageBayesianScore",
    "domainBayesianScore",
    "hierarchicalBayesianScore"
]);

const SCORE_FEATURES = new Set([
    "frecencyScore", "bayesianScore", "historyScore", "pageHistoryScore", "domainHistoryScore",
    "pageContextScore", "domainContextScore", "pageBayesianScore", "domainBayesianScore",
    "hierarchicalBayesianScore"
]);
const FLAG_FEATURES = new Set(["pinned", "audible", "pageContextAvailable", "domainContextAvailable"]);

/**
 * Capture the feature matrix for one prediction. `prediction` is the object
 * buildShadowPredictions returned for `candidates`; rows follow its
 * eligibleTabIds order so the outcome index resolved later lines up.
 * Safe for chrome.storage.session: still numeric-only, bounded by the
 * candidate cap the prediction already applied.
 */
export function captureReplayFeatures(candidates, prediction, { now = Date.now() } = {}) {
    const byTabId = new Map();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const tabId = Number(candidate?.tabId);
        if (Number.isFinite(tabId) && !byTabId.has(tabId)) byTabId.set(tabId, candidate);
    }
    const current = byTabId.get(Number(prediction?.sourceTabId)) || null;
    const eligibleTabIds = Array.isArray(prediction?.eligibleTabIds) ? prediction.eligibleTabIds : [];
    const eligible = eligibleTabIds.map(tabId => byTabId.get(Number(tabId)));
    if (eligible.length === 0 || eligible.some(candidate => !candidate)) return null;

    const currentDomain = typeof current?.domain === "string" ? current.domain : "";
    const currentIndex = finiteOrNull(current?.index);
    const currentWindow = current?.windowId ?? null;
    const capturedAt = Math.round(Number(now)) || Date.now();
    // Group 0 is reserved for the current tab's value; every other distinct
    // value gets the next integer in first-seen order. Group numbers are
    // per-row and carry no meaning across rows.
    const domainGroups = { next: 1, ids: new Map(currentDomain !== "" ? [[currentDomain, 0]] : []) };
    const windowGroups = { next: 1, ids: new Map(currentWindow !== null ? [[currentWindow, 0]] : []) };
    const group = (groups, value) => {
        if (value === "" || value === null || value === undefined) return null;
        if (!groups.ids.has(value)) groups.ids.set(value, groups.next++);
        return groups.ids.get(value);
    };

    const tabRanks = new Map([...eligible].map(candidate => Number(candidate.tabId)).sort((left, right) => left - right)
        .map((tabId, rank) => [tabId, rank]));

    const matrix = eligible.map(candidate => {
        const sameWindow = currentWindow !== null && candidate.windowId === currentWindow;
        const index = finiteOrNull(candidate.index);
        return REPLAY_FEATURES.map(feature => {
            switch (feature) {
            case "tabRank": return tabRanks.get(Number(candidate.tabId));
            case "accessAgeMs": return ageOrNull(capturedAt, candidate.lastAccessed);
            case "firstSeenAgeMs": return ageOrNull(capturedAt, candidate.firstSeen);
            case "totalTimeSpent": return roundedOrNull(candidate.totalTimeSpent, 0);
            case "domainGroup": return group(domainGroups, typeof candidate.domain === "string" ? candidate.domain : "");
            case "windowGroup": return group(windowGroups, candidate.windowId ?? null);
            case "stripOffset": return sameWindow && currentIndex !== null && index !== null ? index - currentIndex : null;
            default:
                if (FLAG_FEATURES.has(feature)) return candidate[feature] ? 1 : 0;
                if (SCORE_FEATURES.has(feature)) return roundedOrNull(candidate[feature], SCORE_PRECISION);
                return null;
            }
        });
    });

    return {
        format: REPLAY_FORMAT,
        features: [...REPLAY_FEATURES],
        capturedAt,
        currentHasDomain: currentDomain !== "" ? 1 : 0,
        currentIndex,
        matrix
    };
}

/**
 * Turn a pending capture into a durable row once the outcome is known.
 * Returns null unless the outcome names one of the captured candidates.
 */
export function finalizeReplayRow(capture, { outcomeIndex, timestamp, cohort }) {
    const sane = sanitizeCapture(capture);
    if (!sane) return null;
    const index = Number(outcomeIndex);
    if (!Number.isInteger(index) || index < 0 || index >= sane.matrix.length) return null;

    const local = new Date(timestamp);
    const row = {
        timestamp: Math.round(Number(timestamp)) || sane.capturedAt,
        cohort: typeof cohort === "string" ? cohort.slice(0, 64) : "",
        capturedAt: sane.capturedAt,
        hourOfDay: local.getHours(),
        dayOfWeek: local.getDay(),
        currentHasDomain: sane.currentHasDomain,
        currentIndex: sane.currentIndex,
        totalCandidates: sane.matrix.length,
        truncated: 0,
        outcomeIndex: index,
        positions: null,
        features: sane.features,
        matrix: sane.matrix
    };
    if (sane.matrix.length <= MAX_REPLAY_CANDIDATES) return row;

    // Keep the most recently accessed candidates and the outcome, in their
    // original order so tab-id tie-breaks still replay among the kept rows.
    const ageColumn = sane.features.indexOf("accessAgeMs");
    const keep = new Set([index]);
    const byRecency = sane.matrix.map((values, position) => ({ position, age: ageColumn >= 0 ? values[ageColumn] : null }))
        .filter(item => item.position !== index)
        .sort((left, right) => (left.age ?? Infinity) - (right.age ?? Infinity) || left.position - right.position);
    for (const item of byRecency) {
        if (keep.size >= MAX_REPLAY_CANDIDATES) break;
        keep.add(item.position);
    }
    const positions = [...keep].sort((left, right) => left - right);
    return {
        ...row,
        truncated: 1,
        outcomeIndex: positions.indexOf(index),
        positions,
        matrix: positions.map(position => sane.matrix[position])
    };
}

/**
 * Rebuild shadow-ranking candidates from a row. Field names match
 * tab-recall's buildRecallCandidate so buildShadowPredictions runs unchanged;
 * the current tab is REPLAY_CURRENT_TAB_ID and eligible tabs are 1..n.
 */
export function reconstructCandidates(row) {
    const column = columnReader(row);
    const capturedAt = Number(row.capturedAt) || Number(row.timestamp) || 0;
    const currentIndex = finiteOrNull(row.currentIndex);
    const candidates = [{
        tabId: REPLAY_CURRENT_TAB_ID,
        windowId: 0,
        index: currentIndex,
        domain: row.currentHasDomain ? "d0" : "",
        lastAccessed: capturedAt,
        totalTimeSpent: 0,
        firstSeen: 0
    }];
    row.matrix.forEach((values, position) => {
        const get = feature => column(values, feature);
        const accessAge = get("accessAgeMs");
        const firstSeenAge = get("firstSeenAgeMs");
        const domainGroup = get("domainGroup");
        const windowGroup = get("windowGroup");
        const stripOffset = get("stripOffset");
        const candidate = {
            tabId: (get("tabRank") ?? position) + 1,
            windowId: windowGroup === null ? -1 - position : windowGroup,
            index: stripOffset === null || currentIndex === null ? null : currentIndex + stripOffset,
            domain: domainGroup === null ? "" : `d${domainGroup}`,
            lastAccessed: accessAge === null ? 0 : capturedAt - accessAge,
            totalTimeSpent: get("totalTimeSpent") ?? 0,
            firstSeen: firstSeenAge === null ? 0 : capturedAt - firstSeenAge
        };
        for (const feature of FLAG_FEATURES) candidate[feature] = get(feature) === 1;
        // rankBy drops non-finite scores, so null (live -Infinity or NaN) → NaN.
        for (const feature of SCORE_FEATURES) candidate[feature] = get(feature) ?? Number.NaN;
        candidates.push(candidate);
    });
    return candidates;
}

/**
 * Score one row with a prediction builder (the live buildShadowPredictions by
 * default, or any function with the same contract) and return a record in the
 * same shape takePendingPrediction produces, so summarizeRankingDiagnostics
 * reports replayed models exactly as it reports live ones.
 */
export function replayOutcome(row, build = buildShadowPredictions) {
    const candidates = reconstructCandidates(row);
    const prediction = build(candidates, { currentTabId: REPLAY_CURRENT_TAB_ID });
    // Reconstructed candidates are in matrix order, with the current tab first.
    const actual = candidates[Number(row.outcomeIndex) + 1]?.tabId ?? -1;
    const models = Object.entries(prediction?.models || {}).map(([modelVersion, model]) => {
        const predictedTabIds = Array.isArray(model?.predictedTabIds) ? model.predictedTabIds : [];
        const probabilities = Array.isArray(model?.probabilities) ? model.probabilities : [];
        const actualIndex = predictedTabIds.indexOf(actual);
        return {
            modelVersion,
            identityResolution: model?.identityResolution || "none",
            confidenceMethod: model?.confidenceMethod || "unknown",
            predictedCount: predictedTabIds.length,
            actualRank: actualIndex + 1,
            actualProbability: actualIndex >= 0 ? probabilities[actualIndex] : 0,
            top1Probability: probabilities[0] || 0
        };
    });
    return {
        event: "next_tab_outcome",
        cohort: row.cohort,
        timestamp: row.timestamp,
        destinationClass: "existing-tab",
        candidateCount: row.totalCandidates,
        qualifiedDwellMs: 0,
        observationAgeMs: 0,
        predictionLatencyMs: 0,
        censorReason: "",
        truncated: Boolean(row.truncated),
        models
    };
}

const ROW_FIELDS = ["timestamp", "cohort", "capturedAt", "hourOfDay", "dayOfWeek", "currentHasDomain",
    "currentIndex", "totalCandidates", "truncated", "outcomeIndex", "positions"];

/** Columnar-by-row storage encoding; drops the oldest rows to fit the budget. */
export function encodeReplayRows(rows, { maxRows = DEFAULT_MAX_REPLAY_ROWS, maxBytes = DEFAULT_MAX_REPLAY_BYTES } = {}) {
    const labels = [];
    const indexes = new Map();
    const label = value => {
        if (!indexes.has(value)) { indexes.set(value, labels.length); labels.push(value); }
        return indexes.get(value);
    };
    const encoded = (Array.isArray(rows) ? rows : []).slice(-maxRows).map(row => {
        const matrix = normalizeMatrix(row, REPLAY_FEATURES);
        return [...ROW_FIELDS.map(field => field === "cohort" ? label(String(row.cohort ?? "")) : (row[field] ?? null)), matrix];
    });
    const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    let size = bytes({ format: REPLAY_FORMAT, features: REPLAY_FEATURES, labels, rows: [] });
    const sizes = encoded.map(row => bytes(row) + 1);
    size += sizes.reduce((sum, value) => sum + value, 0);
    let start = 0;
    while (size > maxBytes && start < encoded.length) size -= sizes[start++];
    return { format: REPLAY_FORMAT, features: [...REPLAY_FEATURES], labels, rows: encoded.slice(start) };
}

export function decodeReplayRows(value) {
    if (value?.format !== REPLAY_FORMAT || !Array.isArray(value.rows) || !Array.isArray(value.features)) return [];
    const labels = Array.isArray(value.labels) ? value.labels : [];
    return value.rows.filter(row => Array.isArray(row) && row.length === ROW_FIELDS.length + 1).map(row => {
        const record = Object.fromEntries(ROW_FIELDS.map((field, index) => [field, row[index]]));
        record.cohort = labels[record.cohort] ?? "";
        record.features = [...value.features];
        record.matrix = Array.isArray(row[ROW_FIELDS.length]) ? row[ROW_FIELDS.length] : [];
        return record;
    }).filter(record => Number.isInteger(record.outcomeIndex) && record.outcomeIndex >= 0
        && record.outcomeIndex < record.matrix.length);
}

/** Validate a capture coming back out of chrome.storage.session. */
export function sanitizeCapture(capture) {
    if (capture?.format !== REPLAY_FORMAT || !Array.isArray(capture.features) || !Array.isArray(capture.matrix)) return null;
    const width = capture.features.length;
    if (width === 0 || !capture.features.every(feature => typeof feature === "string")) return null;
    const matrix = capture.matrix.map(values => Array.isArray(values) && values.length === width
        ? values.map(value => (typeof value === "number" && Number.isFinite(value)) ? value : null) : null);
    if (matrix.length === 0 || matrix.some(values => values === null)) return null;
    return {
        features: [...capture.features],
        capturedAt: Math.round(Number(capture.capturedAt)) || 0,
        currentHasDomain: capture.currentHasDomain ? 1 : 0,
        currentIndex: finiteOrNull(capture.currentIndex),
        matrix
    };
}

function columnReader(row) {
    const features = Array.isArray(row.features) ? row.features : REPLAY_FEATURES;
    const positions = new Map(features.map((feature, index) => [feature, index]));
    return (values, feature) => {
        const index = positions.get(feature);
        if (index === undefined) return null;
        const value = values[index];
        return typeof value === "number" && Number.isFinite(value) ? value : null;
    };
}

function normalizeMatrix(row, features) {
    const column = columnReader(row);
    return (Array.isArray(row.matrix) ? row.matrix : []).map(values => features.map(feature => column(values, feature)));
}

function ageOrNull(now, timestamp) {
    const value = Number(timestamp);
    return Number.isFinite(value) && value > 0 ? Math.round(now - value) : null;
}

function roundedOrNull(value, precision) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    if (precision === 0) return Math.round(number);
    return Number(number.toPrecision(precision));
}

function finiteOrNull(value) {
    const number = Number(value);
    return value !== null && value !== undefined && value !== "" && Number.isFinite(number) ? number : null;
}
