/** Local opt-in Home study. URLs and launcher IDs live only in storage.session. */
export const HOME_CONTEXT_COHORT = "home-context-v1";
export const HOME_CONTEXT_BUFFER_KEY = "tabtopiaHomeContextDiagnosticsV1";
export const HOME_CONTEXT_SESSION_KEY = "tabtopiaHomeContextPendingV1";
const MAX_AGE_MS = 30 * 60 * 1000;
const STATES = new Set(["ready", "empty", "unavailable", "loading", "stale",
    "launch", "threshold", "continuation", "reinstatement", "reorientation", "handoff"]);
const EVENTS = new Set(["impression", "click", "dismissal", "qualified_on_list", "off_list", "expired", "superseded"]);

function httpUrl(value) {
    if (typeof value !== "string" || value.length > 8192) return "";
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol)) return "";
        url.hash = "";
        return url.href;
    } catch { return ""; }
}
function rank(value) { return Number.isInteger(value) && value >= 1 && value <= 3 ? value : 0; }
function safeRecord(raw) {
    if (raw?.cohort !== HOME_CONTEXT_COHORT || !EVENTS.has(raw.event) || !Number.isFinite(raw.timestamp)) return null;
    return {
        cohort: HOME_CONTEXT_COHORT, timestamp: raw.timestamp, event: raw.event,
        state: STATES.has(raw.state) ? raw.state : "unavailable",
        rank: rank(raw.rank), candidateCount: Math.min(3, Math.max(0, Number(raw.candidateCount) || 0)),
        origin: raw.origin === "click" ? "click" : "navigation"
    };
}

export class HomeContextDiagnostics {
    constructor(localStorage, sessionStorage, { isEnabled = () => false, now = Date.now, maxRecords = 500 } = {}) {
        this.localStorage = localStorage;
        this.sessionStorage = sessionStorage;
        this.isEnabled = isEnabled;
        this.now = now;
        this.maxRecords = Math.max(1, Math.min(500, maxRecords));
        this.chain = Promise.resolve();
        this.generation = 0;
    }

    run(operation) {
        const generation = this.generation;
        const result = this.chain.catch(() => {}).then(async () => {
            if (generation !== this.generation || !this.isEnabled() || !this.sessionStorage) return false;
            const saved = await this.sessionStorage.get([HOME_CONTEXT_SESSION_KEY]);
            const session = saved[HOME_CONTEXT_SESSION_KEY] || { seen: [], pending: null };
            session.seen = (Array.isArray(session.seen) ? session.seen : [])
                .filter(item => item.at > this.now() - MAX_AGE_MS).slice(-128);
            const records = [];
            if (session.pending && this.now() >= session.pending.expiresAt) {
                records.push(this.event("expired", session.pending));
                session.pending = null;
            }
            const value = await operation(session, records);
            if (generation !== this.generation || !this.isEnabled()) return false;
            if (records.length) {
                const local = await this.localStorage.get([HOME_CONTEXT_BUFFER_KEY]);
                const existing = (Array.isArray(local[HOME_CONTEXT_BUFFER_KEY]) ? local[HOME_CONTEXT_BUFFER_KEY] : [])
                    .map(safeRecord).filter(Boolean);
                if (generation !== this.generation || !this.isEnabled()) return false;
                await this.localStorage.set({ [HOME_CONTEXT_BUFFER_KEY]: [...existing, ...records].slice(-this.maxRecords) });
            }
            await this.sessionStorage.set({ [HOME_CONTEXT_SESSION_KEY]: session });
            return value;
        });
        this.chain = result;
        return result;
    }

    event(event, pending, extra = {}) {
        return safeRecord({ cohort: HOME_CONTEXT_COHORT, timestamp: this.now(), event,
            state: pending.state, candidateCount: pending.candidates.length, ...extra });
    }

