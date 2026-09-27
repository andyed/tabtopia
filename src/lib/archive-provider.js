// Compatibility reader for previously saved supplemental data.
// Public builds have no archive service connection.
const STORAGE_KEY = "tabtopiaArchiveProviderV1";
export const SNAPSHOT_VERSION = 2;

const ARCHIVE_TTL_MS = 24 * 60 * 60 * 1000;
const RELATED_TTL_MS = 10 * 60 * 1000;

const MAX_ARCHIVE_ROWS = 96;
const MAX_SEMANTIC_HITS = 12;
const MAX_CACHED_QUERIES = 12;
const MAX_TAGS = 12;
const MAX_TITLE_LENGTH = 180;
const MAX_URL_LENGTH = 2048;
const MAX_QUERY_TITLES = 4;
const MAX_QUERY_TITLE_LENGTH = 120;
const MAX_QUERY_LENGTH = 320;

/**
 * Read the local snapshot only. This is the first-paint path: it never fetches
 * and it reports stale data rather than making Home wait for localhost.
 */
export async function readCachedArchive({
  storage = globalThis.chrome?.storage?.local,
  now = Date.now()
} = {}) {
  const timestamp = validNow(now);
  const loaded = await loadSnapshot(storage);
  if (!loaded.ok) return view(emptySnapshot(), "", timestamp, "offline", false);

  const query = loaded.snapshot.lastQuery;
  const status = hasVisibleData(loaded.snapshot, query) ? "cached" : "empty";
  return view(loaded.snapshot, query, timestamp, status, false);
}

// Public builds preserve cached data but have no service connection.
export async function refreshArchive() {
  return { changed: false, status: "disabled" };
}

