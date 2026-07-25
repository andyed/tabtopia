import {
  clearRecentHistoryCache,
  getRecentHistory,
  recentHistoryCacheConfig
} from "../lib/history-cache.js";
import { createBrowsingSnapshot } from "../lib/browsing-snapshot.js";
import {
  HABIT_DESTINATION_DEFAULTS,
  prepareHabitCandidatePool,
  rankHabitDestinations
} from "../lib/habit-destinations.js";
import { recognizeStartPageState, stateDisplayName } from "../lib/start-page-state.js";
import { forecastResumption } from "../lib/resumption-forecast.js";

const HISTORY_HORIZON_MS = 24 * 60 * 60 * 1000;
const HISTORY_ITEM_LIMIT = 80;
const HABIT_HISTORY_ITEM_LIMIT = recentHistoryCacheConfig.maxResults;
// Visits are what history-recovered neighborhoods are built from, so the
// provenance fetch is now load-bearing rather than a sample. It stays bounded:
// one getVisits call per item, and the builder caps how many become nodes.
const PROVENANCE_ITEM_LIMIT = 60;
const VISITS_PER_ITEM_LIMIT = 64;
const REFRESH_DEBOUNCE_MS = 500;

let refreshTimer = null;
let refreshInFlight = null;

startWhenIdle();

async function startWhenIdle() {
  const installType = await getInstallType();
  if (installType !== "development") return;

  const start = () => {
    scheduleRefresh(0);
    installRefreshListeners();
  };

  if (document.readyState === "complete") {
    scheduleIdle(start);
  } else {
    window.addEventListener("load", () => scheduleIdle(start), { once: true });
  }
}

function scheduleIdle(callback) {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(callback, { timeout: 1200 });
  } else {
    setTimeout(callback, 0);
  }
}

function installRefreshListeners() {
  chrome.tabs.onCreated.addListener(() => scheduleRefresh());
  chrome.tabs.onRemoved.addListener(() => scheduleRefresh());
  chrome.tabs.onActivated.addListener(() => scheduleRefresh());
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") scheduleRefresh();
  });
  chrome.windows.onCreated.addListener(() => scheduleRefresh());
  chrome.windows.onRemoved.addListener(() => scheduleRefresh());
  chrome.windows.onFocusChanged.addListener(() => scheduleRefresh());
  chrome.history.onVisited.addListener(() => invalidateHistoryAndRefresh());
  chrome.history.onVisitRemoved.addListener(() => invalidateHistoryAndRefresh());
}

function invalidateHistoryAndRefresh() {
  clearRecentHistoryCache()
    .catch(() => {})
    .finally(() => scheduleRefresh());
}

function scheduleRefresh(delay = REFRESH_DEBOUNCE_MS) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshRecognition().catch(error => renderFailure(error));
  }, delay);
}

async function refreshRecognition() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = collectRecognition().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function collectRecognition() {
  const now = Date.now();
  const [currentWindow, windows, historyPool, backgroundState] = await Promise.all([
    getCurrentWindow(),
    getAllWindows(),
    getRecentHistory({
      startTime: now - recentHistoryCacheConfig.horizonMs,
      maxResults: HABIT_HISTORY_ITEM_LIMIT
    }),
    getBackgroundState()
  ]);
  const historyItems = historyPool
    .filter(item => Number(item?.lastVisitTime || 0) >= now - HISTORY_HORIZON_MS)
    .slice(0, HISTORY_ITEM_LIMIT);
  const habitPool = prepareHabitCandidatePool(historyPool, {
    maxScoredPages: HABIT_DESTINATION_DEFAULTS.maxScoredPages
  });
  const [visitsByUrl, historyScores] = await Promise.all([
    getRecentVisitProvenance(historyItems.slice(0, PROVENANCE_ITEM_LIMIT)),
    scoreHabitHistory(habitPool.candidates)
  ]);
  const snapshot = createBrowsingSnapshot({
    now,
    currentWindowId: currentWindow?.id,
    windows,
    historyItems,
    visitsByUrl,
    activityByTab: Object.fromEntries(backgroundState?.tabActivityLog || []),
    tabHistory: backgroundState?.tabHistory || [],
    tabRelationships: backgroundState?.tabRelationships || []
  });
  const recognition = recognizeStartPageState(snapshot);
  const forecast = forecastResumption(snapshot, { state: recognition.state });
  const habitDestinations = rankHabitDestinations({
    pool: habitPool,
    historyScores,
    openTabs: windows.flatMap(window => window.tabs || []),
    now,
    limit: HABIT_DESTINATION_DEFAULTS.resultLimit
  });

  window.tabtopiaStartPageRecognition = {
    snapshot,
    recognition,
    forecast,
    habitDestinations,
    refresh: refreshRecognition
  };
  renderInspector(snapshot, recognition, forecast, habitDestinations);
  window.dispatchEvent(new CustomEvent("tabtopia-state-recognized", {
    detail: { snapshot, recognition, forecast, habitDestinations }
  }));
  return { snapshot, recognition, forecast, habitDestinations };
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
  details.open = true;
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
  const inspector = getOrCreateInspector();
  inspector.dataset.state = "error";
  inspector.replaceChildren(textElement(
    "p",
    `State recognition unavailable: ${String(error?.message || error)}`,
    "state-inspector__error"
  ));
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

async function getRecentVisitProvenance(historyItems) {
  const cutoff = Date.now() - HISTORY_HORIZON_MS;
  const entries = await Promise.all(historyItems.map(async item => [
    item.url,
    (await getVisits(item.url))
      .filter(visit => Number(visit?.visitTime || 0) >= cutoff)
      .slice(-VISITS_PER_ITEM_LIMIT)
  ]));
  return Object.fromEntries(entries);
}

function getVisits(url) {
  return new Promise(resolve => {
    chrome.history.getVisits({ url }, visits => {
      if (chrome.runtime.lastError) return resolve([]);
      resolve(Array.isArray(visits) ? visits : []);
    });
  });
}

function getAllWindows() {
  return new Promise((resolve, reject) => {
    chrome.windows.getAll({ populate: true }, windows => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(windows || []);
    });
  });
}

function getCurrentWindow() {
  return new Promise((resolve, reject) => {
    chrome.windows.getCurrent(window => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(window || null);
    });
  });
}

function getBackgroundState() {
  return chrome.runtime.sendMessage({ action: "getState" }).catch(() => ({
    tabActivityLog: [],
    tabHistory: [],
    tabRelationships: []
  }));
}

async function scoreHabitHistory(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  try {
    const response = await chrome.runtime.sendMessage({
      action: "scoreHabitHistory",
      candidates: candidates.map(candidate => ({
        key: candidate.key,
        url: candidate.url
      }))
    });
    return response?.success && Array.isArray(response.scores) ? response.scores : [];
  } catch {
    return [];
  }
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
