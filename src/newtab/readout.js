import { formatDistanceToNow, formatSessionDuration } from './utility.js';
import { getMotivationalMessage } from './motivational-posters.js';
import { tabSearch } from './search.js';
import { fetchRecentBookmarks, fetchRecentHistory } from './init.js';

let readoutTimeout = null;
let currentBookmarkPage = 0;
const BOOKMARKS_PER_PAGE = 10;
let stickyCell = null;  // Track currently sticky cell

let inactivityTimer = null;
const INACTIVITY_TIMEOUT = 600000;

let currentMotivationalMessage = null;

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
    type: 'headline',     // Use headline for concise summaries
    format: 'plain-text', // Keep it simple
    length: 'short'      // Don't make it too verbose
};

// Track summarizer crashes to implement backoff
let summarizerCrashCount = 0;
let lastCrashTime = 0;
const CRASH_BACKOFF_DURATION = 30000; // 30 seconds
const MAX_CRASHES_BEFORE_BACKOFF = 3;

// Utility function to extract and clean words from a URL for better search recall
function extractWordsFromUrl(url) {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname;
        const path = urlObj.pathname;
        
        // Extract domain parts (e.g., 'example' and 'com' from example.com)
        const domainParts = hostname.split('.');
        
        // Extract path parts and filter out empty parts
        const pathParts = path.split(/[\/\-_.]/).filter(part => part.length > 0);
        
        // Combine and filter out common words and very short parts
        const allParts = [...domainParts, ...pathParts].filter(part => {
            return part.length > 2 && 
                  !['www', 'com', 'org', 'net', 'io', 'html', 'php', 'asp', 'jsp'].includes(part);
        });
        
        // Split CamelCase and kebab-case words
        const expandedParts = [];
        allParts.forEach(part => {
            // Split by camelCase
            const camelSplit = part.replace(/([a-z])([A-Z])/g, '$1 $2');
            // Add original and split versions
            expandedParts.push(part);
            if (camelSplit !== part) expandedParts.push(camelSplit);
        });
        
        return expandedParts;
    } catch (e) {
        console.log('Error extracting words from URL:', e);
        return [];
    }
}

// Add at the top with other state variables
let lastDisplayedNodeId = null;

// Helper function to get domain from URL
function getDomain(url) {
    if (!url) return 'Unknown';
    try {
        const parsedUrl = new URL(url);
        return parsedUrl.hostname;
    } catch (e) {
        console.warn('Invalid URL:', url);
        return 'Unknown';
    }
}

// Add this helper function for formatting URLs
function formatUrlForDisplay(url) {
    if (!url) return '';
    
    // Remove http://, https://, and www.
    return url
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '');
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

function initializeSearchBox() {
    const readoutContainer = document.getElementById('readout');
    if (!readoutContainer) return;

    // Create search box wrapper if it doesn't exist
    let searchContainer = document.querySelector('.search-container');
    if (!searchContainer) {
        searchContainer = document.createElement('div');
        searchContainer.className = 'search-container';
        searchContainer.innerHTML = `
            <input type="text" 
                id="tabSearch" 
                placeholder="Search tabs..." 
                class="search-input"
            />
        `;
        readoutContainer.insertBefore(searchContainer, readoutContainer.firstChild);

        // Add search handler
        const searchInput = document.getElementById('tabSearch');
        if (searchInput) {
            searchInput.addEventListener('input', handleTabSearch);
        }
    }
}

