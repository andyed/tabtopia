import { normalizeIdentity } from "./revisit-model.js";

const DEFAULT_MAX_SCORED_PAGES = 128;
const DEFAULT_RESULT_LIMIT = 6;
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

export const HABIT_DESTINATION_DEFAULTS = Object.freeze({
  maxScoredPages: DEFAULT_MAX_SCORED_PAGES,
  resultLimit: DEFAULT_RESULT_LIMIT
});

/**
 * Turn Chrome History rows into a bounded, reversible candidate pool.
 *
 * visitCount and lastVisitTime only decide which pages are worth asking the
 * qualified-access store about. They are deliberately not the final habit
 * score because raw History rows include reloads, redirects, and brief visits.
 */
export function prepareHabitCandidatePool(historyItems, {
  maxScoredPages = DEFAULT_MAX_SCORED_PAGES
} = {}) {
  const pageMap = new Map();

  for (const item of Array.isArray(historyItems) ? historyItems : []) {
    const url = String(item?.url || "");
    if (!isEligibleHabitUrl(url)) continue;
    const identity = normalizeIdentity(url);
    if (!identity) continue;

    const candidate = {
      normalizedPage: identity.page,
      domain: identity.domain,
      url,
      title: String(item?.title || identity.domain || "Untitled"),
      visitCount: nonNegativeNumber(item?.visitCount),
      typedCount: nonNegativeNumber(item?.typedCount),
      lastVisitTime: positiveNumber(item?.lastVisitTime)
    };
    const existing = pageMap.get(identity.page);
    pageMap.set(identity.page, existing
      ? mergeHistoryRows(existing, candidate)
      : candidate);
  }

  const pages = [...pageMap.values()];
  const safeLimit = Math.max(0, Math.min(
    DEFAULT_MAX_SCORED_PAGES,
    Math.floor(Number(maxScoredPages) || 0)
  ));
  const frequencyCount = Math.ceil(safeLimit / 2);
  const recencyCount = safeLimit - frequencyCount;
  const selected = new Map();

  pages
    .slice()
    .sort(compareFrequency)
    .slice(0, frequencyCount)
    .forEach(item => selected.set(item.normalizedPage, item));
  pages
    .slice()
    .sort(compareRecency)
    .slice(0, recencyCount)
    .forEach(item => selected.set(item.normalizedPage, item));

  // A high-frequency and a recent list can overlap heavily. Fill the unused
  // budget deterministically from the combined evidence order.
  if (selected.size < safeLimit) {
    pages
      .slice()
      .sort(compareShortlistEvidence)
      .forEach(item => {
        if (selected.size < safeLimit) selected.set(item.normalizedPage, item);
      });
  }

  const candidates = [...selected.values()]
    .sort(compareStableCandidate)
    .map((item, index) => ({
      ...item,
      key: String(index)
    }));

  return {
    candidates,
    totalEligiblePages: pages.length,
    truncated: pages.length > candidates.length,
    maxScoredPages: safeLimit
  };
}

/**
 * Rank one concrete destination per domain from History-only ACT-R scores.
 *
 * No neighborhood or transition input is accepted. That API boundary is the
 * coupling-skepticism invariant: a synchronous neighbor cannot borrow rank in
 * this lane.
 */
