import { normalizeIdentity } from "./revisit-model.js";

const CACHE_KEY = "tabtopiaRecentContextV1";
const HIDDEN_KEY = "tabtopiaContextHiddenSitesV1";
const HORIZON_MS = 30 * 60 * 1000;

export async function readRecentContext({
  storage = globalThis.chrome?.storage?.session,
  preferences = globalThis.chrome?.storage?.local,
  now = Date.now(), development = false
} = {}) {
  const [saved, prefs] = await Promise.all([
    storage?.get?.(CACHE_KEY).catch(() => ({})),
    preferences?.get?.(HIDDEN_KEY).catch(() => ({}))
  ]);
  const hiddenHosts = Array.isArray(prefs?.[HIDDEN_KEY])
    ? prefs[HIDDEN_KEY].filter(validHost).slice(0, 100)
    : [];
  const cached = saved?.[CACHE_KEY];
  const valid = cached?.version === 1 && cached.expiresAt > now
    && cached.generatedAt <= now && cached.generatedAt > now - HORIZON_MS;
  return {
    ...(valid ? cached : { results: [], context: null, expiresAt: 0, generatedAt: 0 }),
    hiddenHosts,
    status: valid ? cached.status : "empty",
    fetchedAt: Number(cached?.fetchedAt || 0),
    changed: false
  };
}

// Local overlays may replace this module; public builds never contact a service.
export async function refreshRecentContext() {
  return { changed: false, status: "disabled" };
}

export function buildFeaturedContext(context, openTabs = [], now = Date.now()) {
  if (!context || context.expiresAt <= now || !context.context?.seedCount) return [];
  const hidden = context.hiddenHosts || [];
  const seen = new Set();
  return sanitizeResults(context.results).filter(item => {
    const host = contextSiteKey(item.url);
    if (hidden.some(value => host === value || host.endsWith(`.${value}`))) return false;
    const key = pageKey(item.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3).map((item, index) => {
    const existing = openTabs.find(tab => pageKey(tab.url) === pageKey(item.url));
    return {
      ...item, id: `recent-context-${index + 1}`, rank: index + 1,
      verb: existing ? "switch" : "open",
      target: { url: item.url, title: item.title, open: Boolean(existing),
        ...(existing ? { tabId: existing.id, windowId: existing.windowId } : {}) },
      sources: ["recent-context"], reasons: ["Related to your last 30 minutes"],
      contextGeneratedAt: context.generatedAt, expiresAt: context.expiresAt
    };
  });
}

export async function setContextSiteHidden(urlOrHost, hidden, {
  preferences = globalThis.chrome?.storage?.local, development = false
} = {}) {
  const host = contextSiteKey(urlOrHost.includes("://") ? urlOrHost : `https://${urlOrHost}`);
  if (!validHost(host)) throw new Error("Invalid site");
  const saved = await preferences.get(HIDDEN_KEY);
  const hosts = new Set(Array.isArray(saved[HIDDEN_KEY]) ? saved[HIDDEN_KEY] : []);
  if (hidden) hosts.add(host); else hosts.delete(host);
  await preferences.set({ [HIDDEN_KEY]: [...hosts].slice(-100) });
  return host;
}

function sanitizeResults(value) {
  return (Array.isArray(value) ? value : []).flatMap(item => {
    try {
      const url = new URL(item.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return [];
      if (typeof item.title !== "string" || !item.title.trim()) return [];
      return [{ url: url.href, title: item.title.trim().slice(0, 300),
        score: Number.isFinite(item.score) ? item.score : null, domain: hostOf(url.href) }];
    } catch { return []; }
  }).slice(0, 12);
}
function validHost(value) { return typeof value === "string" && (/^[a-z0-9.-]+$/i.test(value) && value.includes(".") || /^localhost(?::\d{1,5})?$/.test(value)); }
export function contextSiteKey(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return ["localhost", "127.0.0.1", "[::1]"].includes(host)
      ? `localhost${url.port ? `:${url.port}` : ""}` : host;
  } catch { return ""; }
}
function hostOf(value) { try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } }
function pageKey(value) { return normalizeIdentity(value)?.page || ""; }