    recordImpression(raw, sourceTabId) {
        return this.run((session, records) => {
            const id = raw?.impressionId;
            if (typeof id !== "string" || !id || id.length > 160 || !Number.isInteger(sourceTabId) || sourceTabId < 1) return false;
            if (session.seen.some(item => item.id === id)) return false;
            const candidates = [];
            for (const candidate of (Array.isArray(raw.candidates) ? raw.candidates : []).slice(0, 3)) {
                const url = httpUrl(candidate?.url);
                const candidateRank = rank(candidate?.rank);
                if (url && candidateRank && !candidates.some(item => item.url === url || item.rank === candidateRank)) candidates.push({ url, rank: candidateRank });
            }
            if (!candidates.length) return false;
            const now = this.now();
            const contextGeneratedAt = Number.isFinite(raw.contextGeneratedAt) ? raw.contextGeneratedAt : now;
            const expiresAt = Math.min(now + MAX_AGE_MS, contextGeneratedAt + MAX_AGE_MS,
                Number.isFinite(raw.expiresAt) ? raw.expiresAt : now + MAX_AGE_MS);
            if (expiresAt <= now || contextGeneratedAt > now + 60000) return false;
            if (session.pending) records.push(this.event("superseded", session.pending));
            session.pending = { id, sourceTabId, candidates, state: STATES.has(raw.state) ? raw.state : "ready",
                timestamp: now, expiresAt, clicked: [], dismissed: [] };
            session.seen = [...session.seen, { id, at: now }].slice(-128);
            records.push(this.event("impression", session.pending));
            return true;
        });
    }

    recordChoice(raw, sourceTabId) {
        return this.run((session, records) => {
            const pending = session.pending;
            if (!pending || pending.id !== raw.impressionId || pending.sourceTabId !== sourceTabId) return false;
            const candidate = pending.candidates.find(item => item.rank === raw.rank && item.url === httpUrl(raw.url));
            if (!candidate || pending.clicked.includes(candidate.rank) || pending.dismissed.includes(candidate.rank)) return false;
            pending.clicked.push(candidate.rank);
            records.push(this.event("click", pending, { rank: candidate.rank, origin: "click" }));
            return true;
        });
    }

    recordDismissal(raw, sourceTabId) {
        return this.run((session, records) => {
            const pending = session.pending;
            if (!pending || pending.id !== raw.impressionId || pending.sourceTabId !== sourceTabId) return false;
            const candidate = pending.candidates.find(item => item.rank === raw.rank);
            if (!candidate || pending.dismissed.includes(candidate.rank)) return false;
            pending.dismissed.push(candidate.rank);
            records.push(this.event("dismissal", pending, { rank: candidate.rank }));
            return true;
        });
    }

    recordQualifiedAccess({ url, tabId, qualifiedDwellMs }) {
        return this.run((session, records) => {
            const pending = session.pending;
            const destination = httpUrl(url);
            if (!pending || !destination || qualifiedDwellMs < 2000 || !Number.isFinite(qualifiedDwellMs)) return false;
            const candidate = pending.candidates.find(item => item.url === destination && !pending.dismissed.includes(item.rank));
            const clicked = candidate && pending.clicked.includes(candidate.rank);
            // Unrelated tab switching is not an off-list choice from Home.
            if (tabId !== pending.sourceTabId && !clicked) return false;
            records.push(this.event(candidate ? "qualified_on_list" : "off_list", pending,
                { rank: candidate?.rank, origin: clicked ? "click" : "navigation" }));
            session.pending = null;
            return true;
        });
    }

    async getSummary() {
        await this.run(() => true); // expire pending observations without timers
        await this.chain.catch(() => {});
        const saved = this.isEnabled() ? await this.localStorage.get([HOME_CONTEXT_BUFFER_KEY]) : {};
        const records = (saved[HOME_CONTEXT_BUFFER_KEY] || []).map(safeRecord).filter(Boolean);
        const count = event => records.filter(record => record.event === event).length;
        return { cohort: HOME_CONTEXT_COHORT, enabled: this.isEnabled(), retainedRecords: records.length,
            from: records[0]?.timestamp || null, to: records.at(-1)?.timestamp || null,
            impressions: count("impression"), clicks: count("click"), dismissals: count("dismissal"),
            qualifiedOnList: count("qualified_on_list"), offList: count("off_list"), expired: count("expired"),
            superseded: count("superseded"),
            qualifiedClicks: records.filter(record => record.event === "qualified_on_list" && record.origin === "click").length };
    }

    clear() {
        this.generation += 1;
        const cleared = this.chain.catch(() => {}).then(() => Promise.all([
            this.localStorage.remove(HOME_CONTEXT_BUFFER_KEY),
            this.sessionStorage?.remove(HOME_CONTEXT_SESSION_KEY)
        ]));
        // New work waits until removal completes; already queued work is invalidated.
        this.chain = cleared;
        return cleared;
    }
}
