import { getFaviconUrl, formatUrl, abbreviateTitle, debounce } from './utility.js';
import { updateStats } from './stats.js';
import { showDefaultReadout } from './readout.js';
import { initializeApp } from './init.js';
import { tabSearch } from './search.js';
import { drawTreemap } from './treemap.js';

const HISTORY_RESULTS_LIMIT = 20;
const MICROS_SESSION_TIMEOUT = 2 * 60 * 1000; // 2 minutes in milliseconds
const UPDATE_INTERVAL = 120000; // 2 minutes in milliseconds
let updateTimer = null;
let lastUpdate = Date.now();
let tabEdges = new Map(); // Track edges between tabs

// Add new tracking constants
const TAB_ACTIVITY = {
  ACTIVE_THRESHOLD: 1000, // minimum ms to count as active time
  IDLE_THRESHOLD: 300000  // 5 minutes without interaction = idle
};

// Add tab activity tracking
let tabActivityLog = new Map(); // Track tab activity periods
let navigationEvents = new Map();

let inactivityTimer = null;
const INACTIVITY_TIMEOUT = 5000; // 5 seconds

let categorizedDataCache = null;
let currentData = null;

function resetInactivityTimer(categorizedData) {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
        showDefaultReadout(categorizedData);
    }, INACTIVITY_TIMEOUT);
}

// Add mousemove listener to the document
document.addEventListener('mousemove', () => {
    if (categorizedDataCache && !document.querySelector('.cell-selected')) {
        resetInactivityTimer(categorizedDataCache);
    }
});

function categorizeData(history, windows) {
    console.log('Categorizing data...'); // Debug

    const activeWindows = windows.map(window => ({
        id: window.id,
        focused: window.focused,
        tabs: window.tabs.map(tab => ({
            id: tab.id,
            windowId: tab.windowId,
            url: tab.url,
            title: tab.title,
            active: tab.active,
            favIconUrl: tab.favIconUrl,
            lastAccessed: tab.lastAccessed
        }))
    }));

    console.log('Active windows:', activeWindows); // Debug

    const windowSwimlanes = {};
    activeWindows.forEach(window => {
        windowSwimlanes[window.id] = window.tabs;
    });

    console.log('Window swimlanes:', windowSwimlanes); // Debug

    const historySwimlane = history.map(entry => ({
        id: entry.id,
        url: entry.url,
        title: entry.title,
        lastVisitTime: entry.lastVisitTime,
        visitCount: entry.visitCount
    }));

    console.log('History swimlane:', historySwimlane); // Debug

    const tabsCount = activeWindows.map(window => window.tabs.length);

    console.log('Tabs count:', tabsCount); // Debug

    const categorizedData = {
        activeWindows,
        windowSwimlanes,
        historySwimlane,
        tabsCount
    };

    console.log('Categorized data:', categorizedData); // Debug

    return categorizedData;
}

function handleTabSearch(event) {
    const searchTerm = event.target.value.trim();
    
    console.log('Search input:', searchTerm);

    // Reset all cells if search is empty
    if (!searchTerm) {
        d3.selectAll('.cell')
            .style('opacity', 1)
            .classed('cell-search-match', false)
            .classed('cell-search-nomatch', false);
        return;
    }

    const results = tabSearch.search(searchTerm);
    console.log('Search results:', {
        term: searchTerm,
        count: results.length,
        firstResult: results[0]
    });

    // Update visualization based on search results
    d3.selectAll('.cell')
        .each(function(d) {
            if (!d || !d.data) return;
            
            const isMatch = results.some(r => r.id === d.data.id);
            
            d3.select(this)
                .classed('cell-search-match', isMatch)
                .classed('cell-search-nomatch', !isMatch)
                .style('opacity', isMatch ? 1 : 0.3)
                .style('transition', 'opacity 0.2s ease-in-out');
        });

    // Change tab order to jump between matching cells
    if (results.length > 0) {
        const firstMatch = results[0];
        const matchingCell = d3.selectAll('.cell-search-match').node();
        if (matchingCell) {
            matchingCell.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
}

function exitSearchMode() {
    const searchInput = document.getElementById('tabSearch');
    searchInput.value = '';
    handleTabSearch({ target: { value: '' } }); // Clear search results
    clearSearchStyles(); // Clear search styles from treemap
}

export function clearSearchStyles() {
    d3.selectAll('.cell')
        .style('opacity', 1)
        .classed('cell-search-match', false)
        .classed('cell-search-nomatch', false)
        .classed('cell-selected', false)
        .style('transition', 'opacity 0.2s ease-in-out');
}

document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('tabSearch');
    let searchResults = [];
    let currentIndex = -1;

    searchInput.addEventListener('input', debounce((event) => {
        handleTabSearch(event);
        searchResults = tabSearch.search(event.target.value.trim());
        currentIndex = -1;
    }, 200));

    searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            exitSearchMode();
            searchResults = [];
            currentIndex = -1;
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (searchResults.length > 0) {
                if (event.key === 'ArrowDown') {
                    currentIndex = (currentIndex + 1) % searchResults.length;
                } else if (event.key === 'ArrowUp') {
                    currentIndex = (currentIndex - 1 + searchResults.length) % searchResults.length;
                }
                const matchingCell = d3.selectAll('.cell-search-match').nodes()[currentIndex];
                if (matchingCell) {
                    matchingCell.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    d3.selectAll('.cell-search-match').classed('cell-selected', false);
                    d3.select(matchingCell).classed('cell-selected', true);
                }
            }
        }
    });
});

