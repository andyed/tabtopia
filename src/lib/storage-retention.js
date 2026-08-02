const DEFAULT_MAX_HERO_PAGES = 160;
const MAX_HERO_IMAGES_PER_PAGE = 3;
const MAX_URL_LENGTH = 4096;
const MAX_ALT_LENGTH = 280;
const MAX_TITLE_LENGTH = 320;
const DEFAULT_BROWSER_STATE_BYTES = 2 * 1024 * 1024;
const DEFAULT_BROWSER_STATE_TABS = 128;
const DEFAULT_TAB_HISTORY_ENTRIES = 50;
const DEFAULT_ACTIVITY_EVENTS = 48;
const DEFAULT_ACTIVITY_NAVIGATIONS = 48;
const DEFAULT_RELATIONSHIP_CHILDREN = 24;
const MAX_STATE_URL_LENGTH = 2048;
const MAX_STATE_TEXT_LENGTH = 512;
const MAX_STATE_LABEL_LENGTH = 120;

/**
 * Keep hero recall useful without letting arbitrary page metadata consume the
 * extension's entire chrome.storage.local quota.
 */
export function compactHeroImageStore(store, { maxEntries = DEFAULT_MAX_HERO_PAGES } = {}) {
  const safeLimit = Math.max(0, Math.floor(Number(maxEntries) || 0));
  if (!store || typeof store !== "object" || Array.isArray(store) || safeLimit === 0) return {};

  return Object.fromEntries(Object.entries(store)
    .filter(([pageUrl]) => isPublicHttpUrl(pageUrl))
    .map(([pageUrl, record]) => [pageUrl, compactHeroImageRecord(record)])
    .filter(([, record]) => record.images.length > 0)
    .sort((left, right) => right[1].timestamp - left[1].timestamp
      || left[0].localeCompare(right[0]))
    .slice(0, safeLimit));
}

export function mergeHeroImageStore(store, pageUrl, record, options) {
  if (!isPublicHttpUrl(pageUrl)) return compactHeroImageStore(store, options);
  const compactRecord = compactHeroImageRecord(record);
  if (compactRecord.images.length === 0) return compactHeroImageStore(store, options);
  return compactHeroImageStore({ ...object(store), [pageUrl]: compactRecord }, options);
}

export function compactHeroImageRecord(record) {
  const source = record && typeof record === "object" ? record : {};
  const seen = new Set();
  const images = array(source.images)
    .filter(image => image && typeof image === "object" && isPublicHttpUrl(image.src))
    .filter(image => {
      const src = String(image.src);
      if (seen.has(src)) return false;
      seen.add(src);
      return true;
    })
    .sort((left, right) => number(right.score) - number(left.score))
    .slice(0, MAX_HERO_IMAGES_PER_PAGE)
    .map(image => ({
      src: String(image.src),
      width: nonNegativeInteger(image.width),
      height: nonNegativeInteger(image.height),
      score: number(image.score),
      alt: boundedText(image.alt, MAX_ALT_LENGTH),
      isMetaImage: Boolean(image.isMetaImage),
      isWikiImage: Boolean(image.isWikiImage),
      isWikiContentImage: Boolean(image.isWikiContentImage)
    }));

  return {
    images,
    title: boundedText(source.title, MAX_TITLE_LENGTH),
    timestamp: positiveNumber(source.timestamp) || Date.now(),
    dwellTime: nonNegativeInteger(source.dwellTime ?? source.metrics?.dwellTime),
    scrollDepth: nonNegativeInteger(source.scrollDepth ?? source.metrics?.scrollDepth)
  };
}

export function isStorageQuotaError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("quota") || message.includes("kquotabytes");
}

/**
 * Convert the durable tab-state corpus into a recent, live-tab-only snapshot.
 * Chrome tab/window APIs remain the source of truth; this store is enrichment,
 * so stale browser-session tab ids and unlimited event tails have no value.
 */
