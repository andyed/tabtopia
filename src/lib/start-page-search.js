import { normalizeIdentity } from "./revisit-model.js";
import { normalizeQuery, scoreText } from "./tab-recall.js";

const DEFAULT_LIMIT = 16;
const MAX_LIMIT = 50;

/**
 * Build a deterministic, list-first retrieval set for a start-page query.
 *
 * Text match is the admission gate for direct bookmark/open/History results.
 * Explicit archive tags may admit a separate related-recall lane; recent access
 * and repeat visits only order candidates inside those evidence lanes. All
 * sources merge by stable page identity so the SERP never repeats a URL.
 */
export function buildStartPageSearchResults({
  query = "",
  openItems = [],
  bookmarkItems = [],
  taggedItems = [],
  historyItems = [],
  now = Date.now(),
  limit = DEFAULT_LIMIT
} = {}) {
  const tokens = normalizeQuery(query);
  if (tokens.length === 0) return [];

  const byPage = new Map();
  for (const raw of array(historyItems)) mergeCandidate(byPage, historyCandidate(raw));
  for (const raw of array(taggedItems)) mergeCandidate(byPage, taggedCandidate(raw));
  for (const raw of array(bookmarkItems)) mergeCandidate(byPage, bookmarkCandidate(raw));
  for (const raw of array(openItems)) mergeCandidate(byPage, openCandidate(raw));

  const phrase = tokens.join(" ");
  const tagSpace = matchingTagSpace(tokens, byPage.values());
  const saved = [];
  const related = [];
  const general = [];
  for (const candidate of byPage.values()) {
    const text = scoreCandidateText(tokens, candidate);
    const matchedTags = candidate.tags.filter(tag => tagSpace.has(searchable(tag)));
    if (text.score <= 0 && matchedTags.length === 0) continue;
    const normalizedTitle = searchable(candidate.title);
    const exactTitle = normalizedTitle === phrase;
    const titlePhrase = normalizedTitle.includes(phrase);
    const lastSeenAt = Math.max(candidate.lastAccessed, candidate.lastVisitTime);
    const rankScore = text.score
      + (exactTitle ? 20 : titlePhrase ? 4 : 0)
      + recencyBoost(lastSeenAt, now)
      + Math.min(2, Math.log2(Math.max(1, candidate.visitCount)))
      + (candidate.open ? 0.5 : 0);
    const result = {
      ...candidate,
      lastSeenAt,
      matchedTags,
      matchKind: matchedTags.length > 0 && text.score <= 0
        ? "Related tag"
        : matchKind(tokens, candidate, exactTitle, titlePhrase, text.reason),
      rankScore: rankScore + matchedTags.length * 5,
      source: candidate.open ? "open" : "history"
    };
    if (candidate.bookmarked && text.score > 0) saved.push({ ...result, source: "bookmark" });
    else if (matchedTags.length > 0 && candidate.tagged) related.push({ ...result, source: "tag" });
    else if (text.score > 0) general.push(result);
  }

  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(limit) || DEFAULT_LIMIT)));
  return [
    ...saved.sort(compareRanked),
    ...related.sort(compareRanked),
    ...general.sort(compareRanked)
  ]
    .slice(0, safeLimit)
    .map(({ rankScore: _rankScore, sourcePriority: _sourcePriority, ...result }) => result);
}

function historyCandidate(raw) {
  if (!raw || typeof raw !== "object") return null;
  return baseCandidate(raw, {
    open: false,
    bookmarked: false,
    tagged: false,
    history: true,
    tabId: null,
    windowId: null,
    lastAccessed: 0,
    lastVisitTime: positiveNumber(raw.lastVisitTime),
    historyLastVisitedAt: positiveNumber(raw.lastVisitTime),
    bookmarkSavedAt: 0,
    taggedAt: 0,
    visitCount: Math.max(1, Math.floor(Number(raw.visitCount) || 1)),
    sourcePriority: 1
  });
}

function taggedCandidate(raw) {
  if (!raw || typeof raw !== "object") return null;
  return baseCandidate(raw, {
    open: false,
    bookmarked: false,
    tagged: true,
    history: false,
    tabId: null,
    windowId: null,
    lastAccessed: 0,
    lastVisitTime: positiveNumber(raw.lastVisitTime ?? raw.timestamp),
    historyLastVisitedAt: 0,
    bookmarkSavedAt: 0,
    taggedAt: positiveNumber(raw.archivedAt ?? raw.timestamp),
    visitCount: Math.max(0, Math.floor(Number(raw.visitCount) || 0)),
    sourcePriority: 2
  });
}

function bookmarkCandidate(raw) {
  if (!raw || typeof raw !== "object") return null;
  return baseCandidate(raw, {
    open: false,
    bookmarked: true,
    tagged: false,
    history: false,
    tabId: null,
    windowId: null,
    lastAccessed: positiveNumber(raw.dateLastUsed),
    lastVisitTime: positiveNumber(raw.dateAdded),
    historyLastVisitedAt: 0,
    bookmarkSavedAt: positiveNumber(raw.dateAdded),
    taggedAt: 0,
    visitCount: 0,
    sourcePriority: 3
  });
}

function openCandidate(raw) {
  const source = raw?.data && typeof raw.data === "object" ? raw.data : raw;
  if (!source || typeof source !== "object") return null;
  return baseCandidate(source, {
    open: true,
    bookmarked: false,
    tagged: false,
    history: false,
    tabId: integer(source.id ?? raw?.tabId),
    windowId: integer(source.windowId ?? raw?.windowId),
    lastAccessed: positiveNumber(source.lastAccessed),
    lastVisitTime: 0,
    historyLastVisitedAt: 0,
    bookmarkSavedAt: 0,
    taggedAt: 0,
    visitCount: 0,
    sourcePriority: 4
  });
}