// Function to search bookmarks for a specific domain
async function searchBookmarksForTab(url) {
    try {
        // Extract domain from the URL
        const domain = getDomain(url);
        if (domain === 'Unknown') {
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

        console.log('Bookmarks for domain:', domain, filteredBookmarks); 
        return filteredBookmarks;
    } catch (error) {
        console.error('Error searching bookmarks for domain:', url, error);
        return [];
    }
}

// Function to search history for a specific domain
async function searchHistoryForTab(url) {
    try {
        // Extract domain from the URL
        const domain = getDomain(url);
        if (domain === 'Unknown') {
            return [];
        }

        // Search by domain instead of tab ID
        const historyItems = await new Promise((resolve, reject) => {
            chrome.history.search({
                text: domain,
                maxResults: 10,
                startTime: 0
            }, (results) => {
                if (chrome.runtime.lastError) {
                    return reject(chrome.runtime.lastError);
                }
                resolve(results);
            });
        });

        // Further filter to ensure domain match
        const filteredHistory = historyItems.filter(item => {
            try {
                return getDomain(item.url) === domain;
            } catch (e) {
                return false;
            }
        });

        console.log('History for domain:', domain, filteredHistory);
        return filteredHistory;
    } catch (error) {
        console.error('Error searching history for domain:', url, error);
        return [];
    }
}

async function getTabContent(url) {
    try {
        // Check for unsupported URLs
        if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('file://')) {
            console.log('Skipping content extraction for restricted URL:', url);
            return null;
        }

        // First try to find the tab with this URL
        const tabs = await chrome.tabs.query({ url });
        
        if (!tabs || tabs.length === 0) {
            console.log('No matching tab found for URL:', url);
            // Rather than fail, we'll try a different approach to get content
            // Return a placeholder summary instead
            return `This is a webpage at ${url}. The specific content is not accessible.`;
        }

        try {
            // Check if we can execute script in this tab
            const tab = tabs[0];
            
            // Execute script in the tab to get content
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    // Get all text content, excluding scripts and styles
                    try {
                        const walker = document.createTreeWalker(
                            document.body,
                            NodeFilter.SHOW_TEXT,
                            {
                                acceptNode: (node) => {
                                    const parent = node.parentElement;
                                    if (!parent) return NodeFilter.FILTER_REJECT;
                                    
                                    // Skip hidden elements
                                    if (parent.offsetHeight === 0) return NodeFilter.FILTER_REJECT;
                                    
                                    // Skip script and style tags
                                    const tag = parent.tagName.toLowerCase();
                                    if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT;
                                    
                                    return NodeFilter.FILTER_ACCEPT;
                                }
                            }
                        );

                        let content = '';
                        let node;
                        let counter = 0;
                        const maxNodes = 5000; // Prevent excessive processing
                        
                        while ((node = walker.nextNode()) && counter < maxNodes) {
                            const text = node.textContent.trim();
                            if (text) content += text + ' ';
                            counter++;
                        }
                        
                        return content.trim();
                    } catch (err) {
                        // If we encounter an error within the injected script
                        return `Could not extract content from this page: ${err.message}`;
                    }
                }
            });
            
            if (results && results[0] && results[0].result) {
                return results[0].result;
            } else {
                console.log('Script executed but returned no content');
                return `This appears to be a webpage at ${new URL(url).hostname}. Content could not be extracted.`;
            }
        } catch (scriptError) {
            console.warn('Cannot execute script in tab:', scriptError);
            // Return basic page information from tab data instead
            const tab = tabs[0];
            return `This is a webpage titled "${tab.title}" at ${new URL(url).hostname}.`;
        }
    } catch (error) {
        console.error('Error getting tab content:', error);
        // Return a minimal string that can still be summarized
        const urlObj = new URL(url);
        return `This is a webpage at ${urlObj.hostname}.`;
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
    if (!url || typeof url !== 'string') {
        console.warn('Invalid URL provided to summary queue:', url);
        return false;
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
    console.log('🔄 Summarizer crash counter reset');
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
        lastCrashTime: lastCrashTime ? new Date(lastCrashTime).toISOString() : null
    };
}

/**
 * Flushes all summary caches (both in-memory and Redux state)
 * Call this when you want to force re-generation of summaries
 * @param {boolean} notifyState - Whether to notify the state system to clear summaries
 */
