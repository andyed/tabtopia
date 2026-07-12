import { drawTreemap } from "./treemap.js";
import { displayReadout, loadNanoSummariesFromStorage } from "./readout.js";

// Make this a module-level variable so it's accessible to all functions
let categorizedDataCache = null;

export async function initializeApp() {
    console.log("Initializing app...");
    
    // Load nano summaries from storage first
    await loadNanoSummariesFromStorage();
    
    // Only fetch the categorized tab data on load - this is necessary
    categorizedDataCache = await fetchCategorizedData();
    console.log("Categorized data fetched:", categorizedDataCache);
    
    // Set up tab event listeners
    setupTabEventListeners();
    
    // OPTIONAL: If you need placeholder cells, use a lightweight alternative
    ensureMinimumCellsLightweight(categorizedDataCache);

    // Draw the initial treemap
    drawTreemap(categorizedDataCache);
    
    // Add resize handler
    window.onresize = debounce(async () => {
        console.log("Resizing treemap...");
        if (categorizedDataCache) {
            await drawTreemap(categorizedDataCache);
        }
    }, 250); // Increased debounce time for better performance

    // Optimize blur handler - don't fully reinitialize
    window.onblur = debounce(async () => {
        console.log("Window lost focus, refreshing data only...");
        const freshData = await refreshData(categorizedDataCache); // More efficient refresh
        if (freshData) categorizedDataCache = freshData;
    }, 500);
    // Removed immediate AI/Summarizer check to prevent startup crashes
    // The API will be checked when actually needed during summarization
}

// Set up listeners for Chrome tab events
function setupTabEventListeners() {
    // Listen for tab removal events
    chrome.tabs.onRemoved.addListener(handleTabRemoved);
    
    // Optionally listen for other tab events
    chrome.tabs.onCreated.addListener(handleTabCreated);
    chrome.tabs.onUpdated.addListener(handleTabUpdated);
}

// Handle tab removed events
function handleTabRemoved(tabId, removeInfo) {
    console.log("Tab removed:", tabId, removeInfo);
    
    if (!categorizedDataCache?.activeWindows) {
        console.warn("No treemap data available");
        return;
    }
    
    let tabFound = false;
    let windowsToRemove = [];
    
    // Find the window containing this tab
    for (const window of categorizedDataCache.activeWindows) {
        // Skip placeholder windows
        if (window.id === "placeholder-window") continue;
        
        // Look for the tab in this window
        const tabIndex = window.tabs.findIndex(tab => tab.id === tabId);
        
        if (tabIndex !== -1) {
            // Remove the tab
            window.tabs.splice(tabIndex, 1);
            tabFound = true;
            
            // If this was the last tab in a window, mark window for removal
            if (window.tabs.length === 0) {
                windowsToRemove.push(window);
            }
            
            break;
        }
    }
    
    // Remove any empty windows
    for (const window of windowsToRemove) {
        const windowIndex = categorizedDataCache.activeWindows.indexOf(window);
        if (windowIndex !== -1) {
            categorizedDataCache.activeWindows.splice(windowIndex, 1);
        }
    }
    
    // Only redraw if we actually removed something
    if (tabFound) {
        // Re-apply minimum cells if needed
        ensureMinimumCellsLightweight(categorizedDataCache);
        
        // Update the visualization
        drawTreemap(categorizedDataCache);
    }
}

// Handle tab created events
function handleTabCreated(tab) {
    console.log("Tab created:", tab);
    
    // This is less critical since the next refresh will catch new tabs,
    // but it can provide a more responsive experience
    
    // For now, we'll just trigger a data refresh when tabs are created
    if (categorizedDataCache) {
        refreshData(categorizedDataCache).then(freshData => {
            if (freshData) categorizedDataCache = freshData;
        });
    }
}

