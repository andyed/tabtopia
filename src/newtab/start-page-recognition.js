import { updateFrequentPreference } from "../lib/frequent-destinations.js";
import { setContextSiteHidden } from "../lib/recent-context-provider.js";
import { buildHomeRecommendations } from "../lib/home-recommendations.js";
import { stateDisplayName } from "../lib/start-page-state.js";
import { buildArchiveEnrichment } from "../lib/archive-enrichment.js";
import { buildDeferredIntentions } from "../lib/deferred-intentions.js";
import { buildStartPageFeed } from "../lib/start-page-feed.js";
import { buildTechmemeEnrichment } from "../lib/techmeme-enrichment.js";
import { buildGithubStarsEnrichment } from "../lib/github-stars-enrichment.js";
import { createStartPageController } from "./start-page-controller.js";
import { createStartPageActionExecutor } from "./start-page-actions.js";
import { renderHomeTakeover } from "./home-takeover.js";
import { FEATURE_FLAGS, readFeatureFlag } from "../lib/feature-flags.js";

const HOME_MODEL_CACHE_KEY = "tabtopiaHomeModelV1";
const HOME_MODEL_CACHE_VERSION = 2;
const HOME_MODEL_CACHE_TTL_MS = 30 * 60 * 1000;
let controller = null;
let installType = "normal";
let homeEnabled = false;
let freshOverride = false;
let latestHomeModel = null;
const executeHomeAction = createStartPageActionExecutor();
let cachedHomeRead = null;
let lastHiddenContextHost = "";
let lastHiddenContextItem = null;
let featuredImpression = null;
let contextExpiryTimer = null;
const contextPageId = crypto.randomUUID();
let contextImpressionSequence = 0;
let recommendationRound = 0;
let recommendationLockedPages = [];
let recommendationRestorePage = null;
let recommendationExcludedPages = [];
let recommendationPreferencesSignature = "";
let lastSnoozedRecommendation = null;
let recommendationFeedbackMessage = "";
const recommendationArm = crypto.getRandomValues(new Uint32Array(1))[0] % 2 ? "explore" : "balanced";

if (window.location.hash === "#/home") {
  homeEnabled = true;
  showInitialHome();
}

startWhenIdle();

async function startWhenIdle() {
  installType = await getInstallType();
  homeEnabled = await shouldUseHomeTakeover();
  if (homeEnabled) showInitialHome();

  const start = async () => {
    // The hash can change between module evaluation and the idle start (for
    // example a direct jump to the legacy landscape). Resolve it again here so
    // an early route never gets lost before the hashchange listener exists.
    homeEnabled = await shouldUseHomeTakeover();
    if (homeEnabled) showInitialHome();
    else deactivateHome();
    window.addEventListener("hashchange", handleRouteChange);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    if (installType === "development" || homeEnabled) ensureControllerStarted();
  };

  if (document.readyState === "complete") {
    scheduleIdle(start);
  } else {
    window.addEventListener("load", () => scheduleIdle(start), { once: true });
  }
}

function showInitialHome() {
  activateHome();
  const root = document.getElementById("startPageHome");
  if (root && root.childElementCount === 0) {
    renderHome({ loading: true, mode: "quiet", state: "launch", actions: [] });
  }
  restoreCachedHome().catch(() => {});
}

async function restoreCachedHome() {
  if (!chrome.storage?.session?.get) return;
  if (!cachedHomeRead) cachedHomeRead = chrome.storage.session.get(HOME_MODEL_CACHE_KEY);
  const stored = (await cachedHomeRead)?.[HOME_MODEL_CACHE_KEY];
  if (!stored || stored.version !== HOME_MODEL_CACHE_VERSION) return;
  if (Date.now() - Number(stored.cachedAt || 0) > HOME_MODEL_CACHE_TTL_MS) return;
  if (!homeEnabled || latestHomeModel) return;
  renderHome({
    ...stored.model,
    // Recommendations need current preferences and feedback before exposure.
    featuredItems: [],
    frequentDestinations: null,
    loading: true,
    stale: true,
    error: null,
    freshOverride: false
  });
}

function cacheHomeModel(model) {
  if (!chrome.storage?.session?.set) return;
  chrome.storage.session.set({
    [HOME_MODEL_CACHE_KEY]: {
      version: HOME_MODEL_CACHE_VERSION,
      cachedAt: Date.now(),
      model
    }
  }).catch(() => {});
}

function ensureControllerStarted() {
  if (controller) return false;
  controller = createStartPageController({
    onUpdate: handleStartPageUpdate,
    onError: renderFailure
  });
  controller.start();
  return true;
}

function scheduleIdle(callback) {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(callback, { timeout: 1200 });
  } else {
    setTimeout(callback, 0);
  }
}