export function flushSummaryCache(notifyState = true) {
    console.log('Flushing summary cache');
    
    // Clear the in-memory cache
    summaryCache.clear();
    
    // Clear the queue
    clearSummaryQueue();
    
    // Clear persisted nano summaries from storage
    chrome.storage.local.remove(['nanoSummaries'], () => {
        if (chrome.runtime.lastError) {
            console.error('Error clearing nano summaries from storage:', chrome.runtime.lastError);
        } else {
            console.log('✅ Cleared nano summaries from storage');
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
    if (typeof tabSearch.addSummaryToIndex === 'function') {
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
        const result = await chrome.storage.local.get(['nanoSummaries']);
        const summaries = result.nanoSummaries || {};
        
        // Add new summary
        summaries[url] = {
            summary,
            timestamp: Date.now(),
            source: 'chrome-summarizer'
        };
        
        // Save back to storage
        await chrome.storage.local.set({ nanoSummaries: summaries });
        console.log(`✅ Persisted nano summary for ${url}`);
        
    } catch (error) {
        console.error('Error persisting nano summary:', error);
    }
}

/**
 * Load nano summaries from storage on startup
 * This ensures summaries are available after browser restart
 */
export async function loadNanoSummariesFromStorage() {
    try {
        const result = await chrome.storage.local.get(['nanoSummaries']);
        const summaries = result.nanoSummaries || {};
        
        console.log(`Loading ${Object.keys(summaries).length} nano summaries from storage...`);
        
        // Add to in-memory cache
        Object.entries(summaries).forEach(([url, data]) => {
            summaryCache.set(url, {
                summary: data.summary,
                timestamp: data.timestamp
            });
            
            // Add to search index if available
            if (typeof tabSearch.addSummaryToIndex === 'function') {
                tabSearch.addSummaryToIndex(url, data.summary);
            }
        });
        
        console.log(`✅ Loaded ${Object.keys(summaries).length} nano summaries from storage`);
        
    } catch (error) {
        console.error('Error loading nano summaries from storage:', error);
    }
}

// Generate a fallback summary based on URL structure and visit metrics
async function generateVisitMetricFallback(url) {
    try {
        console.log('Generating fallback summary for:', url);
        
        // Extract meaningful words from the URL
        const urlWords = extractWordsFromUrl(url);
        console.log('Extracted URL words:', urlWords);
        
        // Get history metrics for this URL/domain
        const historyItems = await searchHistoryForTab(url);
        
        // Extract basic URL info
        let domain = 'unknown';
        let pathname = '';
        let pageType = '';
        
        try {
            const urlObj = new URL(url);
            domain = urlObj.hostname;
            pathname = urlObj.pathname;
            
            // Try to identify page type from path
            if (pathname.includes('/article/') || pathname.includes('/post/')) {
                pageType = 'article';
            } else if (pathname.includes('/product/')) {
                pageType = 'product';
            } else if (pathname.includes('/category/') || pathname.includes('/tag/')) {
                pageType = 'category';
            } else if (pathname.endsWith('.pdf')) {
                pageType = 'PDF document';
            } else if (pathname === '/' || pathname === '') {
                pageType = 'homepage';
            }
        } catch (e) { /* ignore parsing errors */ }
        
        // Construct a meaningful fallback message
        const visitCount = historyItems.length;
        const pluralVisits = visitCount === 1 ? 'visit' : 'visits';
        
        // Create informative summary based on available data
        let summary;
        
        if (visitCount > 0) {
            // With history data
            if (urlWords.length > 0) {
                const keyTerms = urlWords.slice(0, 3).join(', ');
                summary = `${domain} page about ${keyTerms} (${visitCount} previous ${pluralVisits})`;
            } else {
                summary = `${domain} ${pageType || 'page'} with ${visitCount} previous ${pluralVisits}`;
            }
        } else {
            // No history data
            if (urlWords.length > 0) {
                const keyTerms = urlWords.slice(0, 3).join(', ');
                summary = `${domain} page related to ${keyTerms}`;
            } else {
                summary = `${domain} ${pageType || 'page'} (content not available for summarization)`;
            }
        }
        
        return summary;
    } catch (error) {
        console.error('Error generating fallback summary:', error);
        return 'Page content not available for summarization';
    }
}

// Enhanced queue processing with rate limiting and error recovery
export async function processSummaryQueue() {
    if (isProcessingQueue) {
        console.log('Queue processing already in progress, skipping...');
        return;
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
                    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
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
        console.error('❌ Critical error in queue processing:', error);
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
        const readout = document.getElementById('readout');
        const summaryContent = document.getElementById('summary-content');
        const currentUrl = readout?.querySelector('.readout-url')?.textContent;
        
        if (summaryContent && currentUrl && formatUrlForDisplay(url) === currentUrl) {
            summaryContent.innerHTML = createTruncatedSummary(summary);
            console.log(`🔄 Updated readout for: ${url}`);
        }
    } catch (error) {
        console.error('Error updating readout:', error);
    }
}

// Update summarizeUrl to use the Chrome Summarizer API correctly
async function summarizeUrl(url) {
    try {
        // Skip chrome:// URLs
        if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('file://')) {
            console.log('Skipping summary for restricted URL:', url);
            return null;
        }

        // Check for crash backoff
        const now = Date.now();
        if (summarizerCrashCount >= MAX_CRASHES_BEFORE_BACKOFF && 
            (now - lastCrashTime) < CRASH_BACKOFF_DURATION) {
            console.log(`⚠️ Summarizer in backoff mode due to crashes. Skipping: ${url}`);
            return await generateVisitMetricFallback(url);
        }

        // Check if the global Summarizer API is available
        if (!window.Summarizer) {
            console.log('Chrome Summarizer API not available in this browser');
            return await generateVisitMetricFallback(url);
        }

        // Check if model is available using correct API method
        const availability = await window.Summarizer.availability();
        console.log('Summarizer availability:', availability);
        
        if (availability === 'unavailable') {
            console.log('Summarizer API not usable on this system');
            return await generateVisitMetricFallback(url);
        }

        // Get tab content to summarize
        const content = await getTabContent(url);
        
        // If no content available, create a fallback summary based on visit metrics
        if (!content) {
            console.log('No content available to summarize for URL:', url);
            return await generateVisitMetricFallback(url);
        }
        
        // Limit content length to avoid QuotaExceededError
        // Chrome Summarizer API has input limits
        const MAX_CONTENT_LENGTH = 12000; // ~12KB max based on API limits
        let trimmedContent = content;
        
        // Filter out problematic content that might cause crashes
        const filteredContent = content
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove script tags
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')   // Remove style tags
            .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '') // Remove iframes
            .replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '') // Remove objects
            .replace(/<embed[^>]*>/gi, '')                    // Remove embeds
            .replace(/<applet[^>]*>[\s\S]*?<\/applet>/gi, '') // Remove applets
            .replace(/[^\x00-\x7F]/g, ' ')                    // Remove non-ASCII characters
            .replace(/\s+/g, ' ')                             // Normalize whitespace
            .trim();
        
        if (filteredContent.length > MAX_CONTENT_LENGTH) {
            console.log(`Content too large (${filteredContent.length} chars), trimming to ${MAX_CONTENT_LENGTH} chars`);
            // Take first part for better context
            const firstPart = Math.floor(MAX_CONTENT_LENGTH * 0.7);
            // Take last part to include conclusions
            const lastPart = MAX_CONTENT_LENGTH - firstPart;
            trimmedContent = filteredContent.substring(0, firstPart) + "\n[...content trimmed...]\n" + 
                           filteredContent.substring(filteredContent.length - lastPart);
        } else {
            trimmedContent = filteredContent;
        }
        
        // Additional safety check - if content is too short, use fallback
        if (trimmedContent.length < 50) {
            console.log('Content too short after filtering, using fallback summary');
            return await generateVisitMetricFallback(url);
        }
        
                // Initialize the summarizer
        let summarizer;
        try {
            // Create the summarizer with proper monitoring of download
            summarizer = await window.Summarizer.create({
                ...SUMMARIZER_OPTIONS,
                monitor(m) {
                    m.addEventListener('downloadprogress', (e) => {
                        console.log(`Downloading summarizer model: ${Math.round(e.loaded * 100)}%`);
                    });
                }
            });
            
            // Wait for model to be ready if needed
            if (summarizer.ready) {
                await summarizer.ready;
            }
            
            // Generate the summary with enhanced context for on-device model
            console.log('Generating summary for:', url, `(content length: ${trimmedContent.length})`);
            
            // Extract domain and title information to provide more context
            let domain = 'unknown';
            let pageTitle = '';
            
            try {
                const urlObj = new URL(url);
                domain = urlObj.hostname;
                
                // Look for a title in the content
                const titleMatch = trimmedContent.match(/<title>([^<]+)<\/title>/) || 
                                  trimmedContent.match(/^([^\n]{10,100})\n/) ||
                                  /<h1[^>]*>([^<]+)<\/h1>/i.exec(trimmedContent);
                if (titleMatch) {
                    pageTitle = titleMatch[1].trim();
                }
            } catch (e) { /* ignore URL parsing errors */ }
            
            // Create a more detailed context prompt
            const contextPrompt = `Summarize this webpage${pageTitle ? ' about "' + pageTitle + '"' : ''} from ${domain} in one concise sentence. ` +
                               `Focus on the main topic and key information. ` +
                               `Include what makes this page unique or valuable to the reader. ` +
                               `Ensure your summary is factual, informative, and directly based on the content.`;
                               
            const summary = await summarizer.summarize(trimmedContent, {
                context: contextPrompt
            });
            
            // Reset crash count on successful summary
            if (summary) {
                summarizerCrashCount = 0;
                console.log('✅ Summarizer crash count reset - successful summary generated');
            }
            
            return summary;
        } catch (error) {
            console.error('Error during summarization:', error);
            
            // Check if this is a model crash error
            if (error.message && error.message.includes('crashed')) {
                summarizerCrashCount++;
                lastCrashTime = Date.now();
                console.warn(`🚨 Summarizer crash detected (${summarizerCrashCount}/${MAX_CRASHES_BEFORE_BACKOFF})`);
                
                if (summarizerCrashCount >= MAX_CRASHES_BEFORE_BACKOFF) {
                    console.warn(`⚠️ Entering backoff mode for ${CRASH_BACKOFF_DURATION/1000} seconds`);
                }
            }
            
            return null;
        }
    } catch (error) {
        console.error('Error in summarizeUrl function:', error);
        return null;
    }
}

