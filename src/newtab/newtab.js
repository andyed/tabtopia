import { getFaviconUrl, formatUrl, abbreviateTitle } from "./utility.js";
import { updateStats } from "./stats.js";
import { showDefaultReadout, loadNanoSummariesFromStorage } from "./readout.js";
import { initializeApp } from "./init.js";
import { tabSearch, initializeSearch } from "./search.js";
import { drawTreemap } from "./treemap.js";

// Legacy stubs removed.
async function fetchRecentBookmarks(count) {
    return new Promise(resolve => {
        chrome.bookmarks.getRecent(count || 4, resolve);
    });
}
function createTreemapData(stateObj) {
    return {
        name: "root",
        children: (stateObj?.activeWindows || []).map(window => ({
            name: `Window ${window.id}`,
            id: window.id,
            children: (window.tabs || []).map(tab => ({
                id: `tab${tab.id}`,
                windowId: window.id,
                title: tab.title || "Untitled",
                url: tab.url || "",
                favIconUrl: tab.favIconUrl,
                lastAccessed: tab.lastAccessed || Date.now(),
                timeSpent: tab.totalTimeSpent || 100,
                isBookmark: false,
                children: []
            }))
        }))
    };
}

const HISTORY_RESULTS_LIMIT = 20;
const MICROS_SESSION_TIMEOUT = 2 * 60 * 1000; // 2 minutes in milliseconds
const UPDATE_INTERVAL = 120000; // 2 minutes in milliseconds
let updateTimer = null;
let lastUpdate = Date.now();
let tabEdges = new Map(); // Track edges between tabs

// Add new tracking constants
const TAB_ACTIVITY = {
    ACTIVE_THRESHOLD: 1000, // minimum ms to count as active time
    IDLE_THRESHOLD: 300000  // 5 minutes without interaction = idle
};

// Add tab activity tracking
let tabActivityLog = new Map(); // Track tab activity periods
let navigationEvents = new Map();

let inactivityTimer = null;
const INACTIVITY_TIMEOUT = 5000; // 5 seconds

let categorizedDataCache = null;
let currentData = null;

// Signature of the windows/tabs last painted by the live-update path
// (refreshTreemapState). Lets that path skip redundant repaints — most notably
// the new-tab page's OWN load event, which fires onUpdated right after first
// paint and otherwise forces a full redundant redraw on every boot.
let lastTreemapSignature = null;
function treemapSignature(activeWindows) {
    if (!Array.isArray(activeWindows)) return "";
    return activeWindows
        .map(w => `${w.id}:` + (w.tabs || [])
            .map(t => `${t.id}|${t.active ? 1 : 0}|${t.url || ""}|${t.title || ""}`)
            .join(","))
        .join(";");
}

// Define treemapState at the top of your file or in an appropriate scope
const treemapState = {
    data: null,
    linkTextCache: {},
    needsBookmarks: false,
    getTotalTabs: function () {
        return this.data?.activeWindows?.reduce((sum, w) => sum + w.tabs.length, 0) || 0;
    }
};

function resetInactivityTimer(categorizedData) {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
        // A stationary pointer is still an active hover. Do not replace the
        // domain context with the idle panel just because mousemove stopped.
        if (document.querySelector("#treemap .node-focused") ||
            document.getElementById("readout")?.classList.contains("sticky")) {
            return;
        }
        showDefaultReadout(categorizedData);
    }, INACTIVITY_TIMEOUT);
}

// Add throttled mousemove listener to the document
let lastMouseMove = 0;
document.addEventListener("mousemove", () => {
    const now = Date.now();
    if (now - lastMouseMove > 500) {
        lastMouseMove = now;
        const isPinned = document.getElementById("readout")?.classList.contains("sticky");
        if (categorizedDataCache && !isPinned) {
            resetInactivityTimer(categorizedDataCache);
        } else if (isPinned) {
            clearTimeout(inactivityTimer);
        }
    }
});

function categorizeData(history, windows) {
    const activeWindows = windows.map(window => ({
        id: window.id,
        focused: window.focused,
        tabs: window.tabs.map(tab => ({
            id: tab.id,
            windowId: tab.windowId,
            url: tab.url,
            title: tab.title,
            active: tab.active,
            favIconUrl: tab.favIconUrl,
            lastAccessed: tab.lastAccessed
        }))
    }));

    const windowSwimlanes = {};
    activeWindows.forEach(window => {
        windowSwimlanes[window.id] = window.tabs;
    });

    const historySwimlane = history.map(entry => ({
        id: entry.id,
        url: entry.url,
        title: entry.title,
        lastVisitTime: entry.lastVisitTime,
        visitCount: entry.visitCount
    }));

    const tabsCount = activeWindows.map(window => window.tabs.length);

    return {
        activeWindows,
        windowSwimlanes,
        historySwimlane,
        tabsCount
    };
}

