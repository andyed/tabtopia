import { normalizeIdentity } from "./revisit-model.js";
import { flattenBookmarkTree } from "./bookmark-intent.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const BOOKMARK_RECENCY_HALF_LIFE_MS = 30 * DAY_MS;
const DEFAULT_RESULT_LIMIT = 10;
const MAX_RESULT_LIMIT = 24;
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

export const DEFERRED_INTENTION_DEFAULTS = Object.freeze({
  bookmarkRecencyHalfLifeMs: BOOKMARK_RECENCY_HALF_LIFE_MS,
  resultLimit: DEFAULT_RESULT_LIMIT,
  maxResultLimit: MAX_RESULT_LIMIT
});

/**
 * Build a bounded lane of bookmark-backed actions that may represent an
 * intention saved for later.
 *
 * Bookmark recency remains a continuous signal. Current History is used only
 * to report whether the page was revisited after it was saved; without dwell
 * evidence, this module makes no claim about the quality of that revisit.
 */
export function buildDeferredIntentions({
  bookmarks = [],
  historyItems = [],
  openTabs = [],
  now = Date.now(),
  limit = DEFAULT_RESULT_LIMIT,
  bookmarkRecencyHalfLifeMs = BOOKMARK_RECENCY_HALF_LIFE_MS
} = {}) {
  const generatedAt = finiteTimestamp(now) || Date.now();
  const halfLifeMs = positiveNumber(bookmarkRecencyHalfLifeMs)
    || BOOKMARK_RECENCY_HALF_LIFE_MS;
  const historyByPage = indexHistory(historyItems);
  const bookmarksByPage = new Map();

  for (const bookmark of flattenBookmarkTree(bookmarks)) {
    const url = String(bookmark?.url || "");
    if (!isEligibleUrl(url)) continue;
    const identity = normalizeIdentity(url);
    if (!identity) continue;

    const candidate = normalizeBookmark(bookmark, identity);
    const existing = bookmarksByPage.get(identity.page);
    bookmarksByPage.set(identity.page, existing
      ? mergeBookmarks(existing, candidate)
      : candidate);
  }

  const ranked = [...bookmarksByPage.values()].map(bookmark => {
    const history = historyByPage.get(bookmark.normalizedPage);
    const lastVisitTime = finiteTimestamp(history?.lastVisitTime);
    const revisitedAfterSave = bookmark.bookmarkedAt > 0
      && lastVisitTime > bookmark.bookmarkedAt;
    const ageMs = bookmark.bookmarkedAt > 0
      ? Math.max(0, generatedAt - bookmark.bookmarkedAt)
      : null;
    const bookmarkRecency = ageMs === null
      ? 0
      : Math.pow(2, -ageMs / halfLifeMs);
    const openTab = findExactOpenTab(bookmark.normalizedPage, openTabs);
    const target = openTab
      ? { ...openTab, open: true }
      : {
          url: bookmark.url,
          title: bookmark.title,
          open: false
        };

    return {
      id: `star:${bookmark.primaryBookmarkId}`,
      kind: "deferred-intention",
      source: "star",
      score: bookmarkRecency,
      action: {
        verb: openTab ? "switch" : "open",
        target
      },
      cues: {
        bookmarkedAt: bookmark.bookmarkedAt,
        bookmarkAgeMs: ageMs,
        bookmarkRecency,
        mobileFolder: bookmark.mobileFolder,
        lastVisitTime,
        revisitedAfterSave,
        bookmarkCount: bookmark.bookmarkCount
      },
      reasons: reasonsForBookmark({
        bookmarkedAt: bookmark.bookmarkedAt,
        revisitedAfterSave,
        open: Boolean(openTab)
      })
    };
  }).sort(compareDeferredIntentions);

  const safeLimit = boundedLimit(limit);
  return {
    generatedAt,
    source: "star",
    candidates: ranked.slice(0, safeLimit),
    suppressedCount: Math.max(0, ranked.length - safeLimit),
    totalEligibleBookmarks: ranked.length
  };
}

function normalizeBookmark(bookmark, identity) {
  const id = String(bookmark?.id ?? "");
  return {
    normalizedPage: identity.page,
    domain: identity.domain,
    url: String(bookmark.url),
    title: String(bookmark.title || identity.domain || "Untitled"),
    bookmarkedAt: finiteTimestamp(bookmark.dateAdded),
    mobileFolder: Boolean(bookmark.mobileFolder),
    primaryBookmarkId: id || identity.page,
    bookmarkIds: id ? [id] : [],
    bookmarkCount: 1
  };
}

function mergeBookmarks(existing, incoming) {
  const incomingIsNewer = incoming.bookmarkedAt > existing.bookmarkedAt
    || (incoming.bookmarkedAt === existing.bookmarkedAt
      && incoming.primaryBookmarkId.localeCompare(existing.primaryBookmarkId) < 0);
  const representative = incomingIsNewer ? incoming : existing;
  return {
    ...representative,
    normalizedPage: existing.normalizedPage,
    domain: existing.domain,
    mobileFolder: existing.mobileFolder || incoming.mobileFolder,
    bookmarkIds: [...new Set([...existing.bookmarkIds, ...incoming.bookmarkIds])].sort(),
    bookmarkCount: existing.bookmarkCount + incoming.bookmarkCount
  };
}

function indexHistory(historyItems) {
  const byPage = new Map();
  for (const item of Array.isArray(historyItems) ? historyItems : []) {
    const identity = normalizeIdentity(item?.url || "");
    if (!identity || !isEligibleUrl(item.url)) continue;
    const lastVisitTime = finiteTimestamp(item?.lastVisitTime);
    const existing = byPage.get(identity.page);
    if (!existing || lastVisitTime > existing.lastVisitTime) {
      byPage.set(identity.page, { lastVisitTime });
    }
  }
  return byPage;
}

function findExactOpenTab(normalizedPage, openTabs) {
  return (Array.isArray(openTabs) ? openTabs : [])
    .filter(tab => !tab?.incognito && normalizeIdentity(tab?.url || "")?.page === normalizedPage)
    .sort((left, right) => finiteTimestamp(right?.lastAccessed) - finiteTimestamp(left?.lastAccessed)
      || compareIds(left?.id, right?.id))[0] || null;
}

function reasonsForBookmark({ bookmarkedAt, revisitedAfterSave, open }) {
  const reasons = [];
  reasons.push(bookmarkedAt > 0
    ? "saved for later; bookmark recency retained as continuous evidence"
    : "saved for later; save time unavailable");
  reasons.push(revisitedAfterSave
    ? "revisited after saving; intent remains uncertain"
    : "not revisited in available History after saving");
  if (open) reasons.push("already open — this action switches to the page");
  return reasons;
}

function compareDeferredIntentions(left, right) {
  return Number(right.cues.mobileFolder) - Number(left.cues.mobileFolder)
    || right.cues.bookmarkRecency - left.cues.bookmarkRecency
    || right.cues.bookmarkedAt - left.cues.bookmarkedAt
    || left.action.target.url.localeCompare(right.action.target.url)
    || left.id.localeCompare(right.id);
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
  if (!Number.isFinite(number)) return DEFAULT_RESULT_LIMIT;
  return Math.max(0, Math.min(MAX_RESULT_LIMIT, Math.floor(number)));
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function compareIds(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return String(left ?? "").localeCompare(String(right ?? ""));
}
