// Sessions view JavaScript
console.log('sessions.js loaded');

// Import the summary cache and helper functions from readout.js
import { summaryCache, getCachedSummary } from './readout.js';
// Import the debug tools bridge for ES module compatibility
import { viewStoredHeroImages, debugToolsReady } from './debug-tools-bridge.js';

// Helper function to create a truncated summary display (simplified version from readout.js)
function createTruncatedSummary(summary, searchTerm = '') {
    if (!summary) return '';
    
    const MAX_SUMMARY_LINES = 3;
    const lines = summary.split('\n');
    const isTruncated = lines.length > MAX_SUMMARY_LINES;
    
    let truncatedSummary = isTruncated 
        ? lines.slice(0, MAX_SUMMARY_LINES).join('\n')
        : summary;
    
    // Highlight search term if provided
    if (searchTerm && searchTerm.trim() !== '') {
        truncatedSummary = highlightText(truncatedSummary, searchTerm);
    }
    
    return `<div class="summary-content"><div class="summary-text">${truncatedSummary.trim()}</div>${isTruncated ? `<div class="summary-expand"><button class="show-more-btn" onclick="this.parentElement.parentElement.innerHTML = \`${summary.replace(/`/g, '\\`').trim()}\`">Show more...</button></div>` : ''}</div>`;
}

// Helper function to highlight search matches in text
function highlightText(text, searchTerm) {
    if (!searchTerm || !text) return text;
    
    const searchRegex = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return text.replace(searchRegex, match => `<span class="search-highlight">${match}</span>`);
}

let allSessionsData = []; // To store the original full list of sessions
let currentSearchTerm = ''; // Track current search term for highlighting
let sessionsData = []; // Store the processed sessions data

/**
 * Get URLs of all currently active tabs
 * @returns {Promise<Array<string>>} Array of active tab URLs
 */
async function getActiveTabUrls() {
    return new Promise((resolve) => {
        chrome.tabs.query({ active: true }, (tabs) => {
            const activeUrls = tabs.map(tab => tab.url);
            console.log(`Found ${activeUrls.length} active tabs:`, activeUrls);
            resolve(activeUrls);
        });
    });
}

/**
 * Get hero images for a URL
 * @param {string} url - URL to get hero images for
 * @returns {Promise<Array>} - Hero images or null
 */
async function getHeroImagesForUrl(url) {
    return new Promise((resolve) => {
        // First check browserState if available (core shared data structure)
        if (typeof browserState !== 'undefined' && browserState.heroImages && browserState.heroImages.get) {
            const heroImageData = browserState.heroImages.get(url);
            if (heroImageData && heroImageData.images) {
                console.log(`🔍 Found hero images for ${url} in browserState`);
                return resolve(heroImageData.images);
            }
        }
        
        // Then check local storage
        chrome.storage.local.get(['heroImages'], (result) => {
            const heroImagesStore = result.heroImages || {};
            if (heroImagesStore[url]) {
                console.log(`📦 Found hero images for ${url} in local storage`);
                resolve(heroImagesStore[url].images);
            } else {
                // If not in storage, try asking background script directly
                console.log(`🔄 Hero images for ${url} not found locally, asking background script`);
                chrome.runtime.sendMessage({ action: 'getHeroImagesForUrl', url: url }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error('❌ Error getting hero images:', chrome.runtime.lastError);
                        resolve(null);
                    } else if (response && response.images) {
                        console.log(`✅ Received hero images for ${url} from background script`);
                        resolve(response.images);
                    } else {
                        console.log(`⚠️ No hero images found for ${url}`);
                        resolve(null);
                    }
                });
            }
        });
    });
}

/**
 * Renders hero images for a page if available
 * @param {Object} page - Page object with URL and dwellTime
 * @returns {Promise<HTMLElement|null>} - Hero image strip element or null
 */
async function renderHeroImagesForPage(page) {
    // Only try to show hero images for pages with significant dwell time
    if (!page.dwellTimeMs || page.dwellTimeMs < 60000) {
        return null;
    }
    
    const heroImages = await getHeroImagesForUrl(page.url);
    if (!heroImages || !heroImages.length) {
        return null;
    }
    
    // Create a horizontal strip of thumbnails
    const strip = document.createElement('div');
    strip.className = 'hero-image-strip';
    
    // Add each thumbnail
    heroImages.forEach((image, index) => {
        // Skip invalid images
        if (!image.src) return;
        
        const thumb = document.createElement('img');
        thumb.className = 'hero-image-thumbnail';
        thumb.src = image.src;
        thumb.alt = image.alt || '';
        thumb.dataset.index = index;
        thumb.dataset.fullsize = image.src;
        
        // Add click handler to expand image
        thumb.addEventListener('click', (e) => {
            // Find or create container for expanded image
            let container = strip.nextElementSibling;
            if (!container || !container.classList.contains('hero-image-container')) {
                container = document.createElement('div');
                container.className = 'hero-image-container';
                strip.insertAdjacentElement('afterend', container);
            } else {
                // Clear existing content
                container.innerHTML = '';
            }
            
            // Create expanded image
            const expandedImg = document.createElement('img');
            expandedImg.className = 'hero-image-expanded';
            expandedImg.src = image.src;
            expandedImg.alt = image.alt || '';
            
            // Add close button
            const closeBtn = document.createElement('button');
            closeBtn.className = 'hero-image-close';
            closeBtn.textContent = '×';
            closeBtn.addEventListener('click', () => {
                container.remove();
            });
            
            container.appendChild(expandedImg);
            container.appendChild(closeBtn);
        });
        
        strip.appendChild(thumb);
    });
    
    return strip;
}

document.addEventListener('DOMContentLoaded', () => {
    console.log('Sessions view DOM fully loaded and parsed');
    // Add tab group styles to document head
    addTabGroupStyles();
    initSessions();

    // Use the existing search input from the header
    const searchInput = document.getElementById('sessionSearch'); 
    if (searchInput) {
        searchInput.addEventListener('input', (event) => {
            currentSearchTerm = event.target.value.toLowerCase();
            filterAndRenderSessions(currentSearchTerm);
        });
    }
    
    // Add focus event listener to refresh data when tab gains focus
    window.addEventListener('focus', () => {
        console.log('Tab regained focus, refreshing sessions data...');
        initSessions(true); // Pass true to indicate this is a refresh
    });
    
    // Also refresh data every 5 minutes if the tab is active
    setInterval(() => {
        if (document.hasFocus()) {
            console.log('Auto-refreshing sessions data (5 minute interval)...');
            initSessions(true);
        }
    }, 5 * 60 * 1000); // 5 minutes in milliseconds
});

function filterAndRenderSessions(searchTerm) {
    if (!allSessionsData) return;

    if (!searchTerm || searchTerm.trim() === '') {
        renderSessions(allSessionsData); // Render all if search is empty
        return;
    }

    const filteredSessions = allSessionsData.filter(session => {
        // Check session name
        if (session.name && session.name.toLowerCase().includes(searchTerm)) {
            return true;
        }
        // Check pages within the session
        if (session.pages) {
            for (const page of session.pages) {
                if (page.title && page.title.toLowerCase().includes(searchTerm)) {
                    return true;
                }
                if (page.url && page.url.toLowerCase().includes(searchTerm)) {
                    return true;
                }
                
                // Check AI summary if available in cache
                const cachedSummary = getCachedSummary(page.url);
                if (cachedSummary && cachedSummary.toLowerCase().includes(searchTerm)) {
                    return true;
                }
            }
        }
        return false;
    });
    renderSessions(filteredSessions);
}

/**
 * Process sessions data from history and active tabs
 * @param {Array} activeTabUrls - Array of URLs of active tabs
 * @param {boolean} isRefresh - Whether this is a refresh operation
 * @returns {Promise<Object>} - Object with sessions array
 */
async function processSessionsData(activeTabUrls = [], isRefresh = false) {
    console.log(`Processing and rendering sessions with ${activeTabUrls.length} active tabs...`);
    
    try {
        // Fetch most recent 7 days of history data
        const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        
        // Use a larger maxResults to ensure we get all recent activity
        const [historyItems, allWindows] = await Promise.all([
            chrome.history.search({ 
                text: '', 
                maxResults: 2000,
                startTime: sevenDaysAgo 
            }),
            chrome.windows.getAll({ populate: true })
        ]);

        console.log(`Fetched ${historyItems.length} history items and ${allWindows.length} windows`);

        // Process the data into sessions
        const processedSessions = await processDataIntoSessions(historyItems, allWindows);
        
        // Apply any current search filter but don't render here
        let sessionsToReturn = processedSessions;
        
        if (currentSearchTerm && currentSearchTerm.trim() !== '') {
            sessionsToReturn = processedSessions.filter(session => {
                // Check session name
                if (session.name && session.name.toLowerCase().includes(currentSearchTerm)) {
                    return true;
                }
                // Check pages within the session
                if (session.pages) {
                    for (const page of session.pages) {
                        if (page.title && page.title.toLowerCase().includes(currentSearchTerm)) {
                            return true;
                        }
                        if (page.url && page.url.toLowerCase().includes(currentSearchTerm)) {
                            return true;
                        }
                        
                        // Check AI summary if available in cache
                        const cachedSummary = getCachedSummary(page.url);
                        if (cachedSummary && cachedSummary.toLowerCase().includes(currentSearchTerm)) {
                            return true;
                        }
                    }
                }
                return false;
            });
        }
        
        return { sessions: sessionsToReturn };
    } catch (error) {
        console.error('Error processing sessions data:', error);
        return { sessions: [] };
    }
}