document.addEventListener("DOMContentLoaded", async () => {
    try {
        // Boot from open windows/tabs only. The treemap, search index, and
        // default readout all read `activeWindows` exclusively — the previous
        // full-history fetch (maxResults: 10000, startTime: 0) built a
        // `historySwimlane` that nothing on this path renders or indexes, so it
        // was pure latency on every new tab. Dropped.
        const windows = await chrome.windows.getAll({ populate: true });

        categorizedDataCache = categorizeData([], windows);
        currentData = categorizedDataCache;

        // Initialize search index
        tabSearch.buildIndex(categorizedDataCache);

        // Single authoritative search wiring (input, keyboard nav, persistence,
        // cross-newtab sync) — lives in search.js. The persisted query is
        // restored into the box here; the filter itself is applied by
        // reapplySearch() at the end of drawTreemap below.
        initializeSearch();

        // Hydrate the parser-painted context rail immediately. Bookmark IO is
        // asynchronous and independent of the SVG layout, so it should begin
        // before drawTreemap's synchronous label measurement work.
        showDefaultReadout(categorizedDataCache);

        // Initialize visualizations
        if (categorizedDataCache?.activeWindows) {
            await drawTreemap(categorizedDataCache);

            // Seed the live-update store from the same data we just painted, and
            // record its signature. This stops the onUpdated handler from seeing
            // an empty `state` on the new tab's own load — which used to force a
            // full window-count-mismatch rebuild + a redundant second paint.
            state.activeWindows = categorizedDataCache.activeWindows.map(
                w => ({ ...w, tabs: (w.tabs || []).map(t => ({ ...t })) })
            );
            lastTreemapSignature = treemapSignature(state.activeWindows);

            // Start inactivity timer only if we have data
            if (!document.querySelector(".cell-selected")) {
                resetInactivityTimer(categorizedDataCache);
            }

            // First paint done. Hydrate the AI summary cache off the critical
            // path — summaries are only consumed by the hover readout, never by
            // first paint, so this must not be awaited before drawTreemap.
            loadNanoSummariesFromStorage();
        } else {
            console.error("Invalid data structure:", categorizedDataCache);
        }
    } catch (error) {
        console.error("Error initializing page:", error);
    }
});

async function fetchHistoryData(limit, startTime) {
    return new Promise((resolve) => {
        chrome.history.search(
            {
                text: "",
                maxResults: limit,
                startTime: startTime || Date.now() - (24 * 60 * 60 * 1000) // Last 24 hours
            },
            (historyItems) => {
                // Get visits for each history item to get more details
                Promise.all(historyItems.map(item =>
                    new Promise(resolveVisits => {
                        chrome.history.getVisits({ url: item.url }, visits => {
                            // Get the most recent visit
                            const latestVisit = visits[visits.length - 1];
                            resolveVisits({
                                ...item,
                                visits: visits,
                                tabId: latestVisit?.tabId,
                                windowId: latestVisit?.windowId,
                                transitionType: latestVisit?.transition, // Add transition type
                                transitionQualifiers: latestVisit?.transitionQualifiers, // Add qualifiers
                                referrer: latestVisit?.referringVisit ?
                                    visits.find(v => v.visitId === latestVisit.referringVisit)?.url :
                                    null
                            });
                        });
                    })
                )).then(detailedHistoryItems => {
                    console.log("Detailed history items with transitions:", detailedHistoryItems);
                    resolve(detailedHistoryItems);
                });
            }
        );
    });
}

