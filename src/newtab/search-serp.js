import { getRecentHistory, recentHistoryCacheConfig } from "../lib/history-cache.js";
import { buildStartPageSearchResults } from "../lib/start-page-search.js";
import { formatRelativeAccess } from "../lib/tab-recall.js";
import { createStartPageActionExecutor } from "./start-page-actions.js";
import { createLetterFavicon, getLocalFaviconUrl } from "./utility.js";

const DIRECT_HISTORY_LIMIT = 200;
const RESULT_LIMIT = 16;
const QUERY_CACHE_LIMIT = 8;

export function createSearchSerp(root = document.getElementById("startPageSearch")) {
  if (!root) return inertSerp();

  const executeAction = createStartPageActionExecutor();
  const queryCache = new Map();
  const inFlightQueries = new Map();
  let requestId = 0;
  let currentQuery = "";
  let currentOpenItems = [];
  let onClear = null;

  root.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClear?.();
    }
  });

  function connectSearchInput(searchInput, clearHandler) {
    if (!searchInput) return;
    onClear = clearHandler;
  }

  function update(query, openItems = []) {
    const normalized = String(query || "").trim();
    currentOpenItems = array(openItems);
    if (!normalized) {
      clear();
      return Promise.resolve([]);
    }

    currentQuery = normalized;
    const thisRequest = ++requestId;
    showRoot(normalized);
    const quickHistory = liveHistoryPool();
    const cachedDirect = queryCache.get(normalized);
    const immediateHistory = cachedDirect || quickHistory;
    const immediate = resultsFor(normalized, currentOpenItems, immediateHistory);
    render(normalized, immediate, { loading: !cachedDirect, error: "" });
    if (cachedDirect) return Promise.resolve(immediate);

    return directHistoryFor(normalized).then(directHistory => {
      rememberQuery(normalized, directHistory);
      if (thisRequest !== requestId || currentQuery !== normalized) return [];
      const complete = resultsFor(normalized, currentOpenItems, [...quickHistory, ...directHistory]);
      render(normalized, complete, { loading: false, error: "" });
      return complete;
    }).catch(() => {
      if (thisRequest !== requestId || currentQuery !== normalized) return [];
      render(normalized, immediate, {
        loading: false,
        error: "Full History is unavailable; showing matches already in memory."
      });
      return immediate;
    });
  }

  function clear() {
    requestId += 1;
    currentQuery = "";
    currentOpenItems = [];
    root.hidden = true;
    root.replaceChildren();
    root.removeAttribute("data-query");
    root.setAttribute("aria-busy", "false");
    document.body.classList.remove("start-page-search-active");
  }

  function focusFirst() {
    const first = resultLinks()[0];
    if (!first) return false;
    first.focus();
    return true;
  }

  function activateFirst() {
    const first = resultLinks()[0];
    if (!first) return false;
    first.click();
    return true;
  }

  function isActive() {
    return !root.hidden && Boolean(currentQuery);
  }

  function moveFocus(direction) {
    const links = resultLinks();
    if (links.length === 0) return false;
    const currentIndex = links.indexOf(document.activeElement);
    const nextIndex = currentIndex < 0
      ? (direction > 0 ? 0 : links.length - 1)
      : (currentIndex + direction + links.length) % links.length;
    links[nextIndex].focus();
    return true;
  }

  function resultLinks() {
    return [...root.querySelectorAll(".search-serp__result-link")];
  }

  function showRoot(query) {
    document.body.classList.add("start-page-search-active");
    root.hidden = false;
    root.dataset.query = query;
    root.setAttribute("aria-busy", "true");
  }

  function render(query, results, { loading, error }) {
    if (query !== currentQuery) return;
    const fragment = document.createDocumentFragment();
    const header = element("header", "search-serp__header");
    header.append(
      element("p", "search-serp__kicker", "Search"),
      queryHeading(query),
      element(
        "p",
        "search-serp__summary",
        summaryText(results.length, loading)
      )
    );
    fragment.append(header);

    if (error) {
      const warning = element("p", "search-serp__warning", error);
      warning.setAttribute("role", "status");
      fragment.append(warning);
    }

    if (results.length > 0) {
      fragment.append(resultList(results));
    } else if (loading) {
      fragment.append(loadingState());
    } else {
      fragment.append(emptyState(query));
    }

    fragment.append(searchHelp());
    root.replaceChildren(fragment);
    root.setAttribute("aria-busy", String(loading));
  }

  function resultList(results) {
    const list = element("ol", "search-serp__results");
    list.setAttribute("aria-label", "Matching open tabs and recent pages");
    results.forEach((result, index) => {
      const item = element("li", "search-serp__result");
      item.dataset.rank = String(index + 1).padStart(2, "0");
      item.classList.toggle("search-serp__result--open", result.open);
      item.append(resultLink(result));
      list.append(item);
    });
    return list;
  }

  function resultLink(result) {
    const link = element("a", "search-serp__result-link");
    link.href = result.url;
    link.dataset.resultId = result.id;
    link.dataset.verb = result.open ? "switch" : "open";
    link.setAttribute("aria-label", `${result.open ? "Switch to" : "Open"}: ${result.title}`);

    const rank = element("span", "search-serp__rank", "");
    rank.setAttribute("aria-hidden", "true");
    const icon = resultFavicon(result);
    const copy = element("span", "search-serp__copy");
    copy.append(
      element("strong", "search-serp__title", result.title),
      element("span", "search-serp__location", displayLocation(result))
    );
    const evidence = element("span", "search-serp__evidence");
    evidence.append(
      evidenceToken(result.open ? "Open tab" : "History", result.open ? "open" : "history"),
      evidenceToken(result.matchKind, "match")
    );
    if (result.lastSeenAt > 0) {
      evidence.append(evidenceToken(formatRelativeAccess(result.lastSeenAt), "time"));
    }
    if (result.visitCount > 1) {
      evidence.append(evidenceToken(`${result.visitCount} visits`, "visits"));
    }
    link.append(rank, icon, copy, evidence);

    link.addEventListener("click", event => {
      if (usesNativeNavigation(event)) return;
      event.preventDefault();
      activateResult(result, link);
    });
    return link;
  }

  async function activateResult(result, link) {
    if (link.dataset.pending === "true") return;
    link.dataset.pending = "true";
    link.setAttribute("aria-busy", "true");
    const action = result.open
      ? {
          verb: "switch",
          target: {
            title: result.title,
            url: result.url,
            open: true,
            tabId: result.tabId,
            windowId: result.windowId
          }
        }
      : {
          verb: "open",
          target: { title: result.title, url: result.url, open: false }
        };
    const outcome = await executeAction(action);
    if (!link.isConnected) return;
    delete link.dataset.pending;
    link.removeAttribute("aria-busy");
    if (!outcome?.ok) {
      const warning = root.querySelector(".search-serp__warning") || element("p", "search-serp__warning");
      warning.setAttribute("role", "alert");
      warning.textContent = "Could not open that result. The search is still here to retry.";
      if (!warning.isConnected) root.querySelector(".search-serp__header")?.after(warning);
    }
  }

  function rememberQuery(query, historyItems) {
    if (queryCache.has(query)) queryCache.delete(query);
    queryCache.set(query, array(historyItems));
    while (queryCache.size > QUERY_CACHE_LIMIT) queryCache.delete(queryCache.keys().next().value);
  }

  function directHistoryFor(query) {
    const existing = inFlightQueries.get(query);
    if (existing) return existing;
    const request = getRecentHistory({
      text: query,
      startTime: Date.now() - recentHistoryCacheConfig.horizonMs,
      maxResults: DIRECT_HISTORY_LIMIT
    }).finally(() => {
      if (inFlightQueries.get(query) === request) inFlightQueries.delete(query);
    });
    inFlightQueries.set(query, request);
    return request;
  }

  return { update, clear, focusFirst, activateFirst, isActive, moveFocus, connectSearchInput };
}