document.addEventListener('DOMContentLoaded', async () => {
    try {
        // Initialize data first
        const [history, windows] = await Promise.all([
            chrome.history.search({ text: '', maxResults: 10000, startTime: 0 }),
            chrome.windows.getAll({ populate: true })
        ]);

        // Create initial categorized data
        categorizedDataCache = categorizeData(history, windows);
        currentData = categorizedDataCache;

        // Initialize search index
        tabSearch.buildIndex(categorizedDataCache);

        // Set up search handler
        const searchInput = document.getElementById('tabSearch');
        if (searchInput) {
            searchInput.addEventListener('input', debounce(handleTabSearch, 200));
            searchInput.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    exitSearchMode();
                }
            });
        }

        // Initialize visualizations
        if (categorizedDataCache?.activeWindows) {
            await drawTreemap(categorizedDataCache);
            showDefaultReadout(categorizedDataCache);
            
            // Start inactivity timer only if we have data
            if (!document.querySelector('.cell-selected')) {
                resetInactivityTimer(categorizedDataCache);
            }
        } else {
            console.error('Invalid data structure:', categorizedDataCache);
        }
    } catch (error) {
        console.error('Error initializing page:', error);
    }
});

async function fetchHistoryData(limit, startTime) {
  return new Promise((resolve) => {
    chrome.history.search(
      { 
        text: '', 
        maxResults: limit,
        startTime: startTime || Date.now() - (24 * 60 * 60 * 1000) // Last 24 hours
      }, 
      (historyItems) => {
        // Get visits for each history item to get more details
        Promise.all(historyItems.map(item => 
          new Promise(resolveVisits => {
            chrome.history.getVisits({ url: item.url }, visits => {
              // Get the most recent visit
              const latestVisit = visits[visits.length - 1];
              resolveVisits({
                ...item,
                visits: visits,
                tabId: latestVisit?.tabId,
                windowId: latestVisit?.windowId,
                transitionType: latestVisit?.transition, // Add transition type
                transitionQualifiers: latestVisit?.transitionQualifiers, // Add qualifiers
                referrer: latestVisit?.referringVisit ? 
                  visits.find(v => v.visitId === latestVisit.referringVisit)?.url : 
                  null
              });
            })
          })
        )).then(detailedHistoryItems => {
          console.log('Detailed history items with transitions:', detailedHistoryItems);
          resolve(detailedHistoryItems);
        });
      }
    );
  });
}

// Modify fetchActiveWindowsAndTabs to include time tracking
async function fetchActiveWindowsAndTabs() {
  return new Promise((resolve) => {
    chrome.windows.getAll({ populate: true }, async (windows) => {
      const activeWindows = await Promise.all(windows.map(async window => ({
        id: window.id,
        focused: window.focused,
        tabs: await Promise.all(window.tabs.map(async tab => {
          // Get stored activity data
          const storedActivity = await chrome.storage.local.get(`tab_${tab.id}`);
          const activity = storedActivity[`tab_${tab.id}`] || {
            totalTimeSpent: 0,
            lastTouch: tab.active ? Date.now() : null,
            firstSeen: Date.now()
          };
          
          // Update if tab is active
          if (tab.active) {
            const now = Date.now();
            if (activity.lastTouch) {
              activity.totalTimeSpent += (now - activity.lastTouch);
            }
            activity.lastTouch = now;
            // Store updated activity
            await chrome.storage.local.set({
              [`tab_${tab.id}`]: activity
            });
          }
          
          return {
            id: tab.id,
            windowId: window.id,
            url: tab.url,
            title: tab.title,
            active: tab.active,
            favIconUrl: tab.favIconUrl,
            lastAccessed: tab.lastAccessed,
            totalTimeSpent: activity.totalTimeSpent,
            lastTouch: activity.lastTouch,
            firstSeen: activity.firstSeen
          };
        }))
      })));
      
      console.log('Active windows and tabs with time spent:', activeWindows);
      resolve(activeWindows);
    });
  });
}