// Modify fetchActiveWindowsAndTabs to include time tracking
async function fetchActiveWindowsAndTabs() {
    return new Promise((resolve) => {
        chrome.windows.getAll({ populate: true }, async (windows) => {
            const activeWindows = await Promise.all(windows.map(async window => ({
                id: window.id,
                focused: window.focused,
                tabs: await Promise.all(window.tabs.map(async tab => {
                    // Get stored activity data
                    const storedActivity = await chrome.storage.local.get(`tab_${tab.id}`);
                    const activity = storedActivity[`tab_${tab.id}`] || {
                        totalTimeSpent: 0,
                        lastTouch: tab.active ? Date.now() : null,
                        firstSeen: Date.now()
                    };

                    // Update if tab is active
                    if (tab.active) {
                        const now = Date.now();
                        if (activity.lastTouch) {
                            activity.totalTimeSpent += (now - activity.lastTouch);
                        }
                        activity.lastTouch = now;
                        // Store updated activity
                        await chrome.storage.local.set({
                            [`tab_${tab.id}`]: activity
                        });
                    }

                    return {
                        id: tab.id,
                        windowId: window.id,
                        url: tab.url,
                        title: tab.title,
                        active: tab.active,
                        favIconUrl: tab.favIconUrl,
                        lastAccessed: tab.lastAccessed,
                        totalTimeSpent: activity.totalTimeSpent,
                        lastTouch: activity.lastTouch,
                        firstSeen: activity.firstSeen
                    };
                }))
            })));

            console.log("Active windows and tabs with time spent:", activeWindows);
            resolve(activeWindows);
        });
    });
}

function categorizeHistoryData(data) {
    const { history = [], activeWindowsAndTabs = [] } = data;
    const activeTabs = new Map();
    const historySwimlane = [];
    const windowSwimlanes = {};
    const edges = []; // Initialize edges array

    // First, initialize windowSwimlanes with active tabs
    activeWindowsAndTabs.forEach(window => {
        // Initialize array for this window's tabs
        windowSwimlanes[window.id] = [];

        // Add current tabs to the window's swimlane
        window.tabs.forEach(tab => {
            const activity = tabActivityLog.get(tab.id) || {
                totalTimeSpent: 0,
                lastTouch: tab.active ? Date.now() : null,
                firstSeen: Date.now()
            };

            windowSwimlanes[window.id].push({
                id: tab.id,
                url: tab.url,
                title: tab.title,
                active: tab.active,
                favIconUrl: tab.favIconUrl,
                lastAccessed: tab.lastAccessed,
                windowId: window.id,
                isCurrentTab: true,
                totalTimeSpent: activity.totalTimeSpent,
                lastTouch: activity.lastTouch,
                firstSeen: activity.firstSeen
            });

            // Store reference for history matching
            activeTabs.set(tab.id, { windowId: window.id, tab });
        });
    });

    // Then categorize history items
    history.forEach(item => {
        const activeTab = activeTabs.get(item.id);

        if (item.windowId && windowSwimlanes[item.windowId]) {
            // If we know the window ID and it exists, add to that window
            windowSwimlanes[item.windowId].push({
                ...item,
                isHistoryItem: true
            });
        } else if (activeTab) {
            // If we found a matching active tab, add to its window
            windowSwimlanes[activeTab.windowId].push({
                ...item,
                windowId: activeTab.windowId,
                isHistoryItem: true
            });
        } else {
            // Otherwise, add to history swimlane
            historySwimlane.push(item);
        }
    });

    // Debug output
    console.log("Categorized Data:", {
        activeWindows: activeWindowsAndTabs,
        windowSwimlanes,
        historySwimlane,
        tabsCount: Object.entries(windowSwimlanes).map(([id, tabs]) => ({
            windowId: id,
            activeTabsCount: tabs.filter(t => t.isCurrentTab).length,
            historyItemsCount: tabs.filter(t => t.isHistoryItem).length
        }))
    });

    return {
        historySwimlane,
        windowSwimlanes,
        activeWindowsAndTabs,
        edges, // Add edges to returned data structure
        totalEdges: 0,
        nodesWithEdges: new Set()
    };
}

function createMicrosessions(history) {
    const microsessions = [];
    let currentSession = [];
    let lastVisitTime = null;

    history.forEach(item => {
        if (lastVisitTime && (item.lastVisitTime - lastVisitTime > MICROS_SESSION_TIMEOUT)) {
            microsessions.push(currentSession);
            currentSession = [];
        }
        currentSession.push(item);
        lastVisitTime = item.lastVisitTime;
    });

    if (currentSession.length > 0) {
        microsessions.push(currentSession);
    }

    return microsessions;
}

