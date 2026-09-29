import { readRecentContext, refreshRecentContext } from "../lib/recent-context-provider.js";
import { flattenBookmarkTree } from "../lib/bookmark-intent.js";
import { HOME_RECOMMENDATION_PREFS_KEY, readHomeRecommendationPreferences, collectHomeRecommendationIdentities } from "../lib/home-recommendations.js";
import {
  clearRecentHistoryCache,
  getRecentHistory,
  recentHistoryCacheConfig
} from "../lib/history-cache.js";
import { createBrowsingSnapshot } from "../lib/browsing-snapshot.js";
import {
  HABIT_DESTINATION_DEFAULTS,
  prepareHabitCandidatePool,
  rankHabitDestinations
} from "../lib/habit-destinations.js";
import { recognizeStartPageState } from "../lib/start-page-state.js";
import { forecastResumption } from "../lib/resumption-forecast.js";
import {
  archiveQueryForState,
  readCachedArchive,
  refreshArchive
} from "../lib/archive-provider.js";
import {
  readCachedTechmeme,
  refreshTechmeme
} from "../lib/techmeme-provider.js";
import {
  readCachedGithubStars,
  refreshGithubStars
} from "../lib/github-stars-provider.js";

const HISTORY_HORIZON_MS = 24 * 60 * 60 * 1000;
const HISTORY_ITEM_LIMIT = 80;
const HABIT_HISTORY_ITEM_LIMIT = recentHistoryCacheConfig.maxResults;
const PROVENANCE_ITEM_LIMIT = 60;
const VISITS_PER_ITEM_LIMIT = 64;
const RECENT_BOOKMARK_LIMIT = 64;
const REFRESH_DEBOUNCE_MS = 500;

/**
 * Canonical owner for the adaptive start-page data lifecycle.
 *
 * The development inspector and the visible homepage subscribe to this same
 * controller. Neither renderer owns Chrome listeners, cache invalidation, or
 * candidate collection, so visual experiments cannot fork product truth.
 */
export function createStartPageController({
  onUpdate = () => {},
  onError = () => {}
} = {}) {
  let refreshTimer = null;
  let refreshInFlight = null;
  let refreshRequested = false;
  let archiveRefreshInFlight = null;
  let contextRefreshInFlight = null;
  let techmemeRefreshInFlight = null;
  let githubStarsRefreshInFlight = null;
  let activeArchiveQuery = null;
  let pendingArchiveQuery;
  let started = false;
  const removers = [];

  function listen(event, listener) {
    if (!event?.addListener) return;
    event.addListener(listener);
    removers.push(() => event.removeListener?.(listener));
  }

  function installListeners() {
    listen(chrome.storage?.onChanged, (changes, area) => {
      if (area === "local" && (changes.tabtopiaContextHiddenSitesV1 || changes[HOME_RECOMMENDATION_PREFS_KEY])) scheduleRefresh();
    });
    listen(chrome.tabs.onCreated, () => scheduleRefresh());
    listen(chrome.tabs.onRemoved, () => scheduleRefresh());
    listen(chrome.tabs.onActivated, () => scheduleRefresh());
    listen(chrome.tabs.onUpdated, (_tabId, changeInfo) => {
      if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") scheduleRefresh();
    });
    listen(chrome.windows.onCreated, () => scheduleRefresh());
    listen(chrome.windows.onRemoved, () => scheduleRefresh());
    listen(chrome.windows.onFocusChanged, () => scheduleRefresh());
    const bookmarksChanged = () => { bookmarkTreeCache = null; scheduleRefresh(); };
    listen(chrome.bookmarks?.onCreated, bookmarksChanged);
    listen(chrome.bookmarks?.onRemoved, bookmarksChanged);
    listen(chrome.bookmarks?.onChanged, bookmarksChanged);
    listen(chrome.bookmarks?.onMoved, bookmarksChanged);
    listen(chrome.history.onVisited, () => invalidateHistoryAndRefresh());
    listen(chrome.history.onVisitRemoved, () => invalidateHistoryAndRefresh());
  }

  function invalidateHistoryAndRefresh() {
    clearRecentHistoryCache()
      .catch(() => {})
      .finally(() => scheduleRefresh());
  }

  function scheduleRefresh(delay = REFRESH_DEBOUNCE_MS) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh().catch(() => {});
    }, delay);
  }

  async function refresh() {
    if (refreshInFlight) {
      refreshRequested = true;
      return refreshInFlight;
    }
    refreshInFlight = collectStartPageState()
      .then(result => {
        onUpdate(result);
        refreshArchiveInBackground(result);
        if (!contextRefreshInFlight) {
          contextRefreshInFlight = refreshRecentContext()
            .then(update => { if (started && update.changed) scheduleRefresh(0); })
            .catch(() => {})
            .finally(() => { contextRefreshInFlight = null; });
        }
        refreshTechmemeInBackground();
        refreshGithubStarsInBackground();
        return result;
      })
      .catch(error => {
        onError(error);
        throw error;
      })
      .finally(() => {
        refreshInFlight = null;
        if (refreshRequested) {
          refreshRequested = false;
          if (started) scheduleRefresh(0);
        }
      });
    return refreshInFlight;
  }

  function refreshArchiveInBackground(result) {
    const query = result?.archiveQuery || "";
    if (archiveRefreshInFlight) {
      if (query !== activeArchiveQuery) pendingArchiveQuery = query;
      return;
    }
    activeArchiveQuery = query;
    archiveRefreshInFlight = refreshArchive({ query })
      .then(update => {
        if (started && update?.changed) scheduleRefresh(0);
      })
      .catch(() => {})
      .finally(() => {
        archiveRefreshInFlight = null;
        activeArchiveQuery = null;
        if (!started || pendingArchiveQuery === undefined) return;
        const nextQuery = pendingArchiveQuery;
        pendingArchiveQuery = undefined;
        refreshArchiveInBackground({ archiveQuery: nextQuery });
      });
  }

  function refreshTechmemeInBackground() {
    if (techmemeRefreshInFlight) return;
    techmemeRefreshInFlight = refreshTechmeme()
      .then(update => {
        if (started && update?.changed) scheduleRefresh(0);
      })
      .catch(() => {})
      .finally(() => {
        techmemeRefreshInFlight = null;
      });
  }

  function refreshGithubStarsInBackground() {
    if (githubStarsRefreshInFlight) return;
    githubStarsRefreshInFlight = refreshGithubStars()
      .then(update => {
        if (started && update?.changed) scheduleRefresh(0);
      })
      .catch(() => {})
      .finally(() => {
        githubStarsRefreshInFlight = null;
      });
  }

  function start() {
    if (started) return;
    started = true;
    installListeners();
    scheduleRefresh(0);
  }

  function stop() {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    removers.splice(0).forEach(remove => remove());
    pendingArchiveQuery = undefined;
    started = false;
  }

  return { start, stop, refresh, scheduleRefresh };
}

