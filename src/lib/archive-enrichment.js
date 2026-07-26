import { normalizeIdentity } from "./revisit-model.js";

const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 12;
const MAX_TOPICS = 2;
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);
const INTEREST_STATE_ORDER = Object.freeze({
  "active-now": 0,
  resurfacing: 1,
  recurring: 2,
  archive: 3
});

/**
 * Enrich the home feed with related archive items without mixing their evidence
 * with habit or deferred-intention scores.
 *
 * Candidate lanes are explicit: semantic rank, then tags inferred from exact
 * archive matches for the current context, then a deterministic durable
 * fallback. Every output state and reason stays qualitative.
 */
export function buildArchiveEnrichment({
  archiveItems = [],
  semanticItems = [],
  contextItems = [],
  selectedUrls = [],
  now = Date.now(),
  limit = DEFAULT_LIMIT
} = {}) {
  const generatedAt = finiteTimestamp(now) || Date.now();
  const archiveByPage = indexArchive(archiveItems);
  const exclusions = excludedPages(selectedUrls, contextItems, archiveByPage);
  const context = deriveContext(contextItems, archiveByPage);
  const semanticRanks = indexSemanticRanks(semanticItems, archiveByPage);
  const candidates = [...archiveByPage.values()]
    .filter(item => !exclusions.has(item.normalizedPage));

  const semanticLane = [];
  const contextLane = [];
  const fallbackLane = [];

  for (const item of candidates) {
    const semanticRank = semanticRanks.get(item.normalizedPage);
    const overlaps = item.tags.filter(tag => context.tags.has(tag));
    const foreignOverlaps = overlaps.filter(tag => context.foreignTags.has(tag));
    const localOverlaps = overlaps.filter(tag => context.localTags.has(tag));
    const enriched = {
      item,
      semanticRank,
      overlaps,
      foreignOverlaps,
      localOverlaps
    };

    if (Number.isFinite(semanticRank)) semanticLane.push(enriched);
    else if (overlaps.length > 0) contextLane.push(enriched);
    else fallbackLane.push(enriched);
  }

  semanticLane.sort(compareSemantic);
  contextLane.sort(compareContext);
  fallbackLane.sort(compareDurable);

  const safeLimit = boundedLimit(limit);
  const selected = [];
  const selectedPages = new Set();
  for (const [source, lane] of [
    ["semantic", semanticLane],
    ["context", contextLane],
    ["fallback", fallbackLane]
  ]) {
    for (const candidate of lane) {
      if (selected.length >= safeLimit) break;
      if (selectedPages.has(candidate.item.normalizedPage)) continue;
      selectedPages.add(candidate.item.normalizedPage);
      selected.push(materializeCandidate(candidate, source, generatedAt));
    }
  }

  return {
    items: selected,
    interests: summarizeInterests(selected),
    sourceCounts: {
      semantic: selected.filter(item => item.source === "semantic").length,
      context: selected.filter(item => item.source === "context").length,
      fallback: selected.filter(item => item.source === "fallback").length
    }
  };
}

function indexArchive(archiveItems) {
  const byPage = new Map();
  for (const raw of Array.isArray(archiveItems) ? archiveItems : []) {
    const url = String(raw?.url || "");
    if (!isEligibleUrl(url)) continue;
    const identity = normalizeIdentity(url);
    if (!identity) continue;

    const item = {
      normalizedPage: identity.page,
      domain: identity.domain,
      url,
      title: cleanText(raw?.title) || identity.domain || "Archived page",
      tags: normalizeTags(raw?.tags),
      visitCount: nonNegativeNumber(raw?.visitCount ?? raw?.accessCount),
      lastVisitTime: finiteTimestamp(raw?.lastVisitTime ?? raw?.lastAccessAt),
      archivedAt: finiteTimestamp(raw?.archivedAt ?? raw?.dateAdded ?? raw?.savedAt),
      excluded: Boolean(raw?.selected || raw?.open || raw?.current)
    };
    const existing = byPage.get(identity.page);
    byPage.set(identity.page, existing ? mergeArchiveItems(existing, item) : item);
  }
  return byPage;
}

function mergeArchiveItems(existing, incoming) {
  const incomingIsNewer = compareArchiveRepresentatives(incoming, existing) < 0;
  const representative = incomingIsNewer ? incoming : existing;
  return {
    ...representative,
    normalizedPage: existing.normalizedPage,
    domain: existing.domain,
    tags: [...new Set([...existing.tags, ...incoming.tags])].sort(),
    visitCount: Math.max(existing.visitCount, incoming.visitCount),
    lastVisitTime: Math.max(existing.lastVisitTime, incoming.lastVisitTime),
    archivedAt: Math.max(existing.archivedAt, incoming.archivedAt),
    excluded: existing.excluded || incoming.excluded
  };
}

function excludedPages(selectedUrls, contextItems, archiveByPage) {
  const excluded = new Set();
  for (const value of Array.isArray(selectedUrls) ? selectedUrls : []) {
    const page = pageOf(typeof value === "string" ? value : value?.url);
    if (page) excluded.add(page);
  }
  for (const item of Array.isArray(contextItems) ? contextItems : []) {
    const page = pageOf(item?.url);
    if (page) excluded.add(page);
  }
  for (const item of archiveByPage.values()) {
    if (item.excluded) excluded.add(item.normalizedPage);
  }
  return excluded;
}