// Handle tab updated events (URL or title changes)
function handleTabUpdated(tabId, changeInfo, tab) {
    // Only respond to complete tab updates with title changes
    if (!changeInfo.title && !changeInfo.url) return;
    
    console.log("Tab updated:", tabId, changeInfo);
    
    // Find and update the tab in our cache
    if (categorizedDataCache?.activeWindows) {
        let tabFound = false;
        
        for (const window of categorizedDataCache.activeWindows) {
            const tabToUpdate = window.tabs.find(t => t.id === tabId);
            
            if (tabToUpdate) {
                // Update the tab data
                if (changeInfo.title) tabToUpdate.title = changeInfo.title;
                if (changeInfo.url) tabToUpdate.url = changeInfo.url;
                if (changeInfo.favIconUrl) tabToUpdate.favIconUrl = changeInfo.favIconUrl;
                
                tabFound = true;
                break;
            }
        }
        
        // Only redraw for significant changes (title/URL)
        if (tabFound && (changeInfo.title || changeInfo.url)) {
            drawTreemap(categorizedDataCache);
        }
    }
}

// New lightweight function that doesn't need bookmarks
function ensureMinimumCellsLightweight(categorizedDataCache) {
    const totalTabs = categorizedDataCache.activeWindows.reduce(
        (sum, window) => sum + window.tabs.length, 0
    );
    
    // If we have a reasonable number of tabs, don't bother with placeholders
    if (totalTabs >= 4) return;
    
    // Add some placeholder cells if needed
    const placeholdersNeeded = 4 - totalTabs;
    
    if (placeholdersNeeded > 0) {
        // Create a simple placeholder window with dummy tabs
        if (!categorizedDataCache.placeholderWindow) {
            categorizedDataCache.placeholderWindow = {
                id: "placeholder-window",
                tabs: []
            };
            
            // Add to active windows
            categorizedDataCache.activeWindows.push(categorizedDataCache.placeholderWindow);
        }
        
        // Clear existing placeholders and add new ones
        categorizedDataCache.placeholderWindow.tabs = [];
        
        // Add placeholder tabs
        for (let i = 0; i < placeholdersNeeded; i++) {
            categorizedDataCache.placeholderWindow.tabs.push({
                id: `placeholder-${i}`,
                title: "Getting started",
                url: "chrome://newtab/",
                favIconUrl: "chrome://favicon/size/16@1x/chrome://newtab/",
                lastAccessed: Date.now() - (i * 10000),
                timeSpent: 1,
                isPlaceholder: true
            });
        }
    }
}

// More efficient refresh function that only updates data
async function refreshData(existingData) {
    try {
        const freshData = await fetchCategorizedData();
        
        // Only redraw if the data has actually changed
        if (hasDataChanged(existingData, freshData)) {
            console.log("Tab data changed, updating treemap");
            await drawTreemap(freshData);
            return freshData;
        } else {
            console.log("No change in data detected");
            return existingData;
        }
    } catch (error) {
        console.error("Error refreshing data:", error);
        return existingData;
    }
}

// Helper to detect if data has actually changed
function hasDataChanged(oldData, newData) {
    // Quick check: window count
    if (oldData.activeWindows.length !== newData.activeWindows.length) {
        return true;
    }
    
    // Quick check: tab count
    const oldTabCount = oldData.activeWindows.reduce((sum, w) => sum + w.tabs.length, 0);
    const newTabCount = newData.activeWindows.reduce((sum, w) => sum + w.tabs.length, 0);
    
    if (oldTabCount !== newTabCount) {
        return true;
    }
    
    // If we need better detection, we could add more checks here
    // But tab count changes will catch most meaningful updates
    
    return false;
}