function categorizeHistoryData(data) {
  const { history = [], activeWindowsAndTabs = [] } = data;
  const activeTabs = new Map();
  const historySwimlane = [];
  const windowSwimlanes = {};
  const edges = []; // Initialize edges array

  // First, initialize windowSwimlanes with active tabs
  activeWindowsAndTabs.forEach(window => {
    // Initialize array for this window's tabs
    windowSwimlanes[window.id] = [];
    
    // Add current tabs to the window's swimlane
    window.tabs.forEach(tab => {
      const activity = tabActivityLog.get(tab.id) || {
        totalTimeSpent: 0,
        lastTouch: tab.active ? Date.now() : null,
        firstSeen: Date.now()
      };
      
      windowSwimlanes[window.id].push({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        favIconUrl: tab.favIconUrl,
        lastAccessed: tab.lastAccessed,
        windowId: window.id,
        isCurrentTab: true,
        totalTimeSpent: activity.totalTimeSpent,
        lastTouch: activity.lastTouch,
        firstSeen: activity.firstSeen
      });
      
      // Store reference for history matching
      activeTabs.set(tab.id, { windowId: window.id, tab });
    });
  });

  // Then categorize history items
  history.forEach(item => {
    const activeTab = activeTabs.get(item.id);
    
    if (item.windowId && windowSwimlanes[item.windowId]) {
      // If we know the window ID and it exists, add to that window
      windowSwimlanes[item.windowId].push({
        ...item,
        isHistoryItem: true
      });
    } else if (activeTab) {
      // If we found a matching active tab, add to its window
      windowSwimlanes[activeTab.windowId].push({
        ...item,
        windowId: activeTab.windowId,
        isHistoryItem: true
      });
    } else {
      // Otherwise, add to history swimlane
      historySwimlane.push(item);
    }
  });

  // Debug output
  console.log('Categorized Data:', {
    activeWindows: activeWindowsAndTabs,
    windowSwimlanes,
    historySwimlane,
    tabsCount: Object.entries(windowSwimlanes).map(([id, tabs]) => ({
      windowId: id,
      activeTabsCount: tabs.filter(t => t.isCurrentTab).length,
      historyItemsCount: tabs.filter(t => t.isHistoryItem).length
    }))
  });

  return {
    historySwimlane,
    windowSwimlanes,
    activeWindowsAndTabs,
    edges, // Add edges to returned data structure
    totalEdges: 0,
    nodesWithEdges: new Set()
  };
}

function createMicrosessions(history) {
  const microsessions = [];
  let currentSession = [];
  let lastVisitTime = null;

  history.forEach(item => {
    if (lastVisitTime && (item.lastVisitTime - lastVisitTime > MICROS_SESSION_TIMEOUT)) {
      microsessions.push(currentSession);
      currentSession = [];
    }
    currentSession.push(item);
    lastVisitTime = item.lastVisitTime;
  });

  if (currentSession.length > 0) {
    microsessions.push(currentSession);
  }

  return microsessions;
}

function displayStats(data, sessionCount) {
  const { historySwimlane, windowSwimlanes, totalEdges, nodesWithEdges } = data;
  const totalHistoryItems = historySwimlane.length + Object.values(windowSwimlanes).reduce((acc, items) => acc + items.length, 0);
  const totalActiveTabs = Object.values(windowSwimlanes).reduce((acc, items) => acc + items.length, 0);
  const averageEdgesConnected = (nodesWithEdges / totalHistoryItems) * 100;

  document.getElementById('total-history-items').textContent = `Total History Items: ${totalHistoryItems}`;
  document.getElementById('total-active-tabs').textContent = `Total Active Tabs: ${totalActiveTabs}`;
  document.getElementById('total-edges').textContent = `Total Edges: ${totalEdges}`;
  document.getElementById('average-edges-connected').textContent = `Average % of Nodes with Edges: ${averageEdgesConnected.toFixed(2)}%`;
  document.getElementById('total-sessions').textContent = `Total Sessions: ${sessionCount}`;
}

function updateReadoutText(text) {
  const readout = document.getElementById('readout');
  if (readout) {
    readout.textContent = text;
  }
}

// Add navigation event listeners
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    console.log("Tab updated:", tab); // Debug
    updateTimelineWithNavigation(tab);

    const window = state.activeWindows.find(w => w.id === tab.windowId);
    if (window) {
        const tabIndex = window.tabs.findIndex(t => t.id === tabId);
        if (tabIndex !== -1) {
            window.tabs[tabIndex] = {
                ...window.tabs[tabIndex],
                ...tab,
                lastAccessed: Date.now()
            };
        } else {
            // Add the tab if it doesn't exist
            window.tabs.push({
                id: tabId,
                windowId: tab.windowId,
                url: tab.url,
                title: tab.title,
                active: tab.active,
                favIconUrl: tab.favIconUrl,
                lastAccessed: Date.now()
            });
        }
        refreshTreemapState({ activeWindows: state.activeWindows });
    } else {
        // Add the window if it doesn't exist
        state.activeWindows.push({
            id: tab.windowId,
            focused: false,
            tabs: [{
                id: tabId,
                windowId: tab.windowId,
                url: tab.url,
                title: tab.title,
                active: tab.active,
                favIconUrl: tab.favIconUrl,
                lastAccessed: Date.now()
            }]
        });
        refreshTreemapState({ activeWindows: state.activeWindows });
    }
  }
});

async function updateTimelineWithNavigation(tab) {
    try {
        if (!currentData) {
            // If no current data, reinitialize
            await initializeApp();
            return;
        }
        console.log("Updating timeline with navigation:", tab); // Debug

        const newNavigation = {
            url: tab.url,
            title: tab.title,
            lastVisitTime: Date.now(),
            windowId: tab.windowId,
            tabId: tab.id,
            favIconUrl: tab.favIconUrl,
            isCurrentTab: true
        };

        // Add to appropriate window swimlane
        if (!currentData.windowSwimlanes[tab.windowId]) {
            currentData.windowSwimlanes[tab.windowId] = [];
        }
        currentData.windowSwimlanes[tab.windowId].push(newNavigation);
        console.log('Updated window swimlanes:', currentData.windowSwimlanes); // Debug

        // Update the visualizations
        updateTreemap();
    } catch (error) {
        console.error('Error updating timeline with navigation:', error);
    }
}

