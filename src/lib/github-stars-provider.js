const STORAGE_KEY = "tabtopiaGithubStarsProviderV1";
const SNAPSHOT_VERSION = 1;
const GITHUB_STARS_ENDPOINT = "http://127.0.0.1:8889/api/github/stars";
const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;
const MAX_STORED_ITEMS = 2000;
const MAX_TITLE_LENGTH = 180;
const MAX_DESCRIPTION_LENGTH = 600;
const MAX_TOPIC_LENGTH = 64;
const MAX_TOPICS = 24;

/**
 * Read only the last good local snapshot. This is part of Home's first-paint
 * path and therefore never performs network work.
 */
export async function readCachedGithubStars({
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
 * Refresh the local Interests GitHub-star export in the background. A failed
 * service, malformed response, or storage error preserves the last good data.
 */
export async function refreshGithubStars({
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
    const response = await fetchGithubStars(fetchImpl);
    const items = parseGithubStars(response);
    const next = {
      version: SNAPSHOT_VERSION,
      fetchedAt: timestamp,
      sourceUpdatedAt: dateTimestamp(response?.updatedAt),
      items
    };
    const changed = !sameItems(previous.items, items)
      || previous.sourceUpdatedAt !== next.sourceUpdatedAt;
    const written = await saveSnapshot(storage, next);
    if (!written) return view(previous, timestamp, "offline", false);
    return view(next, timestamp, "live", changed);
  } catch {
    return view(previous, timestamp, "offline", false);
  }
}

/** Retain only the small, explicit-interest surface Home needs. */
export function parseGithubStars(payload) {
  const sourceItems = Array.isArray(payload) ? payload : payload?.items;
  if (!Array.isArray(sourceItems)) throw new Error("malformed GitHub stars response");

  const items = [];
  const seen = new Set();
  for (const raw of sourceItems) {
    if (raw?.type && raw.type !== "star") continue;
    if (raw?.source && String(raw.source).toLocaleLowerCase() !== "github") continue;
    const title = boundedText(raw?.title, MAX_TITLE_LENGTH);
    const url = safeGithubRepositoryUrl(raw?.url);
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    items.push({
      id: `github-star:${url}`,
      title,
      url,
      description: boundedText(raw?.description, MAX_DESCRIPTION_LENGTH),
      topics: normalizeTopics(raw?.topics),
      stars: nonnegativeInteger(raw?.stars),
      starredAt: dateTimestamp(raw?.starredAt ?? raw?.date_added)
    });
  }

  items.sort((left, right) => right.starredAt - left.starredAt
    || left.title.localeCompare(right.title));
  return items.slice(0, MAX_STORED_ITEMS);
}

async function fetchGithubStars(fetchImpl) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const response = await fetchImpl(GITHUB_STARS_ENDPOINT, {
      signal: controller?.signal,
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    if (!response?.ok || typeof response.json !== "function") {
      throw new Error("GitHub stars unavailable");
    }
    return await response.json();
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
  return {
    version: SNAPSHOT_VERSION,
    fetchedAt: dateTimestamp(value.fetchedAt),
    sourceUpdatedAt: dateTimestamp(value.sourceUpdatedAt),
    items: parseGithubStars(Array.isArray(value.items) ? value.items : [])
  };
}

function view(snapshot, now, status, changed) {
  return {
    items: snapshot.items.map(item => ({ ...item, topics: [...item.topics] })),
    fetchedAt: snapshot.fetchedAt,
    sourceUpdatedAt: snapshot.sourceUpdatedAt,
    freshness: isFresh(snapshot.fetchedAt, now) ? "fresh" : snapshot.fetchedAt > 0 ? "stale" : "empty",
    status,
    changed: Boolean(changed)
  };
}

function emptySnapshot() {
  return { version: SNAPSHOT_VERSION, fetchedAt: 0, sourceUpdatedAt: 0, items: [] };
}

function normalizeTopics(value) {
  const topics = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const topic = boundedText(raw, MAX_TOPIC_LENGTH).toLocaleLowerCase();
    if (!topic || seen.has(topic)) continue;
    seen.add(topic);
    topics.push(topic);
    if (topics.length >= MAX_TOPICS) break;
  }
  return topics;
}

function safeGithubRepositoryUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname.toLocaleLowerCase())) {
      return "";
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return "";
    return `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/iu, "")}`;
  } catch {
    return "";
  }
}

function boundedText(value, limit) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, limit) : "";
}

function dateTimestamp(value) {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function nonnegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function validNow(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Date.now();
}

function isFresh(fetchedAt, now) {
  return fetchedAt > 0 && now - fetchedAt <= SNAPSHOT_TTL_MS;
}

function sameItems(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
