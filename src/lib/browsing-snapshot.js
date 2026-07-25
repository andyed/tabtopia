import { buildBrowsingNeighborhoods } from "./browsing-neighborhoods.js";

const SNAPSHOT_VERSION = 1;

const MEANINGFUL_PROTOCOLS = new Set(["http:", "https:", "file:"]);

export const DENSITY_REGIMES = Object.freeze({
  EMPTY: "empty",
  DIRECT: "direct",
  ROUTE: "route",
  MICROGRAPH: "micrograph",
  CLUSTER: "cluster",
  NEIGHBORHOODS: "neighborhoods"
});

export function createBrowsingSnapshot({
  now = Date.now(),
  timezoneOffsetMinutes = new Date(now).getTimezoneOffset(),
  currentWindowId = null,
  windows = [],
  historyItems = [],
  visitsByUrl = {},
  activityByTab = {},
  tabHistory = [],
  tabRelationships = []
} = {}) {
  const normalizedWindows = windows
    .map(window => normalizeWindow(window, activityByTab))
    .filter(Boolean);
  const currentWindow = normalizedWindows.find(window => window.id === currentWindowId)
    || normalizedWindows.find(window => window.focused)
    || normalizedWindows[0]
    || emptyWindow(currentWindowId);
  const otherWindows = normalizedWindows.filter(window => window.id !== currentWindow.id);
  const currentTabs = currentWindow.tabs.filter(isMeaningfulTab);
  const otherTabs = otherWindows.flatMap(window => window.tabs.filter(isMeaningfulTab));
  const meaningfulTabs = [...currentTabs, ...otherTabs];
  const normalizedHistory = normalizeHistory(historyItems, visitsByUrl);
  const localHistory = normalizedHistory.filter(item => item.isLocal !== false);
  const foreignHistory = normalizedHistory.filter(item => item.isLocal === false);
  const latestLiveActivityAt = maxTimestamp(meaningfulTabs.map(tab => tab.lastAccessed));
  const latestLocalHistoryAt = maxTimestamp(localHistory.map(item => item.visitTime));
  const latestForeignAt = maxTimestamp(foreignHistory.map(item => item.visitTime));
  const latestMeaningfulActivityAt = Math.max(latestLiveActivityAt, latestLocalHistoryAt);
  const interruptionGapMs = latestMeaningfulActivityAt > 0
    ? Math.max(0, now - latestMeaningfulActivityAt)
    : null;
  const crossedLocalDayBoundary = latestMeaningfulActivityAt > 0
    ? localDayKey(now, timezoneOffsetMinutes) !== localDayKey(latestMeaningfulActivityAt, timezoneOffsetMinutes)
    : false;

  const neighborhoods = buildBrowsingNeighborhoods({
    tabs: meaningfulTabs,
    visits: normalizedHistory.filter(item => isMeaningfulUrl(item.url)),
    tabHistory,
    tabRelationships,
    activityByTab,
    now
  }).map(neighborhood => ({
    ...neighborhood,
    inCurrentWindow: neighborhood.items.some(item => item.windowId === currentWindow.id),
    density: densityRegimeForCount(neighborhood.itemCount)
  }));
  const neighborhoodEdges = neighborhoods.flatMap(neighborhood => neighborhood.edges);

  return {
    version: SNAPSHOT_VERSION,
    generatedAt: now,
    currentWindow: {
      ...currentWindow,
      tabs: currentTabs,
      isClean: currentTabs.length === 0,
      density: densityRegimeForCount(currentTabs.length)
    },
    otherWindows: otherWindows.map(window => {
      const tabs = window.tabs.filter(isMeaningfulTab);
      return {
        ...window,
        tabs,
        density: densityRegimeForCount(tabs.length)
      };
    }),
    tabs: meaningfulTabs,
    history: {
      items: normalizedHistory,
      localItems: localHistory,
      foreignItems: foreignHistory,
      latestLocalAt: latestLocalHistoryAt,
      latestForeignAt
    },
    activity: {
      latestLiveAt: latestLiveActivityAt,
      latestMeaningfulAt: latestMeaningfulActivityAt,
      interruptionGapMs,
      crossedLocalDayBoundary,
      timezoneOffsetMinutes
    },
    neighborhoods,
    topology: {
      edgeCount: neighborhoodEdges.length,
      structuralEdgeCount: neighborhoodEdges.filter(edge =>
        edge.types.includes("spawn") || edge.types.includes("referrer")).length,
      temporalEdgeCount: neighborhoodEdges.filter(edge => edge.types.includes("temporal")).length,
      openItemCount: neighborhoods.reduce((sum, item) => sum + item.openCount, 0),
      recoveredItemCount: neighborhoods.reduce((sum, item) => sum + item.recoveredCount, 0)
    },
    availability: {
      liveWindows: normalizedWindows.length > 0,
      recentHistory: normalizedHistory.length > 0,
      foreignProvenance: normalizedHistory.some(item => typeof item.isLocal === "boolean"),
      relationshipEvidence: neighborhoodEdges.length > 0,
      recoveredWork: neighborhoods.some(neighborhood => neighborhood.recoveredCount > 0)
    }
  };
}

