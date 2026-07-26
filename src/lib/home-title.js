const DEFAULT_MAX_GRAPHEMES = 56;
const MIN_MAX_GRAPHEMES = 16;
const MAX_MAX_GRAPHEMES = 160;
const SERVICE_SUFFIX_SEPARATOR = /\s(?:\||·|•)\s/gu;
const TRAILING_BREAK_PUNCTUATION = /[\s,;:|·•/\-–—]+$/u;

export const HOME_TITLE_LIMITS = Object.freeze({
  focal: 68,
  activity: 76,
  landscape: 58,
  standard: 54,
  trail: 50,
  compact: 46
});

/**
 * Produce a stable Home-page title without splitting a grapheme or ending in
 * dangling punctuation. Common `Article | Publication` suffixes are removed
 * before word-boundary truncation because Home already renders the domain.
 */
export function truncateHomeTitle(value, { maxGraphemes = DEFAULT_MAX_GRAPHEMES } = {}) {
  const full = normalizeTitle(value);
  const limit = boundedLimit(maxGraphemes);
  if (graphemeLength(full) <= limit) {
    return { full, display: full, truncated: false, strategy: "complete" };
  }

  const withoutService = stripServiceSuffix(full, limit);
  const display = truncateAtWordBoundary(withoutService || full, limit);
  return {
    full,
    display,
    truncated: display !== full,
    strategy: withoutService ? "service-suffix" : "word-boundary"
  };
}

function stripServiceSuffix(value, limit) {
  const separators = [...value.matchAll(SERVICE_SUFFIX_SEPARATOR)];
  const last = separators.at(-1);
  if (!last || last.index === undefined) return "";

  const prefix = value.slice(0, last.index).trim();
  const suffix = value.slice(last.index + last[0].length).trim();
  const minimumPrefix = Math.min(24, Math.ceil(limit * 0.45));
  const maximumSuffix = Math.max(18, Math.floor(limit * 0.55));
  const suffixWords = suffix.split(/\s+/u).filter(Boolean).length;
  if (graphemeLength(prefix) < minimumPrefix) return "";
  if (graphemeLength(suffix) > maximumSuffix || suffixWords > 6) return "";
  return prefix;
}

function truncateAtWordBoundary(value, limit) {
  const contentLimit = Math.max(1, limit - 1);
  if (graphemeLength(value) <= contentLimit) {
    return `${value.replace(TRAILING_BREAK_PUNCTUATION, "")}…`;
  }

  const hardCut = graphemes(value).slice(0, contentLimit).join("");
  let candidate = hardCut;
  const whitespaceIndex = hardCut.search(/\s+\S*$/u);
  if (whitespaceIndex >= Math.floor(contentLimit * 0.55)) {
    candidate = hardCut.slice(0, whitespaceIndex);
  }
  candidate = candidate.replace(TRAILING_BREAK_PUNCTUATION, "").trim();
  if (!candidate) candidate = hardCut.trim();
  return `${candidate}…`;
}

function normalizeTitle(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function graphemeLength(value) {
  return graphemes(value).length;
}

function graphemes(value) {
  if (typeof Intl?.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(value)].map(entry => entry.segment);
  }
  return Array.from(value);
}

function boundedLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_MAX_GRAPHEMES;
  return Math.max(MIN_MAX_GRAPHEMES, Math.min(MAX_MAX_GRAPHEMES, Math.floor(number)));
}
