// Sessions view JavaScript
console.log("sessions.js loaded");

// Import the summary cache and helper functions from readout.js
import { summaryCache, getCachedSummary, summaryQueue, processSummaryQueue } from "./readout.js";
import { getLocalFaviconUrl, escapeHtml, safeUrl } from "./utility.js";
// Import the debug tools bridge for ES module compatibility

// Import session renderers
import { renderSessionCards } from "./sessions_renderer.js";
// Import hero image utilities
import { createSessionCard, clearSeenHeroImages } from "./hero_images_display.js";
// Import time formatting utilities
import { formatTimeAgo } from "./timeago.js";
// Import URL utilities
import { extractSearchQuery } from "../lib/url-utils.js";
import { getRecentHistory } from "../lib/history-cache.js";
// Cross-view search query hand-off (URL ?q= + chrome.storage.session)
import {
    readSharedQuery,
    publishSharedQuery,
    decorateViewLinks,
    onSharedQueryChange
} from "./search-persistence.js";

/**
 * Format milliseconds into a human-readable duration string
 * @param {number} milliseconds - Duration in milliseconds
 * @returns {string} Formatted duration string (e.g. "2h 30m 15s")
 */
function formatDuration(milliseconds) {
    if (milliseconds === undefined || milliseconds === null || isNaN(milliseconds)) return "N/A";

    // Handle negative durations
    if (milliseconds < 0) return "Duration unknown";

    // Handle zero or very small durations
    if (milliseconds === 0) return "Brief view";
    if (milliseconds < 1000) return "< 1s";

    if (milliseconds < 60000) return `${Math.round(milliseconds / 1000)}s`;
    if (milliseconds < 3600000) return `${Math.round(milliseconds / 60000)}m`;

    const hours = Math.floor(milliseconds / 3600000);
    const minutes = Math.round((milliseconds % 3600000) / 60000);
    return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
}


/**
 * Generate a favicon URL for a given page URL
 * @param {string} url - The URL to get favicon for
 * @returns {string} - The favicon URL
 */
function getFaviconDisplayUrl(url) {
    try {
        new URL(url); // validate; an invalid URL falls through to the catch below
        // Local favicon (Chrome's cache) instead of the external Google service.
        return getLocalFaviconUrl(url, 32);
    } catch (e) {
        // Fallback for invalid URLs
        return "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik04IDIuNWEuNS41IDAgMCAxIC41LjVWOGEuNS41IDAgMCAxLTEgMFYzYS41LjUgMCAwIDEgLjUtLjVaTTggMTBhLjc1Ljc1IDAgMSAwIDAgMS41Ljc1Ljc1IDAgMCAwIDAtMS41WiIgZmlsbD0iIzVGNjM2OCIvPjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgY2xpcC1ydWxlPSJldmVub2RkIiBkPSJNOCAxNUE3IDcgMCAxIDAgOCAxYTcgNyAwIDAgMCAwIDE0Wm0wLTFBNiA2IDAgMSAwIDggMmE2IDYgMCAwIDAgMCAxMloiIGZpbGw9IiM1RjYzNjgiLz48L3N2Zz4=";
    }
}