export function isMeaningfulTab(tab) {
  if (!tab || tab.incognito || !tab.url) return false;
  return isMeaningfulUrl(tab.url);
}

export function isMeaningfulUrl(url) {
  try {
    return MEANINGFUL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function densityRegimeForCount(count) {
  const safeCount = Math.max(0, Number(count) || 0);
  if (safeCount === 0) return DENSITY_REGIMES.EMPTY;
  if (safeCount <= 2) return DENSITY_REGIMES.DIRECT;
  if (safeCount <= 7) return DENSITY_REGIMES.ROUTE;
  if (safeCount <= 15) return DENSITY_REGIMES.MICROGRAPH;
  if (safeCount <= 30) return DENSITY_REGIMES.CLUSTER;
  return DENSITY_REGIMES.NEIGHBORHOODS;
}

function normalizeWindow(window, activityByTab) {
  if (!window || window.id === undefined || window.id === null) return null;
  return {
    id: window.id,
    focused: Boolean(window.focused),
    tabs: (Array.isArray(window.tabs) ? window.tabs : []).map(tab => normalizeTab(tab, activityByTab))
  };
}

function normalizeTab(tab, activityByTab) {
  const activity = readActivity(activityByTab, tab?.id);
  return {
    id: tab?.id,
    windowId: tab?.windowId,
    title: String(tab?.title || "Untitled"),
    url: String(tab?.url || ""),
    active: Boolean(tab?.active),
    pinned: Boolean(tab?.pinned),
    audible: Boolean(tab?.audible),
    incognito: Boolean(tab?.incognito),
    openerTabId: tab?.openerTabId ?? null,
    lastAccessed: latestTabActivity(tab, activity)
  };
}

function normalizeHistory(historyItems, visitsByUrl) {
  return (Array.isArray(historyItems) ? historyItems : []).flatMap(item => {
    if (!item?.url) return [];
    const visits = readVisits(visitsByUrl, item.url);
    if (visits.length === 0) {
      return [{
        url: item.url,
        title: item.title || "Untitled",
        visitTime: Number(item.lastVisitTime || 0),
        isLocal: typeof item.isLocal === "boolean" ? item.isLocal : undefined
      }];
    }
    return visits.map(visit => ({
      url: item.url,
      title: item.title || "Untitled",
      visitTime: Number(visit.visitTime || item.lastVisitTime || 0),
      isLocal: typeof visit.isLocal === "boolean" ? visit.isLocal : undefined,
      transition: visit.transition || undefined,
      // Chrome's referral chain is the only structural evidence that outlives
      // the tab it was created in, so it has to survive normalization.
      visitId: visit.visitId ?? visit.id ?? undefined,
      referringVisitId: normalizeVisitId(visit.referringVisitId)
    }));
  }).filter(item => Number.isFinite(item.visitTime) && item.visitTime > 0);
}

// Chrome reports "0" for a visit that had no referrer. Treat it as absent so it
// cannot become a node key that every unreferred visit collides on.
function normalizeVisitId(value) {
  if (value === undefined || value === null) return undefined;
  const asString = String(value);
  return asString === "0" || asString === "" ? undefined : asString;
}

function latestTabActivity(tab, activity) {
  const candidates = [Number(tab?.lastAccessed || 0), Number(activity?.lastTouch || 0)];
  for (const event of Array.isArray(activity?.events) ? activity.events : []) {
    candidates.push(Number(event?.timestamp || 0));
  }
  for (const navigation of Array.isArray(activity?.navigations) ? activity.navigations : []) {
    candidates.push(Number(navigation?.timestamp || 0));
  }
  return maxTimestamp(candidates);
}

function readActivity(activityByTab, tabId) {
  if (activityByTab instanceof Map) return activityByTab.get(tabId) || activityByTab.get(String(tabId));
  return activityByTab?.[tabId] || activityByTab?.[String(tabId)] || {};
}

function readVisits(visitsByUrl, url) {
  if (visitsByUrl instanceof Map) return visitsByUrl.get(url) || [];
  return Array.isArray(visitsByUrl?.[url]) ? visitsByUrl[url] : [];
}

function maxTimestamp(values) {
  const finite = values.map(Number).filter(value => Number.isFinite(value) && value > 0);
  return finite.length > 0 ? Math.max(...finite) : 0;
}

function localDayKey(timestamp, timezoneOffsetMinutes) {
  const offsetMs = Number(timezoneOffsetMinutes || 0) * 60 * 1000;
  return new Date(Number(timestamp) - offsetMs).toISOString().slice(0, 10);
}

function emptyWindow(id) {
  return { id, focused: true, tabs: [] };
}
