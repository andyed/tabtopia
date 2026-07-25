import {
    REVISIT_MODEL_DEFAULTS,
    normalizeIdentity,
    scoreBayesian,
    scoreHistory,
    scoreHierarchical
} from "./revisit-model.js";

const STATE_KEY = "tabtopiaRevisitModelV1";
const SECRET_KEY = "tabtopiaRevisitSecretV1";
const STATE_VERSION = 1;
const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_ACCESSES_PER_IDENTITY = 64;
const MAX_IDENTITIES = 1000;
const MAX_TRANSITION_SOURCES = 500;
const MAX_TRANSITION_TARGETS = 32;

export class RevisitStore {
    constructor(storageArea, config = {}) {
        this.storage = storageArea;
        this.config = { ...REVISIT_MODEL_DEFAULTS, ...config };
        this.state = emptyState();
        this.hmacKey = null;
        this.digestCache = new Map();
        this.persistTimer = null;
        this.ready = false;
    }

    async init() {
        const saved = await this.storage.get([STATE_KEY, SECRET_KEY]);
        const secret = saved[SECRET_KEY] || createSecret();
        if (!saved[SECRET_KEY]) await this.storage.set({ [SECRET_KEY]: secret });

        this.hmacKey = await crypto.subtle.importKey(
            "raw",
            decodeBase64(secret),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
        );
        this.state = validateState(saved[STATE_KEY]);
        this.prune(Date.now());
        this.ready = true;
        return this;
    }

    async recordAccess(url, previousUrl = "", timestamp = Date.now()) {
        if (!this.ready) await this.init();
        const current = normalizeIdentity(url);
        if (!current) return false;
        const previous = normalizeIdentity(previousUrl);

        for (const resolution of ["page", "domain"]) {
            const currentDigest = await this.digest(current[resolution]);
            appendTimestamp(this.state.histories[resolution], currentDigest, timestamp);

            if (previous?.[resolution] && previous[resolution] !== current[resolution]) {
                const previousDigest = await this.digest(previous[resolution]);
                incrementTransition(this.state.transitions[resolution], previousDigest, currentDigest);
            }
        }

        this.state.updatedAt = timestamp;
        this.prune(timestamp);
        this.schedulePersist();
        return true;
    }

    async scoreTabs(tabs, currentUrl, now = Date.now()) {
        if (!this.ready) await this.init();
        const current = normalizeIdentity(currentUrl);
        const currentDigests = current ? {
            page: await this.digest(current.page),
            domain: await this.digest(current.domain)
        } : { page: null, domain: null };

        return Promise.all(tabs.map(async tab => {
            const identity = normalizeIdentity(tab.url || "");
            if (!identity) return { tabId: tab.id, score: Number.NEGATIVE_INFINITY, history: Number.NEGATIVE_INFINITY, source: "none" };

            const pageDigest = await this.digest(identity.page);
            const domainDigest = await this.digest(identity.domain);
            const page = scoreBayesian({
                accessTimestamps: this.state.histories.page[pageDigest],
                candidateIdentity: pageDigest,
                currentIdentity: currentDigests.page,
                transitions: this.state.transitions.page,
                now,
                decay: this.config.decay,
                smoothing: this.config.smoothing
            });
            const domain = scoreBayesian({
                accessTimestamps: this.state.histories.domain[domainDigest],
                candidateIdentity: domainDigest,
                currentIdentity: currentDigests.domain,
                transitions: this.state.transitions.domain,
                now,
                decay: this.config.decay,
                smoothing: this.config.smoothing
            });

            const score = this.config.resolution === "page"
                ? page.score
                : this.config.resolution === "domain"
                    ? domain.score
                    : scoreHierarchical({ domain, page });

            return {
                tabId: tab.id,
                score,
                history: page.history,
                source: Number.isFinite(score) ? "bayesian" : "none"
            };
        }));
    }

    /**
     * Score a bounded, already-enumerated candidate pool using ACT-R History
     * only. Candidate enumeration belongs to Chrome History; this store owns the
     * qualified access timestamps. Keeping Context out of this method prevents
     * a synchronous or transitional cue from leaking into the durable habit
     * prior.
     *
     * The caller-supplied key is echoed so an extension page can join the
     * results without receiving persisted HMAC digests or echoed URLs.
     */
    async scoreHistoryCandidates(candidates, now = Date.now()) {
        if (!this.ready) await this.init();
        const safeCandidates = Array.isArray(candidates) ? candidates : [];

        return Promise.all(safeCandidates.map(async candidate => {
            const identity = normalizeIdentity(candidate?.url || "");
            if (!identity) return emptyHistoryCandidate(candidate?.key);

            const pageDigest = await this.digest(identity.page);
            const domainDigest = await this.digest(identity.domain);
            return {
                key: candidate?.key,
                page: historyEvidence(
                    this.state.histories.page[pageDigest],
                    now,
                    this.config.decay
                ),
                domain: historyEvidence(
                    this.state.histories.domain[domainDigest],
                    now,
                    this.config.decay
                )
            };
        }));
    }