// Helper function to create a truncated summary display (simplified version from readout.js)
function createTruncatedSummary(summary, searchTerm = "") {
    if (!summary) return "";

    const MAX_SUMMARY_LINES = 3;
    const lines = summary.split("\n");
    const isTruncated = lines.length > MAX_SUMMARY_LINES;

    let truncatedSummary = isTruncated
        ? lines.slice(0, MAX_SUMMARY_LINES).join("\n")
        : summary;

    // Highlight search term if provided
    if (searchTerm && searchTerm.trim() !== "") {
        truncatedSummary = highlightText(truncatedSummary, searchTerm);
    }

    return `<div class="summary-content"><div class="summary-text">${truncatedSummary.trim()}</div>${isTruncated ? `<div class="summary-expand"><button class="show-more-btn" onclick="this.parentElement.parentElement.innerHTML = \`${summary.replace(/`/g, "\\`").trim()}\`">Show more...</button></div>` : ""}</div>`;
}

// Helper function to highlight search matches in text
// Returns HTML (callers assign it to innerHTML), so the caller-supplied text —
// page titles and URLs, which any visited site controls — must be escaped here.
// Escape BEFORE inserting the highlight markup, and match against the escaped
// text with an equally-escaped term so a term containing &, < or " still hits.
function highlightText(text, searchTerm) {
    if (!searchTerm || !text) return escapeHtml(text);

    const escapedText = escapeHtml(text);
    const escapedTerm = escapeHtml(searchTerm);
    const searchRegex = new RegExp(escapedTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return escapedText.replace(searchRegex, match => `<span class="search-highlight">${match}</span>`);
}

let allSessionsData = []; // To store the original full list of sessions
let currentSearchTerm = ""; // Track current search term for highlighting
let sessionsData = []; // Store the processed sessions data

/**
 * Get URLs of all currently active tabs
 * @returns {Promise<Array<string>>} Array of active tab URLs
 */
async function getActiveTabUrls() {
    return new Promise((resolve) => {
        chrome.tabs.query({ active: true }, (tabs) => {
            const activeUrls = tabs.map(tab => tab.url);
            console.log(`Found ${activeUrls.length} active tabs:`, activeUrls);
            resolve(activeUrls);
        });
    });
}

// Cache for in-flight hero image requests and recent results
const heroImageRequestCache = {
    inFlight: new Map(), // URL -> Promise
    lastRequested: new Map(), // URL -> timestamp
    cooldownPeriod: 2000 // ms between allowed repeat requests
};

/**
 * Get hero images for a URL
 * @param {string} url - URL to get hero images for
 * @returns {Promise<Array>} - Hero images or null
 */
async function getHeroImagesForUrl(url) {
    // Don't allow rapid repeated requests for the same URL
    const now = Date.now();
    const lastRequested = heroImageRequestCache.lastRequested.get(url) || 0;
    if (now - lastRequested < heroImageRequestCache.cooldownPeriod) {
        // Request made too recently, return cached result or null
        const existingRequest = heroImageRequestCache.inFlight.get(url);
        if (existingRequest) {
            return existingRequest;
        }
        return null;
    }

    // Check for in-flight request for this URL
    if (heroImageRequestCache.inFlight.has(url)) {
        return heroImageRequestCache.inFlight.get(url);
    }

    // Create a new request promise
    const requestPromise = new Promise((resolve) => {
        // Update cache
        heroImageRequestCache.lastRequested.set(url, now);

        // First check browserState if available (core shared data structure)
        if (typeof browserState !== "undefined" && browserState.heroImages && browserState.heroImages.get) {
            const heroImageData = browserState.heroImages.get(url);
            if (heroImageData && heroImageData.images) {
                resolve(heroImageData.images);
                return;
            }
        }

        // Then check local storage
        chrome.storage.local.get(["heroImages"], (result) => {
            const heroImagesStore = result.heroImages || {};
            if (heroImagesStore[url]) {
                resolve(heroImagesStore[url].images);
            } else {
                // If not in storage, try asking background script directly
                chrome.runtime.sendMessage({ action: "getHeroImagesForUrl", url: url }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error("❌ Error getting hero images:", chrome.runtime.lastError);
                        resolve(null);
                    } else if (response && response.images) {
                        resolve(response.images);
                    } else {
                        resolve(null);
                    }
                });
            }
        });
    });

    // Store the promise in the cache
    heroImageRequestCache.inFlight.set(url, requestPromise);

    // Remove from in-flight cache once resolved
    requestPromise.then(result => {
        heroImageRequestCache.inFlight.delete(url);
        return result;
    }).catch(() => {
        heroImageRequestCache.inFlight.delete(url);
        return null;
    });

    return requestPromise;
}

/**
 * Renders hero images for a page if available
 * @param {Object} page - Page object with URL and dwellTime
 * @returns {Promise<HTMLElement|null>} - Hero image strip element or null
 */
async function renderHeroImagesForPage(page) {
    // Only try to show hero images for pages with significant dwell time
    if (!page.dwellTimeMs || page.dwellTimeMs < 60000 || page.heroImagesRendered) {
        return null;
    }

    const heroImages = await getHeroImagesForUrl(page.url);
    if (!heroImages || !heroImages.length) {
        return null;
    }

    // Create a horizontal strip of thumbnails
    const strip = document.createElement("div");
    strip.className = "hero-image-strip";

    // Add each thumbnail
    heroImages.forEach((image, index) => {
        // Skip invalid images
        if (!image.src) return;

        const thumb = document.createElement("img");
        thumb.className = "hero-image-thumbnail";
        thumb.src = image.src;
        thumb.alt = image.alt || "";
        thumb.dataset.index = index;
        thumb.dataset.fullsize = image.src;

        // Add click handler to expand image
        thumb.addEventListener("click", (e) => {
            // Find or create container for expanded image
            let container = strip.nextElementSibling;
            if (!container || !container.classList.contains("hero-image-container")) {
                container = document.createElement("div");
                container.className = "hero-image-container";
                strip.insertAdjacentElement("afterend", container);
            } else {
                // Clear existing content
                container.innerHTML = "";
            }

            // Create expanded image
            const expandedImg = document.createElement("img");
            expandedImg.className = "hero-image-expanded";
            expandedImg.src = image.src;
            expandedImg.alt = image.alt || "";

            // Add close button
            const closeBtn = document.createElement("button");
            closeBtn.className = "hero-image-close";
            closeBtn.textContent = "×";
            closeBtn.addEventListener("click", () => {
                container.remove();
            });

            container.appendChild(expandedImg);
            container.appendChild(closeBtn);
        });

        strip.appendChild(thumb);
    });

    return strip;
}

/**
 * Add dynamic styles for tab groups and micro-session separators to the document head
 */
function addTabGroupStyles() {
    const style = document.createElement("style");
    style.textContent = `
        /* Tab group coloring styles */
        .tab-group-indicator {
            display: inline-block;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            margin-right: 5px;
        }
        
        /* Micro-session separator styles */
        .micro-session-separator-item {
            list-style-type: none;
            margin: 10px 0;
            padding: 0;
        }
        
        .micro-session-separator {
            border-top: 1px dashed #aaa;
            position: relative;
            margin: 10px 0;
            padding-top: 5px;
            text-align: center;
        }
        
        .micro-session-reason {
            display: inline-block;
            background: #f0f0f0;
            color: #666;
            border: 1px solid #ddd;
            border-radius: 12px;
            padding: 2px 10px;
            font-size: 11px;
            position: relative;
            top: -12px;
        }
        
        .micro-session-start {
            position: relative;
            border-left: 3px solid #4285f4;
            margin-left: -3px;
            padding-left: 10px;
        }
        
        /* New window type */
        .micro-session-separator[data-reason="new_window"] .micro-session-reason {
            background: #e8f0fe;
            color: #1967d2;
            border-color: #aecbfa;
        }
        
        /* New tab type */
        .micro-session-separator[data-reason="new_tab"] .micro-session-reason {
            background: #e6f4ea;
            color: #137333;
            border-color: #a8dab5;
        }
        
        /* Time gap type */
        .micro-session-separator[data-reason="time_gap"] .micro-session-reason {
            background: #fef7e0;
            color: #b06000;
            border-color: #fde293;
        }
    `;
    document.head.appendChild(style);
}

let lastStateUpdateTime = 0;
const REFRESH_THROTTLE_PERIOD = 10000; // 10 seconds

async function refreshSessionsIfNecessary() {
    const now = Date.now();

    // Throttle to avoid refreshing too frequently
    if (now - lastStateUpdateTime < REFRESH_THROTTLE_PERIOD) {
        console.log("Refresh throttled");
        return;
    }

    // Check if the state has been updated since the last refresh
    const lastUpdated = await new Promise(resolve => {
        chrome.storage.local.get("lastStateSave", (result) => {
            resolve(result.lastStateSave || 0);
        });
    });

    if (lastUpdated > lastStateUpdateTime) {
        console.log("State has been updated, refreshing sessions data...");
        lastStateUpdateTime = now; // Update time before refresh
        await initSessions(true);
    } else {
        console.log("No state update detected, skipping refresh");
    }
}

document.addEventListener("DOMContentLoaded", () => {
    console.log("Sessions view DOM fully loaded and parsed");
    addTabGroupStyles();

    // Seed with the query carried from another view (URL ?q= or chrome.storage.session);
    // the filter itself runs once initSessions has rendered the data.
    const searchInput = document.getElementById("sessionSearch");
    const initialQuery = readSharedQuery();
    if (searchInput) {
        searchInput.value = initialQuery;
    }
    decorateViewLinks(initialQuery.trim());
    currentSearchTerm = initialQuery.toLowerCase();

    initSessions().then(() => {
        if (currentSearchTerm.trim()) {
            filterAndRenderSessions(currentSearchTerm);
        }
    });

    if (searchInput) {
        searchInput.addEventListener("input", (event) => {
            publishSharedQuery(event.target.value.trim());
            currentSearchTerm = event.target.value.toLowerCase();
            filterAndRenderSessions(currentSearchTerm);
        });

        // Live-sync with edits made in other open views.
        onSharedQueryChange((query) => {
            searchInput.value = query;
            currentSearchTerm = query.toLowerCase();
            filterAndRenderSessions(currentSearchTerm);
            decorateViewLinks(query.trim());
        });
    }

    // Check for updates when the tab becomes visible
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            console.log("Tab is visible, checking for session updates...");
            refreshSessionsIfNecessary();
        }
    });

    // Also check for updates periodically
    setInterval(refreshSessionsIfNecessary, 15000); // Check every 15 seconds
});

function filterAndRenderSessions(searchTerm) {
    if (!allSessionsData) return;

    // Local Filter (Instant) — standalone build searches only the in-memory
    // session corpus; there is no backend semantic search.
    let filteredSessions;
    if (!searchTerm || searchTerm.trim() === "") {
        filteredSessions = allSessionsData;
        renderSessions(filteredSessions);
        return;
    }

    filteredSessions = allSessionsData.filter(session => {
        // Check session name
        if (session.name && session.name.toLowerCase().includes(searchTerm)) {
            return true;
        }
        // Check pages within the session
        if (session.pages) {
            for (const page of session.pages) {
                if (page.title && page.title.toLowerCase().includes(searchTerm)) {
                    return true;
                }
                if (page.url && page.url.toLowerCase().includes(searchTerm)) {
                    return true;
                }

                // Check AI summary if available in cache
                const cachedSummary = getCachedSummary(page.url);
                if (cachedSummary && cachedSummary.toLowerCase().includes(searchTerm)) {
                    return true;
                }
            }
        }
        return false;
    });

    // Render local results immediately
    renderSessions(filteredSessions);
}

/**
 * Process sessions data from history and active tabs
 * @param {Array} activeTabUrls - Array of URLs of active tabs
 * @param {boolean} isRefresh - Whether this is a refresh operation
 * @returns {Promise<Object>} - Object with sessions array
 */
async function processSessionsData(activeTabUrls = [], isRefresh = false) {
    console.log(`Processing and rendering sessions with ${activeTabUrls.length} active tabs...`);

    try {
        // Standalone build: Chrome's own history is the sole sessions source.
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        const [historyItems, allWindows] = await Promise.all([
            getRecentHistory({
                text: "",
                // Most-recent N items in the window. The removed backend returned a
                // curated set; pulling 10000 raw history items made the sessions view
                // slow to fetch, sessionize, and render. 3000 keeps plenty of recent
                // sessions while cutting load time ~3x. Raise it for deeper history.
                maxResults: 3000,
                startTime: thirtyDaysAgo // 30-day window
            }),
            chrome.windows.getAll({ populate: true })
        ]);
        console.log(`[Tabtopia] Retrieved ${historyItems.length} items from local Chrome History (30-day window)`);

        console.log(`Fetched ${historyItems.length} history items and ${allWindows.length} windows`);

        // Process the data into sessions
        console.log(`[Duration] Starting session data processing with ${historyItems.length} history items and ${allWindows.length} windows`);
        const processedSessions = await processDataIntoSessions(historyItems, allWindows);

        // (Removed a per-session diagnostic console.log loop that ran two
        //  Date.toLocaleString() calls + an object log for every session on
        //  every load — pure overhead on the render path.)

        // Apply any current search filter but don't render here
        let sessionsToReturn = processedSessions;

        if (currentSearchTerm && currentSearchTerm.trim() !== "") {
            sessionsToReturn = processedSessions.filter(session => {
                // Check session name
                if (session.name && session.name.toLowerCase().includes(currentSearchTerm)) {
                    return true;
                }

                // Check session-level summary if available
                if (session.summary && session.summary.toLowerCase().includes(currentSearchTerm)) {
                    // Mark this session as having a summary match for highlighting
                    session.hasSummaryMatch = true;
                    return true;
                }

                // Check search queries within the session
                if (session.searchQueries && session.searchQueries.some(query =>
                    query.toLowerCase().includes(currentSearchTerm))) {
                    return true;
                }

                // Check pages within the session
                if (session.pages) {
                    for (const page of session.pages) {
                        if (page.title && page.title.toLowerCase().includes(currentSearchTerm)) {
                            return true;
                        }
                        if (page.url && page.url.toLowerCase().includes(currentSearchTerm)) {
                            return true;
                        }

                        // Check AI summary if available in cache
                        const cachedSummary = getCachedSummary(page.url);
                        if (cachedSummary && cachedSummary.toLowerCase().includes(currentSearchTerm)) {
                            // Store which pages have summary matches for highlighting
                            if (!page.matchTypes) page.matchTypes = {};
                            page.matchTypes.summary = true;
                            return true;
                        }
                    }
                }
                return false;
            });
        }

        return { sessions: sessionsToReturn };
    } catch (error) {
        console.error("Error processing sessions data:", error);
        return { sessions: [] };
    }
}

async function initSessions(isRefresh = false) {
    const container = document.getElementById("sessions-container");
    const startTime = performance.now();

    try {
        // Get active tab URLs
        const activeTabUrls = await getActiveTabUrls();

        // Process sessions data (but don't render yet)
        const { sessions } = await processSessionsData(activeTabUrls, isRefresh);

        // Store the full dataset
        allSessionsData = sessions;
        sessionsData = sessions;

        // Explicitly render the sessions
        await renderSessions(sessions, isRefresh);

        // If this is a refresh, save and restore scroll position
        if (isRefresh) {
            const scrollPos = window.scrollY;
            // Small delay to ensure DOM is updated before restoring scroll
            setTimeout(() => {
                window.scrollTo(0, scrollPos);
            }, 100);
        }

        // Log performance metrics
        const endTime = performance.now();
        console.log(`Sessions data ${isRefresh ? "refreshed" : "loaded"} in ${(endTime - startTime).toFixed(2)}ms`);
    } catch (error) {
        console.error("Failed to initialize sessions view:", error);
        if (container && !isRefresh) { // Only show error on initial load
            container.innerHTML = `<p class="error-message">Error loading sessions: ${error.message}</p>`;
        }
    }
}

/**
 * Creates a refresh indicator element that shows when data is being refreshed
 * @returns {HTMLElement} The refresh indicator element
 */
function createRefreshIndicator() {
    // Check if it already exists
    let indicator = document.getElementById("refresh-indicator");
    if (indicator) return indicator;

    // Create new indicator
    indicator = document.createElement("div");
    indicator.id = "refresh-indicator";
    indicator.textContent = "Refreshing data...";
    indicator.style.cssText = `
        position: fixed;
        top: 10px;
        right: 10px;
        background-color: rgba(0, 0, 0, 0.7);
        color: white;
        padding: 8px 12px;
        border-radius: 4px;
        font-size: 12px;
        z-index: 1000;
        opacity: 0;
        transition: opacity 0.3s ease;
        pointer-events: none;
    `;

    // Add a style for the active state
    const style = document.createElement("style");
    style.textContent = `
        #refresh-indicator.active {
            opacity: 1;
        }
    `;
    document.head.appendChild(style);

    // Attach helper methods to control visibility for callers
    // These are used by setupSessionsAutoRefresh()
    indicator.show = () => {
        indicator.classList.add("active");
    };
    indicator.hide = () => {
        indicator.classList.remove("active");
    };

    // Add to DOM
    document.body.appendChild(indicator);
    return indicator;
}

async function processDataIntoSessions(historyItems, allWindows) { // Made async
    console.log("Processing data into sessions...");
    const SESSION_GAP_THRESHOLD = 30 * 60 * 1000; // 30 minutes in milliseconds
    const MICRO_SESSION_GAP_THRESHOLD = 5 * 60 * 1000; // 5 minutes for micro-sessions
    const SESSION_CONTEXT_THRESHOLD = 4 * 60 * 60 * 1000; // 4 hours as extended context threshold
    const NEW_WINDOW_BREAK = true; // Break session on new window detection
    let processedSessions = [];

    // 1. Combine history items and active tabs into a single list of activities
    let activities = historyItems.map(item => ({
        ...item, // Preserve all properties from backend items (metrics, dwellTime, etc)
        url: item.url,
        title: item.title || item.url,
        timestamp: item.lastVisitTime,
        type: item.type || "history",
        _layer: item._layer || "raw",
        tags: item.tags || [],
        visitCount: item.visitCount
    }));

    // Track active tab URLs to identify active sessions later
    const activeTabUrls = new Set();
    const activeTabIds = new Set();

    allWindows.forEach(window => {
        if (window.tabs) {
            window.tabs.forEach(tab => {
                if (tab.url && !tab.url.startsWith("chrome://")) { // Exclude internal chrome pages
                    // Store the URL for later active session identification
                    activeTabUrls.add(tab.url);
                    activeTabIds.add(tab.id);

                    // Get the access time or use current time as fallback
                    const accessTime = tab.lastAccessTime || Date.now();

                    activities.push({
                        url: tab.url,
                        title: tab.title || tab.url,
                        timestamp: accessTime,
                        lastAccessTime: accessTime, // Store explicitly for filtering later
                        type: "active_tab",
                        tabId: tab.id,
                        windowId: window.id,
                        active: tab.active
                    });
                }
            });
        }
    });

    console.log(`Found ${activeTabUrls.size} active tabs for session tracking`);

    // Only deduplicate exact timestamp duplicates, not across sessions
    // This preserves multiple visits to the same URL when they occur in different sessions
    activities = activities.reduce((acc, current) => {
        // Only consider it a duplicate if it's the same URL with nearly identical timestamp (within 1 second)
        const x = acc.find(item => item.url === current.url && Math.abs(item.timestamp - current.timestamp) < 1000);
        if (!x) {
            // No duplicate found, add the current activity
            return acc.concat([current]);
        } else if (current.type === "active_tab" && x.type === "history") {
            // Replace history with active_tab if it's essentially the same event
            return acc.filter(item => item !== x).concat([current]);
        }
        return acc;
    }, []);

    console.log(`Activities after deduplication: ${activities.length}`);


    // 2. Sort activities chronologically (oldest first for session building)
    activities.sort((a, b) => a.timestamp - b.timestamp);

    if (activities.length === 0) {
        console.log("No activities to process into sessions.");
        return [];
    }

    // 3. Group activities into sessions with context awareness
    let currentSession = null;
    let lastActivity = null;
    let sessionsByDay = {}; // Group sessions by day for context matching

    activities.forEach((activity, index) => {
        if (!activity.url) return; // Skip activities without a URL

        // Get day key for the activity for context matching
        const activityDate = new Date(activity.timestamp);
        const year = activityDate.getFullYear();
        const month = String(activityDate.getMonth() + 1).padStart(2, "0");
        const day = String(activityDate.getDate()).padStart(2, "0");
        const dayKey = `${year}-${month}-${day}`;

        if (!sessionsByDay[dayKey]) {
            sessionsByDay[dayKey] = [];
        }

        if (currentSession === null) {
            // Start the first session
            currentSession = createNewSession(activity);
        } else {
            const timeDiff = activity.timestamp - currentSession.endTime;

            // Check if we're revisiting a page that was already seen in the current session
            const previousVisitInSession = currentSession.pages.find(page => page.url === activity.url);
            const isRevisit = previousVisitInSession !== undefined;

            // Check for context matching with earlier sessions from the same day
            const contextSessions = sessionsByDay[dayKey].filter(session => {
                // Only consider sessions within context threshold of this activity
                return Math.abs(activity.timestamp - session.endTime) < SESSION_CONTEXT_THRESHOLD;
            });

            // Find if any contextual session has this URL
            const matchingContextSession = contextSessions.find(session => {
                return session.pages.some(page => page.url === activity.url);
            });

            // Check for micro-session breaks based on window ID and origin
            const isNewWindow = activity.windowId && currentSession.lastWindowId &&
                activity.windowId !== currentSession.lastWindowId;

            // Check if this is likely an explicit new tab or window navigation
            const isExplicitNewTab = activity.openContext === "user_command" ||
                activity.url.includes("chrome://newtab");

            // Calculate if this should be a micro-session break
            const isMicroSessionBreak = (timeDiff > MICRO_SESSION_GAP_THRESHOLD) ||
                (NEW_WINDOW_BREAK && isNewWindow) ||
                isExplicitNewTab;

            // Full session break (longer time gap)
            if (timeDiff > SESSION_GAP_THRESHOLD) {
                // Time gap is too large, check for possible context bridge
                if (matchingContextSession && timeDiff < SESSION_CONTEXT_THRESHOLD && !isNewWindow) {
                    console.log(`Found context match for ${activity.url} in recent session`);
                    // Add to existing session instead of creating new one
                    currentSession.pages.push({
                        url: activity.url,
                        title: activity.title,
                        visitTime: activity.timestamp,
                        lastAccessTime: activity.lastAccessTime,
                        windowId: activity.windowId,
                        tabId: activity.tabId,
                        isContextualRevisit: true
                    });
                    // Update session end time and log the change
                    console.log(`[Duration] Updating session ${currentSession.id} endTime due to contextual revisit:`, {
                        url: activity.url,
                        oldEndTime: new Date(currentSession.endTime).toISOString(),
                        newEndTime: new Date(activity.timestamp).toISOString(),
                        timeDiff: activity.timestamp - currentSession.endTime
                    });
                    currentSession.endTime = activity.timestamp;
                    currentSession.lastWindowId = activity.windowId;
                } else {
                    // Time gap is too large and no context match, finalize previous session and start a new one
                    finalizeSession(currentSession, activeTabUrls);
                    sessionsByDay[dayKey].push(currentSession);
                    processedSessions.push(currentSession);

                    // Start a new session
                    currentSession = createNewSession(activity);
                }
                // Micro-session break (new window, explicit navigation, or smaller time gap)
            } else if (isMicroSessionBreak) {
                console.log(`Creating micro-session break for ${activity.url} - ${isNewWindow ? "new window" : "time gap or explicit navigation"}`);

                // Create a micro-session marker in current session
                currentSession.microSessionBreaks = currentSession.microSessionBreaks || [];
                currentSession.microSessionBreaks.push({
                    timestamp: activity.timestamp,
                    reason: isNewWindow ? "new_window" :
                        isExplicitNewTab ? "new_tab" : "time_gap"
                });

                // Add the page with a micro-session marker
                currentSession.pages.push({
                    url: activity.url,
                    title: activity.title,
                    visitTime: activity.timestamp,
                    lastAccessTime: activity.lastAccessTime,
                    windowId: activity.windowId,
                    tabId: activity.tabId,
                    isMicroSessionStart: true,
                    microSessionReason: isNewWindow ? "new_window" :
                        isExplicitNewTab ? "new_tab" : "time_gap"
                });

                currentSession.endTime = activity.timestamp;
                currentSession.lastWindowId = activity.windowId;
            } else {
                // Activity is part of the current session
                currentSession.pages.push({
                    url: activity.url,
                    title: activity.title,
                    visitTime: activity.timestamp,
                    lastAccessTime: activity.lastAccessTime,
                    windowId: activity.windowId,
                    tabId: activity.tabId,
                    isRevisit: isRevisit
                });
                currentSession.endTime = activity.timestamp;
                currentSession.lastWindowId = activity.windowId;
            }
        }

        lastActivity = activity;
    });

    // Finalize the last session
    if (currentSession) {
        finalizeSession(currentSession, activeTabUrls);
        processedSessions.push(currentSession);
    }

    // Enrich sessions with dwell time and referral data
    if (typeof window.browserState !== "undefined" && window.browserState.getPageActivityAndReferrals) {
        console.log("Enriching sessions with activity and referral data...");

        // Optimize: Fetch state once before the loop to avoid redundant background IPC calls
        if (typeof window.browserState.getState === "function") {
            await window.browserState.getState();
        }

        for (let i = 0; i < processedSessions.length; i++) {
            const session = processedSessions[i];
            if (session.pages && session.pages.length > 0) {
                const pageInfoForEnrichment = session.pages.map(p => ({
                    url: p.url,
                    visitTimestamp: p.visitTime, // Map visitTime to visitTimestamp
                    // Pass existing dwell metrics if available from backend
                    dwellTimeMs: p.dwellTimeMs || (p.metrics ? p.metrics.dwellTime : null)
                }));

                try {
                    // Use skipRefresh: true since we already updated state above
                    const enrichedPages = await window.browserState.getPageActivityAndReferrals(pageInfoForEnrichment, { skipRefresh: true });
                    session.pages = session.pages.map((originalPage, index) => ({
                        ...originalPage,
                        ...enrichedPages[index] // Adds originalTabId, dwellTimeMs, referral
                    }));
                    console.log(`Enriched ${enrichedPages.length} pages for session ${session.id}`);
                } catch (error) {
                    console.error(`Error enriching pages for session ${session.id}:`, error);
                }
            }
        }
    }
    else {
        console.warn("browserState.getPageActivityAndReferrals not available. Skipping session enrichment.");
        // More detailed diagnostics
        console.warn(`window.browserState exists: ${typeof window.browserState !== "undefined"}`);
        if (typeof window.browserState !== "undefined") {
            console.warn("window.browserState properties:", Object.keys(window.browserState));
            console.warn(`getPageActivityAndReferrals is function: ${typeof window.browserState.getPageActivityAndReferrals === "function"}`);
        }
    }

    console.log("Processed sessions (enriched):", processedSessions);

    // Queue important pages for summary generation
    const pagesToSummarize = new Set();

    // Process each session to find important pages to summarize
    processedSessions.forEach(session => {
        if (!session.pages || session.pages.length === 0) return;

        // Always queue the first page of each session
        if (session.pages[0]) {
            pagesToSummarize.add(session.pages[0].url);
        }

        // Queue search pages (most valuable for search recall)
        const searchPages = session.pages.filter(page => extractSearchQuery(page.url));
        searchPages.forEach(page => pagesToSummarize.add(page.url));

        // Queue pages with significant dwell time (> 1 minute)
        const significantPages = session.pages.filter(page => page.dwellTimeMs > 60000);
        significantPages.slice(0, 3).forEach(page => pagesToSummarize.add(page.url));
    });

    // Add to summary queue if not already cached
    pagesToSummarize.forEach(url => {
        // Skip restricted URLs
        if (url.startsWith("chrome://") || url.startsWith("file://")) return;

        // Skip if we already have a summary
        if (!getCachedSummary(url)) {
            console.log(`Queueing summary generation for: ${url}`);
            summaryQueue.add(url);
        }
    });

    // Process the queue if we added any URLs
    if (summaryQueue.size > 0) {
        console.log(`Processing ${summaryQueue.size} URLs for summary generation`);
        processSummaryQueue().catch(console.error);
    }

    return processedSessions;
}

/**
 * Creates a new session object with initial page data
 * @param {Object} activity - The initial activity to create session from
 * @returns {Object} - The new session object
 */
function createNewSession(activity) {
    const sessionId = `session_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    return {
        id: sessionId,
        startTime: activity.timestamp,
        endTime: activity.timestamp,
        lastWindowId: activity.windowId, // Track the window ID for micro-session detection
        pages: [{
            url: activity.url,
            title: activity.title,
            visitTime: activity.timestamp,
            lastAccessTime: activity.lastAccessTime,
            windowId: activity.windowId,
            tabId: activity.tabId
        }]
    };
}