function handleStartPageUpdate({ snapshot, recognition, forecast, habitDestinations, ...extra }) {
  const sourceState = { snapshot, recognition, forecast, habitDestinations, ...extra };
  const deferredIntentions = buildDeferredIntentions({
    bookmarks: extra.recommendationBookmarks || extra.bookmarks,
    historyItems: extra.historyPool,
    openTabs: (extra.windows || []).flatMap(window => window.tabs || []),
    now: extra.generatedAt
  });
  const baseFeed = buildStartPageFeed({
    state: recognition.state,
    habitDestinations,
    deferredIntentions,
    resumptionActivities: forecast,
    neighborhoods: snapshot.neighborhoods,
    generatedAt: extra.generatedAt
  });
  const archiveEnrichment = buildArchiveEnrichment({
    archiveItems: archiveRowsForEnrichment(extra.archiveSnapshot),
    semanticItems: semanticRowsForEnrichment(extra.archiveSnapshot),
    contextItems: [
      ...(snapshot.history?.items || []),
      ...(snapshot.tabs || [])
    ],
    selectedUrls: selectedFeedUrls(baseFeed),
    now: extra.generatedAt
  });
  const techmemeEnrichment = buildTechmemeEnrichment({
    feedItems: extra.techmemeSnapshot?.items,
    interestTopics: archiveEnrichment.interests,
    contextTitles: techmemeContextTitles(baseFeed, forecast, snapshot)
  });
  const githubStarsEnrichment = buildGithubStarsEnrichment({
    starItems: extra.githubStarsSnapshot?.items,
    interestTopics: archiveEnrichment.interests,
    contextTitles: techmemeContextTitles(baseFeed, forecast, snapshot)
  });
  const preferencesSignature = JSON.stringify(extra.recommendationPreferences);
  if (preferencesSignature !== recommendationPreferencesSignature) {
    recommendationLockedPages = [];
    recommendationRestorePage = null;
    recommendationExcludedPages = [];
    recommendationPreferencesSignature = preferencesSignature;
  }
  const arm = extra.recommendationPreferences?.exploration === false ? "balanced" : recommendationArm;
  const candidates = buildHomeRecommendations({
    context: extra.recentContextSnapshot,
    history: extra.historyPool,
    bookmarks: extra.recommendationBookmarks,
    openTabs: (extra.windows || []).flatMap(w => w.tabs || []),
    preferences: extra.recommendationPreferences,
    feedback: extra.recommendationFeedback,
    now: extra.generatedAt,
    seed: `${contextPageId}:${recommendationRound}`,
    arm, limit: 3, excludePages: recommendationExcludedPages,
    lockedPages: recommendationRestorePage
      ? [recommendationRestorePage, ...recommendationLockedPages.filter(page => page !== recommendationRestorePage)]
      : recommendationLockedPages
  });
  const featuredItems = candidates;
  const feed = {
    ...baseFeed,
    frequentDestinations: extra.frequentDestinations,
    featuredItems,
    recommendationArm: arm,
    recentContext: extra.recentContextSnapshot,
    archiveItems: archiveEnrichment.items,
    interests: archiveEnrichment.interests,
    archiveSourceCounts: archiveEnrichment.sourceCounts,
    archiveStatus: extra.archiveSnapshot?.status || "empty",
    githubStarItems: githubStarsEnrichment.items,
    githubStarsStatus: extra.githubStarsSnapshot?.status || "empty",
    techmemeItems: techmemeEnrichment.items,
    techmemeStatus: extra.techmemeSnapshot?.status || "empty"
  };
  latestHomeModel = homeModelFrom(feed, recognition, forecast, snapshot);
  cacheHomeModel(latestHomeModel);

  window.tabtopiaStartPageRecognition = {
    ...sourceState,
    deferredIntentions,
    archiveEnrichment,
    githubStarsEnrichment,
    techmemeEnrichment,
    feed,
    homeModel: latestHomeModel,
    refresh: () => controller?.refresh()
  };
  if (installType === "development") {
    renderInspector(snapshot, recognition, forecast, habitDestinations);
  }
  if (homeEnabled) {
    if (freshOverride) renderFreshHome();
    else renderSuggestedHome();
  }
  window.dispatchEvent(new CustomEvent("tabtopia-state-recognized", {
    detail: {
      ...sourceState,
      deferredIntentions,
      archiveEnrichment,
      githubStarsEnrichment,
      techmemeEnrichment,
      feed,
      homeModel: latestHomeModel
    }
  }));
}

function techmemeContextTitles(feed, forecast, snapshot) {
  const titles = [
    ...(feed?.actions || []).map(item => item?.action?.target?.title),
    feed?.primaryActivity?.action?.target?.title,
    ...(forecast?.candidates || []).slice(0, 4).map(item => item?.action?.target?.title),
    ...(snapshot?.history?.foreignItems || []).slice(0, 3).map(item => item?.title)
  ];
  return titles.filter(Boolean);
}

function archiveRowsForEnrichment(snapshot) {
  return snapshot?.archive || [];
}

function semanticRowsForEnrichment(snapshot) {
  return (snapshot?.related || []).map((item, index) => ({
    ...item,
    rank: index + 1
  }));
}

function selectedFeedUrls(feed) {
  return [
    ...(feed?.actions || []).map(item => item?.action?.target?.url),
    feed?.primaryActivity?.action?.target?.url
  ].filter(Boolean);
}

