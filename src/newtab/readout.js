import { formatDistanceToNow, formatSessionDuration, escapeHtml, safeUrl } from "./utility.js";
import { tabSearch } from "./search.js";
import { fetchRecentBookmarks, fetchRecentHistory } from "./init.js";

let readoutTimeout = null;
let currentBookmarkPage = 0;
const BOOKMARKS_PER_PAGE = 10;
let stickyCell = null;  // Track currently sticky cell

let inactivityTimer = null;
const INACTIVITY_TIMEOUT = 600000;

// Add cache for summaries at the top of the file
export const summaryCache = new Map();
const SUMMARY_CACHE_DURATION = 1000 * 60 * 5; // 5 minutes

// Add these constants at the top with other constants
const MAX_SUMMARY_LINES = 5;
const LINE_HEIGHT = 20; // Approximate height of a line in pixels

// Add at the top with other constants
export const summaryQueue = new Set();
let isProcessingQueue = false;
let queueProcessingStats = {
    totalProcessed: 0,
    totalFailed: 0,
    lastProcessed: null,
    isActive: false
};

// Queue configuration
const QUEUE_CONFIG = {
    MAX_CONCURRENT: 2,           // Process max 2 summaries at once
    MAX_QUEUE_SIZE: 50,          // Don't let queue get too large
    RETRY_DELAY: 5000,           // 5 seconds between retries
    MAX_RETRIES: 3,              // Max 3 retries per URL
    PROCESS_INTERVAL: 2000       // Check queue every 2 seconds
};

// Update the summarizer options with more specificity for on-device models
const SUMMARIZER_OPTIONS = {
    type: "headline",      // Use headline for concise summaries
    format: "plain-text",  // Keep it simple
    length: "short",       // Don't make it too verbose
    outputLanguage: "en"   // Current Summarizer API key (per developer.chrome.com/docs/ai/summarizer-api).
                           // Was 'expectedLanguage', which is not a valid option — that's what triggered
                           // Chrome's "No output language was specified" warning. Supported: de, en, es, fr, ja.
};

// Track summarizer crashes to implement backoff
let summarizerCrashCount = 0;
let lastCrashTime = 0;
const CRASH_BACKOFF_DURATION = 300000; // 5 minutes (increased from 30 seconds)
const MAX_CRASHES_BEFORE_BACKOFF = 1; // Immediate fallback after first crash

// GLOBAL DISABLE: Prevent all Summarizer API calls to stop crashes entirely
let globalSummarizerDisabled = false; // START ENABLED but will disable on first crash
let crashMessageCount = 0;
const GLOBAL_DISABLE_DURATION = 600000; // 10 minutes

// Allow manual re-enable via console for testing
window.enableSummarizer = function () {
    globalSummarizerDisabled = false;
    console.log("🔄 Summarizer manually re-enabled for testing");
    updateSummarizerStatus();
};

window.disableSummarizer = function () {
    globalSummarizerDisabled = true;
    console.log("🚫 Summarizer manually disabled");
    updateSummarizerStatus();
};

// Show summarizer status to users
function updateSummarizerStatus() {
    const status = globalSummarizerDisabled ? "DISABLED (prevents crashes)" : "ENABLED";
    console.log(`📊 Summarizer Status: ${status}`);
}

// Show initial status
updateSummarizerStatus();

// EMERGENCY: Global error handler to prevent app crashes
window.addEventListener("error", function (event) {
    if (event.error && event.error.message && event.error.message.includes("summarizer")) {
        console.error("🚨 Summarizer-related error caught, disabling API:", event.error);
        globalSummarizerDisabled = true;
        updateSummarizerStatus();
        event.preventDefault();
        return false;
    }
});

window.addEventListener("unhandledrejection", function (event) {
    if (event.reason && String(event.reason).toLowerCase().includes("summarizer")) {
        console.error("🚨 Summarizer-related promise rejection caught, disabling API:", event.reason);
        globalSummarizerDisabled = true;
        updateSummarizerStatus();
        event.preventDefault();
    }
});

// Check if global crash state is available from newtab.html
if (typeof window !== "undefined" && window.summarizerCrashState) {
    // Use the global state that was set up during page load
    Object.defineProperty(window, "globalSummarizerDisabled", {
        get() { return window.summarizerCrashState.disabled; }
    });
    Object.defineProperty(window, "crashMessageCount", {
        get() { return window.summarizerCrashState.crashCount; }
    });

    console.log("✅ Connected to global crash suppression system");
} else {
    console.warn("⚠️ Global crash suppression not available, using local fallback");
}

// Utility function to extract and clean words from a URL for better search recall
function extractWordsFromUrl(url) {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname;
        const path = urlObj.pathname;

        // Extract domain parts (e.g., 'example' and 'com' from example.com)
        const domainParts = hostname.split(".");

        // Extract path parts and filter out empty parts
        const pathParts = path.split(/[\/\-_.]/).filter(part => part.length > 0);

        // Combine and filter out common words and very short parts
        const allParts = [...domainParts, ...pathParts].filter(part => {
            return part.length > 2 &&
                !["www", "com", "org", "net", "io", "html", "php", "asp", "jsp"].includes(part);
        });

        // Split CamelCase and kebab-case words
        const expandedParts = [];
        allParts.forEach(part => {
            // Split by camelCase
            const camelSplit = part.replace(/([a-z])([A-Z])/g, "$1 $2");
            // Add original and split versions
            expandedParts.push(part);
            if (camelSplit !== part) expandedParts.push(camelSplit);
        });

        return expandedParts;
    } catch (e) {
        console.log("Error extracting words from URL:", e);
        return [];
    }
}

// Add at the top with other state variables
let lastDisplayedNodeId = null;

// Helper function to get domain from URL
function getDomain(url) {
    if (!url) return "Unknown";
    try {
        const parsedUrl = new URL(url);
        return parsedUrl.hostname;
    } catch (e) {
        console.warn("Invalid URL:", url);
        return "Unknown";
    }
}

// Add this helper function for formatting URLs
function formatUrlForDisplay(url) {
    if (!url) return "";

    // Remove http://, https://, and www.
    return url
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "");
}

const ITEMS_PER_PAGE = 5;

function resetInactivityTimer(categorizedDataCache) {
    // Don't set timer if we're in sticky state
    if (stickyCell) {
        return;
    }

    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
        showDefaultReadout(categorizedDataCache);
    }, INACTIVITY_TIMEOUT);
}

// Function to search bookmarks for a specific domain
async function searchBookmarksForTab(url) {
    try {
        // Extract domain from the URL
        const domain = getDomain(url);
        if (domain === "Unknown") {
            return [];
        }

        // Search by domain instead of tab ID
        const bookmarks = await new Promise((resolve, reject) => {
            chrome.bookmarks.search({ query: domain }, (results) => {
                if (chrome.runtime.lastError) {
                    return reject(chrome.runtime.lastError);
                }
                resolve(results);
            });
        });

        // Further filter to ensure domain match
        const filteredBookmarks = bookmarks.filter(bookmark => {
            try {
                return getDomain(bookmark.url) === domain;
            } catch (e) {
                return false;
            }
        });

        console.log("Bookmarks for domain:", domain, filteredBookmarks);
        return filteredBookmarks;
    } catch (error) {
        console.error("Error searching bookmarks for domain:", url, error);
        return [];
    }
}

