import "../logging.js";

import { SHADOW_MODEL_VERSIONS } from "./shadow-ranking.js";
import { encodeRankingDetails, decodeRankingDetails } from "./ranking-detail-codec.js";
import {
    decodeReplayRows, encodeReplayRows, finalizeReplayRow, sanitizeCapture
} from "./ranking-replay.js";

export const DIAGNOSTICS_SETTING_KEY = "tabtopiaRankingDiagnosticsEnabledV1";
// Content-free feature rows for eligible outcomes; see ranking-replay.js.
export const DIAGNOSTICS_REPLAY_KEY = "tabtopiaRankingReplayV1";
export const DIAGNOSTICS_BUFFER_KEY = "tabtopiaRankingDiagnosticsV2";
export const DIAGNOSTICS_PENDING_KEY = "tabtopiaRankingDiagnosticsPendingV2";
export const DIAGNOSTICS_SESSION_KEY = "tabtopiaRankingDiagnosticsSessionV2";
export const DIAGNOSTICS_ROLLUP_KEY = "tabtopiaRankingStudyDaysV3";
export const RANKING_STUDY_COHORT = "next-tab-matrix-v3";

export const RANKING_STUDY_DEFAULTS = Object.freeze({
    evaluationWindowMs: 7 * 24 * 60 * 60 * 1000,
    maximumObservationAgeMs: 30 * 60 * 1000,
    minimumTotalObservations: 100,
    minimumWindowObservations: 25,
    requiredWinningWindows: 2,
    // Home shows three featured destinations, so the gate judges the surface
    // it guards: top-3 (plus MRR), not top-1. Zemla et al. (2015) likewise
    // report a four-slot springboard rather than a single prediction.
    exposureHitMetric: "hit3",
    minimumCoverage: 0.8,
    maximumCalibrationError: 0.1,
    maximumPredictionP95Ms: 50
});

const DEFAULT_MAX_RECORDS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;
// Upper bounds keep durable latency storage fixed-size and p95 conservative.
const LATENCY_BOUNDS = [0, 1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 25, 35, 50, 75, 100, 200, 500, 1000, 60000];
const MAX_MODELS = 24;
const MAX_CANDIDATES = 1000;
const CALIBRATION_BIN_COUNT = 5;
const LOG_LOSS_FLOOR = 1e-6;
const ALLOWED_EVENTS = new Set([
    "omnibox_selection",
    "omnibox_abandonment",
    "next_tab_outcome"
]);
const CENSOR_REASONS = new Set([
    "inactivity",
    "outcome-not-candidate",
    "candidate-set-changed",
    "unspecified"
]);
const DESTINATION_CLASSES = new Set(["existing-tab", "out-of-set", "unknown"]);

/**
 * Local-only, bounded ranking diagnostics. Normal installs start disabled;
 * unpacked development installs start enabled. A persisted user choice always
 * wins over the install-type default.
 */
export class RankingDiagnostics {
    constructor(localStorage, sessionStorage = null, {
        maxRecords = DEFAULT_MAX_RECORDS,
        flushDelayMs = 1000,
        maximumObservationAgeMs = RANKING_STUDY_DEFAULTS.maximumObservationAgeMs,
        now = Date.now
    } = {}) {
        this.localStorage = localStorage;
        this.sessionStorage = sessionStorage;
        this.maxRecords = maxRecords;
        this.flushDelayMs = flushDelayMs;
        this.maximumObservationAgeMs = maximumObservationAgeMs;
        this.now = now;
        this.enabled = false;
        this.ready = false;
        this.sessionStartedAt = 0;
        this.pendingRecords = [];
        this.pendingReplayRows = [];
        this.flushTimer = null;
        this.flushChain = Promise.resolve();
    }

    async init({ installType } = {}) {
        const saved = await this.localStorage.get([DIAGNOSTICS_SETTING_KEY]);
        if (typeof saved[DIAGNOSTICS_SETTING_KEY] === "boolean") {
            this.enabled = saved[DIAGNOSTICS_SETTING_KEY];
        } else {
            this.enabled = installType === "development";
            await this.localStorage.set({ [DIAGNOSTICS_SETTING_KEY]: this.enabled });
        }
        if (this.enabled) await this.ensureSessionStart();
        this.ready = true;
        return this;
    }

    isEnabled() {
        return this.ready && this.enabled;
    }

    async setEnabled(enabled) {
        this.enabled = Boolean(enabled);
        this.ready = true;
        await this.localStorage.set({ [DIAGNOSTICS_SETTING_KEY]: this.enabled });
        if (this.enabled) await this.ensureSessionStart();
        else await this.clear();
        return this.enabled;
    }

    record(rawRecord) {
        if (!this.isEnabled()) return false;
        const record = sanitizeRecord(rawRecord);
        if (!record) return false;
        this.pendingRecords.push(record);
        // The replay row rides alongside the record from takePendingPrediction;
        // sanitizeRecord drops it on purpose so the detail buffer stays small.
        if (rawRecord.replay && record.event === "next_tab_outcome" && !record.censorReason) {
            this.pendingReplayRows.push(rawRecord.replay);
        }
        this.scheduleFlush();
        return true;
    }

