import { 
  initializeTimeline, 
  initializeGraph, 
  updateTimeline, 
  updateGraph, 
  setupBrushing, 
  setupZooming, 
  drawSwimlanes,
  sharedTimeScale // Add this import
} from './d3-visualizations.js';
import { getFaviconUrl, formatUrl, abbreviateTitle, debounce } from './utility.js';
import { updateStats } from './stats.js';
import { drawTreemap } from './treemap.js';


const HISTORY_RESULTS_LIMIT = 20;
const MICROS_SESSION_TIMEOUT = 2 * 60 * 1000; // 2 minutes in milliseconds
const UPDATE_INTERVAL = 120000; // 2 minutes in milliseconds
let updateTimer = null;
let lastUpdate = Date.now();
let currentData = null;
let tabEdges = new Map(); // Track edges between tabs

// Add new tracking constants
const TAB_ACTIVITY = {
  ACTIVE_THRESHOLD: 1000, // minimum ms to count as active time
  IDLE_THRESHOLD: 300000  // 5 minutes without interaction = idle
};

// Add tab activity tracking
let tabActivityLog = new Map(); // Track tab activity periods
let navigationEvents = new Map();

async function initializeApp() {
  try {
    const [history, windows] = await Promise.all([
        chrome.history.search({ text: '', maxResults: 10000, startTime: 0 }),
        chrome.windows.getAll({ populate: true })
    ]);

    const categorizedData = categorizeData(history, windows);
    console.log('Categorized Data:', categorizedData);

    // Ensure we have valid data before initializing visualizations
    if (categorizedData && categorizedData.activeWindows) {
        drawTreemap(categorizedData);
    } else {
        console.error('Invalid categorized data structure:', categorizedData);
    }

  } catch (error) {
    console.error('Initialization error:', error);
  }
}

// Call initializeApp when the DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  initializeApp();
}

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
    updateTimelineWithNavigation(tab);
  }
});

async function updateTimelineWithNavigation(tab) {
  try {
    if (!currentData) {
      // If no current data, reinitialize
      await initializeApp();
      return;
    }

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

    // Update the visualizations
    //updateTimeline(currentData);
    //updateGraph(currentData);
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
  updateTimeline(categorizedData);
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  // Remove window from current data if it exists
  if (currentData && currentData.windowSwimlanes) {
    delete currentData.windowSwimlanes[windowId];
    currentData.activeWindowsAndTabs = currentData.activeWindowsAndTabs.filter(w => w.id !== windowId);
    updateTimeline(currentData);
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

// Update the setupMenu function
async function setupMenu() {
  const menuButton = document.getElementById('menuButton');
  const menuDropdown = document.getElementById('menuDropdown');
  const menuItems = document.querySelectorAll('.menu-item');

  menuButton?.addEventListener('click', (e) => {
    e.stopPropagation();
    menuDropdown?.classList.toggle('show');
  });

  document.addEventListener('click', (e) => {
    if (!menuDropdown?.contains(e.target) && !menuButton?.contains(e.target)) {
      menuDropdown?.classList.remove('show');
    }
  });

  menuItems.forEach(item => {
    item.addEventListener('click', async () => {
      // Update active state
      menuItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      const type = item.dataset.type;
      const value = parseInt(item.dataset.value);

      try {
        // Fetch new history data based on selection
        const historyData = await fetchHistoryRange(type, value);
        
        // Get current windows and tabs
        const activeWindowsAndTabs = await fetchActiveWindowsAndTabs();
        
        // Update visualizations
        currentData = await categorizeHistoryData({
          history: historyData,
          activeWindowsAndTabs
        });
        
        updateTimeline(currentData);
        updateGraph(currentData);

      } catch (error) {
        console.error('Error updating history:', error);
      }

      // Dismiss menu
      menuDropdown?.classList.remove('show');
    });
  });
}

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

async function updateHistoryTimeRange(startTime) {
  const historyData = await fetchHistoryData(null, startTime);
  const activeWindowsAndTabs = await fetchActiveWindowsAndTabs();
  updateVisualization({ history: historyData, activeWindowsAndTabs });
}

async function updateHistoryCount(count) {
  const historyData = await fetchHistoryData(count);
  const activeWindowsAndTabs = await fetchActiveWindowsAndTabs();
  updateVisualization({ history: historyData, activeWindowsAndTabs });
}

// Add to initialization section
document.addEventListener('DOMContentLoaded', () => {
  setupMenu();
  // ...existing initialization code...
});

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
  const sourceTab = findTabById(windowSwimlanes, edge.source);
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
  for (const tabs of Object.values(windowSwimlanes)) {
    const tab = tabs.find(t => t.id === tabId);
    if (tab) {
      return tab;
    }
  }
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

  // Update visualizations if needed
  if (currentData) {
    debouncedTimelineUpdate(true);
  }
});

// Add cleanup for stored data when tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.local.remove(`tab_${tabId}`);
  tabActivityLog.delete(tabId);
});