// Add window event listeners
chrome.windows.onCreated.addListener(async (window) => {
  // Refresh data and update timeline
  const historyData = await fetchHistoryData(HISTORY_RESULTS_LIMIT);
  const activeWindowsAndTabs = await fetchActiveWindowsAndTabs();
  
  const combinedData = {
    history: historyData,
    activeWindowsAndTabs: activeWindowsAndTabs
  };
  
  const categorizedData = categorizeHistoryData(combinedData);
  //updateTimeline(categorizedData);
  console.log('Window created:', window); // Debug
  console.log('Active windows and tabs:', activeWindowsAndTabs); // Debug
});

chrome.windows.onRemoved.addListener(async (windowId) => {
    try {
        if (!currentData) {
            console.warn('No current data available for window removal');
            return;
        }

        // Create new data structure without the removed window
        const updatedData = {
            ...currentData,
            activeWindowsAndTabs: (currentData.activeWindowsAndTabs || [])
                .filter(w => w.id !== windowId),
            windowSwimlanes: { ...currentData.windowSwimlanes }
        };
        
        // Remove the window from swimlanes
        delete updatedData.windowSwimlanes[windowId];

        // Ensure we still have valid tree data structure
        const treeData = {
            name: 'Browser Windows',
            children: updatedData.activeWindowsAndTabs.map(window => ({
                name: `Window ${window.id}`,
                id: window.id,
                focused: window.focused,
                children: window.tabs.map(tab => ({
                    name: tab.title || 'Untitled',
                    id: tab.id,
                    url: tab.url || '',
                    title: tab.title || 'Untitled',
                    active: tab.active || false,
                    favIconUrl: tab.favIconUrl,
                    lastAccessed: tab.lastAccessed || Date.now(),
                    windowId: window.id,
                    totalTimeSpent: tab.totalTimeSpent || 1
                }))
            }))
        };

        // Update current data
        currentData = updatedData;

        // Redraw treemap with new structure
        if (treeData.children && treeData.children.length > 0) {
            await drawTreemap(treeData);
        } else {
            // Handle empty state
            document.getElementById('treemap').innerHTML = 
                '<div class="empty-state">No windows open</div>';
        }

        console.log('Window removed, updated data:', currentData);
    } catch (error) {
        console.error('Error handling window removal:', error);
    }
});

// Replace direct tab activity tracking with message-based sync
async function syncTabActivity() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_TAB_ACTIVITY' });
    if (response) {
      tabActivityLog = new Map(response.tabActivityLog);
      navigationEvents = new Map(response.navigationEvents);
      
      // Update visualizations with new data
      if (currentData) {
        const activeWindowsAndTabs = await fetchActiveWindowsAndTabs();
        currentData = categorizeHistoryData({
          history: currentData.historySwimlane,
          activeWindowsAndTabs
        });
        updateTimeline(currentData);
        updateGraph(currentData);
      }
    }
  } catch (error) {
    console.error('Error syncing tab activity:', error);
  }
}

// Update setupTimelineUpdates to include tab activity sync
function setupTimelineUpdates() {
  // Clear any existing timer
  if (updateTimer) {
    clearInterval(updateTimer);
  }

  // Setup visibility change handling
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(updateTimer);
      updateTimer = null;
    } else {
      // Page is visible again, sync immediately and restart timer
      syncTabActivity();
      startUpdateTimer();
    }
  });

  // Start initial timer if page is visible
  if (!document.hidden) {
    startUpdateTimer();
  }
}

function startUpdateTimer() {
  // Sync tab activity data periodically
  updateTimer = setInterval(async () => {
    await syncTabActivity();
  }, UPDATE_INTERVAL);
}

// Add cleanup function
function cleanup() {
  window.removeEventListener('resize', debouncedResize);
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
  tabActivityLog.clear();
}

// Add event listener for page unload
window.addEventListener('unload', cleanup);

async function fetchHistoryRange(type, value) {
  const query = {
    text: '',
    maxResults: 10000 // Default max results
  };

  if (type === 'time') {
    // Calculate start time based on selected range
    const startTime = new Date(Date.now() - (value * 1000));
    query.startTime = startTime.getTime();
  } else if (type === 'count') {
    // Use specified count as maxResults
    query.maxResults = value;
  }

  return chrome.history.search(query);
}

// Capture new tab creation and update edges
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId) {
    const edge = {
      source: tab.openerTabId,
      target: tab.id,
      type: 'new-tab'
    };
    tabEdges.set(`${tab.openerTabId}-${tab.id}`, edge);
    updateGraphWithNewEdge(edge);
  }
});

// Capture tab updates to ensure edges are tracked
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.openerTabId) {
    const edge = {
      source: tab.openerTabId,
      target: tab.id,
      type: 'new-tab'
    };
    tabEdges.set(`${tab.openerTabId}-${tab.id}`, edge);
    updateGraphWithNewEdge(edge);
  }
});

