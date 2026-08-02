const DEFAULT_MAX_HERO_PAGES = 160;
const MAX_HERO_IMAGES_PER_PAGE = 3;
const MAX_URL_LENGTH = 4096;
const MAX_ALT_LENGTH = 280;
const MAX_TITLE_LENGTH = 320;

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
