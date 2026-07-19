console.log("graph.js loaded");

import { createForceGraph } from "./graph-renderer.js";
import { getDomainFromUrl, getFaviconUrl } from "./utility.js";
import { browserState } from "./state.js";
import { getRecentHistory } from "../lib/history-cache.js";
import {
    readSharedQuery,
    publishSharedQuery,
    decorateViewLinks,
    onSharedQueryChange
} from "./search-persistence.js";

// Graph visualization data
let nodes = [];
let links = [];
let simulation;
let svg;
let zoom;
let timeScale; // Add timeScale as a global variable
let width, height; // Add near the top of your file with other globals

// State tracking
let currentlyOpenTabs = new Map();
let bookmarkedUrls = new Set();
let filterState = "all";  // 'all', 'active', 'bookmarks'
let currentViewMode = "time"; // 'time' or 'domain'

// Initialize the visualization
async function init() {
    // Show loading indicator
    document.getElementById("graph").innerHTML =
        "<div class=\"loading\"><div class=\"spinner\"></div>Loading your browsing data...</div>";

    try {
        // These sources are independent. Starting them together matters on a
        // cold extension load: storage, History, windows, and bookmarks should
        // not form a serial waterfall before the first graph paint.
        const [cachedGraphData, historyItems, windows, bookmarks] = await Promise.all([
            getGraphData(),
            getRecentHistory({ text: "", maxResults: 200, startTime: Date.now() - 7 * 24 * 60 * 60 * 1000 }),
            chrome.windows.getAll({ populate: true }),
            fetchBookmarks()
        ]);

        // Track currently open tabs
        windows.forEach(window => {
            if (window.tabs) {
                window.tabs.forEach(tab => {
                    currentlyOpenTabs.set(tab.id, tab);
                });
            }
        });

        // Process data with cached positions
        await processHistoryData(historyItems, bookmarks, windows);

        // Restore summaries from cache
        if (Object.keys(cachedGraphData.summaries).length > 0) {
            for (const [url, summary] of Object.entries(cachedGraphData.summaries)) {
                const node = nodes.find(n => n.url === url);
                if (node) {
                    node.summary = summary;
                }
            }
        }

        // Add custom edges
        if (cachedGraphData.customEdges.length > 0) {
            addCustomEdges(cachedGraphData.customEdges);
        }

        // Restore saved node positions so the layout doesn't re-converge from scratch.
        // storeNodePositions() writes { x, y, fixed } per nodeId every 30s while
        // alpha < 0.1; without this restore step the data was being written and
        // never read.
        if (cachedGraphData.nodePositions && Object.keys(cachedGraphData.nodePositions).length > 0) {
            let restored = 0;
            nodes.forEach(node => {
                const saved = cachedGraphData.nodePositions[node.id];
                if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
                    node.x = saved.x;
                    node.y = saved.y;
                    if (saved.fixed) {
                        node.fx = saved.x;
                        node.fy = saved.y;
                    }
                    restored++;
                }
            });
            console.log(`Restored positions for ${restored} of ${nodes.length} nodes`);
        }

        // Create the visualization
        // Create a synthetic session object for the main graph view
        const graphSession = { id: "main-graph" };
        const graphResult = createForceGraph(document.getElementById("graph"), nodes, links, graphSession, currentViewMode);

        // Store the simulation reference for later use
        if (graphResult) {
            simulation = graphResult.simulation;
            svg = graphResult.svg;
        }

        // Periodically save node positions
        const positionSaveInterval = setInterval(() => {
            // Only save if simulation has stabilized
            if (simulation && simulation.alpha() < 0.1) {
                storeNodePositions(nodes);
            }
        }, 30000);

        // Add this cleanup to avoid memory leaks when the page is unloaded
        window.addEventListener("unload", () => {
            clearInterval(positionSaveInterval);
            // Save one last time when leaving
            if (simulation && nodes.length > 0) {
                storeNodePositions(nodes);
            }
        });

    } catch (error) {
        console.error("Failed to initialize graph:", error);
        document.getElementById("graph").innerHTML =
            `<div class="error">Error loading graph visualization: ${error.message}</div>`;
    }
}

async function fetchBookmarks() {
    return new Promise((resolve) => {
        chrome.bookmarks.getTree(function (bookmarkTreeNodes) {
            const bookmarks = [];

            function processNode(node) {
                if (node.url) {
                    bookmarks.push({
                        id: node.id,
                        title: node.title,
                        url: node.url,
                        dateAdded: node.dateAdded
                    });
                    bookmarkedUrls.add(node.url);
                }

                if (node.children) {
                    node.children.forEach(processNode);
                }
            }

            bookmarkTreeNodes.forEach(processNode);
            resolve(bookmarks);
        });
    });
}