// Function to search history for a specific domain
async function searchHistoryForTab(url) {
    try {
        // Extract domain from the URL
        const domain = getDomain(url);
        if (domain === "Unknown") {
            return [];
        }

        // Search by domain instead of tab ID
        const historyItems = await chrome.history.search({
            text: domain,
            maxResults: 10,
            // Only search last 90 days to prevent hanging on massive history DBs
            startTime: Date.now() - (90 * 24 * 60 * 60 * 1000)
        });

        // Further filter to ensure domain match
        const filteredHistory = historyItems.filter(item => {
            try {
                return getDomain(item.url) === domain;
            } catch (e) {
                return false;
            }
        });

        console.log("History for domain:", domain, filteredHistory);
        return filteredHistory;
    } catch (error) {
        console.error("Error searching history for domain:", url, error);
        return [];
    }
}

async function getTabContent(url) {
    try {
        console.log("🔍 Starting content extraction for:", url);

        if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("file://")) {
            console.log("⏭️ Skipping content extraction for restricted URL:", url);
            return null;
        }

        // **NEW: Try background worker first (bypasses many content blocks)**
        try {
            const workerContent = await getContentFromWorker(url);
            if (workerContent && workerContent.length > 50) {
                console.log(`✅ Worker extracted ${workerContent.length} characters for ${url}`);
                return workerContent;
            }
        } catch (workerError) {
            console.warn("🔧 Worker extraction failed, trying direct approach:", workerError.message);
        }

        // **FALLBACK: Try direct content script approach**
        console.log("📄 Trying direct content script approach for:", url);

        // Try multiple strategies to find the tab
        let tabs = await chrome.tabs.query({ url });

        // If exact URL match fails, try domain-based search
        if (!tabs || tabs.length === 0) {
            try {
                const urlObj = new URL(url);
                const domain = urlObj.hostname;
                const allTabs = await chrome.tabs.query({});
                tabs = allTabs.filter(tab => {
                    try {
                        return tab.url && new URL(tab.url).hostname === domain;
                    } catch (e) {
                        return false;
                    }
                });

                if (tabs.length > 0) {
                    console.log(`🔍 Found ${tabs.length} tabs for domain ${domain}, using first match`);
                }
            } catch (e) {
                console.warn("Error in domain-based tab search:", e);
            }
        }

        if (!tabs || tabs.length === 0) {
            console.log("📚 No matching tab found for URL, trying metadata extraction:", url);
            return await getContentFromMetadata(url);
        }

        try {
            const tab = tabs[0];
            console.log("🎯 Targeting tab for content extraction:", tab.id, tab.url);

            // Enhanced content extraction script
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    try {
                        console.log("📄 Content script executing in tab");

                        // Multiple extraction strategies
                        let content = "";

                        // Strategy 1: Try to get main content areas
                        const mainSelectors = [
                            "main", "article", "[role=\"main\"]",
                            ".content", ".post-content", ".entry-content",
                            "#content", "#main-content"
                        ];

                        for (const selector of mainSelectors) {
                            const element = document.querySelector(selector);
                            if (element && element.innerText.trim().length > 200) {
                                content = element.innerText.trim();
                                console.log(`✅ Found content via ${selector}: ${content.length} chars`);
                                break;
                            }
                        }

                        // Strategy 2: Fallback to body with filtering
                        if (!content && document.body) {
                            console.log("📝 Trying body traversal");

                            const walker = document.createTreeWalker(
                                document.body,
                                NodeFilter.SHOW_TEXT,
                                {
                                    acceptNode: (node) => {
                                        const parent = node.parentElement;
                                        if (!parent) return NodeFilter.FILTER_REJECT;

                                        // Skip hidden elements
                                        const style = window.getComputedStyle(parent);
                                        if (style.display === "none" || style.visibility === "hidden") {
                                            return NodeFilter.FILTER_REJECT;
                                        }

                                        // Skip script and style tags
                                        const tag = parent.tagName.toLowerCase();
                                        if (["script", "style", "noscript"].includes(tag)) {
                                            return NodeFilter.FILTER_REJECT;
                                        }

                                        return NodeFilter.FILTER_ACCEPT;
                                    }
                                }
                            );

                            let textContent = "";
                            let node;
                            let counter = 0;
                            const maxNodes = 5000;

                            while ((node = walker.nextNode()) && counter < maxNodes) {
                                const text = node.textContent.trim();
                                if (text && text.length > 3) { // Filter out very short text
                                    textContent += text + " ";
                                }
                                counter++;
                            }

                            content = textContent.trim();
                            console.log(`📝 Body traversal found ${content.length} chars from ${counter} nodes`);
                        }

                        // Strategy 3: Get page title and meta description as fallback
                        if (!content || content.length < 100) {
                            console.log("🏷️ Trying metadata extraction");

                            const title = document.title || "";
                            const metaDesc = document.querySelector("meta[name=\"description\"]")?.content || "";
                            const h1 = document.querySelector("h1")?.innerText || "";

                            content = [title, h1, metaDesc].filter(Boolean).join(". ");
                            console.log(`🏷️ Metadata extraction: ${content.length} chars`);
                        }

                        return content || null;

                    } catch (err) {
                        console.error("💥 Content extraction error:", err);
                        return null;
                    }
                }
            });

            const extractedContent = results?.[0]?.result;

            if (extractedContent && extractedContent.trim().length > 50) {
                console.log(`✅ Direct extraction successful: ${extractedContent.length} characters from ${url}`);
                return extractedContent;
            } else {
                console.log(`⚠️ Direct extraction insufficient (${extractedContent?.length || 0} chars), trying metadata fallback`);
                return await getContentFromMetadata(url);
            }

        } catch (scriptError) {
            console.warn("🚫 Content script injection failed:", scriptError.message);
            return await getContentFromMetadata(url);
        }
    } catch (error) {
        console.error("💥 Error in getTabContent:", error);
        return await getContentFromMetadata(url);
    }
}

// Enhanced content extraction using background worker
async function getContentFromWorker(url) {
    try {
        console.log("🔧 Requesting content extraction from background worker for:", url);

        const response = await chrome.runtime.sendMessage({
            action: "extractContent",
            url: url
        });

        if (response && response.success && response.content) {
            console.log(`✅ Worker extracted ${response.content.length} characters for ${url}`);
            return response.content;
        } else {
            console.log(`⚠️ Worker extraction failed: ${response?.error || "Unknown error"}`);
            return null;
        }

    } catch (error) {
        console.error("💥 Error communicating with background worker:", error);
        return null;
    }
}

