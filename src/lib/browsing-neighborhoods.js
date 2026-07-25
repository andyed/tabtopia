const DEFAULT_TEMPORAL_GAP_MS = 4 * 60 * 1000;
const DEFAULT_TEMPORAL_HORIZON_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TEMPORAL_NEIGHBORS = 2;
const DEFAULT_TEMPORAL_SPAN_BUDGET_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PAGE_NODES = 200;

const EDGE_WEIGHTS = Object.freeze({
  spawn: 1,
  referrer: 0.86,
  temporal: 0.34
});

// Transitions that mean the user followed something rather than arriving fresh.
// A trail of these is task-shaped; a run of `typed` visits usually is not.
const FOLLOWED_TRANSITIONS = new Set(["link", "form_submit", "generated", "auto_subframe", "manual_subframe"]);

/**
 * Build task-shaped components from open tabs and recent history visits.
 *
 * Nodes come from two sources. Open tabs are live work. History visits are the
 * work that a browser restart, a tab close, or another device left behind —
 * without them a clean window can only ever produce an empty graph, which is
 * exactly the situation (Handoff, Reorientation) where reconstruction matters
 * most. A visit whose URL is already open merges into that tab's node so the
 * same page never appears twice.
 *
 * Spawn, referrer, and visit-referral edges are structural evidence. Temporal
 * overlap is a weaker fallback, bounded both per node and by a component
 * activity-span budget so a long browsing day does not collapse into one
 * global hairball.
 */
export function buildBrowsingNeighborhoods({
  tabs = [],
  visits = [],
  tabHistory = [],
  tabRelationships = [],
  activityByTab = {},
  now = Date.now(),
  temporalGapMs = DEFAULT_TEMPORAL_GAP_MS,
  temporalHorizonMs = DEFAULT_TEMPORAL_HORIZON_MS,
  maxTemporalNeighbors = DEFAULT_MAX_TEMPORAL_NEIGHBORS,
  temporalSpanBudgetMs = DEFAULT_TEMPORAL_SPAN_BUDGET_MS,
  maxPageNodes = DEFAULT_MAX_PAGE_NODES
} = {}) {
  const activityMap = keyedMap(activityByTab);
  const historyByTab = keyedMap(tabHistory);
  const relationshipsByTab = keyedMap(tabRelationships);

  const nodes = new Map();
  const nodeKeyByUrl = new Map();
  const nodeKeyByTabId = new Map();

  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (tab?.id === undefined || tab?.id === null) continue;
    const key = tabNodeKey(tab.id);
    if (nodes.has(key)) continue;
    nodes.set(key, tabNode(tab, key));
    nodeKeyByTabId.set(String(tab.id), key);
    const identity = urlIdentity(tab.url);
    if (identity && !nodeKeyByUrl.has(identity)) nodeKeyByUrl.set(identity, key);
  }

  const nodeKeyByVisitId = new Map();
  for (const visit of selectRecentVisits(visits, now, temporalHorizonMs, maxPageNodes)) {
    const identity = urlIdentity(visit.url);
    if (!identity) continue;

    let key = nodeKeyByUrl.get(identity);
    if (!key) {
      key = pageNodeKey(identity);
      nodes.set(key, pageNode(visit, key, identity));
      nodeKeyByUrl.set(identity, key);
    }
    absorbVisit(nodes.get(key), visit);
    if (visit.visitId !== undefined && visit.visitId !== null) {
      nodeKeyByVisitId.set(String(visit.visitId), key);
    }
  }

  if (nodes.size === 0) return [];

  for (const node of nodes.values()) {
    node.timestamps = resolveTimestamps(node, activityMap, historyByTab, now, temporalHorizonMs);
    node.lastActivityAt = node.timestamps.at(-1) || Number(node.lastAccessed || 0);
  }

  const edges = new Map();

  for (const node of nodes.values()) {
    if (node.kind !== "tab") continue;
    const openerKey = nodeKeyByTabId.get(String(node.openerTabId));
    if (openerKey) addEdge(edges, nodes, openerKey, node.key, "spawn", { origin: "chrome-opener" });
  }

  for (const [rawTabId, relationship] of relationshipsByTab) {
    const targetKey = nodeKeyByTabId.get(String(rawTabId));
    if (!targetKey || !relationship || typeof relationship !== "object") continue;

    const referringKey = nodeKeyByTabId.get(String(relationship.referringTabId));
    if (referringKey) {
      addEdge(edges, nodes, referringKey, targetKey, "spawn", {
        origin: relationship.transitionType || "relationship",
        timestamp: relationship.timestamp
      });
    } else if (relationship.referringURL) {
      const sourceKey = nodeKeyByUrl.get(urlIdentity(relationship.referringURL));
      if (sourceKey) {
        addEdge(edges, nodes, sourceKey, targetKey, "referrer", {
          origin: "relationship-url",
          timestamp: relationship.timestamp
        });
      }
    }

    for (const child of Array.isArray(relationship.childTabs) ? relationship.childTabs : []) {
      const childKey = nodeKeyByTabId.get(String(child?.tabId));
      if (childKey) {
        addEdge(edges, nodes, targetKey, childKey, "spawn", {
          origin: child?.transitionType || "child-tab",
          timestamp: child?.timestamp
        });
      }
    }
  }

  for (const [rawTabId, history] of historyByTab) {
    for (const navigation of Array.isArray(history) ? history : []) {
      const referrer = navigation?.referer || navigation?.referrer || navigation?.referringURL;
      if (!referrer) continue;
      const sourceKey = nodeKeyByUrl.get(urlIdentity(referrer));
      const targetKey = nodeKeyByTabId.get(String(rawTabId))
        || nodeKeyByUrl.get(urlIdentity(navigation?.url));
      if (!sourceKey || !targetKey) continue;
      addEdge(edges, nodes, sourceKey, targetKey, "referrer", {
        origin: "navigation",
        timestamp: navigation?.timestamp
      });
    }
  }

  // Chrome's own referral chain. This is the only structural evidence that
  // survives a tab close, so it carries the reconstruction after a restart.
  for (const visit of selectRecentVisits(visits, now, temporalHorizonMs, maxPageNodes)) {
    const targetKey = nodeKeyByUrl.get(urlIdentity(visit.url));
    const sourceKey = nodeKeyByVisitId.get(String(visit.referringVisitId));
    if (!targetKey || !sourceKey) continue;
    addEdge(edges, nodes, sourceKey, targetKey, "referrer", {
      origin: "visit-referral",
      transition: visit.transition,
      timestamp: Number(visit.visitTime) || undefined
    });
  }

  const index = createComponentIndex(nodes);
  for (const edge of edges.values()) index.union(edge.source, edge.target);

  addTemporalEdges({
    edges,
    nodes,
    index,
    temporalGapMs,
    maxTemporalNeighbors,
    temporalSpanBudgetMs
  });

  return componentsFromGraph(nodes, edges, index);
}