/**
 * Finalizes session data by computing duration, top domains, and other metrics
 * @param {Object} session - The session object to finalize
 * @param {Set} activeTabUrls - Set of URLs currently open in active tabs
 */
function finalizeSession(session, activeTabUrls) {
    // Calculate duration
    session.durationMs = session.endTime - session.startTime;
    // Make duration available under both property names for compatibility
    session.duration = session.durationMs;

    // Extract domains and count occurrences
    const domainCounts = {};
    const faviconByDomain = {};
    const searchQueries = new Set();

    session.pages.forEach(page => {
        try {
            // Extract domain
            const url = new URL(page.url);
            const domain = url.hostname;

            // Count domain occurrences
            if (!domainCounts[domain]) {
                domainCounts[domain] = 0;
                faviconByDomain[domain] = getFaviconDisplayUrl(page.url);
            }
            domainCounts[domain]++;

            // Check if this page contains a search query in referral
            if (page.referral && page.referral.searchQuery) {
                searchQueries.add(page.referral.searchQuery);
            }
        } catch (e) {
            // Skip invalid URLs
        }
    });

    // Sort domains by frequency
    const topDomains = Object.entries(domainCounts)
        .map(([domain, count]) => ({
            domain,
            count,
            faviconUrl: faviconByDomain[domain]
        }))
        .sort((a, b) => b.count - a.count);

    session.topDomains = topDomains;
    session.totalPages = session.pages.length;
    session.isActive = session.pages.some(page => activeTabUrls.has(page.url));

    // Add search queries if any
    if (searchQueries.size > 0) {
        session.searchQueries = Array.from(searchQueries);
    }

    return session;
}