    scheduleFlush() {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush().catch(error => globalThis.TabtopiaLogger.warn("[RankingDiagnostics] flush failed", error));
        }, this.flushDelayMs);
    }

    async flush() {
        if (!this.isEnabled() || this.pendingRecords.length === 0) return;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        const records = this.pendingRecords.splice(0);
        const replayRows = this.pendingReplayRows.splice(0);
        this.flushChain = this.flushChain.catch(() => {}).then(async () => {
            if (!this.isEnabled()) return;
            const saved = await this.localStorage.get([DIAGNOSTICS_BUFFER_KEY, DIAGNOSTICS_ROLLUP_KEY, DIAGNOSTICS_REPLAY_KEY]);
            const existing = decodeRankingDetails(saved[DIAGNOSTICS_BUFFER_KEY]);
            const days = updateStudyDays(saved[DIAGNOSTICS_ROLLUP_KEY], records, this.now());
            const values = {
                [DIAGNOSTICS_BUFFER_KEY]: encodeRankingDetails([...existing, ...records], { maxRecords: this.maxRecords }),
                [DIAGNOSTICS_ROLLUP_KEY]: days
            };
            if (replayRows.length > 0) {
                const existingReplay = decodeReplayRows(saved[DIAGNOSTICS_REPLAY_KEY]);
                values[DIAGNOSTICS_REPLAY_KEY] = encodeReplayRows([...existingReplay, ...replayRows]);
            }
            await this.localStorage.set(values);
        }).catch(error => {
            if (this.isEnabled()) {
                this.pendingRecords.unshift(...records);
                this.pendingReplayRows.unshift(...replayRows);
            }
            throw error;
        });
        await this.flushChain;
    }

    async clear() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.pendingRecords = [];
        this.pendingReplayRows = [];
        this.sessionStartedAt = 0;
        await this.flushChain.catch(() => {});
        this.flushChain = Promise.resolve();
        await Promise.all([
            removeKey(this.localStorage, DIAGNOSTICS_BUFFER_KEY),
            removeKey(this.localStorage, DIAGNOSTICS_ROLLUP_KEY),
            removeKey(this.localStorage, DIAGNOSTICS_REPLAY_KEY),
            removeKey(this.sessionStorage, DIAGNOSTICS_PENDING_KEY),
            removeKey(this.sessionStorage, DIAGNOSTICS_SESSION_KEY)
        ]);
    }

    async getRecords() {
        if (!this.isEnabled()) return [];
        await this.flush();
        await this.flushChain;
        const saved = await this.localStorage.get([DIAGNOSTICS_BUFFER_KEY]);
        return decodeRankingDetails(saved[DIAGNOSTICS_BUFFER_KEY]);
    }

    async getSummary() {
        await this.flush();
        await this.flushChain;
        const saved = this.isEnabled()
            ? await this.localStorage.get([DIAGNOSTICS_ROLLUP_KEY, DIAGNOSTICS_BUFFER_KEY, DIAGNOSTICS_REPLAY_KEY]) : {};
        const days = retainedStudyDays(saved[DIAGNOSTICS_ROLLUP_KEY], this.now());
        const accumulator = createStudyAccumulator();
        for (const day of days) mergeStudyAccumulator(accumulator, decodeAccumulator(day.data));
        const summary = finalizeStudy(accumulator, RANKING_STUDY_DEFAULTS);
        summary.study.retentionDays = RETENTION_DAYS;
        summary.study.retainedDays = days.length;
        summary.study.predictionLatencyMethod = "histogram-upper-bound";
        summary.study.detailLimit = this.maxRecords;
        summary.study.retainedDetails = decodeRankingDetails(saved[DIAGNOSTICS_BUFFER_KEY]).length;
        summary.study.replayRows = decodeReplayRows(saved[DIAGNOSTICS_REPLAY_KEY]).length;
        return summary;
    }

    /**
     * Resolve one short-lived prediction into one durable, content-free study
     * record. Tab identifiers are consumed here and never copied to the local
     * outcome buffer.
     */
    async takePendingPrediction(actualTabId, qualifiedDwellMs, currentTabIds = [], now = Date.now()) {
        if (!this.isEnabled() || !this.sessionStorage) return null;
        const saved = await this.sessionStorage.get([DIAGNOSTICS_PENDING_KEY]);
        const pending = saved[DIAGNOSTICS_PENDING_KEY];
        await removeKey(this.sessionStorage, DIAGNOSTICS_PENDING_KEY);
        const actual = boundedInteger(actualTabId, 1, Number.MAX_SAFE_INTEGER);
        if (!pending || !actual || pending.cohort !== RANKING_STUDY_COHORT) return null;
        // URL changes, reload completion, and window refocus also qualify an
        // access. They are not next-tab choices. The caller builds a fresh
        // prediction from the updated context after consuming this one.
        if (actual === pending.sourceTabId) return null;

        const eligibleTabIds = safeTabIds(pending.eligibleTabIds, MAX_CANDIDATES);
        const observationAgeMs = Math.max(0, now - boundedInteger(pending.timestamp, 0, now));
        const currentSetWasProvided = Array.isArray(currentTabIds) && currentTabIds.length > 0;
        const comparableCurrentIds = currentSetWasProvided
            ? safeTabIds(currentTabIds, MAX_CANDIDATES)
                .filter(tabId => tabId !== boundedInteger(pending.sourceTabId, 1, Number.MAX_SAFE_INTEGER))
            : [];

        let censorReason = "";
        if (observationAgeMs > this.maximumObservationAgeMs) {
            censorReason = "inactivity";
        } else if (!eligibleTabIds.includes(actual)) {
            censorReason = "outcome-not-candidate";
        } else if (currentSetWasProvided && !sameIntegerSet(eligibleTabIds, comparableCurrentIds)) {
            censorReason = "candidate-set-changed";
        }

        const models = [];
        for (const [modelVersion, rawPrediction] of Object.entries(pending.models || {}).slice(0, MAX_MODELS)) {
            const prediction = sanitizePendingModel(rawPrediction);
            const actualIndex = prediction.predictedTabIds.indexOf(actual);
            models.push({
                modelVersion,
                identityResolution: prediction.identityResolution,
                confidenceMethod: prediction.confidenceMethod,
                predictedCount: prediction.predictedTabIds.length,
                actualRank: actualIndex + 1,
                actualProbability: actualIndex >= 0 ? prediction.probabilities[actualIndex] : 0,
                top1Probability: prediction.probabilities[0] || 0
            });
        }

        const record = sanitizeRecord({
            event: "next_tab_outcome",
            cohort: pending.cohort,
            timestamp: now,
            destinationClass: eligibleTabIds.includes(actual) ? "existing-tab" : "out-of-set",
            candidateCount: eligibleTabIds.length,
            qualifiedDwellMs,
            observationAgeMs,
            predictionLatencyMs: pending.latencyMs,
            openTabBand: openTabBand(eligibleTabIds.length + 1),
            sessionAgeBand: sessionAgeBand(pending.sessionAgeMs),
            censorReason,
            models
        });
        // Only an eligible outcome earns a replay row: a censored one has no
        // label a model could be scored against. The row shares the record's
        // timestamp so the offline fidelity check can join the two.
        if (record && !censorReason && pending.replay) {
            const replay = finalizeReplayRow(pending.replay, {
                outcomeIndex: eligibleTabIds.indexOf(actual), timestamp: now, cohort: pending.cohort
            });
            if (replay) record.replay = replay;
        }
        return record;
    }

    async setPendingPrediction(prediction, now = Date.now()) {
        if (!this.isEnabled() || !this.sessionStorage) return false;
        await this.ensureSessionStart(now);
        const eligibleTabIds = safeTabIds(prediction?.eligibleTabIds, MAX_CANDIDATES);
        const models = {};
        for (const [rawVersion, rawPrediction] of Object.entries(prediction?.models || {}).slice(0, MAX_MODELS)) {
            const version = safeLabel(rawVersion);
            if (!version) continue;
            models[version] = sanitizePendingModel(rawPrediction);
        }
        // A capture must have exactly one feature row per eligible tab, in the
        // same order, or the outcome index resolved later would point at the
        // wrong candidate. Anything else is dropped rather than stored.
        const replay = sanitizeCapture(prediction?.replay);
        await this.sessionStorage.set({
            [DIAGNOSTICS_PENDING_KEY]: {
                cohort: RANKING_STUDY_COHORT,
                timestamp: now,
                sourceTabId: boundedInteger(prediction?.sourceTabId, 1, Number.MAX_SAFE_INTEGER),
                candidateCount: eligibleTabIds.length,
                eligibleTabIds,
                latencyMs: boundedNumber(prediction?.latencyMs, 0, 60000),
                sessionAgeMs: Math.max(0, now - this.sessionStartedAt),
                models,
                replay: replay && replay.matrix.length === eligibleTabIds.length
                    ? { format: prediction.replay.format, ...replay } : null
            }
        });
        return true;
    }

    async ensureSessionStart(now = Date.now()) {
        if (!this.sessionStorage) return 0;
        if (this.sessionStartedAt) return this.sessionStartedAt;
        const saved = await this.sessionStorage.get([DIAGNOSTICS_SESSION_KEY]);
        this.sessionStartedAt = boundedInteger(
            saved[DIAGNOSTICS_SESSION_KEY]?.startedAt,
            1,
            now
        ) || now;
        await this.sessionStorage.set({
            [DIAGNOSTICS_SESSION_KEY]: { startedAt: this.sessionStartedAt }
        });
        return this.sessionStartedAt;
    }
}