export function archiveQueryForState({ snapshot, forecast } = {}) {
  const titles = [];
  const currentTabs = Array.isArray(snapshot?.currentWindow?.tabs)
    ? snapshot.currentWindow.tabs
    : [];
  const active = currentTabs.find(tab => tab?.active);
  addQueryTitle(titles, active?.title);

  const foreignItems = Array.isArray(snapshot?.history?.foreignItems)
    ? snapshot.history.foreignItems.slice().sort((left, right) =>
      Number(right?.visitTime || 0) - Number(left?.visitTime || 0))
    : [];
  for (const item of foreignItems.slice(0, 2)) {
    addQueryTitle(titles, item?.title);
    if (titles.length >= MAX_QUERY_TITLES) break;
  }

  for (const candidate of Array.isArray(forecast?.candidates) ? forecast.candidates : []) {
    addQueryTitle(titles, candidate?.action?.target?.title || candidate?.title);
    if (titles.length >= MAX_QUERY_TITLES) break;
  }

  if (titles.length < MAX_QUERY_TITLES) {
    const remainingTabs = currentTabs
      .filter(tab => tab !== active)
      .slice()
      .sort((left, right) => Number(right?.lastAccessed || 0) - Number(left?.lastAccessed || 0));
    for (const tab of remainingTabs) {
      addQueryTitle(titles, tab?.title);
      if (titles.length >= MAX_QUERY_TITLES) break;
    }
  }

  return normalizeQuery(titles.join(" | "));
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

function normalizeArchivePayload(payload) {
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items) ? payload.items : null;
  if (!items) throw new Error("malformed archive response");

  let structurallyValid = 0;
  const seen = new Set();
  const rows = [];
  for (const item of items) {
    const title = boundedText(item?.title, MAX_TITLE_LENGTH);
    const url = boundedUrl(item?.url);
    if (!title || !url) continue;
    structurallyValid += 1;

    const tags = normalizeTags(item?.tags);
    if (tags.length === 0) continue;
    const key = `${url}\u0000${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const timestamp = dateTimestamp(item?.date_added ?? item?.date ?? item?.timestamp ?? item?.lastVisitTime);
    rows.push({
      title,
      url,
      tags,
      timestamp,
      visitCount: boundedCount(item?.visitCount),
      lastVisitTime: dateTimestamp(item?.lastVisitTime),
      archivedAt: dateTimestamp(item?.archivedAt ?? item?.dateAdded ?? item?.savedAt) || timestamp,
      type: boundedText(item?.type, 40),
      layer: boundedText(item?._layer ?? item?.layer, 48)
    });
    if (rows.length >= MAX_ARCHIVE_ROWS) break;
  }
  if (items.length > 0 && structurallyValid === 0) throw new Error("malformed archive rows");
  return rows;
}

function normalizeSearchPayload(payload) {
  const items = Array.isArray(payload?.results)
    ? payload.results
    : Array.isArray(payload) ? payload : null;
  if (!items) throw new Error("malformed search response");

  let structurallyValid = 0;
  const seen = new Set();
  const hits = [];
  for (const item of items) {
    const title = boundedText(item?.title, MAX_TITLE_LENGTH);
    const url = boundedUrl(item?.url);
    if (!title || !url) continue;
    structurallyValid += 1;
    if (seen.has(url)) continue;
    seen.add(url);
    hits.push({
      title,
      url,
      score: finiteNumber(item?.score),
      timestamp: dateTimestamp(item?.date ?? item?.date_added ?? item?.timestamp),
      type: boundedText(item?.type, 40)
    });
    if (hits.length >= MAX_SEMANTIC_HITS) break;
  }
  if (items.length > 0 && structurallyValid === 0) throw new Error("malformed search rows");
  return hits;
}

function validateSnapshot(value) {
  if (!value || value.version !== SNAPSHOT_VERSION) return emptySnapshot();

  const archiveRows = Array.isArray(value.archive?.rows)
    ? normalizeArchivePayload(value.archive.rows)
    : [];
  const queries = {};
  for (const entry of Object.values(objectOrEmpty(value.queries))) {
    const query = normalizeQuery(entry?.query);
    if (!query || !Array.isArray(entry?.hits)) continue;
    try {
      queries[queryKey(query)] = {
        query,
        fetchedAt: positiveNumber(entry?.fetchedAt),
        hits: normalizeSearchPayload({ results: entry.hits })
      };
    } catch {
      // One bad query entry must not invalidate the daily archive snapshot.
    }
  }
  trimQueryCache(queries);

  const lastQuery = normalizeQuery(value.lastQuery);
  return {
    version: SNAPSHOT_VERSION,
    updatedAt: positiveNumber(value.updatedAt),
    archive: {
      fetchedAt: positiveNumber(value.archive?.fetchedAt),
      rows: archiveRows
    },
    queries,
    lastQuery: queries[queryKey(lastQuery)] ? lastQuery : ""
  };
}

function emptySnapshot() {
  return {
    version: SNAPSHOT_VERSION,
    updatedAt: 0,
    archive: { fetchedAt: 0, rows: [] },
    queries: {},
    lastQuery: ""
  };
}

function view(snapshot, query, now, status, changed) {
  const resolvedQuery = normalizeQuery(query) || snapshot.lastQuery;
  const related = snapshot.queries[queryKey(resolvedQuery)];
  return {
    version: SNAPSHOT_VERSION,
    status,
    changed: Boolean(changed),
    query: resolvedQuery,
    archive: snapshot.archive.rows.map(row => ({ ...row, tags: [...row.tags] })),
    related: (related?.hits || []).map(hit => ({ ...hit })),
    fetchedAt: {
      archive: snapshot.archive.fetchedAt,
      related: related?.fetchedAt || 0
    },
    freshness: {
      archive: freshness(snapshot.archive.fetchedAt, now, ARCHIVE_TTL_MS),
      related: resolvedQuery
        ? freshness(related?.fetchedAt, now, RELATED_TTL_MS)
        : "unused"
    }
  };
}

function freshness(fetchedAt, now, ttlMs) {
  if (!positiveNumber(fetchedAt)) return "empty";
  return isFresh(fetchedAt, now, ttlMs) ? "fresh" : "stale";
}

function isFresh(fetchedAt, now, ttlMs) {
  const timestamp = positiveNumber(fetchedAt);
  return timestamp > 0 && now >= timestamp && (now - timestamp) < ttlMs;
}

function hasVisibleData(snapshot, query) {
  return snapshot.archive.rows.length > 0
    || (snapshot.queries[queryKey(query)]?.hits.length || 0) > 0;
}

function normalizeQuery(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH)
    .trim();
}

function addQueryTitle(titles, value) {
  if (titles.length >= MAX_QUERY_TITLES) return;
  const title = boundedText(value, MAX_QUERY_TITLE_LENGTH);
  if (!title || /^untitled$/i.test(title)) return;
  if (titles.some(existing => existing.toLocaleLowerCase() === title.toLocaleLowerCase())) return;
  titles.push(title);
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const tags = [];
  for (const rawTag of value) {
    const tag = boundedText(rawTag, 64);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

function boundedText(value, limit) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit)
    .trim();
}

function boundedUrl(value) {
  const url = boundedText(value, MAX_URL_LENGTH);
  if (!url) return "";
  if (url.startsWith("/")) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : "";
  } catch {
    return "";
  }
}

function dateTimestamp(value) {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function boundedCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(1_000_000, Math.floor(number));
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function validNow(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Date.now();
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function queryKey(query) {
  return normalizeQuery(query).toLocaleLowerCase();
}

function trimQueryCache(queries) {
  const entries = Object.entries(queries);
  if (entries.length <= MAX_CACHED_QUERIES) return;
  entries.sort((left, right) => right[1].fetchedAt - left[1].fetchedAt || left[0].localeCompare(right[0]));
  const keep = new Set(entries.slice(0, MAX_CACHED_QUERIES).map(([key]) => key));
  for (const key of Object.keys(queries)) {
    if (!keep.has(key)) delete queries[key];
  }
}