function displayStats(data, sessionCount) {
    const { historySwimlane, windowSwimlanes, totalEdges, nodesWithEdges } = data;
    const totalHistoryItems = historySwimlane.length + Object.values(windowSwimlanes).reduce((acc, items) => acc + items.length, 0);
    const totalActiveTabs = Object.values(windowSwimlanes).reduce((acc, items) => acc + items.length, 0);
    const averageEdgesConnected = (nodesWithEdges / totalHistoryItems) * 100;

    document.getElementById("total-history-items").textContent = `Total History Items: ${totalHistoryItems}`;
    document.getElementById("total-active-tabs").textContent = `Total Active Tabs: ${totalActiveTabs}`;
    document.getElementById("total-edges").textContent = `Total Edges: ${totalEdges}`;
    document.getElementById("average-edges-connected").textContent = `Average % of Nodes with Edges: ${averageEdgesConnected.toFixed(2)}%`;
    document.getElementById("total-sessions").textContent = `Total Sessions: ${sessionCount}`;
}

function updateReadoutText(text) {
    const readout = document.getElementById("readout");
    if (readout) {
        readout.textContent = text;
    }
}

// Add navigation event listeners
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.url) {
        console.log("Tab updated:", tab); // Debug
        updateTimelineWithNavigation(tab);

        const window = state.activeWindows.find(w => w.id === tab.windowId);
        if (window) {
            const tabIndex = window.tabs.findIndex(t => t.id === tabId);
            if (tabIndex !== -1) {
                window.tabs[tabIndex] = {
                    ...window.tabs[tabIndex],
                    ...tab,
                    lastAccessed: Date.now()
                };
            } else {
                // Add the tab if it doesn't exist
                window.tabs.push({
                    id: tabId,
                    windowId: tab.windowId,
                    url: tab.url,
                    title: tab.title,
                    active: tab.active,
                    favIconUrl: tab.favIconUrl,
                    lastAccessed: Date.now()
                });
            }
            refreshTreemapState({ activeWindows: state.activeWindows });
        } else {
            // Add the window if it doesn't exist
            state.activeWindows.push({
                id: tab.windowId,
                focused: false,
                tabs: [{
                    id: tabId,
                    windowId: tab.windowId,
                    url: tab.url,
                    title: tab.title,
                    active: tab.active,
                    favIconUrl: tab.favIconUrl,
                    lastAccessed: Date.now()
                }]
            });
            refreshTreemapState({ activeWindows: state.activeWindows });
        }
    }
});

async function updateTimelineWithNavigation(tab) {
    try {
        if (!currentData) {
            // If no current data, reinitialize
            await initializeApp();
            return;
        }
        console.log("Updating timeline with navigation:", tab); // Debug

        const newNavigation = {
            url: tab.url,
            title: tab.title,
            lastVisitTime: Date.now(),
            windowId: tab.windowId,
            tabId: tab.id,
            favIconUrl: tab.favIconUrl,
            isCurrentTab: true
        };

        // Add to appropriate window swimlane
        if (!currentData.windowSwimlanes[tab.windowId]) {
            currentData.windowSwimlanes[tab.windowId] = [];
        }
        currentData.windowSwimlanes[tab.windowId].push(newNavigation);
        console.log("Updated window swimlanes:", currentData.windowSwimlanes); // Debug

        // Update the visualizations
        updateTreemap();
    } catch (error) {
        console.error("Error updating timeline with navigation:", error);
    }
}

// Window create/remove listeners live further down (state.activeWindows-based).
// The earlier handlers here used the stale currentData/activeWindowsAndTabs shape
// and have been removed.

// Replace direct tab activity tracking with message-based sync
async function syncTabActivity() {
    try {
        const response = await chrome.runtime.sendMessage({ type: "GET_TAB_ACTIVITY" });
        if (response) {
            tabActivityLog = new Map(response.tabActivityLog);
            navigationEvents = new Map(response.navigationEvents);

            // Update visualizations with new data
            if (currentData) {
                const activeWindowsAndTabs = await fetchActiveWindowsAndTabs();
                currentData = categorizeHistoryData({
                    history: currentData.historySwimlane,
                    activeWindowsAndTabs
                });
                // Visualizations are now reactive; legacy manual redraw calls removed
            }
        }
    } catch (error) {
        console.error("Error syncing tab activity:", error);
    }
}

// Update setupTimelineUpdates to include tab activity sync
function setupTimelineUpdates() {
    // Clear any existing timer
    if (updateTimer) {
        clearInterval(updateTimer);
    }

    // Setup visibility change handling
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            clearInterval(updateTimer);
            updateTimer = null;
        } else {
            // Page is visible again, sync immediately and restart timer
            syncTabActivity();
            startUpdateTimer();
        }
    });

    // Start initial timer if page is visible
    if (!document.hidden) {
        startUpdateTimer();
    }
}

