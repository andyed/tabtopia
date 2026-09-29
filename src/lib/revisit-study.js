import { normalizeIdentity } from "./revisit-model.js";

export const REVISIT_STUDY_KEY = "tabtopiaRevisitStudyV1";
export const REVISIT_STUDY_COHORT = "page-return-opportunities-v1";
export const REVISIT_HORIZONS = Object.freeze([10, 50, 200]);
const DAY = 86400000;
const RETENTION_DAYS = 90;
const MAX_HISTORY = 2000;
const MAX_DETAILS = 1000;
const MODELS = ["base-rate-v1", "history-bucket-v1"];
const hashKey = key => typeof key === "string" && /^[A-Za-z0-9_+/=-]{16,128}$/.test(key);
const ratio = (n, d) => d ? n / d : null;
const fresh = () => ({ version: 1, sequence: 0, lastKey: "", lastAt: 0,
    history: {}, pending: [], days: [], details: [] });

/**
 * Does a qualified page access recur within the next N qualified page accesses?
 * Every anchor gets predictions BEFORE its future is observed. Labels mature
 * at the horizon, including positives, so quick returns do not train earlier
 * than negatives. Browser idle time never manufactures a negative.
 *
 * Durable identities are installation-local, purpose-separated HMACs. Reports
 * contain no identities, URLs, titles, queries, embeddings, or conversation text.
 */
export class RevisitStudy {
    constructor(storage, { digest, isEnabled = () => false, now = Date.now } = {}) {
        this.storage = storage;
        this.digest = digest;
        this.isEnabled = isEnabled;
        this.now = now;
        this.chain = Promise.resolve();
        this.generation = 0;
    }

    serialize(operation) {
        const generation = this.generation;
        const run = this.chain.catch(() => {}).then(async () => {
            if (!this.isEnabled() || generation !== this.generation) return false;
            return operation(() => this.isEnabled() && generation === this.generation);
        });
        this.chain = run;
        return run;
    }

    async load() {
        const saved = (await this.storage.get([REVISIT_STUDY_KEY]))[REVISIT_STUDY_KEY];
        return saved?.version === 1 ? structuredClone(saved) : fresh();
    }

    recordAccess({ url, qualifiedDwellMs = 0, focused = false, incognito = false } = {}) {
        return this.serialize(async valid => {
            const identity = normalizeIdentity(url);
            if (!identity || incognito || !focused || qualifiedDwellMs < 2000) return false;
            const key = await this.digest(`revisit-study-v1:${identity.page}`);
            if (!hashKey(key) || !valid()) return false;
            const state = await this.load();
            const now = this.now();
            // Refocus, duplicate load callbacks and reloads are not departures.
            // Identity deliberately ignores fragments, but preserves page queries.
            if (now < state.lastAt) return false;
            prune(state, now);
            if (key === state.lastKey) return false;
            state.sequence += 1;
            state.lastAt = now;
            const day = dayBucket(state, now);
            day.accesses += 1;
            if (state.history[key]) day.seenBefore += 1;

            for (const anchor of state.pending) {
                const distance = state.sequence - anchor.sequence;
                if (anchor.key === key && !anchor.returnDistance) anchor.returnDistance = distance;
                for (const horizon of REVISIT_HORIZONS) {
                    if (distance !== horizon) continue;
                    const label = anchor.returnDistance > 0 && anchor.returnDistance <= horizon ? 1 : 0;
                    settle(day, horizon, anchor, label);
                    state.details.push({ timestamp: now, anchorAt: anchor.timestamp, horizon, label,
                        bucket: anchor.bucket, probabilities: anchor.predictions[horizon] });
                }
            }
            state.pending = state.pending.filter(anchor => state.sequence - anchor.sequence < REVISIT_HORIZONS.at(-1));

            // Predict with only matured observations, never current/future labels.
            const previous = state.history[key];
            const bucket = featureBucket(previous, state.sequence);
            const predictions = Object.fromEntries(REVISIT_HORIZONS.map(horizon => {
                const { total, positive, bucketTotal, bucketPositive } = trainingCounts(state, horizon, bucket);
                const base = (positive + 1) / (total + 2);
                const history = (bucketPositive + 20 * base) / (bucketTotal + 20);
                return [horizon, [base, history]];
            }));
            state.pending.push({ key, sequence: state.sequence, timestamp: now, bucket, predictions, returnDistance: 0 });
            state.history[key] = { visits: Math.min(1000000, (previous?.visits || 0) + 1),
                lastSequence: state.sequence, lastAt: now };
            state.lastKey = key;
            prune(state, now);
            if (!valid()) return false;
            await this.storage.set({ [REVISIT_STUDY_KEY]: state });
            return true;
        });
    }

    getSummary() {
        return this.serialize(async valid => {
            const state = await this.load();
            prune(state, this.now());
            // Expiry and censoring are persisted together; repeated reads do not
            // recount expired anchors and a worker restart sees the same state.
            if (!valid()) return false;
            await this.storage.set({ [REVISIT_STUDY_KEY]: state });
            return summarizeRevisitStudy(state);
        });
    }

    async clear() {
        this.generation += 1;
        await this.chain.catch(() => {});
        await this.storage.remove(REVISIT_STUDY_KEY);
    }
}