// Enhanced metadata-based content extraction
async function getContentFromMetadata(url) {
    try {
        console.log("Attempting metadata-based content extraction for:", url);

        // Get history data for this URL
        const historyItems = await chrome.history.search({
            text: url,
            maxResults: 1
        });

        // Get bookmarks for this URL
        const bookmarks = await chrome.bookmarks.search({ url });

        let content = "";

        // Extract from history
        if (historyItems.length > 0) {
            const item = historyItems[0];
            if (item.title && item.title !== "New Tab" && item.title.length > 3) {
                content += item.title + ". ";
            }
        }

        // Extract from bookmarks
        if (bookmarks.length > 0) {
            const bookmark = bookmarks[0];
            if (bookmark.title && bookmark.title !== "New Tab" && bookmark.title.length > 3) {
                content += bookmark.title + ". ";
            }
        }

        // Extract meaningful information from URL structure
        try {
            const urlObj = new URL(url);
            const pathname = urlObj.pathname;
            const searchParams = urlObj.searchParams;

            // Extract search queries
            const searchQuery = searchParams.get("q") || searchParams.get("query") || searchParams.get("search");
            if (searchQuery) {
                content += `Search query: ${decodeURIComponent(searchQuery)}. `;
            }

            // Extract meaningful path segments
            const pathSegments = pathname.split("/").filter(segment =>
                segment.length > 2 &&
                !["www", "com", "org", "net", "html", "php", "asp", "jsp"].includes(segment.toLowerCase())
            );

            if (pathSegments.length > 0) {
                const cleanSegments = pathSegments.map(segment =>
                    segment.replace(/[-_]/g, " ").replace(/\.[a-z]+$/i, "")
                ).join(" ");
                content += `Page content related to: ${cleanSegments}. `;
            }

            // Add domain context
            const domain = urlObj.hostname.replace(/^www\./, "");
            content += `This is a page from ${domain}. `;

        } catch (e) {
            console.warn("Error parsing URL for metadata:", e);
        }

        // If we still have minimal content, create a more descriptive fallback
        if (content.trim().length < 50) {
            const domain = getDomain(url);
            const urlWords = extractWordsFromUrl(url);

            if (urlWords.length > 0) {
                const keyTerms = urlWords.slice(0, 5).join(", ");
                content = `This is a webpage from ${domain} that appears to be related to ${keyTerms}. The page contains content about these topics that may be useful for understanding the subject matter.`;
            } else {
                content = `This is a webpage from ${domain}. While the specific content cannot be extracted, it likely contains information relevant to the site's topic and purpose.`;
            }
        }

        console.log(`📄 Generated metadata-based content (${content.length} chars):`, content.substring(0, 100) + "...");
        return content.trim();

    } catch (error) {
        console.error("Error in metadata extraction:", error);
        // Final fallback - return something that won't get filtered out
        const domain = getDomain(url);
        return `This is a webpage from ${domain} that contains content that could not be directly extracted due to technical limitations, but likely contains relevant information about the topic or subject matter of the site.`;
    }
}

// Add cache management functions
export function getCachedSummary(url) {
    const cached = summaryCache.get(url);
    if (!cached) return null;

    // Check if cache is still valid
    if (Date.now() - cached.timestamp > SUMMARY_CACHE_DURATION) {
        summaryCache.delete(url);
        return null;
    }

    return cached.summary;
}

/**
 * Add URL to summary queue with size limits and validation
 * @param {string} url - The URL to add to the queue
 * @returns {boolean} - Whether the URL was successfully added
 */
export function addToSummaryQueue(url) {
    if (!url || typeof url !== "string") {
        console.warn("Invalid URL provided to summary queue:", url);
        return false;
    }

    // Check if summarizer is globally disabled (but allow queue addition for fallbacks)
    if (globalSummarizerDisabled) {
        console.log("ℹ️ Summarizer disabled - will use fallback for:", url);
        // Still add to queue, but processSummaryQueue will use fallbacks
    }

    // Check if already in queue
    if (summaryQueue.has(url)) {
        console.log(`⏭️ URL already in queue: ${url}`);
        return false;
    }

    // Check if already cached
    if (getCachedSummary(url)) {
        console.log(`⏭️ URL already cached: ${url}`);
        return false;
    }

    // Check queue size limit
    if (summaryQueue.size >= QUEUE_CONFIG.MAX_QUEUE_SIZE) {
        console.warn(`⚠️ Queue full (${summaryQueue.size}/${QUEUE_CONFIG.MAX_QUEUE_SIZE}), dropping oldest item`);
        // Remove oldest item (first in Set)
        const firstItem = summaryQueue.values().next().value;
        summaryQueue.delete(firstItem);
    }

    // Add to queue
    summaryQueue.add(url);
    console.log(`📋 Added to queue: ${url} (${summaryQueue.size}/${QUEUE_CONFIG.MAX_QUEUE_SIZE})`);

    // Trigger processing if not already running
    if (!isProcessingQueue) {
        setTimeout(() => {
            processSummaryQueue().catch(console.error);
        }, 100); // Small delay to batch multiple additions
    }

    return true;
}

/**
 * Get queue statistics for debugging and monitoring
 * @returns {Object} - Queue statistics
 */
export function getQueueStats() {
    return {
        queueSize: summaryQueue.size,
        isProcessing: isProcessingQueue,
        stats: { ...queueProcessingStats },
        config: { ...QUEUE_CONFIG }
    };
}

/**
 * Clear the summary queue
 */
export function clearSummaryQueue() {
    const size = summaryQueue.size;
    summaryQueue.clear();
    console.log(`🗑️ Cleared summary queue (${size} items)`);
}

/**
 * Reset summarizer crash counter (useful for debugging)
 */
export function resetSummarizerCrashCounter() {
    summarizerCrashCount = 0;
    lastCrashTime = 0;
    globalSummarizerDisabled = false;
    crashMessageCount = 0;
    console.log("🔄 Summarizer crash counter and global disable state reset");
}

/**
 * Get summarizer status including crash information
 */
export function getSummarizerStatus() {
    const now = Date.now();
    const inBackoff = summarizerCrashCount >= MAX_CRASHES_BEFORE_BACKOFF &&
        (now - lastCrashTime) < CRASH_BACKOFF_DURATION;
    const backoffRemaining = inBackoff ?
        Math.max(0, Math.ceil((CRASH_BACKOFF_DURATION - (now - lastCrashTime)) / 1000)) : 0;

    return {
        crashCount: summarizerCrashCount,
        maxCrashes: MAX_CRASHES_BEFORE_BACKOFF,
        inBackoff,
        backoffRemainingSeconds: backoffRemaining,
        lastCrashTime: lastCrashTime ? new Date(lastCrashTime).toISOString() : null,
        globallyDisabled: globalSummarizerDisabled,
        crashMessageCount: crashMessageCount,
        globalDisableDuration: GLOBAL_DISABLE_DURATION
    };
}

