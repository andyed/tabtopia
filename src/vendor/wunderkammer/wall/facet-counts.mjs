/**
 * Value counts per facet, derived from the clips themselves. Facets are
 * derived, not configured: any frontmatter or props key becomes filterable.
 *
 * One copy for the server (/api/clips), the static demo build and the
 * collection loader in the browser. It lives under wall/ because that is the
 * shared code the browser can import; serve.mjs already imports
 * wall/permalink.mjs the same way. The server and demo copies had drifted:
 * the server's assumed every clip carried a tags array.
 */
export function buildFacets(clips) {
  const facets = { tags: {}, source: {}, kind: {}, captured: {} };
  const propKeys = new Map();

  for (const c of clips) {
    for (const t of c.tags || []) facets.tags[t] = (facets.tags[t] || 0) + 1;
    if (c.source) facets.source[c.source] = (facets.source[c.source] || 0) + 1;
    if (c.kind) facets.kind[c.kind] = (facets.kind[c.kind] || 0) + 1;
    const month = String(c.captured || '').slice(0, 7);
    if (month) facets.captured[month] = (facets.captured[month] || 0) + 1;

    for (const [k, v] of Object.entries(c.props || {})) {
      if (v === '' || v === null || v === undefined) continue;
      if (!propKeys.has(k)) propKeys.set(k, {});
      const bucket = propKeys.get(k);
      for (const item of Array.isArray(v) ? v : [v]) {
        bucket[String(item)] = (bucket[String(item)] || 0) + 1;
      }
    }
  }
  for (const [k, bucket] of propKeys) facets[k] = bucket;
  return facets;
}