/**
 * Renders the list of pages for a session with micro-session separation
 * @param {Object} session - The session object with pages to render
 * @param {string} searchTerm - Optional search term to highlight
 * @returns {HTMLElement} - The rendered page list container
 */
function renderPageList(session, searchTerm = "") {
    const pageListContainer = document.createElement("div");
    pageListContainer.className = "session-page-list";

    // Sort pages chronologically
    const sortedPages = session.pages.sort((a, b) => a.visitTime - b.visitTime);

    // Create list for pages
    const ul = document.createElement("ul");
    ul.className = "session-pages-ul";

    // Add summary at the top
    const summary = document.createElement("div");
    summary.className = "session-summary";

    // Add summary details like page count and duration
    const summaryDetails = document.createElement("div");
    summaryDetails.className = "session-summary-details";

    // Add top domains if available
    if (session.topDomains && session.topDomains.length > 0) {
        const domainsList = document.createElement("div");
        domainsList.className = "detail";
        domainsList.innerHTML = `<span class="detail-label">Top domains:</span> ${session.topDomains.slice(0, 3).map(d => escapeHtml(d.domain)).join(", ")}`;
        summaryDetails.appendChild(domainsList);
    }

    // Add search queries if available
    if (session.searchQueries && session.searchQueries.length > 0) {
        const queriesList = document.createElement("div");
        queriesList.className = "detail search-queries";
        queriesList.innerHTML = `<span class="detail-label">Search queries:</span> ${session.searchQueries.slice(0, 3).map(q => `<span class="search-query">${escapeHtml(q)}</span>`).join(", ")}`;
        summaryDetails.appendChild(queriesList);
    }

    summary.appendChild(summaryDetails);
    pageListContainer.appendChild(summary);

    // Add session header with date if available
    if (session && session.startTime) {
        const sessionHeader = document.createElement("div");
        sessionHeader.className = "session-detail-header";
        sessionHeader.textContent = `Session started: ${new Date(session.startTime).toLocaleString()}`;
        pageListContainer.appendChild(sessionHeader);

        // Add domain histogram if we have top domains
        if (session.topDomains && session.topDomains.length > 0) {
            const domainHistogram = document.createElement("div");
            domainHistogram.className = "domain-histogram";

            // Show top 5 domains max
            const topDomains = session.topDomains.slice(0, 5);

            topDomains.forEach(domainInfo => {
                const domainPill = document.createElement("div");
                domainPill.className = "domain-histogram-pill";

                const domainFavicon = document.createElement("img");
                domainFavicon.src = domainInfo.faviconUrl;
                domainFavicon.alt = "";
                domainFavicon.className = "domain-histogram-favicon";

                const domainName = document.createElement("span");
                domainName.textContent = domainInfo.domain;
                domainName.className = "domain-histogram-name";

                domainPill.appendChild(domainFavicon);
                domainPill.appendChild(domainName);
                domainHistogram.appendChild(domainPill);
            });

            pageListContainer.appendChild(domainHistogram);
        }
    }

    // Track the last shown time to avoid duplicates
    let lastShownTime = null;

    // Track current micro-session for visual separation
    let currentMicroSessionIndex = 0;

    sortedPages.forEach((page, index) => {
        // Check if this page starts a new micro-session
        if (page.isMicroSessionStart && index > 0) {
            // Create a micro-session separator
            const separator = document.createElement("div");
            separator.className = "micro-session-separator";

            // Add data attribute for reason-specific styling
            if (page.microSessionReason) {
                separator.dataset.reason = page.microSessionReason;
                let reasonText = "";
                switch (page.microSessionReason) {
                    case "new_window":
                        reasonText = "New Window";
                        break;
                    case "new_tab":
                        reasonText = "New Tab";
                        break;
                    case "time_gap":
                        reasonText = "Time Gap";
                        break;
                    default:
                        reasonText = "Session Break";
                }

                separator.innerHTML = `<span class="micro-session-reason">${reasonText}</span>`;
            }

            // Add the separator to the list
            const separatorItem = document.createElement("li");
            separatorItem.className = "micro-session-separator-item";
            separatorItem.appendChild(separator);
            ul.appendChild(separatorItem);

            // Increment micro-session counter
            currentMicroSessionIndex++;
        }

        const li = document.createElement("li");
        li.className = "session-page-item";

        // Add micro-session indicator if this starts a micro-session
        if (page.isMicroSessionStart) {
            li.classList.add("micro-session-start");
        }

        // Create container for favicon and domain
        const faviconDomainContainer = document.createElement("div");
        faviconDomainContainer.className = "favicon-domain-container";

        // Add favicon
        const faviconImg = document.createElement("img");
        faviconImg.className = "page-favicon-img";
        faviconImg.src = getFaviconDisplayUrl(page.url);
        faviconImg.alt = ""; // Decorative
        faviconDomainContainer.appendChild(faviconImg);

        // Add domain pill next to favicon
        try {
            const url = new URL(page.url);
            const domainPill = document.createElement("span");
            domainPill.className = "domain-pill";
            domainPill.textContent = url.hostname;
            faviconDomainContainer.appendChild(domainPill);
        } catch (e) { /* Invalid URL, skip domain pill */ }

        li.appendChild(faviconDomainContainer);

        const pageDetails = document.createElement("div");
        pageDetails.className = "page-item-details";

        // Title with optional highlight - with 4x larger font
        const titleLink = document.createElement("a");
        titleLink.href = safeUrl(page.url);
        const titleText = page.title || page.url;
        if (searchTerm && titleText.toLowerCase().includes(searchTerm)) {
            titleLink.innerHTML = highlightText(titleText, searchTerm);
        } else {
            titleLink.textContent = titleText;
        }
        titleLink.className = "page-title-link";
        titleLink.target = "_blank"; // Open in new tab
        pageDetails.appendChild(titleLink);

        // URL with optional highlight
        const urlText = document.createElement("span");
        urlText.className = "page-url-text";
        if (searchTerm && page.url.toLowerCase().includes(searchTerm)) {
            urlText.innerHTML = highlightText(page.url, searchTerm);
        } else {
            urlText.textContent = page.url;
        }
        pageDetails.appendChild(urlText);

        // Format the current page time and check if it's different from the last shown time
        const currentTime = new Date(page.visitTime);
        const timeFormatted = currentTime.toLocaleString();
        const timeKey = currentTime.getHours() + ":" + currentTime.getMinutes();

        // Only show time if it's different from the last one we showed
        if (!lastShownTime || timeKey !== lastShownTime) {
            const visitTimeText = document.createElement("span");
            visitTimeText.className = "page-visit-time";
            visitTimeText.textContent = `Visited: ${timeFormatted}`;
            pageDetails.appendChild(visitTimeText);

            // Update the last shown time
            lastShownTime = timeKey;
        }

        // Display Dwell Time
        const dwellTimeMs = parseFloat(page.dwellTimeMs || 0);
        if (dwellTimeMs > 0) {
            console.log(`[Page Render2] Page ${page.url}: dwellTimeMs = ${dwellTimeMs} (${typeof dwellTimeMs})`);
            const dwellTimeText = document.createElement("span");
            dwellTimeText.className = "page-dwell-time";
            dwellTimeText.textContent = `Dwell time: ${formatDuration(dwellTimeMs)}`;
            pageDetails.appendChild(dwellTimeText);
        }

        // Check for hero images if page has significant dwell time (≥60s)
        // Only if not already rendered elsewhere (like in the session mosaic)
        const heroImageDwellMs = parseFloat(page.dwellTimeMs || 0);
        if (heroImageDwellMs >= 60000 && !page.heroImagesRendered) {
            // Add a loading placeholder that will be replaced asynchronously
            const heroImagePlaceholder = document.createElement("div");
            heroImagePlaceholder.className = "hero-image-placeholder";
            heroImagePlaceholder.setAttribute("data-url", page.url);
            pageDetails.appendChild(heroImagePlaceholder);

            // Asynchronously load hero images
            getHeroImagesForUrl(page.url).then(heroImages => {
                if (heroImages && heroImages.length > 0) {
                    // Create a horizontal strip of thumbnails
                    const strip = document.createElement("div");
                    strip.className = "hero-image-strip";

                    // Add each thumbnail
                    heroImages.forEach((image, index) => {
                        // Skip invalid images
                        if (!image.src) return;

                        const thumb = document.createElement("img");
                        thumb.className = "hero-image-thumbnail";
                        thumb.src = image.src;
                        thumb.alt = image.alt || "";
                        thumb.dataset.index = index;

                        // Add click handler to expand image
                        thumb.addEventListener("click", (e) => {
                            e.stopPropagation(); // Prevent bubbling

                            // Find or create container for expanded image
                            let container = strip.nextElementSibling;
                            if (!container || !container.classList.contains("hero-image-container")) {
                                container = document.createElement("div");
                                container.className = "hero-image-container";
                                strip.insertAdjacentElement("afterend", container);
                            } else {
                                // Clear existing content
                                container.innerHTML = "";
                            }

                            // Create expanded image
                            const expandedImg = document.createElement("img");
                            expandedImg.className = "hero-image-expanded";
                            expandedImg.src = image.src;
                            expandedImg.alt = image.alt || "";

                            // Add close button
                            const closeBtn = document.createElement("button");
                            closeBtn.className = "hero-image-close";
                            closeBtn.textContent = "\u00d7"; // × symbol
                            closeBtn.addEventListener("click", (e) => {
                                e.stopPropagation(); // Prevent bubbling
                                container.remove();
                            });

                            container.appendChild(expandedImg);
                            container.appendChild(closeBtn);
                        });

                        strip.appendChild(thumb);
                    });

                    // Replace placeholder with actual content
                    if (strip.children.length > 0) {
                        heroImagePlaceholder.replaceWith(strip);
                    } else {
                        heroImagePlaceholder.remove();
                    }
                } else {
                    // No images found, remove placeholder
                    heroImagePlaceholder.remove();
                }
            });

            // Mark this page as having its hero images rendered
            page.heroImagesRendered = true;
        }

        // Display Referral Info
        if (page.referral) {
            const referralDiv = document.createElement("div");
            referralDiv.className = "page-referral-info";
            let referralHtml = "Referred by: ";
            if (page.referral.type === "tabOpen") {
                if (page.referral.sourceUrl) {
                    const sourceLink = document.createElement("a");
                    sourceLink.href = page.referral.sourceUrl;
                    sourceLink.textContent = page.referral.sourceUrl.length > 70 ? page.referral.sourceUrl.substring(0, 67) + "..." : page.referral.sourceUrl;
                    sourceLink.target = "_blank";
                    referralDiv.appendChild(document.createTextNode(referralHtml));
                    referralDiv.appendChild(sourceLink);
                } else {
                    referralDiv.textContent = referralHtml + "an unknown source tab";
                }
                if (page.referral.linkText) {
                    referralDiv.appendChild(document.createTextNode(` (link: "${page.referral.linkText}")`));
                }
            } else {
                // Fallback for other referral types if ever introduced
                referralDiv.textContent = referralHtml + "unknown mechanism.";
            }
            pageDetails.appendChild(referralDiv);
        }

        // Handle summary display with loading indicator for non-cached summaries
        const cachedSummary = getCachedSummary(page.url);
        const isInternalUrl = page.url.startsWith("chrome://") || page.url.startsWith("file:///");

        // Only show summary section if we have a cached summary or if URL is valid for summarization
        if (cachedSummary || !isInternalUrl) {
            const summaryDiv = document.createElement("div");
            summaryDiv.className = "page-summary";

            // Add a small label indicating this is an AI summary
            const summaryLabel = document.createElement("div");
            summaryLabel.className = "summary-label";

            if (cachedSummary) {
                summaryLabel.textContent = "AI Summary";
            } else {
                // Use a loading indicator instead of static text
                summaryLabel.innerHTML = "AI Summary <span class=\"loading-indicator\">...</span>";

                // Set up polling to check for summary availability
                const checkSummaryInterval = setInterval(() => {
                    const updatedSummary = getCachedSummary(page.url);
                    if (updatedSummary) {
                        clearInterval(checkSummaryInterval);
                        // Update the label to remove loading indicator
                        summaryLabel.textContent = "AI Summary";
                        // Create and add summary content
                        const summaryContent = document.createElement("div");
                        summaryContent.innerHTML = createTruncatedSummary(updatedSummary, searchTerm);
                        summaryDiv.appendChild(summaryContent);
                    }
                }, 2000); // Check every 2 seconds

                // Stop checking after 30 seconds to avoid resource waste
                setTimeout(() => clearInterval(checkSummaryInterval), 30000);
            }

            summaryDiv.appendChild(summaryLabel);

            // Only add content if we have a cached summary
            if (cachedSummary) {
                const summaryContent = document.createElement("div");
                summaryContent.innerHTML = createTruncatedSummary(cachedSummary, searchTerm);
                summaryDiv.appendChild(summaryContent);
            }

            pageDetails.appendChild(summaryDiv);
        }

        li.appendChild(pageDetails);

        ul.appendChild(li);
    });

    pageListContainer.appendChild(ul);
    return pageListContainer;
}