async function initSessions(isRefresh = false) {
    const container = document.getElementById('sessions-container');
    const startTime = performance.now();
    
    try {
        // Get active tab URLs
        const activeTabUrls = await getActiveTabUrls();
        
        // Process sessions data (but don't render yet)
        const { sessions } = await processSessionsData(activeTabUrls, isRefresh);
        
        // Store the full dataset
        allSessionsData = sessions;
        sessionsData = sessions;
        
        // Explicitly render the sessions
        renderSessions(sessions, isRefresh);
        
        // If this is a refresh, save and restore scroll position
        if (isRefresh) {
            const scrollPos = window.scrollY;
            // Small delay to ensure DOM is updated before restoring scroll
            setTimeout(() => {
                window.scrollTo(0, scrollPos);
            }, 100);
        }
        
        // Log performance metrics
        const endTime = performance.now();
        console.log(`Sessions data ${isRefresh ? 'refreshed' : 'loaded'} in ${(endTime - startTime).toFixed(2)}ms`);
    } catch (error) {
        console.error('Failed to initialize sessions view:', error);
        if (container && !isRefresh) { // Only show error on initial load
            container.innerHTML = `<p class="error-message">Error loading sessions: ${error.message}</p>`;
        }
    }
}

/**
 * Creates a refresh indicator element that shows when data is being refreshed
 * @returns {HTMLElement} The refresh indicator element
 */
function createRefreshIndicator() {
    // Check if it already exists
    let indicator = document.getElementById('refresh-indicator');
    if (indicator) return indicator;
    
    // Create new indicator
    indicator = document.createElement('div');
    indicator.id = 'refresh-indicator';
    indicator.textContent = 'Refreshing data...';
    indicator.style.cssText = `
        position: fixed;
        top: 10px;
        right: 10px;
        background-color: rgba(0, 0, 0, 0.7);
        color: white;
        padding: 8px 12px;
        border-radius: 4px;
        font-size: 12px;
        z-index: 1000;
        opacity: 0;
        transition: opacity 0.3s ease;
        pointer-events: none;
    `;
    
    // Add a style for the active state
    const style = document.createElement('style');
    style.textContent = `
        #refresh-indicator.active {
            opacity: 1;
        }
    `;
    document.head.appendChild(style);
    
    // Add to DOM
    document.body.appendChild(indicator);
    return indicator;
}

async function processDataIntoSessions(historyItems, allWindows) { // Made async
    console.log('Processing data into sessions...');
    const SESSION_GAP_THRESHOLD = 30 * 60 * 1000; // 30 minutes in milliseconds
    const SESSION_CONTEXT_THRESHOLD = 4 * 60 * 60 * 1000; // 4 hours as extended context threshold
    let processedSessions = [];

    // 1. Combine history items and active tabs into a single list of activities
    let activities = historyItems.map(item => ({
        url: item.url,
        title: item.title || item.url,
        timestamp: item.lastVisitTime,
        type: 'history'
    }));

    // Track active tab URLs to identify active sessions later
    const activeTabUrls = new Set();
    const activeTabIds = new Set();
    
    allWindows.forEach(window => {
        if (window.tabs) {
            window.tabs.forEach(tab => {
                if (tab.url && !tab.url.startsWith('chrome://')) { // Exclude internal chrome pages
                    // Store the URL for later active session identification
                    activeTabUrls.add(tab.url);
                    activeTabIds.add(tab.id);
                    
                    activities.push({
                        url: tab.url,
                        title: tab.title || tab.url,
                        timestamp: tab.lastAccessTime || Date.now(), // lastAccessTime might not be available for all tabs, fallback to now
                        type: 'active_tab',
                        tabId: tab.id,
                        windowId: window.id,
                        active: tab.active
                    });
                }
            });
        }
    });
    
    console.log(`Found ${activeTabUrls.size} active tabs for session tracking`);

    // Only deduplicate exact timestamp duplicates, not across sessions
    // This preserves multiple visits to the same URL when they occur in different sessions
    activities = activities.reduce((acc, current) => {
        // Only consider it a duplicate if it's the same URL with nearly identical timestamp (within 1 second)
        const x = acc.find(item => item.url === current.url && Math.abs(item.timestamp - current.timestamp) < 1000);
        if (!x) {
            // No duplicate found, add the current activity
            return acc.concat([current]);
        } else if (current.type === 'active_tab' && x.type === 'history') {
            // Replace history with active_tab if it's essentially the same event
            return acc.filter(item => item !== x).concat([current]);
        }
        return acc;
    }, []);
    
    console.log(`Activities after deduplication: ${activities.length}`);


    // 2. Sort activities chronologically (oldest first for session building)
    activities.sort((a, b) => a.timestamp - b.timestamp);

    if (activities.length === 0) {
        console.log('No activities to process into sessions.');
        return [];
    }

    // 3. Group activities into sessions with context awareness
    let currentSession = null;
    let lastActivity = null;
    let sessionsByDay = {}; // Group sessions by day for context matching

    activities.forEach((activity, index) => {
        if (!activity.url) return; // Skip activities without a URL
        
        // Get day key for the activity for context matching
        const activityDate = new Date(activity.timestamp);
        const year = activityDate.getFullYear();
        const month = String(activityDate.getMonth() + 1).padStart(2, '0');
        const day = String(activityDate.getDate()).padStart(2, '0');
        const dayKey = `${year}-${month}-${day}`;
        
        if (!sessionsByDay[dayKey]) {
            sessionsByDay[dayKey] = [];
        }
        
        if (currentSession === null) {
            // Start the first session
            currentSession = createNewSession(activity);
        } else {
            const timeDiff = activity.timestamp - currentSession.endTime;
            
            // Check if we're revisiting a page that was already seen in the current session
            const previousVisitInSession = currentSession.pages.find(page => page.url === activity.url);
            const isRevisit = previousVisitInSession !== undefined;
            
            // Check for context matching with earlier sessions from the same day
            const contextSessions = sessionsByDay[dayKey].filter(session => {
                // Only consider sessions within context threshold of this activity
                return Math.abs(activity.timestamp - session.endTime) < SESSION_CONTEXT_THRESHOLD;
            });
            
            // Find if any contextual session has this URL
            const matchingContextSession = contextSessions.find(session => {
                return session.pages.some(page => page.url === activity.url);
            });
            
            if (timeDiff > SESSION_GAP_THRESHOLD) {
                // Time gap is too large, check for possible context bridge
                if (matchingContextSession && timeDiff < SESSION_CONTEXT_THRESHOLD) {
                    console.log(`Found context match for ${activity.url} in recent session`); 
                    // Add to existing session instead of creating new one
                    currentSession.pages.push({
                        url: activity.url,
                        title: activity.title,
                        visitTime: activity.timestamp,
                        isContextualRevisit: true
                    });
                    currentSession.endTime = activity.timestamp;
                } else {
                    // Time gap is too large and no context match, finalize previous session and start a new one
                    finalizeSession(currentSession, activeTabUrls);
                    sessionsByDay[dayKey].push(currentSession);
                    processedSessions.push(currentSession);
                    
                    // Start a new session
                    currentSession = createNewSession(activity);
                }
            } else {
                // Activity is part of the current session
                currentSession.pages.push({
                    url: activity.url,
                    title: activity.title,
                    visitTime: activity.timestamp,
                    isRevisit: isRevisit
                });
                currentSession.endTime = activity.timestamp;
            }
        }
        
        lastActivity = activity;
    });

    // Finalize the last session
    if (currentSession) {
        finalizeSession(currentSession, activeTabUrls);
        processedSessions.push(currentSession);
    }

    // Enrich sessions with dwell time and referral data
    if (typeof browserState !== 'undefined' && browserState.getPageActivityAndReferrals) {
        console.log('Enriching sessions with activity and referral data...');
        for (let i = 0; i < processedSessions.length; i++) {
            const session = processedSessions[i];
            if (session.pages && session.pages.length > 0) {
                const pageInfoForEnrichment = session.pages.map(p => ({
                    url: p.url,
                    visitTimestamp: p.visitTime // Map visitTime to visitTimestamp
                }));

                try {
                    const enrichedPages = await browserState.getPageActivityAndReferrals(pageInfoForEnrichment);
                    session.pages = session.pages.map((originalPage, index) => ({
                        ...originalPage,
                        ...enrichedPages[index] // Adds originalTabId, dwellTimeMs, referral
                    }));
                    console.log(`Enriched ${enrichedPages.length} pages for session ${session.id}`);
                } catch (error) {
                    console.error(`Error enriching pages for session ${session.id}:`, error);
                }
            }
        }
    } else {
        console.warn('browserState.getPageActivityAndReferrals not available. Skipping session enrichment.');
    }
    
    console.log('Processed sessions (enriched):', processedSessions);
    return processedSessions;
}

