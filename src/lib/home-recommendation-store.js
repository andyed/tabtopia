/** Opt-in, local Home experiment. Raw identities occur only in session storage. */
export const HOME_RECOMMENDATION_COHORT = "home-recs-v2";
export const HOME_RECOMMENDATION_KEY = "tabtopiaHomeRecommendationStudyV2";
export const HOME_RECOMMENDATION_SESSION_KEY = "tabtopiaHomeRecommendationPendingV2";
export const HOME_RECOMMENDATION_SNOOZE_KEY = "tabtopiaHomeRecommendationSnoozesV2";
const DAY = 86400000;
const MAX_AGE = 30 * 60000;
const ARMS = ["balanced", "explore"];
const COUNTS = ["impressions", "exposures", "clicks", "engaged", "bounces", "snoozes"];
const emptyCounts = () => Object.fromEntries(COUNTS.map(key => [key, 0]));
const armOf = value => ARMS.includes(value) ? value : "balanced";
const safeId = value => typeof value === "string" && value.length > 0 && value.length <= 8192 ? value : "";
const safeRank = value => Number.isInteger(value) && value > 0 && value <= 100 ? value : 0;
const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
const hashKey = value => typeof value === "string" && /^[A-Za-z0-9_+/=-]{16,128}$/.test(value);

export class HomeRecommendationStore {
    constructor(local, session, { isEnabled = () => false, digest, identityForUrl, now = Date.now } = {}) {
        this.local = local;
        this.session = session;
        this.isEnabled = isEnabled;
        this.digest = digest;
        this.identityForUrl = identityForUrl || (url => {
            try { const parsed = new URL(url); parsed.hash = ""; return parsed.href; } catch { return ""; }
        });
        this.now = now;
        this.chain = Promise.resolve();
        this.generation = 0;
        this.workerSessionId = globalThis.crypto?.randomUUID?.() || String(Math.random());
    }

    identity(url) {
        try {
            const parsed = new URL(url);
            if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
            const result = this.identityForUrl(url);
            return safeId(typeof result === "string" ? result : result?.page);
        } catch { return ""; }
    }

    async key(identity) {
        if (!safeId(identity) || typeof this.digest !== "function") return "";
        const key = await this.digest(`home-recommendation-feedback-v2:${identity}`);
        return hashKey(key) ? key : "";
    }

    serialize(operation, { preference = false } = {}) {
        const generation = this.generation;
        const run = this.chain.catch(() => {}).then(async () => {
            if (generation !== this.generation || (!preference && !this.isEnabled())) return false;
            return operation(() => generation === this.generation && (preference || this.isEnabled()));
        });
        this.chain = run;
        return run;
    }

