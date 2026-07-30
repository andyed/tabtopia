const MIN_GRAPH_ROLES = 3;
const MAX_GRAPH_ROLES = 10;
const STRUCTURAL_EDGE_TYPES = new Set(["spawn", "referrer"]);

/**
 * Project a browsing neighborhood into a deterministic, display-only journey.
 *
 * Ranking continues to use the canonical neighborhood unchanged. This layer
 * groups query variants by origin + pathname so the Home graph can show stable
 * page roles, then restores direction from each evidence record's sourceKey and
 * targetKey. It never infers intent labels such as goal, detour, or recovery.
 */
export function buildActivityJourney({ items = [], edges = [] } = {}) {
  const roles = new Map();
  const roleBySourceKey = new Map();

  for (const rawItem of array(items)) {
    const item = normalizeItem(rawItem);
    if (!item) continue;

    let role = roles.get(item.roleKey);
    if (!role) {
      role = {
        id: item.roleKey,
        title: item.title,
        url: item.url,
        domain: item.domain,
        path: item.path,
        sourceKeys: [],
        recordedPages: 0,
        visitCount: 0,
        internalTransitions: 0,
        firstSeenAt: item.firstSeenAt,
        lastSeenAt: item.lastSeenAt,
        open: false,
        active: false,
        representativeAt: item.representativeAt,
        target: item.target
      };
      roles.set(item.roleKey, role);
    }

    role.sourceKeys.push(item.sourceKey);
    role.recordedPages += 1;
    role.visitCount += item.visitCount;
    role.firstSeenAt = earliest(role.firstSeenAt, item.firstSeenAt);
    role.lastSeenAt = Math.max(role.lastSeenAt, item.lastSeenAt);
    role.open ||= item.open;
    role.active ||= item.active;
    if ((item.open && !role.target?.open)
      || (item.open === Boolean(role.target?.open) && item.representativeAt >= role.representativeAt)) {
      role.title = item.title;
      role.url = item.url;
      role.representativeAt = item.representativeAt;
      role.target = item.target;
    }
    roleBySourceKey.set(item.sourceKey, item.roleKey);
  }

  const nodes = [...roles.values()];
  if (nodes.length < MIN_GRAPH_ROLES || nodes.length > MAX_GRAPH_ROLES) return null;

  const projectedEdges = aggregateEdges(edges, roleBySourceKey, roles);
  const structuralEdges = projectedEdges.filter(edge => edge.kind === "structural");
  if (structuralEdges.length < 2) return null;

  nodes.sort(compareNodes);
  const positions = journeyPositions(nodes.length);
  const indexById = new Map();
  nodes.forEach((node, index) => {
    node.index = index;
    node.position = positions[index];
    node.first = index === 0;
    node.latest = index === nodes.length - 1;
    node.repeated = node.visitCount > 1 || node.recordedPages > 1 || node.internalTransitions > 0;
    node.showFavicon = index === 0 || node.domain !== nodes[index - 1]?.domain;
    delete node.representativeAt;
    indexById.set(node.id, index);
  });

  projectedEdges.sort((left, right) => {
    const leftTime = left.firstSeenAt || Number.POSITIVE_INFINITY;
    const rightTime = right.firstSeenAt || Number.POSITIVE_INFINITY;
    return leftTime - rightTime
      || indexById.get(left.source) - indexById.get(right.source)
      || indexById.get(left.target) - indexById.get(right.target)
      || left.kind.localeCompare(right.kind);
  });

  return {
    nodes,
    edges: projectedEdges,
    recordedPageCount: nodes.reduce((sum, node) => sum + node.recordedPages, 0),
    roleCount: nodes.length,
    structuralEdgeCount: structuralEdges.length,
    followedTransitionCount: structuralEdges.reduce((sum, edge) => sum + edge.count, 0),
    repeatedRoleCount: nodes.filter(node => node.repeated).length,
    dominantDomain: dominantValue(nodes.map(node => node.domain))
  };
}

export function pageRoleIdentity(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    if (!["http:", "https:"].includes(url.protocol)) return "";
    const host = url.hostname.toLowerCase().replace(/^www\./u, "");
    const port = url.port ? `:${url.port}` : "";
    let pathname = url.pathname.replace(/\/{2,}/gu, "/") || "/";
    if (pathname.length > 1) pathname = pathname.replace(/\/+$/u, "");
    return `${url.protocol}//${host}${port}${pathname}`;
  } catch {
    return "";
  }
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const roleKey = pageRoleIdentity(raw.url);
  const sourceKey = String(raw.key ?? raw.id ?? "");
  if (!roleKey || !sourceKey) return null;

  const timestamps = [
    ...array(raw.timestamps),
    ...array(raw.visitTimes),
    raw.lastAccessed,
    raw.lastActivityAt
  ].map(Number).filter(timestamp => Number.isFinite(timestamp) && timestamp > 0);
  const visitCount = Math.max(1, Math.floor(Number(raw.visitCount) || 0));
  const roleUrl = new URL(roleKey);

  return {
    roleKey,
    sourceKey,
    title: String(raw.title || roleUrl.hostname || "Destination"),
    url: String(raw.url || roleKey),
    domain: roleUrl.hostname.replace(/^www\./u, ""),
    path: displayPath(roleUrl),
    visitCount,
    firstSeenAt: timestamps.length > 0 ? Math.min(...timestamps) : 0,
    lastSeenAt: timestamps.length > 0 ? Math.max(...timestamps) : 0,
    representativeAt: Number(raw.lastActivityAt || raw.lastAccessed || 0),
    open: Boolean(raw.open),
    active: Boolean(raw.active),
    target: {
      title: String(raw.title || roleUrl.hostname || "Destination"),
      url: String(raw.url || roleKey),
      open: Boolean(raw.open),
      tabId: Number.isInteger(raw.tabId) ? raw.tabId : (Number.isInteger(raw.id) ? raw.id : null),
      windowId: Number.isInteger(raw.windowId) ? raw.windowId : null
    }
  };
}