async function processHistoryData(historyItems, bookmarks, windows) {
    console.log("Processing history data:", { historyItems, bookmarks, windows });
    const state = await browserState.getState();
    console.log("Received state:", state);
    const tabHistory = state.tabHistory;
    const tabRelationships = state.tabRelationships;
    // Create nodes map to avoid duplicates
    const nodesMap = new Map();

    // Limit history items to 300 most recent
    if (historyItems.length > 300) {
        console.log(`Limiting visualization to 300 most recent items out of ${historyItems.length}`);
        historyItems = historyItems
            .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
            .slice(0, 300);
    }

    // Process history items
    historyItems.forEach(item => {
        const domain = getDomainFromUrl(item.url);
        if (!domain) return;

        // Add node if not exists
        if (!nodesMap.has(item.url)) {
            nodesMap.set(item.url, {
                id: item.url,
                title: item.title,
                url: item.url,
                domain: domain,
                visitCount: item.visitCount,
                lastVisitTime: item.lastVisitTime,
                type: bookmarkedUrls.has(item.url) ? "bookmark" : "history",
                isActive: Array.from(currentlyOpenTabs.values()).some(tab => tab.url === item.url)
            });
        }
    });

    // Add currently open tabs if not in history
    currentlyOpenTabs.forEach(tab => {
        if (tab.url && !nodesMap.has(tab.url)) {
            const domain = getDomainFromUrl(tab.url);
            if (!domain) return;

            nodesMap.set(tab.url, {
                id: tab.url,
                title: tab.title,
                url: tab.url,
                domain: domain,
                visitCount: 1,
                lastVisitTime: Date.now(),
                type: bookmarkedUrls.has(tab.url) ? "bookmark" : "history",
                isActive: true
            });
        } else if (tab.url) {
            // Mark existing node as active
            const node = nodesMap.get(tab.url);
            if (node) {
                node.isActive = true;
            }
        }
    });

    // Convert nodes map to array
    nodes = Array.from(nodesMap.values());

    // Track edge sources to avoid duplicates
    const edgeMap = new Map();

    // 1. Create edges based on browser navigation data (highest confidence)
    if (tabHistory) {
        // tabHistory arrives as a Map from browserState.getState(); Object.entries
        // on a Map is always [] — so the highest-confidence referer/redirect edges
        // never built. Iterate whichever shape we actually get.
        const historyEntries = tabHistory instanceof Map ? tabHistory : Object.entries(tabHistory);
        for (const [tabId, history] of historyEntries) {
            for (const nav of history) {
                if (nav.referer) {
                    const sourceNode = nodes.find(n => n.url === nav.referer);
                    const targetNode = nodes.find(n => n.url === nav.url);

                    if (sourceNode && targetNode) {
                        const edgeId = `${sourceNode.id}-${targetNode.id}`;
                        if (!edgeMap.has(edgeId)) {
                            edgeMap.set(edgeId, {
                                source: sourceNode.id,
                                target: targetNode.id,
                                type: "navigation",
                                transitionType: nav.transitionType || "link",
                                strength: 0.8,  // Highest strength for referrer navigations
                                visible: true
                            });
                        }
                    }
                }

                if (nav.redirects) {
                    let lastUrl = nav.referer;
                    for (const redirect of nav.redirects) {
                        const sourceNode = nodes.find(n => n.url === lastUrl);
                        const targetNode = nodes.find(n => n.url === redirect.url);

                        if (sourceNode && targetNode) {
                            const edgeId = `${sourceNode.id}-${targetNode.id}`;
                            if (!edgeMap.has(edgeId)) {
                                edgeMap.set(edgeId, {
                                    source: sourceNode.id,
                                    target: targetNode.id,
                                    type: "redirect",
                                    strength: 0.9,  // Very high strength for redirects
                                    visible: true
                                });
                            }
                        }
                        lastUrl = redirect.url;
                    }
                }
            }
        }
    }

    // 2. Create edges based on window/tab parent relationships (high confidence)
    windows.forEach(window => {
        if (window.tabs && window.tabs.length > 0) {
            // Find tabs that were opened from other tabs (opener relationship)
            window.tabs.forEach(tab => {
                if (tab.openerTabId) {
                    const opener = window.tabs.find(t => t.id === tab.openerTabId);
                    if (opener) {
                        const sourceNode = nodes.find(n => n.url === opener.url);
                        const targetNode = nodes.find(n => n.url === tab.url);

                        if (sourceNode && targetNode) {
                            const edgeId = `${sourceNode.id}-${targetNode.id}`;
                            if (!edgeMap.has(edgeId)) {
                                edgeMap.set(edgeId, {
                                    source: sourceNode.id,
                                    target: targetNode.id,
                                    type: "opener",
                                    strength: 0.5,  // Strong connection
                                    visible: true
                                });
                            }
                        }
                    }
                }
            });
        }
    });

    // 3. Add bookmark relationships (medium confidence)
    // Connect bookmarks with their non-bookmark variants
    nodes.forEach(node => {
        if (node.type === "bookmark") {
            // Find non-bookmark version of the same URL
            const nonBookmarkVersion = nodes.find(n =>
                n.url === node.url && n.type !== "bookmark");

            if (nonBookmarkVersion) {
                const edgeId = `${node.id}-${nonBookmarkVersion.id}`;
                if (!edgeMap.has(edgeId)) {
                    edgeMap.set(edgeId, {
                        source: node.id,
                        target: nonBookmarkVersion.id,
                        type: "bookmark-relation",
                        strength: 0.4,
                        visible: true
                    });
                }
            }
        }
    });

    // 4. Add temporal sequence edges only as fallback (lower confidence)
    // But be more restrictive with them
    const sortedNodes = [...nodes].sort((a, b) => a.lastVisitTime - b.lastVisitTime);
    const timeThreshold = 2 * 60 * 1000; // 2 minutes

    for (let i = 0; i < sortedNodes.length - 1; i++) {
        const current = sortedNodes[i];
        const next = sortedNodes[i + 1];

        if (next.lastVisitTime - current.lastVisitTime < timeThreshold) {
            const edgeId = `${current.id}-${next.id}`;
            if (!edgeMap.has(edgeId)) {
                edgeMap.set(edgeId, {
                    source: current.id,
                    target: next.id,
                    type: "sequence",
                    strength: 0.2, // Lower strength for time-based edges
                    visible: true
                });
            }
        }
    }

    // Convert edges map to array
    links = Array.from(edgeMap.values());
    console.log("Processed data:", { nodes, links });
}