export async function collectStartPageState(now = Date.now()) {
  const [
    currentWindow,
    windows,
    historyPool,
    backgroundState,
    bookmarks,
    archiveSnapshot,
    techmemeSnapshot,
    githubStarsSnapshot,
    recentContextSnapshot,
    recommendationBookmarks,
    recommendationPreferences
  ] = await Promise.all([
    getCurrentWindow(),
    getAllWindows(),
    getRecentHistory({
      startTime: now - recentHistoryCacheConfig.horizonMs,
      maxResults: HABIT_HISTORY_ITEM_LIMIT
    }),
    getBackgroundState(),
    getRecentBookmarks(RECENT_BOOKMARK_LIMIT),
    readCachedArchive({ now }),
    readCachedTechmeme({ now }),
    readCachedGithubStars({ now }),
    readRecentContext({ now, development: await isDevelopmentInstall() }),
    getRecommendationBookmarks(),
    readHomeRecommendationPreferences({ development: await isDevelopmentInstall() })
  ]);
  const historyItems = historyPool
    .filter(item => Number(item?.lastVisitTime || 0) >= now - HISTORY_HORIZON_MS)
    .slice(0, HISTORY_ITEM_LIMIT);
  const habitPool = prepareHabitCandidatePool(historyPool, {
    maxScoredPages: HABIT_DESTINATION_DEFAULTS.maxScoredPages
  });
  const [visitsByUrl, historyScores] = await Promise.all([
    getRecentVisitProvenance(historyItems.slice(0, PROVENANCE_ITEM_LIMIT), now),
    scoreHabitHistory(habitPool.candidates)
  ]);
  const snapshot = createBrowsingSnapshot({
    now,
    currentWindowId: currentWindow?.id,
    windows,
    historyItems,
    visitsByUrl,
    activityByTab: Object.fromEntries(backgroundState?.tabActivityLog || []),
    tabHistory: backgroundState?.tabHistory || [],
    tabRelationships: backgroundState?.tabRelationships || []
  });
  const recognition = recognizeStartPageState(snapshot, {
    nonReturnWindowEstimate: backgroundState?.nonReturnWindow || null,
    ...(backgroundState?.nonReturnWindow?.status === "ready"
      ? { interruptionMs: backgroundState.nonReturnWindow.boundaryMs }
      : {})
  });
  const forecast = forecastResumption(snapshot, { state: recognition.state });
  const archiveQuery = archiveQueryForState({ snapshot, forecast });
  const currentArchiveSnapshot = archiveSnapshotForQuery(archiveSnapshot, archiveQuery);
  const habitDestinations = rankHabitDestinations({
    pool: habitPool,
    historyScores,
    openTabs: windows.flatMap(window => window.tabs || []),
    now,
    limit: HABIT_DESTINATION_DEFAULTS.resultLimit
  });

  const identities = collectHomeRecommendationIdentities({ context: recentContextSnapshot,
    history: historyPool, bookmarks: recommendationBookmarks, preferences: recommendationPreferences });
  const recommendationFeedback = await chrome.runtime.sendMessage({
    action: "getHomeRecommendationFeedback", identities
  }).then(result => result?.feedback || {}).catch(() => ({}));
  const bookmarkEvidence = await chrome.runtime.sendMessage({
    action: "getBookmarkIntentEvidence", pages: recommendationBookmarks.filter(page => page.mobileFolder)
      .sort((a, b) => Number(b.dateAdded || 0) - Number(a.dateAdded || 0)).slice(0, 800)
  }).then(result => result?.evidence || {}).catch(() => ({}));
  for (const bookmark of recommendationBookmarks) Object.assign(bookmark, bookmarkEvidence[bookmark.url] || {});

  return {
    generatedAt: now,
    windows,
    historyPool,
    bookmarks,
    snapshot,
    recognition,
    forecast,
    habitDestinations,
    archiveSnapshot: currentArchiveSnapshot,
    archiveQuery,
    techmemeSnapshot,
    githubStarsSnapshot,
    recentContextSnapshot,
    recommendationBookmarks,
    recommendationPreferences,
    recommendationFeedback
  };
}

