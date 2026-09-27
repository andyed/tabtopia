const STORAGE_KEY = "tabtopiaGithubStarsProviderV1";
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
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

/** No external star source is connected in public builds. */

export async function refreshGithubStars() {
  return { changed: false, status: "disabled" };
}

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

async function loadSnapshot(storage) {
  if (typeof storage?.get !== "function") return { ok: false, snapshot: emptySnapshot() };
  try {
    const stored = await storage.get(STORAGE_KEY);
    return { ok: true, snapshot: validateSnapshot(stored?.[STORAGE_KEY]) };
  } catch {
    return { ok: false, snapshot: emptySnapshot() };
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