export function summarizeRankingDiagnostics(records, config = {}) {
    const settings = { ...RANKING_STUDY_DEFAULTS, ...config };
    const accumulator = createStudyAccumulator();
    for (const record of Array.isArray(records) ? records : []) {
        addStudyRecord(accumulator, record, settings);
    }
    return finalizeStudy(accumulator, settings);
}

function createStudyAccumulator() {
    return {
        records: 0, selections: 0, abandonments: 0, outcomes: 0, censored: 0,
        firstOutcomeAt: null, lastOutcomeAt: null,
        modelAccumulators: new Map(),
        openTabSegments: new Map(),
        sessionAgeSegments: new Map(),
        destinationClassSegments: new Map(),
        predictionLatencies: new Map(),
        censorReasonCounts: new Map()
    };
}

function addStudyRecord(accumulator, record, settings, bucketLatency = false) {
    if (record?.event === "next_tab_outcome" && record.cohort !== RANKING_STUDY_COHORT) return;
    const outcome = sanitizeRecord(record);
    if (!outcome) return;
    accumulator.records += 1;
    if (outcome.event === "omnibox_selection") accumulator.selections += 1;
    if (outcome.event === "omnibox_abandonment") accumulator.abandonments += 1;
    if (outcome.event !== "next_tab_outcome") return;
    accumulator.outcomes += 1;
    accumulator.firstOutcomeAt = Math.min(accumulator.firstOutcomeAt ?? Infinity, outcome.timestamp);
    accumulator.lastOutcomeAt = Math.max(accumulator.lastOutcomeAt ?? 0, outcome.timestamp);
    if (Number.isFinite(outcome.predictionLatencyMs)) {
        const latency = bucketLatency
            ? LATENCY_BOUNDS.find(bound => outcome.predictionLatencyMs <= bound)
            : outcome.predictionLatencyMs;
        incrementCount(accumulator.predictionLatencies, latency);
    }
    addSegmentOutcome(accumulator.openTabSegments, outcome.openTabBand, outcome, settings);
    addSegmentOutcome(accumulator.sessionAgeSegments, outcome.sessionAgeBand, outcome, settings);
    addSegmentOutcome(accumulator.destinationClassSegments, outcome.destinationClass, outcome, settings);
    if (outcome.censorReason) {
        accumulator.censored += 1;
        incrementCount(accumulator.censorReasonCounts, outcome.censorReason);
        return;
    }
    for (const model of outcome.models) {
        const modelAccumulator = accumulator.modelAccumulators.get(model.modelVersion)
            || createModelAccumulator(model.modelVersion, model.identityResolution);
        addModelOutcome(modelAccumulator, model, outcome.timestamp, settings);
        accumulator.modelAccumulators.set(model.modelVersion, modelAccumulator);
    }
}