// Update graph with new edge
function updateGraphWithNewEdge(edge) {
  if (!currentData) return;
  
  if (!currentData.edges) {
    currentData.edges = [];
  }
  
  const { windowSwimlanes } = currentData;
  console.log("Looking up source tab:", edge.source); // Debug
  const sourceTab = findTabById(windowSwimlanes, edge.source);
  console.log("Looking up target tab:", edge.target); // Debug
  const targetTab = findTabById(windowSwimlanes, edge.target);
  
  if (sourceTab && targetTab && shouldCreateNavigationEdge(targetTab, sourceTab)) {
    currentData.edges.push(edge);
    currentData.totalEdges++;
    currentData.nodesWithEdges.add(sourceTab.id);
    currentData.nodesWithEdges.add(targetTab.id);
    updateGraph(currentData);
  }
}

// Find tab by ID in window swimlanes
function findTabById(windowSwimlanes, tabId) {
  console.log(`findTabById called with tabId: ${tabId}`);
  for (const tabs of Object.values(windowSwimlanes)) {
      const tab = tabs.find(t => t.id === tabId);
      if (tab) {
          console.log(`---Tab found: ${JSON.stringify(tab)}`);
          return tab;
      }
  }
  console.log(`Tab with id ${tabId} not found`);
  return null;
}

// Add tab activity tracking listeners
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const now = Date.now();
  
  // Update previous tab
  const previousTab = Array.from(tabActivityLog.entries())
    .find(([_, data]) => data.lastTouch === Math.max(...Array.from(tabActivityLog.values())
      .map(d => d.lastTouch || 0)));

  if (previousTab) {
    const [prevTabId, prevData] = previousTab;
    if (prevData.lastTouch) {
      const timeSpent = now - prevData.lastTouch;
      if (timeSpent > TAB_ACTIVITY.ACTIVE_THRESHOLD) {
        prevData.totalTimeSpent += timeSpent;
        // Persist updated time
        await chrome.storage.local.set({
          [`tab_${prevTabId}`]: prevData
        });
      }
    }
  }

  // Update current tab
  const storedActivity = await chrome.storage.local.get(`tab_${tabId}`);
  const currentActivity = storedActivity[`tab_${tabId}`] || {
    totalTimeSpent: 0,
    firstSeen: now
  };
  currentActivity.lastTouch = now;
  
  // Persist current tab data
  await chrome.storage.local.set({
    [`tab_${tabId}`]: currentActivity
  });
  
  tabActivityLog.set(tabId, currentActivity);
  console.log('Tab activity log updated:', tabActivityLog);
});

// Add cleanup for stored data when tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.local.remove(`tab_${tabId}`);
  tabActivityLog.delete(tabId);
});


// Add this function with the other utility functions
function shouldCreateNavigationEdge(current, previous) {
  console.log("--- Considering edge between:", previous, current);
  try {
    // Skip chrome:// and extension URLs
    if (current.url.startsWith('chrome://') || 
        previous.url.startsWith('chrome://') ||
        current.url.startsWith('chrome-extension://') ||
        previous.url.startsWith('chrome-extension://')) {
      return false;
    }

    // Only create edges for explicit navigation types
    const navigationType = current.transitionType;
    if (!['link', 'form_submit'].includes(navigationType)) {
      return false;
    }

    // Trust referrer as primary signal
    if (current.referrer === previous.url) {
      return true;
    }

    // Fallback to explicit navigation events
    if (navigationEvents.has(`${previous.id}-${current.id}`)) {
      return true;
    }

    return false;
  } catch (e) {
    return false;
  }
}

// Replace the direct windowSwimlanes initialization
chrome.windows.getAll({ populate: true }, async (windows) => {
    if (!currentData) {
        currentData = { windowSwimlanes: {} };
    }
    
    for (const window of windows) {
        currentData.windowSwimlanes[window.id] = window.tabs;
        
        // Enrich each tab with history data
        for (const tab of currentData.windowSwimlanes[window.id]) {
            chrome.runtime.sendMessage({
                type: 'getTabHistory',
                tabId: tab.id
            }, (response) => {
                if (response?.history) {
                    tab.history = response.history;
                    tab.referringTabId = response.relationship?.referringTabId;
                    console.log(`Updated tab ${tab.id} with history:`, tab);
                }
            });
        }
    }
    console.log('Enriched windowSwimlanes with history:', currentData.windowSwimlanes);
});

// Update the tab change listener to use currentData
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!currentData?.windowSwimlanes) return;
    
    if (changeInfo.status === 'complete') {
        console.log("Looking up tab history for tabId:", tabId); // Debug
        chrome.runtime.sendMessage({
            type: 'getTabHistory',
            tabId: tabId
        }, (response) => {
            if (response?.history) {
                const windowId = tab.windowId;
                const tabs = currentData.windowSwimlanes[windowId];
                if (tabs) {
                    const tabIndex = tabs.findIndex(t => t.id === tabId);
                    if (tabIndex !== -1) {
                        tabs[tabIndex].history = response.history;
                        tabs[tabIndex].referringTabId = response.relationship?.referringTabId;
                        console.log(`Updated tab ${tabId} history in swimlane:`, tabs[tabIndex]);
                    }
                }
            }
        });
    }
});