export function compactBrowserState(state, {
  liveTabIds,
  maxBytes = DEFAULT_BROWSER_STATE_BYTES,
  maxTabs = DEFAULT_BROWSER_STATE_TABS,
  maxHistoryEntries = DEFAULT_TAB_HISTORY_ENTRIES,
  maxEvents = DEFAULT_ACTIVITY_EVENTS,
  maxNavigations = DEFAULT_ACTIVITY_NAVIGATIONS,
  maxChildren = DEFAULT_RELATIONSHIP_CHILDREN
} = {}) {
  const source = object(state);
  const byteLimit = Math.max(16 * 1024, nonNegativeInteger(maxBytes));
  const tabLimit = Math.max(0, nonNegativeInteger(maxTabs));
  const eligibleIds = eligibleTabIds(source, liveTabIds)
    .sort((left, right) => stateRecency(source, right) - stateRecency(source, left)
      || left.localeCompare(right))
    .slice(0, tabLimit);

  let retainedIds = eligibleIds;
  let caps = {
    history: nonNegativeInteger(maxHistoryEntries),
    events: nonNegativeInteger(maxEvents),
    navigations: nonNegativeInteger(maxNavigations),
    children: nonNegativeInteger(maxChildren)
  };
  let compacted = buildCompactedBrowserState(source, retainedIds, caps);

  // A small fixed number of halving passes gives deterministic, cheap pressure
  // relief even for a legacy multi-megabyte value.
  for (let pass = 0; storageByteLength(compacted) > byteLimit && pass < 6; pass += 1) {
    caps = Object.fromEntries(Object.entries(caps)
      .map(([key, value]) => [key, value > 1 ? Math.floor(value / 2) : 0]));
    compacted = buildCompactedBrowserState(source, retainedIds, caps);
  }

  // Thousands of currently open tabs should not be able to crowd every other
  // extension feature out of storage. Keep the most recently evidenced subset.
  while (storageByteLength(compacted) > byteLimit && retainedIds.length > 1) {
    retainedIds = retainedIds.slice(0, Math.ceil(retainedIds.length / 2));
    compacted = buildCompactedBrowserState(source, retainedIds, caps);
  }

  return compacted;
}

export function storageByteLength(value) {
  const encoded = JSON.stringify(value ?? null);
  if (typeof TextEncoder === "function") return new TextEncoder().encode(encoded).byteLength;
  return encoded.length;
}

function buildCompactedBrowserState(source, retainedIds, caps) {
  const retained = new Set(retainedIds);
  const state = {
    tabHistory: {},
    tabRelationships: {},
    tabActivityLog: {},
    tabAudioTracking: {},
    lastActive: compactLastActive(source.lastActive, retained),
    lastSaved: positiveNumber(source.lastSaved)
  };

  for (const tabId of retainedIds) {
    const history = source.tabHistory?.[tabId];
    if (Array.isArray(history) && history.length > 0) {
      state.tabHistory[tabId] = takeRecent(history, caps.history).reverse().map(compactHistoryEntry);
    }

    const relationship = source.tabRelationships?.[tabId];
    if (relationship && typeof relationship === "object") {
      state.tabRelationships[tabId] = compactRelationship(relationship, retained, caps.children);
    }

    const activity = source.tabActivityLog?.[tabId];
    if (activity !== undefined) {
      state.tabActivityLog[tabId] = compactActivity(activity, caps);
    }

    const audio = source.tabAudioTracking?.[tabId];
    if (audio && typeof audio === "object") {
      state.tabAudioTracking[tabId] = compactAudio(audio);
    }
  }

  return state;
}

function compactActivity(value, caps) {
  const legacyEvents = Array.isArray(value) ? value : [];
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    totalTimeSpent: nonNegativeInteger(source.totalTimeSpent),
    firstSeen: positiveNumber(source.firstSeen),
    lastTouch: positiveNumber(source.lastTouch),
    events: takeRecent(array(source.events).length > 0 ? source.events : legacyEvents, caps.events)
      .map(compactActivityEvent),
    navigations: takeRecent(source.navigations, caps.navigations).map(compactNavigation)
  };
}