function addTemporalEdges({
  edges,
  nodes,
  index,
  temporalGapMs,
  maxTemporalNeighbors,
  temporalSpanBudgetMs
}) {
  const entries = [...nodes.values()]
    .filter(node => node.timestamps.length > 0)
    .map(node => [node.key, node.timestamps]);

  const candidates = [];
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const distanceMs = nearestDistance(entries[left][1], entries[right][1]);
      if (distanceMs <= temporalGapMs) {
        candidates.push({ source: entries[left][0], target: entries[right][0], distanceMs });
      }
    }
  }

  candidates.sort((a, b) => a.distanceMs - b.distanceMs
    || a.source.localeCompare(b.source)
    || a.target.localeCompare(b.target));
  const temporalDegree = new Map();

  for (const candidate of candidates) {
    const sourceDegree = temporalDegree.get(candidate.source) || 0;
    const targetDegree = temporalDegree.get(candidate.target) || 0;
    if (sourceDegree >= maxTemporalNeighbors || targetDegree >= maxTemporalNeighbors) continue;

    // Coincidence must not chain a whole afternoon into one component. Two
    // pages three minutes apart are plausibly one task; a component spanning
    // hours held together only by overlap is not.
    if (index.spanIfMerged(candidate.source, candidate.target) > temporalSpanBudgetMs) continue;

    addEdge(edges, nodes, candidate.source, candidate.target, "temporal", {
      origin: "activity-overlap",
      distanceMs: candidate.distanceMs
    });
    index.union(candidate.source, candidate.target);
    temporalDegree.set(candidate.source, sourceDegree + 1);
    temporalDegree.set(candidate.target, targetDegree + 1);
  }
}

function tabNode(tab, key) {
  return {
    key,
    kind: "tab",
    id: tab.id,
    tabId: tab.id,
    windowId: tab.windowId,
    title: String(tab.title || "Untitled"),
    url: String(tab.url || ""),
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    open: true,
    openerTabId: tab.openerTabId ?? null,
    lastAccessed: Number(tab.lastAccessed || 0),
    visitCount: 0,
    foreignVisitCount: 0,
    followedArrivals: 0,
    visitTimes: [],
    timestamps: [],
    lastActivityAt: Number(tab.lastAccessed || 0)
  };
}