function homeModelFrom(feed, recognition, forecast, snapshot) {
  const actions = feed.actions.map(action => ({
    ...action.action,
    id: action.id,
    sources: action.sources,
    reasons: action.reasons.map(reason => reason.text)
  }));
  const neighborhoodById = new Map(
    (snapshot.neighborhoods || []).map(neighborhood => [neighborhood.id, neighborhood])
  );
  const resumptionActivities = (forecast?.candidates || []).map(candidate =>
    activityWithTopology(candidate, neighborhoodById.get(candidate.id))
  );
  const leadingNeighborhood = feed.primaryActivity
    ? neighborhoodById.get(feed.primaryActivity.id)
    : null;
  const leadingActivity = feed.primaryActivity
    ? activityWithTopology(feed.primaryActivity, leadingNeighborhood)
    : feed.mode === "engaged" && actions[0]
      ? activityWithTopology(
          actions[0],
          resumptionActivities.find(candidate =>
            candidate.action?.target?.url === actions[0].target?.url
          )
        )
      : null;
  return {
    ...feed,
    actions,
    primaryActivity: leadingActivity,
    neighborhoods: feed.mode === "return" ? resumptionActivities : [],
    stateLabel: stateDisplayName(recognition.state),
    summary: HOME_STATE_SUMMARIES[recognition.state] || "Choose where to put your attention next.",
    loading: false,
    error: null,
    freshOverride: false
  };
}

function activityWithTopology(activity, neighborhood) {
  return {
    ...activity,
    items: Array.isArray(neighborhood?.items) ? neighborhood.items : [],
    edges: Array.isArray(neighborhood?.edges) ? neighborhood.edges : [],
    relationCounts: neighborhood?.relationCounts && typeof neighborhood.relationCounts === "object"
      ? { ...neighborhood.relationCounts }
      : {}
  };
}

const HOME_STATE_SUMMARIES = Object.freeze({
  launch: "A quiet start, shaped by what you return to.",
  threshold: "Nearby work is available, without demanding the whole screen.",
  continuation: "",
  reinstatement: "Your recent trail is still close enough to recover.",
  reorientation: "Re-enter from a useful starting point.",
  handoff: "Continue a trail recovered from elsewhere."
});

function renderSuggestedHome() {
  if (!latestHomeModel) return;
  freshOverride = false;
  renderHome(latestHomeModel);
}

function renderFreshHome() {
  if (!latestHomeModel) return;
  freshOverride = true;
  renderHome({
    ...latestHomeModel,
    mode: "quiet",
    state: "launch",
    stateLabel: "Fresh start",
    summary: "Nothing is being inferred for this tab.",
    actions: [],
    primaryActivity: null,
    neighborhoods: [],
    archiveItems: [],
    interests: [],
    githubStarItems: [],
    techmemeItems: [],
    freshOverride: true
  });
}

function renderHome(model) {
  const root = document.getElementById("startPageHome");
  if (!root) return;
  activateHome();
  try {
    const focusedRecommendation = root.contains(document.activeElement) ? document.activeElement?.dataset?.recommendationFocus : null;
    const focusedAlternatives = root.contains(document.activeElement)
      && document.activeElement?.matches(".home-takeover__alternatives");
    const otherRoutesOpen = root.querySelector(".home-takeover__other-routes")?.open;
    // Undo may outlive an older in-flight snapshot; its eventual restore is
    // still an explicit command, even while keyboard focus remains on Home.
    renderHomeTakeover(root, { ...model, undoHiddenHost: lastHiddenContextHost,
      undoSnoozed: lastSnoozedRecommendation?.title, recommendationFeedbackMessage }, {
      onFeaturedVisible: items => recordFeaturedImpression(items, model),
      onFeaturedAction: handleFeaturedAction,
      onHideContextSite: hideContextSite,
      onUndoContextHide: undoContextHide,
      onShowAlternatives: showRecommendationAlternatives,
      onSnoozeRecommendation: snoozeRecommendation,
      onUndoSnooze: undoRecommendationSnooze,
      onAction: handleHomeAction,
      onFrequentPreference: async change => {
        await updateFrequentPreference(change);
        await controller?.refresh();
      },
      onStartFresh: renderFreshHome,
      onShowSuggested: renderSuggestedHome,
      onOpenTreemap: openTreemap
    }, { force: Boolean(recommendationRestorePage) });
    const otherRoutes = root.querySelector(".home-takeover__other-routes");
    if (otherRoutes && otherRoutesOpen) otherRoutes.open = true;
    if (focusedRecommendation) {
      [...root.querySelectorAll("[data-recommendation-focus]")]
        .find(node => node.dataset.recommendationFocus === focusedRecommendation)?.focus({ preventScroll: true });
    } else if (focusedAlternatives) {
      root.querySelector(".home-takeover__alternatives")?.focus({ preventScroll: true });
    }
    window.tabtopiaStartPageHome = { model, freshOverride };
    clearTimeout(contextExpiryTimer);
    const expiresAt = Math.min(...(model.featuredItems || []).map(item => Number(item.expiresAt)).filter(value => value > Date.now()));
    if (Number.isFinite(expiresAt) && expiresAt > Date.now()) contextExpiryTimer = setTimeout(() => {
      if (homeEnabled && latestHomeModel) renderHome(latestHomeModel);
      controller?.refresh().catch(() => {});
    }, Math.min(expiresAt - Date.now() + 25, 2147483647));
  } catch (error) {
    console.warn("[StartPageHome] rendering failed", error);
    deactivateHome();
  }
}