function startUpdateTimer() {
    // Sync tab activity data periodically
    updateTimer = setInterval(async () => {
        await syncTabActivity();
    }, UPDATE_INTERVAL);
}

// Add cleanup function
function cleanup() {

    if (updateTimer) {
        clearInterval(updateTimer);
        updateTimer = null;
    }
    tabActivityLog.clear();
}

// Add event listener for page unload
window.addEventListener("unload", cleanup);

async function fetchHistoryRange(type, value) {
    const query = {
        text: "",
        maxResults: 10000 // Default max results
    };

    if (type === "time") {
        // Calculate start time based on selected range
        const startTime = new Date(Date.now() - (value * 1000));
        query.startTime = startTime.getTime();
    } else if (type === "count") {
        // Use specified count as maxResults
        query.maxResults = value;
    }

    return chrome.history.search(query);
}

// Capture new tab creation and update edges
chrome.tabs.onCreated.addListener((tab) => {
    if (tab.openerTabId) {
        const edge = {
            source: tab.openerTabId,
            target: tab.id,
            type: "new-tab"
        };
        tabEdges.set(`${tab.openerTabId}-${tab.id}`, edge);
        updateGraphWithNewEdge(edge);
    }
});

// Capture tab updates to ensure edges are tracked
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.openerTabId) {
        const edge = {
            source: tab.openerTabId,
            target: tab.id,
            type: "new-tab"
        };
        tabEdges.set(`${tab.openerTabId}-${tab.id}`, edge);
        updateGraphWithNewEdge(edge);
    }
});

// Update graph with new edge
function updateGraphWithNewEdge(edge) {
    if (!currentData) return;

    if (!currentData.edges) {
        currentData.edges = [];
    }

    const { windowSwimlanes } = currentData;
    console.log("Looking up source tab:", edge.source); // Debug
    const sourceTab = findTabById(windowSwimlanes, edge.source);
    console.log("Looking up target tab:", edge.target); // Debug
    const targetTab = findTabById(windowSwimlanes, edge.target);

    if (sourceTab && targetTab && shouldCreateNavigationEdge(targetTab, sourceTab)) {
        currentData.edges.push(edge);
        currentData.totalEdges++;
        currentData.nodesWithEdges.add(targetTab.id);
    }
}

// Find tab by ID in window swimlanes
function findTabById(windowSwimlanes, tabId) {
    console.log(`findTabById called with tabId: ${tabId}`);
    for (const tabs of Object.values(windowSwimlanes)) {
        const tab = tabs.find(t => t.id === tabId);
        if (tab) {
            console.log(`---Tab found: ${JSON.stringify(tab)}`);
            return tab;
        }
    }
    console.log(`Tab with id ${tabId} not found`);
    return null;
}

// Add tab activity tracking listeners
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    const now = Date.now();

    // Update previous tab
    const previousTab = Array.from(tabActivityLog.entries())
        .find(([_, data]) => data.lastTouch === Math.max(...Array.from(tabActivityLog.values())
            .map(d => d.lastTouch || 0)));

    if (previousTab) {
        const [prevTabId, prevData] = previousTab;
        if (prevData.lastTouch) {
            const timeSpent = now - prevData.lastTouch;
            if (timeSpent > TAB_ACTIVITY.ACTIVE_THRESHOLD) {
                prevData.totalTimeSpent += timeSpent;
                // Persist updated time
                await chrome.storage.local.set({
                    [`tab_${prevTabId}`]: prevData
                });
            }
        }
    }

    // Update current tab
    const storedActivity = await chrome.storage.local.get(`tab_${tabId}`);
    const currentActivity = storedActivity[`tab_${tabId}`] || {
        totalTimeSpent: 0,
        firstSeen: now
    };
    currentActivity.lastTouch = now;
    currentActivity.lastAccessed = now; // Update last accessed time

    // Persist current tab data
    await chrome.storage.local.set({
        [`tab_${tabId}`]: currentActivity
    });

    tabActivityLog.set(tabId, currentActivity);
    console.log("Tab activity log updated:", tabActivityLog);

    // Update the last accessed time in the current data
    if (currentData && currentData.windowSwimlanes[windowId]) {
        const tab = currentData.windowSwimlanes[windowId].find(t => t.id === tabId);
        if (tab) {
            tab.lastAccessed = now;
        }
    }

    // Move the treemap's "current tab" indicator. Within each window the cell
    // color scales by lastAccessed (most-recent = brightest), and the `active`
    // flag feeds the redraw signature. So stamp the newly-activated tab as most
    // recent, flip the active flags for this window, then redraw through the
    // signature-aware path. Skip if the tab isn't in our store yet (a brand-new
    // tab) — the onUpdated 'complete' handler adds it.
    const win = state.activeWindows.find(w => w.id === windowId);
    const target = win?.tabs.find(t => t.id === tabId);
    if (win && target) {
        let activeChanged = false;
        win.tabs.forEach(t => {
            const nowActive = t === target;
            if (t.active !== nowActive) activeChanged = true;
            t.active = nowActive;
        });
        target.lastAccessed = now;
        if (activeChanged) {
            await refreshTreemapState({ activeWindows: state.activeWindows });
        }
    }
});