function pageNode(visit, key, identity) {
  return {
    key,
    kind: "page",
    id: identity,
    tabId: null,
    windowId: null,
    title: String(visit.title || "Untitled"),
    url: visit.url,
    active: false,
    pinned: false,
    open: false,
    openerTabId: null,
    lastAccessed: 0,
    visitCount: 0,
    foreignVisitCount: 0,
    followedArrivals: 0,
    visitTimes: [],
    timestamps: [],
    lastActivityAt: 0
  };
}

function absorbVisit(node, visit) {
  const visitTime = Number(visit.visitTime) || 0;
  node.visitCount += 1;
  if (visit.isLocal === false) node.foreignVisitCount += 1;
  if (FOLLOWED_TRANSITIONS.has(String(visit.transition || ""))) node.followedArrivals += 1;
  if (visitTime > 0) node.visitTimes.push(visitTime);
  if (node.kind === "page" && visitTime >= node.lastAccessed) {
    node.lastAccessed = visitTime;
    if (visit.title) node.title = String(visit.title);
  }
}

function selectRecentVisits(visits, now, horizonMs, maxPageNodes) {
  const cutoff = Number(now) - Math.max(0, Number(horizonMs) || 0);
  return (Array.isArray(visits) ? visits : [])
    .filter(visit => {
      const visitTime = Number(visit?.visitTime);
      return visit?.url
        && Number.isFinite(visitTime)
        && visitTime > 0
        && visitTime <= Number(now)
        && visitTime >= cutoff;
    })
    .sort((left, right) => Number(right.visitTime) - Number(left.visitTime))
    .slice(0, Math.max(0, maxPageNodes) * 4);
}

function resolveTimestamps(node, activityMap, historyByTab, now, horizonMs) {
  const cutoff = Number(now) - Math.max(0, Number(horizonMs) || 0);
  const activity = node.kind === "tab" ? activityMap.get(String(node.tabId)) : null;
  const history = node.kind === "tab" ? historyByTab.get(String(node.tabId)) : null;
  const timestamps = [node.lastAccessed, activity?.lastTouch, ...node.visitTimes];

  for (const event of Array.isArray(activity?.events) ? activity.events : []) {
    timestamps.push(event?.timestamp);
  }
  for (const navigation of Array.isArray(activity?.navigations) ? activity.navigations : []) {
    timestamps.push(navigation?.timestamp);
  }
  for (const navigation of Array.isArray(history) ? history : []) {
    timestamps.push(navigation?.timestamp);
  }

  return [...new Set(timestamps
    .map(Number)
    .filter(timestamp => Number.isFinite(timestamp)
      && timestamp > 0
      && timestamp <= Number(now)
      && timestamp >= cutoff))]
    .sort((a, b) => a - b);
}

function nearestDistance(left, right) {
  let leftIndex = 0;
  let rightIndex = 0;
  let nearest = Number.POSITIVE_INFINITY;

  while (leftIndex < left.length && rightIndex < right.length) {
    nearest = Math.min(nearest, Math.abs(left[leftIndex] - right[rightIndex]));
    if (left[leftIndex] < right[rightIndex]) leftIndex += 1;
    else rightIndex += 1;
  }
  return nearest;
}

function addEdge(edges, nodes, rawSource, rawTarget, type, evidence = {}) {
  const source = String(rawSource ?? "");
  const target = String(rawTarget ?? "");
  if (!nodes.has(source) || !nodes.has(target) || source === target) return;

  const [first, second] = source.localeCompare(target) <= 0 ? [source, target] : [target, source];
  const id = `${first}::${second}`;
  const existing = edges.get(id) || {
    id,
    source: first,
    target: second,
    types: [],
    weight: 0,
    evidence: []
  };
  if (!existing.types.includes(type)) existing.types.push(type);
  existing.weight = Math.max(existing.weight, EDGE_WEIGHTS[type] || 0);
  existing.evidence.push({
    type,
    sourceKey: source,
    targetKey: target,
    ...cleanEvidence(evidence)
  });
  existing.types.sort((left, right) => (EDGE_WEIGHTS[right] || 0) - (EDGE_WEIGHTS[left] || 0));
  edges.set(id, existing);
}

/**
 * Union-find that also tracks each component's activity span, so the temporal
 * pass can refuse a merge before it happens rather than detecting a
 * mega-component afterwards.
 */
