import { drawTreemap } from './treemap.js';
import { displayReadout } from './readout.js';

export async function initializeApp() {
    console.log('Initializing app...');
    const categorizedDataCache = await fetchCategorizedData();
    console.log('Categorized data fetched:', categorizedDataCache);
    const bookmarks = await fetchRecentBookmarks();
    console.log('Bookmarks fetched:', bookmarks);
    const history = await fetchRecentHistory();
    console.log('History fetched:', history);

    ensureMinimumCells(categorizedDataCache, bookmarks);

    drawTreemap(categorizedDataCache);
        // Add resize handler
    window.onresize = async () => {
        console.log("Resizing treemap...");
        if (categorizedDataCache) {
            await drawTreemap(categorizedDataCache);
        }
    };

    // Add blur handler to refresh the app
    window.onblur = async () => {
        console.log("Window lost focus, refreshing app...");
        await initializeApp(); // Reinitialize the app
    };

    // Pass data to readout
    //displayReadout({ bookmarks, history });
}

async function fetchCategorizedData() {
    return new Promise((resolve) => {
        chrome.windows.getAll({ populate: true }, (windows) => {
            const categorizedData = {
                activeWindows: windows.map(window => ({
                    id: window.id,
                    tabs: window.tabs.map(tab => ({
                        id: tab.id,
                        windowId: window.id,
                        title: tab.title || 'Untitled',
                        url: tab.url || '',
                        favIconUrl: tab.favIconUrl,
                        lastAccessed: tab.lastAccessed || Date.now(),
                        timeSpent: 100,
                        children: []
                    }))
                }))
            };
            resolve(categorizedData);
        });
    });
}

export async function fetchRecentBookmarks(count = 10) {
    try {
        const bookmarks = await chrome.bookmarks.getRecent(count);
        
        console.log('Raw bookmark data:', bookmarks); // Debug raw data
        
        // Map bookmarks to ensure all required fields for display
        const enhancedBookmarks = bookmarks.map(bookmark => ({
            ...bookmark,  // Keep all original properties
            id: bookmark.id,
            title: bookmark.title || 'Untitled Bookmark',
            url: bookmark.url || '',
            type: 'bookmark',  // Add explicit type
            isBookmark: true,  // Add explicit flag
            dateAdded: bookmark.dateAdded,  // Chrome provides this in milliseconds
            lastAccessed: bookmark.dateAdded || Date.now(),
            // Generate favicon URL if not present
            favIconUrl: bookmark.favIconUrl || (bookmark.url ? `chrome://favicon/size/16@1x/${bookmark.url}` : '')
        }));
        
        console.log('Enhanced bookmark data:', enhancedBookmarks); // Debug enhanced data
        
        return enhancedBookmarks;
    } catch (error) {
        console.error('Error fetching bookmarks:', error);
        return [];
    }
}

export async function fetchRecentHistory(count = 10) {
    try {
        const historyItems = await chrome.history.search({
            text: '',
            maxResults: count,
            startTime: 0
        });

        console.log('Raw history data:', historyItems); // Debug raw data

        // Map history items to ensure all required fields for display
        const enhancedHistory = historyItems.map(item => ({
            ...item,  // Keep all original properties
            id: item.id,
            title: item.title || 'Untitled History Item',
            url: item.url || '',
            type: 'history',  // Add explicit type
            isHistory: true,  // Add explicit flag
            lastVisitTime: item.lastVisitTime || Date.now(),
            // Generate favicon URL if not present
            favIconUrl: item.favIconUrl || (item.url ? `chrome://favicon/size/16@1x/${item.url}` : '')
        }));

        console.log('Enhanced history data:', enhancedHistory); // Debug enhanced data

        return enhancedHistory;
    } catch (error) {
        console.error('Error fetching history:', error);
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
    console.log("Picking random bookmarks", bookmarks)
    return shuffled.slice(0, count);
}

function addBookmarksToData(data, bookmarks) {
    const bookmarkWindow = {
        id: 'bookmarkWindow',
        tabs: bookmarks.map((bookmark, index) => ({
            id: `bookmark${index}`,
            windowId: 'bookmarkWindow',
            title: bookmark.title || 'Untitled',
            url: bookmark.url || '',
            favIconUrl: '',
            lastAccessed: Date.now(),
            timeSpent: 100,
            children: [],
            isBookmark: true // Custom property to identify bookmarks
        }))
    };
    data.activeWindows.push(bookmarkWindow);
}