function recordFeaturedImpression(items, model) {
  if (document.visibilityState !== "visible" || !homeEnabled || freshOverride || !items.length) return;
  const root = document.getElementById("startPageHome");
  if (!root || root.hidden || !root.getClientRects().length) return;
  // A refresh already in flight can carry the pre-Undo preference. Keep the
  // restore request until the restored action actually reaches the display.
  if (recommendationRestorePage && (model.featuredItems || []).some(item => item.identity === recommendationRestorePage)) {
    recommendationRestorePage = null;
  }
  const signature = (model.featuredItems || []).map(item => `${item.rank}:${item.identity}`).join("|");
  if (featuredImpression?.signature !== signature) {
    featuredImpression = { signature, id: `${contextPageId}:${++contextImpressionSequence}`, seen: new Set() };
  }
  const newlyVisible = items.filter(item => !featuredImpression.seen.has(item.identity));
  if (!newlyVisible.length) return;
  for (const item of newlyVisible) featuredImpression.seen.add(item.identity);
  recommendationLockedPages = (model.featuredItems || []).map(item => item.identity);
  sendContextDiagnostic({ action: "recordHomeRecommendationImpression", impressionId: featuredImpression.id,
    arm: model.recommendationArm,
    candidates: newlyVisible.map(item => ({ url: item.url, identity: item.identity, rank: item.rank })) });
}

async function sendContextDiagnostic(message) {
  try { return await chrome.runtime.sendMessage(message); } catch { return null; }
}

async function handleFeaturedAction(action) {
  const impressionId = featuredImpression?.id;
  if (impressionId) await sendContextDiagnostic({ action: "recordHomeRecommendationChoice",
    impressionId, url: action.target.url, rank: action.rank,
    targetTabId: action.target.tabId });
  const result = await handleHomeAction(action);
  if (!result.ok && impressionId) await sendContextDiagnostic({ action: "cancelHomeRecommendationChoice",
    impressionId, rank: action.rank });
  return result;
}

async function hideContextSite(item) {
  recommendationRestorePage = null;
  const host = await setContextSiteHidden(item.url, true, { development: installType === "development" });
  lastHiddenContextHost = host;
  lastHiddenContextItem = item;
  featuredImpression = null;
  await controller?.refresh();
  document.querySelector(".home-takeover__context-undo")?.focus();
}

async function showRecommendationAlternatives() {
  recommendationRestorePage = null;
  const previous = (latestHomeModel?.featuredItems || []).map(item => item.identity);
  recommendationExcludedPages = previous;
  recommendationLockedPages = [];
  recommendationRound++;
  featuredImpression = null;
  recommendationFeedbackMessage = "Showing a different set of destinations.";
  await controller?.refresh();
  if (!latestHomeModel?.featuredItems?.length) {
    recommendationExcludedPages = [];
    recommendationFeedbackMessage = "You’ve seen all eligible destinations. More will appear as your browsing changes.";
    await controller?.refresh();
  }
  document.querySelector(".home-takeover__alternatives")?.focus();
}

async function snoozeRecommendation(item) {
  recommendationRestorePage = null;
  const response = await sendContextDiagnostic({ action: "snoozeHomeRecommendation", url: item.url,
    identity: item.identity, durationMs: 24 * 60 * 60 * 1000 });
  if (!response?.success || !response.recorded) throw new Error("Could not snooze destination");
  lastSnoozedRecommendation = item;
  recommendationLockedPages = recommendationLockedPages.filter(identity => identity !== item.identity);
  featuredImpression = null;
  await controller?.refresh();
  document.querySelector(".home-takeover__snooze-undo")?.focus();
}

async function undoRecommendationSnooze() {
  if (!lastSnoozedRecommendation) return;
  const item = lastSnoozedRecommendation;
  const response = await sendContextDiagnostic({ action: "snoozeHomeRecommendation", url: item.url,
    identity: item.identity, durationMs: 0 });
  if (!response?.success || !response.recorded) throw new Error("Could not undo snooze");
  lastSnoozedRecommendation = null;
  recommendationRestorePage = item.identity;
  recommendationLockedPages = [item.identity, ...recommendationLockedPages.filter(identity => identity !== item.identity)].slice(0, 3);
  featuredImpression = null;
  await controller?.refresh();
  document.querySelector(".home-takeover__featured a")?.focus();
}

async function undoContextHide() {
  if (!lastHiddenContextHost) return;
  await setContextSiteHidden(lastHiddenContextHost, false, { development: installType === "development" });
  recommendationRestorePage = lastHiddenContextItem?.identity || null;
  if (lastHiddenContextItem) recommendationLockedPages = [lastHiddenContextItem.identity,
    ...recommendationLockedPages.filter(identity => identity !== lastHiddenContextItem.identity)].slice(0, 3);
  lastHiddenContextItem = null;
  lastHiddenContextHost = "";
  featuredImpression = null;
  await controller?.refresh();
  document.querySelector(".home-takeover__featured a")?.focus();
}