function createComponentIndex(nodes) {
  const parent = new Map();
  const bounds = new Map();

  for (const [key, node] of nodes) {
    parent.set(key, key);
    bounds.set(key, node.timestamps.length > 0
      ? { min: node.timestamps[0], max: node.timestamps.at(-1) }
      : { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY });
  }

  const find = key => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    let cursor = key;
    while (parent.get(cursor) !== cursor) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  const spanOf = ({ min, max }) => (Number.isFinite(min) && Number.isFinite(max) ? max - min : 0);

  return {
    find,
    spanIfMerged(left, right) {
      const a = bounds.get(find(left));
      const b = bounds.get(find(right));
      return spanOf({ min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) });
    },
    union(left, right) {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot === rightRoot) return;
      const winner = leftRoot.localeCompare(rightRoot) <= 0 ? leftRoot : rightRoot;
      const loser = winner === leftRoot ? rightRoot : leftRoot;
      const a = bounds.get(leftRoot);
      const b = bounds.get(rightRoot);
      parent.set(loser, winner);
      bounds.set(winner, { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) });
    }
  };
}

function componentsFromGraph(nodes, edgeMap, index) {
  const membersByRoot = new Map();
  for (const key of nodes.keys()) {
    const root = index.find(key);
    if (!membersByRoot.has(root)) membersByRoot.set(root, []);
    membersByRoot.get(root).push(key);
  }

  const components = [];
  for (const memberKeys of membersByRoot.values()) {
    const memberSet = new Set(memberKeys);
    const items = memberKeys
      .map(key => nodes.get(key))
      .sort((left, right) => Number(right.active) - Number(left.active)
        || Number(right.open) - Number(left.open)
        || right.lastActivityAt - left.lastActivityAt
        || String(left.title).localeCompare(String(right.title)));
    const edges = [...edgeMap.values()]
      .filter(edge => memberSet.has(edge.source) && memberSet.has(edge.target))
      .map(edge => ({ ...edge, evidence: edge.evidence.map(item => ({ ...item })) }));
    const relationCounts = { spawn: 0, referrer: 0, temporal: 0 };
    for (const edge of edges) {
      for (const type of edge.types) relationCounts[type] += 1;
    }
    const windowIds = [...new Set(items.map(item => item.windowId)
      .filter(id => id !== undefined && id !== null))];
    const activity = items.flatMap(item => item.timestamps);
    const stableKey = memberKeys.slice().sort((a, b) => a.localeCompare(b))[0];

    components.push({
      id: `component:${stableKey}`,
      kind: "connected-component",
      items,
      edges,
      itemCount: items.length,
      openCount: items.filter(item => item.open).length,
      recoveredCount: items.filter(item => !item.open).length,
      foreignVisitCount: items.reduce((sum, item) => sum + item.foreignVisitCount, 0),
      visitCount: items.reduce((sum, item) => sum + item.visitCount, 0),
      followedArrivals: items.reduce((sum, item) => sum + item.followedArrivals, 0),
      windowIds,
      focused: items.some(item => item.active),
      firstActivityAt: activity.length > 0 ? Math.min(...activity) : 0,
      lastActivityAt: Math.max(0, ...items.map(item => Number(item.lastActivityAt || 0))),
      spanMs: activity.length > 0 ? Math.max(...activity) - Math.min(...activity) : 0,
      relationCounts
    });
  }

  return components.sort((left, right) => Number(right.focused) - Number(left.focused)
    || right.lastActivityAt - left.lastActivityAt
    || right.itemCount - left.itemCount
    || left.id.localeCompare(right.id));
}

function keyedMap(value) {
  if (value instanceof Map) {
    return new Map([...value.entries()].map(([key, item]) => [String(key ?? ""), item]));
  }
  if (Array.isArray(value)) {
    return new Map(value
      .filter(entry => Array.isArray(entry) && entry.length >= 2)
      .map(([key, item]) => [String(key ?? ""), item]));
  }
  if (value && typeof value === "object") {
    return new Map(Object.entries(value).map(([key, item]) => [String(key), item]));
  }
  return new Map();
}

function tabNodeKey(tabId) {
  return `tab:${tabId}`;
}

function pageNodeKey(identity) {
  return `page:${identity}`;
}

export function urlIdentity(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
}

function cleanEvidence(evidence) {
  return Object.fromEntries(Object.entries(evidence)
    .filter(([, value]) => value !== undefined
      && value !== null
      && (typeof value !== "number" || Number.isFinite(value))));
}
