import { formatDistanceToNow, formatSessionDuration } from './utility.js';
import { getMotivationalMessage } from './motivational-posters.js';
import { tabSearch } from './search.js';

let readoutTimeout = null;
let currentBookmarkPage = 0;
const BOOKMARKS_PER_PAGE = 10;
let stickyCell = null;  // Track currently sticky cell

let inactivityTimer = null;
const INACTIVITY_TIMEOUT = 30000; // 30 seconds

let currentMotivationalMessage = null;

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

async function displayReadout(tabData, sticky, categorizedDataCache, cellNode) {
    // Clear any existing inactivity timer
    clearTimeout(inactivityTimer);

    // Only start inactivity timer if not sticky
    if (!sticky) {
        resetInactivityTimer(categorizedDataCache);
    }

    const readoutContainer = document.getElementById('readout');
    if (!readoutContainer) {
        console.error('Readout container not found');
        return;
    }

    // Initialize search box if needed
    initializeSearchBox();

    // Get or create content container
    let contentContainer = document.querySelector('.readout-content');
    if (!contentContainer) {
        contentContainer = document.createElement('div');
        contentContainer.className = 'readout-content';
        readoutContainer.appendChild(contentContainer);
    }

    // Show default state if no tab data
    if (!tabData) {
        showDefaultReadout(categorizedDataCache);
        return;
    }

    // Handle sticky state changes
    if (sticky) {
        if (stickyCell === cellNode) {
            // Clicking same cell again - remove sticky
            stickyCell = null;
            sticky = false;
        } else if (stickyCell) {
            // Clear previous sticky cell highlight
            d3.select(stickyCell).select('rect')
                .attr('fill', d => d.data.color)
                .attr('stroke', 'none');
            stickyCell = cellNode;
        } else {
            stickyCell = cellNode;
        }
    }

    const domain = getDomain(tabData.url);
    let bookmarkMatches = [];
    let historyMatches = [];
    
    if (domain) {
        try {
            // Get bookmarks
            const bookmarks = await chrome.bookmarks.search({});
            bookmarkMatches = bookmarks
                .filter(bookmark => getDomain(bookmark.url) === domain)
                .map(bookmark => ({
                    ...bookmark,
                    sortDate: bookmark.dateAdded || 0
                }))
                .sort((a, b) => b.sortDate - a.sortDate);

            // Get history
            const oneWeekAgo = new Date().getTime() - (7 * 24 * 60 * 60 * 1000);
            const history = await chrome.history.search({
                text: domain,
                startTime: oneWeekAgo,
                maxResults: 100
            });
            historyMatches = history
                .filter(item => getDomain(item.url) === domain)
                .sort((a, b) => b.lastVisitTime - a.lastVisitTime);
        } catch (error) {
            console.error('Error searching bookmarks/history:', error);
        }
    }

    const totalBookmarks = bookmarkMatches.length;
    const totalHistory = historyMatches.length;
    
    const displayedBookmarks = bookmarkMatches.slice(0, ITEMS_PER_PAGE);
    const displayedHistory = historyMatches.slice(0, ITEMS_PER_PAGE);

    const readoutHtml = `
        <div class="readout-header">
            <h2>${tabData.title}</h2>
            <div class="url-container">
                <a href="${tabData.url}" target="_blank" class="tab-url">
                    ${domain || tabData.url}
                </a>
            </div>
            <div class="tab-meta">
                <span>Last visited: ${formatDistanceToNow(new Date(tabData.lastAccessed))}</span>
                ${tabData.timeSpent ? `
                    <span class="time-spent">
                        Time spent: ${formatSessionDuration(tabData.timeSpent)}
                    </span>
                ` : ''}
            </div>
        </div>
        ${bookmarkMatches.length > 0 ? `
            <div class="bookmarks-section">
                <h3>Bookmarks from ${domain} (${totalBookmarks})</h3>
                <ul class="bookmark-list">
                    ${displayedBookmarks.map(bookmark => `
                        <li class="bookmark-item">
                            <a href="${bookmark.url}" target="_blank">${bookmark.title || bookmark.url}</a>
                            <span class="bookmark-date">
                                ${formatDistanceToNow(new Date(bookmark.dateAdded))}
                            </span>
                        </li>
                    `).join('')}
                </ul>
                ${totalBookmarks > ITEMS_PER_PAGE ? `
                    <button class="show-more-btn">
                        Show ${Math.min(5, totalBookmarks - ITEMS_PER_PAGE)} more
                    </button>
                ` : ''}
            </div>
        ` : ''}
        ${historyMatches.length > 0 ? `
            <div class="history-section">
                <h3>History from ${domain} (${totalHistory})</h3>
                <ul class="history-list">
                    ${displayedHistory.map(item => `
                        <li class="history-item">
                            <a href="${item.url}" target="_blank">${item.title || item.url}</a>
                            <span class="history-date">
                                ${formatDistanceToNow(new Date(item.lastVisitTime))}
                            </span>
                        </li>
                    `).join('')}
                </ul>
                ${totalHistory > ITEMS_PER_PAGE ? `
                    <button class="show-more-btn">
                        Show ${Math.min(5, totalHistory - ITEMS_PER_PAGE)} more
                    </button>
                ` : ''}
            </div>
        ` : ''}
    `;

    contentContainer.innerHTML = readoutHtml;

    // Set up pagination handlers
    window.nextBookmarkPage = () => {
        currentBookmarkPage++;
        displayReadout(tabData, sticky, categorizedDataCache);
    };

    window.prevBookmarkPage = () => {
        currentBookmarkPage = Math.max(0, currentBookmarkPage - 1);
        displayReadout(tabData, sticky, categorizedDataCache);
    };

    if (!sticky) {
        clearTimeout(readoutTimeout);
        readoutTimeout = setTimeout(() => {
            if (!readoutContainer.classList.contains('sticky')) {
                // Instead of clearing everything, just clear the content container
                const contentContainer = document.querySelector('.readout-content');
                if (contentContainer) {
                    contentContainer.innerHTML = '';
                }
            }
        }, 3000);
    }

    readoutContainer.classList.toggle('sticky', sticky);
}

function hideReadout() {
    const readoutContainer = document.getElementById('readout');
    if (!readoutContainer) return;

    // Instead of replacing the entire container's HTML,
    // just clear or update the content container
    const contentContainer = document.querySelector('.readout-content');
    if (contentContainer) {
        contentContainer.innerHTML = '';
    }

    // Clear sticky state if needed
    if (stickyCell) {
        d3.select(stickyCell).select('rect')
            .attr('fill', d => d.data.color)
            .attr('stroke', 'none');
        stickyCell = null;
    }
}

function showDefaultReadout(categorizedDataCache) {
    const readoutContainer = document.getElementById('readout');
    if (!readoutContainer || !categorizedDataCache?.activeWindows) {
        console.warn('Readout container or data not available');
        return;
    }

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
    const searchTerm = event.target.value.trim();
    
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
        const opacity = isMatch ? 1 : 0.3;
        
        d3.select(this)
            .style('opacity', opacity)
            .style('transition', 'opacity 0.2s ease-in-out');
    });
}

// Export both the function and timer reset
export { displayReadout, hideReadout, showDefaultReadout, resetInactivityTimer };