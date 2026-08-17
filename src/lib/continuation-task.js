const STRUCTURAL_TYPES = new Set(["spawn", "referrer"]);
const GOOGLE_HOST = /(^|\.)google\.[a-z.]+$/u;

/**
 * Project an evidence-rich browsing neighborhood into a task-shaped
 * continuation. This is a ranking projection: the neighborhood remains the
 * canonical topology and the exact recorded URL remains the action target.
 */
export function projectContinuationTask(neighborhood = {}) {
  const items = Array.isArray(neighborhood?.items) ? neighborhood.items : [];
  if (items.length === 0) return null;

  const graph = structuralGraph(neighborhood?.edges);
  const candidates = [
    projectSearchExploration(items, graph),
    projectMapsTask(items, graph)
  ].filter(Boolean);

  return candidates.sort((left, right) => right.depth - left.depth
    || right.lastActivityAt - left.lastActivityAt
    || left.kind.localeCompare(right.kind))[0] || null;
}

function projectSearchExploration(items, graph) {
  const groups = new Map();
  for (const item of items) {
    const search = googleSearch(item?.url);
    if (!search) continue;
    const group = groups.get(search.key) || { ...search, items: [], keys: new Set() };
    group.items.push(item);
    group.keys.add(String(item.key || ""));
    groups.set(search.key, group);
  }

  const candidates = [];
  for (const group of groups.values()) {
    const branchKeys = new Set();
    for (const key of group.keys) {
      for (const target of graph.outgoing.get(key) || []) {
        if (!group.keys.has(target)) branchKeys.add(target);
      }
    }
    if (branchKeys.size < 2) continue;

    const reachable = reachableFrom(group.keys, graph.outgoing);
    const resultCount = [...reachable].filter(key => !group.keys.has(key)).length;
    const pathDepth = maxDepthFrom(group.keys, graph.outgoing);
    const depth = clamp01(
      0.62
      + (Math.min(4, branchKeys.size) - 2) * 0.1
      + Math.min(0.18, Math.max(0, pathDepth - 1) * 0.06)
    );
    const entry = latestItem(group.items);
    const queryLabel = compactLabel(group.query, 80);

    candidates.push({
      kind: "search-exploration",
      label: `Search · ${queryLabel}`,
      depth,
      depthBand: depth >= 0.8 ? "deep" : "developing",
      lastActivityAt: latestActivity(group.items),
      target: taskTarget(entry, `Search · ${queryLabel}`),
      entryPoint: taskTarget(entry, `Search · ${queryLabel}`),
      evidence: {
        query: group.query,
        branchCount: branchKeys.size,
        resultCount,
        pathDepth
      },
      reasons: [
        `${branchKeys.size} results opened from “${queryLabel}”`,
        ...(pathDepth > 1 ? [`exploration continued ${pathDepth} steps from the search`] : [])
      ]
    });
  }

  return candidates.sort((left, right) => right.depth - left.depth
    || right.lastActivityAt - left.lastActivityAt
    || left.label.localeCompare(right.label))[0] || null;
}

function projectMapsTask(items, graph) {
  const states = new Map();
  for (const item of items) {
    const state = googleMapsState(item?.url);
    if (!state) continue;
    const previous = states.get(state.key);
    if (!previous || activityAt(item) >= activityAt(previous.item)) {
      states.set(state.key, { ...state, item });
    }
  }
  if (states.size === 0) return null;

  const values = [...states.values()];
  const directions = values.filter(item => item.stage === "directions");
  const places = values.filter(item => item.stage === "place");
  const searches = values.filter(item => item.stage === "search");
  const directedProgression = countMapProgression(values, graph);
  const latest = values.sort((left, right) => activityAt(right.item) - activityAt(left.item))[0];

  let depth = 0.5;
  let depthBand = "shallow";
  let label = latest.label;
  if (directions.length > 0) {
    depth = 0.9;
    depthBand = "deep";
    label = directions.sort((left, right) => activityAt(right.item) - activityAt(left.item))[0].label;
  } else if (places.length >= 2) {
    depth = clamp01(0.72 + Math.min(0.18, (places.length - 2) * 0.06));
    depthBand = depth >= 0.8 ? "deep" : "developing";
    label = `Compare ${places.length} places`;
  } else if (searches.length > 0 && places.length > 0) {
    depth = 0.68;
    depthBand = "developing";
    label = places[0].label;
  } else if (places.length === 1) {
    depth = 0.56;
    depthBand = "focused";
    label = places[0].label;
  }
  depth = clamp01(depth + Math.min(0.08, directedProgression * 0.04));

  const preferred = directions.length > 0
    ? directions.sort((left, right) => activityAt(right.item) - activityAt(left.item))[0]
    : latest;
  return {
    kind: "maps-continuation",
    label,
    depth,
    depthBand,
    lastActivityAt: activityAt(preferred.item),
    target: taskTarget(preferred.item, label),
    entryPoint: taskTarget(preferred.item, label),
    evidence: {
      stageCount: states.size,
      placeCount: places.length,
      hasDirections: directions.length > 0,
      directedProgression
    },
    reasons: [
      directions.length > 0
        ? "place exploration progressed to directions"
        : places.length >= 2
          ? `${places.length} places compared in Maps`
          : `Maps activity reached ${latest.stage}`
    ]
  };
}

