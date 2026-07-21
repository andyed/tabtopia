import { getRecentHistory } from "../lib/history-cache.js";
import { createBrowsingSnapshot } from "../lib/browsing-snapshot.js";
import { recognizeStartPageState, stateDisplayName } from "../lib/start-page-state.js";

const HISTORY_HORIZON_MS = 24 * 60 * 60 * 1000;
const HISTORY_ITEM_LIMIT = 80;
const PROVENANCE_ITEM_LIMIT = 16;
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
  const [currentWindow, windows, historyItems, backgroundState] = await Promise.all([
    getCurrentWindow(),
    getAllWindows(),
    getRecentHistory({
      startTime: now - HISTORY_HORIZON_MS,
      maxResults: HISTORY_ITEM_LIMIT
    }),
    getBackgroundState()
  ]);
  const visitsByUrl = await getRecentVisitProvenance(historyItems.slice(0, PROVENANCE_ITEM_LIMIT));
  const snapshot = createBrowsingSnapshot({
    now,
    currentWindowId: currentWindow?.id,
    windows,
    historyItems,
    visitsByUrl,
    activityByTab: Object.fromEntries(backgroundState?.tabActivityLog || [])
  });
  const recognition = recognizeStartPageState(snapshot);

  window.tabtopiaStartPageRecognition = {
    snapshot,
    recognition,
    refresh: refreshRecognition
  };
  renderInspector(snapshot, recognition);
  window.dispatchEvent(new CustomEvent("tabtopia-state-recognized", {
    detail: { snapshot, recognition }
  }));
  return { snapshot, recognition };
}

function renderInspector(snapshot, recognition) {
  const inspector = getOrCreateInspector();
  inspector.dataset.state = recognition.state;
  inspector.dataset.confidence = recognition.confidence.toFixed(2);

  const stateName = stateDisplayName(recognition.state);
  const confidence = Math.round(recognition.confidence * 100);
  inspector.replaceChildren();

  const details = document.createElement("details");
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
    evidenceList(recognition.evidence)
  );
  details.append(summary, body);
  inspector.append(details);
}

function signalGrid(snapshot, recognition) {
  const list = document.createElement("dl");
  list.className = "state-inspector__signals";
  for (const [label, value] of [
    ["Current", recognition.signals.currentCount],
    ["Elsewhere", recognition.signals.otherCount],
    ["Neighborhoods", snapshot.neighborhoods.length],
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
  return `${Math.round(gapMs / 60000)}m`;
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
  return chrome.runtime.sendMessage({ action: "getState" }).catch(() => ({ tabActivityLog: [] }));
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
