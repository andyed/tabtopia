import { debounce } from "./utility.js";
import {
    readSharedQuery,
    publishSharedQuery,
    decorateViewLinks,
    onSharedQueryChange
} from "./search-persistence.js";

export class TabSearch {
    constructor() {
        this.searchIndex = null;
        this.documentLookup = new Map();
        this.summaryLookup = new Map();
    }

    buildIndex(state) {
        // Full rebuild: the lookup must be cleared or closed tabs linger and
        // addSummaryToIndex keeps matching documents that no longer exist.
        this.documentLookup.clear();

        const documents = [];

        // Index tabs from each window
        state?.activeWindows?.forEach(window => {
            window.tabs?.forEach(tab => {
                const doc = {
                    id: `tab${tab.id}`,
                    title: tab.title || "Untitled",
                    url: tab.url || "",
                    windowId: window.id,
                    isBookmark: false,
                    data: tab
                };
                documents.push(doc);
                this.documentLookup.set(doc.id, doc);
            });
        });

        // Create Lunr index with summary field
        const builder = new lunr.Builder();

        builder.ref("id");
        builder.field("title", { boost: 10 });
        builder.field("url", { boost: 5 });
        builder.field("summary", { boost: 3 });

        // Add all documents to the builder. Summaries are keyed by the stable
        // tab id, so rebuilds (which now happen on every treemap redraw) keep
        // any AI summaries already folded in — rebuilding with "" silently
        // dropped them from the index.
        documents.forEach(doc => {
            builder.add({
                id: doc.id,
                title: doc.title || "",
                url: doc.url || "",
                summary: this.summaryLookup.get(doc.id) || ""
            });
        });

        this.searchIndex = builder.build();

        console.log("Search index built:", { documentsIndexed: documents.length });
    }

    addSummaryToIndex(url, summary) {
        if (!url || !summary) return;
        
        const doc = Array.from(this.documentLookup.values())
            .find(d => d.url === url);
            
        if (!doc) {
            console.log("No document found for URL:", url);
            return;
        }

        // Store summary in lookup
        this.summaryLookup.set(doc.id, summary);

        // Rebuild index with updated documents
        const builder = new lunr.Builder();
        
        builder.ref("id");
        builder.field("title", { boost: 10 });
        builder.field("url", { boost: 5 });
        builder.field("summary", { boost: 3 });

        // Add all documents with their current summaries
        Array.from(this.documentLookup.values()).forEach(doc => {
            builder.add({
                id: doc.id,
                title: doc.title || "",
                url: doc.url || "",
                summary: this.summaryLookup.get(doc.id) || ""
            });
        });

        this.searchIndex = builder.build();
        console.log("Added summary to index for:", doc.id);
    }

    getMatchContext(url, searchTerm) {
        if (!url || !searchTerm) return null;

        const doc = Array.from(this.documentLookup.values())
            .find(d => d.url === url);
            
        if (!doc) return null;

        const summary = this.summaryLookup.get(doc.id);
        if (!summary) return null;

        const normalizedSummary = summary.toLowerCase();
        const normalizedSearch = searchTerm.toLowerCase();
        const index = normalizedSummary.indexOf(normalizedSearch);
        
        if (index === -1) return null;

        const contextLength = 50;
        const start = Math.max(0, index - contextLength);
        const end = Math.min(summary.length, index + searchTerm.length + contextLength);
        
        return {
            summaryContext: summary.slice(start, end)
        };
    }

