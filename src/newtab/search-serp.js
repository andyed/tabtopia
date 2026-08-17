import { getRecentHistory, recentHistoryCacheConfig } from "../lib/history-cache.js";
import { buildStartPageSearchResults } from "../lib/start-page-search.js";
import { buildTypeaheadCompletion } from "../lib/typeahead-completion.js";
import { createStartPageActionExecutor } from "./start-page-actions.js";
import { createLetterFavicon, getLocalFaviconUrl } from "./utility.js";
import { buildSearchEvidence } from "./search-evidence.js";
import { createSearchFisheye } from "./search-fisheye.js";

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
  let currentRetrieval = emptyRetrieval();
  let onClear = null;
  let connectedSearchInput = null;
  let currentCompletion = null;
  let composing = false;
  const typeahead = typeaheadElements();
  const fisheye = createSearchFisheye(root);

  root.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (moveFocus(event.key === "ArrowDown" ? 1 : -1)) event.preventDefault();
      return;
    }
    if (event.key === "ArrowLeft" && event.target.closest?.(".search-serp__result-link")) {
      event.preventDefault();
      focusSearchInput();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClear?.();
      connectedSearchInput?.focus();
    }
  });

  function connectSearchInput(searchInput, clearHandler) {
    if (!searchInput) return;
    onClear = clearHandler;
    if (connectedSearchInput === searchInput) return;
    connectedSearchInput?.removeEventListener("keydown", handleSearchInputNavigation);
    connectedSearchInput?.removeEventListener("keydown", handleTypeaheadKeydown);
    connectedSearchInput?.removeEventListener("input", clearTypeahead);
    connectedSearchInput?.removeEventListener("compositionstart", handleCompositionStart);
    connectedSearchInput?.removeEventListener("compositionend", handleCompositionEnd);
    connectedSearchInput = searchInput;
    connectedSearchInput.addEventListener("keydown", handleTypeaheadKeydown);
    connectedSearchInput.addEventListener("keydown", handleSearchInputNavigation);
    connectedSearchInput.addEventListener("input", clearTypeahead);
    connectedSearchInput.addEventListener("compositionstart", handleCompositionStart);
    connectedSearchInput.addEventListener("compositionend", handleCompositionEnd);
  }

  function handleTypeaheadKeydown(event) {
    if (event.isComposing || composing || !currentCompletion) return;
    const acceptsWithTab = event.key === "Tab" && !event.shiftKey;
    if (!acceptsWithTab) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    acceptTypeahead();
  }

  function handleCompositionStart() {
    composing = true;
    clearTypeahead();
  }

  function handleCompositionEnd() {
    composing = false;
  }

  function caretIsAtEnd() {
    if (!connectedSearchInput) return false;
    const end = connectedSearchInput.value.length;
    return connectedSearchInput.selectionStart === end
      && connectedSearchInput.selectionEnd === end;
  }

  function acceptTypeahead() {
    if (!connectedSearchInput || !currentCompletion) return false;
    connectedSearchInput.value = currentCompletion.value;
    const end = connectedSearchInput.value.length;
    connectedSearchInput.setSelectionRange?.(end, end);
    clearTypeahead();
    connectedSearchInput.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  function handleSearchInputNavigation(event) {
    if (event.key === "ArrowRight" && caretIsAtEnd()) {
      if (focusFirst()) event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (moveFocus(event.key === "ArrowDown" ? 1 : -1)) event.preventDefault();
    }
  }

  function focusSearchInput() {
    if (!connectedSearchInput) return false;
    connectedSearchInput.focus({ preventScroll: true });
    const end = connectedSearchInput.value.length;
    connectedSearchInput.setSelectionRange?.(end, end);
    return true;
  }

  function update(query, openItems = [], retrieval = {}) {
    const normalized = String(query || "").trim();
    currentOpenItems = array(openItems);
    currentRetrieval = normalizeRetrieval(retrieval);
    if (!normalized) {
      clear();
      return Promise.resolve([]);
    }

    currentQuery = normalized;
    const thisRequest = ++requestId;
    showRoot(normalized);
    const local = resultsFor(normalized, currentOpenItems, [], currentRetrieval);
    const needsHistory = !currentRetrieval.historyFallback || local.length < RESULT_LIMIT;
    const quickHistory = currentRetrieval.historyFallback ? [] : liveHistoryPool();
    const cachedDirect = queryCache.get(normalized);
    const immediateHistory = cachedDirect || quickHistory;
    const immediate = resultsFor(normalized, currentOpenItems, immediateHistory, currentRetrieval);
    render(normalized, immediate, { loading: needsHistory && !cachedDirect, error: "" });
    if (!needsHistory || cachedDirect) return Promise.resolve(immediate);

    return directHistoryFor(normalized).then(directHistory => {
      rememberQuery(normalized, directHistory);
      if (thisRequest !== requestId || currentQuery !== normalized) return [];
      const complete = resultsFor(
        normalized,
        currentOpenItems,
        [...quickHistory, ...directHistory],
        currentRetrieval
      );
      render(normalized, complete, { loading: false, error: "" });
      return complete;
    }).catch(() => {
      if (thisRequest !== requestId || currentQuery !== normalized) return [];
      render(normalized, immediate, {
        loading: false,
        error: currentRetrieval.historyFallback
          ? "History fallback is unavailable; showing saved recall matches."
          : "Full History is unavailable; showing matches already in memory."
      });
      return immediate;
    });
  }

  function clear() {
    requestId += 1;
    currentQuery = "";
    currentOpenItems = [];
    currentRetrieval = emptyRetrieval();
    root.hidden = true;
    root.replaceChildren();
    root.removeAttribute("data-query");
    root.setAttribute("aria-busy", "false");
    document.body.classList.remove("start-page-search-active");
    clearTypeahead();
    fisheye.clear();
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
    const focusedLink = root.contains(document.activeElement)
      ? document.activeElement.closest?.(".search-serp__result-link")
      : null;
    const focusedResultId = focusedLink?.dataset.resultId || "";
    const focusedIndex = focusedLink ? resultLinks().indexOf(focusedLink) : -1;
    const fragment = document.createDocumentFragment();
    const header = element("header", "search-serp__header");
    header.append(
      element("p", "search-serp__kicker", "Search"),
      queryHeading(query),
      element(
        "p",
        "search-serp__summary",
        summaryText(results, loading, currentRetrieval)
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
      fragment.append(emptyState(query, currentRetrieval));
    }

    fragment.append(searchHelp());
    root.replaceChildren(fragment);
    root.setAttribute("aria-busy", String(loading));
    fisheye.refresh();
    updateTypeahead(query, results);
    restoreResultFocus(focusedResultId, focusedIndex);
  }

  function updateTypeahead(query, results) {
    clearTypeahead();
    if (!connectedSearchInput || composing || connectedSearchInput.value !== query) return;
    const completion = buildTypeaheadCompletion(query, results);
    if (!completion || !typeahead.root) return;
    currentCompletion = completion;
    if (typeahead.prefix) typeahead.prefix.textContent = query;
    if (typeahead.suffix) typeahead.suffix.textContent = completion.suffix;
    typeahead.root.hidden = false;
    if (typeahead.status) {
      const source = completion.kind === "location" ? "location" : "title";
      typeahead.status.textContent = `${completion.value}, suggested ${source}. Press Tab to complete, or Right Arrow to move to results.`;
    }
    const help = root.querySelector(".search-serp__help");
    if (help) help.textContent = "Tab completes · ←→ search/results · ↑↓ move · Enter opens · Esc clears";
  }

  function clearTypeahead() {
    currentCompletion = null;
    if (typeahead.root) typeahead.root.hidden = true;
    if (typeahead.prefix) typeahead.prefix.textContent = "";
    if (typeahead.suffix) typeahead.suffix.textContent = "";
    if (typeahead.status) typeahead.status.textContent = "";
  }

  function restoreResultFocus(resultId, priorIndex) {
    if (!resultId && priorIndex < 0) return;
    const links = resultLinks();
    const sameResult = links.find(link => link.dataset.resultId === resultId);
    const fallback = priorIndex >= 0 ? links[Math.min(priorIndex, links.length - 1)] : null;
    (sameResult || fallback)?.focus({ preventScroll: true });
  }

  function resultList(results) {
    const list = element("ol", "search-serp__results");
    list.setAttribute("aria-label", "Matching saved, open, and recent pages");
    results.forEach((result, index) => {
      const item = element("li", "search-serp__result");
      item.dataset.rank = String(index + 1).padStart(2, "0");
      item.classList.toggle("search-serp__result--open", result.open);
      item.classList.toggle("search-serp__result--bookmark", result.source === "bookmark");
      item.classList.toggle("search-serp__result--tag", result.source === "tag");
      item.classList.toggle("search-serp__result--hero", shouldShowHero(result, index));
      item.append(resultLink(result, index));
      list.append(item);
    });
    return list;
  }

  function resultLink(result, index) {
    const link = element("a", "search-serp__result-link");
    link.href = result.url;
    link.dataset.resultId = result.id;
    link.dataset.verb = result.open ? "switch" : "open";
    link.setAttribute("aria-label", `${result.open ? "Switch to" : "Open"}: ${result.title}`);

    const rank = element("span", "search-serp__rank", "");
    rank.setAttribute("aria-hidden", "true");
    const visual = resultVisual(result, index);
    const copy = element("span", "search-serp__copy");
    copy.append(
      element("strong", "search-serp__title", result.title),
      element("span", "search-serp__location", displayLocation(result))
    );
    if (result.summary) {
      copy.append(element("span", "search-serp__snippet", result.summary));
    }
    const evidence = element("span", "search-serp__evidence");
    for (const item of buildSearchEvidence(result)) {
      evidence.append(evidenceToken(item.text, item.kind));
    }
    link.append(rank, visual, copy, evidence);

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

function resultsFor(query, openItems, historyItems, retrieval = {}) {
  return buildStartPageSearchResults({
    query,
    openItems,
    bookmarkItems: retrieval.bookmarkItems,
    taggedItems: retrieval.taggedItems,
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

function summaryText(results, loading, retrieval = {}) {
  const count = results.length;
  const bookmarks = results.filter(result => result.source === "bookmark").length;
  const tagged = results.filter(result => result.source === "tag").length;
  const open = results.filter(result => result.open).length;
  const history = results.filter(result => result.source === "history").length;
  if (count > 0) {
    const parts = [];
    if (bookmarks > 0) parts.push(`${bookmarks} saved ${bookmarks === 1 ? "page" : "pages"}`);
    if (tagged > 0) parts.push(`${tagged} related ${tagged === 1 ? "page" : "pages"}`);
    if (open > 0) parts.push(`${open} open now`);
    if (history > 0) parts.push(`${history} recent ${history === 1 ? "page" : "pages"}`);
    if (loading) parts.push(history > 0 ? "checking more" : "checking recent browsing");
    return parts.join(" · ");
  }
  if (loading && retrieval.historyFallback) return "Checking saved, related, and recent pages";
  if (loading) return "Checking open and recent pages";
  return "No matching pages";
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

function resultVisual(result, index) {
  if (!shouldShowHero(result, index)) return resultFavicon(result);
  const visual = element("span", "search-serp__visual");
  visual.setAttribute("aria-hidden", "true");
  const hero = element("img", "search-serp__hero");
  hero.src = result.heroImageUrl;
  hero.alt = "";
  const favicon = resultFavicon(result);
  favicon.classList.add("search-serp__favicon--overlay");
  hero.addEventListener("error", () => {
    visual.replaceWith(resultFavicon(result));
  }, { once: true });
  visual.append(hero, favicon);
  return visual;
}

function shouldShowHero(result, index) {
  return index < 3
    && Boolean(result?.heroImageUrl)
    && Number(result?.heroImageScore || 0) >= 20;
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

function emptyState(query, retrieval = {}) {
  const section = element("section", "search-serp__empty");
  section.append(
    element(
      "h2",
      "search-serp__empty-title",
      retrieval.historyFallback
        ? "No bookmark, tagged recall, or recent page matched every word"
        : "No recent page matched every word"
    ),
    element("p", "search-serp__empty-copy", `Try a title fragment, site, or URL from “${query}”.`)
  );
  return section;
}

function searchHelp() {
  const help = element("p", "search-serp__help", "←→ search/results · ↑↓ move · Enter opens · Esc clears");
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

function typeaheadElements() {
  const root = document.getElementById("tabSearchTypeahead");
  return {
    root,
    prefix: root?.querySelector("[data-typeahead-prefix]") || null,
    suffix: root?.querySelector("[data-typeahead-suffix]") || null,
    status: document.getElementById("tabSearchTypeaheadStatus")
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

function emptyRetrieval() {
  return { bookmarkItems: [], taggedItems: [], historyFallback: false };
}

function normalizeRetrieval(value) {
  return {
    bookmarkItems: array(value?.bookmarkItems),
    taggedItems: array(value?.taggedItems),
    historyFallback: Boolean(value?.historyFallback)
  };
}