function finalizeStudy(accumulator, settings) {
    const { records, selections, abandonments, outcomes, censored,
        modelAccumulators, openTabSegments, sessionAgeSegments,
        destinationClassSegments, predictionLatencies, censorReasonCounts } = accumulator;
    const models = [...modelAccumulators.values()]
        .map(value => finalizeModel(value))
        .sort((left, right) => left.modelVersion.localeCompare(right.modelVersion));
    addBaselineLift(models);
    const eligibleOutcomes = outcomes - censored;
    const study = {
        cohort: RANKING_STUDY_COHORT,
        outcomes,
        eligibleOutcomes,
        censoredOutcomes: censored,
        eligibilityCoverage: ratio(eligibleOutcomes, outcomes),
        censoringRate: ratio(censored, outcomes),
        censorReasons: [...censorReasonCounts.entries()]
            .map(([reason, count]) => ({ reason, count, rate: ratio(count, outcomes) }))
            .sort((left, right) => (right.count - left.count) || left.reason.localeCompare(right.reason)),
        evaluationWindows: countEvaluationWindows(models),
        predictionP95Ms: histogramPercentile(predictionLatencies, 0.95),
        firstOutcomeAt: accumulator.firstOutcomeAt,
        lastOutcomeAt: accumulator.lastOutcomeAt
    };
    return {
        records, selections, abandonments, study, models,
        segments: {
            openTabBands: finalizeSegments(openTabSegments),
            sessionAgeBands: finalizeSegments(sessionAgeSegments),
            destinationClasses: finalizeSegments(destinationClassSegments)
        },
        exposureGate: evaluateExposureGate(models, study, settings)
    };
}

function retainedStudyDays(value, now) {
    const today = Math.floor(now / DAY_MS);
    return (Array.isArray(value) ? value : []).filter(day =>
        day?.cohort === RANKING_STUDY_COHORT
        && Number.isInteger(day.day) && day.day <= today
        && day.day > today - RETENTION_DAYS).slice(-RETENTION_DAYS);
}

function updateStudyDays(saved, records, now) {
    const days = new Map(retainedStudyDays(saved, now).map(day => [day.day, day]));
    const today = Math.floor(now / DAY_MS);
    const pending = new Map();
    for (const record of records) {
        const day = Math.floor(record.timestamp / DAY_MS);
        if (day > today || day <= today - RETENTION_DAYS) continue;
        const accumulator = pending.get(day)
            || (days.has(day) ? decodeAccumulator(days.get(day).data) : createStudyAccumulator());
        addStudyRecord(accumulator, record, RANKING_STUDY_DEFAULTS, true);
        if (accumulator.records > 0) pending.set(day, accumulator);
    }
    for (const [day, accumulator] of pending) {
        days.set(day, { day, cohort: RANKING_STUDY_COHORT, data: encodeAccumulator(accumulator) });
    }
    return [...days.values()].sort((left, right) => left.day - right.day);
}