    search(query) {
        if (!query?.trim()) return [];
        if (!this.searchIndex) {
            console.warn("No search index available");
            return [];
        }

        console.log("Searching for:", query);

        try {
            const searchQuery = `*${query.trim()}*`;
            const results = this.searchIndex.search(searchQuery);
            
            console.log("Search results:", {
                query: searchQuery,
                resultCount: results.length,
                firstResult: results[0]
            });

            return results.map(result => {
                const doc = this.documentLookup.get(result.ref);
                const summary = this.summaryLookup.get(result.ref);
                
                const matchType = this.determineMatchType(result, query, doc);
                
                return {
                    score: result.score,
                    id: doc.id,
                    title: doc.title,
                    url: doc.url,
                    windowId: doc.windowId,
                    isBookmark: doc.isBookmark,
                    data: doc.data,
                    matchType,
                    tab: doc.data
                };
            });
        } catch (e) {
            console.warn("Search error:", e);
            return Array.from(this.documentLookup.values())
                .filter(doc => {
                    const summary = this.summaryLookup.get(doc.id);
                    const normalizedQuery = query.toLowerCase();
                    return doc.title.toLowerCase().includes(normalizedQuery) ||
                           doc.url.toLowerCase().includes(normalizedQuery) ||
                           (summary && summary.toLowerCase().includes(normalizedQuery));
                })
                .map(doc => ({
                    score: 1,
                    id: doc.id,
                    title: doc.title,
                    url: doc.url,
                    windowId: doc.windowId,
                    isBookmark: doc.isBookmark,
                    data: doc.data,
                    matchType: this.determineMatchType({ matchData: {} }, query, doc),
                    tab: doc.data
                }));
        }
    }

    determineMatchType(result, query, doc) {
        const normalizedQuery = query.toLowerCase();
        
        if (result.matchData && result.matchData.metadata) {
            const metadata = result.matchData.metadata;
            if (metadata[query] || metadata[`*${query}*`]) {
                if (metadata[query]?.title || metadata[`*${query}*`]?.title) return "direct";
                if (metadata[query]?.url || metadata[`*${query}*`]?.url) return "direct";
                if (metadata[query]?.summary || metadata[`*${query}*`]?.summary) return "summary";
            }
        }
        
        if (doc) {
            if (doc.title.toLowerCase().includes(normalizedQuery)) return "direct";
            if (doc.url.toLowerCase().includes(normalizedQuery)) return "direct";
            const summary = this.summaryLookup.get(doc.id);
            if (summary && summary.toLowerCase().includes(normalizedQuery)) return "summary";
        }
        
        return "direct";
    }
}   

export const tabSearch = new TabSearch();

// Run a query and paint the match/nomatch classes. Empty query resets cells.
export function applySearch(query) {
    if (!query) {
        clearSearchResults();
        return [];
    }
    const results = tabSearch.search(query);
    handleSearchResults(results);
    return results;
}

// Re-run whatever is in the search box against the current cells. Called after
// every treemap redraw: drawTreemap recreates all cell <g> elements, which
// silently dropped the search filter even though the box still held the query
// (the same class of bug as the pinned-selection loss, fixed the same way).
export function reapplySearch() {
    const searchInput = document.getElementById("tabSearch");
    const query = searchInput?.value.trim();
    if (query) {
        applySearch(query);
    }
}

// Index of the currently arrow-key-selected match, reset whenever the query changes.
let matchCycleIndex = -1;

function cycleSearchMatches(direction) {
    const matches = d3.selectAll(".cell-search-match").nodes();
    if (!matches.length) return;

    matchCycleIndex = direction === "next"
        ? (matchCycleIndex + 1) % matches.length
        : (matchCycleIndex - 1 + matches.length) % matches.length;

    const cell = matches[matchCycleIndex];
    cell.scrollIntoView({ behavior: "smooth", block: "center" });
    d3.selectAll(".cell-search-match").classed("cell-selected", false);
    d3.select(cell).classed("cell-selected", true);
}

// Single authoritative wiring for the #tabSearch box. newtab.js, readout.js and
// this module each used to attach their own competing input handlers — all
// search UI behavior now lives here.
export function initializeSearch() {
    const searchInput = document.getElementById("tabSearch");

    if (!searchInput) {
        console.error("Search input element not found!");
        return;
    }

    // Restore the carried query — URL ?q= (view switch) wins over session storage
    // (fresh newtab). The filter itself is applied by reapplySearch() at the
    // end of the first drawTreemap — no cells exist yet. Decorate the header
    // links immediately so a view switch right after load carries it too.
    const initialQuery = readSharedQuery();
    searchInput.value = initialQuery;
    decorateViewLinks(initialQuery.trim());

    // Publish synchronously on every keystroke (a debounced publish can lose
    // the query if a view switch or new tab happens inside the debounce
    // window); debounce only the search + repaint.
    searchInput.addEventListener("input", (event) => {
        publishSharedQuery(event.target.value.trim());
    });

    searchInput.addEventListener("input", debounce((event) => {
        matchCycleIndex = -1;
        applySearch(event.target.value.trim());
    }, 200));

    searchInput.addEventListener("keydown", (event) => {
        switch (event.key) {
            case "Enter":
                event.preventDefault();
                focusFirstSearchResult();
                break;
            case "Tab":
                event.preventDefault();
                focusFirstSearchResult();
                break;
            case "ArrowDown":
                event.preventDefault();
                cycleSearchMatches("next");
                break;
            case "ArrowUp":
                event.preventDefault();
                cycleSearchMatches("prev");
                break;
            case "Escape":
                event.preventDefault();
                exitSearchMode();
                break;
        }
    });

    // Live-sync from other open views: typing (or Escape) in another newtab or
    // view updates this one. Fires only in documents that didn't do the write.
    onSharedQueryChange((query) => {
        searchInput.value = query;
        matchCycleIndex = -1;
        applySearch(query.trim());
        decorateViewLinks(query.trim());
    });

    console.log("Search initialization complete");
}