function featureBucket(history, sequence) {
    const visits = history?.visits || 0;
    const frequency = visits === 0 ? "first" : visits === 1 ? "once" : visits < 5 ? "2-4" : "5+";
    const gap = history ? sequence - history.lastSequence : Infinity;
    const recency = gap <= 10 ? "near" : gap <= 50 ? "recent" : "distant";
    return `${frequency}/${recency}`;
}

function trainingCounts(state, horizon, bucket) {
    let total = 0, positive = 0, bucketTotal = 0, bucketPositive = 0;
    for (const day of state.days) {
        const data = day.horizons[horizon];
        if (!data) continue;
        total += data.total; positive += data.positive;
        bucketTotal += data.buckets[bucket]?.[0] || 0;
        bucketPositive += data.buckets[bucket]?.[1] || 0;
    }
    return { total, positive, bucketTotal, bucketPositive };
}

function dayBucket(state, now) {
    const date = Math.floor(now / DAY);
    let day = state.days.find(value => value.day === date);
    if (!day) {
        day = { day: date, accesses: 0, seenBefore: 0, censored: 0, horizons: {} };
        state.days.push(day);
    }
    return day;
}

function emptyModel() {
    return { n: 0, brier: 0, logLoss: 0, tp: 0, fp: 0, tn: 0, fn: 0,
        bins: Array.from({ length: 10 }, () => [0, 0, 0]) };
}

function settle(day, horizon, anchor, label) {
    const data = day.horizons[horizon] ||= { total: 0, positive: 0, buckets: {},
        models: Object.fromEntries(MODELS.map(model => [model, emptyModel()])) };
    data.total += 1; data.positive += label;
    const bucket = data.buckets[anchor.bucket] ||= [0, 0];
    bucket[0] += 1; bucket[1] += label;
    MODELS.forEach((name, index) => {
        const p = anchor.predictions[horizon][index];
        const model = data.models[name];
        model.n += 1; model.brier += (p - label) ** 2;
        model.logLoss -= Math.log(Math.max(1e-6, label ? p : 1 - p));
        model[p >= 0.5 ? (label ? "tp" : "fp") : (label ? "fn" : "tn")] += 1;
        const bin = model.bins[Math.min(9, Math.floor(p * 10))];
        bin[0] += 1; bin[1] += p; bin[2] += label;
    });
}

function prune(state, now) {
    const cutoff = now - RETENTION_DAYS * DAY;
    const today = Math.floor(now / DAY);
    const expired = state.pending.filter(anchor => anchor.timestamp < cutoff);
    if (expired.length) {
        // Count unresolved horizon labels, not negatives or lost predictions.
        dayBucket(state, now).censored += expired.reduce((sum, anchor) => sum
            + REVISIT_HORIZONS.filter(horizon => state.sequence - anchor.sequence < horizon).length, 0);
    }
    state.pending = state.pending.filter(anchor => anchor.timestamp >= cutoff);
    state.history = Object.fromEntries(Object.entries(state.history)
        .filter(([key, value]) => hashKey(key) && value.lastAt >= cutoff)
        .sort((a, b) => b[1].lastSequence - a[1].lastSequence).slice(0, MAX_HISTORY));
    state.details = state.details.filter(row => row.timestamp >= cutoff).slice(-MAX_DETAILS);
    state.days = state.days.filter(day => day.day <= today && day.day > today - RETENTION_DAYS);
}

export function summarizeRevisitStudy(state) {
    const days = state.days || [];
    return {
        cohort: REVISIT_STUDY_COHORT, shadowOnly: true, retentionDays: RETENTION_DAYS,
        retainedDays: days.length, qualifiedAccesses: days.reduce((n, day) => n + day.accesses, 0),
        seenBefore: days.reduce((n, day) => n + day.seenBefore, 0),
        censoredLabels: days.reduce((n, day) => n + day.censored, 0),
        pendingAnchors: state.pending.length,
        retainedDetails: state.details.length,
        horizons: REVISIT_HORIZONS.map(horizon => {
            const total = days.reduce((n, day) => n + (day.horizons[horizon]?.total || 0), 0);
            const positive = days.reduce((n, day) => n + (day.horizons[horizon]?.positive || 0), 0);
            const models = MODELS.map(name => {
                const aggregate = emptyModel();
                for (const day of days) {
                    const value = day.horizons[horizon]?.models[name];
                    if (!value) continue;
                    for (const key of ["n", "brier", "logLoss", "tp", "fp", "tn", "fn"]) aggregate[key] += value[key];
                    value.bins.forEach((bin, i) => bin.forEach((x, j) => { aggregate.bins[i][j] += x; }));
                }
                const calibrationError = ratio(aggregate.bins.reduce((n, bin) => n + Math.abs(bin[1] - bin[2]), 0), total);
                return { model: name, observations: total, brier: ratio(aggregate.brier, total),
                    logLoss: ratio(aggregate.logLoss, total), calibrationError,
                    precision: ratio(aggregate.tp, aggregate.tp + aggregate.fp),
                    recall: ratio(aggregate.tp, aggregate.tp + aggregate.fn),
                    balancedAccuracy: positive && total > positive
                        ? (aggregate.tp / positive + aggregate.tn / (total - positive)) / 2 : null };
            });
            return { horizon, resolved: total, returned: positive, noObservedReturn: total - positive,
                returnRate: ratio(positive, total),
                pending: state.pending.filter(anchor => state.sequence - anchor.sequence < horizon).length,
                models };
        })
    };
}