// Fixed numeric columns avoid repeating model field names in every daily
// segment. The V3 storage key versions this compact, content-free format.
const MODEL_TOTAL_FIELDS = ["observations", "covered", "hit1", "hit3", "hit4", "reciprocalRank", "logLoss", "logLossObservations"];
const STUDY_SEGMENTS = ["openTabSegments", "sessionAgeSegments", "destinationClassSegments"];

function encodeModels(models) {
    return [...models].map(([key, model]) => [
        key, model.modelVersion, model.identityResolution,
        MODEL_TOTAL_FIELDS.map(field => model[field]),
        model.calibrationBins.map(bin => [bin.observations, bin.confidence, bin.hits]),
        encodeModels(model.windows)
    ]);
}

function decodeModels(rows) {
    return new Map(rows.map(([key, version, identity, totals, bins, windows]) => {
        const model = createModelAccumulator(version, identity);
        MODEL_TOTAL_FIELDS.forEach((field, index) => { model[field] = totals[index]; });
        model.calibrationBins = bins.map(([observations, confidence, hits]) => ({ observations, confidence, hits }));
        model.windows = decodeModels(windows);
        return [key, model];
    }));
}

function encodeAccumulator(accumulator) {
    const data = { ...accumulator,
        modelAccumulators: encodeModels(accumulator.modelAccumulators),
        predictionLatencies: [...accumulator.predictionLatencies],
        censorReasonCounts: [...accumulator.censorReasonCounts]
    };
    for (const key of STUDY_SEGMENTS) {
        data[key] = [...accumulator[key].values()].map(segment => [
            segment.band, segment.outcomes, segment.censored, encodeModels(segment.models)
        ]);
    }
    return data;
}

function decodeAccumulator(data) {
    const accumulator = { ...data,
        modelAccumulators: decodeModels(data.modelAccumulators),
        predictionLatencies: new Map(data.predictionLatencies),
        censorReasonCounts: new Map(data.censorReasonCounts)
    };
    for (const key of STUDY_SEGMENTS) {
        accumulator[key] = new Map(data[key].map(([band, outcomes, censored, models]) => [
            band, { band, outcomes, censored, models: decodeModels(models) }
        ]));
    }
    return accumulator;
}

function mergeStudyAccumulator(target, source) {
    for (const key of ["records", "selections", "abandonments", "outcomes", "censored"]) {
        target[key] += source[key];
    }
    if (source.firstOutcomeAt !== null) {
        target.firstOutcomeAt = Math.min(target.firstOutcomeAt ?? Infinity, source.firstOutcomeAt);
        target.lastOutcomeAt = Math.max(target.lastOutcomeAt ?? 0, source.lastOutcomeAt);
    }
    for (const key of ["predictionLatencies", "censorReasonCounts"]) {
        for (const [name, count] of source[key]) incrementCount(target[key], name, count);
    }
    mergeModels(target.modelAccumulators, source.modelAccumulators);
    for (const key of STUDY_SEGMENTS) {
        for (const [band, segment] of source[key]) {
            const current = target[key].get(band) || { band, outcomes: 0, censored: 0, models: new Map() };
            current.outcomes += segment.outcomes;
            current.censored += segment.censored;
            mergeModels(current.models, segment.models);
            target[key].set(band, current);
        }
    }
}

function mergeModels(target, source) {
    for (const [version, model] of source) {
        const current = target.get(version) || createModelAccumulator(model.modelVersion, model.identityResolution);
        for (const key of MODEL_TOTAL_FIELDS) {
            current[key] += model[key];
        }
        model.calibrationBins.forEach((bin, index) => {
            for (const key of ["observations", "confidence", "hits"]) current.calibrationBins[index][key] += bin[key];
        });
        mergeModels(current.windows, model.windows);
        target.set(version, current);
    }
}

function incrementCount(map, key, count = 1) {
    map.set(key, (map.get(key) || 0) + count);
}

function histogramPercentile(histogram, fraction) {
    const total = [...histogram.values()].reduce((sum, count) => sum + count, 0);
    if (total === 0) return null;
    let cumulative = 0;
    for (const [value, count] of [...histogram].sort(([left], [right]) => left - right)) {
        cumulative += count;
        if (cumulative >= Math.ceil(fraction * total)) return value;
    }
    return null;
}

