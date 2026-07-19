// Shared recent-history cache for the secondary visualization pages.
//
// Graph, Sessions, and Stars are separate extension documents. Without a shared
// cache, the first visit to each document issues its own chrome.history.search
// against the profile database. On a large profile that repeatedly pays the
// cold database/page-cache cost. The MV3 service worker prewarms this snapshot;
// chrome.storage.session keeps it available across document and worker lifetimes
// without persisting browsing history to disk a second time.

const CACHE_KEY = "tabtopiaRecentHistoryV1";
const CACHE_VERSION = 1;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_HORIZON_MS = 180 * 24 * 60 * 60 * 1000;
const CACHE_MAX_RESULTS = 5000;

let memoryCache = null;
let refreshPromise = null;

function compactHistoryItem(item) {
  return {
    id: item.id,
    url: item.url,
    title: item.title,
    lastVisitTime: item.lastVisitTime,
    visitCount: item.visitCount,
    typedCount: item.typedCount
  };
}

function cacheCovers(cache, { text = "", startTime = 0, endTime, maxResults = 100 }) {
  if (text || endTime !== undefined) return false;
  if (!cache || cache.version !== CACHE_VERSION || !Array.isArray(cache.items)) return false;
  if (Date.now() - cache.fetchedAt > CACHE_TTL_MS) return false;
  if (cache.startTime > startTime) return false;
  return cache.maxResults >= maxResults;
}

function selectItems(cache, { startTime = 0, maxResults = 100 }) {
  return cache.items
    .filter(item => (item.lastVisitTime || 0) >= startTime)
    .slice(0, maxResults);
}

async function readCache() {
  if (memoryCache) return memoryCache;
  try {
    const stored = await chrome.storage.session.get(CACHE_KEY);
    memoryCache = stored[CACHE_KEY] || null;
  } catch (_error) {
    // storage.session may be unavailable in an older test/runtime. A direct
    // history query remains the correctness fallback.
  }
  return memoryCache;
}

async function writeCache(cache) {
  memoryCache = cache;
  try {
    await chrome.storage.session.set({ [CACHE_KEY]: cache });
  } catch (error) {
    console.warn("[HistoryCache] session cache write failed", error);
  }
}

export async function refreshRecentHistoryCache() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const started = performance.now();
    const startTime = Date.now() - CACHE_HORIZON_MS;
    const rawItems = await chrome.history.search({
      text: "",
      startTime,
      maxResults: CACHE_MAX_RESULTS
    });
    const items = rawItems.map(compactHistoryItem);

    // Do not pin an empty startup snapshot. Fresh profiles and E2E fixtures can
    // receive their first history rows immediately after the worker starts.
    if (items.length > 0) {
      await writeCache({
        version: CACHE_VERSION,
        fetchedAt: Date.now(),
        startTime,
        maxResults: CACHE_MAX_RESULTS,
        items
      });
    }
    console.debug(`[HistoryCache] prewarm ${items.length} rows in ${(performance.now() - started).toFixed(1)}ms`);
    return items;
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export async function getRecentHistory(options = {}) {
  const query = {
    text: options.text || "",
    startTime: options.startTime || 0,
    endTime: options.endTime,
    maxResults: options.maxResults || 100
  };
  const started = performance.now();
  const cache = await readCache();
  if (cacheCovers(cache, query)) {
    const items = selectItems(cache, query);
    console.debug(`[HistoryCache] hit ${items.length} rows in ${(performance.now() - started).toFixed(1)}ms`);
    return items;
  }

  const directQuery = {
    text: query.text,
    startTime: query.startTime,
    maxResults: query.maxResults
  };
  if (query.endTime !== undefined) directQuery.endTime = query.endTime;
  const items = await chrome.history.search(directQuery);
  console.debug(`[HistoryCache] direct ${items.length} rows in ${(performance.now() - started).toFixed(1)}ms`);
  return items;
}

export async function clearRecentHistoryCache() {
  memoryCache = null;
  try {
    await chrome.storage.session.remove(CACHE_KEY);
  } catch (_error) { }
}

export const recentHistoryCacheConfig = Object.freeze({
  key: CACHE_KEY,
  ttlMs: CACHE_TTL_MS,
  horizonMs: CACHE_HORIZON_MS,
  maxResults: CACHE_MAX_RESULTS
});