async function handleHomeAction(action) {
  const result = await executeHomeAction(action);
  if (!result.ok && latestHomeModel) {
    renderHome({
      ...(freshOverride ? { ...latestHomeModel, mode: "quiet", actions: [], primaryActivity: null } : latestHomeModel),
      freshOverride,
      error: result.error?.message || "That destination could not be opened."
    });
  }
  return result;
}

function openTreemap() {
  window.location.hash = "/treemap";
  deactivateHome();
}

async function handleRouteChange() {
  homeEnabled = await shouldUseHomeTakeover();
  if (homeEnabled) {
    if (freshOverride) renderFreshHome();
    else if (latestHomeModel) renderSuggestedHome();
    else renderHome({ loading: true, mode: "quiet", state: "launch", actions: [] });
    const startedNow = ensureControllerStarted();
    if (!startedNow) controller.refresh().catch(() => {});
  } else {
    deactivateHome();
  }
}

function handlePageShow() {
  handleRouteChange().catch(() => {});
}

function handleVisibilityChange() {
  if (document.visibilityState === "visible" && homeEnabled) {
    controller?.refresh().catch(() => {});
  }
}

function activateHome() {
  document.body.classList.add("home-takeover-active");
  const root = document.getElementById("startPageHome");
  if (root) root.hidden = false;
}

function deactivateHome() {
  document.body.classList.remove("home-takeover-active");
  const root = document.getElementById("startPageHome");
  if (root) root.hidden = true;
}

function renderInspector(snapshot, recognition, forecast, habitDestinations) {
  const inspector = getOrCreateInspector();
  inspector.dataset.state = recognition.state;
  inspector.dataset.confidence = recognition.confidence.toFixed(2);

  const stateName = stateDisplayName(recognition.state);
  const confidence = Math.round(recognition.confidence * 100);
  inspector.replaceChildren();

  const details = document.createElement("details");
  details.className = "state-inspector__primary";
  details.open = !homeEnabled;
  const summary = document.createElement("summary");
  const state = textElement("span", stateName, "state-inspector__state");
  const score = textElement("span", `${confidence}%`, "state-inspector__confidence");
  summary.append(state, score);

  const body = document.createElement("div");
  body.className = "state-inspector__body";
  body.append(
    textElement("p", "Development state recognition", "state-inspector__eyebrow"),
    signalGrid(snapshot, recognition),
    evidenceList(recognition.evidence),
    renderHabitDestinations(habitDestinations),
    renderForecast(forecast),
    renderNeighborhoodPreview(snapshot.neighborhoods),
    renderTopologyAudit(snapshot)
  );
  details.append(summary, body);
  inspector.append(details);
}

function renderHabitDestinations(habitDestinations) {
  const candidates = habitDestinations?.candidates || [];
  const section = document.createElement("section");
  section.className = "resumption-forecast habit-destinations";
  section.setAttribute("aria-label", "Habit destinations from qualified history");

  const header = document.createElement("header");
  header.append(
    textElement("h2", "Habit destinations"),
    textElement("span", `${candidates.length} History-ranked`)
  );
  section.append(header);

  if (candidates.length === 0) {
    section.append(textElement(
      "p",
      "No qualified habit evidence yet. Chrome History supplies candidates; only focused accesses lasting at least two seconds supply rank.",
      "resumption-forecast__empty"
    ));
    return section;
  }

  const list = document.createElement("ol");
  list.className = "resumption-forecast__list";
  for (const candidate of candidates) list.append(renderHabitDestination(candidate));
  section.append(list);

  if (habitDestinations.suppressedCount > 0) {
    section.append(textElement(
      "p",
      `+ ${habitDestinations.suppressedCount} lower-ranked destination${habitDestinations.suppressedCount === 1 ? "" : "s"}`,
      "resumption-forecast__more"
    ));
  }
  return section;
}

function renderHabitDestination(candidate) {
  const item = document.createElement("li");
  item.className = "resumption-forecast__item";
  item.dataset.source = "qualified-history";

  const heading = document.createElement("div");
  heading.className = "resumption-forecast__heading";
  heading.append(
    textElement("span", VERB_LABELS[candidate.action.verb] || candidate.action.verb, "resumption-forecast__verb"),
    textElement("span", `B ${candidate.score.toFixed(2)}`, "resumption-forecast__score")
  );
  item.append(heading, tabLink(candidate.action.target, "resumption-forecast__target"));

  const meta = document.createElement("p");
  meta.className = "resumption-forecast__meta";
  meta.append(
    textElement("span", candidate.domain, "resumption-forecast__domain"),
    textElement(
      "span",
      `${candidate.cues.accessCount} qualified`,
      "resumption-forecast__confidence"
    )
  );
  item.append(meta);

  const reasons = document.createElement("ul");
  reasons.className = "resumption-forecast__reasons";
  for (const reason of candidate.reasons) reasons.append(textElement("li", reason));
  item.append(reasons);
  return item;
}