function sanitizeRecord(record) {
    if (!record || !ALLOWED_EVENTS.has(record.event)) return null;
    const common = {
        event: record.event,
        timestamp: boundedInteger(record.timestamp || Date.now(), 0, Number.MAX_SAFE_INTEGER)
    };

    if (record.event === "next_tab_outcome") {
        const models = Array.isArray(record.models)
            ? record.models.map(sanitizeOutcomeModel).filter(Boolean).slice(0, MAX_MODELS)
            : legacyOutcomeModels(record);
        if (models.length === 0) return null;
        return {
            ...common,
            cohort: safeLabel(record.cohort),
            destinationClass: safeDestinationClass(record.destinationClass),
            candidateCount: boundedInteger(record.candidateCount, 0, MAX_CANDIDATES),
            qualifiedDwellMs: boundedInteger(record.qualifiedDwellMs, 0, 3600000),
            observationAgeMs: boundedInteger(record.observationAgeMs, 0, 24 * 60 * 60 * 1000),
            predictionLatencyMs: boundedNumber(record.predictionLatencyMs, 0, 60000),
            openTabBand: safeBand(record.openTabBand) || openTabBand(Number(record.candidateCount || 0) + 1),
            sessionAgeBand: safeBand(record.sessionAgeBand) || "unknown",
            censorReason: sanitizeCensorReason(record),
            models
        };
    }

    return {
        ...common,
        modelVersion: safeLabel(record.modelVersion) || "recall-bayes-v1",
        queryLength: boundedInteger(record.queryLength, 0, 100000),
        queryTokenCount: boundedInteger(record.queryTokenCount, 0, 10000),
        candidateCount: boundedInteger(record.candidateCount, 0, 100000),
        selectedRank: record.event === "omnibox_selection"
            ? boundedInteger(record.selectedRank, 0, 100000)
            : 0,
        latencyMs: boundedNumber(record.latencyMs, 0, 60000)
    };
}

function sanitizeOutcomeModel(model) {
    const modelVersion = safeLabel(model?.modelVersion);
    if (!modelVersion) return null;
    return {
        modelVersion,
        identityResolution: safeLabel(model?.identityResolution) || "none",
        confidenceMethod: safeLabel(model?.confidenceMethod) || "unknown",
        predictedCount: boundedInteger(model?.predictedCount, 0, MAX_CANDIDATES),
        actualRank: boundedInteger(model?.actualRank, 0, MAX_CANDIDATES),
        actualProbability: boundedProbability(model?.actualProbability),
        top1Probability: boundedProbability(model?.top1Probability)
    };
}

function legacyOutcomeModels(record) {
    const modelVersion = safeLabel(record?.modelVersion);
    const actualTabId = boundedInteger(record?.actualTabId, 1, Number.MAX_SAFE_INTEGER);
    if (!modelVersion || !actualTabId) return [];
    const predictedTabIds = safeTabIds(record?.predictedTabIds, MAX_CANDIDATES);
    return [{
        modelVersion,
        identityResolution: safeLabel(record?.identityResolution) || "unknown",
        confidenceMethod: "unknown",
        predictedCount: predictedTabIds.length,
        actualRank: predictedTabIds.indexOf(actualTabId) + 1,
        actualProbability: null,
        top1Probability: null
    }];
}

function sanitizePendingModel(rawPrediction) {
    const value = Array.isArray(rawPrediction)
        ? { predictedTabIds: rawPrediction }
        : rawPrediction || {};
    const predictedTabIds = safeTabIds(value.predictedTabIds, MAX_CANDIDATES);
    const probabilities = normalizeProbabilities(value.probabilities, predictedTabIds.length);
    return {
        identityResolution: safeLabel(value.identityResolution) || "none",
        confidenceMethod: safeLabel(value.confidenceMethod) || "unknown",
        predictedTabIds,
        probabilities
    };
}

function normalizeProbabilities(values, length) {
    if (length === 0) return [];
    const probabilities = (Array.isArray(values) ? values : [])
        .slice(0, length)
        .map(value => boundedProbability(value) ?? 0);
    if (probabilities.length !== length || probabilities.every(value => value === 0)) {
        return Array.from({ length }, () => 1 / length);
    }
    const total = probabilities.reduce((sum, value) => sum + value, 0);
    return probabilities.map(value => value / total);
}

function createModelAccumulator(modelVersion, identityResolution = "none") {
    return {
        modelVersion,
        identityResolution,
        observations: 0,
        covered: 0,
        hit1: 0,
        hit3: 0,
        hit4: 0,
        reciprocalRank: 0,
        logLoss: 0,
        logLossObservations: 0,
        calibrationBins: Array.from({ length: CALIBRATION_BIN_COUNT }, () => ({
            observations: 0,
            confidence: 0,
            hits: 0
        })),
        windows: new Map()
    };
}

function addModelOutcome(accumulator, model, timestamp, settings, includeWindow = true) {
    accumulator.observations += 1;
    if (model.predictedCount > 0) accumulator.covered += 1;
    if (model.actualRank === 1) accumulator.hit1 += 1;
    if (model.actualRank > 0 && model.actualRank <= 3) accumulator.hit3 += 1;
    if (model.actualRank > 0 && model.actualRank <= 4) accumulator.hit4 += 1;
    if (model.actualRank > 0) accumulator.reciprocalRank += 1 / model.actualRank;

    if (Number.isFinite(model.actualProbability)) {
        accumulator.logLoss += -Math.log(Math.max(LOG_LOSS_FLOOR, model.actualProbability));
        accumulator.logLossObservations += 1;
    }
    if (model.predictedCount > 0 && Number.isFinite(model.top1Probability)) {
        const binIndex = Math.min(
            CALIBRATION_BIN_COUNT - 1,
            Math.floor(model.top1Probability * CALIBRATION_BIN_COUNT)
        );
        const bin = accumulator.calibrationBins[binIndex];
        bin.observations += 1;
        bin.confidence += model.top1Probability;
        if (model.actualRank === 1) bin.hits += 1;
    }

    if (includeWindow) {
        const start = evaluationWindowStart(timestamp, settings.evaluationWindowMs);
        const windowAccumulator = accumulator.windows.get(start)
            || createModelAccumulator(accumulator.modelVersion, accumulator.identityResolution);
        addModelOutcome(windowAccumulator, model, timestamp, settings, false);
        accumulator.windows.set(start, windowAccumulator);
    }
}

