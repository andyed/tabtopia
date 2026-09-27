// Home actions use bounded, explainable heuristics. Scores are not probabilities.
export const HOME_RECOMMENDATION_PREFS_KEY = "tabtopiaHomeRecommendationPrefsV1";
const POLICY = "home-recs-v2";
const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;

export function recommendationIdentity(value) {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const hostname = loopback ? "localhost" : url.hostname.toLowerCase().replace(/^www\./, "");
    const site = `${hostname}${url.port ? `:${url.port}` : ""}`;
    let path = url.pathname || "/";
    let query = url.search;
    const file = url.searchParams.get("file");
    // These query parameters navigate within one document, not to new documents.
    if (loopback && url.port === "2527" && path === "/memory" && /\.(md|markdown)$/i.test(file || "")) {
      path = file;
      query = `?${new URLSearchParams({ file }).toString()}`;
      return { page: `${url.protocol}//${site}/memory${query}`, site, path, document: true };
    }
    return { page: `${url.protocol}//${site}${path}${query}`, site, path,
      document: /\.(md|markdown|pdf|txt|docx?)$/i.test(path) };
  } catch { return null; }
}

function preferencesValue(value, strict = false) {
  if (strict && (!value || !Array.isArray(value.hubs) || value.hubs.length > 12 || (value.exploration !== undefined && typeof value.exploration !== "boolean"))) {
    throw new TypeError("Choose up to 12 valid hub URLs and a boolean exploration preference");
  }
  const seen = new Set();
  const hubs = [];
  for (const hub of (Array.isArray(value?.hubs) ? value.hubs : []).slice(0, 12)) {
    const identity = recommendationIdentity(hub?.url);
    if (!identity || (hub.title !== undefined && typeof hub.title !== "string")) {
      if (strict) throw new TypeError("Hub URLs must use http or https without credentials");
      continue;
    }
    if (seen.has(identity.page)) continue;
    seen.add(identity.page);
    hubs.push({ url: new URL(hub.url).href, title: (hub.title || identity.site).trim().slice(0, 120) || identity.site });
  }
  return { hubs, exploration: value?.exploration !== false };
}

export async function readHomeRecommendationPreferences({ storage = globalThis.chrome?.storage?.local } = {}) {
  let saved;
  try { saved = (await storage?.get?.(HOME_RECOMMENDATION_PREFS_KEY))?.[HOME_RECOMMENDATION_PREFS_KEY]; } catch { /* usable local defaults */ }
  return preferencesValue(saved ?? { hubs: [], exploration: true });
}

export async function saveHomeRecommendationPreferences(value, { storage = globalThis.chrome?.storage?.local } = {}) {
  const result = preferencesValue(value, true);
  if (!storage?.set) throw new Error("Preference storage unavailable");
  await storage.set({ [HOME_RECOMMENDATION_PREFS_KEY]: result });
  return result;
}

function timestamp(value) { return typeof value === "number" ? value : Date.parse(value || ""); }
function positive(value) { return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0; }
function hash(value) {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return result >>> 0;
}
function parentPath(path) {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? `/${parts.slice(0, -1).join("/")}` : "/";
}

function pathKey(identity, path) { return `${new URL(identity.page).origin}${path}`; }
function historyBranches(history, now) {
  const pages = new Map();
  for (const raw of (Array.isArray(history) ? history : []).slice(0, 5000)) {
    const identity = recommendationIdentity(raw?.url);
    const visitedAt = timestamp(raw?.lastVisitTime);
    if (!identity || positive(raw.visitCount) < 2 || !Number.isFinite(visitedAt)
      || visitedAt > now || now - visitedAt > 28 * DAY) continue;
    pages.set(identity.page, identity);
  }
  const branches = new Map();
  for (const identity of pages.values()) {
    const parts = identity.path.split("/").filter(Boolean);
    // Strict ancestors only: query variants of the same path are not children.
    for (let depth = 0; depth < parts.length; depth++) {
      const path = depth ? `/${parts.slice(0, depth).join("/")}` : "/";
      const key = pathKey(identity, path);
      if (!branches.has(key)) branches.set(key, new Set());
      branches.get(key).add(identity.path);
    }
  }
  return branches;
}
function shortlist(values, scanLimit = 5000) {
  // Keep documents even when ordinary high-volume browsing would crowd them out.
  return (Array.isArray(values) ? values : []).slice(0, scanLimit)
    .map((value, index) => ({ value, index, identity: recommendationIdentity(value?.url) }))
    .filter(item => item.identity)
    .sort((a, b) => Number(b.identity.document) - Number(a.identity.document) || a.index - b.index)
    .slice(0, 800).map(item => item.value);
}