/**
 * Flushes all summary caches (both in-memory and Redux state)
 * Call this when you want to force re-generation of summaries
 * @param {boolean} notifyState - Whether to notify the state system to clear summaries
 */
export function flushSummaryCache(notifyState = true) {
    console.log("Flushing summary cache");

    // Clear the in-memory cache
    summaryCache.clear();

    // Clear the queue
    clearSummaryQueue();

    // Clear persisted nano summaries from storage
    chrome.storage.local.remove(["nanoSummaries"], () => {
        if (chrome.runtime.lastError) {
            console.error("Error clearing nano summaries from storage:", chrome.runtime.lastError);
        } else {
            console.log("✅ Cleared nano summaries from storage");
        }
    });

    // Optionally clear the summaries in Redux state
    if (notifyState && window.browserState) {
        // Dispatch an action to clear state summaries
        window.browserState.clearSummaries();
    }
}

function cacheSummary(url, summary) {
    summaryCache.set(url, {
        summary,
        timestamp: Date.now()
    });

    // Add summary to search index if the function exists
    if (typeof tabSearch.addSummaryToIndex === "function") {
        tabSearch.addSummaryToIndex(url, summary);
    }

    // Persist summary to storage for persistence across browser restarts
    persistSummaryToStorage(url, summary);
}

/**
 * Persist summary to chrome.storage.local for persistence across browser restarts
 * @param {string} url - The URL the summary is for
 * @param {string} summary - The summary text
 */
async function persistSummaryToStorage(url, summary) {
    try {
        // Get existing summaries from storage
        const result = await chrome.storage.local.get(["nanoSummaries"]);
        const summaries = result.nanoSummaries || {};

        // Add new summary
        summaries[url] = {
            summary,
            timestamp: Date.now(),
            source: "chrome-summarizer"
        };

        // Save back to storage
        await chrome.storage.local.set({ nanoSummaries: summaries });
        console.log(`✅ Persisted nano summary for ${url}`);

    } catch (error) {
        console.error("Error persisting nano summary:", error);
    }
}

/**
 * Load nano summaries from storage on startup
 * This ensures summaries are available after browser restart
 */
export async function loadNanoSummariesFromStorage() {
    try {
        const result = await chrome.storage.local.get(["nanoSummaries"]);
        const summaries = result.nanoSummaries || {};

        console.log(`Loading ${Object.keys(summaries).length} nano summaries from storage...`);

        // Add to in-memory cache
        Object.entries(summaries).forEach(([url, data]) => {
            summaryCache.set(url, {
                summary: data.summary,
                timestamp: data.timestamp
            });

            // Add to search index if available
            if (typeof tabSearch.addSummaryToIndex === "function") {
                tabSearch.addSummaryToIndex(url, data.summary);
            }
        });

        console.log(`✅ Loaded ${Object.keys(summaries).length} nano summaries from storage`);

    } catch (error) {
        console.error("Error loading nano summaries from storage:", error);
    }
}

// Generate a fallback summary based on URL structure and visit metrics
async function generateVisitMetricFallback(url) {
    try {
        console.log("Generating fallback summary for:", url);

        // Extract meaningful words from the URL
        const urlWords = extractWordsFromUrl(url);
        console.log("Extracted URL words:", urlWords);

        // Get history metrics for this URL/domain
        const historyItems = await searchHistoryForTab(url);

        // Extract basic URL info
        let domain = "unknown";
        let pathname = "";
        let pageType = "";

        try {
            const urlObj = new URL(url);
            domain = urlObj.hostname;
            pathname = urlObj.pathname;

            // Try to identify page type from path
            if (pathname.includes("/article/") || pathname.includes("/post/")) {
                pageType = "article";
            } else if (pathname.includes("/product/")) {
                pageType = "product";
            } else if (pathname.includes("/category/") || pathname.includes("/tag/")) {
                pageType = "category";
            } else if (pathname.endsWith(".pdf")) {
                pageType = "PDF document";
            } else if (pathname === "/" || pathname === "") {
                pageType = "homepage";
            }
        } catch (e) { /* ignore parsing errors */ }

        // Construct a meaningful fallback message
        const visitCount = historyItems.length;
        const pluralVisits = visitCount === 1 ? "visit" : "visits";

        // Create informative summary based on available data
        let summary;

        if (visitCount > 0) {
            // With history data
            if (urlWords.length > 0) {
                const keyTerms = urlWords.slice(0, 3).join(", ");
                summary = `${domain} page about ${keyTerms} (${visitCount} previous ${pluralVisits})`;
            } else {
                summary = `${domain} ${pageType || "page"} with ${visitCount} previous ${pluralVisits}`;
            }
        } else {
            // No history data
            if (urlWords.length > 0) {
                const keyTerms = urlWords.slice(0, 3).join(", ");
                summary = `${domain} page related to ${keyTerms}`;
            } else {
                summary = `${domain} ${pageType || "page"} (content not available for summarization)`;
            }
        }

        return summary;
    } catch (error) {
        console.error("Error generating fallback summary:", error);
        return "Page content not available for summarization";
    }
}