function compactActivityEvent(value) {
  const source = object(value);
  const event = {
    type: boundedText(source.type, MAX_STATE_LABEL_LENGTH),
    timestamp: positiveNumber(source.timestamp)
  };
  if (source.data && typeof source.data === "object") {
    event.data = compactInteractionData(source.data);
  }
  return event;
}

function compactNavigation(value) {
  const source = object(value);
  return {
    type: boundedText(source.type, MAX_STATE_LABEL_LENGTH),
    url: boundedText(source.url, MAX_STATE_URL_LENGTH),
    timestamp: positiveNumber(source.timestamp),
    transitionType: boundedText(source.transitionType, MAX_STATE_LABEL_LENGTH),
    transitionQualifiers: compactLabels(source.transitionQualifiers),
    referer: boundedText(source.referer || source.referrer || source.referringURL, MAX_STATE_URL_LENGTH)
  };
}

function compactHistoryEntry(value) {
  const source = object(value);
  return {
    url: boundedText(source.url, MAX_STATE_URL_LENGTH),
    title: boundedText(source.title, MAX_TITLE_LENGTH),
    timestamp: positiveNumber(source.timestamp),
    transitionType: boundedText(source.transitionType, MAX_STATE_LABEL_LENGTH),
    transitionQualifiers: compactLabels(source.transitionQualifiers),
    dwellTimeMs: nonNegativeInteger(source.dwellTimeMs),
    dwellTimeUpdated: positiveNumber(source.dwellTimeUpdated),
    searchQuery: boundedText(source.searchQuery, MAX_STATE_TEXT_LENGTH),
    referer: boundedText(source.referer || source.referrer, MAX_STATE_URL_LENGTH),
    redirects: array(source.redirects).slice(-8).map(url => boundedText(url, MAX_STATE_URL_LENGTH))
  };
}

function compactRelationship(value, retained, maxChildren) {
  const source = object(value);
  const referringTabId = retained.has(String(source.referringTabId)) ? source.referringTabId : null;
  const previousTab = retained.has(String(source.previousTab)) ? source.previousTab : null;
  return {
    referringTabId,
    referringURL: boundedText(source.referringURL, MAX_STATE_URL_LENGTH),
    timestamp: positiveNumber(source.timestamp || source.creationTime),
    transitionType: boundedText(source.transitionType, MAX_STATE_LABEL_LENGTH),
    transitionQualifiers: compactLabels(source.transitionQualifiers),
    linkText: boundedText(source.linkText, MAX_STATE_TEXT_LENGTH),
    isFormSubmission: Boolean(source.isFormSubmission),
    previousTab,
    interactionData: source.interactionData ? compactInteractionData(source.interactionData) : null,
    lastClickedLink: source.lastClickedLink ? compactInteractionData(source.lastClickedLink) : null,
    childTabs: takeRecent(
      array(source.childTabs).filter(child => retained.has(String(child?.tabId))),
      maxChildren
    )
      .map(child => ({
        tabId: child.tabId,
        url: boundedText(child.url, MAX_STATE_URL_LENGTH),
        timestamp: positiveNumber(child.timestamp),
        transitionType: boundedText(child.transitionType, MAX_STATE_LABEL_LENGTH)
      }))
  };
}