document.addEventListener('DOMContentLoaded', function () {
    const width = 800;//document.getElementById('visualization-container').offsetWidth;
    const height = window.innerHeight;

    const svg = d3.select('#treemap')
        .append('svg')
        .attr('width', width)
        .attr('height', height);

    const treemap = d3.treemap()
        .size([width, height])
        .padding(1);

   

    // Example usage with windowData
    if (window.windowData) {
        drawTreemap(window.windowData);
    }
});

document.addEventListener('DOMContentLoaded', () => {
    initializeApp();

    const searchInput = document.getElementById('tabSearch');
    searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            searchInput.value = '';
            tabSearch.search(''); // Clear search results
            clearSearchStyles(); // Clear search styles from treemap
        }
    });
});


// 1. Add clear state management
const state = {
    activeWindows: [],
    bookmarks: [],
    minCells: 4,
    currentTabCount: 0,
    get needsBookmarks() {
        return this.currentTabCount < this.minCells;
    }
};

// 2. Single update function that handles all state changes
async function updateTreemapState(changes) {
    console.log('State update:', {
        before: {
            tabCount: state.currentTabCount,
            hasBookmarks: state.needsBookmarks,
            windows: state.activeWindows.length
        }
    });

    // Apply changes
    Object.assign(state, changes);
    state.currentTabCount = state.activeWindows.reduce(
        (sum, w) => sum + w.tabs.length, 
        0
    );

    // Manage bookmarks based on tab count
    if (state.needsBookmarks) {
        const bookmarksNeeded = state.minCells - state.currentTabCount;
        state.bookmarks = await fetchRecentBookmarks(bookmarksNeeded);
    } else {
        state.bookmarks = [];
    }

    console.log('State update:', {
        after: {
            tabCount: state.currentTabCount,
            hasBookmarks: state.needsBookmarks,
            bookmarks: state.bookmarks.length
        }
    });

    // Single point of truth for treemap data
    const treeData = {
        name: 'root',
        children: [
            ...state.activeWindows.map(window => ({
                name: `Window ${window.id}`,
                id: window.id,
                children: window.tabs.map(tab => ({
                    id: `tab${tab.id}`,
                    windowId: window.id,
                    title: tab.title || 'Untitled',
                    url: tab.url || '',
                    favIconUrl: tab.favIconUrl,
                    lastAccessed: Date.now(),
                    timeSpent: tab.totalTimeSpent || 100,
                    isBookmark: false,
                    children: []
                }))
            })),
            // Only add bookmark window if needed
            ...(state.needsBookmarks ? [{
                name: 'Window bookmark',
                id: 'bookmark',
                children: state.bookmarks.map(bookmark => ({
                    id: `bookmark${bookmark.id}`,
                    windowId: 'bookmark',
                    title: bookmark.title || 'Untitled',
                    url: bookmark.url || '',
                    favIconUrl: bookmark.favIconUrl,
                    lastAccessed: Date.now(),
                    timeSpent: 100,
                    isBookmark: true,
                    children: []
                }))
            }] : [])
        ]
    };

    // Update visualization
    await drawTreemap(treeData);
}

// 3. Update event handlers to use state management
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') {
        const window = state.activeWindows.find(w => w.id === tab.windowId);
        if (window) {
            const tabIndex = window.tabs.findIndex(t => t.id === tabId);
            if (tabIndex !== -1) {
                window.tabs[tabIndex] = {
                    ...window.tabs[tabIndex],
                    ...tab,
                    lastAccessed: Date.now()
                };
                refreshTreemapState({ activeWindows: state.activeWindows });
            }
        }
    }
});

// Add a central state update handler
function handleStateUpdate(stateUpdate) {
    console.log('State update received:', {
        type: stateUpdate.type,
        tabId: stateUpdate.tabId,
        url: stateUpdate.tab?.url,
        title: stateUpdate.tab?.title
    });
    
    // Update timeline
    if (stateUpdate.action === 'tabUpdated' || stateUpdate.type === 'tabUpdate') {
        updateTimelineWithNavigation(stateUpdate.tab);
    }
    
    // Force treemap redraw on URL or title changes
    if (stateUpdate.tab && (stateUpdate.changeInfo?.url || stateUpdate.changeInfo?.title)) {
        console.log('Tab content changed, updating treemap:', {
            tabId: stateUpdate.tabId,
            url: stateUpdate.tab.url,
            title: stateUpdate.tab.title
        });
        
        // Force immediate treemap update with fresh data
        updateTreemap();
    }

    // Add this new condition to handle link navigation events
    if (stateUpdate.type === 'STATE_UPDATED' && 
        stateUpdate.event && 
        stateUpdate.event.type === 'LINK_NAVIGATION') {
      
      const event = stateUpdate.event;
      console.log("Looking up node for URL:", event.url); // Debug
      const nodeId = getNodeIdForUrl(event.url);
      
      if (nodeId) {
        // Update the node with link text
        const node = getNode(nodeId);
        if (node) {
          node.linkText = event.linkText;
          node.linkTitle = event.title;
          node.clickTimestamp = event.timestamp;
          
          // Notify about updated node - use your existing notification mechanism
          console.debug(`Updated node ${nodeId} with link text: ${event.linkText}`);
          
          // If you have a redraw or update function, call it here
          // For example: updateVisualization();
          updateTreemap();
        }
      }
    }
}

