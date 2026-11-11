/** Exact scope membership and explainable facet clusters; no inferred semantic similarity. */
export const clipKey = clip => String(clip.url || clip.id);
export function valuesOf(clip, key) {
  const raw = key in clip ? clip[key] : clip.props?.[key];
  return (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map(String)
    .map(value => key === 'captured' ? value.slice(0, 7) : value);
}
/** Shared OR-within-facet predicate, including captured-date prefix semantics. */
export function matchesFacet(clip, key, values) {
  return !values.size || valuesOf(clip, key).some(value =>
    key === 'captured' ? [...values].some(want => value.startsWith(want)) : values.has(value));
}
export function matchesFilters(clip, query, active) {
  const hay = [clip.title, clip.note, clip.source, clip.url, ...(clip.tags || [])].join(' ').toLowerCase();
  if (!query.trim().toLowerCase().split(/\s+/).every(term => hay.includes(term))) return false;
  return [...active].every(([key, values]) => matchesFacet(clip, key, values));
}
export function filterScope(clips, { query, active, branches }) {
  const keys = branches === null ? null : new Set(branches.flatMap(branch => branch.keys));
  return clips.filter(clip => (!keys || keys.has(clipKey(clip))) && matchesFilters(clip, query, active));
}
export function chooseCluster(current, cluster, add, label = 'Previous scope') {
  return add ? [{ label, keys: current.map(clipKey) }, { label: cluster.label, keys: [...cluster.keys] }]
    : [{ label: cluster.label, keys: [...cluster.keys] }];
}
export function contextClusters(clips, selected, labels = {}, active = new Map()) {
  if (!selected.length || selected.length === clips.length) return [];
  const selectedKeys = new Set(selected.map(clipKey));
  const outside = clips.filter(clip => !selectedKeys.has(clipKey(clip)));
  const families = [['captured', 'year'], ['color'], ['kaleido', 'complexity', 'repetition'], ['tags', 'source']];
  const result = [], seen = new Set();
  for (const family of families) {
    const candidates = [];
    for (const key of family) {
      const groups = new Map(), foreground = new Map();
      for (const clip of selected) for (const value of new Set(valuesOf(clip, key))) foreground.set(value, (foreground.get(value) || 0) + 1);
      for (const clip of outside) for (const value of new Set(valuesOf(clip, key))) {
        if (!value || ['unknown', 'uncertain'].includes(value)) continue;
        if (!groups.has(value)) groups.set(value, []);
        groups.get(value).push(clip);
      }
      for (const [value, members] of groups) {
        const shared = foreground.get(value) || 0;
        // Dates supply temporal alternatives; other families require a shared attribute.
        if (!shared && !['captured', 'year'].includes(key) && !active.has(key)) continue;
        const distance = key === 'captured' ? Math.min(...[...foreground.keys()].map(v =>
          Math.abs(Date.parse(v + '-01') - Date.parse(value + '-01')) / 86400000)) : 0;
        // Near-universal attributes (for example weak repetition) do not make useful neighbours.
        const prevalence = (members.length + shared) / clips.length;
        if (family === families[2] && prevalence > 0.9 && !active.has(key)) continue;
        const score = (shared / selected.length) * Math.log(1 + 1 / prevalence) + (active.has(key) ? 1 : 0) +
          (key === 'captured' ? 1 / (1 + (Number.isFinite(distance) ? distance / 31 : 100)) : 0);
        const keys = [...new Set(members.map(clipKey))];
        const signature = [...keys].sort().join('\n');
        candidates.push({ id: `${key}:${value}`, label: `${labels[key] || key}: ${value}`,
          reason: shared ? `Shares ${value} with ${shared} current items` : `Alternative ${labels[key] || key}`,
          keys, members, score, signature });
      }
    }
    candidates.sort((a, b) => b.score - a.score || b.keys.length - a.keys.length || a.id.localeCompare(b.id));
    const best = candidates.find(candidate => !seen.has(candidate.signature));
    if (best) { seen.add(best.signature); result.push(best); }
    if (result.length === 3) break;
  }
  return result;
}
