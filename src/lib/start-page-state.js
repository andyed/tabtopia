export const START_PAGE_STATES = Object.freeze({
  LAUNCH: "launch",
  THRESHOLD: "threshold",
  REINSTATEMENT: "reinstatement",
  CONTINUATION: "continuation",
  HANDOFF: "handoff"
});

export const START_PAGE_STATE_DEFAULTS = Object.freeze({
  interruptionMs: 30 * 60 * 1000,
  handoffHorizonMs: 6 * 60 * 60 * 1000,
  minimumForeignVisits: 2
});

export function recognizeStartPageState(snapshot, config = {}) {
  const thresholds = { ...START_PAGE_STATE_DEFAULTS, ...config };
  const currentCount = snapshot?.currentWindow?.tabs?.length || 0;
  const otherWindows = snapshot?.otherWindows || [];
  const otherCount = otherWindows.reduce((sum, window) => sum + (window.tabs?.length || 0), 0);
  const gapMs = snapshot?.activity?.interruptionGapMs;
  const foreignItems = recentForeignItems(snapshot, thresholds.handoffHorizonMs);
  const foreignDomains = new Set(foreignItems.map(item => domainOf(item.url)).filter(Boolean));
  const latestForeignAt = Number(snapshot?.history?.latestForeignAt || 0);
  const latestLocalAt = Number(snapshot?.activity?.latestMeaningfulAt || 0);
  const foreignTrailIsCoherent = foreignItems.length >= thresholds.minimumForeignVisits
    && foreignDomains.size > 0
    && foreignDomains.size <= Math.max(3, Math.ceil(foreignItems.length / 2))
    && latestForeignAt > latestLocalAt;
  const currentWindowIsClean = currentCount === 0;

  if (currentWindowIsClean && foreignTrailIsCoherent) {
    return result(START_PAGE_STATES.HANDOFF, clamp(0.78 + Math.min(0.14, foreignItems.length * 0.02)), [
      "clean-current-window",
      `${foreignItems.length}-recent-foreign-visits`,
      `${foreignDomains.size}-foreign-domain${foreignDomains.size === 1 ? "" : "s"}`,
      "foreign-trail-is-latest"
    ], {
      currentCount,
      otherCount,
      gapMs,
      foreignVisitCount: foreignItems.length,
      foreignDomainCount: foreignDomains.size
    });
  }

  if (currentWindowIsClean && otherCount > 0 && Number.isFinite(gapMs) && gapMs >= thresholds.interruptionMs) {
    const gapMinutes = Math.round(gapMs / 60000);
    return result(START_PAGE_STATES.REINSTATEMENT, clamp(0.76 + Math.min(0.16, gapMs / (6 * 60 * 60 * 1000))), [
      "clean-current-window",
      `${gapMinutes}-minute-gap`,
      `${otherCount}-live-tabs-in-${nonEmptyWindowCount(otherWindows)}-other-windows`
    ], { currentCount, otherCount, gapMs, foreignVisitCount: foreignItems.length });
  }

  if (currentWindowIsClean && otherCount > 0) {
    return result(START_PAGE_STATES.THRESHOLD, clamp(0.7 + Math.min(0.14, otherCount * 0.015)), [
      "clean-current-window",
      `${otherCount}-live-tabs-nearby`,
      "no-substantial-interruption"
    ], { currentCount, otherCount, gapMs, foreignVisitCount: foreignItems.length });
  }

  if (currentCount > 0) {
    return result(START_PAGE_STATES.CONTINUATION, clamp(0.72 + Math.min(0.18, currentCount * 0.025)), [
      `${currentCount}-meaningful-tabs-in-current-window`,
      `${snapshot?.currentWindow?.density || "unknown"}-density`
    ], { currentCount, otherCount, gapMs, foreignVisitCount: foreignItems.length });
  }

  return result(START_PAGE_STATES.LAUNCH, otherCount === 0 ? 0.88 : 0.66, [
    "clean-current-window",
    otherCount === 0 ? "no-live-work-elsewhere" : "weak-live-work-signal",
    foreignItems.length === 0 ? "no-recent-foreign-trail" : "foreign-trail-below-threshold"
  ], { currentCount, otherCount, gapMs, foreignVisitCount: foreignItems.length });
}

export function stateDisplayName(state) {
  return ({
    [START_PAGE_STATES.LAUNCH]: "Launch",
    [START_PAGE_STATES.THRESHOLD]: "Threshold",
    [START_PAGE_STATES.REINSTATEMENT]: "Reinstatement",
    [START_PAGE_STATES.CONTINUATION]: "Continuation",
    [START_PAGE_STATES.HANDOFF]: "Handoff"
  })[state] || "Unknown";
}

function recentForeignItems(snapshot, horizonMs) {
  const generatedAt = Number(snapshot?.generatedAt || Date.now());
  return (snapshot?.history?.foreignItems || []).filter(item => {
    const age = generatedAt - Number(item.visitTime || 0);
    return age >= 0 && age <= horizonMs;
  });
}

function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function nonEmptyWindowCount(windows) {
  return windows.filter(window => (window.tabs?.length || 0) > 0).length;
}

function result(state, confidence, evidence, signals) {
  return { state, confidence, evidence, signals };
}

function clamp(value) {
  return Math.max(0, Math.min(1, value));
}