function signalGrid(snapshot, recognition) {
  const list = document.createElement("dl");
  list.className = "state-inspector__signals";
  for (const [label, value] of [
    ["Current", recognition.signals.currentCount],
    ["Elsewhere", recognition.signals.otherCount],
    ["Live", snapshot.topology.openItemCount],
    ["Recovered", snapshot.topology.recoveredItemCount],
    ["Gap", formatGap(recognition.signals.gapMs)]
  ]) {
    const item = document.createElement("div");
    item.append(textElement("dt", label), textElement("dd", String(value)));
    list.append(item);
  }
  return list;
}

function evidenceList(evidence) {
  const list = document.createElement("ul");
  list.className = "state-inspector__evidence";
  for (const item of evidence) list.append(textElement("li", humanizeEvidence(item)));
  return list;
}

function renderForecast(forecast) {
  const candidates = forecast?.candidates || [];
  const section = document.createElement("section");
  section.className = "resumption-forecast";
  section.setAttribute("aria-label", "Predicted work to resume");

  const header = document.createElement("header");
  header.append(
    textElement("h2", "Likely to resume"),
    textElement("span", `${candidates.length} predicted`)
  );
  section.append(header);

  if (candidates.length === 0) {
    section.append(textElement(
      "p",
      "No recoverable activity in the last 24 hours.",
      "resumption-forecast__empty"
    ));
    return section;
  }

  const list = document.createElement("ol");
  list.className = "resumption-forecast__list";
  for (const candidate of candidates) list.append(renderForecastCandidate(candidate));
  section.append(list);

  if (forecast.suppressedCount > 0) {
    section.append(textElement(
      "p",
      `+ ${forecast.suppressedCount} lower-ranked activit${forecast.suppressedCount === 1 ? "y" : "ies"}`,
      "resumption-forecast__more"
    ));
  }
  return section;
}

function renderForecastCandidate(candidate) {
  const item = document.createElement("li");
  item.className = "resumption-forecast__item";
  item.dataset.provenance = candidate.provenance;

  const heading = document.createElement("div");
  heading.className = "resumption-forecast__heading";
  heading.append(
    textElement("span", VERB_LABELS[candidate.action.verb] || candidate.action.verb, "resumption-forecast__verb"),
    textElement("span", `${Math.round(candidate.score * 100)}`, "resumption-forecast__score")
  );
  item.append(heading, tabLink(candidate.action.target, "resumption-forecast__target"));

  const meta = document.createElement("p");
  meta.className = "resumption-forecast__meta";
  meta.append(
    textElement("span", domainOf(candidate.action.target?.url), "resumption-forecast__domain"),
    textElement("span", `${Math.round(candidate.confidence * 100)}% confidence`, "resumption-forecast__confidence")
  );
  item.append(meta);

  const reasons = document.createElement("ul");
  reasons.className = "resumption-forecast__reasons";
  for (const reason of candidate.reasons) reasons.append(textElement("li", reason));
  item.append(reasons);
  return item;
}

const VERB_LABELS = Object.freeze({
  open: "Open",
  reopen: "Reopen",
  restart: "Restart from",
  continue: "Continue here",
  switch: "Switch to"
});

function renderNeighborhoodPreview(neighborhoods) {
  const section = document.createElement("section");
  section.className = "neighborhood-preview";
  section.setAttribute("aria-label", "Connected browsing neighborhoods");

  const header = document.createElement("header");
  header.append(
    textElement("h2", "Connected work"),
    textElement("span", `${neighborhoods.length} neighborhood${neighborhoods.length === 1 ? "" : "s"}`)
  );
  section.append(header);

  const list = document.createElement("ol");
  list.className = "neighborhood-preview__list";
  for (const neighborhood of neighborhoods.slice(0, 4)) {
    list.append(renderNeighborhood(neighborhood));
  }
  section.append(list);

  if (neighborhoods.length > 4) {
    section.append(textElement(
      "p",
      `+ ${neighborhoods.length - 4} more connected areas`,
      "neighborhood-preview__more"
    ));
  }
  return section;
}

function renderNeighborhood(neighborhood) {
  const item = document.createElement("li");
  const mode = neighborhood.itemCount === 1
    ? "landmark"
    : neighborhood.itemCount === 2
      ? "pair"
      : neighborhood.itemCount <= 5
        ? "trail"
        : "summary";
  item.className = `neighborhood-preview__item neighborhood-preview__item--${mode}`;
  item.dataset.density = neighborhood.density;

  const relation = primaryRelation(neighborhood);
  const tabs = mode === "pair"
    ? orderedPairTabs(neighborhood, relation.type)
    : neighborhood.items.slice(0, mode === "summary" ? 3 : 5);

  if (mode === "landmark") {
    item.append(tabLink(tabs[0], "neighborhood-preview__landmark"));
    item.append(textElement("span", domainOf(tabs[0]?.url), "neighborhood-preview__domain"));
    return item;
  }

  if (mode === "pair") {
    item.append(
      tabLink(tabs[0], "neighborhood-preview__pair-title"),
      textElement("span", relation.label, `neighborhood-preview__relation neighborhood-preview__relation--${relation.type}`),
      tabLink(tabs[1], "neighborhood-preview__pair-title")
    );
    return item;
  }

  const heading = document.createElement("div");
  heading.className = "neighborhood-preview__heading";
  heading.append(
    textElement("span", relation.label, `neighborhood-preview__relation neighborhood-preview__relation--${relation.type}`),
    textElement("span", `${neighborhood.itemCount} pages`, "neighborhood-preview__count")
  );
  item.append(heading);

  const route = document.createElement("ol");
  route.className = "neighborhood-preview__route";
  for (const tab of tabs) {
    const routeItem = document.createElement("li");
    routeItem.append(tabLink(tab));
    route.append(routeItem);
  }
  item.append(route);
  return item;
}