// Enhanced queue processing with rate limiting and error recovery
export async function processSummaryQueue() {
    if (isProcessingQueue) {
        console.log("Queue processing already in progress, skipping...");
        return;
    }

    // If summarizer is globally disabled, process queue with fallbacks only
    if (globalSummarizerDisabled) {
        console.log("ℹ️ Summarizer disabled - processing queue with fallbacks only");
    }

    isProcessingQueue = true;
    queueProcessingStats.isActive = true;

    console.log(`🔄 Starting queue processing with ${summaryQueue.size} items`);

    try {
        // Don't clear the queue immediately - process items one by one
        const urls = Array.from(summaryQueue);

        // Process URLs in batches to avoid overwhelming the system
        for (let i = 0; i < urls.length; i += QUEUE_CONFIG.MAX_CONCURRENT) {
            const batch = urls.slice(i, i + QUEUE_CONFIG.MAX_CONCURRENT);

            console.log(`Processing batch ${Math.floor(i / QUEUE_CONFIG.MAX_CONCURRENT) + 1}: ${batch.length} URLs`);

            // Process batch concurrently but with individual error handling
            const batchPromises = batch.map(async (url) => {
                try {
                    // Remove from queue immediately to prevent reprocessing
                    summaryQueue.delete(url);

                    // Skip if already cached
                    if (getCachedSummary(url)) {
                        console.log(`⏭️ Skipping ${url} - already cached`);
                        return;
                    }

                    // Skip chrome URLs
                    if (url.startsWith("chrome://") || url.startsWith("chrome-extension://")) {
                        console.log(`⏭️ Skipping chrome URL: ${url}`);
                        return;
                    }

                    console.log(`📝 Generating summary for: ${url}`);
                    const summary = await summarizeUrl(url);

                    if (summary) {
                        cacheSummary(url, summary);
                        queueProcessingStats.totalProcessed++;
                        queueProcessingStats.lastProcessed = Date.now();

                        console.log(`✅ Summary generated for: ${url}`);

                        // Update current readout if it's showing this URL
                        updateReadoutIfNeeded(url, summary);
                    } else {
                        console.log(`⚠️ No summary generated for: ${url}`);
                        queueProcessingStats.totalFailed++;
                    }
                } catch (error) {
                    console.error(`❌ Error generating summary for ${url}:`, error);
                    queueProcessingStats.totalFailed++;

                    // Don't re-add to queue immediately - could cause infinite loops
                    // Instead, we'll let the user retry manually or through other mechanisms
                }
            });

            // Wait for batch to complete before processing next batch
            await Promise.allSettled(batchPromises);

            // Small delay between batches to be nice to the system
            if (i + QUEUE_CONFIG.MAX_CONCURRENT < urls.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        console.log(`✅ Queue processing complete. Processed: ${queueProcessingStats.totalProcessed}, Failed: ${queueProcessingStats.totalFailed}`);

    } catch (error) {
        console.error("❌ Critical error in queue processing:", error);
    } finally {
        isProcessingQueue = false;
        queueProcessingStats.isActive = false;

        // If more items were added during processing, schedule another run
        if (summaryQueue.size > 0) {
            console.log(`🔄 ${summaryQueue.size} items remaining, scheduling next run...`);
            setTimeout(() => {
                processSummaryQueue().catch(console.error);
            }, QUEUE_CONFIG.PROCESS_INTERVAL);
        }
    }
}

/**
 * Update readout if it's currently showing the URL that just got a summary
 * @param {string} url - The URL that was summarized
 * @param {string} summary - The generated summary
 */
function updateReadoutIfNeeded(url, summary) {
    try {
        const readout = document.getElementById("readout");
        const summaryContent = document.getElementById("summary-content");
        const currentUrl = readout?.querySelector(".readout-url")?.textContent;

        if (summaryContent && currentUrl && formatUrlForDisplay(url) === currentUrl) {
            summaryContent.innerHTML = createTruncatedSummary(summary);
            console.log(`🔄 Updated readout for: ${url}`);
        }
    } catch (error) {
        console.error("Error updating readout:", error);
    }
}

// Update summarizeUrl to use the Chrome Summarizer API correctly
async function summarizeUrl(url) {
    // NUCLEAR SAFETY: Wrap entire function in try-catch to prevent app crashes
    try {
        // Skip restricted URLs
        if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("file://")) {
            console.log("Skipping summary for restricted URL:", url);
            return null;
        }

        // Check for crash backoff (now triggers after 1 crash)
        const now = Date.now();

        // Check global crash state first
        const isGloballyDisabled = (typeof window !== "undefined" && window.summarizerCrashState)
            ? window.summarizerCrashState.disabled
            : globalSummarizerDisabled;

        if (isGloballyDisabled) {
            console.log(`🚫 Summarizer globally disabled due to repeated crashes. Using fallback: ${url}`);
            return await generateVisitMetricFallback(url);
        }

        if (summarizerCrashCount >= MAX_CRASHES_BEFORE_BACKOFF &&
            (now - lastCrashTime) < CRASH_BACKOFF_DURATION) {
            console.log(`⚠️ Summarizer in backoff mode due to crashes. Skipping: ${url}`);
            return await generateVisitMetricFallback(url);
        }

        // Check if summarizer is globally disabled first
        if (globalSummarizerDisabled) {
            console.log("🚫 Summarizer disabled - using fallback:", url);
            return await generateVisitMetricFallback(url);
        }

        // Enhanced API availability check with crash pre-detection
        if (!window.Summarizer) {
            console.log("Chrome Summarizer API not available in this browser");
            return await generateVisitMetricFallback(url);
        }

        // Pre-emptively check for crashes before trying to use the API
        let availability;
        try {
            availability = await Promise.race([
                window.Summarizer.availability(SUMMARIZER_OPTIONS),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Availability check timeout")), 5000))
            ]);
            console.log("Summarizer availability:", availability);
        } catch (availError) {
            console.warn("Summarizer availability check failed:", availError.message);
            if (availError.message.includes("crashed") || availError.message.includes("timeout")) {
                globalSummarizerDisabled = true;
                console.log("🚫 Pre-emptively disabling summarizer due to availability check failure");
                setTimeout(() => {
                    globalSummarizerDisabled = false;
                }, GLOBAL_DISABLE_DURATION);
            }
            return await generateVisitMetricFallback(url);
        }

        // Handle all availability states properly
        if (availability === "unavailable") {
            console.log("Summarizer API not usable on this system");
            return await generateVisitMetricFallback(url);
        }

        if (availability === "downloadable") {
            console.log("Summarizer model needs to be downloaded first");
            return await generateVisitMetricFallback(url);
        }

        if (availability !== "available") {
            console.log("Summarizer not in available state:", availability);
            return await generateVisitMetricFallback(url);
        }

        // Get tab content with enhanced validation
        const content = await getTabContent(url);

        // Enhanced content validation - more lenient now that we have better content extraction
        if (!content || content.trim().length < 50) { // Lowered back to 50 since we have better extraction
            console.log("Insufficient content available to summarize for URL:", url,
                `(length: ${content?.length || 0})`);
            return await generateVisitMetricFallback(url);
        }

        // Filter and prepare content
        const filteredContent = content
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, "")
            .replace(/<object[^>]*>[\s\S]*?<\/object>/gi, "")
            .replace(/<embed[^>]*>/gi, "")
            .replace(/<applet[^>]*>[\s\S]*?<\/applet>/gi, "")
            .replace(/[^\x00-\x7F]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        // Final content length check - more lenient
        if (filteredContent.length < 50) {
            console.log("Content too short after filtering, using fallback summary");
            return await generateVisitMetricFallback(url);
        }

        // Trim to API limits
        const MAX_CONTENT_LENGTH = 12000;
        let trimmedContent = filteredContent;
        if (filteredContent.length > MAX_CONTENT_LENGTH) {
            const firstPart = Math.floor(MAX_CONTENT_LENGTH * 0.7);
            const lastPart = MAX_CONTENT_LENGTH - firstPart;
            trimmedContent = filteredContent.substring(0, firstPart) +
                "\n[...content trimmed...]\n" +
                filteredContent.substring(filteredContent.length - lastPart);
        }

        // Initialize summarizer with proper error handling and timeout
        let summarizer;
        try {
            // Check for user activation before creating summarizer
            if (!navigator.userActivation.isActive) {
                console.log("No user activation, using fallback summary");
                return await generateVisitMetricFallback(url);
            }

            // Wrap summarizer creation in timeout to prevent hanging
            summarizer = await Promise.race([
                window.Summarizer.create({
                    ...SUMMARIZER_OPTIONS,
                    monitor(m) {
                        m.addEventListener("downloadprogress", (e) => {
                            console.log(`Downloading summarizer model: ${Math.round(e.loaded * 100)}%`);
                        });
                    }
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Summarizer creation timeout")), 10000))
            ]);

            // Wait for model to be ready with timeout
            if (summarizer.ready) {
                await Promise.race([
                    summarizer.ready,
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Summarizer ready timeout")), 5000))
                ]);
            }

            // Extract context information
            let domain = "unknown";
            let pageTitle = "";

            try {
                const urlObj = new URL(url);
                domain = urlObj.hostname;

                const titleMatch = trimmedContent.match(/<title>([^<]+)<\/title>/) ||
                    trimmedContent.match(/^([^\n]{10,100})\n/) ||
                    /<h1[^>]*>([^<]+)<\/h1>/i.exec(trimmedContent);
                if (titleMatch) {
                    pageTitle = titleMatch[1].trim();
                }
            } catch (e) { /* ignore URL parsing errors */ }

            // Create context prompt
            const contextPrompt = `Summarize this webpage${pageTitle ? " about \"" + pageTitle + "\"" : ""} from ${domain} in one concise sentence. ` +
                "Focus on the main topic and key information. " +
                "Include what makes this page unique or valuable to the reader. " +
                "Ensure your summary is factual, informative, and directly based on the content.";

            // FIXED: Proper API call syntax with timeout protection
            console.log("Generating summary for:", url, `(content length: ${trimmedContent.length})`);
            const summary = await Promise.race([
                summarizer.summarize(trimmedContent, {
                    context: contextPrompt
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Summarizer execution timeout")), 15000))
            ]);

            // Success - reset crash count
            if (summary && summary.trim()) {
                summarizerCrashCount = 0;
                console.log("✅ Summarizer crash count reset - successful summary generated");
                console.log("📝 AI Summary generated:", summary.substring(0, 100) + "...");
                return summary;
            } else {
                console.warn("Summarizer returned empty result");
                return await generateVisitMetricFallback(url);
            }

        } catch (error) {
            console.error("Error during summarization:", error);

            // Enhanced crash detection with global disable
            if (error.message && (
                error.message.includes("crashed") ||
                error.message.includes("quota") ||
                error.message.includes("failed") ||
                error.message.includes("too many times"))) {

                summarizerCrashCount++;
                lastCrashTime = Date.now();
                console.warn(`🚨 Summarizer crash detected (${summarizerCrashCount}/${MAX_CRASHES_BEFORE_BACKOFF}): ${error.message}`);

                // Immediately disable after first crash to prevent spam
                if (summarizerCrashCount >= MAX_CRASHES_BEFORE_BACKOFF) {
                    console.warn(`⚠️ Entering backoff mode for ${CRASH_BACKOFF_DURATION / 1000} seconds`);
                }

                // Global disable if we detect the "too many times" error
                if (error.message.includes("too many times")) {
                    globalSummarizerDisabled = true;
                    console.error(`🚫 GLOBALLY DISABLING Summarizer due to repeated crashes. Will re-enable in ${GLOBAL_DISABLE_DURATION / 60000} minutes`);

                    // Re-enable after the global disable duration
                    setTimeout(() => {
                        globalSummarizerDisabled = false;
                        summarizerCrashCount = 0;
                        lastCrashTime = 0;
                        console.log("✅ Summarizer globally re-enabled after cooldown period");
                    }, GLOBAL_DISABLE_DURATION);
                }
            }

            return await generateVisitMetricFallback(url);
        } finally {
            // Clean up summarizer instance
            if (summarizer && typeof summarizer.destroy === "function") {
                try {
                    summarizer.destroy();
                } catch (e) {
                    console.warn("Error destroying summarizer:", e);
                }
            }
        }
    } catch (error) {
        console.error("Error in summarizeUrl function:", error);
        return await generateVisitMetricFallback(url);
    }
}

// Add this helper function for summary display
export function createTruncatedSummary(summary) {
    if (!summary) return "";

    const lines = summary.split("\n");
    const isTruncated = lines.length > MAX_SUMMARY_LINES;

    const truncatedText = isTruncated
        ? lines.slice(0, MAX_SUMMARY_LINES).join("\n")
        : summary;

    // Render truncated text safely (\n → <br>, all other HTML chars escaped)
    const truncatedHtml = escapeHtml(truncatedText.trim()).replace(/\n/g, "<br>");

    if (!isTruncated) {
        return `<div class="summary-content"><div class="summary-text" style="line-height: ${LINE_HEIGHT}px">${truncatedHtml}</div></div>`;
    }

    // Full summary stashed in data-* so the show-more handler can read it back
    // unambiguously (the previous inline template-literal approach broke when
    // the summary contained backticks, quotes, or backslashes).
    const fullAttr = escapeHtml(summary);
    const expandHandler = "(function(b){var p=document.createElement('pre');p.style.whiteSpace='pre-wrap';p.style.margin='0';p.textContent=b.dataset.fullSummary;b.parentElement.parentElement.replaceChildren(p);})(this)";

    return `<div class="summary-content"><div class="summary-text" style="line-height: ${LINE_HEIGHT}px">${truncatedHtml}</div><div class="summary-expand"><button class="show-more-btn" data-full-summary="${fullAttr}" onclick="${expandHandler}">Show more...</button></div></div>`;
}

// Update displayReadout to queue summaries instead of generating them immediately
export async function displayReadout(d, event) {
    // Clear existing timeout
    if (readoutTimeout) {
        clearTimeout(readoutTimeout);
    }

    // Normalize data structure
    const nodeData = d?.data || d;
    if (!nodeData) {
        console.error("Node data is undefined or null");
        return;
    }

    // Check if this is the same node we're already displaying
    const currentNodeId = nodeData.id || `${nodeData.windowId}-${nodeData.index}`;
    if (currentNodeId === lastDisplayedNodeId) {
        return; // same node already displayed — nothing to do
    }
    lastDisplayedNodeId = currentNodeId;

    // Make sure we have a URL to work with
    const url = nodeData.url || "";
    if (!url) {
        console.error("No URL available to search");
        return;
    }

    // These are independent Chrome lookups. Resolve them together so the
    // domain context appears as quickly as the slower of the two, not their sum.
    const [bookmarks, history] = await Promise.all([
        searchBookmarksForTab(url),
        searchHistoryForTab(url)
    ]);

    // Abort if the user hovered over a different cell while we were fetching
    if (lastDisplayedNodeId !== currentNodeId) {
        return;
    }

    // Sort history by recency (most recent first)
    const sortedHistory = history.sort((a, b) => b.lastVisitTime - a.lastVisitTime);

    // Basic properties
    const title = nodeData.title || "Untitled";

    // Format URL for display (remove http:// and www.)
    const displayUrl = formatUrlForDisplay(url);

    // More robust type detection
    const isBookmark = Boolean(
        nodeData.isBookmark ||
        nodeData.type === "bookmark" ||
        nodeData.dateAdded ||
        (nodeData.id && String(nodeData.id).startsWith("bookmark"))
    );

    // Format date for display if present
    let bookmarkDate = "";
    if (nodeData.dateAdded) {
        try {
            bookmarkDate = formatDistanceToNow(nodeData.dateAdded);
        } catch (e) {
            bookmarkDate = "Unknown date";
            console.error("Error formatting date:", e);
        }
    }

    // Get domain for display
    const domain = getDomain(url);

    // Check if we should show summary section
    const isChromePage = url.startsWith("chrome://") || url.startsWith("chrome-extension://");
    const cachedSummary = getCachedSummary(url);
    // Only show summary section if we either have a cached summary or it's not a Chrome page (and can be summarized)
    const showSummarySection = cachedSummary || (!isChromePage && !url.startsWith("file://"));

    // Check if this is a search result with summary match
    const searchInput = document.getElementById("tabSearch");
    const searchTerm = searchInput?.value.trim().toLowerCase();
    const searchMatch = searchTerm ? tabSearch.getMatchContext(url, searchTerm) : null;

    // Build readout HTML
    const readout = document.getElementById("readout");
    if (!readout) {
        console.error("Readout panel element not found");
        return;
    }

    readout.innerHTML = `
        <div class="readout-header ${isBookmark ? "bookmark" : ""}">
            <div class="readout-kicker">Domain context</div>
            <div class="readout-title">${escapeHtml(title)}</div>
            <div class="readout-url">${escapeHtml(displayUrl)}</div>
            ${searchMatch?.summaryContext ? `
                <div class="search-match-context">
                    <span class="match-label">Matched in summary:</span>
                    <span class="match-text">"...${escapeHtml(searchMatch.summaryContext)}..."</span>
                </div>
            ` : ""}
        </div>
        <div class="readout-details">
            ${isBookmark ? `
                <div class="readout-item bookmark-info">
                    <span class="label">Type:</span>
                    <span class="value">Bookmark</span>
                </div>
                ${bookmarkDate ? `
                    <div class="readout-item">
                        <span class="label">Bookmarked:</span>
                        <span class="value">${bookmarkDate}</span>
                    </div>
                ` : ""}
            ` : `
                <div class="readout-item">
                    <span class="label">Last accessed:</span>
                    <span class="value">${nodeData.lastAccessed ? formatDistanceToNow(nodeData.lastAccessed) : "Unknown"}</span>
                </div>
            `}
        </div>

        <!-- Domain stars are the primary hover payoff. Keep them above history
             and generated summaries so they never disappear below the fold. -->
        ${bookmarks.length > 0 ? `
            <div class="bookmarks-section">
                <h3>Stars from ${escapeHtml(domain)} <span>${bookmarks.length}</span></h3>
                <ul class="bookmark-list">
                    ${bookmarks.slice(0, 5).map(bookmark => `
                        <li class="bookmark-item">
                            <a href="${escapeHtml(bookmark.url)}" target="_blank" rel="noopener">${escapeHtml(bookmark.title || formatUrlForDisplay(bookmark.url))}</a>
                            <span class="bookmark-date">
                                ${formatDistanceToNow(new Date(bookmark.dateAdded))}
                            </span>
                        </li>
                    `).join("")}
                </ul>
            </div>
        ` : `
            <div class="bookmarks-section bookmarks-empty">
                <h3>Stars from ${escapeHtml(domain)}</h3>
                <p>No saved pages from this domain yet.</p>
            </div>
        `}

        <!-- History section -->
        ${sortedHistory.length > 0 ? `
            <div class="history-section">
                <h3>Recent visits <span>${sortedHistory.length}</span></h3>
                <ul class="history-list">
                    ${sortedHistory.slice(0, 5).map(item => `
                        <li class="history-item">
                            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title || formatUrlForDisplay(item.url))}</a>
                            <span class="history-date">
                                ${formatDistanceToNow(new Date(item.lastVisitTime))}
                            </span>
                        </li>
                    `).join("")}
                </ul>
            </div>
        ` : ""}
        
        ${showSummarySection ? `
            <div class="summary-section">
                ${cachedSummary ? `
                    <h3>Summary <span class="cached">(cached)</span></h3>
                    <div id="summary-content" class="summary-content">
                        ${createTruncatedSummary(cachedSummary)}
                    </div>
                ` : `
                    <!-- No heading when summary is loading -->
                    <div id="summary-content" class="summary-content summary-loading">
                        <div class="loading"><span class="loading-dots">...</span></div>
                    </div>
                `}
            </div>
        ` : ""}

    `;

    // Show readout - ensure it's visible
    readout.classList.remove("hidden");

    // #readout is a docked flex child. Old tooltip code translated it by
    // -50% when no pointer event was supplied, leaving the rail visibly shifted
    // after a hover. Always clear those legacy inline offsets.
    readout.style.removeProperty("left");
    readout.style.removeProperty("top");
    readout.style.removeProperty("transform");

    // Queue summary generation if needed (even if not showing summary section)
    if (!isChromePage && !url.startsWith("file://") && !cachedSummary) {
        addToSummaryQueue(url);

        // If we're not showing the summary section yet, set up a timer to show it when summary is ready
        if (!showSummarySection) {
            // Check every 2 seconds if summary becomes available
            const checkInterval = setInterval(() => {
                const newCachedSummary = getCachedSummary(url);
                if (newCachedSummary && lastDisplayedNodeId === currentNodeId) {
                    clearInterval(checkInterval);
                    // Update the UI to show the summary section now that we have one
                    const summarySection = document.createElement("div");
                    summarySection.className = "summary-section";
                    summarySection.innerHTML = `
                        <h3>Summary <span class="cached">(cached)</span></h3>
                        <div id="summary-content" class="summary-content">
                            ${createTruncatedSummary(newCachedSummary)}
                        </div>
                    `;

                    // Insert after readout-details
                    const readoutDetails = document.querySelector(".readout-details");
                    if (readoutDetails && readoutDetails.nextSibling) {
                        readout.insertBefore(summarySection, readoutDetails.nextSibling);
                    } else {
                        readout.appendChild(summarySection);
                    }
                }
            }, 2000);

            // Clean up the interval after 30 seconds if summary never arrives
            setTimeout(() => clearInterval(checkInterval), 30000);
        }
    }
}

// Update the positioning logic to handle undefined event
function positionReadout(event) {
    const readout = document.getElementById("readout");

    if (!event) {
        // Center in viewport if no event is provided
        readout.style.left = "50%";
        readout.style.top = "50%";
        readout.style.transform = "translate(-50%, -50%)";
        return;
    }

    // Rest of your positioning logic...
    const container = document.querySelector(".treemap-container") || document.body;

    // Default positioning near cursor
    const padding = 15;
    let x = event.pageX + padding;
    let y = event.pageY + padding;

    // Get dimensions
    const readoutWidth = readout.offsetWidth;
    const readoutHeight = readout.offsetHeight;
    const containerRect = container.getBoundingClientRect();

    // Ensure readout stays within container bounds
    if (x + readoutWidth > window.innerWidth) {
        x = Math.max(0, event.pageX - readoutWidth - padding);
    }

    if (y + readoutHeight > window.innerHeight) {
        y = Math.max(0, event.pageY - readoutHeight - padding);
    }

    // Apply positioning
    readout.style.left = `${x}px`;
    readout.style.top = `${y}px`;
}

// Add cache cleanup on hide
export function hideReadout() {
    const readoutContainer = document.getElementById("readout");

    // Reset the last displayed node ID
    lastDisplayedNodeId = null;

    // Use classList instead of style.display = 'none'
    readoutContainer.classList.add("hidden");

    // Keep a minimal placeholder to maintain structure
    readoutContainer.innerHTML = "<div class=\"readout-placeholder\"></div>";

    // Cleanup old cache entries
    for (const [url, cached] of summaryCache.entries()) {
        if (Date.now() - cached.timestamp > SUMMARY_CACHE_DURATION) {
            summaryCache.delete(url);
        }
    }
}

// Recent stars (bookmarks) for the default readout panel. Cached at module
// scope: the default panel is re-shown constantly (inactivity timer, hover-out),
// and hitting chrome.bookmarks.getRecent on every reset is pointless — the list
// only changes on bookmark churn, so those events invalidate the cache.
const RECENT_STARS_COUNT = 6;
let recentStarsCache = null;
if (typeof chrome !== "undefined" && chrome.bookmarks) {
    chrome.bookmarks.onCreated.addListener(() => { recentStarsCache = null; });
    chrome.bookmarks.onRemoved.addListener(() => { recentStarsCache = null; });
    chrome.bookmarks.onChanged.addListener(() => { recentStarsCache = null; });
}

async function renderRecentStars(listEl) {
    try {
        if (!recentStarsCache) {
            recentStarsCache = await fetchRecentBookmarks(RECENT_STARS_COUNT);
        }
    } catch (error) {
        console.error("Error fetching recent stars:", error);
    }
    const stars = recentStarsCache || [];

    // The user may have hovered a cell while getRecent was in flight, replacing
    // the default panel — don't paint into a detached node.
    if (!listEl.isConnected) return;
    listEl.removeAttribute("aria-busy");

    if (!stars.length) {
        const empty = document.createElement("li");
        empty.className = "star-empty";
        empty.textContent = "No starred pages yet.";
        listEl.replaceChildren(empty);
        return;
    }

    // Built with DOM APIs (not innerHTML) — bookmark titles are arbitrary text.
    listEl.replaceChildren(...stars.map(bookmark => {
        const li = document.createElement("li");
        li.className = "star-item";

        const link = document.createElement("a");
        link.href = bookmark.url;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = bookmark.title || formatUrlForDisplay(bookmark.url);

        const meta = document.createElement("span");
        meta.className = "star-meta";
        meta.textContent = `${getDomain(bookmark.url)} · ${formatDistanceToNow(new Date(bookmark.dateAdded))}`;

        li.append(link, meta);
        return li;
    }));
}

function showDefaultReadout(categorizedDataCache) {
    const readoutContainer = document.getElementById("readout");
    if (!readoutContainer) {
        console.warn("Readout container not available");
        return;
    }

    // Reset so hovering the last cell works again after inactivity timeout
    lastDisplayedNodeId = null;

    // The default shell lives in newtab.html so it can paint as the document is
    // parsed, before the treemap module has loaded or measured a single label.
    // Reuse that shell when it is still present; rebuild it only when returning
    // from a tab-specific hover or pinned readout.
    let contentContainer = readoutContainer.querySelector(":scope > .readout-content");
    if (!contentContainer?.querySelector(".readout-intro")) {
        readoutContainer.innerHTML = `
          <div class="readout-content">
        <div class="readout-intro">
            <div class="readout-kicker">Browsing memory</div>
            <h2>Follow a region</h2>
            <p>Hover a tile to reveal pages and stars from its domain. Click a tile to hold that context here.</p>
        </div>
        <div class="recent-stars">
            <div class="readout-section-heading">
                <h3>Recent stars</h3>
                <a href="stars.html">Open landmarks</a>
            </div>
            <ul class="star-list" aria-busy="true">
              <li class="star-empty">Loading recent stars…</li>
            </ul>
        </div>
          </div>
        `;
        contentContainer = readoutContainer.querySelector(":scope > .readout-content");
    }
    renderRecentStars(contentContainer.querySelector(".star-list"));

    // NOTE: no tabSearch.buildIndex() here. This function is always called with
    // the boot-time cache, so rebuilding on the inactivity timer clobbered the
    // fresh index drawTreemap maintains with stale tab data.
}

// Make queue functions available globally for console access and debug tools
window.getQueueStats = getQueueStats;
window.addToSummaryQueue = addToSummaryQueue;
window.clearSummaryQueue = clearSummaryQueue;
window.processSummaryQueue = processSummaryQueue;
window.resetSummarizerCrashCounter = resetSummarizerCrashCounter;
window.getSummarizerStatus = getSummarizerStatus;

// Make browserState.clearSummaries available globally for console access
window.flushSummaryCache = function () {
    console.log(`Flushing summary cache with ${summaryCache.size} entries...`);
    summaryCache.clear();

    // Also clear summaries in browserState if available
    if (typeof browserState !== "undefined" && browserState.clearSummaries) {
        browserState.clearSummaries();
        console.log("Cleared summaries from browserState");
    } else {
        console.warn("browserState.clearSummaries not available");
    }

    console.log("Summary cache flushed successfully");
    return true;
};

// Audio tracking debug functions
window.getAudioTrackingStats = function () {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "getAudioTrackingStats" }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Error getting audio tracking stats:", chrome.runtime.lastError);
                resolve({ error: chrome.runtime.lastError.message });
            } else {
                resolve(response);
            }
        });
    });
};

window.getCurrentAudioDuration = function (tabId) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({
            action: "getCurrentAudioDuration",
            tabId: parseInt(tabId)
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Error getting current audio duration:", chrome.runtime.lastError);
                resolve({ error: chrome.runtime.lastError.message });
            } else {
                resolve(response);
            }
        });
    });
};

window.resetAudioTracking = function (tabId = null) {
    return new Promise((resolve) => {
        const message = { action: "resetAudioTracking" };
        if (tabId !== null) {
            message.tabId = parseInt(tabId);
        }

        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Error resetting audio tracking:", chrome.runtime.lastError);
                resolve({ error: chrome.runtime.lastError.message });
            } else {
                console.log(tabId ? `Audio tracking reset for tab ${tabId}` : "All audio tracking data reset");
                resolve(response);
            }
        });
    });
};

// Export both the function and timer reset
export { showDefaultReadout, resetInactivityTimer };
