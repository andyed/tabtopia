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
    
    if (domain) {
        try {
            const bookmarks = await chrome.bookmarks.search({});
            bookmarkMatches = bookmarks
                .filter(bookmark => getDomain(bookmark.url) === domain)
                .map(bookmark => ({
                    ...bookmark,
                    // Use the most recent of dateAdded or lastVisited
                    sortDate: Math.max(
                        bookmark.dateAdded || 0,
                        bookmark.lastVisited || 0
                    )
                }))
                .sort((a, b) => b.sortDate - a.sortDate);
        } catch (error) {
            console.error('Error searching bookmarks:', error);
        }
    }

    const totalBookmarks = bookmarkMatches.length;
    const startIndex = currentBookmarkPage * BOOKMARKS_PER_PAGE;
    const displayedBookmarks = bookmarkMatches.slice(startIndex, startIndex + BOOKMARKS_PER_PAGE);

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
                <h3>Other Bookmarks from ${domain} (${totalBookmarks})</h3>
                <ul class="bookmark-list">
                    ${displayedBookmarks.map(bookmark => `
                        <li class="bookmark-item">
                            <a href="${bookmark.url}" target="_blank">
                                ${bookmark.title || bookmark.url}
                            </a>
                            <span class="bookmark-date">
                                ${bookmark.dateAdded ? 
                                    `Bookmarked ${formatDistanceToNow(new Date(bookmark.dateAdded))} ago` : 
                                    ''}
                            </span>
                        </li>
                    `).join('')}
                </ul>
                ${totalBookmarks > BOOKMARKS_PER_PAGE ? `
                    <div class="bookmark-pagination">
                        ${currentBookmarkPage > 0 ? `
                            <button class="pagination-btn prev" onclick="window.prevBookmarkPage()">Previous</button>
                        ` : ''}
                        <span class="page-info">
                            ${startIndex + 1}-${Math.min(startIndex + BOOKMARKS_PER_PAGE, totalBookmarks)} 
                            of ${totalBookmarks}
                        </span>
                        ${(currentBookmarkPage + 1) * BOOKMARKS_PER_PAGE < totalBookmarks ? `
                            <button class="pagination-btn next" onclick="window.nextBookmarkPage()">More</button>
                        ` : ''}
                    </div>
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