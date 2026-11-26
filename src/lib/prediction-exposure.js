import { learnedCombinerScores, withFittedProbabilities } from "./learned-combiner.js";
import { LEARNED_COMBINER_FULL_V1 } from "./learned-combiner-weights.js";
import { SHADOW_MODEL_VERSIONS, rankBy } from "./shadow-ranking.js";

// Exposure experiment for the next-tab model. Plan and success rules:
// docs/PREDICTION_EXPOSURE_PLAN.md. The shadow study keeps judging the model on
// unexposed choices only; this store measures what showing it does.

export const PREDICTION_EXPOSURE_SETTING_KEY = "tabtopiaPredictionExposureEnabledV1";
export const PREDICTION_EXPOSURE_STORE_KEY = "tabtopiaPredictionExposureV1";
export const PREDICTION_EXPOSURE_COHORT = "prediction-exposure-v1";
export const PREDICTION_MODEL_VERSION = SHADOW_MODEL_VERSIONS.learnedCombinerFull;

// Below 0.4 the top candidate was right 22-33% of the time on held-out rows;
// from 0.4 up it was right 46-69%. Probabilities above 0.6 run hot, so the UI
// names a threshold, never a percentage.
export const LIKELY_NEXT_THRESHOLD = 0.4;
export const TREATMENT_SHARE = 0.8;
// A qualified access needs two seconds of dwell; thirty leaves room for a
// slow window focus without crediting an unrelated later switch.
export const EXPOSED_ACTIVATION_WINDOW_MS = 30 * 1000;