export function rankHabitDestinations({
  pool,
  historyScores = [],
  openTabs = [],
  now = Date.now(),
  limit = DEFAULT_RESULT_LIMIT
} = {}) {
  const candidates = Array.isArray(pool?.candidates) ? pool.candidates : [];
  const scoresByKey = new Map((Array.isArray(historyScores) ? historyScores : [])
    .map(score => [String(score?.key), score]));
  const pagesByDomain = new Map();

  for (const candidate of candidates) {
    const evidence = scoresByKey.get(String(candidate.key));
    if (!Number.isFinite(evidence?.domain?.activation)) continue;
    const scored = {
      ...candidate,
      pageEvidence: normalizeEvidence(evidence?.page),
      domainEvidence: normalizeEvidence(evidence?.domain)
    };
    const pages = pagesByDomain.get(candidate.domain) || [];
    pages.push(scored);
    pagesByDomain.set(candidate.domain, pages);
  }

  const ranked = [...pagesByDomain.entries()].map(([domain, pages]) => {
    pages.sort(compareScoredPages);
    const chosen = pages[0];
    const openTab = findExactOpenTab(chosen.normalizedPage, openTabs);
    const target = openTab
      ? { ...openTab, open: true }
      : {
          url: chosen.url,
          title: chosen.title,
          open: false
        };
    const accessCount = chosen.domainEvidence.accessCount;

    return {
      id: `habit:${domain}`,
      kind: "habit-destination",
      domain,
      score: chosen.domainEvidence.activation,
      action: {
        verb: openTab ? "switch" : "open",
        target
      },
      cues: {
        historyActivation: chosen.domainEvidence.activation,
        pageHistoryActivation: chosen.pageEvidence.activation,
        accessCount,
        pageAccessCount: chosen.pageEvidence.accessCount,
        lastAccessAt: chosen.domainEvidence.lastAccessAt,
        chromeVisitCount: pages.reduce((sum, page) => sum + page.visitCount, 0),
        typedCount: pages.reduce((sum, page) => sum + page.typedCount, 0),
        context: 0
      },
      reasons: [
        `${accessCount} qualified access${accessCount === 1 ? "" : "es"} in durable History`,
        "session coupling excluded from this score"
      ]
    };
  }).sort(compareRankedDestinations);

  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  return {
    generatedAt: Number(now) || Date.now(),
    source: "qualified-history",
    candidates: ranked.slice(0, safeLimit),
    suppressedCount: Math.max(0, ranked.length - safeLimit),
    scoredPageCount: candidates.length,
    shortlistedPageCount: pool?.candidates?.length || 0,
    truncatedPool: Boolean(pool?.truncated)
  };
}

function isEligibleHabitUrl(url) {
  try {
    return SUPPORTED_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function mergeHistoryRows(existing, incoming) {
  const incomingIsNewer = incoming.lastVisitTime > existing.lastVisitTime
    || (incoming.lastVisitTime === existing.lastVisitTime && incoming.url.localeCompare(existing.url) < 0);
  const representative = incomingIsNewer ? incoming : existing;
  return {
    ...representative,
    normalizedPage: existing.normalizedPage,
    domain: existing.domain,
    visitCount: existing.visitCount + incoming.visitCount,
    typedCount: existing.typedCount + incoming.typedCount,
    lastVisitTime: Math.max(existing.lastVisitTime, incoming.lastVisitTime)
  };
}

function normalizeEvidence(value) {
  return {
    activation: Number.isFinite(value?.activation)
      ? Number(value.activation)
      : Number.NEGATIVE_INFINITY,
    accessCount: nonNegativeNumber(value?.accessCount),
    lastAccessAt: positiveNumber(value?.lastAccessAt)
  };
}

function findExactOpenTab(normalizedPage, openTabs) {
  return (Array.isArray(openTabs) ? openTabs : [])
    .filter(tab => normalizeIdentity(tab?.url || "")?.page === normalizedPage)
    .sort((left, right) => positiveNumber(right?.lastAccessed) - positiveNumber(left?.lastAccessed)
      || Number(left?.id || 0) - Number(right?.id || 0))[0] || null;
}

function compareFrequency(left, right) {
  return right.visitCount - left.visitCount
    || right.typedCount - left.typedCount
    || right.lastVisitTime - left.lastVisitTime
    || left.normalizedPage.localeCompare(right.normalizedPage);
}

function compareRecency(left, right) {
  return right.lastVisitTime - left.lastVisitTime
    || right.visitCount - left.visitCount
    || right.typedCount - left.typedCount
    || left.normalizedPage.localeCompare(right.normalizedPage);
}

function compareShortlistEvidence(left, right) {
  const leftScore = Math.log1p(left.visitCount) + (0.25 * Math.log1p(left.typedCount));
  const rightScore = Math.log1p(right.visitCount) + (0.25 * Math.log1p(right.typedCount));
  return rightScore - leftScore
    || compareRecency(left, right);
}

function compareStableCandidate(left, right) {
  return left.normalizedPage.localeCompare(right.normalizedPage);
}

function compareScoredPages(left, right) {
  return finiteDescending(right.pageEvidence.activation, left.pageEvidence.activation)
    || right.pageEvidence.accessCount - left.pageEvidence.accessCount
    || right.lastVisitTime - left.lastVisitTime
    || left.normalizedPage.localeCompare(right.normalizedPage);
}

function compareRankedDestinations(left, right) {
  return finiteDescending(right.score, left.score)
    || right.cues.accessCount - left.cues.accessCount
    || right.cues.lastAccessAt - left.cues.lastAccessAt
    || left.domain.localeCompare(right.domain);
}

function finiteDescending(high, low) {
  if (Number.isFinite(high) && Number.isFinite(low)) return high - low;
  if (Number.isFinite(high)) return 1;
  if (Number.isFinite(low)) return -1;
  return 0;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