    cleanState(raw = {}) {
        const earliest = new Date(this.now() - 27 * DAY).toISOString().slice(0, 10);
        const today = new Date(this.now()).toISOString().slice(0, 10);
        const days = (Array.isArray(raw.days) ? raw.days : []).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day.day) && day.day >= earliest && day.day <= today).slice(-28).map(day => ({
            day: day.day, arms: Object.fromEntries(ARMS.map(arm => [arm,
                Object.fromEntries(COUNTS.map(key => [key, number(day.arms?.[arm]?.[key])]))]))
        }));
        const feedback = Object.fromEntries(Object.entries(raw.feedback || {}).filter(([key]) => hashKey(key))
            .map(([key, value]) => {
                const days = (Array.isArray(value.days) ? value.days : []).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day.day)
                    && day.day >= earliest && day.day <= today).slice(-28).map(day => ({ day: day.day,
                    impressions: number(day.impressions), engaged: number(day.engaged),
                    lastShownAt: number(day.lastShownAt), lastEngagedAt: number(day.lastEngagedAt) }));
                return [key, { days, impressions: days.reduce((sum, day) => sum + day.impressions, 0),
                    engaged: days.reduce((sum, day) => sum + day.engaged, 0),
                    lastShownAt: Math.max(0, ...days.map(day => day.lastShownAt)),
                    lastEngagedAt: Math.max(0, ...days.map(day => day.lastEngagedAt)) }];
            }).filter(([, value]) => value.days.length)
            .sort((a, b) => Math.max(b[1].lastShownAt, b[1].lastEngagedAt) - Math.max(a[1].lastShownAt, a[1].lastEngagedAt)).slice(0, 2000));
        const details = (Array.isArray(raw.details) ? raw.details : []).filter(row => row.timestamp >= this.now() - 28 * DAY
            && row.timestamp <= this.now() && [...COUNTS, "expired"].includes(row.event)).slice(-500).map(row => ({
            cohort: HOME_RECOMMENDATION_COHORT, timestamp: number(row.timestamp), arm: armOf(row.arm),
            event: row.event, rank: safeRank(row.rank), count: number(row.count)
        }));
        return { version: 2, days, feedback, details };
    }

    async state() {
        const saved = await this.local.get(HOME_RECOMMENDATION_KEY);
        return this.cleanState(saved[HOME_RECOMMENDATION_KEY]);
    }

    async pending() {
        const saved = await this.session.get(HOME_RECOMMENDATION_SESSION_KEY);
        const state = saved[HOME_RECOMMENDATION_SESSION_KEY] || { impressions: [], choice: null };
        state.impressions = (state.impressions || []).filter(item => item.timestamp > this.now() - MAX_AGE).slice(-64);
        if (state.choice?.timestamp <= this.now() - MAX_AGE) state.choice = null;
        return state;
    }

    event(state, arm, event, rank = 0, count = 1) {
        const day = new Date(this.now()).toISOString().slice(0, 10);
        let bucket = state.days.find(item => item.day === day);
        if (!bucket) { bucket = { day, arms: Object.fromEntries(ARMS.map(key => [key, emptyCounts()])) }; state.days.push(bucket); }
        if (COUNTS.includes(event)) bucket.arms[armOf(arm)][event] += count;
        state.details.push({ cohort: HOME_RECOMMENDATION_COHORT, timestamp: this.now(), arm: armOf(arm), event, rank, count });
        state.details = state.details.slice(-500);
    }

    feedbackEvent(state, key, event) {
        const day = new Date(this.now()).toISOString().slice(0, 10);
        const feedback = state.feedback[key] ||= { days: [] };
        let bucket = feedback.days.find(item => item.day === day);
        if (!bucket) { bucket = { day, impressions: 0, engaged: 0, lastShownAt: 0, lastEngagedAt: 0 }; feedback.days.push(bucket); }
        bucket[event] += 1;
        bucket[event === "impressions" ? "lastShownAt" : "lastEngagedAt"] = this.now();
    }

    async save(state, pending, valid) {
        if (!valid()) return false;
        await this.local.set({ [HOME_RECOMMENDATION_KEY]: this.cleanState(state) });
        if (!valid()) return false;
        await this.session.set({ [HOME_RECOMMENDATION_SESSION_KEY]: pending });
        return true;
    }

    recordImpression({ impressionId, sourceTabId, candidates, arm }) {
        return this.serialize(async valid => {
            if (!safeId(impressionId) || impressionId.length > 160 || !Number.isInteger(sourceTabId)) return false;
            const state = await this.state(), pending = await this.pending();
            let impression = pending.impressions.find(item => item.id === impressionId && item.sourceTabId === sourceTabId);
            const isNew = !impression;
            impression ||= { id: impressionId, sourceTabId, arm: armOf(arm), timestamp: this.now(), candidates: [], clicked: [] };
            let count = 0;
            for (const item of (Array.isArray(candidates) ? candidates : []).slice(0, 24)) {
                const identity = this.identity(item.url), rank = safeRank(item.rank);
                if (!identity || (item.identity && item.identity !== identity) || !rank || impression.candidates.some(c => c.identity === identity || c.rank === rank)) continue;
                if (impression.candidates.length >= 24) break;
                const key = await this.key(identity);
                if (!key) continue;
                impression.candidates.push({ identity, url: item.url, rank });
                this.feedbackEvent(state, key, "impressions");
                this.event(state, impression.arm, "exposures", rank);
                count += 1;
            }
            if (!count) return false;
            if (isNew) { pending.impressions.push(impression); pending.impressions = pending.impressions.slice(-64); this.event(state, impression.arm, "impressions"); }
            return this.save(state, pending, valid);
        });
    }

    recordChoice({ impressionId, sourceTabId, url, rank, targetTabId }) {
        return this.serialize(async valid => {
            const state = await this.state(), pending = await this.pending();
            const impression = pending.impressions.find(item => item.id === impressionId && item.sourceTabId === sourceTabId);
            const identity = this.identity(url);
            const candidate = impression?.candidates.find(item => item.rank === rank && item.identity === identity);
            if (!candidate || impression.clicked.includes(rank)) return false;
            if (pending.choice?.focus) this.event(state, pending.choice.arm, "bounces", pending.choice.rank);
            impression.clicked.push(rank);
            pending.choice = { ...candidate, arm: impression.arm, impressionId, sourceTabId,
                expectedTabId: Number.isInteger(targetTabId) && targetTabId > 0 ? targetTabId : sourceTabId,
                timestamp: this.now(), focus: null };
            this.event(state, impression.arm, "clicks", rank);
            return this.save(state, pending, valid);
        });
    }

    /** Failed browser navigation must not arm a later unrelated natural visit. */
    cancelChoice({ impressionId, sourceTabId, rank }) {
        return this.serialize(async valid => {
            const state = await this.state(), pending = await this.pending();
            const choice = pending.choice;
            if (!choice || choice.impressionId !== impressionId || choice.sourceTabId !== sourceTabId || choice.rank !== rank) return false;
            pending.choice = null;
            const impression = pending.impressions.find(item => item.id === impressionId && item.sourceTabId === sourceTabId);
            // Retain the attempted click count; a genuine retry can create a new attempt.
            if (impression) impression.clicked = impression.clicked.filter(value => value !== rank);
            return this.save(state, pending, valid);
        });
    }

    /** Browser owner calls with verified foreground tab; null cancels continuous dwell. */
    updateFocus(access) {
        return this.serialize(async valid => {
            const state = await this.state(), pending = await this.pending();
            const choice = pending.choice;
            if (!choice) return null;
            const identity = access?.focused && this.identity(access.url);
            if (identity !== choice.identity || access?.tabId !== choice.expectedTabId) {
                if (!choice.focus) return null; // click has not reached its destination yet
                this.event(state, choice.arm, "bounces", choice.rank);
                pending.choice = null;
                await this.save(state, pending, valid);
                return null;
            }
            if (choice.focus && choice.focus.tabId !== access.tabId) {
                this.event(state, choice.arm, "bounces", choice.rank);
                pending.choice = null;
                await this.save(state, pending, valid);
                return null;
            }
            // A suspended/restarted worker cannot prove continuous foreground dwell.
            if (choice.focus?.workerSessionId !== this.workerSessionId) choice.focus = null;
            choice.focus ||= { tabId: access.tabId, startedAt: this.now(), workerSessionId: this.workerSessionId };
            const remainingMs = 10000 - (this.now() - choice.focus.startedAt);
            if (remainingMs <= 0) {
                const key = await this.key(choice.identity);
                if (key) {
                    this.feedbackEvent(state, key, "engaged");
                }
                this.event(state, choice.arm, "engaged", choice.rank);
                pending.choice = null;
                await this.save(state, pending, valid);
                return null;
            }
            await this.save(state, pending, valid);
            return valid() ? { remainingMs } : null;
        });
    }

    /** Explicit snooze is a preference, even while measurement is disabled. */
    snooze({ url, identity: supplied, durationMs = DAY }) {
        return this.serialize(async valid => {
            const identity = this.identity(url);
            if (!identity || (supplied && supplied !== identity)) return false;
            const key = await this.key(identity);
            if (!key) return false;
            const saved = await this.local.get(HOME_RECOMMENDATION_SNOOZE_KEY);
            const snoozes = Object.fromEntries(Object.entries(saved[HOME_RECOMMENDATION_SNOOZE_KEY] || {})
                .filter(([key, until]) => hashKey(key) && Number.isFinite(until) && until > this.now()).slice(-1999));
            if (durationMs > 0) snoozes[key] = this.now() + Math.min(28 * DAY, Math.max(60000, number(durationMs)));
            else delete snoozes[key];
            if (!valid()) return false;
            await this.local.set({ [HOME_RECOMMENDATION_SNOOZE_KEY]: snoozes });
            if (this.isEnabled() && durationMs > 0) {
                const state = await this.state(), pending = await this.pending();
                const impression = [...pending.impressions].reverse().find(item => item.candidates.some(c => c.identity === identity));
                this.event(state, impression?.arm || "balanced", "snoozes", impression?.candidates.find(c => c.identity === identity)?.rank || 0);
                await this.save(state, pending, valid);
            }
            return true;
        }, { preference: true });
    }

    async getFeedback({ identities = [] } = {}) {
        await this.chain.catch(() => {});
        const state = this.isEnabled() ? await this.state() : { feedback: {} };
        const saved = await this.local.get(HOME_RECOMMENDATION_SNOOZE_KEY);
        const snoozes = saved[HOME_RECOMMENDATION_SNOOZE_KEY] || {};
        const output = Object.create(null);
        const requested = [...new Set((Array.isArray(identities) ? identities : []).filter(safeId))].slice(0, 2000);
        const needsKeys = this.isEnabled() || Object.keys(snoozes).length > 0;
        for (let offset = 0; offset < requested.length; offset += 50) {
            await Promise.all(requested.slice(offset, offset + 50).map(async identity => {
                const key = needsKeys ? await this.key(identity) : "";
                const feedback = state.feedback[key];
                output[identity] = { impressions: feedback?.impressions || 0, lastShownAt: feedback?.lastShownAt || 0,
                    engaged: feedback?.engaged || 0, lastEngagedAt: feedback?.lastEngagedAt || 0,
                    snoozedUntil: snoozes[key] > this.now() ? snoozes[key] : 0 };
            }));
        }
        return output;
    }

    async summary() {
        await this.chain.catch(() => {});
        const state = this.isEnabled() ? await this.state() : this.cleanState();
        const arms = Object.fromEntries(ARMS.map(arm => [arm, emptyCounts()]));
        for (const day of state.days) for (const arm of ARMS) for (const key of COUNTS) arms[arm][key] += day.arms[arm][key];
        return { cohort: HOME_RECOMMENDATION_COHORT, enabled: this.isEnabled(), retentionDays: 28,
            arms, retainedDays: state.days.length, detailCount: state.details.length,
            from: state.days[0]?.day || null, to: state.days.at(-1)?.day || null };
    }

    clear() {
        this.generation += 1;
        const run = this.chain.catch(() => {}).then(() => Promise.all([
            this.local.remove(HOME_RECOMMENDATION_KEY), this.session.remove(HOME_RECOMMENDATION_SESSION_KEY)
        ]));
        this.chain = run;
        return run;
    }
}