function createNewSession(activity) {
    return {
        id: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        startTime: activity.timestamp,
        endTime: activity.timestamp,
        pages: [{
            url: activity.url,
            title: activity.title,
            visitTime: activity.timestamp
        }],
        pageCount: 0, // Will be calculated in finalizeSession
        duration: 0, // Will be calculated in finalizeSession
        topDomains: [], // Will be calculated in finalizeSession
        linkTexts: [], // Placeholder
        searchQueries: [], // Placeholder
        name: '' // Will be generated in finalizeSession
    };
}

function getFaviconDisplayUrl(pageUrlOrDomain) {
    try {
        let domain = pageUrlOrDomain;
        // If it's a full URL, extract the hostname
        if (pageUrlOrDomain.includes('://')) {
            domain = new URL(pageUrlOrDomain).hostname;
        }
        // Remove www. if it exists, as Google's service sometimes works better without it for some domains
        // domain = domain.replace(/^www\./, '');
        // The above line is commented out as it might be too aggressive. Let's test without it first.
        return `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
    } catch (e) {
        console.warn('Could not generate favicon URL for:', pageUrlOrDomain, e);
        return ''; // Return empty or a default placeholder icon URL
    }
}

function extractSearchQuery(url) {
    try {
        const urlObj = new URL(url);
        let query = null;
        
        // Google search
        if (urlObj.hostname.includes('google.') && urlObj.pathname.includes('/search')) {
            query = urlObj.searchParams.get('q');
        }
        // Bing search
        else if (urlObj.hostname.includes('bing.com') && urlObj.pathname.includes('/search')) {
            query = urlObj.searchParams.get('q');
        }
        // DuckDuckGo
        else if (urlObj.hostname.includes('duckduckgo.com')) {
            query = urlObj.searchParams.get('q');
        }
        // Yahoo search
        else if (urlObj.hostname.includes('search.yahoo.com')) {
            query = urlObj.searchParams.get('p');
        }
        // Baidu
        else if (urlObj.hostname.includes('baidu.com') && urlObj.pathname.includes('/s')) {
            query = urlObj.searchParams.get('wd');
        }
        // Yandex
        else if (urlObj.hostname.includes('yandex') && urlObj.pathname.includes('/search')) {
            query = urlObj.searchParams.get('text');
        }
        // Add more search engines as needed
        
        return query;
    } catch (e) {
        console.warn('Error extracting search query:', e);
        return null;
    }
}

/**
 * Groups pages within a session by tab context
 * @param {Array} pages - Array of page objects with originalTabId and referral data
 * @returns {Array} Array of tab group objects, each with an id, name, and pages array
 */
function groupByTabContext(pages) {
    if (!pages || !Array.isArray(pages) || pages.length === 0) {
        return [];
    }
    
    console.log('Grouping pages by tab context');
    
    // Track tab relationships (parent → children)
    const tabRelationships = {};
    const tabPageMap = {}; // originalTabId → array of pages
    const orphanedPages = []; // Pages without tab ID
    const tabTimelineMap = {}; // originalTabId → { startTime, endTime }
    
    // First pass - organize pages by tab and capture relationships
    pages.forEach(page => {
        if (!page.originalTabId) {
            orphanedPages.push(page);
            return;
        }
        
        // Group pages by tab ID
        if (!tabPageMap[page.originalTabId]) {
            tabPageMap[page.originalTabId] = [];
            tabTimelineMap[page.originalTabId] = {
                startTime: page.visitTime,
                endTime: page.visitTime
            };
        }
        
        tabPageMap[page.originalTabId].push(page);
        
        // Update tab timeline
        tabTimelineMap[page.originalTabId].startTime = 
            Math.min(tabTimelineMap[page.originalTabId].startTime, page.visitTime);
        tabTimelineMap[page.originalTabId].endTime = 
            Math.max(tabTimelineMap[page.originalTabId].endTime, page.visitTime);
            
        // Establish tab relationship from referral data
        if (page.referral && page.referral.referringTabId && 
            page.referral.referringTabId !== page.originalTabId) {
            tabRelationships[page.originalTabId] = page.referral.referringTabId;
        }
    });
    
    // Create tab family trees (root tabs and their descendants)
    const rootTabs = {};
    const processedTabs = new Set();
    
    // Identify root tabs (no parent or parent not in this session)
    Object.keys(tabPageMap).forEach(tabId => {
        let currentTabId = tabId;
        let parentTabId = tabRelationships[currentTabId];
        let isRoot = true;
        
        // Trace back to find the ultimate parent within this session
        while (parentTabId && tabPageMap[parentTabId]) {
            currentTabId = parentTabId;
            parentTabId = tabRelationships[currentTabId];
            isRoot = false;
        }
        
        // Found a root tab
        if (isRoot && !rootTabs[tabId]) {
            rootTabs[tabId] = {
                tabId: tabId,
                childTabs: [],
                pages: tabPageMap[tabId],
                startTime: tabTimelineMap[tabId].startTime,
                endTime: tabTimelineMap[tabId].endTime
            };
        }
        // Found a descendant of a root
        else if (!isRoot) {
            if (!rootTabs[currentTabId]) {
                rootTabs[currentTabId] = {
                    tabId: currentTabId,
                    childTabs: [],
                    pages: tabPageMap[currentTabId],
                    startTime: tabTimelineMap[currentTabId].startTime,
                    endTime: tabTimelineMap[currentTabId].endTime
                };
            }
            
            // Don't add immediate children here - will do in next pass
        }
    });
    
    // Add immediate children to their parents
    Object.keys(tabRelationships).forEach(tabId => {
        const parentTabId = tabRelationships[tabId];
        if (rootTabs[parentTabId]) {
            rootTabs[parentTabId].childTabs.push(tabId);
        }
    });
    
    // Now, create tab groups from root tabs
    const tabGroups = [];
    let groupCounter = 0;
    
    // Helper to recursively collect pages from a tab family
    function collectTabFamilyPages(tabId) {
        let allPages = [];
        
        if (tabPageMap[tabId]) {
            allPages = allPages.concat(tabPageMap[tabId]);
            
            // Process direct children of this tab
            const childTabs = Object.keys(tabRelationships)
                .filter(childId => tabRelationships[childId] === tabId);
                
            childTabs.forEach(childTabId => {
                allPages = allPages.concat(collectTabFamilyPages(childTabId));
            });
        }
        
        return allPages;
    }
    
    // Create groups from root tabs
    Object.keys(rootTabs).forEach(rootTabId => {
        const rootTab = rootTabs[rootTabId];
        
        // Collect all pages from this tab family
        let allTabFamilyPages = collectTabFamilyPages(rootTabId);
        
        // Only create groups with multiple pages
        if (allTabFamilyPages.length > 0) {
            // Sort pages chronologically
            allTabFamilyPages.sort((a, b) => a.visitTime - b.visitTime);
            
            // Create a name based on the first meaningful page
            const nameSources = allTabFamilyPages.filter(p => 
                p.title && !p.title.toLowerCase().includes('new tab'));
                
            let groupName = nameSources.length > 0 ? 
                nameSources[0].title : 
                `Tab Group ${groupCounter + 1}`;
                
            // Truncate long names
            if (groupName.length > 50) {
                groupName = groupName.substring(0, 47) + '...';
            }
            
            const groupId = `tab_group_${rootTabId}`;
            
            tabGroups.push({
                id: groupId,
                name: groupName,
                pages: allTabFamilyPages,
                rootTabId: rootTabId,
                pageCount: allTabFamilyPages.length,
                startTime: allTabFamilyPages[0].visitTime,
                endTime: allTabFamilyPages[allTabFamilyPages.length - 1].visitTime,
                duration: allTabFamilyPages[allTabFamilyPages.length - 1].visitTime - 
                          allTabFamilyPages[0].visitTime
            });
            
            groupCounter++;
        }
    });
    
    // Handle orphaned pages (no tab ID)
    if (orphanedPages.length > 0) {
        orphanedPages.sort((a, b) => a.visitTime - b.visitTime);
        
        tabGroups.push({
            id: 'orphaned_pages',
            name: 'Other Pages',
            pages: orphanedPages,
            pageCount: orphanedPages.length,
            startTime: orphanedPages[0].visitTime,
            endTime: orphanedPages[orphanedPages.length - 1].visitTime,
            duration: orphanedPages[orphanedPages.length - 1].visitTime - orphanedPages[0].visitTime,
            isOrphanGroup: true
        });
    }
    
    // Sort groups chronologically by their start time
    tabGroups.sort((a, b) => a.startTime - b.startTime);
    
    console.log(`Created ${tabGroups.length} tab groups from ${pages.length} pages`);
    return tabGroups;
}

function finalizeSession(session, activeTabUrls) {
    session.duration = session.endTime - session.startTime;
    
    const uniqueUrls = new Set(session.pages.map(p => p.url));
    session.pageCount = uniqueUrls.size;
    
    // Check if this session contains any currently active tabs
    if (activeTabUrls && activeTabUrls.size > 0) {
        // Check if any URL in the session is currently open in a tab
        session.hasActiveTabs = session.pages.some(page => activeTabUrls.has(page.url));
    } else {
        session.hasActiveTabs = false;
    }
    
    // Extract search queries from all URLs in the session
    session.searchQueries = [];
    if (session.pages) {
        session.pages.forEach(page => {
            const query = extractSearchQuery(page.url);
            if (query && query.trim() !== '' && !session.searchQueries.includes(query)) {
                session.searchQueries.push(query);
            }
        });
    }
    
    // Create tab groups for large sessions (>10 pages or >1 hour)
    const ONE_HOUR = 60 * 60 * 1000;
    const LARGE_SESSION_PAGE_THRESHOLD = 10;
    const isLargeSession = session.pageCount > LARGE_SESSION_PAGE_THRESHOLD || session.duration > ONE_HOUR;
    
    if (isLargeSession && session.pages && session.pages.length > 0) {
        console.log(`Session ${session.id} is large (${session.pageCount} pages, ${formatDuration(session.duration)}). Creating tab groups.`);
        session.tabGroups = groupByTabContext(session.pages);
        session.hasTabGroups = session.tabGroups && session.tabGroups.length > 0;
        
        if (session.hasTabGroups) {
            // Extract most meaningful tab group for session naming
            const meaningfulGroups = session.tabGroups
                .filter(group => !group.isOrphanGroup)
                .sort((a, b) => b.pageCount - a.pageCount);
                
            if (meaningfulGroups.length > 0 && meaningfulGroups[0].name) {
                session.primaryTabGroup = meaningfulGroups[0];
            }
        }
    } else {
        session.hasTabGroups = false;
    }

    // Updated session naming
    if (session.pages.length > 0) {
        const firstPageTitle = session.pages[0].title;
        if (firstPageTitle && firstPageTitle.toLowerCase() !== 'new tab' && firstPageTitle.length > 10) {
            session.name = `${firstPageTitle.substring(0,70)}${firstPageTitle.length > 70 ? '...' : ''}`;
        } else {
            session.name = `Session from ${new Date(session.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} - ${new Date(session.startTime).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
        }
    } else {
        session.name = `Brief Session - ${new Date(session.startTime).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
    }

    const domainCounts = session.pages.reduce((acc, page) => {
        try {
            const domain = new URL(page.url).hostname;
            acc[domain] = (acc[domain] || 0) + 1;
        } catch (e) {
            console.warn('Invalid URL encountered for domain extraction:', page.url);
        }
        return acc;
    }, {});

    // Dynamic number of top domains
    let numTopDomains = 5; // Default
    if (session.pageCount < 5) {
        numTopDomains = 3;
    } else if (session.pageCount >= 15) {
        numTopDomains = 7;
    }

    session.topDomains = Object.entries(domainCounts)
        .sort(([,a],[,b]) => b-a)
        .slice(0, numTopDomains)
        .map(([domain]) => ({
            domain: domain,
            faviconUrl: getFaviconDisplayUrl(domain) // Get favicon for the domain itself
        }));

    // Populate linkTexts from enriched page data
    session.linkTexts = [];
    if (session.pages) {
        session.pages.forEach(page => {
            if (page.referral && page.referral.linkText && !session.linkTexts.includes(page.referral.linkText)) {
                session.linkTexts.push(page.referral.linkText);
            }
        });
    }
}

function formatDuration(milliseconds) {
    if (milliseconds < 0 || isNaN(milliseconds)) return 'N/A';
    let totalSeconds = Math.floor(milliseconds / 1000);
    let hours = Math.floor(totalSeconds / 3600);
    let minutes = Math.floor((totalSeconds % 3600) / 60);
    let seconds = totalSeconds % 60;

    let parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
        
    return parts.join(' ');
}

function createListElement(items, title) {
    if (!items || items.length === 0) return null;
    const listContainer = document.createElement('div');
    listContainer.className = 'session-detail-list';
    const listTitle = document.createElement('strong');
    listTitle.textContent = `${title}: `;
    listContainer.appendChild(listTitle);
    const ul = document.createElement('ul');
    items.forEach(item => {
        const li = document.createElement('li');
        li.textContent = item;
        ul.appendChild(li);
    });
    listContainer.appendChild(ul);
    return listContainer;
}

function createDomainListElement(domains) { // Removed title parameter
    if (!domains || domains.length === 0) return null;
    const listContainer = document.createElement('div');
    listContainer.className = 'session-detail-list session-domain-list';
    // Removed title element creation
    const ul = document.createElement('ul');
    domains.forEach(item => {
        const li = document.createElement('li');
        const anchor = document.createElement('a');
        anchor.href = '#'; // Prevent page jump, actual navigation handled by JS
        anchor.className = 'domain-pill-link';
        anchor.style.textDecoration = 'none';
        anchor.style.color = 'inherit';
        anchor.style.cursor = 'pointer';

        if (item.faviconUrl) {
            const img = document.createElement('img');
            img.src = item.faviconUrl;
            img.alt = `${item.domain} favicon`;
            img.className = 'favicon-img';
            anchor.appendChild(img);
        }
        anchor.appendChild(document.createTextNode(`${item.faviconUrl ? ' ' : ''}${item.domain}`));
        
        anchor.addEventListener('click', async (event) => {
            event.preventDefault(); // Prevent default anchor behavior
            const domainToFind = item.domain;
            try {
                const tabs = await chrome.tabs.query({});
                let foundTab = null;
                for (const tab of tabs) {
                    if (tab.url) {
                        try {
                            const tabHostname = new URL(tab.url).hostname;
                            if (tabHostname === domainToFind || tabHostname.endsWith('.' + domainToFind)) {
                                foundTab = tab;
                                break;
                            }
                        } catch (e) {
                            // Invalid URL, skip
                        }
                    }
                }

                if (foundTab) {
                    await chrome.tabs.update(foundTab.id, { active: true });
                    await chrome.windows.update(foundTab.windowId, { focused: true });
                } else {
                    await chrome.tabs.create({ url: `https://${domainToFind}` });
                }
            } catch (error) {
                console.error('Error handling domain click:', error);
            }
        });

        li.appendChild(anchor);
        ul.appendChild(li);
    });
    listContainer.appendChild(ul);
    return listContainer;
}