function focusFirstSearchResult() {
    console.log("Attempting to focus first search result");
    
    const firstResult = d3.select(".cell-search-match").node();
    console.log("First result found:", !!firstResult);
    
    if (firstResult) {
        const nodeData = d3.select(firstResult).datum();
        console.log("First result data:", nodeData?.data);
        
        d3.selectAll(".cell").classed("cell-selected", false);
        d3.select(firstResult).classed("cell-selected", true);
        
        firstResult.setAttribute("tabindex", "0");
        firstResult.focus();
        
        if (nodeData && nodeData.data) {
            console.log("Activating tab/bookmark from search result");
            
            if (nodeData.data.isBookmark) {
                console.log("Opening bookmark in new tab:", nodeData.data.url);
                chrome.tabs.create({
                    url: nodeData.data.url,
                    active: true
                });
            } else {
                let windowId = typeof nodeData.data.windowId === "number" ? 
                    nodeData.data.windowId : parseInt(nodeData.data.windowId, 10);
                let tabId = typeof nodeData.data.id === "number" ? 
                    nodeData.data.id : parseInt(nodeData.data.id.replace(/\D/g, ""), 10);
                
                console.log("Activating tab:", tabId, "in window:", windowId);
                
                chrome.windows.update(windowId, { focused: true }, () => {
                    if (chrome.runtime.lastError) {
                        console.error("Error focusing window:", chrome.runtime.lastError);
                        return;
                    }
                    
                    chrome.tabs.update(tabId, { active: true }, () => {
                        if (chrome.runtime.lastError) {
                            console.error("Error activating tab:", chrome.runtime.lastError);
                        }
                    });
                });
            }
        }
    } else {
        console.log("No search match found, focusing treemap");
        const treemap = document.getElementById("treemap");
        if (treemap) {
            treemap.setAttribute("tabindex", "0"); 
            treemap.focus();
        }
    }
}

export function exitSearchMode() {
    const searchInput = document.getElementById("tabSearch");
    if (searchInput) {
        searchInput.value = "";
        searchInput.blur();
    }
    publishSharedQuery("");
    matchCycleIndex = -1;
    clearSearchResults();
}

export function handleSearchResults(results) {
    console.log("Processing search results:", results.length);

    d3.selectAll(".cell")
        .classed("cell-search-match", d => {
            const isMatch = results.some(r => r.id === d.data.id);
            if (isMatch) {
                d.searchData = results.find(r => r.id === d.data.id);
            }
            return isMatch;
        })
        .classed("cell-search-nomatch", d => !results.some(r => r.id === d.data.id))
        .style("opacity", d => results.some(r => r.id === d.data.id) ? 1 : 0.3);

    updateSearchTabOrder(results);
}

function updateSearchTabOrder(results) {
    const searchOrder = results.map(r => r.id);
    d3.selectAll(".cell")
        .attr("tabindex", d => {
            const index = searchOrder.indexOf(d.data.id);
            return index >= 0 ? 0 : -1;
        });
}

export function clearSearchResults() {
    d3.selectAll(".cell")
        .style("opacity", 1)
        .classed("cell-search-match", false)
        .classed("cell-search-nomatch", false)
        .classed("cell-selected", false)
        .style("transition", "opacity 0.2s ease-in-out");
}