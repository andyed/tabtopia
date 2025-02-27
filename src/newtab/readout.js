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

// Update the bookmark detection in displayReadout
export function displayReadout(d, event) {
    // Clear existing timeout
    if (readoutTimeout) {
        clearTimeout(readoutTimeout);
    }
    
    // Debug what we received
    console.log('Readout data:', d);
    
    // Normalize data structure
    const nodeData = d.data || d;
    console.log('Normalized data:', nodeData);
    
    // Basic properties
    const title = nodeData.title || 'Untitled';
    const url = nodeData.url || '';
    
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
    
    // Build readout HTML
    const readout = document.getElementById('readout');
    readout.innerHTML = `
        <div class="readout-header ${isBookmark ? 'bookmark' : ''}">
            <div class="readout-title">${title}</div>
            <div class="readout-url">${url}</div>
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
    `;
    
    // Show readout
    readout.style.display = 'block';
    
    // Position
    if (event) {
        positionReadout(event);
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
export { hideReadout, showDefaultReadout, resetInactivityTimer };