// Add cleanup for stored data when tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
    await chrome.storage.local.remove(`tab_${tabId}`);
    tabActivityLog.delete(tabId);
});


// Add this function with the other utility functions
function shouldCreateNavigationEdge(current, previous) {
    console.log("--- Considering edge between:", previous, current);
    try {
        // Skip chrome:// and extension URLs
        if (current.url.startsWith("chrome://") ||
            previous.url.startsWith("chrome://") ||
            current.url.startsWith("chrome-extension://") ||
            previous.url.startsWith("chrome-extension://")) {
            return false;
        }

        // Only create edges for explicit navigation types
        const navigationType = current.transitionType;
        if (!["link", "form_submit"].includes(navigationType)) {
            return false;
        }

        // Trust referrer as primary signal
        if (current.referrer === previous.url) {
            return true;
        }

        // Fallback to explicit navigation events
        if (navigationEvents.has(`${previous.id}-${current.id}`)) {
            return true;
        }

        return false;
    } catch (e) {
        return false;
    }
}

// Removed: a top-level chrome.windows.getAll that fired a `getTabHistory`
// message to the service worker for every open tab on each newtab load, plus a
// duplicate chrome.tabs.onUpdated listener doing the same on tab-complete. Both
// enriched windowSwimlanes/`tab.history`, which no render path (treemap,
// readout, search) ever reads — pure boot-time service-worker chatter.

// Removed two legacy DOMContentLoaded handlers:
//   1. One created an empty SVG and drew window.windowData, which was never set.
//   2. One called initializeApp() (from init.js) which ran a *second* drawTreemap
//      → every newtab load painted the treemap twice. The primary init above is
//      now the single boot path.


// 1. Add clear state management
const state = {
    activeWindows: [],
    bookmarks: [],
    minCells: 4,
    currentTabCount: 0,
    get needsBookmarks() {
        return this.currentTabCount < this.minCells;
    }
};

// 2. Single update function that handles all state changes
async function updateTreemapState(changes) {
    console.log("State update:", {
        before: {
            tabCount: state.currentTabCount,
            hasBookmarks: state.needsBookmarks,
            windows: state.activeWindows.length
        }
    });

    // Apply changes
    Object.assign(state, changes);
    state.currentTabCount = state.activeWindows.reduce(
        (sum, w) => sum + w.tabs.length,
        0
    );

    // Manage bookmarks based on tab count
    if (state.needsBookmarks) {
        const bookmarksNeeded = state.minCells - state.currentTabCount;
        state.bookmarks = await fetchRecentBookmarks(bookmarksNeeded);
    } else {
        state.bookmarks = [];
    }

    console.log("State update:", {
        after: {
            tabCount: state.currentTabCount,
            hasBookmarks: state.needsBookmarks,
            bookmarks: state.bookmarks.length
        }
    });

    // Single point of truth for treemap data
    const treeData = {
        name: "root",
        children: [
            ...state.activeWindows.map(window => ({
                name: `Window ${window.id}`,
                id: window.id,
                children: window.tabs.map(tab => ({
                    id: `tab${tab.id}`,
                    windowId: window.id,
                    title: tab.title || "Untitled",
                    url: tab.url || "",
                    favIconUrl: tab.favIconUrl,
                    lastAccessed: Date.now(),
                    timeSpent: tab.totalTimeSpent || 100,
                    isBookmark: false,
                    children: []
                }))
            })),
            // Only add bookmark window if needed
            ...(state.needsBookmarks ? [{
                name: "Window bookmark",
                id: "bookmark",
                children: state.bookmarks.map(bookmark => ({
                    id: `bookmark${bookmark.id}`,
                    windowId: "bookmark",
                    title: bookmark.title || "Untitled",
                    url: bookmark.url || "",
                    favIconUrl: bookmark.favIconUrl,
                    lastAccessed: Date.now(),
                    timeSpent: 100,
                    isBookmark: true,
                    children: []
                }))
            }] : [])
        ]
    };

    // Update visualization
    await drawTreemap(treeData);
}

