import { normalizeIdentity } from "./revisit-model.js";
import { isQualifiedContinuationAlternative } from "./resumption-forecast.js";
import { START_PAGE_STATES } from "./start-page-state.js";

const DEFAULT_ACTION_LIMIT = 18;
const MAX_ACTION_LIMIT = 24;
const SOURCE_SLOTS = Object.freeze(["habit", "star", "habit", "star", "habit", "star"]);
const SOURCE_ORDER = Object.freeze(["habit", "star", "activity", "foreign"]);

export const HOME_COMPOSITION_MODES = Object.freeze({
  QUIET: "quiet",
  ENGAGED: "engaged",
  RETURN: "return"
});

/**
 * Compose independently ranked source lanes into a flexible home view model.
 *
 * Habit and star scores are never compared. Explicit source slots choose which
 * lane contributes an action. Resumption activities remain a separate shape;
 * when an activity has the same endpoint as a selected page action, only its
 * evidence is attached to that action and no score is combined or donated.
 */
export function buildStartPageFeed({
  state = START_PAGE_STATES.LAUNCH,
  habitDestinations = [],
  deferredIntentions = [],
  resumptionActivities = [],
  neighborhoods = [],
  generatedAt = Date.now(),
  actionLimit = DEFAULT_ACTION_LIMIT
} = {}) {
  const habits = candidateArray(habitDestinations);
  const stars = candidateArray(deferredIntentions);
  const activities = candidateArray(resumptionActivities);
  const actionEntries = indexPageActions(habits, stars);
  const safeLimit = boundedLimit(actionLimit);
  let selected = selectBySourceSlots(actionEntries, habits, stars, safeLimit);
  const selectedByPage = new Map(selected.map(action => [action.pageIdentity, action]));

  let primaryActivity = null;
  let continuationAlternative = null;
  for (const activity of activities) {
    const pageIdentity = pageOf(activity?.action?.target?.url);
    const matchingAction = pageIdentity ? selectedByPage.get(pageIdentity) : null;
    if (matchingAction) {
      addEvidence(matchingAction, "activity", activity);
      adoptSwitchTarget(matchingAction, activity);
    } else if (!primaryActivity) {
      primaryActivity = normalizePrimaryActivity(activity);
    } else if (pageIdentity
      && !continuationAlternative
      && shouldPromoteContinuationAlternative(activity, state)) {
      continuationAlternative = createPageAction(pageIdentity, activity);
      addEvidence(continuationAlternative, "activity", activity);
      adoptSwitchTarget(continuationAlternative, activity);
    }
  }

  if (continuationAlternative && safeLimit > 0) {
    selected = [continuationAlternative, ...selected]
      .filter((action, index, actions) => actions.findIndex(item => item.pageIdentity === action.pageIdentity) === index)
      .slice(0, safeLimit);
  }

  return {
    generatedAt: finiteTimestamp(generatedAt) || Date.now(),
    state,
    mode: compositionModeForState(state),
    actions: selected.map(finalizeAction),
    primaryActivity,
    neighborhoods: Array.isArray(neighborhoods) ? neighborhoods.slice() : [],
    sourceSlots: SOURCE_SLOTS.slice(),
    sourceCounts: {
      habit: habits.length,
      star: stars.length,
      activity: activities.length
    }
  };
}

function shouldPromoteContinuationAlternative(activity, state) {
  return state === START_PAGE_STATES.CONTINUATION
    && isQualifiedContinuationAlternative(activity);
}

export function compositionModeForState(state) {
  if (state === START_PAGE_STATES.CONTINUATION) return HOME_COMPOSITION_MODES.ENGAGED;
  if ([
    START_PAGE_STATES.REINSTATEMENT,
    START_PAGE_STATES.REORIENTATION,
    START_PAGE_STATES.HANDOFF
  ].includes(state)) return HOME_COMPOSITION_MODES.RETURN;
  return HOME_COMPOSITION_MODES.QUIET;
}

function candidateArray(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.candidates) ? value.candidates : [];
}

function indexPageActions(habits, stars) {
  const entries = new Map();
  for (const [source, candidates] of [["habit", habits], ["star", stars]]) {
    for (const candidate of candidates) {
      const pageIdentity = pageOf(candidate?.action?.target?.url);
      if (!pageIdentity) continue;
      let entry = entries.get(pageIdentity);
      if (!entry) {
        entry = createPageAction(pageIdentity, candidate);
        entries.set(pageIdentity, entry);
      }
      addEvidence(entry, source, candidate);
      adoptSwitchTarget(entry, candidate);
    }
  }
  return entries;
}