function inspectNavigationData() {
  console.group('Navigation Data Inspection');
  console.log('Current Navigation Events:', Array.from(navigationEvents.entries()));
  console.log('Edge Data:', currentData?.edges);
  console.groupEnd();
}

// Add to window for easy console access
window.inspectNavigationData = inspectNavigationData;

// Add near other utility functions
function updateTimelineIfNeeded(force = false) {
  const now = Date.now();
  
  // Don't update if not forced and last update was recent
  if (!force && now - lastUpdate < UPDATE_INTERVAL) {
    return;
  }

  // Update last update time
  lastUpdate = now;

  // Fetch latest data and update visualizations
  fetchActiveWindowsAndTabs().then(activeWindowsAndTabs => {
    if (currentData) {
      currentData = categorizeHistoryData({
        history: currentData.historySwimlane,
        activeWindowsAndTabs
      });
      
      // Update both visualizations
      updateTimeline(currentData);
      updateGraph(currentData);
      updateStats(sharedTimeScale);
    }
  });
}

// Create a debounced version for rapid updates
const debouncedTimelineUpdate = debounce(updateTimelineIfNeeded, 250);

// Add this function with the other utility functions
function shouldCreateNavigationEdge(current, previous) {
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

const LAYOUT = {
    ROW_HEIGHT: 30,
    AXIS_HEIGHT: 30,
    HISTORY_ROWS: 2,
    AXIS_MARGIN: 10
};

document.addEventListener('DOMContentLoaded', function () {
    const width = document.getElementById('sidebar').offsetWidth;
    const height = window.innerHeight;

    const svg = d3.select('#treemap')
        .append('svg')
        .attr('width', width)
        .attr('height', height);

    const treemap = d3.treemap()
        .size([width, height])
        .padding(1);

    function drawTreemap(data) {
        const root = d3.hierarchy(data)
            .sum(d => d.totalTimeSpent)
            .sort((a, b) => b.value - a.value);

        treemap(root);

        const nodes = svg.selectAll('g')
            .data(root.leaves())
            .enter()
            .append('g')
            .attr('transform', d => `translate(${d.x0},${d.y0})`)
            .style('cursor', 'pointer')
            .on('dblclick', (event, d) => {
                // Focus the tab
                chrome.windows.update(d.data.windowId, { focused: true }, () => {
                    chrome.tabs.update(d.data.id.replace('tab', ''), { active: true });
                });
            });

        // Make the rect and text both clickable
        nodes.append('rect')
            .attr('id', d => d.data.id)
            .attr('width', d => d.x1 - d.x0)
            .attr('height', d => d.y1 - d.y0)
            .attr('fill', d => d.parent.data.focused ? '#4a9eff' : '#69b3a2')
            .attr('opacity', 0.7);

        nodes.append('image')
            .attr('xlink:href', d => d.data.favIconUrl)
            .attr('x', 3)
            .attr('y', 3)
            .attr('width', 16)
            .attr('height', 16);

        nodes.append('text')
            .attr('x', 22)
            .attr('y', 15)
            .text(d => d.data.title)
            .attr('font-size', '10px')
            .attr('fill', 'white')
            .attr('text-anchor', 'start')
            .attr('dominant-baseline', 'hanging');
    }

    // Example usage with windowData
    if (window.windowData) {
        drawTreemap(window.windowData);
    }
});

export function categorizeData(history, windows) {
    // Sort windows to put focused window first
    const sortedWindows = [...windows].sort((a, b) => {
        if (a.focused === b.focused) return 0;
        return a.focused ? -1 : 1;
    });

    const activeWindows = sortedWindows.map(window => ({
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

    const windowSwimlanes = {};
    activeWindows.forEach(window => {
        windowSwimlanes[window.id] = window.tabs;
    });

    const historySwimlane = history.map(entry => ({
        id: entry.id,
        url: entry.url,
        title: entry.title,
        lastVisitTime: entry.lastVisitTime,
        visitCount: entry.visitCount
    }));

    const tabsCount = activeWindows.map(window => window.tabs.length);

    return {
        activeWindows,
        windowSwimlanes,
        historySwimlane,
        tabsCount
    };
}

