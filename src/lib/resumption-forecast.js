import { START_PAGE_STATES } from "./start-page-state.js";

const RECENCY_HALF_LIFE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_CANDIDATE_LIMIT = 6;

/**
 * How much each cue is allowed to matter, per recognized state.
 *
 * These are policies, not a learned model. The roadmap's rule is that the
 * recognized environment selects an interpretable ranking policy rather than
 * forcing every job through one unexplained weighted score, so each state gets
 * its own row and every row is legible on its own terms.
 */
export const RESUMPTION_POLICIES = Object.freeze({
  [START_PAGE_STATES.HANDOFF]: {
    weights: { recency: 0.24, investment: 0.16, structure: 0.16, unfinished: 0.14, habit: 0.08, provenance: 0.22 },
    prefer: "foreign",
    open: "damp",
    entry: "resume"
  },
  [START_PAGE_STATES.REORIENTATION]: {
    weights: { recency: 0.14, investment: 0.26, structure: 0.24, unfinished: 0.14, habit: 0.14, provenance: 0.08 },
    prefer: "local",
    open: "neutral",
    entry: "restart"
  },
  [START_PAGE_STATES.REINSTATEMENT]: {
    weights: { recency: 0.30, investment: 0.18, structure: 0.18, unfinished: 0.18, habit: 0.08, provenance: 0.08 },
    prefer: "local",
    open: "prefer",
    entry: "resume"
  },
  [START_PAGE_STATES.CONTINUATION]: {
    weights: { recency: 0.28, investment: 0.16, structure: 0.22, unfinished: 0.20, habit: 0.06, provenance: 0.08 },
    prefer: "local",
    open: "damp",
    entry: "resume"
  },
  [START_PAGE_STATES.THRESHOLD]: {
    weights: { recency: 0.26, investment: 0.16, structure: 0.16, unfinished: 0.14, habit: 0.20, provenance: 0.08 },
    prefer: "local",
    open: "prefer",
    entry: "resume"
  },
  [START_PAGE_STATES.LAUNCH]: {
    weights: { recency: 0.16, investment: 0.14, structure: 0.14, unfinished: 0.10, habit: 0.38, provenance: 0.08 },
    prefer: "local",
    open: "neutral",
    entry: "resume"
  }
});

const DEFAULT_POLICY = RESUMPTION_POLICIES[START_PAGE_STATES.LAUNCH];

/**
 * Rank the browsing activities the user is most likely to resume.
 *
 * Operates on the snapshot's neighborhoods, which now include work recovered
 * from history, so the forecast still has something to say after a restart or
 * a device handoff. Every candidate carries its own evidence; a candidate the
 * evidence cannot support gets a low confidence rather than a suppressed
 * score, so the UI can decline to make a strong claim.
 */
export function forecastResumption(snapshot, { state, limit = DEFAULT_CANDIDATE_LIMIT } = {}) {
  const now = Number(snapshot?.generatedAt) || Date.now();
  const resolvedState = state || snapshot?.recognizedState || START_PAGE_STATES.LAUNCH;
  const policy = RESUMPTION_POLICIES[resolvedState] || DEFAULT_POLICY;
  const neighborhoods = snapshot?.neighborhoods || [];

  const candidates = neighborhoods
    .map(neighborhood => scoreNeighborhood(neighborhood, policy, now))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score
      || right.confidence - left.confidence
      || right.lastActivityAt - left.lastActivityAt
      || left.id.localeCompare(right.id));

  return {
    generatedAt: now,
    state: resolvedState,
    policy: policy.weights,
    candidates: candidates.slice(0, Math.max(0, limit)),
    suppressedCount: Math.max(0, candidates.length - Math.max(0, limit))
  };
}

function scoreNeighborhood(neighborhood, policy, now) {
  const items = neighborhood?.items || [];
  if (items.length === 0) return null;

  const cues = computeCues(neighborhood, now);
  const provenanceCue = policy.prefer === "foreign"
    ? cues.foreignFraction
    : 1 - cues.foreignFraction;

  const weighted = policy.weights.recency * cues.recency
    + policy.weights.investment * cues.investment
    + policy.weights.structure * cues.structure
    + policy.weights.unfinished * cues.unfinished
    + policy.weights.habit * cues.habit
    + policy.weights.provenance * provenanceCue;

  const openMultiplier = openAdjustment(policy.open, cues.openFraction);
  const score = clamp01(weighted * openMultiplier);
  const resumePoint = items[0];
  const entryPoint = selectEntryPoint(neighborhood) || resumePoint;
  const target = policy.entry === "restart" ? entryPoint : resumePoint;

  return {
    id: neighborhood.id,
    score,
    confidence: confidenceFor(neighborhood, cues),
    itemCount: neighborhood.itemCount,
    openCount: neighborhood.openCount,
    recoveredCount: neighborhood.recoveredCount,
    lastActivityAt: neighborhood.lastActivityAt,
    spanMs: neighborhood.spanMs,
    provenance: provenanceLabel(cues.foreignFraction),
    action: {
      verb: actionVerb(policy, target, cues),
      target,
      entryPoint,
      resumePoint
    },
    cues,
    reasons: reasonsFor(neighborhood, cues, policy, now)
  };
}

