import { drawTreemap } from './treemap.js';

export async function initializeApp() {
    console.log('Initializing app...');
    const categorizedDataCache = await fetchCategorizedData();
    console.log('Categorized data fetched:', categorizedDataCache);
    const bookmarks = await fetchRecentBookmarks();
    console.log('Bookmarks fetched:', bookmarks);

    ensureMinimumCells(categorizedDataCache, bookmarks);

    drawTreemap(categorizedDataCache);
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

export async function fetchRecentBookmarks() {
    return new Promise((resolve) => {
        chrome.bookmarks.getRecent(50, (bookmarks) => {
            const threeMonthsAgo = Date.now() - (3 * 30 * 24 * 60 * 60 * 1000);
            const recentBookmarks = bookmarks.filter(bookmark => bookmark.dateAdded >= threeMonthsAgo);
            console.log('Recent bookmarks:', recentBookmarks);
            resolve(recentBookmarks);
        });
    });
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