// Note: a third chrome.tabs.onUpdated handler used to live here; it duplicated
// the state.activeWindows refresh path of the handler above and has been removed.

// Add a central state update handler
function handleStateUpdate(stateUpdate) {
    console.log("State update received:", {
        type: stateUpdate.type,
        tabId: stateUpdate.tabId,
        url: stateUpdate.tab?.url,
        title: stateUpdate.tab?.title
    });

    // Update timeline
    if (stateUpdate.action === "tabUpdated" || stateUpdate.type === "tabUpdate") {
        updateTimelineWithNavigation(stateUpdate.tab);
    }

    // Force treemap redraw on URL or title changes
    if (stateUpdate.tab && (stateUpdate.changeInfo?.url || stateUpdate.changeInfo?.title)) {
        console.log("Tab content changed, updating treemap:", {
            tabId: stateUpdate.tabId,
            url: stateUpdate.tab.url,
            title: stateUpdate.tab.title
        });

        // Force immediate treemap update with fresh data
        updateTreemap();
    }

    // Legacy LINK_NAVIGATION handler removed
}

async function updateTreemap() {
    // treemapState.data is only populated by treemap.js's secondary init; on the
    // newtab.js authoritative path it stays null, so this is an expected no-op
    // (fires on every tab-complete). Stay silent rather than spamming a warning.
    if (!treemapState.data) {
        return;
    }
    await drawTreemap(treemapState.data);
}

// Update the message listener to properly handle responses
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Log incoming message
    console.log("Newtab received message:", {
        type: message.type,
        action: message.action
    });

    // Handle different message types
    if (message.action === "tabUpdated" || message.type === "tabUpdate") {
        try {
            handleStateUpdate(message);
            // Send immediate response
            sendResponse({ success: true });
        } catch (error) {
            console.error("Error handling state update:", error);
            sendResponse({ success: false, error: error.message });
        }
        return false; // We're not using an async response
    }

    // For async handlers, manage the sendResponse properly
    if (message.type === "getTabHistory") {
        // Handle asynchronously
        chrome.storage.local.get(`history_${message.tabId}`)
            .then(result => {
                sendResponse(result);
            })
            .catch(error => {
                console.error("Error fetching tab history:", error);
                sendResponse({ error: error.message });
            });
        return true; // Keep the message channel open
    }

    // Default response for unhandled messages
    sendResponse({ received: true });
    return false;
});

// Update window removal handler
chrome.windows.onRemoved.addListener(async (windowId) => {
    try {
        console.log("Window removal detected:", {
            windowId,
            existingWindows: state.activeWindows.length,
            cachedWindows: categorizedDataCache?.activeWindows?.length
        });

        if (!categorizedDataCache?.activeWindows) {
            console.warn("No cache data available for window removal");
            return;
        }

        // Update state properly
        state.activeWindows = state.activeWindows.filter(w => w.id !== windowId);

        // Update cache
        categorizedDataCache.activeWindows = categorizedDataCache.activeWindows.filter(w => w.id !== windowId);

        // Remove from swimlanes too
        if (categorizedDataCache.windowSwimlanes) {
            delete categorizedDataCache.windowSwimlanes[windowId];
        }

        console.log("Window counts after removal:", {
            stateWindows: state.activeWindows.length,
            cachedWindows: categorizedDataCache.activeWindows.length,
            remainingWindows: await getWindowCount()
        });

        // Handle empty state or update visualization
        if (categorizedDataCache.activeWindows.length === 0) {
            // No windows left, show empty state
            document.getElementById("treemap").innerHTML =
                "<div class=\"empty-state\"><h2>No windows open</h2><p>Open a new window to see your tabs</p></div>";
            console.log("No windows remaining, showing empty state");
        } else {
            // Update visualization
            await updateTreemap();
            console.log("Treemap updated after window removal");
        }
    } catch (error) {
        console.error("Error handling window removal:", error);
    }
});

