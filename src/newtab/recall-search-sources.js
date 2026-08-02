import { readCachedArchive } from "../lib/archive-provider.js";

const EMPTY_STORED_RECALL = Object.freeze({
  nanoSummaries: {},
  heroImages: {}
});

/**
 * Load the shared retrieval evidence used by every top-level search box.
 * Each source fails independently so bookmarks or tagged recall still work when
 * another Chrome API is temporarily unavailable.
 */
export async function loadRecallSearchSources({
  chromeApi = globalThis.chrome,
  windows,
  archiveReader = readCachedArchive
} = {}) {
  const [resolvedWindows, bookmarkTree, storedRecall, archiveSnapshot] = await Promise.all([
    optionalSource(
      "open tabs",
      windows || chromeApi?.windows?.getAll?.({ populate: true }),
      []
    ),
    optionalSource("bookmarks", chromeApi?.bookmarks?.getTree?.(), []),
    optionalSource(
      "saved recall",
      chromeApi?.storage?.local?.get?.(["nanoSummaries", "heroImages"]),
      EMPTY_STORED_RECALL
    ),
    optionalSource("tagged recall", archiveReader?.(), { archive: [] })
  ]);

  return buildRecallSearchSources({
    windows: resolvedWindows,
    bookmarkTree,
    summaries: storedRecall?.nanoSummaries,
    heroImages: storedRecall?.heroImages,
    taggedItems: archiveSnapshot?.archive
  });
}

/** Pure normalizer used by tests and by the Chrome-backed loader above. */
export function buildRecallSearchSources({
  windows = [],
  bookmarkTree = [],
  summaries = {},
  heroImages = {},
  taggedItems = []
} = {}) {
  const summaryRecords = object(summaries);
  const heroImageRecords = object(heroImages);
  const decorate = item => decorateRecallItem(item, { summaryRecords, heroImageRecords });

  return {
    openItems: array(windows).flatMap(window => array(window?.tabs).map(tab => decorate({
      ...tab,
      windowId: tab?.windowId ?? window?.id
    }))),
    bookmarkItems: flattenBookmarks(bookmarkTree).map(decorate),
    taggedItems: array(taggedItems).map(decorate),
    summaryRecords,
    heroImageRecords,
    historyFallback: true
  };
}

export function decorateRecallItems(items, sources) {
  return array(items).map(item => decorateRecallItem(item, sources));
}

export function decorateRecallItem(item, {
  summaryRecords = {},
  heroImageRecords = {}
} = {}) {
  if (!item || typeof item !== "object") return item;
  const source = item?.data && typeof item.data === "object" ? item.data : item;
  const url = String(source.url || item.url || "");
  const summaryRecord = normalizeSummaryRecord(summaryRecords[url]);
  const heroImage = bestHeroImage(heroImageRecords[url]);
  const decoration = {
    summary: item.summary || source.summary || summaryRecord.summary,
    summarySource: item.summarySource || source.summarySource || summaryRecord.source,
    summaryTimestamp: Number(item.summaryTimestamp || source.summaryTimestamp || summaryRecord.timestamp || 0),
    heroImageUrl: item.heroImageUrl || source.heroImageUrl || heroImage.src,
    heroImageAlt: item.heroImageAlt || source.heroImageAlt || heroImage.alt,
    heroImageScore: Number(item.heroImageScore || source.heroImageScore || heroImage.score || 0)
  };

  if (item.data && typeof item.data === "object") {
    return { ...item, ...decoration, data: { ...item.data, ...decoration } };
  }
  return { ...item, ...decoration };
}

function flattenBookmarks(tree) {
  const bookmarks = [];
  const visit = nodes => {
    for (const node of array(nodes)) {
      if (node?.url && isPublicWebUrl(node.url)) bookmarks.push(node);
      if (node?.children) visit(node.children);
    }
  };
  visit(tree);
  return bookmarks.sort((left, right) => Number(right.dateAdded || 0) - Number(left.dateAdded || 0)
    || String(left.title || "").localeCompare(String(right.title || "")));
}

function normalizeSummaryRecord(record) {
  if (typeof record === "string") return { summary: record, source: "legacy-unknown", timestamp: 0 };
  if (!record || typeof record !== "object") return { summary: "", source: "", timestamp: 0 };
  return {
    summary: String(record.summary || ""),
    source: normalizeSummarySource(record.source),
    timestamp: Number(record.timestamp || 0)
  };
}

function normalizeSummarySource(source) {
  const value = String(source || "");
  if (value === "chrome-ai" || value === "visit-fallback" || value === "metadata-fallback") return value;
  return value ? "legacy-unknown" : "";
}

function bestHeroImage(record) {
  const images = array(record?.images)
    .filter(image => image?.src && isDisplayableImageUrl(image.src))
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  const image = images[0];
  return image ? {
    src: String(image.src),
    alt: String(image.alt || record?.title || ""),
    score: Number(image.score || 0)
  } : { src: "", alt: "", score: 0 };
}

function isDisplayableImageUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === "http:"
      || parsed.protocol === "https:"
      || (parsed.protocol === "data:" && /^data:image\//iu.test(String(value)));
  } catch {
    return false;
  }
}

function isPublicWebUrl(value) {
  try {
    const protocol = new URL(String(value)).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

async function optionalSource(label, promise, fallback) {
  try {
    if (!promise || typeof promise.then !== "function") return fallback;
    return await promise;
  } catch (error) {
    console.warn(`[Recall Search] ${label} unavailable`, error);
    return fallback;
  }
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}