/**
 * Renders sessions in the UI
 * @param {Array} sessions - Array of session objects to render
 * @param {boolean} isRefresh - Whether this is a refresh operation
 */
async function renderSessions(sessions, isRefresh = false) {
    const container = document.getElementById("sessions-container");
    if (!container) return;

    // If not a refresh (initial load), clear the global seen hero images registry
    // This ensures a clean state for the initial session rendering
    if (!isRefresh) {
        clearSeenHeroImages();
        container.innerHTML = "<p class=\"loading-message\">Loading sessions data...</p>";
    } else {
        // If this is a refresh, show indicator and keep existing content
        const indicator = createRefreshIndicator();
        indicator.classList.add("active");
        setTimeout(() => {
            indicator.classList.remove("active");
        }, 1000);
    }

    // Always use card grid layout for sessions
    await renderSessionCards(sessions, container, isRefresh);
}

/**
 * Setup auto-refresh for sessions data
 */
function setupSessionsAutoRefresh() {
    const REFRESH_INTERVAL = 60000; // 60 seconds
    const refreshIndicator = createRefreshIndicator();

    setInterval(async () => {
        console.log("Auto-refreshing sessions data...");
        refreshIndicator.show();

        try {
            // Fetch fresh active tab information
            const activeTabUrls = await getActiveTabUrls();

            // Refresh data and render with isRefresh flag
            await refreshSessionsData(activeTabUrls);

            console.log("Sessions auto-refresh complete");
        } catch (error) {
            console.error("Error during sessions auto-refresh:", error);
        } finally {
            refreshIndicator.hide();
        }
    }, REFRESH_INTERVAL);

    // Also add a manual refresh button
    const addRefreshButton = () => {
        const existingButton = document.getElementById("manual-refresh-button");
        if (existingButton) return;

        // sessions.html uses .header-controls (the page never had a .page-header
        // element, so the previous selector silently no-op'd and the button never
        // appeared). Fall back across both selectors for safety.
        const container = document.querySelector(".header-controls")
            || document.querySelector(".app-header")
            || document.querySelector(".page-header");
        if (!container) return;

        const refreshButton = document.createElement("button");
        refreshButton.id = "manual-refresh-button";
        refreshButton.className = "refresh-button";
        refreshButton.innerHTML = "<span>↻</span> Refresh";
        refreshButton.title = "Refresh sessions data";
        refreshButton.addEventListener("click", async () => {
            refreshButton.disabled = true;
            refreshIndicator.show();

            try {
                // Fetch fresh active tab information
                const activeTabUrls = await getActiveTabUrls();

                // Refresh data and render with isRefresh flag
                await refreshSessionsData(activeTabUrls);

                console.log("Manual sessions refresh complete");
            } catch (error) {
                console.error("Error during manual sessions refresh:", error);
            } finally {
                refreshButton.disabled = false;
                refreshIndicator.hide();
            }
        });

        container.appendChild(refreshButton);
    };

    // Add refresh button when DOM is ready
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", addRefreshButton);
    } else {
        addRefreshButton();
    }
}

/**
 * Refresh sessions data and update UI
 * @param {Array} activeTabUrls - Array of URLs of active tabs
 * @returns {Promise<void>}
 */
async function refreshSessionsData(activeTabUrls) {
    try {
        // Clear the global seen hero images registry before refreshing
        // This ensures we don't carry over duplicate detection from previous renderings
        clearSeenHeroImages();

        // Get fresh data
        const { sessions } = await processSessionsData(activeTabUrls, true);
        sessionsData = sessions; // Update global sessions data
        allSessionsData = sessions; // Update all sessions data as well

        // Render the refreshed sessions
        await renderSessions(sessions, true);

        console.log("Sessions data refreshed successfully");
    } catch (error) {
        console.error("Error refreshing sessions data:", error);
    }
}

// Initialize auto-refresh when sessions view is loaded
setupSessionsAutoRefresh();