function orderedPairTabs(neighborhood, relationType) {
  const items = neighborhood?.items || [];
  if (!["spawn", "referrer"].includes(relationType)) return items.slice(0, 2);

  const evidence = (neighborhood.edges || [])
    .flatMap(edge => edge.evidence || [])
    .find(item => item.type === relationType);
  if (!evidence) return items.slice(0, 2);

  const source = items.find(item => item.key === evidence.sourceKey);
  const target = items.find(item => item.key === evidence.targetKey);
  return source && target ? [target, source] : items.slice(0, 2);
}

function primaryRelation(neighborhood) {
  const counts = neighborhood?.relationCounts || {};
  if ((counts.spawn || 0) > 0) return { type: "spawn", label: "opened from" };
  if ((counts.referrer || 0) > 0) return { type: "referrer", label: "followed from" };
  if ((counts.temporal || 0) > 0) return { type: "temporal", label: "active together" };
  return { type: "single", label: "open landmark" };
}

function renderTopologyAudit(snapshot) {
  const neighborhoods = snapshot?.neighborhoods || [];
  const edgeCount = snapshot?.topology?.edgeCount || 0;
  const isolates = neighborhoods.filter(item => item.itemCount === 1).length;
  const largest = Math.max(0, ...neighborhoods.map(item => item.itemCount || 0));

  const audit = document.createElement("details");
  audit.className = "neighborhood-audit";

  const summary = document.createElement("summary");
  summary.append(
    textElement("span", "Audit topology", "neighborhood-audit__title"),
    textElement(
      "span",
      `${neighborhoods.length} component${neighborhoods.length === 1 ? "" : "s"}`,
      "neighborhood-audit__health"
    )
  );

  const body = document.createElement("div");
  body.className = "neighborhood-audit__body";
  body.append(
    auditMetrics([
      ["Components", neighborhoods.length],
      ["Isolates", isolates],
      ["Largest", `${largest} page${largest === 1 ? "" : "s"}`],
      ["Edges", edgeCount]
    ]),
    relationBreakdown(snapshot?.topology),
    renderAuditedComponents(neighborhoods)
  );
  audit.append(summary, body);
  return audit;
}

function auditMetrics(metrics) {
  const list = document.createElement("dl");
  list.className = "neighborhood-audit__metrics";
  for (const [label, value] of metrics) {
    const item = document.createElement("div");
    item.append(textElement("dt", label), textElement("dd", String(value)));
    list.append(item);
  }
  return list;
}

function relationBreakdown(topology = {}) {
  const structural = Number(topology?.structuralEdgeCount || 0);
  const temporal = Number(topology?.temporalEdgeCount || 0);
  const line = document.createElement("p");
  line.className = "neighborhood-audit__breakdown";
  line.append(
    textElement("span", `${structural} structural`, "neighborhood-audit__relation-count"),
    textElement("span", `${temporal} temporal`, "neighborhood-audit__relation-count")
  );
  return line;
}

function renderAuditedComponents(neighborhoods) {
  const list = document.createElement("ol");
  list.className = "neighborhood-audit__components";

  neighborhoods.forEach((neighborhood, index) => {
    const item = document.createElement("li");
    const details = document.createElement("details");
    details.className = "neighborhood-audit__component";

    const summary = document.createElement("summary");
    summary.append(
      textElement("span", `Neighborhood ${String(index + 1).padStart(2, "0")}`),
      textElement("span", componentRelationSummary(neighborhood), "neighborhood-audit__component-counts")
    );

    const body = document.createElement("div");
    body.className = "neighborhood-audit__component-body";
    body.append(renderAuditedTabs(neighborhood.items));
    if ((neighborhood.edges || []).length > 0) {
      body.append(renderAuditedEdges(neighborhood));
    } else {
      body.append(textElement(
        "p",
        neighborhood.openCount > 0
          ? "No joining evidence — isolated open page."
          : "No joining evidence — isolated page recovered from history.",
        "neighborhood-audit__isolated"
      ));
    }
    details.append(summary, body);
    item.append(details);
    list.append(item);
  });
  return list;
}

