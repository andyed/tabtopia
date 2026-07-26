const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 12;
const SHORT_SIGNAL_TOKENS = new Set(["ai", "ar", "eu", "uk", "us", "vr"]);
const STOP_WORDS = new Set([
  "about", "after", "again", "against", "along", "also", "among", "another", "around",
  "because", "before", "being", "between", "could", "during", "from", "have", "into",
  "just", "more", "most", "new", "over", "page", "says", "some", "than", "that", "their",
  "there", "these", "they", "this", "through", "under", "using", "with", "would", "your"
]);

/**
 * Filter cached Techmeme headlines against archive topics and currently visible
 * Home titles. This lane enriches the page only; its score is never exposed to
 * or combined with prediction evidence.
 */
export function buildTechmemeEnrichment({
  feedItems = [],
  interestTopics = [],
  contextTitles = [],
  limit = DEFAULT_LIMIT
} = {}) {
  const topics = normalizeTopics(interestTopics);
  const topicSignals = topics.map(topic => ({ topic, tokens: signalTokens(topic) }));
  const contextTokens = new Set(asTextArray(contextTitles).flatMap(signalTokens));
  const seen = new Set();
  const ranked = [];

  for (const [index, raw] of (Array.isArray(feedItems) ? feedItems : []).entries()) {
    const title = cleanText(raw?.title);
    const url = safeTechmemeUrl(raw?.url);
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);

    const haystack = title.toLocaleLowerCase();
    const headlineTokens = new Set(signalTokens(title));
    const matchedTopics = [];
    let score = 0;

    for (const signal of topicSignals) {
      const phraseMatch = signal.topic.includes(" ") && haystack.includes(signal.topic);
      const tokenMatches = signal.tokens.filter(token => headlineTokens.has(token));
      if (!phraseMatch && tokenMatches.length === 0) continue;
      matchedTopics.push(signal.topic);
      score += phraseMatch ? 6 : Math.min(4, tokenMatches.length * 2);
    }

    const contextMatches = [...contextTokens].filter(token => headlineTokens.has(token));
    score += Math.min(3, contextMatches.length);
    if (score < 1) continue;

    ranked.push({
      id: String(raw?.id || `techmeme:${url}`),
      kind: "techmeme-enrichment",
      title,
      url,
      publishedAt: finiteTimestamp(raw?.publishedAt),
      matchedTopics: matchedTopics.slice(0, 3),
      relevance: score,
      feedRank: index + 1,
      action: {
        verb: "open",
        target: { title, url, open: false }
      }
    });
  }

  ranked.sort((left, right) => right.relevance - left.relevance
    || left.feedRank - right.feedRank
    || left.url.localeCompare(right.url));

  const safeLimit = boundedLimit(limit);
  return {
    items: ranked.slice(0, safeLimit).map(({ relevance, feedRank, ...item }) => item),
    matchedCount: ranked.length,
    signalCount: topics.length + contextTokens.size
  };
}

function normalizeTopics(values) {
  const topics = asTextArray((Array.isArray(values) ? values : []).map(value => value?.topic ?? value))
    .map(value => value.toLocaleLowerCase());
  return [...new Set(topics)].sort();
}

function asTextArray(value) {
  return (Array.isArray(value) ? value : []).map(cleanText).filter(Boolean);
}

function signalTokens(value) {
  return cleanText(value)
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[’']/gu, "")
    .split(/[^\p{L}\p{N}+#.-]+/u)
    .map(token => token.replace(/^[.-]+|[.-]+$/gu, ""))
    .filter(token => (token.length >= 4 || SHORT_SIGNAL_TOKENS.has(token)) && !STOP_WORDS.has(token));
}

function safeTechmemeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLocaleLowerCase();
    return url.protocol === "https:" && (host === "techmeme.com" || host === "www.techmeme.com")
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function cleanText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function boundedLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_LIMIT;
  return Math.max(0, Math.min(MAX_LIMIT, Math.floor(number)));
}