function resultsFor(query, openItems, historyItems) {
  return buildStartPageSearchResults({
    query,
    openItems,
    historyItems,
    now: Date.now(),
    limit: RESULT_LIMIT
  });
}

function liveHistoryPool() {
  return array(window.tabtopiaStartPageRecognition?.historyPool);
}

function queryHeading(query) {
  const heading = element("h1", "search-serp__titleline");
  heading.append(
    document.createTextNode("Results for "),
    element("span", "search-serp__query", `“${query}”`)
  );
  return heading;
}

function summaryText(count, loading) {
  const noun = count === 1 ? "match" : "matches";
  if (loading && count > 0) return `${count} ${noun} now · checking full History`;
  if (loading) return "Checking open tabs and recent History";
  return `${count} ${noun} across open tabs and recent History`;
}

function resultFavicon(result) {
  const icon = element("img", "search-serp__favicon");
  icon.src = getLocalFaviconUrl(result.url, 32);
  icon.alt = "";
  icon.width = 32;
  icon.height = 32;
  icon.setAttribute("aria-hidden", "true");
  icon.addEventListener("error", () => {
    icon.src = createLetterFavicon(result.url);
  }, { once: true });
  return icon;
}

function evidenceToken(text, kind) {
  const token = element("span", `search-serp__token search-serp__token--${kind}`, text);
  return token;
}

function displayLocation(result) {
  const path = String(result.path || "/");
  const concisePath = path === "/" ? "" : path;
  return `${result.domain}${concisePath}`;
}

function loadingState() {
  const section = element("section", "search-serp__loading");
  section.setAttribute("aria-label", "Searching recent History");
  section.append(element("p", "search-serp__empty-title", "Looking through recent History"));
  const rows = element("div", "search-serp__loading-rows");
  rows.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 4; index += 1) rows.append(element("span", "search-serp__loading-row"));
  section.append(rows);
  return section;
}

function emptyState(query) {
  const section = element("section", "search-serp__empty");
  section.append(
    element("h2", "search-serp__empty-title", "No recent page matched every word"),
    element("p", "search-serp__empty-copy", `Try a title fragment, site, or URL from “${query}”.`)
  );
  return section;
}

function searchHelp() {
  const help = element("p", "search-serp__help", "↑↓ move · Enter opens · Esc clears");
  return help;
}

function usesNativeNavigation(event) {
  return event.defaultPrevented
    || event.button !== 0
    || event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey;
}

function inertSerp() {
  const noop = () => false;
  return {
    update: async () => [],
    clear: noop,
    focusFirst: noop,
    activateFirst: noop,
    isActive: noop,
    moveFocus: noop,
    connectSearchInput: noop
  };
}

function element(tagName, className = "", text = "") {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== "") node.textContent = String(text);
  return node;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}