function finalizeModel(accumulator, includeWindows = true) {
    const calibration = finalizeCalibration(accumulator.calibrationBins);
    const model = {
        modelVersion: accumulator.modelVersion,
        identityResolution: accumulator.identityResolution,
        observations: accumulator.observations,
        coveredObservations: accumulator.covered,
        coverage: ratio(accumulator.covered, accumulator.observations),
        hit1: ratio(accumulator.hit1, accumulator.observations),
        hit3: ratio(accumulator.hit3, accumulator.observations),
        hit4: ratio(accumulator.hit4, accumulator.observations),
        mrr: ratio(accumulator.reciprocalRank, accumulator.observations),
        logLoss: ratio(accumulator.logLoss, accumulator.logLossObservations),
        calibrationObservations: calibration.observations,
        calibrationError: calibration.error,
        calibrationBins: calibration.bins
    };
    if (includeWindows) {
        model.windows = [...accumulator.windows.entries()]
            .map(([windowStart, value]) => ({
                windowStart,
                ...finalizeModel(value, false)
            }))
            .sort((left, right) => left.windowStart - right.windowStart);
    }
    return model;
}

function finalizeCalibration(rawBins) {
    const observations = rawBins.reduce((sum, bin) => sum + bin.observations, 0);
    let weightedError = 0;
    const bins = rawBins.map((bin, index) => {
        const meanConfidence = ratio(bin.confidence, bin.observations);
        const accuracy = ratio(bin.hits, bin.observations);
        if (bin.observations > 0) {
            weightedError += bin.observations * Math.abs(meanConfidence - accuracy);
        }
        return {
            lower: index / CALIBRATION_BIN_COUNT,
            upper: (index + 1) / CALIBRATION_BIN_COUNT,
            observations: bin.observations,
            meanConfidence,
            accuracy
        };
    });
    return {
        observations,
        error: ratio(weightedError, observations),
        bins
    };
}

function addBaselineLift(models) {
    const byVersion = new Map(models.map(model => [model.modelVersion, model]));
    const baselines = [SHADOW_MODEL_VERSIONS.mru, SHADOW_MODEL_VERSIONS.frecency];
    for (const model of models) {
        model.lift = {};
        for (const version of baselines) {
            const baseline = byVersion.get(version);
            if (!baseline) continue;
            model.lift[version] = {
                hit1: difference(model.hit1, baseline.hit1),
                hit3: difference(model.hit3, baseline.hit3),
                mrr: difference(model.mrr, baseline.mrr)
            };
        }
    }
}

function addSegmentOutcome(segments, band, outcome, settings) {
    const safe = safeBand(band) || "unknown";
    const segment = segments.get(safe) || {
        band: safe,
        outcomes: 0,
        censored: 0,
        models: new Map()
    };
    segment.outcomes += 1;
    if (outcome.censorReason) {
        segment.censored += 1;
    } else {
        for (const model of outcome.models) {
            const accumulator = segment.models.get(model.modelVersion)
                || createModelAccumulator(model.modelVersion, model.identityResolution);
            addModelOutcome(accumulator, model, outcome.timestamp, settings, false);
            segment.models.set(model.modelVersion, accumulator);
        }
    }
    segments.set(safe, segment);
}

function finalizeSegments(segments) {
    return [...segments.values()].map(segment => ({
        band: segment.band,
        outcomes: segment.outcomes,
        eligibleOutcomes: segment.outcomes - segment.censored,
        censoringRate: ratio(segment.censored, segment.outcomes),
        models: [...segment.models.values()]
            .map(value => finalizeModel(value, false))
            .sort((left, right) => left.modelVersion.localeCompare(right.modelVersion))
    }));
}