function compactInteractionData(value) {
  const source = object(value);
  const formData = object(source.formData);
  const pageContext = object(source.pageContext);
  const attributes = object(source.attributes);
  return {
    text: boundedText(source.text, MAX_STATE_TEXT_LENGTH),
    linkText: boundedText(source.linkText, MAX_STATE_TEXT_LENGTH),
    targetUrl: boundedText(source.targetUrl || source.href, MAX_STATE_URL_LENGTH),
    sourceUrl: boundedText(source.sourceUrl, MAX_STATE_URL_LENGTH),
    sourceTitle: boundedText(source.sourceTitle, MAX_TITLE_LENGTH),
    sourceDomain: boundedText(source.sourceDomain, MAX_STATE_LABEL_LENGTH),
    targetDomain: boundedText(source.targetDomain, MAX_STATE_LABEL_LENGTH),
    interactionType: boundedText(source.interactionType, MAX_STATE_LABEL_LENGTH),
    sourceElementType: boundedText(source.sourceElementType || source.elementType, MAX_STATE_LABEL_LENGTH),
    surroundingText: boundedText(source.surroundingText, MAX_STATE_TEXT_LENGTH),
    isFormSubmission: Boolean(source.isFormSubmission),
    timestamp: positiveNumber(source.timestamp || source.clickTimestamp),
    formData: formData.searchQuery
      ? { searchQuery: boundedText(formData.searchQuery, MAX_STATE_TEXT_LENGTH) }
      : null,
    pageContext: Object.keys(pageContext).length > 0 ? {
      path: boundedText(pageContext.path, MAX_STATE_TEXT_LENGTH),
      title: boundedText(pageContext.title, MAX_TITLE_LENGTH)
    } : null,
    attributes: Object.keys(attributes).length > 0 ? {
      ariaLabel: boundedText(attributes.ariaLabel, MAX_STATE_TEXT_LENGTH),
      id: boundedText(attributes.id, MAX_STATE_LABEL_LENGTH),
      rel: boundedText(attributes.rel, MAX_STATE_LABEL_LENGTH)
    } : null
  };
}

function compactAudio(value) {
  const source = object(value);
  return {
    totalAudioDuration: nonNegativeInteger(source.totalAudioDuration),
    isCurrentlyAudible: Boolean(source.isCurrentlyAudible),
    audioStartTime: positiveNumber(source.audioStartTime),
    lastAudioEnd: positiveNumber(source.lastAudioEnd)
  };
}

function compactLastActive(value, retained) {
  const source = object(value);
  if (!retained.has(String(source.tabId))) return null;
  return {
    tabId: source.tabId,
    windowId: source.windowId,
    timestamp: positiveNumber(source.timestamp)
  };
}

function eligibleTabIds(source, liveTabIds) {
  const storedIds = new Set([
    ...Object.keys(object(source.tabHistory)),
    ...Object.keys(object(source.tabRelationships)),
    ...Object.keys(object(source.tabActivityLog)),
    ...Object.keys(object(source.tabAudioTracking))
  ]);
  if (source.lastActive?.tabId !== undefined) storedIds.add(String(source.lastActive.tabId));
  if (liveTabIds !== undefined) {
    return [...new Set(arrayOrSet(liveTabIds).map(value => String(value)).filter(id => storedIds.has(id)))];
  }
  return [...storedIds];
}

function stateRecency(source, tabId) {
  const activity = object(source.tabActivityLog?.[tabId]);
  const timestamps = [
    activity.lastTouch,
    ...array(activity.events).map(item => item?.timestamp),
    ...array(activity.navigations).map(item => item?.timestamp),
    ...array(source.tabHistory?.[tabId]).map(item => item?.timestamp),
    source.tabRelationships?.[tabId]?.timestamp
  ].map(Number).filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : 0;
}

function takeRecent(value, limit) {
  const safeLimit = nonNegativeInteger(limit);
  if (safeLimit === 0) return [];
  return array(value)
    .map((item, index) => ({ item, index, timestamp: Number(item?.timestamp || 0) }))
    .sort((left, right) => right.timestamp - left.timestamp || right.index - left.index)
    .slice(0, safeLimit)
    .sort((left, right) => left.timestamp - right.timestamp || left.index - right.index)
    .map(entry => entry.item);
}

function compactLabels(value) {
  return array(value).slice(0, 8).map(item => boundedText(item, MAX_STATE_LABEL_LENGTH));
}

function arrayOrSet(value) {
  if (value instanceof Set) return [...value];
  return array(value);
}

function isPublicHttpUrl(value) {
  const text = String(value || "");
  if (!text || text.length > MAX_URL_LENGTH) return false;
  try {
    const protocol = new URL(text).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function boundedText(value, limit) {
  return String(value || "").trim().slice(0, limit);
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}