function structuralGraph(edges) {
  const outgoing = new Map();
  const structuralPairs = [];
  const seenPairs = new Set();
  for (const edge of Array.isArray(edges) ? edges : []) {
    for (const evidence of Array.isArray(edge?.evidence) ? edge.evidence : []) {
      if (!STRUCTURAL_TYPES.has(String(evidence?.type || ""))) continue;
      const source = String(evidence?.sourceKey || "");
      const target = String(evidence?.targetKey || "");
      if (!source || !target || source === target) continue;
      if (!outgoing.has(source)) outgoing.set(source, new Set());
      outgoing.get(source).add(target);
      const signature = JSON.stringify([source, target]);
      if (!seenPairs.has(signature)) {
        seenPairs.add(signature);
        structuralPairs.push({ source, target });
      }
    }
  }
  return { outgoing, structuralPairs };
}

function countMapProgression(states, graph) {
  const stageByKey = new Map();
  for (const state of states) stageByKey.set(String(state.item?.key || ""), state.stage);
  const rank = { search: 1, place: 2, directions: 3 };
  let count = 0;
  for (const { source, target } of graph.structuralPairs) {
    if ((rank[stageByKey.get(target)] || 0) > (rank[stageByKey.get(source)] || 0)) count += 1;
  }
  return count;
}

function googleSearch(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    const host = url.hostname.toLowerCase().replace(/^www\./u, "");
    if (!GOOGLE_HOST.test(host) || url.pathname !== "/search") return null;
    const query = cleanText(url.searchParams.get("q"));
    if (!query) return null;
    return { query, key: query.toLocaleLowerCase() };
  } catch {
    return null;
  }
}

function googleMapsState(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    const host = url.hostname.toLowerCase().replace(/^www\./u, "");
    const googleMapsHost = host.startsWith("maps.google.");
    if (!googleMapsHost && (!GOOGLE_HOST.test(host) || !url.pathname.startsWith("/maps"))) return null;

    const pieces = url.pathname.split("/").filter(Boolean).map(decodePiece);
    const mapsIndex = pieces[0] === "maps" ? 0 : -1;
    const stage = mapsIndex >= 0 ? pieces[mapsIndex + 1] : "search";
    const values = mapsIndex >= 0 ? pieces.slice(mapsIndex + 2) : [];

    if (stage === "dir") {
      const endpoints = values.filter(piece => piece && !piece.startsWith("@") && piece !== "data").slice(0, 2);
      const label = endpoints.length >= 2
        ? `Directions · ${compactLabel(endpoints[0], 38)} → ${compactLabel(endpoints[1], 38)}`
        : "Directions in Maps";
      return { stage: "directions", key: `directions:${endpoints.join("->").toLocaleLowerCase()}`, label };
    }
    if (stage === "place") {
      const place = cleanText(values[0]);
      if (!place) return null;
      return { stage: "place", key: `place:${place.toLocaleLowerCase()}`, label: `Place · ${compactLabel(place, 72)}` };
    }
    if (stage === "search") {
      const query = cleanText(values[0] || url.searchParams.get("q"));
      if (!query) return null;
      return { stage: "search", key: `search:${query.toLocaleLowerCase()}`, label: `Map search · ${compactLabel(query, 72)}` };
    }

    const query = cleanText(url.searchParams.get("q"));
    return query
      ? { stage: "search", key: `search:${query.toLocaleLowerCase()}`, label: `Map search · ${compactLabel(query, 72)}` }
      : null;
  } catch {
    return null;
  }
}

function reachableFrom(sourceKeys, outgoing) {
  const seen = new Set(sourceKeys);
  const queue = [...sourceKeys];
  while (queue.length > 0) {
    const source = queue.shift();
    for (const target of outgoing.get(source) || []) {
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

function maxDepthFrom(sourceKeys, outgoing) {
  const depths = new Map([...sourceKeys].map(key => [key, 0]));
  const queue = [...sourceKeys];
  while (queue.length > 0) {
    const source = queue.shift();
    const nextDepth = (depths.get(source) || 0) + 1;
    for (const target of outgoing.get(source) || []) {
      if ((depths.get(target) ?? -1) >= nextDepth) continue;
      depths.set(target, nextDepth);
      if (nextDepth <= 12) queue.push(target);
    }
  }
  return Math.max(0, ...depths.values());
}

function taskTarget(item, title) {
  if (!item) return null;
  return { ...item, title: String(title || item.title || "Continue") };
}

function latestItem(items) {
  return [...items].sort((left, right) => activityAt(right) - activityAt(left))[0] || null;
}

function latestActivity(items) {
  return Math.max(0, ...items.map(activityAt));
}

function activityAt(item) {
  return Number(item?.lastActivityAt || item?.lastAccessed || 0);
}

function decodePiece(value) {
  try {
    return decodeURIComponent(String(value || "").replace(/\+/gu, " "));
  } catch {
    return String(value || "").replace(/\+/gu, " ");
  }
}

function cleanText(value) {
  return decodePiece(value).replace(/\s+/gu, " ").trim();
}

function compactLabel(value, limit) {
  const text = cleanText(value);
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}