// Add centralized treemap update function
async function updateTreemap() {
    try {
        if (typeof drawTreemap !== 'function') {
            console.warn('drawTreemap function not available');
            return;
        }

        console.log('Updating treemap with fresh data');
        
        // Get fresh data for all tabs in all windows
        const windows = await chrome.windows.getAll({ populate: true });
        
        // Update categorizedDataCache with new data
        categorizedDataCache = {
            ...categorizedDataCache,
            activeWindows: windows.map(window => ({
                id: window.id,
                focused: window.focused,
                tabs: window.tabs.map(tab => ({
                    id: tab.id,
                    windowId: tab.windowId,
                    url: tab.url,
                    title: tab.title,
                    active: tab.active,
                    favIconUrl: tab.favIconUrl || getFaviconUrl(tab.url),
                    lastAccessed: Date.now()
                }))
            }))
        };
        
        console.log('Updated categorizedDataCache with fresh window data:', {
            windows: categorizedDataCache.activeWindows.length,
            totalTabs: categorizedDataCache.activeWindows.reduce(
                (sum, w) => sum + w.tabs.length, 0
            )
        });
        
        // Now draw with updated data
        await drawTreemap(categorizedDataCache);
    } catch (error) {
        console.error('Error updating treemap:', error);
    }
}

// Update the message listener to properly handle responses
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Log incoming message
    console.log('Newtab received message:', {
        type: message.type,
        action: message.action
    });
    
    // Handle different message types
    if (message.action === 'tabUpdated' || message.type === 'tabUpdate') {
        try {
            handleStateUpdate(message);
            // Send immediate response
            sendResponse({ success: true });
        } catch (error) {
            console.error('Error handling state update:', error);
            sendResponse({ success: false, error: error.message });
        }
        return false; // We're not using an async response
    }
    
    // For async handlers, manage the sendResponse properly
    if (message.type === 'getTabHistory') {
        // Handle asynchronously
        chrome.storage.local.get(`history_${message.tabId}`)
            .then(result => {
                sendResponse(result);
            })
            .catch(error => {
                console.error('Error fetching tab history:', error);
                sendResponse({ error: error.message });
            });
        return true; // Keep the message channel open
    }
    
    // Default response for unhandled messages
    sendResponse({ received: true });
    return false;
});

// Update window removal handler
chrome.windows.onRemoved.addListener(async (windowId) => {
    try {
        console.log('Window removal detected:', {
            windowId,
            existingWindows: state.activeWindows.length,
            cachedWindows: categorizedDataCache?.activeWindows?.length
        });

        if (!categorizedDataCache?.activeWindows) {
            console.warn('No cache data available for window removal');
            return;
        }

        // Update state properly
        state.activeWindows = state.activeWindows.filter(w => w.id !== windowId);
        
        // Update cache
        categorizedDataCache.activeWindows = categorizedDataCache.activeWindows.filter(w => w.id !== windowId);
        
        // Remove from swimlanes too
        if (categorizedDataCache.windowSwimlanes) {
            delete categorizedDataCache.windowSwimlanes[windowId];
        }

        console.log('Window counts after removal:', {
            stateWindows: state.activeWindows.length,
            cachedWindows: categorizedDataCache.activeWindows.length,
            remainingWindows: await getWindowCount()
        });

        // Handle empty state or update visualization
        if (categorizedDataCache.activeWindows.length === 0) {
            // No windows left, show empty state
            document.getElementById('treemap').innerHTML = 
                '<div class="empty-state"><h2>No windows open</h2><p>Open a new window to see your tabs</p></div>';
            console.log('No windows remaining, showing empty state');
        } else {
            // Update visualization
            await updateTreemap();
            console.log('Treemap updated after window removal');
        }
    } catch (error) {
        console.error('Error handling window removal:', error);
    }
});

// Add window creation handler
chrome.windows.onCreated.addListener(async (window) => {
    try {
        console.log('New window created:', {
            windowId: window.id,
            currentWindows: state.activeWindows.length
        });
        
        // Wait for window to be fully initialized with tabs
        setTimeout(async () => {
            // Force refresh of all window data
            await updateTreemap();
            
            console.log('Window counts after creation:', {
                stateWindows: state.activeWindows.length,
                cachedWindows: categorizedDataCache.activeWindows.length,
                actualWindows: await getWindowCount()
            });
        }, 500);
    } catch (error) {
        console.error('Error handling window creation:', error);
    }
});

// Add helper function to get accurate window count
async function getWindowCount() {
    try {
        const windows = await chrome.windows.getAll();
        return windows.length;
    } catch (error) {
        console.error('Error getting window count:', error);
        return 0;
    }
}

