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
const summaryQueue = new Set();
let isProcessingQueue = false;

// Update the summarizer options
const SUMMARIZER_OPTIONS = {
    type: 'headline', // Change to headline for shorter summaries
    format: 'plain-text',
    length: 'short'
};

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
 * Flushes all summary caches (both in-memory and Redux state)
 * Call this when you want to force re-generation of summaries
 * @param {boolean} notifyState - Whether to notify the state system to clear summaries
 */
export function flushSummaryCache(notifyState = true) {
    console.log('Flushing summary cache');
    
    // Clear the in-memory cache
    summaryCache.clear();
    
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
}

// Update the queue processing function to be more aggressive
async function processSummaryQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
        const urls = Array.from(summaryQueue);
        summaryQueue.clear();

        await Promise.all(urls.map(async (url) => {
            // Skip if already cached
            if (getCachedSummary(url)) return;

            // Skip chrome URLs
            if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;

            try {
                const summary = await summarizeUrl(url);
                if (summary) {
                    cacheSummary(url, summary);
                    // Update current readout if it's showing this URL
                    const readout = document.getElementById('readout');
                    const summaryContent = document.getElementById('summary-content');
                    const currentUrl = readout?.querySelector('.readout-url')?.textContent;
                    if (summaryContent && formatUrlForDisplay(url) === currentUrl) {
                        summaryContent.innerHTML = createTruncatedSummary(summary);
                    }
                }
            } catch (error) {
                console.error('Error generating summary for:', url, error);
            }
        }));
    } finally {
        isProcessingQueue = false;
        if (summaryQueue.size > 0) {
            processSummaryQueue().catch(console.error);
        }
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

        // Check if the global Summarizer API is available
        if (!window.Summarizer) {
            console.log('Chrome Summarizer API not available in this browser');
            return null;
        }

        // Check if model is available using correct API method
        const availability = await window.Summarizer.availability();
        console.log('Summarizer availability:', availability);
        
        if (availability === 'unavailable') {
            console.log('Summarizer API not usable on this system');
            return null;
        }

        // Get tab content to summarize
        const content = await getTabContent(url);
        if (!content) {
            console.log('No content available to summarize for URL:', url);
            return null;
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
            
            // Generate the summary
            console.log('Generating summary for:', url);
            return await summarizer.summarize(content, {
                context: `Summarize this webpage in one sentence`
            });
        } catch (error) {
            console.error('Error during summarization:', error);
            return null;
        }
    } catch (error) {
        console.error('Error in summarizeUrl function:', error);
        return null;
    }
}

// Add this helper function for summary display
function createTruncatedSummary(summary) {
    if (!summary) return '';
    
    const lines = summary.split('\n');
    const isTruncated = lines.length > MAX_SUMMARY_LINES;
    
    const truncatedSummary = isTruncated 
        ? lines.slice(0, MAX_SUMMARY_LINES).join('\n')
        : summary;
    
    return `
        <div class="summary-content">
            <div class="summary-text" style="line-height: ${LINE_HEIGHT}px">
                ${truncatedSummary}
            </div>
            ${isTruncated ? `
                <div class="summary-expand">
                    <button class="show-more-btn" onclick="this.parentElement.parentElement.innerHTML = \`${summary.replace(/`/g, '\\`')}\`">
                        Show more...
                    </button>
                </div>
            ` : ''}
        </div>
    `;
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
                <h3>Summary ${cachedSummary ? '<span class="cached">(cached)</span>' : ''}</h3>
                <div id="summary-content" class="summary-content">
                    ${cachedSummary ? 
                        createTruncatedSummary(cachedSummary) : 
                        '<div class="loading"><span class="loading-dots">...</span></div>'
                    }
                </div>
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
        summaryQueue.add(url);
        processSummaryQueue().catch(console.error);
        
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

// Export both the function and timer reset
export {  showDefaultReadout, resetInactivityTimer };