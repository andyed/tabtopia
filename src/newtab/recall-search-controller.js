import { createSearchSerp } from "./search-serp.js";
import { loadRecallSearchSources } from "./recall-search-sources.js";
import {
  readSharedQuery,
  publishSharedQuery,
  decorateViewLinks,
  onSharedQueryChange
} from "./search-persistence.js";

/**
 * Give a standalone top-level view the canonical recall SERP interaction.
 * Main and Stars retain their local visual filtering and call the same SERP
 * directly; Graph and Sessions use this controller because they have no local
 * result surface to preserve.
 */
export function createRecallSearchController({
  input,
  root = document.getElementById("startPageSearch"),
  loadSources = loadRecallSearchSources
} = {}) {
  const serp = createSearchSerp(root);
  let sources = emptySources();
  let searchTimer = null;
  let initialized = false;

  function run(rawQuery) {
    const query = String(rawQuery || "").trim();
    decorateViewLinks(query);
    if (!query) {
      serp.clear();
      return Promise.resolve([]);
    }
    return serp.update(query, sources.openItems, sources);
  }

  function clear() {
    if (input) input.value = "";
    publishSharedQuery("");
    run("");
    input?.focus();
  }

  function init() {
    if (initialized || !input) return Promise.resolve(sources);
    initialized = true;
    const initialQuery = readSharedQuery();
    input.value = initialQuery;
    serp.connectSearchInput(input, clear);
    run(initialQuery);

    input.addEventListener("input", event => {
      const query = event.target.value.trim();
      publishSharedQuery(query);
      decorateViewLinks(query);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => run(query), 120);
    });

    input.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        clear();
      } else if (event.key === "Enter") {
        if (serp.activateFirst()) event.preventDefault();
      } else if (event.key === "Tab") {
        if (serp.focusFirst()) event.preventDefault();
      }
    });

    onSharedQueryChange(query => {
      input.value = query;
      clearTimeout(searchTimer);
      run(query);
    });

    return loadSources().then(loaded => {
      sources = { ...emptySources(), ...loaded, historyFallback: true };
      if (input.value.trim()) run(input.value);
      return sources;
    }).catch(error => {
      console.warn("[Recall Search] shared sources unavailable", error);
      return sources;
    });
  }

  return { init, run, clear, serp };
}

function emptySources() {
  return {
    openItems: [],
    bookmarkItems: [],
    taggedItems: [],
    summaryRecords: {},
    heroImageRecords: {},
    historyFallback: false
  };
}