// Update treemap state management to ensure window counts sync properly
async function refreshTreemapState(changes) {
    console.log('State update:', {
        before: {
            windows: state.activeWindows.length,
            tabCount: state.currentTabCount
        }
    });

    // Apply changes
    Object.assign(state, changes);
    state.currentTabCount = state.activeWindows.reduce(
        (sum, w) => sum + w.tabs.length, 
        0
    );

    // Sync with actual window count to ensure accuracy
    const actualWindowCount = await getWindowCount();
    if (actualWindowCount !== state.activeWindows.length) {
        console.warn('Window count mismatch:', {
            stateCount: state.activeWindows.length,
            actualCount: actualWindowCount
        });
        
        // Refresh all window data
        const windows = await chrome.windows.getAll({ populate: true });
        state.activeWindows = windows.map(window => ({
            id: window.id,
            focused: window.focused,
            tabs: window.tabs.map(tab => ({
                id: tab.id,
                windowId: tab.windowId,
                url: tab.url,
                title: tab.title,
                active: tab.active,
                favIconUrl: tab.favIconUrl || getFaviconUrl(tab.url),
                lastAccessed: Date.now()
            }))
        }));
        
        state.currentTabCount = state.activeWindows.reduce(
            (sum, w) => sum + w.tabs.length, 
            0
        );
    }

    console.log('State after update:', {
        windows: state.activeWindows.length,
        tabCount: state.currentTabCount
    });

    // Create treemap data structure
    const treeData = createTreemapData(state);
    
    // Update visualization
    await drawTreemap(treeData);
}

// Add tab removal listener
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    console.log(`Tab ${tabId} removed`);

    // Update state to remove the tab
    const windowId = removeInfo.windowId;
    if (currentData && currentData.windowSwimlanes && currentData.windowSwimlanes[windowId]) {
        currentData.windowSwimlanes[windowId] = currentData.windowSwimlanes[windowId].filter(tab => tab.id !== tabId);
        
        // If the window has no more tabs, remove the window
        if (currentData.windowSwimlanes[windowId].length === 0) {
            delete currentData.windowSwimlanes[windowId];
            currentData.activeWindows = currentData.activeWindows.filter(window => window.id !== windowId);
        }

        // Update the visualization
        await updateTreemap();
    }
});

document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('tabSearch');
    let searchResults = [];
    let currentIndex = -1;

    searchInput.addEventListener('input', debounce((event) => {
        handleTabSearch(event);
        searchResults = tabSearch.search(event.target.value.trim());
        currentIndex = -1;
    }, 200));

    searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            exitSearchMode();
            searchResults = [];
            currentIndex = -1;
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (searchResults.length > 0) {
                if (event.key === 'ArrowDown') {
                    currentIndex = (currentIndex + 1) % searchResults.length;
                } else if (event.key === 'ArrowUp') {
                    currentIndex = (currentIndex - 1 + searchResults.length) % searchResults.length;
                }
                const matchingCell = d3.selectAll('.cell-search-match').nodes()[currentIndex];
                if (matchingCell) {
                    matchingCell.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    d3.selectAll('.cell-search-match').classed('cell-selected', false);
                    d3.select(matchingCell).classed('cell-selected', true);
                }
            }
        }
    });
});

function createTreemapData(state) {
    return {
        name: 'root',
        children: [
            ...state.activeWindows.map(window => ({
                name: `Window ${window.id}`,
                id: window.id,
                children: window.tabs.map(tab => ({
                    id: `tab${tab.id}`,
                    windowId: window.id,
                    title: tab.title || 'Untitled',
                    url: tab.url || '',
                    favIconUrl: tab.favIconUrl,
                    lastAccessed: Date.now(),
                    timeSpent: tab.totalTimeSpent || 100,
                    isBookmark: false,
                    children: []
                }))
            })),
            // Only add bookmark window if needed
            ...(state.needsBookmarks ? [{
                name: 'Window bookmark',
                id: 'bookmark',
                children: state.bookmarks.map(bookmark => ({
                    id: `bookmark${bookmark.id}`,
                    windowId: 'bookmark',
                    title: bookmark.title || 'Untitled',
                    url: bookmark.url || '',
                    favIconUrl: bookmark.favIconUrl,
                    lastAccessed: Date.now(),
                    timeSpent: 100,
                    isBookmark: true,
                    children: []
                }))
            }] : [])
        ]
    };
}



document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('tabSearch');
    let searchResults = [];
    let currentIndex = -1;

    searchInput.addEventListener('input', debounce((event) => {
        handleTabSearch(event);
        searchResults = tabSearch.search(event.target.value.trim());
        currentIndex = -1;
    }, 200));

    searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            exitSearchMode();
            searchResults = [];
            currentIndex = -1;
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (searchResults.length > 0) {
                if (event.key === 'ArrowDown') {
                    currentIndex = (currentIndex + 1) % searchResults.length;
                } else if (event.key === 'ArrowUp') {
                    currentIndex = (currentIndex - 1 + searchResults.length) % searchResults.length;
                }
                const matchingCell = d3.selectAll('.cell-search-match').nodes()[currentIndex];
                if (matchingCell) {
                    matchingCell.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    d3.selectAll('.cell-search-match').classed('cell-selected', false);
                    d3.select(matchingCell).classed('cell-selected', true);
                }
            }
        }
    });
});