const SURFACES = new Set(["omnibox", "home"]);
const ARMS = new Set(["treatment", "control"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;
const CELL_FIELDS = ["impressions", "labeled", "selections", "labeledSelections", "top1Selections",
    "reciprocalRank", "refinements", "abandonments"];

/**
 * Rank open tabs with the gated model. Same features and tie-breaks as the
 * shadow study's learned-combiner-full-v1, so what the surface shows is what
 * the study measured.
 */
export function predictLikelyTabs(candidates, { currentTabId = null } = {}) {
    const list = (Array.isArray(candidates) ? candidates : [])
        .filter(candidate => Number.isFinite(Number(candidate?.tabId)));
    const current = list.find(candidate => candidate.tabId === currentTabId) || null;
    const eligible = list.filter(candidate => candidate.tabId !== currentTabId);
    const scores = learnedCombinerScores(eligible, current, LEARNED_COMBINER_FULL_V1);
    const ranked = withFittedProbabilities(
        rankBy(eligible, candidate => scores.get(candidate.tabId), { identityResolution: "tab" }),
        scores
    );
    const probabilities = Array.isArray(ranked.probabilities) ? ranked.probabilities : [];
    const topProbability = Number.isFinite(probabilities[0]) ? probabilities[0] : 0;
    return {
        modelVersion: PREDICTION_MODEL_VERSION,
        tabIds: ranked.predictedTabIds || [],
        probabilities,
        topProbability,
        labeled: topProbability >= LIKELY_NEXT_THRESHOLD
    };
}

export function assignArm(random = Math.random) {
    const draw = Number(random());
    const treatment = Number.isFinite(draw) ? draw < TREATMENT_SHARE : true;
    return treatment
        ? { arm: "treatment", propensity: TREATMENT_SHARE }
        : { arm: "control", propensity: 1 - TREATMENT_SHARE };
}

/** Stable reorder: items in `tabIds` order first, everything else after in its original order. */
export function orderByTabIds(items, tabIds) {
    const position = new Map((Array.isArray(tabIds) ? tabIds : []).map((tabId, index) => [tabId, index]));
    return (Array.isArray(items) ? items : [])
        .map((item, index) => ({ item, index, rank: position.has(item?.tabId) ? position.get(item.tabId) : Infinity }))
        .sort((left, right) => (left.rank - right.rank) || (left.index - right.index))
        .map(entry => entry.item);
}

/**
 * Local, content-free daily counts per surface and arm. No tab ids, URLs or
 * titles are stored. Writes only while ranking diagnostics are enabled; the
 * background passes that check in, so one switch governs all measurement.
 */
export class PredictionExposureStore {
    constructor(localStorage, { now = Date.now } = {}) {
        this.localStorage = localStorage;
        this.now = now;
        this.exposureEnabled = false;
        this.ready = false;
        this.writeChain = Promise.resolve();
        this.exposedActivation = null;
    }

    async init({ installType } = {}) {
        const saved = await this.localStorage.get([PREDICTION_EXPOSURE_SETTING_KEY]);
        if (typeof saved[PREDICTION_EXPOSURE_SETTING_KEY] === "boolean") {
            this.exposureEnabled = saved[PREDICTION_EXPOSURE_SETTING_KEY];
        } else {
            // Gated on one development profile's data; other installs opt in.
            this.exposureEnabled = installType === "development";
            await this.localStorage.set({ [PREDICTION_EXPOSURE_SETTING_KEY]: this.exposureEnabled });
        }
        this.ready = true;
        return this;
    }

    isExposureEnabled() {
        return this.ready && this.exposureEnabled;
    }

    async setExposureEnabled(enabled) {
        this.exposureEnabled = Boolean(enabled);
        this.ready = true;
        this.exposedActivation = null;
        await this.localStorage.set({ [PREDICTION_EXPOSURE_SETTING_KEY]: this.exposureEnabled });
        return this.exposureEnabled;
    }

    recordImpression({ surface, arm, labeled }) {
        return this.increment(surface, arm, cell => {
            cell.impressions += 1;
            if (labeled) cell.labeled += 1;
        });
    }

    recordSelection({ surface, arm, displayedRank, labeled }) {
        const rank = Number(displayedRank);
        if (!Number.isInteger(rank) || rank < 1) return Promise.resolve(false);
        return this.increment(surface, arm, cell => {
            cell.selections += 1;
            cell.reciprocalRank += 1 / rank;
            if (rank === 1) cell.top1Selections += 1;
            if (labeled && rank === 1) cell.labeledSelections += 1;
        });
    }

    recordRefinement({ surface, arm }) {
        return this.increment(surface, arm, cell => { cell.refinements += 1; });
    }

    recordAbandonment({ surface, arm }) {
        return this.increment(surface, arm, cell => { cell.abandonments += 1; });
    }

    /** Remember that `tabId` was chosen from a shown prediction (either arm). */
    markExposedActivation(tabId, now = this.now()) {
        const id = Number(tabId);
        this.exposedActivation = Number.isInteger(id) && id > 0 ? { tabId: id, at: now } : null;
    }

    /** True once if the qualified access of `tabId` follows a prediction choice. */
    consumeExposedActivation(tabId, now = this.now()) {
        const mark = this.exposedActivation;
        if (!mark || mark.tabId !== Number(tabId)) return false;
        this.exposedActivation = null;
        return now - mark.at >= 0 && now - mark.at <= EXPOSED_ACTIVATION_WINDOW_MS;
    }

    increment(surface, arm, update) {
        if (!SURFACES.has(surface) || !ARMS.has(arm)) return Promise.resolve(false);
        const day = Math.floor(this.now() / DAY_MS);
        this.writeChain = this.writeChain.catch(() => {}).then(async () => {
            const saved = await this.localStorage.get([PREDICTION_EXPOSURE_STORE_KEY]);
            const days = retainedDays(saved[PREDICTION_EXPOSURE_STORE_KEY], day);
            let entry = days.find(item => item.day === day);
            if (!entry) {
                entry = { day, cohort: PREDICTION_EXPOSURE_COHORT, modelVersion: PREDICTION_MODEL_VERSION, cells: {} };
                days.push(entry);
            }
            const key = `${surface}:${arm}`;
            const cell = decodeCell(entry.cells[key]);
            update(cell);
            entry.cells[key] = encodeCell(cell);
            await this.localStorage.set({ [PREDICTION_EXPOSURE_STORE_KEY]: days.sort((a, b) => a.day - b.day) });
            return true;
        });
        return this.writeChain;
    }

    async getSummary({ windowDays = 7 } = {}) {
        await this.writeChain.catch(() => {});
        const today = Math.floor(this.now() / DAY_MS);
        const saved = await this.localStorage.get([PREDICTION_EXPOSURE_STORE_KEY]);
        return summarizeExposureDays(retainedDays(saved[PREDICTION_EXPOSURE_STORE_KEY], today), {
            today, windowDays, exposureEnabled: this.isExposureEnabled()
        });
    }

    async clear() {
        this.exposedActivation = null;
        await this.writeChain.catch(() => {});
        this.writeChain = Promise.resolve();
        if (typeof this.localStorage.remove === "function") {
            await this.localStorage.remove(PREDICTION_EXPOSURE_STORE_KEY);
        } else {
            await this.localStorage.set({ [PREDICTION_EXPOSURE_STORE_KEY]: undefined });
        }
    }
}

export function summarizeExposureDays(days, { today, windowDays = 7, exposureEnabled = false } = {}) {
    const cells = new Map();
    const windows = new Map();
    let firstDay = null;
    for (const entry of Array.isArray(days) ? days : []) {
        if (entry?.cohort !== PREDICTION_EXPOSURE_COHORT) continue;
        firstDay = firstDay === null ? entry.day : Math.min(firstDay, entry.day);
        for (const [key, raw] of Object.entries(entry.cells || {})) {
            const cell = decodeCell(raw);
            addCell(cells, key, cell);
            const windowIndex = Math.floor((today - entry.day) / windowDays);
            addCell(windows, `${windowIndex}|${key}`, cell);
        }
    }
    const finalize = (key, cell) => {
        const [surface, arm] = key.split(":");
        return {
            surface, arm, ...cell,
            selectionRate: ratio(cell.selections, cell.impressions),
            meanReciprocalRank: ratio(cell.reciprocalRank, cell.selections),
            // Reciprocal rank per impression: a choice at rank 1 scores 1, no
            // choice scores 0. The plan's primary metric.
            reciprocalRankPerImpression: ratio(cell.reciprocalRank, cell.impressions),
            abandonmentRate: ratio(cell.abandonments, cell.impressions)
        };
    };
    return {
        cohort: PREDICTION_EXPOSURE_COHORT,
        modelVersion: PREDICTION_MODEL_VERSION,
        exposureEnabled,
        firstDay,
        treatmentShare: TREATMENT_SHARE,
        likelyNextThreshold: LIKELY_NEXT_THRESHOLD,
        arms: [...cells].map(([key, cell]) => finalize(key, cell))
            .sort((a, b) => a.surface.localeCompare(b.surface) || b.arm.localeCompare(a.arm)),
        windows: [...windows].map(([compound, cell]) => {
            const [windowIndex, key] = compound.split("|");
            return { windowsAgo: Number(windowIndex), ...finalize(key, cell) };
        }).sort((a, b) => a.windowsAgo - b.windowsAgo || a.surface.localeCompare(b.surface) || b.arm.localeCompare(a.arm))
    };
}

function retainedDays(value, today) {
    return (Array.isArray(value) ? value : [])
        .filter(entry => entry?.cohort === PREDICTION_EXPOSURE_COHORT
            && Number.isInteger(entry.day) && entry.day <= today && entry.day > today - RETENTION_DAYS
            && entry.cells && typeof entry.cells === "object");
}

function addCell(map, key, cell) {
    const current = map.get(key) || decodeCell(null);
    for (const field of CELL_FIELDS) current[field] += cell[field];
    map.set(key, current);
}

function decodeCell(raw) {
    const values = Array.isArray(raw) ? raw : [];
    return Object.fromEntries(CELL_FIELDS.map((field, index) => {
        const value = Number(values[index]);
        return [field, Number.isFinite(value) && value >= 0 ? value : 0];
    }));
}

function encodeCell(cell) {
    return CELL_FIELDS.map(field => cell[field]);
}

function ratio(numerator, denominator) {
    return denominator > 0 ? numerator / denominator : null;
}
