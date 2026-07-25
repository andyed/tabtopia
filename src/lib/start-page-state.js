export const START_PAGE_STATES = Object.freeze({
  LAUNCH: "launch",
  THRESHOLD: "threshold",
  REINSTATEMENT: "reinstatement",
  REORIENTATION: "reorientation",
  CONTINUATION: "continuation",
  HANDOFF: "handoff"
});

export const START_PAGE_STATE_DEFAULTS = Object.freeze({
  interruptionMs: 30 * 60 * 1000,
  reorientationMs: 6 * 60 * 60 * 1000,
  crossDayReorientationMs: 4 * 60 * 60 * 1000,
  handoffHorizonMs: 6 * 60 * 60 * 1000,
  minimumForeignVisits: 2
});

export function recognizeStartPageState(snapshot, config = {}) {
  const thresholds = { ...START_PAGE_STATE_DEFAULTS, ...config };
  const currentCount = snapshot?.currentWindow?.tabs?.length || 0;
  const otherWindows = snapshot?.otherWindows || [];
  const otherCount = otherWindows.reduce((sum, window) => sum + (window.tabs?.length || 0), 0);
  const liveCount = currentCount + otherCount;
  const neighborhoods = snapshot?.neighborhoods || [];
  // Neighborhoods now mix live tabs with work recovered from history. Evidence
  // must say which, or "3 active neighborhoods" would claim live work that a
  // restart already closed.
  const neighborhoodCount = neighborhoods.filter(item => (item.openCount || 0) > 0).length;
  const recoveredNeighborhoodCount = neighborhoods.filter(item =>
    (item.openCount || 0) === 0 && (item.recoveredCount || 0) > 0).length;
  const edgeCount = snapshot?.topology?.edgeCount || 0;
  const gapMs = snapshot?.activity?.interruptionGapMs;
  const crossedLocalDayBoundary = Boolean(snapshot?.activity?.crossedLocalDayBoundary);
  const interruptionSignals = { gapMs, crossedLocalDayBoundary };
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
      "foreign-trail-is-latest",
      ...(recoveredNeighborhoodCount > 0
        ? [`${recoveredNeighborhoodCount}-recovered-neighborhood${recoveredNeighborhoodCount === 1 ? "" : "s"}`]
        : [])
    ], {
      currentCount,
      otherCount,
      ...interruptionSignals,
      foreignVisitCount: foreignItems.length,
      foreignDomainCount: foreignDomains.size,
      neighborhoodCount,
      recoveredNeighborhoodCount
    });
  }

  const isReorientation = Number.isFinite(gapMs) && (
    gapMs >= thresholds.reorientationMs
    || (crossedLocalDayBoundary && gapMs >= thresholds.crossDayReorientationMs)
  );

  if (liveCount > 0 && isReorientation) {
    const gapHours = Math.round((gapMs / (60 * 60 * 1000)) * 10) / 10;
    return result(START_PAGE_STATES.REORIENTATION, clamp(
      0.82 + Math.min(0.12, Math.max(0, gapMs - thresholds.crossDayReorientationMs) / (24 * 60 * 60 * 1000))
    ), [
      currentWindowIsClean ? "clean-current-window" : `${currentCount}-live-tabs-in-current-window`,
      `${gapHours}-hour-gap`,
      ...(crossedLocalDayBoundary ? ["crossed-local-day-boundary"] : ["extended-interruption"]),
      `${neighborhoodCount}-active-neighborhood${neighborhoodCount === 1 ? "" : "s"}`,
      ...(recoveredNeighborhoodCount > 0
        ? [`${recoveredNeighborhoodCount}-recovered-neighborhood${recoveredNeighborhoodCount === 1 ? "" : "s"}`]
        : []),
      ...(otherCount > 0 ? [`${otherCount}-live-tabs-in-${nonEmptyWindowCount(otherWindows)}-other-windows`] : [])
    ], {
      currentCount,
      otherCount,
      ...interruptionSignals,
      foreignVisitCount: foreignItems.length,
      neighborhoodCount,
      recoveredNeighborhoodCount,
      edgeCount
    });
  }

  if (liveCount > 0 && Number.isFinite(gapMs) && gapMs >= thresholds.interruptionMs) {
    const gapMinutes = Math.round(gapMs / 60000);
    return result(START_PAGE_STATES.REINSTATEMENT, clamp(0.76 + Math.min(0.16, gapMs / (6 * 60 * 60 * 1000))), [
      currentWindowIsClean ? "clean-current-window" : `${currentCount}-live-tabs-in-current-window`,
      `${gapMinutes}-minute-gap`,
      `${neighborhoodCount}-active-neighborhood${neighborhoodCount === 1 ? "" : "s"}`,
      ...(otherCount > 0 ? [`${otherCount}-live-tabs-in-${nonEmptyWindowCount(otherWindows)}-other-windows`] : [])
    ], {
      currentCount,
      otherCount,
      ...interruptionSignals,
      foreignVisitCount: foreignItems.length,
      neighborhoodCount,
      recoveredNeighborhoodCount,
      edgeCount
    });
  }

  if (currentWindowIsClean && otherCount > 0) {
    return result(START_PAGE_STATES.THRESHOLD, clamp(0.7 + Math.min(0.14, otherCount * 0.015)), [
      "clean-current-window",
      `${otherCount}-live-tabs-nearby`,
      "no-substantial-interruption"
    ], { currentCount, otherCount, ...interruptionSignals, foreignVisitCount: foreignItems.length });
  }

  if (currentCount > 0) {
    return result(START_PAGE_STATES.CONTINUATION, clamp(
      0.68
      + Math.min(0.12, currentCount * 0.01)
      + Math.min(0.08, Math.max(0, neighborhoodCount - 1) * 0.02)
    ), [
      `${currentCount}-meaningful-tabs-in-current-window`,
      `${neighborhoodCount}-active-neighborhood${neighborhoodCount === 1 ? "" : "s"}`,
      `${edgeCount}-relationship-edge${edgeCount === 1 ? "" : "s"}`
    ], {
      currentCount,
      otherCount,
      ...interruptionSignals,
      foreignVisitCount: foreignItems.length,
      neighborhoodCount,
      recoveredNeighborhoodCount,
      edgeCount
    });
  }

  return result(START_PAGE_STATES.LAUNCH, otherCount === 0 ? 0.88 : 0.66, [
    "clean-current-window",
    otherCount === 0 ? "no-live-work-elsewhere" : "weak-live-work-signal",
    foreignItems.length === 0 ? "no-recent-foreign-trail" : "foreign-trail-below-threshold"
  ], { currentCount, otherCount, ...interruptionSignals, foreignVisitCount: foreignItems.length });
}

export function stateDisplayName(state) {
  return ({
    [START_PAGE_STATES.LAUNCH]: "Launch",
    [START_PAGE_STATES.THRESHOLD]: "Threshold",
    [START_PAGE_STATES.REINSTATEMENT]: "Reinstatement",
    [START_PAGE_STATES.REORIENTATION]: "Reorientation",
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