console.log("Adding DOMContentLoaded listener");
document.addEventListener("DOMContentLoaded", () => {
    init();

    // The graph view has no search filter (yet), but it must not DROP the
    // query while the user passes through: seed the box, keep the header
    // links carrying it, and publish edits onward.
    const searchInput = document.getElementById("tabSearch");
    const initialQuery = readSharedQuery();
    if (searchInput) {
        searchInput.value = initialQuery;
        searchInput.addEventListener("input", (event) => {
            publishSharedQuery(event.target.value.trim());
        });
    }
    decorateViewLinks(initialQuery.trim());
    onSharedQueryChange((query) => {
        if (searchInput) searchInput.value = query;
        decorateViewLinks(query.trim());
    });

    // Add view mode toggle listeners
    const timeViewBtn = document.getElementById("timeViewBtn");
    const domainViewBtn = document.getElementById("domainViewBtn");

    if (timeViewBtn && domainViewBtn) {
        timeViewBtn.addEventListener("click", () => {
            currentViewMode = "time";
            timeViewBtn.classList.add("active");
            domainViewBtn.classList.remove("active");

            // Recreate the graph with new view mode
            const graphSession = { id: "main-graph" };
            const graphResult = createForceGraph(
                document.getElementById("graph"),
                nodes,
                links,
                graphSession,
                currentViewMode
            );

            if (graphResult) {
                simulation = graphResult.simulation;
                svg = graphResult.svg;
            }
        });

        domainViewBtn.addEventListener("click", () => {
            currentViewMode = "domain";
            domainViewBtn.classList.add("active");
            timeViewBtn.classList.remove("active");

            // Recreate the graph with new view mode
            const graphSession = { id: "main-graph" };
            const graphResult = createForceGraph(
                document.getElementById("graph"),
                nodes,
                links,
                graphSession,
                currentViewMode
            );

            if (graphResult) {
                simulation = graphResult.simulation;
                svg = graphResult.svg;
            }
        });
    }
});

// Add this helper function in graph.js to handle the storage operations
async function getGraphData() {
    return new Promise((resolve) => {
        chrome.storage.local.get("graphPersistentData", (result) => {
            resolve(result.graphPersistentData || {
                summaries: {},
                customEdges: [],
                nodePositions: {},
                lastUpdated: null
            });
        });
    });
}

// Add this helper function for storing positions
async function storeNodePositions(nodes) {
    try {
        // Get existing data
        const data = await getGraphData();
        const nodePositions = {};

        // Save current node positions
        nodes.forEach(node => {
            if (node.id && (node.x !== undefined && node.y !== undefined)) {
                nodePositions[node.id] = {
                    x: node.x,
                    y: node.y,
                    fixed: node.fx !== null || node.fy !== null
                };
            }
        });

        data.nodePositions = nodePositions;
        data.lastUpdated = Date.now();

        // Save to storage
        chrome.storage.local.set({ "graphPersistentData": data });
        console.log(`Saved positions for ${Object.keys(nodePositions).length} nodes`);
    } catch (e) {
        console.warn("Error saving node positions:", e);
    }
}

function addCustomEdges(customEdges) {
    if (!customEdges) return;
    customEdges.forEach(edge => {
        const sourceNode = nodes.find(n => n.url === edge.source);
        const targetNode = nodes.find(n => n.url === edge.target);
        if (sourceNode && targetNode) {
            links.push({
                source: sourceNode.id,
                target: targetNode.id,
                type: edge.type || "custom",
                strength: edge.strength || 0.5,
                visible: true
            });
        }
    });
}