function evaluateExposureGate(models, study, settings) {
    const byVersion = new Map(models.map(model => [model.modelVersion, model]));
    const primary = byVersion.get(SHADOW_MODEL_VERSIONS.bayesDomain);
    const mru = byVersion.get(SHADOW_MODEL_VERSIONS.mru);
    const frecency = byVersion.get(SHADOW_MODEL_VERSIONS.frecency);
    const reasons = [];
    const winningWindows = primary
        ? primary.windows.filter(window => windowBeatsBaselines(window, mru, frecency, settings)).length
        : 0;

    if (!primary || !mru || !frecency) reasons.push("Required primary and baseline models have not all produced outcomes.");
    if ((primary?.observations || 0) < settings.minimumTotalObservations) {
        reasons.push(`Need ${settings.minimumTotalObservations} eligible outcomes.`);
    }
    if (winningWindows < settings.requiredWinningWindows) {
        reasons.push(`Need ${hitMetricLabel(settings)} and MRR lift over MRU and frecency in ${settings.requiredWinningWindows} evaluation windows.`);
    }
    if (!Number.isFinite(primary?.coverage) || primary.coverage < settings.minimumCoverage) {
        reasons.push(`Primary-model coverage must reach ${Math.round(settings.minimumCoverage * 100)}%.`);
    }
    if ((primary?.calibrationObservations || 0) < settings.minimumTotalObservations
        || !Number.isFinite(primary?.calibrationError)
        || primary.calibrationError > settings.maximumCalibrationError) {
        reasons.push("Primary confidence is not yet calibrated well enough for exposure.");
    }
    if (!Number.isFinite(study.predictionP95Ms)
        || study.predictionP95Ms > settings.maximumPredictionP95Ms) {
        reasons.push(`Prediction p95 must remain at or below ${settings.maximumPredictionP95Ms} ms.`);
    }

    return {
        ready: reasons.length === 0,
        automaticUiChange: false,
        primaryModel: SHADOW_MODEL_VERSIONS.bayesDomain,
        baselineModels: [SHADOW_MODEL_VERSIONS.mru, SHADOW_MODEL_VERSIONS.frecency],
        winningWindows,
        requiredWinningWindows: settings.requiredWinningWindows,
        minimumWindowObservations: settings.minimumWindowObservations,
        hitMetric: hitMetric(settings),
        reasons
    };
}

const GATE_HIT_METRICS = new Set(["hit1", "hit3", "hit4"]);

function hitMetric(settings) {
    return GATE_HIT_METRICS.has(settings?.exposureHitMetric) ? settings.exposureHitMetric : "hit3";
}

function hitMetricLabel(settings) {
    return `top-${hitMetric(settings).slice(3)}`;
}

function windowBeatsBaselines(primaryWindow, mru, frecency, settings) {
    if (primaryWindow.observations < settings.minimumWindowObservations) return false;
    const mruWindow = mru?.windows.find(window => window.windowStart === primaryWindow.windowStart);
    const frecencyWindow = frecency?.windows.find(window => window.windowStart === primaryWindow.windowStart);
    if (!mruWindow || !frecencyWindow) return false;
    if (mruWindow.observations < settings.minimumWindowObservations
        || frecencyWindow.observations < settings.minimumWindowObservations) return false;
    const metric = hitMetric(settings);
    return primaryWindow[metric] > mruWindow[metric]
        && primaryWindow.mrr > mruWindow.mrr
        && primaryWindow[metric] > frecencyWindow[metric]
        && primaryWindow.mrr > frecencyWindow.mrr;
}

function countEvaluationWindows(models) {
    const windows = new Set();
    for (const model of models) {
        for (const window of model.windows || []) windows.add(window.windowStart);
    }
    return windows.size;
}

function sanitizeCensorReason(record) {
    const requested = safeLabel(record?.censorReason);
    if (CENSOR_REASONS.has(requested)) return requested;
    return record?.censored ? "unspecified" : "";
}

function safeDestinationClass(value) {
    const requested = safeLabel(value);
    return DESTINATION_CLASSES.has(requested) ? requested : "unknown";
}

function openTabBand(openTabCount) {
    const count = boundedInteger(openTabCount, 0, MAX_CANDIDATES + 1);
    if (count <= 5) return "2-5";
    if (count <= 10) return "6-10";
    if (count <= 25) return "11-25";
    if (count <= 50) return "26-50";
    return "51+";
}

function sessionAgeBand(ageMs) {
    const age = boundedInteger(ageMs, 0, 30 * 24 * 60 * 60 * 1000);
    if (age < 15 * 60 * 1000) return "under-15m";
    if (age < 60 * 60 * 1000) return "15-60m";
    if (age < 4 * 60 * 60 * 1000) return "1-4h";
    return "4h+";
}

function evaluationWindowStart(timestamp, windowMs) {
    const safeWindow = Math.max(1, Number(windowMs) || RANKING_STUDY_DEFAULTS.evaluationWindowMs);
    return Math.floor(Number(timestamp || 0) / safeWindow) * safeWindow;
}

function safeTabIds(values, limit = 10) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(value => boundedInteger(value, 1, Number.MAX_SAFE_INTEGER))
        .filter(Boolean))]
        .slice(0, Math.max(0, limit));
}

function sameIntegerSet(left, right) {
    if (left.length !== right.length) return false;
    const rightSet = new Set(right);
    return left.every(value => rightSet.has(value));
}

function safeLabel(value) {
    const label = String(value || "").replace(/[^a-z0-9._+-]/gi, "").slice(0, 80);
    return label || "";
}

function safeBand(value) {
    return safeLabel(value).slice(0, 32);
}

function boundedInteger(value, min, max) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : 0;
}

function boundedNumber(value, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : 0;
}

function boundedProbability(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : null;
}

function ratio(numerator, denominator) {
    return denominator > 0 ? numerator / denominator : null;
}

function difference(left, right) {
    return Number.isFinite(left) && Number.isFinite(right) ? left - right : null;
}


async function removeKey(storage, key) {
    if (!storage) return;
    if (typeof storage.remove === "function") await storage.remove(key);
    else if (typeof storage.set === "function") await storage.set({ [key]: undefined });
}
