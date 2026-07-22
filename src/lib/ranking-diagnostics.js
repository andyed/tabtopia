export const DIAGNOSTICS_SETTING_KEY = "tabtopiaRankingDiagnosticsEnabledV1";
export const DIAGNOSTICS_BUFFER_KEY = "tabtopiaRankingDiagnosticsV1";
export const DIAGNOSTICS_PENDING_KEY = "tabtopiaRankingDiagnosticsPendingV1";

const DEFAULT_MAX_RECORDS = 500;
const ALLOWED_EVENTS = new Set([
    "omnibox_selection",
    "omnibox_abandonment",
    "next_tab_outcome"
]);

/**
 * Local-only, bounded ranking diagnostics. Normal installs start disabled;
 * unpacked development installs start enabled. A persisted user choice always
 * wins over the install-type default.
 */
export class RankingDiagnostics {
    constructor(localStorage, sessionStorage = null, {
        maxRecords = DEFAULT_MAX_RECORDS,
        flushDelayMs = 1000
    } = {}) {
        this.localStorage = localStorage;
        this.sessionStorage = sessionStorage;
        this.maxRecords = maxRecords;
        this.flushDelayMs = flushDelayMs;
        this.enabled = false;
        this.ready = false;
        this.pendingRecords = [];
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
        if (!this.enabled) await this.clear();
        return this.enabled;
    }

    record(rawRecord) {
        if (!this.isEnabled()) return false;
        const record = sanitizeRecord(rawRecord);
        if (!record) return false;
        this.pendingRecords.push(record);
        this.scheduleFlush();
        return true;
    }

    scheduleFlush() {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush().catch(error => console.warn("[RankingDiagnostics] flush failed", error));
        }, this.flushDelayMs);
    }

    async flush() {
        if (!this.isEnabled() || this.pendingRecords.length === 0) return;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        const records = this.pendingRecords.splice(0);
        this.flushChain = this.flushChain.then(async () => {
            const saved = await this.localStorage.get([DIAGNOSTICS_BUFFER_KEY]);
            const existing = Array.isArray(saved[DIAGNOSTICS_BUFFER_KEY])
                ? saved[DIAGNOSTICS_BUFFER_KEY]
                : [];
            await this.localStorage.set({
                [DIAGNOSTICS_BUFFER_KEY]: [...existing, ...records].slice(-this.maxRecords)
            });
        });
        await this.flushChain;
    }

    async clear() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.pendingRecords = [];
        await this.flushChain.catch(() => {});
        await Promise.all([
            removeKey(this.localStorage, DIAGNOSTICS_BUFFER_KEY),
            removeKey(this.sessionStorage, DIAGNOSTICS_PENDING_KEY)
        ]);
    }

    async getRecords() {
        if (!this.isEnabled()) return [];
        await this.flush();
        const saved = await this.localStorage.get([DIAGNOSTICS_BUFFER_KEY]);
        return Array.isArray(saved[DIAGNOSTICS_BUFFER_KEY])
            ? saved[DIAGNOSTICS_BUFFER_KEY]
            : [];
    }

    async takePendingPrediction(actualTabId, qualifiedDwellMs) {
        if (!this.isEnabled() || !this.sessionStorage) return null;
        const saved = await this.sessionStorage.get([DIAGNOSTICS_PENDING_KEY]);
        const pending = saved[DIAGNOSTICS_PENDING_KEY];
        await removeKey(this.sessionStorage, DIAGNOSTICS_PENDING_KEY);
        if (!pending || !Number.isFinite(actualTabId)) return null;

        const records = [];
        for (const [modelVersion, predictedTabIds] of Object.entries(pending.models || {})) {
            const record = sanitizeRecord({
                event: "next_tab_outcome",
                timestamp: Date.now(),
                modelVersion,
                candidateCount: pending.candidateCount,
                predictedTabIds,
                actualTabId,
                qualifiedDwellMs
            });
            if (record) records.push(record);
        }
        return records;
    }

    async setPendingPrediction(prediction) {
        if (!this.isEnabled() || !this.sessionStorage) return false;
        const candidateCount = boundedInteger(prediction?.candidateCount, 0, 100000);
        const models = {};
        for (const [version, tabIds] of Object.entries(prediction?.models || {})) {
            const safeVersion = safeLabel(version);
            if (!safeVersion) continue;
            models[safeVersion] = safeTabIds(tabIds);
        }
        await this.sessionStorage.set({
            [DIAGNOSTICS_PENDING_KEY]: {
                timestamp: Date.now(),
                candidateCount,
                models
            }
        });
        return true;
    }
}

export function summarizeRankingDiagnostics(records) {
    const outcomes = new Map();
    let selections = 0;
    let abandonments = 0;

    for (const record of Array.isArray(records) ? records : []) {
        if (record?.event === "omnibox_selection") selections += 1;
        if (record?.event === "omnibox_abandonment") abandonments += 1;
        if (record?.event !== "next_tab_outcome") continue;

        const version = safeLabel(record.modelVersion);
        if (!version) continue;
        const ranks = safeTabIds(record.predictedTabIds);
        const actual = boundedInteger(record.actualTabId, 1, Number.MAX_SAFE_INTEGER);
        const rank = ranks.indexOf(actual) + 1;
        const model = outcomes.get(version) || {
            modelVersion: version,
            observations: 0,
            hit1: 0,
            hit3: 0,
            hit4: 0,
            reciprocalRank: 0
        };
        model.observations += 1;
        if (rank === 1) model.hit1 += 1;
        if (rank > 0 && rank <= 3) model.hit3 += 1;
        if (rank > 0 && rank <= 4) model.hit4 += 1;
        if (rank > 0) model.reciprocalRank += 1 / rank;
        outcomes.set(version, model);
    }

    return {
        records: Array.isArray(records) ? records.length : 0,
        selections,
        abandonments,
        models: [...outcomes.values()].map(model => ({
            modelVersion: model.modelVersion,
            observations: model.observations,
            hit1: model.hit1 / model.observations,
            hit3: model.hit3 / model.observations,
            hit4: model.hit4 / model.observations,
            mrr: model.reciprocalRank / model.observations
        }))
    };
}

function sanitizeRecord(record) {
    if (!record || !ALLOWED_EVENTS.has(record.event)) return null;
    const common = {
        event: record.event,
        timestamp: boundedInteger(record.timestamp || Date.now(), 0, Number.MAX_SAFE_INTEGER)
    };

    if (record.event === "next_tab_outcome") {
        const modelVersion = safeLabel(record.modelVersion);
        const actualTabId = boundedInteger(record.actualTabId, 1, Number.MAX_SAFE_INTEGER);
        if (!modelVersion || !actualTabId) return null;
        return {
            ...common,
            modelVersion,
            candidateCount: boundedInteger(record.candidateCount, 0, 100000),
            predictedTabIds: safeTabIds(record.predictedTabIds),
            actualTabId,
            qualifiedDwellMs: boundedInteger(record.qualifiedDwellMs, 0, 3600000)
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

function safeTabIds(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(value => boundedInteger(value, 1, Number.MAX_SAFE_INTEGER))
        .filter(Boolean))]
        .slice(0, 10);
}

function safeLabel(value) {
    const label = String(value || "").replace(/[^a-z0-9._-]/gi, "").slice(0, 80);
    return label || "";
}

function boundedInteger(value, min, max) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : 0;
}

function boundedNumber(value, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : 0;
}

async function removeKey(storage, key) {
    if (!storage) return;
    if (typeof storage.remove === "function") await storage.remove(key);
    else if (typeof storage.set === "function") await storage.set({ [key]: undefined });
}
