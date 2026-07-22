const DEFAULT_DECAY = 0.5;
const DEFAULT_SMOOTHING = 0.01;
const MIN_ELAPSED_SECONDS = 1;

export const REVISIT_MODEL_DEFAULTS = Object.freeze({
    decay: DEFAULT_DECAY,
    smoothing: DEFAULT_SMOOTHING,
    resolution: "domain"
});

/**
 * Normalize a URL into stable page and host identities. These values are used
 * in memory only; the persistent store converts them to keyed digests.
 */
export function normalizeIdentity(url) {
    try {
        const parsed = new URL(url);
        if (!["http:", "https:", "file:"].includes(parsed.protocol)) return null;

        parsed.hash = "";
        const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
        const pathname = parsed.pathname || "/";
        const search = parsed.searchParams.toString();
        const page = parsed.protocol === "file:"
            ? `file://${pathname}`
            : `${parsed.protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ""}${pathname}${search ? `?${search}` : ""}`;

        return {
            page,
            domain: parsed.protocol === "file:" ? "file://" : hostname
        };
    } catch {
        return null;
    }
}

/**
 * Anderson-Schooler / ACT-R base-level activation used as the History term in
 * Zemla et al. (2015): ln(sum(deltaTime ^ -decay)).
 */
export function scoreHistory(accessTimestamps, now = Date.now(), decay = DEFAULT_DECAY) {
    if (!Array.isArray(accessTimestamps) || accessTimestamps.length === 0) {
        return Number.NEGATIVE_INFINITY;
    }

    let activation = 0;
    for (const timestamp of accessTimestamps) {
        if (!Number.isFinite(timestamp) || timestamp > now) continue;
        const elapsedSeconds = Math.max(MIN_ELAPSED_SECONDS, (now - timestamp) / 1000);
        activation += elapsedSeconds ** -decay;
    }

    return activation > 0 ? Math.log(activation) : Number.NEGATIVE_INFINITY;
}

/**
 * Smoothed log odds of transitioning from the current identity to a candidate
 * rather than to any other observed identity. With no outgoing evidence the
 * result is neutral.
 */
export function scoreContext(candidateIdentity, currentIdentity, transitions, smoothing = DEFAULT_SMOOTHING) {
    if (!candidateIdentity || !currentIdentity || candidateIdentity === currentIdentity) return 0;

    const outgoing = readOutgoingTransitions(transitions, currentIdentity);
    if (!outgoing) return 0;

    let total = 0;
    let candidateCount = 0;
    for (const [target, rawCount] of entriesOf(outgoing)) {
        const count = Number(rawCount);
        if (!Number.isFinite(count) || count <= 0) continue;
        total += count;
        if (target === candidateIdentity) candidateCount += count;
    }

    if (total === 0) return 0;
    const otherCount = Math.max(0, total - candidateCount);
    const correction = Number.isFinite(smoothing) && smoothing > 0 ? smoothing : DEFAULT_SMOOTHING;
    return Math.log((candidateCount + correction) / (otherCount + correction));
}

export function scoreBayesian({
    accessTimestamps,
    candidateIdentity,
    currentIdentity,
    transitions,
    now = Date.now(),
    decay = DEFAULT_DECAY,
    smoothing = DEFAULT_SMOOTHING
}) {
    const history = scoreHistory(accessTimestamps, now, decay);
    if (!Number.isFinite(history)) {
        return { history, context: 0, score: Number.NEGATIVE_INFINITY };
    }

    const context = scoreContext(candidateIdentity, currentIdentity, transitions, smoothing);
    return { history, context, score: history + context };
}

/**
 * Combine domain posterior odds with page-specific History. Domain evidence is
 * less sparse; page History selects the precise open tab within that domain.
 */
export function scoreHierarchical({ domain, page }) {
    const domainScore = Number.isFinite(domain?.score) ? domain.score : Number.NEGATIVE_INFINITY;
    const pageHistory = Number.isFinite(page?.history) ? page.history : Number.NEGATIVE_INFINITY;

    if (!Number.isFinite(domainScore) && !Number.isFinite(pageHistory)) {
        return Number.NEGATIVE_INFINITY;
    }
    if (!Number.isFinite(domainScore)) return pageHistory;
    if (!Number.isFinite(pageHistory)) return domainScore;
    return domainScore + pageHistory;
}

function readOutgoingTransitions(transitions, currentIdentity) {
    if (transitions instanceof Map) return transitions.get(currentIdentity);
    if (transitions && typeof transitions === "object") return transitions[currentIdentity];
    return null;
}

function entriesOf(value) {
    if (value instanceof Map) return value.entries();
    if (value && typeof value === "object") return Object.entries(value);
    return [];
}