function baseCandidate(raw, state) {
  const url = String(raw.url || "");
  const identity = normalizeIdentity(url);
  if (!identity || !["http:", "https:"].includes(protocol(url))) return null;
  let path = "";
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname || "/"}${parsed.search || ""}`;
  } catch {
    return null;
  }
  return {
    id: identity.page,
    title: String(raw.title || identity.domain || "Untitled page"),
    url,
    domain: identity.domain,
    path,
    summary: String(raw.summary || ""),
    summarySource: String(raw.summarySource || ""),
    summaryTimestamp: positiveNumber(raw.summaryTimestamp),
    heroImageUrl: String(raw.heroImageUrl || ""),
    heroImageAlt: String(raw.heroImageAlt || ""),
    heroImageScore: positiveNumber(raw.heroImageScore),
    tags: normalizeTags(raw.tags),
    ...state
  };
}

function mergeCandidate(byPage, candidate) {
  if (!candidate) return;
  const existing = byPage.get(candidate.id);
  if (!existing) {
    byPage.set(candidate.id, candidate);
    return;
  }
  const representative = candidate.sourcePriority > existing.sourcePriority ? candidate : existing;
  byPage.set(candidate.id, {
    ...existing,
    ...representative,
    open: existing.open || candidate.open,
    bookmarked: existing.bookmarked || candidate.bookmarked,
    tagged: existing.tagged || candidate.tagged,
    history: existing.history || candidate.history,
    tabId: candidate.open ? candidate.tabId : existing.open ? existing.tabId : null,
    windowId: candidate.open ? candidate.windowId : existing.open ? existing.windowId : null,
    lastAccessed: Math.max(existing.lastAccessed, candidate.lastAccessed),
    lastVisitTime: Math.max(existing.lastVisitTime, candidate.lastVisitTime),
    historyLastVisitedAt: Math.max(existing.historyLastVisitedAt, candidate.historyLastVisitedAt),
    bookmarkSavedAt: Math.max(existing.bookmarkSavedAt, candidate.bookmarkSavedAt),
    taggedAt: Math.max(existing.taggedAt, candidate.taggedAt),
    visitCount: Math.max(existing.visitCount, candidate.visitCount),
    summary: candidate.summary || existing.summary,
    summarySource: candidate.summary ? candidate.summarySource : existing.summarySource,
    summaryTimestamp: Math.max(existing.summaryTimestamp, candidate.summaryTimestamp),
    heroImageUrl: candidate.heroImageScore > existing.heroImageScore
      ? candidate.heroImageUrl
      : existing.heroImageUrl,
    heroImageAlt: candidate.heroImageScore > existing.heroImageScore
      ? candidate.heroImageAlt
      : existing.heroImageAlt,
    heroImageScore: Math.max(existing.heroImageScore, candidate.heroImageScore),
    tags: [...new Set([...existing.tags, ...candidate.tags])].sort(),
    sourcePriority: Math.max(existing.sourcePriority, candidate.sourcePriority)
  });
}

function scoreCandidateText(tokens, candidate) {
  const structured = scoreText(tokens, candidate);
  if (!everyToken(tokens, candidate.summary)) return structured;
  const phrase = tokens.join(" ");
  const summaryScore = tokens.length * 4 + (searchable(candidate.summary).includes(phrase) ? 3 : 0);
  return summaryScore > structured.score
    ? { score: summaryScore, reason: "summary match" }
    : structured;
}

function matchingTagSpace(tokens, candidates) {
  const tags = new Set();
  for (const candidate of candidates) {
    if (!candidate.tagged || candidate.tags.length === 0) continue;
    const directTags = candidate.tags.filter(tag => everyToken(tokens, tag));
    if (directTags.length > 0 || scoreCandidateText(tokens, candidate).score > 0) {
      for (const tag of candidate.tags) tags.add(searchable(tag));
    }
  }
  return tags;
}

function compareRanked(left, right) {
  return (right.rankScore - left.rankScore)
    || (right.lastSeenAt - left.lastSeenAt)
    || left.title.localeCompare(right.title)
    || left.url.localeCompare(right.url);
}

function matchKind(tokens, candidate, exactTitle, titlePhrase, fallback) {
  if (exactTitle) return "Exact title";
  if (titlePhrase || everyToken(tokens, candidate.title)) return "Title";
  if (fallback === "summary match") return "Summary";
  if (everyToken(tokens, candidate.domain)) return "Site";
  if (everyToken(tokens, candidate.path)) return "URL";
  if (fallback === "title match") return "Title";
  if (fallback === "domain match") return "Site";
  return "URL";
}

function everyToken(tokens, value) {
  const normalized = searchable(value);
  return tokens.every(token => normalized.includes(token));
}

function recencyBoost(timestamp, now) {
  if (!timestamp) return 0;
  const age = Math.max(0, Number(now) - timestamp);
  if (age <= 5 * 60 * 1000) return 6;
  if (age <= 60 * 60 * 1000) return 5;
  if (age <= 24 * 60 * 60 * 1000) return 4;
  if (age <= 7 * 24 * 60 * 60 * 1000) return 2;
  if (age <= 30 * 24 * 60 * 60 * 1000) return 1;
  return 0;
}

function searchable(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase();
}

function normalizeTags(value) {
  return [...new Set(array(value)
    .map(tag => String(tag || "").trim())
    .filter(Boolean))];
}

function protocol(value) {
  try {
    return new URL(value).protocol;
  } catch {
    return "";
  }
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function integer(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}
