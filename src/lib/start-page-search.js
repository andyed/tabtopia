import { normalizeIdentity } from "./revisit-model.js";
import { normalizeQuery, scoreText } from "./tab-recall.js";

const DEFAULT_LIMIT = 16;
const MAX_LIMIT = 50;

/**
 * Build a deterministic, list-first retrieval set for a start-page query.
 *
 * Text match is the admission gate. Recent access and repeat visits only break
 * ambiguity between matching pages; they can never make an unrelated page
 * appear. Open tabs and Chrome History merge by stable page identity so the
 * SERP can offer Switch without showing the same URL twice.
 */
export function buildStartPageSearchResults({
  query = "",
  openItems = [],
  historyItems = [],
  now = Date.now(),
  limit = DEFAULT_LIMIT
} = {}) {
  const tokens = normalizeQuery(query);
  if (tokens.length === 0) return [];

  const byPage = new Map();
  for (const raw of array(historyItems)) mergeCandidate(byPage, historyCandidate(raw));
  for (const raw of array(openItems)) mergeCandidate(byPage, openCandidate(raw));

  const phrase = tokens.join(" ");
  const ranked = [];
  for (const candidate of byPage.values()) {
    const text = scoreText(tokens, candidate);
    if (text.score <= 0) continue;
    const normalizedTitle = searchable(candidate.title);
    const exactTitle = normalizedTitle === phrase;
    const titlePhrase = normalizedTitle.includes(phrase);
    const lastSeenAt = Math.max(candidate.lastAccessed, candidate.lastVisitTime);
    const rankScore = text.score
      + (exactTitle ? 20 : titlePhrase ? 4 : 0)
      + recencyBoost(lastSeenAt, now)
      + Math.min(2, Math.log2(Math.max(1, candidate.visitCount)))
      + (candidate.open ? 0.5 : 0);
    ranked.push({
      ...candidate,
      lastSeenAt,
      matchKind: matchKind(tokens, candidate, exactTitle, titlePhrase, text.reason),
      rankScore
    });
  }

  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(limit) || DEFAULT_LIMIT)));
  return ranked
    .sort((left, right) => (right.rankScore - left.rankScore)
      || (right.lastSeenAt - left.lastSeenAt)
      || left.title.localeCompare(right.title)
      || left.url.localeCompare(right.url))
    .slice(0, safeLimit)
    .map(({ rankScore: _rankScore, ...result }) => result);
}

function historyCandidate(raw) {
  if (!raw || typeof raw !== "object") return null;
  return baseCandidate(raw, {
    open: false,
    tabId: null,
    windowId: null,
    lastAccessed: 0,
    lastVisitTime: positiveNumber(raw.lastVisitTime),
    visitCount: Math.max(1, Math.floor(Number(raw.visitCount) || 1))
  });
}

function openCandidate(raw) {
  const source = raw?.data && typeof raw.data === "object" ? raw.data : raw;
  if (!source || typeof source !== "object") return null;
  return baseCandidate(source, {
    open: true,
    tabId: integer(source.id ?? raw?.tabId),
    windowId: integer(source.windowId ?? raw?.windowId),
    lastAccessed: positiveNumber(source.lastAccessed),
    lastVisitTime: 0,
    visitCount: 0
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

  const open = existing.open || candidate.open;
  const openSource = candidate.open ? candidate : existing.open ? existing : null;
  const recentSource = candidate.lastVisitTime >= existing.lastVisitTime ? candidate : existing;
  byPage.set(candidate.id, {
    ...existing,
    title: openSource?.title || recentSource.title || existing.title,
    url: openSource?.url || recentSource.url || existing.url,
    domain: openSource?.domain || recentSource.domain || existing.domain,
    path: openSource?.path || recentSource.path || existing.path,
    open,
    tabId: openSource?.tabId ?? null,
    windowId: openSource?.windowId ?? null,
    lastAccessed: Math.max(existing.lastAccessed, candidate.lastAccessed),
    lastVisitTime: Math.max(existing.lastVisitTime, candidate.lastVisitTime),
    visitCount: Math.max(existing.visitCount, candidate.visitCount)
  });
}

function matchKind(tokens, candidate, exactTitle, titlePhrase, fallback) {
  if (exactTitle) return "Exact title";
  if (titlePhrase || everyToken(tokens, candidate.title)) return "Title";
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