// Add window creation handler
chrome.windows.onCreated.addListener(async (window) => {
    try {
        console.log("New window created:", {
            windowId: window.id,
            currentWindows: state.activeWindows.length
        });

        // Wait for window to be fully initialized with tabs
        setTimeout(async () => {
            // Force refresh of all window data
            await updateTreemap();

            console.log("Window counts after creation:", {
                stateWindows: state.activeWindows.length,
                cachedWindows: categorizedDataCache.activeWindows.length,
                actualWindows: await getWindowCount()
            });
        }, 500);
    } catch (error) {
        console.error("Error handling window creation:", error);
    }
});

// Add helper function to get accurate window count
async function getWindowCount() {
    try {
        const windows = await chrome.windows.getAll();
        return windows.length;
    } catch (error) {
        console.error("Error getting window count:", error);
        return 0;
    }
}

// Update treemap state management to ensure window counts sync properly
async function refreshTreemapState(changes) {
    console.log("State update:", {
        before: {
            windows: state.activeWindows.length,
            tabCount: state.currentTabCount
        }
    });

    // Apply changes
    Object.assign(state, changes);
    state.currentTabCount = state.activeWindows.reduce(
        (sum, w) => sum + w.tabs.length,
        0
    );

    // Sync with actual window count to ensure accuracy
    const actualWindowCount = await getWindowCount();
    if (actualWindowCount !== state.activeWindows.length) {
        console.warn("Window count mismatch:", {
            stateCount: state.activeWindows.length,
            actualCount: actualWindowCount
        });

        // Refresh all window data
        const windows = await chrome.windows.getAll({ populate: true });
        state.activeWindows = windows.map(window => ({
            id: window.id,
            focused: window.focused,
            tabs: window.tabs.map(tab => ({
                id: tab.id,
                windowId: tab.windowId,
                url: tab.url,
                title: tab.title,
                active: tab.active,
                // Keep favIconUrl a string (or undefined). getFaviconUrl is
                // async — using it here stored a Promise, which crashed
                // drawTreemap (`Promise.includes` is not a function) mid-render
                // and dropped every tab label. drawTreemap already falls back to
                // a generated letter favicon when this is missing.
                favIconUrl: tab.favIconUrl,
                lastAccessed: Date.now()
            }))
        }));

        state.currentTabCount = state.activeWindows.reduce(
            (sum, w) => sum + w.tabs.length,
            0
        );
    }

    console.log("State after update:", {
        windows: state.activeWindows.length,
        tabCount: state.currentTabCount
    });

    // Skip the repaint when nothing the treemap shows has actually changed.
    // The new-tab page's own load fires onUpdated right after first paint; with
    // `state` seeded at boot this signature matches and we return without a
    // redundant redraw. Real changes (new/removed/navigated/activated tabs)
    // change the signature and redraw. drawTreemap expects { activeWindows }.
    const signature = treemapSignature(state.activeWindows);
    if (signature === lastTreemapSignature) {
        return;
    }
    lastTreemapSignature = signature;
    await drawTreemap({ activeWindows: state.activeWindows });
}

// Add tab removal listener
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    const windowId = removeInfo.windowId;

    // Remove the tab from state.activeWindows — the store drawTreemap actually
    // paints from. The old handler only filtered currentData.windowSwimlanes and
    // called updateTreemap() (a no-op on this render path), so a closed tab's
    // card never disappeared.
    let changed = false;
    state.activeWindows.forEach(w => {
        const before = w.tabs.length;
        w.tabs = w.tabs.filter(t => t.id !== tabId);
        if (w.tabs.length !== before) changed = true;
    });
    // Drop any window left with no tabs (also covers closing a whole window,
    // which fires onRemoved for each of its tabs in turn).
    state.activeWindows = state.activeWindows.filter(w => w.tabs.length > 0);

    // Keep the vestigial currentData store in sync for any remaining readers.
    if (currentData?.windowSwimlanes?.[windowId]) {
        currentData.windowSwimlanes[windowId] =
            currentData.windowSwimlanes[windowId].filter(tab => tab.id !== tabId);
        if (currentData.windowSwimlanes[windowId].length === 0) {
            delete currentData.windowSwimlanes[windowId];
            currentData.activeWindows = (currentData.activeWindows || [])
                .filter(window => window.id !== windowId);
        }
    }

    // Redraw through the signature-aware path so the closed tab's card is removed.
    if (changed) {
        await refreshTreemapState({ activeWindows: state.activeWindows });
    }
});