function componentRelationSummary(neighborhood) {
  const counts = neighborhood?.relationCounts || {};
  const pages = `${neighborhood.itemCount} page${neighborhood.itemCount === 1 ? "" : "s"}`;
  const relations = [
    ["spawn", counts.spawn],
    ["referrer", counts.referrer],
    ["temporal", counts.temporal]
  ]
    .filter(([, count]) => Number(count) > 0)
    .map(([label, count]) => `${count} ${label}`);
  const recovered = neighborhood.recoveredCount > 0
    ? [`${neighborhood.recoveredCount} recovered`]
    : [];
  return [pages, ...relations, ...recovered].join(" · ");
}

function renderAuditedTabs(items = []) {
  const list = document.createElement("ol");
  list.className = "neighborhood-audit__tabs";
  for (const entry of items) {
    const item = document.createElement("li");
    item.append(
      tabLink(entry),
      textElement("span", domainOf(entry?.url), "neighborhood-audit__tab-domain")
    );
    list.append(item);
  }
  return list;
}

function renderAuditedEdges(neighborhood) {
  const itemsByKey = new Map(neighborhood.items.map(item => [item.key, item]));
  const list = document.createElement("ol");
  list.className = "neighborhood-audit__reasons";

  for (const edge of neighborhood.edges) {
    for (const evidence of edge.evidence || []) {
      const item = document.createElement("li");
      item.append(
        textElement("p", edgeReason(evidence, itemsByKey), "neighborhood-audit__reason"),
        textElement("span", evidenceProvenance(evidence), "neighborhood-audit__provenance")
      );
      list.append(item);
    }
  }
  return list;
}

function edgeReason(evidence, itemsByKey) {
  const source = itemsByKey.get(evidence.sourceKey);
  const target = itemsByKey.get(evidence.targetKey);
  const sourceTitle = source?.title || "Unknown source";
  const targetTitle = target?.title || "Unknown target";

  if (evidence.type === "spawn") return `${targetTitle} opened from ${sourceTitle}`;
  if (evidence.type === "referrer") return `${targetTitle} followed from ${sourceTitle}`;
  return `${sourceTitle} and ${targetTitle} were active together`;
}

function evidenceProvenance(evidence) {
  const parts = [humanizeEvidence(evidence.origin || evidence.type)];
  if (evidence.type === "temporal" && Number.isFinite(evidence.distanceMs)) {
    parts.push(`${formatDistance(evidence.distanceMs)} apart`);
  }
  return parts.join(" · ");
}

function tabLink(item, className = "") {
  const link = document.createElement("a");
  const title = item?.title || "Untitled";
  link.href = item?.url || "#";
  link.textContent = title;
  // Open and recovered pages activate differently later; say which this is now
  // so the audit cannot silently imply a closed page is still live.
  link.title = item?.open ? title : `${title} (recovered from history)`;
  link.dataset.origin = item?.open ? "open" : "recovered";
  if (className) link.className = className;
  return link;
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "open page";
  }
}

function getOrCreateInspector() {
  let inspector = document.getElementById("startPageStateInspector");
  if (inspector) return inspector;
  inspector = document.createElement("aside");
  inspector.id = "startPageStateInspector";
  inspector.className = "state-inspector";
  inspector.setAttribute("aria-label", "Development state recognition");
  inspector.setAttribute("aria-live", "polite");
  document.body.append(inspector);
  return inspector;
}

function renderFailure(error) {
  console.warn("[StartPageRecognition] inspector failed", error);
  const message = `State recognition unavailable: ${String(error?.message || error)}`;
  if (homeEnabled) {
    renderHome({
      loading: false,
      mode: "quiet",
      state: "launch",
      stateLabel: "Unavailable",
      summary: "The adaptive view could not be prepared.",
      actions: [],
      neighborhoods: [],
      error: message
    });
  }
  if (installType === "development") {
    const inspector = getOrCreateInspector();
    inspector.dataset.state = "error";
    inspector.replaceChildren(textElement("p", message, "state-inspector__error"));
  }
}

function textElement(tag, text, className = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function humanizeEvidence(value) {
  return String(value || "").replaceAll("-", " ");
}

function formatGap(gapMs) {
  if (!Number.isFinite(gapMs)) return "unknown";
  if (gapMs < 60000) return "<1m";
  if (gapMs >= 2 * 60 * 60 * 1000) {
    const totalMinutes = Math.round(gapMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${Math.round(gapMs / 60000)}m`;
}

function formatDistance(distanceMs) {
  if (distanceMs < 1000) return "<1s";
  if (distanceMs < 60000) return `${Math.round(distanceMs / 1000)}s`;
  return `${Math.round(distanceMs / 60000)}m`;
}

function getInstallType() {
  return new Promise(resolve => {
    if (!chrome.management?.getSelf) return resolve("normal");
    chrome.management.getSelf(info => {
      if (chrome.runtime.lastError) return resolve("normal");
      resolve(info?.installType || "normal");
    });
  });
}

async function shouldUseHomeTakeover() {
  if (window.location.hash === "#/treemap") return false;
  if (window.location.hash === "#/home") return true;
  return readFeatureFlag(chrome.storage?.local, FEATURE_FLAGS.homeTakeover);
}