// Debounce utility function
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Keep these functions for on-demand use in other components
export async function fetchRecentBookmarks(count = 10) {
    try {
        const bookmarks = await chrome.bookmarks.getRecent(count);
        
        console.log("Raw bookmark data:", bookmarks); // Debug raw data
        
        // Map bookmarks to ensure all required fields for display
        const enhancedBookmarks = bookmarks.map(bookmark => ({
            ...bookmark,  // Keep all original properties
            id: bookmark.id,
            title: bookmark.title || "Untitled Bookmark",
            url: bookmark.url || "",
            type: "bookmark",  // Add explicit type
            isBookmark: true,  // Add explicit flag
            dateAdded: bookmark.dateAdded,  // Chrome provides this in milliseconds
            lastAccessed: bookmark.dateAdded || Date.now(),
            // Generate favicon URL if not present
            favIconUrl: bookmark.favIconUrl || (bookmark.url ? `chrome://favicon/size/16@1x/${bookmark.url}` : "")
        }));
        
        console.log("Enhanced bookmark data:", enhancedBookmarks); // Debug enhanced data
        
        return enhancedBookmarks;
    } catch (error) {
        console.error("Error fetching bookmarks:", error);
        return [];
    }
}

export async function fetchRecentHistory(count = 10) {
    try {
        const historyItems = await chrome.history.search({
            text: "",
            maxResults: count,
            startTime: 0
        });

        console.log("Raw history data:", historyItems); // Debug raw data

        // Map history items to ensure all required fields for display
        const enhancedHistory = historyItems.map(item => ({
            ...item,  // Keep all original properties
            id: item.id,
            title: item.title || "Untitled History Item",
            url: item.url || "",
            type: "history",  // Add explicit type
            isHistory: true,  // Add explicit flag
            lastVisitTime: item.lastVisitTime || Date.now(),
            // Generate favicon URL if not present
            favIconUrl: item.favIconUrl || (item.url ? `chrome://favicon/size/16@1x/${item.url}` : "")
        }));

        console.log("Enhanced history data:", enhancedHistory); // Debug enhanced data

        return enhancedHistory;
    } catch (error) {
        console.error("Error fetching history:", error);
        return [];
    }
}

function ensureMinimumCells(data, bookmarks) {
    const totalTabs = data.activeWindows.reduce((sum, w) => sum + w.tabs.length, 0);
    const minCells = 4;

    if (totalTabs < minCells) {
        const randomBookmarks = getRandomBookmarks(bookmarks, minCells - totalTabs);
        addBookmarksToData(data, randomBookmarks);
    }
}

function getRandomBookmarks(bookmarks, count) {
    const shuffled = bookmarks.sort(() => 0.5 - Math.random());
    console.log("Picking random bookmarks", bookmarks);
    return shuffled.slice(0, count);
}

function addBookmarksToData(data, bookmarks) {
    const bookmarkWindow = {
        id: "bookmarkWindow",
        tabs: bookmarks.map((bookmark, index) => ({
            id: `bookmark${index}`,
            windowId: "bookmarkWindow",
            title: bookmark.title || "Untitled",
            url: bookmark.url || "",
            favIconUrl: "",
            lastAccessed: Date.now(),
            timeSpent: 100,
            children: [],
            isBookmark: true // Custom property to identify bookmarks
        }))
    };
    data.activeWindows.push(bookmarkWindow);
}

/**
 * Fetches all windows and tabs from the browser and organizes them
 * into the data structure needed for the treemap visualization.
 */
async function fetchCategorizedData() {
    try {
        // Get all windows with their tabs
        const windows = await new Promise((resolve) => {
            chrome.windows.getAll({ populate: true }, resolve);
        });
        
        // Format the data into the structure expected by the treemap
        const categorizedData = {
            activeWindows: windows.map(window => ({
                id: window.id,
                focused: window.focused,
                tabs: window.tabs.map(tab => ({
                    id: tab.id,
                    windowId: window.id,
                    title: tab.title || "Untitled",
                    url: tab.url || "",
                    favIconUrl: tab.favIconUrl || `chrome://favicon/size/16@1x/${tab.url}`,
                    lastAccessed: Date.now() - Math.floor(Math.random() * 3600000), // Approximate for demo
                    timeSpent: 100, // Default value, replace with actual tracking data if available
                    active: tab.active,
                    pinned: tab.pinned
                }))
            }))
        };
        
        return categorizedData;
    } catch (error) {
        console.error("Error fetching browser data:", error);
        // Return fallback data structure with empty windows array
        return { activeWindows: [] };
    }
}