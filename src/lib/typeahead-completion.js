/**
 * Return the highest-ranked title or location that extends the text already
 * typed. Typeahead is deliberately prefix-only: a summary or middle-of-title
 * match can remain a useful result without rewriting the user's query.
 */
export function buildTypeaheadCompletion(query, results = []) {
  const typed = String(query || "");
  if (!typed.trim() || typed !== typed.trimStart()) return null;

  for (const result of array(results)) {
    for (const candidate of completionCandidates(result)) {
      if (!extendsPrefix(candidate.value, typed)) continue;
      const suffix = candidate.value.slice(typed.length);
      return {
        query: typed,
        value: typed + suffix,
        suffix,
        kind: candidate.kind,
        resultId: String(result?.id || "")
      };
    }
  }

  return null;
}

function completionCandidates(result) {
  if (!result || typeof result !== "object") return [];
  const title = clean(result.title);
  const domain = clean(result.domain);
  const path = clean(result.path);
  const location = domain && path && path !== "/" ? `${domain}${path}` : domain;
  const candidates = [
    { value: title, kind: "title" },
    { value: location, kind: "location" }
  ];
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = searchable(candidate.value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extendsPrefix(candidate, query) {
  const normalizedCandidate = searchable(candidate);
  const normalizedQuery = searchable(query);
  return normalizedCandidate.length > normalizedQuery.length
    && normalizedCandidate.startsWith(normalizedQuery);
}

function clean(value) {
  return String(value || "").trim();
}

function searchable(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase();
}

function array(value) {
  return Array.isArray(value) ? value : [];
}