// Add this helper function for summary display
export function createTruncatedSummary(summary) {
    if (!summary) return '';
    
    const lines = summary.split('\n');
    const isTruncated = lines.length > MAX_SUMMARY_LINES;
    
    const truncatedSummary = isTruncated 
        ? lines.slice(0, MAX_SUMMARY_LINES).join('\n')
        : summary;
    
    return `<div class="summary-content"><div class="summary-text" style="line-height: ${LINE_HEIGHT}px">${truncatedSummary.trim()}</div>${isTruncated ? `<div class="summary-expand"><button class="show-more-btn" onclick="this.parentElement.parentElement.innerHTML = \`${summary.replace(/`/g, '\\`').trim()}\`">Show more...</button></div>` : ''}</div>`;
}

// Update displayReadout to queue summaries instead of generating them immediately
export async function displayReadout(d, event) {
    // Clear existing timeout
    if (readoutTimeout) {
        clearTimeout(readoutTimeout);
    }

    // Debug what we received
    console.log('Readout data:', d);

    // Normalize data structure
    const nodeData = d?.data || d;
    if (!nodeData) {
        console.error('Node data is undefined or null');
        return;
    }

    // Check if this is the same node we're already displaying
    const currentNodeId = nodeData.id || `${nodeData.windowId}-${nodeData.index}`;
    if (currentNodeId === lastDisplayedNodeId) {
        console.log('Skipping readout update - same node');
        return;
    }
    lastDisplayedNodeId = currentNodeId;

    console.log('Normalized data:', nodeData);
    
    // Make sure we have a URL to work with
    const url = nodeData.url || '';
    if (!url) {
        console.error('No URL available to search');
        return;
    }

    // Fetch bookmarks and history for the domain
    const bookmarks = await searchBookmarksForTab(url);
    const history = await searchHistoryForTab(url);
    
    // Sort history by recency (most recent first)
    const sortedHistory = history.sort((a, b) => b.lastVisitTime - a.lastVisitTime);

    // Basic properties
    const title = nodeData.title || 'Untitled';
    
    // Format URL for display (remove http:// and www.)
    const displayUrl = formatUrlForDisplay(url);

    // More robust type detection
    const isBookmark = Boolean(
        nodeData.isBookmark || 
        nodeData.type === 'bookmark' || 
        nodeData.dateAdded ||
        (nodeData.id && String(nodeData.id).startsWith('bookmark'))
    );

    console.log('Is bookmark?', isBookmark);

    // Format date for display if present
    let bookmarkDate = '';
    if (nodeData.dateAdded) {
        try {
            bookmarkDate = formatDistanceToNow(nodeData.dateAdded);
        } catch (e) {
            bookmarkDate = 'Unknown date';
            console.error('Error formatting date:', e);
        }
    }

    // Get domain for display
    const domain = getDomain(url);

    // Check if we should show summary section
    const isChromePage = url.startsWith('chrome://') || url.startsWith('chrome-extension://');
    const cachedSummary = getCachedSummary(url);
    // Only show summary section if we either have a cached summary or it's not a Chrome page (and can be summarized)
    const showSummarySection = cachedSummary || (!isChromePage && !url.startsWith('file://'));

    // Check if this is a search result with summary match
    const searchInput = document.getElementById('tabSearch');
    const searchTerm = searchInput?.value.trim().toLowerCase();
    const searchMatch = searchTerm ? tabSearch.getMatchContext(url, searchTerm) : null;

    // Build readout HTML
    const readout = document.getElementById('readout');
    if (!readout) {
        console.error('Readout panel element not found');
        return;
    }

    readout.innerHTML = `
        <div class="readout-header ${isBookmark ? 'bookmark' : ''}">
            <div class="readout-title">${title}</div>
            <div class="readout-url">${displayUrl}</div>
            ${searchMatch?.summaryContext ? `
                <div class="search-match-context">
                    <span class="match-label">Matched in summary:</span>
                    <span class="match-text">"...${searchMatch.summaryContext}..."</span>
                </div>
            ` : ''}
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
                ` : ''}
            ` : `
                <div class="readout-item">
                    <span class="label">Last accessed:</span>
                    <span class="value">${nodeData.lastAccessed ? formatDistanceToNow(nodeData.lastAccessed) : 'Unknown'}</span>
                </div>
            `}
        </div>
        
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
        ` : ''}

        <!-- History section -->
        ${sortedHistory.length > 0 ? `
            <div class="history-section">
                <h3>History from ${domain} (${sortedHistory.length})</h3>
                <ul class="history-list">
                    ${sortedHistory.slice(0, 5).map(item => `
                        <li class="history-item">
                            <a href="${item.url}" target="_blank">${item.title || formatUrlForDisplay(item.url)}</a>
                            <span class="history-date">
                                ${formatDistanceToNow(new Date(item.lastVisitTime))}
                            </span>
                        </li>
                    `).join('')}
                </ul>
            </div>
        ` : ''}
        
        <!-- Bookmarks section -->
        ${bookmarks.length > 0 ? `
            <div class="bookmarks-section">
                <h3>Bookmarks from ${domain} (${bookmarks.length})</h3>
                <ul class="bookmark-list">
                    ${bookmarks.slice(0, 5).map(bookmark => `
                        <li class="bookmark-item">
                            <a href="${bookmark.url}" target="_blank">${bookmark.title || formatUrlForDisplay(bookmark.url)}</a>
                            <span class="bookmark-date">
                                ${formatDistanceToNow(new Date(bookmark.dateAdded))}
                            </span>
                        </li>
                    `).join('')}
                </ul>
            </div>
        ` : ''}
    `;

    // Show readout - ensure it's visible
    readout.classList.remove('hidden');

    // Position readout
    if (event) {
        positionReadout(event);
    }

    // Queue summary generation if needed (even if not showing summary section)
    if (!isChromePage && !url.startsWith('file://') && !cachedSummary) {
        addToSummaryQueue(url);
        
        // If we're not showing the summary section yet, set up a timer to show it when summary is ready
        if (!showSummarySection) {
            // Check every 2 seconds if summary becomes available
            const checkInterval = setInterval(() => {
                const newCachedSummary = getCachedSummary(url);
                if (newCachedSummary && lastDisplayedNodeId === currentNodeId) {
                    clearInterval(checkInterval);
                    // Update the UI to show the summary section now that we have one
                    const summarySection = document.createElement('div');
                    summarySection.className = 'summary-section';
                    summarySection.innerHTML = `
                        <h3>Summary <span class="cached">(cached)</span></h3>
                        <div id="summary-content" class="summary-content">
                            ${createTruncatedSummary(newCachedSummary)}
                        </div>
                    `;
                    
                    // Insert after readout-details
                    const readoutDetails = document.querySelector('.readout-details');
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
    const readout = document.getElementById('readout');
    
    if (!event) {
        // Center in viewport if no event is provided
        readout.style.left = '50%';
        readout.style.top = '50%';
        readout.style.transform = 'translate(-50%, -50%)';
        return;
    }
    
    // Rest of your positioning logic...
    const container = document.querySelector('.treemap-container') || document.body;
    
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
    const readoutContainer = document.getElementById('readout');
    
    // Reset the last displayed node ID
    lastDisplayedNodeId = null;
    
    // Use classList instead of style.display = 'none'
    readoutContainer.classList.add('hidden');
    
    // Keep a minimal placeholder to maintain structure
    readoutContainer.innerHTML = '<div class="readout-placeholder"></div>';
    
    // Cleanup old cache entries
    for (const [url, cached] of summaryCache.entries()) {
        if (Date.now() - cached.timestamp > SUMMARY_CACHE_DURATION) {
            summaryCache.delete(url);
        }
    }
}

function showDefaultReadout(categorizedDataCache) {
    const readoutContainer = document.getElementById('readout');
    if (!readoutContainer || !categorizedDataCache?.activeWindows) {
        console.warn('Readout container or data not available');
        return;
    }
    // First, clear any existing content
    readoutContainer.innerHTML = '';
    // Initialize search box if needed
    initializeSearchBox();

    const windows = categorizedDataCache.activeWindows.length;
    const tabs = categorizedDataCache.activeWindows.reduce((sum, w) => sum + w.tabs.length, 0);
    
    if (!currentMotivationalMessage) {
        currentMotivationalMessage = getMotivationalMessage(windows, tabs);
    }

    // Get the content container or create it
    let contentContainer = document.querySelector('.readout-content');
    if (!contentContainer) {
        contentContainer = document.createElement('div');
        contentContainer.className = 'readout-content';
        readoutContainer.appendChild(contentContainer);
    }

    contentContainer.innerHTML = `
        <div class="readout-default">
            <h1 class="status-message">${currentMotivationalMessage}</h1>
            <div class="stats">
                <span>${windows} window${windows !== 1 ? 's' : ''}</span>
                <span>•</span>
                <span>${tabs} tab${tabs !== 1 ? 's' : ''}</span>
            </div>
        </div>
    `;

    // Maintain search index
    tabSearch.buildIndex(categorizedDataCache);
}

function handleTabSearch(event) {
    const searchTerm = event.target.value.trim().toLowerCase();
    
    // Reset all cells if search is empty
    if (!searchTerm) {
        d3.selectAll('#treemap g')
            .style('opacity', 1)
            .style('transition', 'opacity 0.2s ease-in-out');
        return;
    }

    const results = tabSearch.search(searchTerm);
    const matchedIds = new Set(results.map(r => r.tab.id));

    // Update visualization based on search results
    d3.selectAll('#treemap g').each(function(d) {
        const tabId = parseInt(d.data.id.replace('tab', ''));
        const isMatch = matchedIds.has(tabId);
        const matchType = results.find(r => r.tab.id === tabId)?.matchType;
        
        // Higher opacity for summary matches
        const opacity = isMatch ? (matchType === 'summary' ? 0.8 : 1) : 0.3;
        
        d3.select(this)
            .style('opacity', opacity)
            .style('transition', 'opacity 0.2s ease-in-out');
            
        // Add a subtle indicator for summary matches
        if (isMatch && matchType === 'summary') {
            d3.select(this).select('rect')
                .style('stroke', '#4CAF50')
                .style('stroke-width', '2px');
        } else {
            d3.select(this).select('rect')
                .style('stroke', null)
                .style('stroke-width', null);
        }
    });
}

// Make queue functions available globally for console access and debug tools
window.getQueueStats = getQueueStats;
window.addToSummaryQueue = addToSummaryQueue;
window.clearSummaryQueue = clearSummaryQueue;
window.processSummaryQueue = processSummaryQueue;
window.resetSummarizerCrashCounter = resetSummarizerCrashCounter;
window.getSummarizerStatus = getSummarizerStatus;

// Make browserState.clearSummaries available globally for console access
window.flushSummaryCache = function() {
    console.log(`Flushing summary cache with ${summaryCache.size} entries...`);
    summaryCache.clear();
    
    // Also clear summaries in browserState if available
    if (typeof browserState !== 'undefined' && browserState.clearSummaries) {
        browserState.clearSummaries();
        console.log('Cleared summaries from browserState');
    } else {
        console.warn('browserState.clearSummaries not available');
    }
    
    console.log('Summary cache flushed successfully');
    return true;
};

// Export both the function and timer reset
export {  showDefaultReadout, resetInactivityTimer };