function archiveSnapshotForQuery(snapshot, query) {
  if (!snapshot || snapshot.query === query || !snapshot.query) return snapshot;
  return {
    ...snapshot,
    related: [],
    freshness: {
      ...snapshot.freshness,
      related: query ? "empty" : "unused"
    }
  };
}

async function getRecentVisitProvenance(historyItems, now) {
  const cutoff = now - HISTORY_HORIZON_MS;
  const entries = await Promise.all(historyItems.map(async item => [
    item.url,
    (await getVisits(item.url))
      .filter(visit => Number(visit?.visitTime || 0) >= cutoff)
      .sort((left, right) => Number(left?.visitTime || 0) - Number(right?.visitTime || 0))
      .slice(-VISITS_PER_ITEM_LIMIT)
  ]));
  return Object.fromEntries(entries);
}

function getVisits(url) {
  return new Promise(resolve => {
    chrome.history.getVisits({ url }, visits => {
      if (chrome.runtime.lastError) return resolve([]);
      resolve(Array.isArray(visits) ? visits : []);
    });
  });
}

function getAllWindows() {
  return new Promise((resolve, reject) => {
    chrome.windows.getAll({ populate: true }, windows => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(windows || []);
    });
  });
}

function getCurrentWindow() {
  return new Promise((resolve, reject) => {
    chrome.windows.getCurrent(window => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(window || null);
    });
  });
}

function getBackgroundState() {
  return chrome.runtime.sendMessage({ action: "getState" }).catch(() => ({
    tabActivityLog: [],
    tabHistory: [],
    tabRelationships: []
  }));
}

function getRecentBookmarks(limit) {
  if (!chrome.bookmarks?.getRecent) return Promise.resolve([]);
  return chrome.bookmarks.getRecent(limit).catch(() => []);
}

let bookmarkTreeCache = null;
function getRecommendationBookmarks() {
  if (!chrome.bookmarks?.getTree) return Promise.resolve([]);
  if (!bookmarkTreeCache) bookmarkTreeCache = chrome.bookmarks.getTree().then(flattenBookmarkTree)
    .catch(() => { bookmarkTreeCache = null; return []; });
  return bookmarkTreeCache.then(pages => pages.map(page => ({ ...page })));
}

async function scoreHabitHistory(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  try {
    const response = await chrome.runtime.sendMessage({
      action: "scoreHabitHistory",
      candidates: candidates.map(candidate => ({
        key: candidate.key,
        url: candidate.url
      }))
    });
    return response?.success && Array.isArray(response.scores) ? response.scores : [];
  } catch {
    return [];
  }
}

let developmentInstall;
async function isDevelopmentInstall() {
  if (!developmentInstall) developmentInstall = new Promise(resolve => {
    try { chrome.management.getSelf(self => resolve(self?.installType === "development")); } catch { resolve(false); }
  });
  return developmentInstall;
}
