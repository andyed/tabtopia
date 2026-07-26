const STORAGE_KEY = "tabtopiaTechmemeProviderV1";
const SNAPSHOT_VERSION = 1;
const TECHMEME_FEED_URL = "https://www.techmeme.com/feed.xml";
const FEED_TTL_MS = 20 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;
const MAX_FEED_ITEMS = 40;
const MAX_TITLE_LENGTH = 280;
const MAX_URL_LENGTH = 2048;

/**
 * Read only the locally cached RSS snapshot. Home uses this on its first-paint
 * path, so a slow or unavailable Techmeme request can never delay rendering.
 */
export async function readCachedTechmeme({
  storage = globalThis.chrome?.storage?.local,
  now = Date.now()
} = {}) {
  const timestamp = validNow(now);
  const loaded = await loadSnapshot(storage);
  if (!loaded.ok) return view(emptySnapshot(), timestamp, "offline", false);
  return view(
    loaded.snapshot,
    timestamp,
    loaded.snapshot.items.length > 0 ? "cached" : "empty",
    false
  );
}

/**
 * Refresh the official Techmeme RSS feed in the background. All network,
 * parsing, validation, and storage failures collapse to an offline snapshot.
 */
export async function refreshTechmeme({
  storage = globalThis.chrome?.storage?.local,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  force = false
} = {}) {
  const timestamp = validNow(now);
  const loaded = await loadSnapshot(storage);
  if (!loaded.ok) return view(emptySnapshot(), timestamp, "offline", false);

  const previous = loaded.snapshot;
  if (!force && isFresh(previous.fetchedAt, timestamp)) {
    return view(previous, timestamp, previous.items.length > 0 ? "cached" : "empty", false);
  }
  if (typeof fetchImpl !== "function") return view(previous, timestamp, "offline", false);

  try {
    const xml = await fetchFeed(fetchImpl);
    const items = parseTechmemeRss(xml);
    const next = {
      version: SNAPSHOT_VERSION,
      fetchedAt: timestamp,
      items
    };
    const changed = !sameItems(previous.items, items);
    const written = await saveSnapshot(storage, next);
    if (!written) return view(previous, timestamp, "offline", false);
    return view(next, timestamp, "live", changed);
  } catch {
    return view(previous, timestamp, "offline", false);
  }
}

/**
 * Parse the small RSS surface we retain: title, Techmeme permalink, and date.
 * Description HTML is intentionally ignored.
 */
export function parseTechmemeRss(xml) {
  if (typeof xml !== "string" || !/<rss\b/iu.test(xml)) {
    throw new Error("malformed Techmeme RSS");
  }

  const items = [];
  const seen = new Set();
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/giu)) {
    const body = match[1];
    const title = boundedText(readTag(body, "title"), MAX_TITLE_LENGTH);
    const url = boundedTechmemeUrl(readTag(body, "link"));
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    items.push({
      id: `techmeme:${url}`,
      title,
      url,
      publishedAt: dateTimestamp(readTag(body, "pubDate"))
    });
    if (items.length >= MAX_FEED_ITEMS) break;
  }

  if (/<item\b/iu.test(xml) && items.length === 0) {
    throw new Error("malformed Techmeme items");
  }
  return items;
}

async function fetchFeed(fetchImpl) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const response = await fetchImpl(TECHMEME_FEED_URL, {
      signal: controller?.signal,
      cache: "no-store",
      headers: { Accept: "application/rss+xml, application/xml, text/xml" }
    });
    if (!response?.ok || typeof response.text !== "function") {
      throw new Error("Techmeme feed unavailable");
    }
    return await response.text();
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function loadSnapshot(storage) {
  if (typeof storage?.get !== "function") return { ok: false, snapshot: emptySnapshot() };
  try {
    const stored = await storage.get(STORAGE_KEY);
    return { ok: true, snapshot: validateSnapshot(stored?.[STORAGE_KEY]) };
  } catch {
    return { ok: false, snapshot: emptySnapshot() };
  }
}

async function saveSnapshot(storage, snapshot) {
  if (typeof storage?.set !== "function") return false;
  try {
    await storage.set({ [STORAGE_KEY]: snapshot });
    return true;
  } catch {
    return false;
  }
}

function validateSnapshot(value) {
  if (!value || value.version !== SNAPSHOT_VERSION) return emptySnapshot();
  const items = [];
  const seen = new Set();
  for (const raw of Array.isArray(value.items) ? value.items : []) {
    const title = boundedText(raw?.title, MAX_TITLE_LENGTH);
    const url = boundedTechmemeUrl(raw?.url);
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    items.push({
      id: `techmeme:${url}`,
      title,
      url,
      publishedAt: dateTimestamp(raw?.publishedAt)
    });
    if (items.length >= MAX_FEED_ITEMS) break;
  }
  return {
    version: SNAPSHOT_VERSION,
    fetchedAt: dateTimestamp(value.fetchedAt),
    items
  };
}

function view(snapshot, now, status, changed) {
  return {
    items: snapshot.items.map(item => ({ ...item })),
    fetchedAt: snapshot.fetchedAt,
    freshness: isFresh(snapshot.fetchedAt, now) ? "fresh" : snapshot.fetchedAt > 0 ? "stale" : "empty",
    status,
    changed: Boolean(changed)
  };
}

function emptySnapshot() {
  return { version: SNAPSHOT_VERSION, fetchedAt: 0, items: [] };
}

function readTag(body, name) {
  const match = body.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "iu"));
  return decodeXml(match?.[1] || "");
}

function decodeXml(value) {
  const withoutCdata = String(value).replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/u, "$1");
  const withoutMarkup = withoutCdata.replace(/<[^>]*>/gu, " ");
  return withoutMarkup
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (_match, decimal) => safeCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|hellip|mdash|ndash|rsquo|lsquo|rdquo|ldquo);/giu, entity => ({
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": "\"",
      "&apos;": "'",
      "&nbsp;": " ",
      "&hellip;": "…",
      "&mdash;": "—",
      "&ndash;": "–",
      "&rsquo;": "’",
      "&lsquo;": "‘",
      "&rdquo;": "”",
      "&ldquo;": "“"
    })[entity.toLocaleLowerCase()] || entity)
    .replace(/\s+/gu, " ")
    .trim();
}

function safeCodePoint(value) {
  try {
    return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
      ? String.fromCodePoint(value)
      : "";
  } catch {
    return "";
  }
}

function boundedText(value, limit) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, limit) : "";
}

function boundedTechmemeUrl(value) {
  const raw = typeof value === "string" ? value.trim().slice(0, MAX_URL_LENGTH) : "";
  try {
    const url = new URL(raw);
    const host = url.hostname.toLocaleLowerCase();
    if (url.protocol !== "https:" || (host !== "techmeme.com" && host !== "www.techmeme.com")) return "";
    return url.href;
  } catch {
    return "";
  }
}

function dateTimestamp(value) {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function validNow(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Date.now();
}

function isFresh(fetchedAt, now) {
  return Number.isFinite(fetchedAt) && fetchedAt > 0 && now - fetchedAt <= FEED_TTL_MS;
}

function sameItems(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