/**
 * Adds CSS styles for tab grouping visualization
 * This should be called once during initialization
 */
function addTabGroupStyles() {
    // Check if styles are already added
    if (document.getElementById('session-tab-group-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'session-tab-group-styles';
    
    // Define the color palette
    const groupColors = [
        '#3498db', // Blue
        '#2ecc71', // Green
        '#e74c3c', // Red
        '#f39c12', // Yellow
        '#9b59b6', // Purple
        '#1abc9c', // Turquoise
        '#d35400', // Pumpkin
        '#7f8c8d', // Gray
        '#27ae60', // Nephritis
        '#c0392b', // Pomegranate
    ];
    
    let styleContent = `
        .tab-group-header {
            border-bottom: 1px solid #ddd;
            padding: 8px 0;
            margin-bottom: 10px;
            font-weight: bold;
        }
        
        .page-list {
            list-style-type: none;
            padding-left: 0;
            margin: 0;
        }
        
        .page-item {
            padding: 8px;
            margin-bottom: 8px;
            border-radius: 4px;
            background-color: #f9f9f9;
            border-left: 4px solid #ddd;
        }
        
        .page-title {
            font-weight: bold;
            margin-bottom: 4px;
        .hero-image-thumbnail:hover {
            transform: translateY(-2px);
            box-shadow: 0 3px 6px rgba(0,0,0,0.16);
        }
        
        .hero-image-expanded {
            display: block;
            max-width: 100%;
            max-height: 300px;
            margin: 10px auto;
            border-radius: 6px;
            box-shadow: 0 3px 10px rgba(0,0,0,0.2);
            object-fit: contain;
        }
        
        .hero-image-container {
            position: relative;
            margin: 10px 0;
            text-align: center;
        }
        
        .hero-image-close {
            position: absolute;
            top: 5px;
            right: 5px;
            background: rgba(0,0,0,0.6);
            color: white;
            border: none;
            border-radius: 50%;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            font-size: 14px;
        }
    `;
    document.head.appendChild(style);
}

/**
 * Renders a session's pages grouped by tab context for large sessions
 * @param {Object} session - The session object with tabGroups
 * @returns {HTMLElement} The container with tab groups
 */
function renderTabGroupedPageList(session) {
    const container = document.createElement('div');
    container.className = 'session-pages-list tab-grouped-pages';
    
    // Display summary of tab groups
    const tabGroupSummary = document.createElement('div');
    tabGroupSummary.className = 'tab-groups-summary';
    tabGroupSummary.innerHTML = `<strong>This session contains ${session.tabGroups.length} tab groups across ${session.pageCount} pages</strong>`;
    container.appendChild(tabGroupSummary);
    
    // Create an accordion for each tab group
    session.tabGroups.forEach((tabGroup, index) => {
        const tabGroupContainer = document.createElement('div');
        tabGroupContainer.className = 'tab-group';
        tabGroupContainer.setAttribute('data-group-id', tabGroup.id);
        
        // Create header with group name and toggle capability
        const tabGroupHeader = document.createElement('div');
        tabGroupHeader.className = 'tab-group-header';
        
        // Add expand/collapse icon
        const expandIcon = document.createElement('span');
        expandIcon.className = 'tab-group-expand-icon';
        expandIcon.textContent = '►';
        tabGroupHeader.appendChild(expandIcon);
        
        // Add group name and page count
        const groupTitle = document.createElement('h4');
        groupTitle.className = 'tab-group-title';
        groupTitle.textContent = `${tabGroup.name || 'Tab Group ' + (index + 1)} (${tabGroup.pageCount} pages)`;
        tabGroupHeader.appendChild(groupTitle);
        
        // Add time range
        const timeRangeSpan = document.createElement('span');
        timeRangeSpan.className = 'tab-group-timerange';
        const startTime = new Date(tabGroup.startTime).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
        const endTime = new Date(tabGroup.endTime).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
        timeRangeSpan.textContent = `${startTime} - ${endTime} (${formatDuration(tabGroup.duration)})`;
        tabGroupHeader.appendChild(timeRangeSpan);
        
        tabGroupContainer.appendChild(tabGroupHeader);
        
        // Create collapsible content for pages
        const tabGroupContent = document.createElement('div');
        tabGroupContent.className = 'tab-group-content collapsed';
        
        // Create standard page list for this group's pages
        const ul = document.createElement('ul');
        ul.className = 'group-pages-list';
        
        // Sort pages chronologically
        const sortedPages = [...tabGroup.pages].sort((a,b) => a.visitTime - b.visitTime);
        
        // Use the current search term for highlighting
        const searchTerm = currentSearchTerm;
        
        sortedPages.forEach(page => {
            const li = document.createElement('li');
            li.className = 'session-page-item';
            
            // Add tab indicator if we have originating tab information
            if (page.originalTabId) {
                const tabIndicator = document.createElement('span');
                tabIndicator.className = 'tab-indicator';
                tabIndicator.title = `Tab ID: ${page.originalTabId}`;
                
                // If this is a child tab that was opened from another tab, show that relationship
                if (page.referral && page.referral.referringTabId) {
                    tabIndicator.classList.add('child-tab');
                    tabIndicator.title += ` (opened from Tab ID: ${page.referral.referringTabId})`;
                }
                
                li.appendChild(tabIndicator);
            }
    
            const faviconImg = document.createElement('img');
            faviconImg.className = 'page-favicon-img';
            faviconImg.src = getFaviconDisplayUrl(page.url);
            faviconImg.alt = ''; // Decorative
            li.appendChild(faviconImg);
    
            const pageDetails = document.createElement('div');
            pageDetails.className = 'page-item-details';
    
            // Title with optional highlight
            const titleLink = document.createElement('a');
            titleLink.href = page.url;
            const titleText = page.title || page.url;
            if (searchTerm && titleText.toLowerCase().includes(searchTerm)) {
                titleLink.innerHTML = highlightText(titleText, searchTerm);
            } else {
                titleLink.textContent = titleText;
            }
            titleLink.className = 'page-title-link';
            titleLink.target = '_blank'; // Open in new tab
            pageDetails.appendChild(titleLink);
    
            // URL with optional highlight
            const urlText = document.createElement('span');
            urlText.className = 'page-url-text';
            if (searchTerm && page.url.toLowerCase().includes(searchTerm)) {
                urlText.innerHTML = highlightText(page.url, searchTerm);
            } else {
                urlText.textContent = page.url;
            }
            pageDetails.appendChild(urlText);
            
            const visitTimeText = document.createElement('span');
            visitTimeText.className = 'page-visit-time';
            visitTimeText.textContent = `Visited: ${new Date(page.visitTime).toLocaleString()}`;
            pageDetails.appendChild(visitTimeText);
    
            // Display Dwell Time
            if (page.dwellTimeMs && page.dwellTimeMs > 0) {
                const dwellTimeText = document.createElement('span');
                dwellTimeText.className = 'page-dwell-time';
                dwellTimeText.textContent = `Dwell time: ${formatDuration(page.dwellTimeMs)}`;
                pageDetails.appendChild(dwellTimeText);
            }
    
            // Display Referral Info
            if (page.referral) {
                const referralDiv = document.createElement('div');
                referralDiv.className = 'page-referral-info';
                let referralHtml = 'Referred by: ';
                if (page.referral.type === 'tabOpen') {
                    if (page.referral.sourceUrl) {
                        const sourceLink = document.createElement('a');
                        sourceLink.href = page.referral.sourceUrl;
                        sourceLink.textContent = page.referral.sourceUrl.length > 70 ? 
                            page.referral.sourceUrl.substring(0, 67) + '...' : page.referral.sourceUrl;
                        sourceLink.target = '_blank';
                        referralDiv.appendChild(document.createTextNode(referralHtml));
                        referralDiv.appendChild(sourceLink);
                    } else {
                        referralDiv.textContent = referralHtml + 'an unknown source tab';
                    }
                    if (page.referral.linkText) {
                        referralDiv.appendChild(document.createTextNode(` (link: "${page.referral.linkText}")`));
                    }
                } else {
                    // Fallback for other referral types
                    referralDiv.textContent = referralHtml + 'unknown mechanism.';
                }
                pageDetails.appendChild(referralDiv);
            }
            
            // Check for hero images if the page has significant dwell time (>60s)
            if (page.dwellTimeMs && page.dwellTimeMs >= 60000) {
                // Add a loading placeholder that will be replaced asynchronously
                const heroImagePlaceholder = document.createElement('div');
                heroImagePlaceholder.className = 'hero-image-placeholder';
                heroImagePlaceholder.setAttribute('data-url', page.url);
                pageDetails.appendChild(heroImagePlaceholder);
                
                // Asynchronously load hero images
                getHeroImagesForUrl(page.url).then(heroImages => {
                    if (heroImages && heroImages.length > 0) {
                        // Create a horizontal strip of thumbnails
                        const strip = document.createElement('div');
                        strip.className = 'hero-image-strip';
                        
                        // Add each thumbnail
                        heroImages.forEach((image, index) => {
                            // Skip invalid images
                            if (!image.src) return;
                            
                            const thumb = document.createElement('img');
                            thumb.className = 'hero-image-thumbnail';
                            thumb.src = image.src;
                            thumb.alt = image.alt || '';
                            thumb.dataset.index = index;
                            
                            // Add click handler to expand image
                            thumb.addEventListener('click', (e) => {
                                e.stopPropagation(); // Prevent tab group toggle
                                
                                // Find or create container for expanded image
                                let container = strip.nextElementSibling;
                                if (!container || !container.classList.contains('hero-image-container')) {
                                    container = document.createElement('div');
                                    container.className = 'hero-image-container';
                                    strip.insertAdjacentElement('afterend', container);
                                } else {
                                    // Clear existing content
                                    container.innerHTML = '';
                                }
                                
                                // Create expanded image
                                const expandedImg = document.createElement('img');
                                expandedImg.className = 'hero-image-expanded';
                                expandedImg.src = image.src;
                                expandedImg.alt = image.alt || '';
                                
                                // Add close button
                                const closeBtn = document.createElement('button');
                                closeBtn.className = 'hero-image-close';
                                closeBtn.textContent = '\u00d7'; // × symbol
                                closeBtn.addEventListener('click', (e) => {
                                    e.stopPropagation(); // Prevent tab group toggle
                                    container.remove();
                                });
                                
                                container.appendChild(expandedImg);
                                container.appendChild(closeBtn);
                            });
                            
                            strip.appendChild(thumb);
                        });
                        
                        // Replace placeholder with actual content
                        if (strip.children.length > 0) {
                            heroImagePlaceholder.replaceWith(strip);
                        } else {
                            heroImagePlaceholder.remove();
                        }
                    } else {
                        // No images found, remove placeholder
                        heroImagePlaceholder.remove();
                    }
                });
            }
            
            // Handle summary display similar to the original function
            const cachedSummary = getCachedSummary(page.url);
            const isInternalUrl = page.url.startsWith('chrome://') || page.url.startsWith('file:///');
            
            if (cachedSummary || !isInternalUrl) {
                const summaryDiv = document.createElement('div');
                summaryDiv.className = 'page-summary';
                
                const summaryLabel = document.createElement('div');
                summaryLabel.className = 'summary-label';
                
                if (cachedSummary) {
                    summaryLabel.textContent = 'AI Summary';
                } else {
                    summaryLabel.innerHTML = 'AI Summary <span class="loading-indicator">...</span>';
                    
                    const checkSummaryInterval = setInterval(() => {
                        const newCachedSummary = getCachedSummary(page.url);
                        if (newCachedSummary) {
                            clearInterval(checkSummaryInterval);
                            summaryLabel.textContent = 'AI Summary';
                            const summaryContent = document.createElement('p');
                            summaryContent.textContent = newCachedSummary;
                            summaryDiv.appendChild(summaryContent);
                        }
                    }, 3000); // Check every 3 seconds
                }
                
                summaryDiv.appendChild(summaryLabel);
                
                if (cachedSummary) {
                    const summaryContent = document.createElement('p');
                    summaryContent.textContent = cachedSummary;
                    summaryDiv.appendChild(summaryContent);
                }
                
                pageDetails.appendChild(summaryDiv);
            }
            
            li.appendChild(pageDetails);
            ul.appendChild(li);
        });
        
        tabGroupContent.appendChild(ul);
        tabGroupContainer.appendChild(tabGroupContent);
        container.appendChild(tabGroupContainer);
        
        // Set up click handlers to toggle tab group expansion
        const toggleExpansion = (event) => {
            // Check if the click is on an interactive element or link
            if (event.target.tagName === 'A' || 
                event.target.closest('a') ||
                event.target.closest('.page-item-details')) {
                // Don't handle clicks on interactive elements inside the content
                return;
            }
            
            const isExpanded = tabGroupContent.classList.contains('expanded');
            tabGroupContent.classList.toggle('expanded', !isExpanded);
            tabGroupContent.classList.toggle('collapsed', isExpanded);
            expandIcon.textContent = isExpanded ? '►' : '▼';
        };
        
        // Add click handler to header (guaranteed to work)
        tabGroupHeader.addEventListener('click', toggleExpansion);
        
        // Add click handler to entire container for better UX
        tabGroupContainer.addEventListener('click', (event) => {
            // Only handle clicks directly on the container itself,
            // not bubbled events from content elements
            if (event.target === tabGroupContainer) {
                toggleExpansion(event);
            }
        });
    });
    
    return container;
}

function renderSessionPageList(pages, session) {
    const pageListContainer = document.createElement('div');
    pageListContainer.className = 'session-pages-list';
    
    // Check if this session has tab groups and should use them
    if (session && session.hasTabGroups && session.tabGroups && session.tabGroups.length > 0) {
        return renderTabGroupedPageList(session);
    }
    
    const ul = document.createElement('ul');

    // Sort pages chronologically if not already sorted (oldest to newest for display)
    const sortedPages = [...pages].sort((a,b) => a.visitTime - b.visitTime);

    // Use the current search term for highlighting
    const searchTerm = currentSearchTerm;
    
    sortedPages.forEach(page => {
        const li = document.createElement('li');
        li.className = 'session-page-item';

        const faviconImg = document.createElement('img');
        faviconImg.className = 'page-favicon-img';
        faviconImg.src = getFaviconDisplayUrl(page.url);
        faviconImg.alt = ''; // Decorative
        li.appendChild(faviconImg);

        const pageDetails = document.createElement('div');
        pageDetails.className = 'page-item-details';

        // Title with optional highlight
        const titleLink = document.createElement('a');
        titleLink.href = page.url;
        const titleText = page.title || page.url;
        if (searchTerm && titleText.toLowerCase().includes(searchTerm)) {
            titleLink.innerHTML = highlightText(titleText, searchTerm);
        } else {
            titleLink.textContent = titleText;
        }
        titleLink.className = 'page-title-link';
        titleLink.target = '_blank'; // Open in new tab
        pageDetails.appendChild(titleLink);

        // URL with optional highlight
        const urlText = document.createElement('span');
        urlText.className = 'page-url-text';
        if (searchTerm && page.url.toLowerCase().includes(searchTerm)) {
            urlText.innerHTML = highlightText(page.url, searchTerm);
        } else {
            urlText.textContent = page.url;
        }
        pageDetails.appendChild(urlText);
        
        const visitTimeText = document.createElement('span');
        visitTimeText.className = 'page-visit-time';
        visitTimeText.textContent = `Visited: ${new Date(page.visitTime).toLocaleString()}`;
        pageDetails.appendChild(visitTimeText);

        // Display Dwell Time
        if (page.dwellTimeMs && page.dwellTimeMs > 0) {
            const dwellTimeText = document.createElement('span');
            dwellTimeText.className = 'page-dwell-time';
            dwellTimeText.textContent = `Dwell time: ${formatDuration(page.dwellTimeMs)}`;
            pageDetails.appendChild(dwellTimeText);
        }

        // Display Referral Info
        if (page.referral) {
            const referralDiv = document.createElement('div');
            referralDiv.className = 'page-referral-info';
            let referralHtml = 'Referred by: ';
            if (page.referral.type === 'tabOpen') {
                if (page.referral.sourceUrl) {
                    const sourceLink = document.createElement('a');
                    sourceLink.href = page.referral.sourceUrl;
                    sourceLink.textContent = page.referral.sourceUrl.length > 70 ? page.referral.sourceUrl.substring(0, 67) + '...' : page.referral.sourceUrl;
                    sourceLink.target = '_blank';
                    referralDiv.appendChild(document.createTextNode(referralHtml));
                    referralDiv.appendChild(sourceLink);
                } else {
                    referralDiv.textContent = referralHtml + 'an unknown source tab';
                }
                if (page.referral.linkText) {
                    referralDiv.appendChild(document.createTextNode(` (link: "${page.referral.linkText}")`));
                }
            } else {
                 // Fallback for other referral types if ever introduced
                referralDiv.textContent = referralHtml + 'unknown mechanism.';
            }
            pageDetails.appendChild(referralDiv);
        }
        
        // Handle summary display with loading indicator for non-cached summaries
        const cachedSummary = getCachedSummary(page.url);
        const isInternalUrl = page.url.startsWith('chrome://') || page.url.startsWith('file:///');
        
        // Only show summary section if we have a cached summary or if URL is valid for summarization
        if (cachedSummary || !isInternalUrl) {
            const summaryDiv = document.createElement('div');
            summaryDiv.className = 'page-summary';
            
            // Add a small label indicating this is an AI summary
            const summaryLabel = document.createElement('div');
            summaryLabel.className = 'summary-label';
            
            if (cachedSummary) {
                summaryLabel.textContent = 'AI Summary';
            } else {
                // Use a loading indicator instead of static text
                summaryLabel.innerHTML = 'AI Summary <span class="loading-indicator">...</span>';
                
                // Set up polling to check for summary availability
                const checkSummaryInterval = setInterval(() => {
                    const updatedSummary = getCachedSummary(page.url);
                    if (updatedSummary) {
                        clearInterval(checkSummaryInterval);
                        // Update the label to remove loading indicator
                        summaryLabel.textContent = 'AI Summary';
                        // Create and add summary content
                        const summaryContent = document.createElement('div');
                        summaryContent.innerHTML = createTruncatedSummary(updatedSummary, searchTerm);
                        summaryDiv.appendChild(summaryContent);
                    }
                }, 2000); // Check every 2 seconds
                
                // Stop checking after 30 seconds to avoid resource waste
                setTimeout(() => clearInterval(checkSummaryInterval), 30000);
            }
            
            summaryDiv.appendChild(summaryLabel);
            
            // Only add content if we have a cached summary
            if (cachedSummary) {
                const summaryContent = document.createElement('div');
                summaryContent.innerHTML = createTruncatedSummary(cachedSummary, searchTerm);
                summaryDiv.appendChild(summaryContent);
            }
            
            pageDetails.appendChild(summaryDiv);
        }

        li.appendChild(pageDetails);
        ul.appendChild(li);
    });

    pageListContainer.appendChild(ul);
    return pageListContainer;
}

/**
 * Renders sessions in the UI
 * @param {Array} sessions - Array of session objects to render
 * @param {boolean} isRefresh - Whether this is a refresh operation
 */
function renderSessions(sessions, isRefresh = false) {
    const container = document.getElementById('sessions-container');
    if (!container) return;

    // If refreshing, keep track of which sessions were expanded
    const expandedSessionIds = [];
    if (isRefresh) {
        // Find all expanded sessions
        const expandedSessions = container.querySelectorAll('.session-item.expanded');
        expandedSessions.forEach(session => {
            const sessionId = session.getAttribute('data-session-id');
            if (sessionId) {
                expandedSessionIds.push(sessionId);
            }
        });
    }

    // Clear existing content
    container.innerHTML = '';

    if (sessions.length === 0) {
        const noSessionsMessage = document.createElement('p');
        noSessionsMessage.className = 'info-message';
        noSessionsMessage.textContent = 'No browsing sessions found. Start browsing or try modifying your filters.';
        container.appendChild(noSessionsMessage);
        return;
    }
    
    // Define time period boundaries (in hours, 24-hour format)
    const timePeriods = [
        { name: 'Early Morning', start: 0, end: 6 },
        { name: 'Morning', start: 6, end: 12 },
        { name: 'Afternoon', start: 12, end: 17 },
        { name: 'Evening', start: 17, end: 21 },
        { name: 'Night', start: 21, end: 24 }
    ];
    
    // Helper function to get time period for a given hour
    function getTimePeriod(hour) {
        return timePeriods.find(period => hour >= period.start && hour < period.end) || timePeriods[0];
    }
    
    // Group sessions by date and time period
    const sessionsByDateAndPeriod = {};
    
    sessions.forEach(session => {
        // Get the date string in local timezone, ensuring we're working with milliseconds timestamps
        const sessionDate = new Date(Number(session.startTime));
        
        // Debug timestamp conversion
        console.log('Session timestamp conversion:', {
            originalTimestamp: session.startTime,
            numericTimestamp: Number(session.startTime),
            convertedDate: sessionDate.toLocaleString(),
            tzOffset: sessionDate.getTimezoneOffset()
        });
        
        // Fix timezone issues by using local date methods instead of toISOString() which uses UTC
        const year = sessionDate.getFullYear();
        const month = String(sessionDate.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
        const day = String(sessionDate.getDate()).padStart(2, '0');
        
        // Create date key in YYYY-MM-DD format using local time
        const dateKey = `${year}-${month}-${day}`;
        
        const hour = sessionDate.getHours();
        const period = getTimePeriod(hour);
        const dateAndPeriodKey = `${dateKey}_${period.name}`;
        
        console.log(`Session from ${sessionDate.toLocaleString()} grouped into date: ${dateKey}, period: ${period.name}`);
        
        if (!sessionsByDateAndPeriod[dateAndPeriodKey]) {
            sessionsByDateAndPeriod[dateAndPeriodKey] = {
                date: dateKey,
                period: period.name,
                hour: period.start, // Use this for sorting
                sessions: []
            };
        }
        
        sessionsByDateAndPeriod[dateAndPeriodKey].sessions.push(session);
    });
    
    // Sort dates in reverse chronological order (newest first)
    // First group by date
    const groupedByDate = {};
    Object.entries(sessionsByDateAndPeriod).forEach(([key, data]) => {
        if (!groupedByDate[data.date]) {
            groupedByDate[data.date] = [];
        }
        groupedByDate[data.date].push(data);
    });
    
    const sortedDates = Object.keys(groupedByDate).sort((a, b) => b.localeCompare(a));
    
    // For each date, process each time period
    sortedDates.forEach(dateKey => {
        const date = new Date(dateKey);
        
        // Format the date nicely for the main date heading
        // Ensure we're working with fresh date objects in local timezone
        const today = new Date();
        
        // Log raw dates for debugging
        console.log('Raw date comparison:', {
            sessionDateObj: date,
            sessionDateKey: dateKey,
            todayObj: today,
            sessionTimestamp: date.getTime(),
            todayTimestamp: today.getTime(),
            sessionDateString: date.toLocaleString(),
            todayDateString: today.toLocaleString()
        });
        
        // Explicitly create today's date key using the same consistent method
        // Use local methods to ensure proper timezone handling
        const todayYear = today.getFullYear();
        const todayMonth = String(today.getMonth() + 1).padStart(2, '0');
        const todayDay = String(today.getDate()).padStart(2, '0');
        const todayDateKey = `${todayYear}-${todayMonth}-${todayDay}`; // YYYY-MM-DD format in local time
        
        // Create yesterday reference using local methods too
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayYear = yesterday.getFullYear();
        const yesterdayMonth = String(yesterday.getMonth() + 1).padStart(2, '0');
        const yesterdayDay = String(yesterday.getDate()).padStart(2, '0');
        const yesterdayDateKey = `${yesterdayYear}-${yesterdayMonth}-${yesterdayDay}`;
        
        let dateDisplay;
        
        console.log(`Comparing dates: dateKey=${dateKey}, todayDateKey=${todayDateKey}, match=${dateKey === todayDateKey}`);

        if (dateKey === todayDateKey) {
            // For today, use the actual today date object for formatting
            const todayDayOfWeek = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(today);
            const todayNumericFormat = new Intl.DateTimeFormat('en-US', { 
                month: 'numeric', 
                day: 'numeric', 
                year: 'numeric' 
            }).format(today);
            dateDisplay = `Today (${todayDayOfWeek}): ${todayNumericFormat}`;
        } else if (dateKey === yesterdayDateKey) {
            const yesterdayDayOfWeek = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(yesterday);
            const yesterdayNumericFormat = new Intl.DateTimeFormat('en-US', { 
                month: 'numeric', 
                day: 'numeric', 
                year: 'numeric' 
            }).format(yesterday);
            dateDisplay = `Yesterday (${yesterdayDayOfWeek}): ${yesterdayNumericFormat}`;
        } else {
            // For other dates, use consistent formatting with day of week
            const dayOfWeek = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(date);
            const numericFormat = new Intl.DateTimeFormat('en-US', { 
                month: 'numeric', 
                day: 'numeric',
                year: 'numeric'
            }).format(date);
            
            const fullDateFormat = new Intl.DateTimeFormat('en-US', { 
                month: 'long', 
                day: 'numeric'
            }).format(date);
            
            dateDisplay = `${fullDateFormat} (${dayOfWeek}): ${numericFormat}`;
        }
        
        // Create main date milestone
        const dateMilestone = document.createElement('div');
        dateMilestone.className = 'date-milestone main-milestone';
        dateMilestone.textContent = dateDisplay;
        container.appendChild(dateMilestone);
        
        // Sort time periods within this date (evening before morning)
        const timePeriods = groupedByDate[dateKey].sort((a, b) => b.hour - a.hour);
        
        timePeriods.forEach(periodData => {
            const { period, sessions } = periodData;
            
            // Create period milestone if we have sessions in this period
            if (sessions.length > 0) {
                // Get the earliest session time in this period for the time label
                const firstSession = sessions.reduce((earliest, current) => 
                    current.startTime < earliest.startTime ? current : earliest
                );
                
                // Format the time for display
                const periodTime = new Date(firstSession.startTime);
                const timeString = periodTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                
                const periodMilestone = document.createElement('div');
                periodMilestone.className = 'date-milestone period-milestone';
                periodMilestone.textContent = `${period}: ${timeString}`;
                container.appendChild(periodMilestone);
                
                // Create a row for sessions from this period
                const sessionsRow = document.createElement('div');
                sessionsRow.className = 'sessions-row';
                container.appendChild(sessionsRow);
                
                // Sort sessions by descending start time
                sessions.sort((a, b) => b.startTime - a.startTime);
                
                // Calculate time deltas for vertical offset
                let previousTime = sessions[0].startTime; // Start with the most recent session time
                
                // Render each session in the row
                sessions.forEach((session, index) => {
                    // Calculate time difference for vertical offset
                    const timeDelta = index === 0 ? 0 : previousTime - session.startTime;
                    previousTime = session.startTime;
                    
                    // Calculate vertical offset based on time difference
                    // Use logarithmic scale to prevent extreme offsets
                    // 1 minute = small offset, 1 hour = medium offset, > 3 hours = larger offset
                    const timeOffsetMinutes = timeDelta / (1000 * 60); // Convert to minutes
                    let verticalOffsetPx = 0;
                    
                    if (timeOffsetMinutes > 0) {
                        if (timeOffsetMinutes < 10) {
                            // Less than 10 minutes - minimal offset
                            verticalOffsetPx = 5;
                        } else if (timeOffsetMinutes < 30) {
                            // 10-30 minutes - small offset
                            verticalOffsetPx = 15;
                        } else if (timeOffsetMinutes < 60) {
                            // 30-60 minutes - medium offset
                            verticalOffsetPx = 25;
                        } else if (timeOffsetMinutes < 180) {
                            // 1-3 hours - larger offset
                            verticalOffsetPx = 35;
                        } else {
                            // > 3 hours - maximum offset
                            verticalOffsetPx = 45;
                        }
                    }
                    
                    const sessionElement = document.createElement('div');
                    sessionElement.className = 'session-item';
                    sessionElement.setAttribute('data-session-id', session.id);
                    
                    // Add active indicator class if this session contains active tabs
                    if (session.hasActiveTabs) {
                        sessionElement.classList.add('has-active-tabs');
                    }
                    
                    // Apply vertical offset through margin-top
                    if (verticalOffsetPx > 0) {
                        sessionElement.style.marginTop = `${verticalOffsetPx}px`;
                    }

                    const sessionHeader = document.createElement('h3');
                    sessionHeader.className = 'session-name';
                    sessionHeader.textContent = session.name || `Session from ${new Date(session.startTime).toLocaleString()}`;
                    sessionElement.appendChild(sessionHeader);

                    // Create a container for collapsible content
                    const collapsibleContent = document.createElement('div');
                    collapsibleContent.className = 'session-collapsible-content';
                    // Will be initially hidden by CSS

                    // Add click listener to the header to toggle details with improved animation handling
                    sessionHeader.addEventListener('click', () => {
                        const isExpanded = sessionElement.classList.contains('expanded');
                        sessionElement.classList.toggle('expanded', !isExpanded);
                        
                        // Load content on first expansion
                        if (!isExpanded && collapsibleContent.childElementCount === 0) {
                            // Check if pages exist and are not empty
                            if (session.pages && session.pages.length > 0) {
                                const pageListElement = renderSessionPageList(session.pages, session);
                                collapsibleContent.appendChild(pageListElement);
                            } else {
                                const noPagesMessage = document.createElement('p');
                                noPagesMessage.textContent = 'No page details available for this session.';
                                noPagesMessage.className = 'no-pages-message';
                                collapsibleContent.appendChild(noPagesMessage);
                            }
                        }
                    });

                    const extentElement = document.createElement('p');
                    extentElement.className = 'session-extent';
                    const durationFormatted = formatDuration(session.duration);
                    extentElement.textContent = `${session.pageCount || '0'} pages • ${durationFormatted}`;
                    sessionElement.appendChild(extentElement);

                    const detailsPreview = document.createElement('div');
                    detailsPreview.className = 'session-preview-details';

                    const topDomainsElement = createDomainListElement(session.topDomains);
                    if (topDomainsElement) {
                        detailsPreview.appendChild(topDomainsElement); // Add top domains to preview
                    }

                    // Add Clicked Link Texts to preview
                    if (session.linkTexts && session.linkTexts.length > 0) {
                        const linkTextsElement = createListElement(session.linkTexts, 'Clicked Links');
                        if (linkTextsElement) {
                            detailsPreview.appendChild(linkTextsElement);
                        }
                    }
                    
                    // Add Search Queries to preview with enhanced styling
                    if (session.searchQueries && session.searchQueries.length > 0) {
                        const searchQueriesContainer = document.createElement('div');
                        searchQueriesContainer.className = 'session-detail-list';
                        
                        const searchQueriesTitle = document.createElement('strong');
                        searchQueriesTitle.textContent = 'Search Queries: ';
                        searchQueriesContainer.appendChild(searchQueriesTitle);
                        
                        const searchQueriesWrapper = document.createElement('div');
                        searchQueriesWrapper.className = 'search-queries-wrapper';
                        searchQueriesWrapper.style.display = 'flex';
                        searchQueriesWrapper.style.flexWrap = 'wrap';
                        searchQueriesWrapper.style.gap = '5px';
                        searchQueriesWrapper.style.marginTop = '5px';
                        
                        session.searchQueries.forEach(query => {
                            const queryItem = document.createElement('span');
                            queryItem.className = 'search-query-item';
                            
                            const queryIcon = document.createElement('span');
                            queryIcon.className = 'search-query-icon';
                            queryItem.appendChild(queryIcon);
                            
                            queryItem.appendChild(document.createTextNode(query));
                            searchQueriesWrapper.appendChild(queryItem);
                        });
                        
                        searchQueriesContainer.appendChild(searchQueriesWrapper);
                        detailsPreview.appendChild(searchQueriesContainer);
                    }

                    sessionElement.appendChild(detailsPreview);

                    // Append the collapsible content container to the session element
                    sessionElement.appendChild(collapsibleContent);

                    // Add the completed session element to the row
                    sessionsRow.appendChild(sessionElement);
                });
            }
        });
    });
    
    console.log('Sessions rendered with date milestones, time periods, and vertical offsets.');
    
    // Re-expand previously expanded sessions after refresh
    if (isRefresh && expandedSessionIds.length > 0) {
        expandedSessionIds.forEach(sessionId => {
            const sessionEl = container.querySelector(`.session-item[data-session-id="${sessionId}"]`);
            if (sessionEl) {
                sessionEl.classList.add('expanded');
                // Trigger content loading by simulating a click on the header
                const header = sessionEl.querySelector('.session-name');
                if (header) {
                    header.click();
                }
            }
        });
    }
}

// Using the createRefreshIndicator function defined earlier in the file

/**
 * Setup auto-refresh for sessions data
 */
function setupSessionsAutoRefresh() {
    const REFRESH_INTERVAL = 60000; // 60 seconds
    const refreshIndicator = createRefreshIndicator();
    
    setInterval(async () => {
        console.log('Auto-refreshing sessions data...');
        refreshIndicator.show();
        
        try {
            // Fetch fresh active tab information
            const activeTabUrls = await getActiveTabUrls();
            
            // Refresh data and render with isRefresh flag
            await refreshSessionsData(activeTabUrls);
            
            console.log('Sessions auto-refresh complete');
        } catch (error) {
            console.error('Error during sessions auto-refresh:', error);
        } finally {
            refreshIndicator.hide();
        }
    }, REFRESH_INTERVAL);
    
    // Also add a manual refresh button
    const addRefreshButton = () => {
        const existingButton = document.getElementById('manual-refresh-button');
        if (existingButton) return;
        
        const container = document.querySelector('.page-header');
        if (!container) return;
        
        const refreshButton = document.createElement('button');
        refreshButton.id = 'manual-refresh-button';
        refreshButton.className = 'refresh-button';
        refreshButton.innerHTML = '<span>↻</span> Refresh';
        refreshButton.title = 'Refresh sessions data';
        refreshButton.addEventListener('click', async () => {
            refreshButton.disabled = true;
            refreshIndicator.show();
            
            try {
                // Fetch fresh active tab information
                const activeTabUrls = await getActiveTabUrls();
                
                // Refresh data and render with isRefresh flag
                await refreshSessionsData(activeTabUrls);
                
                console.log('Manual sessions refresh complete');
            } catch (error) {
                console.error('Error during manual sessions refresh:', error);
            } finally {
                refreshButton.disabled = false;
                refreshIndicator.hide();
            }
        });
        
        container.appendChild(refreshButton);
    };
    
    // Add refresh button when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addRefreshButton);
    } else {
        addRefreshButton();
    }
}

/**
 * Refresh sessions data and update UI
 * @param {Array} activeTabUrls - Array of URLs of active tabs
 * @returns {Promise<void>}
 */
async function refreshSessionsData(activeTabUrls) {
    try {
        // Get fresh data
        const { sessions } = await processSessionsData(activeTabUrls, true);
        sessionsData = sessions; // Update global sessions data
        allSessionsData = sessions; // Update all sessions data as well
        
        // Render the refreshed sessions
        renderSessions(sessions, true);
        
        console.log('Sessions data refreshed successfully');
    } catch (error) {
        console.error('Error refreshing sessions data:', error);
    }
}

// Initialize auto-refresh when sessions view is loaded
setupSessionsAutoRefresh();