function aggregateEdges(rawEdges, roleBySourceKey, roles) {
  const aggregated = new Map();
  const seenEvidence = new Set();

  for (const rawEdge of array(rawEdges)) {
    const evidenceItems = array(rawEdge?.evidence);
    // Structural direction is meaningful only when the telemetry names the
    // source and target. A bare graph edge may be canonicalized, so it is safe
    // only as an undirected temporal relation.
    const fallbackTypes = evidenceItems.length === 0
      ? array(rawEdge?.types).filter(type => type === "temporal")
      : [];
    const candidates = evidenceItems.length > 0
      ? evidenceItems
      : fallbackTypes.map(type => ({ type, sourceKey: rawEdge?.source, targetKey: rawEdge?.target }));

    for (const evidence of candidates) {
      const type = String(evidence?.type || "");
      if (!STRUCTURAL_EDGE_TYPES.has(type) && type !== "temporal") continue;
      const source = roleBySourceKey.get(String(evidence?.sourceKey ?? ""));
      const target = roleBySourceKey.get(String(evidence?.targetKey ?? ""));
      if (!source || !target) continue;

      const timestamp = finiteTimestamp(evidence?.timestamp);
      const signature = [
        type,
        String(evidence?.sourceKey ?? ""),
        String(evidence?.targetKey ?? ""),
        timestamp || String(evidence?.origin || "")
      ].join("|");
      if (seenEvidence.has(signature)) continue;
      seenEvidence.add(signature);

      if (source === target) {
        roles.get(source).internalTransitions += 1;
        continue;
      }

      const kind = type === "temporal" ? "temporal" : "structural";
      const [edgeSource, edgeTarget] = kind === "temporal" && source.localeCompare(target) > 0
        ? [target, source]
        : [source, target];
      const id = `${kind}:${edgeSource}->${edgeTarget}`;
      let edge = aggregated.get(id);
      if (!edge) {
        edge = {
          id,
          source: edgeSource,
          target: edgeTarget,
          kind,
          count: 0,
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          origins: []
        };
        aggregated.set(id, edge);
      }
      edge.count += 1;
      edge.firstSeenAt = earliest(edge.firstSeenAt, timestamp);
      edge.lastSeenAt = Math.max(edge.lastSeenAt, timestamp);
      if (evidence?.origin && !edge.origins.includes(String(evidence.origin))) {
        edge.origins.push(String(evidence.origin));
      }
    }
  }

  return [...aggregated.values()];
}

function journeyPositions(count) {
  const columns = count <= 3 ? count : Math.ceil(count / 2);
  const topCount = Math.min(count, columns);
  const bottomCount = count - topCount;
  const positions = [];

  for (let column = 0; column < topCount; column += 1) {
    positions.push({ x: columnPosition(column, columns), y: bottomCount > 0 ? 28 : 50 });
  }
  for (let offset = 0; offset < bottomCount; offset += 1) {
    const column = columns - 1 - offset;
    positions.push({ x: columnPosition(column, columns), y: 74 });
  }
  return positions;
}

function columnPosition(column, columns) {
  if (columns <= 1) return 50;
  return 10 + ((80 * column) / (columns - 1));
}

function compareNodes(left, right) {
  const leftFirst = left.firstSeenAt || Number.POSITIVE_INFINITY;
  const rightFirst = right.firstSeenAt || Number.POSITIVE_INFINITY;
  const leftLast = left.lastSeenAt || Number.POSITIVE_INFINITY;
  const rightLast = right.lastSeenAt || Number.POSITIVE_INFINITY;
  return leftFirst - rightFirst
    || leftLast - rightLast
    || left.id.localeCompare(right.id);
}

function displayPath(url) {
  const pieces = url.pathname.split("/").filter(Boolean);
  const leaf = pieces.at(-1) || "home";
  return `${url.hostname.replace(/^www\./u, "")}/${leaf}`;
}

function dominantValue(values) {
  const counts = new Map();
  let winner = "";
  for (const value of values.filter(Boolean)) {
    counts.set(value, (counts.get(value) || 0) + 1);
    if (!winner || counts.get(value) > counts.get(winner)) winner = value;
  }
  return winner;
}

function earliest(left, right) {
  if (!left) return right || 0;
  if (!right) return left;
  return Math.min(left, right);
}

function finiteTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}
