const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 12;
const SHORT_SIGNAL_TOKENS = new Set(["ai", "ar", "eu", "uk", "us", "vr"]);
const STOP_WORDS = new Set([
  "about", "after", "again", "against", "along", "also", "among", "another", "around",
  "because", "before", "being", "between", "could", "during", "from", "github", "have",
  "into", "just", "more", "most", "new", "over", "page", "repo", "repository", "some",
  "than", "that", "their", "there", "these", "they", "this", "through", "under", "using",
  "with", "would", "your"
]);

/**
 * Put relevance-matched explicit stars first, then fill with the newest stars.
 * This is an enrichment rank only and never enters Home prediction evidence.
 */
export function buildGithubStarsEnrichment({
  starItems = [],
  interestTopics = [],
  contextTitles = [],
  limit = DEFAULT_LIMIT
} = {}) {
  const topics = normalizeTopics(interestTopics);
  const topicSignals = topics.map(topic => ({ topic, tokens: signalTokens(topic) }));
  const contextTokens = new Set(asTextArray(contextTitles).flatMap(signalTokens));
  const seen = new Set();
  const ranked = [];

  for (const raw of Array.isArray(starItems) ? starItems : []) {
    const title = cleanText(raw?.title);
    const url = safeGithubRepositoryUrl(raw?.url);
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);

    const description = cleanText(raw?.description);
    const repositoryTopics = unique(asTextArray(raw?.topics).map(value => value.toLocaleLowerCase()));
    const haystack = `${title} ${description} ${repositoryTopics.join(" ")}`.toLocaleLowerCase();
    const tokens = new Set(signalTokens(haystack));
    const matchedTopics = [];
    let relevance = 0;

    for (const signal of topicSignals) {
      const phraseMatch = signal.topic.includes(" ") && haystack.includes(signal.topic);
      const tokenMatches = signal.tokens.filter(token => tokens.has(token));
      if (!phraseMatch && tokenMatches.length === 0) continue;
      matchedTopics.push(signal.topic);
      relevance += phraseMatch ? 7 : Math.min(5, tokenMatches.length * 2);
    }
    relevance += Math.min(4, [...contextTokens].filter(token => tokens.has(token)).length);

    ranked.push({
      id: String(raw?.id || `github-star:${url}`),
      kind: "github-star-enrichment",
      title,
      url,
      description,
      topics: repositoryTopics.slice(0, 4),
      matchedTopics: matchedTopics.slice(0, 3),
      starredAt: finiteTimestamp(raw?.starredAt),
      stars: nonnegativeInteger(raw?.stars),
      matchKind: relevance > 0 ? "related" : "recent",
      relevance,
      action: {
        verb: "open",
        target: { title, url, open: false }
      }
    });
  }

  ranked.sort((left, right) => Number(right.relevance > 0) - Number(left.relevance > 0)
    || right.relevance - left.relevance
    || right.starredAt - left.starredAt
    || left.title.localeCompare(right.title));

  return {
    items: ranked.slice(0, boundedLimit(limit)).map(({ relevance, ...item }) => item),
    matchedCount: ranked.filter(item => item.relevance > 0).length,
    availableCount: ranked.length,
    signalCount: topics.length + contextTokens.size
  };
}

function normalizeTopics(values) {
  return unique(asTextArray((Array.isArray(values) ? values : []).map(value => value?.topic ?? value))
    .map(value => value.toLocaleLowerCase()));
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
    .flatMap(token => token.split(/[.-]+/u))
    .filter(token => (token.length >= 4 || SHORT_SIGNAL_TOKENS.has(token)) && !STOP_WORDS.has(token));
}

function safeGithubRepositoryUrl(value) {
  try {
    const url = new URL(String(value || ""));
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

function cleanText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function nonnegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function boundedLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_LIMIT;
  return Math.max(0, Math.min(MAX_LIMIT, Math.floor(number)));
}

function unique(values) {
  return [...new Set(values)];
}