// An upper bound on this ranker's candidate identities, for one bounded feedback
// lookup. Uses exactly the same source shortlists; never exceeds 1624 pages.
export function collectHomeRecommendationIdentities({ context, history = [], bookmarks = [], preferences = {} } = {}) {
  const pages = new Set();
  for (const item of [...preferencesValue(preferences).hubs,
    ...(Array.isArray(context?.results) ? context.results : []).slice(0, 12),
    ...shortlist(bookmarks, 10000), ...shortlist(history)]) {
    const identity = recommendationIdentity(item?.url);
    if (identity) pages.add(identity.page);
  }
  return [...pages];
}

export function buildHomeRecommendations({ context, history = [], bookmarks = [], openTabs = [], preferences = {}, feedback = {},
  now = Date.now(), seed = "home", arm = "balanced", limit = 3, excludePages = [], lockedPages = [] } = {}) {
  if (!Number.isFinite(now)) return [];
  const prefs = preferencesValue(preferences);
  const selectedArm = arm === "explore" && prefs.exploration ? "explore" : "balanced";
  const cap = Math.min(3, Math.max(0, Math.floor(Number(limit) || 0)));
  if (!cap) return [];
  const excluded = new Set(excludePages.map(url => recommendationIdentity(url)?.page).filter(Boolean));
  const hidden = (Array.isArray(context?.hiddenHosts) ? context.hiddenHosts : []).filter(x => typeof x === "string").map(x => x.toLowerCase());
  const candidates = new Map();
  const branches = historyBranches(history, now);
  const contextExpiry = timestamp(context?.expiresAt);
  const generatedAt = timestamp(context?.generatedAt);
  const fresh = contextExpiry > now && generatedAt <= now + 5000 && generatedAt > now - 30 * MINUTE
    && context?.context?.seedCount > 0 && context?.status !== "empty";
  function add(raw, source) {
    const identity = recommendationIdentity(raw?.url);
    if (!identity || excluded.has(identity.page)) return null;
    const hostname = new URL(identity.page).hostname;
    if (hidden.some(host => identity.site === host || (identity.site.startsWith("localhost:") ? false : hostname === host || hostname.endsWith(`.${host}`)))) return null;
    const response = feedback instanceof Map ? feedback.get(identity.page) : feedback?.[identity.page];
    if (timestamp(response?.snoozedUntil) > now) return null;
    let candidate = candidates.get(identity.page);
    if (!candidate) {
      let title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 300) : identity.site;
      if (identity.document && identity.site === "localhost:2527" && (/^(session\s*)?cartographer(?:\s*[-—|:].*)?$/i.test(title) || title === identity.site)) {
        title = identity.path.split("/").filter(Boolean).pop() || title;
      }
      candidate = { identity, url: new URL(raw.url).href, title, navigationAt: 0,
        sources: new Set(), response: response || {}, hub: false, visits: 0, qualified: 0, lastVisit: 0, semantic: 0, related: false, bookmarked: false };
      candidates.set(identity.page, candidate);
    }
    candidate.sources.add(source);
    return candidate;
  }
  if (fresh) for (const raw of (Array.isArray(context.results) ? context.results : []).slice(0, 12)) {
    const item = add(raw, "recent-context");
    if (item) { item.related = true; item.semantic = Math.max(item.semantic, Math.min(1, positive(raw.score))); }
  }
  for (const hub of prefs.hubs) {
    const item = add(hub, "selected-hub");
    if (item) { item.hub = true; item.title = hub.title; }
  }
  for (const raw of shortlist(history)) {
    const identity = recommendationIdentity(raw?.url);
    const visits = positive(raw?.visitCount);
    const qualified = positive(raw?.qualifiedVisits ?? raw?.qualifiedVisitCount);
    const lastVisit = timestamp(raw?.lastVisitTime);
    if (!identity || !Number.isFinite(lastVisit) || lastVisit > now || now - lastVisit > (identity.document ? 180 : 28) * DAY) continue;
    if (visits < 2 && qualified < 1 && !identity.document && !candidates.has(identity.page)) continue;
    const item = add(raw, "history");
    if (item) {
      item.visits = Math.max(item.visits, visits); item.qualified = Math.max(item.qualified, qualified); item.lastVisit = Math.max(item.lastVisit, lastVisit);
      if (lastVisit > item.navigationAt) { item.url = new URL(raw.url).href; item.navigationAt = lastVisit; }
    }
  }
  const bookmarkIdentities = new Map();
  // Density describes the scanned bookmark tree, independently of the smaller
  // action shortlist used to bound ranking and feedback lookups.
  for (const raw of (Array.isArray(bookmarks) ? bookmarks : []).slice(0, 10000)) {
    const identity = recommendationIdentity(raw?.url);
    if (!identity) continue;
    bookmarkIdentities.set(identity.page, identity);
    const existing = candidates.get(identity.page);
    if (existing) { existing.bookmarked = true; existing.sources.add("bookmark"); }
  }
  for (const raw of shortlist(bookmarks, 10000)) {
    const item = add(raw, "bookmark");
    if (item) item.bookmarked = true;
  }
  const tabs = new Map();
  for (const tab of Array.isArray(openTabs) ? openTabs : []) {
    if (tab?.incognito) continue;
    const identity = recommendationIdentity(tab?.url);
    if (identity && Number.isInteger(tab.id) && !tabs.has(identity.page)) tabs.set(identity.page, tab);
  }
  const bookmarkSites = new Map();
  for (const identity of bookmarkIdentities.values()) {
    let area = bookmarkSites.get(identity.site);
    if (!area) { area = { total: 0, prefixes: new Map() }; bookmarkSites.set(identity.site, area); }
    area.total++;
    const parts = identity.path.split("/").filter(Boolean);
    for (let depth = 0; depth <= parts.length; depth++) {
      const prefix = depth ? `/${parts.slice(0, depth).join("/")}` : "/";
      area.prefixes.set(prefix, (area.prefixes.get(prefix) || 0) + 1);
    }
  }
  const ranked = [...candidates.values()].map(item => {
    const ownPath = item.identity.path.replace(/\/$/, "") || "/";
    const branchPages = branches.get(pathKey(item.identity, ownPath))?.size || 0;
    const eligibleHub = !item.identity.document && !new URL(item.identity.page).search && item.lastVisit > 0;
    const inferredHub = eligibleHub && (item.visits >= 12 || (item.visits >= 3 && branchPages >= 2));
    const hubStrength = inferredHub ? (0.9 * Math.min(1, Math.log1p(item.visits / 8))
      + 0.6 * Math.min(1, Math.log1p(branchPages) / Math.log(8)))
      * Math.exp(-(now - item.lastVisit) / (28 * DAY)) : 0;
    if (inferredHub) item.sources.add("inferred-hub");
    const area = bookmarkSites.get(item.identity.site);
    // A visited landing page owns its subtree. Do not credit a profile with
    // every bookmark on the entire host merely because its parent is '/'.
    const ownBookmarkChildren = Math.max(0, (area?.prefixes.get(ownPath) || 0)
      - (bookmarkIdentities.has(item.identity.page) ? 1 : 0));
    const prefix = (inferredHub || (!item.identity.document && ownBookmarkChildren > 0))
      ? ownPath : parentPath(item.identity.path);
    const self = bookmarkIdentities.has(item.identity.page) ? 1 : 0;
    const sameSiteCount = (area?.total || 0) - self;
    const pathSupport = Math.max(0, (area?.prefixes.get(prefix) || 0) - self);
    // Pseudocounts keep sparse folders from looking maximally supported.
    const density = pathSupport ? (pathSupport + 0.5) / (sameSiteCount + 2) : 0;
    const impressions = positive(item.response.impressions);
    const engaged = positive(item.response.engaged);
    const recentShown = Math.max(0, now - timestamp(item.response.lastShownAt));
    const sinceEngaged = Math.max(0, now - timestamp(item.response.lastEngagedAt));
    const fatigue = Math.min(2.5, Math.log1p(Math.max(0, impressions - engaged)) * 0.45)
      + (recentShown < 10 * MINUTE ? 1.2 * (1 - recentShown / (10 * MINUTE)) : 0);
    const engagementPenalty = sinceEngaged < 30 * MINUTE ? 1.8 * (1 - sinceEngaged / (30 * MINUTE)) : 0;
    const score = (item.hub ? 2.2 : hubStrength) + (item.related ? 0.7 + item.semantic : 0)
      + (item.identity.document ? 0.7 : 0) + (item.bookmarked ? 0.35 : 0)
      + Math.min(1.5, Math.log1p(item.visits) * 0.3) + Math.min(0.8, Math.log1p(item.qualified) * 0.35)
      + (item.lastVisit ? 0.35 * Math.exp(-(now - item.lastVisit) / (7 * DAY)) : 0)
      + Math.min(1, density * Math.log1p(pathSupport) * 0.5) - fatigue - engagementPenalty;
    const reasons = [];
    if (item.hub) reasons.push("Your selected hub");
    else if (inferredHub) reasons.push(branchPages >= 2 ? `Hub for ${branchPages} revisited pages` : "Frequently revisited");
    if (item.related) reasons.push("Related to your last 30 minutes");
    if (item.identity.document) reasons.push("Return to a document");
    if (item.visits >= 2) reasons.push(`Visited ${item.visits} times`);
    if (pathSupport >= 2) reasons.push(`${pathSupport} bookmarks in this area`);
    else if (item.bookmarked) reasons.push("Bookmarked by you");
    const tab = tabs.get(item.identity.page);
    return { id: `home-recs-${hash(item.identity.page).toString(16)}`, identity: item.identity.page,
      url: item.url, title: item.title, domain: item.identity.site, verb: tab ? "switch" : "open",
      target: { url: item.url, title: item.title, open: Boolean(tab), ...(tab ? { tabId: tab.id, windowId: tab.windowId } : {}) },
      sources: [...item.sources], reasons, expiresAt: item.related ? contextExpiry : now + 30 * MINUTE,
      contextGeneratedAt: item.related ? generatedAt : now, policy: POLICY, arm: selectedArm,
      features: { hub: item.hub || inferredHub, selectedHub: item.hub, inferredHub, hubStrength, branchPages,
        bookmarkPath: prefix, document: item.identity.document, bookmarkDensity: density, bookmarkSupport: pathSupport,
        bookmarked: item.bookmarked, context: item.related, semanticSimilarity: item.related ? item.semantic : null,
        visits: item.visits, qualifiedVisits: item.qualified, fatigue, engagementPenalty, heuristicScore: score },
      _site: item.identity.site, _path: item.identity.path, _score: score,
      _explorable: (item.hub || item.related || item.identity.document || item.visits >= 2) && engagementPenalty === 0 && fatigue < 2.5 };
  }).sort((a, b) => b._score - a._score || a.identity.localeCompare(b.identity));
  const selected = [];
  const diverse = item => {
    const sameSite = selected.filter(existing => existing._site === item._site);
    if (!sameSite.length) return true;
    // An explicit hub and one distinct document are separate useful actions.
    return sameSite.length === 1 && sameSite[0].identity !== item.identity && sameSite[0]._path !== item._path
      && ((sameSite[0].features.hub && item.features.document) || (sameSite[0].features.document && item.features.hub));
  };
  // A visible slate stays put across feedback writes and late provider arrivals.
  // Hidden, snoozed, excluded, or no-longer-supported actions have already dropped out.
  for (const page of Array.isArray(lockedPages) ? lockedPages : []) {
    if (selected.length >= cap) break;
    const identity = recommendationIdentity(page)?.page;
    const item = ranked.find(candidate => candidate.identity === identity);
    if (item && diverse(item)) selected.push(item);
  }
  // Balanced choices fill the first slots; exploration rotates one supported action.
  const mainSlots = selectedArm === "explore" ? Math.max(0, cap - 1) : cap;
  for (const item of ranked) {
    if (selected.length >= mainSlots) break;
    if (diverse(item)) selected.push(item);
  }
  if (selectedArm === "explore" && selected.length < cap) {
    const pool = ranked.filter(item => diverse(item) && item._explorable).slice(0, 12)
      .sort((a, b) => a.identity.localeCompare(b.identity));
    if (pool.length) selected.push(pool[hash(String(seed)) % pool.length]);
  }
  // Keep diversity constraints even if they leave an honest smaller slate.
  for (const item of ranked) {
    if (selected.length >= cap) break;
    if (diverse(item)) selected.push(item);
  }
  return selected.map(({ _site, _path, _score, _explorable, ...item }, index) => ({ ...item, rank: index + 1 }));
}
