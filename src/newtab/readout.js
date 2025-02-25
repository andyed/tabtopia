import { formatDistanceToNow, formatSessionDuration } from './utility.js';

let readoutTimeout = null;
let currentBookmarkPage = 0;
const BOOKMARKS_PER_PAGE = 10;
let stickyCell = null;  // Track currently sticky cell

// Helper function to get domain from URL
function getDomain(url) {
    try {
        return new URL(url).hostname;
    } catch (e) {
        console.warn('Invalid URL:', url);
        return null;
    }
}

const ITEMS_PER_PAGE = 5;

async function displayReadout(tabData, sticky, categorizedDataCache, cellNode) {
    const readoutContainer = document.getElementById('readout');
    if (!readoutContainer) {
        console.error('Readout container not found');
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

    readoutContainer.innerHTML = readoutHtml;

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
                readoutContainer.innerHTML = '';
            }
        }, 3000);
    }

    readoutContainer.classList.toggle('sticky', sticky);
}

function hideReadout() {
    const readoutContainer = document.getElementById('readout');
    if (readoutContainer && !readoutContainer.classList.contains('sticky')) {
        readoutContainer.innerHTML = '';
        if (stickyCell) {
            d3.select(stickyCell).select('rect')
                .attr('fill', d => d.data.color)
                .attr('stroke', 'none');
            stickyCell = null;
        }
    }
}

export { displayReadout, hideReadout };