function computeCues(neighborhood, now) {
  const items = neighborhood.items;
  const itemCount = neighborhood.itemCount || items.length;
  const visitCount = neighborhood.visitCount || 0;
  const edgeCount = (neighborhood.edges || []).length;
  const structuralEdges = (neighborhood.edges || [])
    .filter(edge => edge.types.includes("spawn") || edge.types.includes("referrer")).length;

  const ageMs = Math.max(0, now - Number(neighborhood.lastActivityAt || 0));
  const recency = Number(neighborhood.lastActivityAt) > 0
    ? Math.pow(2, -ageMs / RECENCY_HALF_LIFE_MS)
    : 0;

  // A lone page has no topology to judge and no repeat evidence to read. The
  // roadmap's rule for unavailable evidence is neutral, not zero — a neutral
  // cue plus lower confidence beats a confident dismissal.
  const structure = edgeCount === 0
    ? (itemCount === 1 ? 0.5 : 0)
    : structuralEdges / edgeCount;
  const unfinished = visitCount === 0
    ? 0.5
    : clamp01((neighborhood.followedArrivals || 0) / visitCount);

  return {
    recency,
    ageMs,
    investment: clamp01(
      0.7 * (Math.log2(1 + itemCount) / Math.log2(9))
      + 0.3 * (Math.log2(1 + visitCount) / Math.log2(17))
    ),
    structure,
    unfinished,
    habit: clamp01(((visitCount / Math.max(1, itemCount)) - 1) / 3),
    foreignFraction: visitCount > 0
      ? clamp01((neighborhood.foreignVisitCount || 0) / visitCount)
      : 0,
    openFraction: itemCount > 0 ? (neighborhood.openCount || 0) / itemCount : 0,
    structuralEdges,
    edgeCount
  };
}

function openAdjustment(mode, openFraction) {
  if (mode === "prefer") return 1 + (0.12 * openFraction);
  if (mode === "damp") return 1 - (0.35 * openFraction);
  return 1;
}

/**
 * The page the trail started from — usually a search, hub, or index. Restarting
 * there recovers the branch the user abandoned, which an endpoint cannot.
 */
function selectEntryPoint(neighborhood) {
  const outbound = new Map();
  for (const edge of neighborhood.edges || []) {
    for (const evidence of edge.evidence || []) {
      if (evidence.type === "temporal") continue;
      outbound.set(evidence.sourceKey, (outbound.get(evidence.sourceKey) || 0) + 1);
    }
  }
  if (outbound.size === 0) return null;

  return (neighborhood.items || [])
    .filter(item => outbound.has(item.key))
    .sort((left, right) => (outbound.get(right.key) || 0) - (outbound.get(left.key) || 0)
      || Number(left.lastActivityAt || 0) - Number(right.lastActivityAt || 0))[0] || null;
}

function actionVerb(policy, target, cues) {
  if (target?.open) return "switch";
  if (policy.entry === "restart") return "restart";
  return cues.foreignFraction >= 0.5 ? "continue" : "reopen";
}

function confidenceFor(neighborhood, cues) {
  let confidence = 0.35;
  if (cues.structuralEdges > 0) confidence += 0.22;
  if (neighborhood.itemCount >= 3) confidence += 0.12;
  else if (neighborhood.itemCount === 2) confidence += 0.06;
  if (neighborhood.visitCount > 0) confidence += 0.1;
  if (Number(neighborhood.lastActivityAt) > 0) confidence += 0.08;
  if (cues.edgeCount > 0 && cues.structuralEdges === 0) confidence -= 0.12;
  return Math.max(0, Math.min(0.9, confidence));
}

function provenanceLabel(foreignFraction) {
  if (foreignFraction >= 0.8) return "foreign";
  if (foreignFraction > 0) return "mixed";
  return "local";
}

function reasonsFor(neighborhood, cues, policy, now) {
  const reasons = [];
  const pages = `${neighborhood.itemCount} page${neighborhood.itemCount === 1 ? "" : "s"}`;

  if (cues.structuralEdges > 0) {
    reasons.push(`${pages} joined by ${cues.structuralEdges} followed link${cues.structuralEdges === 1 ? "" : "s"}`);
  } else if (cues.edgeCount > 0) {
    reasons.push(`${pages} active together, no followed link between them`);
  } else {
    reasons.push(`${pages}, no joining evidence`);
  }

  if (neighborhood.recoveredCount > 0) {
    reasons.push(`${neighborhood.recoveredCount} recovered from history, not open now`);
  }
  if (cues.foreignFraction >= 0.8) reasons.push("every visit came from another device");
  else if (cues.foreignFraction > 0) reasons.push("mixes this device with another");

  reasons.push(`last touched ${formatAge(cues.ageMs)} ago`);

  if (cues.unfinished >= 0.6 && cues.structuralEdges > 0) {
    reasons.push("left part-way along the trail");
  }
  if (cues.habit >= 0.5) reasons.push("revisited repeatedly today");
  if (policy.open === "damp" && cues.openFraction === 1) {
    reasons.push("already open — this is a switch, not a resume");
  }
  return reasons;
}

function formatAge(ageMs) {
  if (!Number.isFinite(ageMs)) return "an unknown time";
  const minutes = Math.round(ageMs / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}