function createPageAction(pageIdentity, candidate) {
  return {
    id: `page:${pageIdentity}`,
    kind: "page-action",
    pageIdentity,
    action: {
      verb: candidate?.action?.verb === "switch" ? "switch" : "open",
      target: cloneTarget(candidate?.action?.target)
    },
    sources: [],
    evidence: []
  };
}

function selectBySourceSlots(entries, habits, stars, limit) {
  if (limit === 0) return [];
  const queues = {
    habit: uniquePageQueue(habits),
    star: uniquePageQueue(stars)
  };
  const offsets = { habit: 0, star: 0 };
  const selected = [];
  const selectedPages = new Set();

  for (let slotIndex = 0; selected.length < limit; slotIndex += 1) {
    const preferred = SOURCE_SLOTS[slotIndex % SOURCE_SLOTS.length];
    const fallback = preferred === "habit" ? "star" : "habit";
    const pageIdentity = takeNext(queues, offsets, preferred, selectedPages)
      || takeNext(queues, offsets, fallback, selectedPages);
    if (!pageIdentity) break;
    const entry = entries.get(pageIdentity);
    if (!entry) continue;
    selectedPages.add(pageIdentity);
    selected.push(entry);
  }
  return selected;
}

function uniquePageQueue(candidates) {
  const seen = new Set();
  const pages = [];
  for (const candidate of candidates) {
    const pageIdentity = pageOf(candidate?.action?.target?.url);
    if (!pageIdentity || seen.has(pageIdentity)) continue;
    seen.add(pageIdentity);
    pages.push(pageIdentity);
  }
  return pages;
}

function takeNext(queues, offsets, source, selectedPages) {
  const queue = queues[source];
  while (offsets[source] < queue.length) {
    const pageIdentity = queue[offsets[source]];
    offsets[source] += 1;
    if (!selectedPages.has(pageIdentity)) return pageIdentity;
  }
  return null;
}

function addEvidence(entry, source, candidate) {
  if (!entry || !candidate) return;
  entry.sources.push(source);
  entry.evidence.push({
    source,
    candidateId: String(candidate.id || ""),
    kind: String(candidate.kind || ""),
    score: Number.isFinite(candidate.score) ? Number(candidate.score) : null,
    confidence: Number.isFinite(candidate.confidence) ? Number(candidate.confidence) : null,
    provenance: String(candidate.provenance || ""),
    cues: cloneRecord(candidate.cues),
    reasons: Array.isArray(candidate.reasons) ? candidate.reasons.map(String) : []
  });
}

function adoptSwitchTarget(entry, candidate) {
  if (candidate?.action?.verb !== "switch") return;
  entry.action = {
    verb: "switch",
    target: cloneTarget(candidate.action.target)
  };
}

function finalizeAction(entry) {
  const sourceSet = new Set(entry.sources);
  if (entry.evidence.some(item => item.provenance === "foreign")) sourceSet.add("foreign");
  const sources = [...sourceSet]
    .sort((left, right) => SOURCE_ORDER.indexOf(left) - SOURCE_ORDER.indexOf(right));
  const evidence = entry.evidence.slice().sort((left, right) => {
    return SOURCE_ORDER.indexOf(left.source) - SOURCE_ORDER.indexOf(right.source)
      || left.candidateId.localeCompare(right.candidateId);
  });
  return {
    ...entry,
    sources,
    evidence,
    reasons: evidence.flatMap(item => item.reasons.map(text => ({ source: item.source, text })))
  };
}

function normalizePrimaryActivity(activity) {
  return {
    ...activity,
    sources: ["activity"],
    evidence: [{
      source: "activity",
      candidateId: String(activity?.id || ""),
      kind: String(activity?.kind || "resumption-activity"),
      score: Number.isFinite(activity?.score) ? Number(activity.score) : null,
      confidence: Number.isFinite(activity?.confidence) ? Number(activity.confidence) : null,
      cues: cloneRecord(activity?.cues),
      reasons: Array.isArray(activity?.reasons) ? activity.reasons.map(String) : []
    }]
  };
}

function cloneTarget(target) {
  return target && typeof target === "object" ? { ...target } : {};
}

function cloneRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function pageOf(url) {
  return normalizeIdentity(url || "")?.page || "";
}

function boundedLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_ACTION_LIMIT;
  return Math.max(0, Math.min(MAX_ACTION_LIMIT, Math.floor(number)));
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function finiteCue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}