    async clear() {
        if (!this.ready) await this.init();
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = null;
        }
        this.state = emptyState();
        this.digestCache.clear();
        await this.storage.set({ [STATE_KEY]: this.state });
    }

    schedulePersist() {
        if (this.persistTimer) return;
        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            this.flush().catch(error => console.warn("[RevisitStore] persistence failed", error));
        }, 2000);
    }

    async flush() {
        if (!this.ready) return;
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = null;
        }
        await this.storage.set({ [STATE_KEY]: this.state });
    }

    prune(now) {
        const cutoff = now - RETENTION_MS;
        for (const resolution of ["page", "domain"]) {
            const histories = this.state.histories[resolution];
            for (const [identity, timestamps] of Object.entries(histories)) {
                const retained = timestamps
                    .filter(timestamp => Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now)
                    .slice(-MAX_ACCESSES_PER_IDENTITY);
                if (retained.length > 0) histories[identity] = retained;
                else delete histories[identity];
            }
            trimHistories(histories);
            trimTransitions(this.state.transitions[resolution], histories);
        }
    }

    async digest(identity) {
        if (!identity) return null;
        if (this.digestCache.has(identity)) return this.digestCache.get(identity);
        const signature = await crypto.subtle.sign("HMAC", this.hmacKey, new TextEncoder().encode(identity));
        const digest = encodeBase64(new Uint8Array(signature));
        this.digestCache.set(identity, digest);
        return digest;
    }
}

function emptyState() {
    return {
        version: STATE_VERSION,
        histories: { page: {}, domain: {} },
        transitions: { page: {}, domain: {} },
        updatedAt: 0
    };
}

function validateState(value) {
    if (!value || value.version !== STATE_VERSION) return emptyState();
    return {
        version: STATE_VERSION,
        histories: {
            page: objectOrEmpty(value.histories?.page),
            domain: objectOrEmpty(value.histories?.domain)
        },
        transitions: {
            page: objectOrEmpty(value.transitions?.page),
            domain: objectOrEmpty(value.transitions?.domain)
        },
        updatedAt: Number(value.updatedAt || 0)
    };
}

function objectOrEmpty(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function appendTimestamp(histories, identity, timestamp) {
    if (!histories[identity]) histories[identity] = [];
    histories[identity].push(timestamp);
    if (histories[identity].length > MAX_ACCESSES_PER_IDENTITY) {
        histories[identity] = histories[identity].slice(-MAX_ACCESSES_PER_IDENTITY);
    }
}

function incrementTransition(transitions, source, target) {
    if (!transitions[source]) transitions[source] = {};
    transitions[source][target] = Number(transitions[source][target] || 0) + 1;

    const targets = Object.entries(transitions[source]);
    if (targets.length > MAX_TRANSITION_TARGETS) {
        targets.sort((a, b) => Number(b[1]) - Number(a[1]));
        transitions[source] = Object.fromEntries(targets.slice(0, MAX_TRANSITION_TARGETS));
    }
}

function trimHistories(histories) {
    const entries = Object.entries(histories);
    if (entries.length <= MAX_IDENTITIES) return;
    entries.sort((a, b) => latest(b[1]) - latest(a[1]));
    const keep = new Set(entries.slice(0, MAX_IDENTITIES).map(([identity]) => identity));
    for (const identity of Object.keys(histories)) {
        if (!keep.has(identity)) delete histories[identity];
    }
}

function trimTransitions(transitions, histories) {
    for (const source of Object.keys(transitions)) {
        if (!histories[source]) {
            delete transitions[source];
            continue;
        }
        for (const target of Object.keys(transitions[source])) {
            if (!histories[target]) delete transitions[source][target];
        }
        if (Object.keys(transitions[source]).length === 0) delete transitions[source];
    }

    const sources = Object.keys(transitions);
    if (sources.length <= MAX_TRANSITION_SOURCES) return;
    sources.sort((a, b) => latest(histories[b]) - latest(histories[a]));
    for (const source of sources.slice(MAX_TRANSITION_SOURCES)) delete transitions[source];
}

function latest(timestamps) {
    return Array.isArray(timestamps) && timestamps.length > 0 ? timestamps[timestamps.length - 1] : 0;
}

function historyEvidence(timestamps, now, decay) {
    const accesses = Array.isArray(timestamps)
        ? timestamps.filter(timestamp => Number.isFinite(timestamp) && timestamp <= now)
        : [];
    return {
        activation: scoreHistory(accesses, now, decay),
        accessCount: accesses.length,
        lastAccessAt: latest(accesses)
    };
}

function emptyHistoryCandidate(key) {
    const empty = {
        activation: Number.NEGATIVE_INFINITY,
        accessCount: 0,
        lastAccessAt: 0
    };
    return {
        key,
        page: { ...empty },
        domain: { ...empty }
    };
}

function createSecret() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return encodeBase64(bytes);
}

function encodeBase64(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64(value) {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
}