function deriveContext(contextItems, archiveByPage) {
  const tags = new Set();
  const localTags = new Set();
  const foreignTags = new Set();

  for (const contextItem of Array.isArray(contextItems) ? contextItems : []) {
    // Context-provided tags are intentionally ignored. A context URL must match
    // an archive identity exactly before its archive tags can influence recall.
    const archiveItem = archiveByPage.get(pageOf(contextItem?.url));
    if (!archiveItem) continue;
    for (const tag of archiveItem.tags) {
      tags.add(tag);
      if (contextItem?.isLocal === false) foreignTags.add(tag);
      else localTags.add(tag);
    }
  }
  return { tags, localTags, foreignTags };
}

function indexSemanticRanks(semanticItems, archiveByPage) {
  const ranks = new Map();
  for (const [index, item] of (Array.isArray(semanticItems) ? semanticItems : []).entries()) {
    const page = pageOf(item?.url);
    if (!page || !archiveByPage.has(page)) continue;
    const explicitRank = positiveNumber(item?.rank ?? item?.semanticRank);
    const rank = explicitRank || index + 1;
    const existing = ranks.get(page);
    if (!Number.isFinite(existing) || rank < existing) ranks.set(page, rank);
  }
  return ranks;
}

function materializeCandidate(candidate, source, now) {
  const { item, overlaps, foreignOverlaps, localOverlaps } = candidate;
  const interestState = interestStateFor({
    source,
    foreignOverlaps,
    localOverlaps,
    visitCount: item.visitCount
  });
  const topics = prioritizedTopics(item.tags, overlaps);
  return {
    id: `archive:${item.normalizedPage}`,
    kind: "archive-enrichment",
    source,
    interestState,
    topics,
    action: {
      verb: "open",
      target: {
        url: item.url,
        title: item.title,
        open: false
      }
    },
    reason: reasonFor({ source, foreignOverlaps, localOverlaps, visitCount: item.visitCount }),
    evidence: {
      semanticRank: Number.isFinite(candidate.semanticRank) ? candidate.semanticRank : null,
      overlappingTags: overlaps.slice(0, MAX_TOPICS),
      foreignContext: foreignOverlaps.length > 0,
      visitCount: item.visitCount,
      lastVisitTime: item.lastVisitTime,
      archivedAt: item.archivedAt,
      ageMs: item.lastVisitTime > 0 ? Math.max(0, now - item.lastVisitTime) : null
    }
  };
}

function interestStateFor({ source, foreignOverlaps, localOverlaps, visitCount }) {
  if (foreignOverlaps.length > 0 || source === "semantic") return "resurfacing";
  if (localOverlaps.length > 0) return "active-now";
  if (visitCount > 1) return "recurring";
  return "archive";
}

function reasonFor({ source, foreignOverlaps, localOverlaps, visitCount }) {
  if (foreignOverlaps.length > 0) {
    return "Related to activity from another device.";
  }
  if (source === "semantic") return "Semantically related.";
  if (localOverlaps.length > 0) return "Shares an active interest.";
  if (visitCount > 1) return "Repeatedly useful.";
  return "Durable reference.";
}

function prioritizedTopics(tags, overlaps) {
  return [...new Set([...overlaps.slice().sort(), ...tags])].slice(0, MAX_TOPICS);
}

function summarizeInterests(items) {
  const byTopic = new Map();
  for (const item of items) {
    for (const topic of item.topics) {
      const existing = byTopic.get(topic);
      if (!existing) {
        byTopic.set(topic, { topic, interestState: item.interestState, itemCount: 1 });
        continue;
      }
      existing.itemCount += 1;
      if (INTEREST_STATE_ORDER[item.interestState] < INTEREST_STATE_ORDER[existing.interestState]) {
        existing.interestState = item.interestState;
      }
    }
  }
  return [...byTopic.values()].sort((left, right) => right.itemCount - left.itemCount
    || INTEREST_STATE_ORDER[left.interestState] - INTEREST_STATE_ORDER[right.interestState]
    || left.topic.localeCompare(right.topic));
}

function compareSemantic(left, right) {
  return left.semanticRank - right.semanticRank
    || compareDurability(left.item, right.item);
}

function compareContext(left, right) {
  return right.overlaps.length - left.overlaps.length
    || right.foreignOverlaps.length - left.foreignOverlaps.length
    || compareDurability(left.item, right.item);
}

function compareDurable(left, right) {
  return compareDurability(left.item, right.item);
}

function compareDurability(left, right) {
  return right.visitCount - left.visitCount
    || right.lastVisitTime - left.lastVisitTime
    || right.archivedAt - left.archivedAt
    || left.normalizedPage.localeCompare(right.normalizedPage);
}

function normalizeTags(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(raw
    .map(tag => cleanText(tag).toLocaleLowerCase())
    .filter(Boolean))].sort();
}

function cleanText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function representativeTimestamp(item) {
  return Math.max(item.lastVisitTime, item.archivedAt);
}

function compareArchiveRepresentatives(left, right) {
  return representativeTimestamp(right) - representativeTimestamp(left)
    || left.url.localeCompare(right.url)
    || left.title.localeCompare(right.title);
}

function pageOf(url) {
  return normalizeIdentity(url || "")?.page || "";
}

function isEligibleUrl(url) {
  try {
    return SUPPORTED_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function boundedLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_LIMIT;
  return Math.max(0, Math.min(MAX_LIMIT, Math.floor(number)));
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
