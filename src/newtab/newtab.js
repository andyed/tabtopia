import { initializeTimeline, initializeGraph, updateTimeline, updateGraph, setupBrushing, setupZooming, drawSwimlanes } from './d3-visualizations.js';
import { getFaviconUrl } from './utility.js';
const HISTORY_RESULTS_LIMIT = 100;
const MICROS_SESSION_TIMEOUT = 2 * 60 * 1000; // 2 minutes in milliseconds

async function initializeApp() {
  try {
    // Initialize visualizations first with empty data
    initializeTimeline();
    initializeGraph();
    
    // Then fetch and update with real data
    const historyData = await fetchHistoryData(HISTORY_RESULTS_LIMIT);
    const activeWindowsAndTabs = await fetchActiveWindowsAndTabs();
    
    const combinedData = {
      history: historyData,
      activeWindowsAndTabs: activeWindowsAndTabs
    };
    
    const categorizedData = categorizeHistoryData(combinedData);
    
    // Now update with real data
    updateTimeline(categorizedData);
    updateGraph(categorizedData);
    
    setupBrushing();
    setupZooming();
    
    console.log('App initialized with data:', categorizedData);
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

async function fetchHistoryData(limit) {
  return new Promise((resolve) => {
    chrome.history.search(
      { 
        text: '', 
        maxResults: limit,
        startTime: Date.now() - (24 * 60 * 60 * 1000) // Last 24 hours
      }, 
      (historyItems) => {
        // Get visits for each history item to get more details
        Promise.all(historyItems.map(item => 
          new Promise(resolveVisits => {
            chrome.history.getVisits({ url: item.url }, visits => {
              resolveVisits({
                ...item,
                visits: visits,
                // Use the most recent visit's referringVisit if available
                tabId: visits[visits.length - 1]?.tabId,
                windowId: visits[visits.length - 1]?.windowId
              });
            });
          })
        )).then(detailedHistoryItems => {
          console.log('Detailed history items:', detailedHistoryItems);
          resolve(detailedHistoryItems);
        });
      }
    );
  });
}

async function fetchActiveWindowsAndTabs() {
  return new Promise((resolve) => {
    chrome.windows.getAll({ populate: true }, (windows) => {
      const activeWindows = windows.map(window => ({
        id: window.id,
        focused: window.focused,
        tabs: window.tabs.map(tab => ({
          id: tab.id,
          windowId: window.id,
          url: tab.url,
          title: tab.title,
          active: tab.active,
          favIconUrl: tab.favIconUrl,
          lastAccessed: tab.lastAccessed
        }))
      }));
      console.log('Active windows and tabs:', activeWindows); // Debug log
      resolve(activeWindows);
    });
  });
}

function categorizeHistoryData(data) {
  const { history = [], activeWindowsAndTabs = [] } = data;
  const activeTabs = new Map();
  const historySwimlane = [];
  const windowSwimlanes = {};

  // First, initialize windowSwimlanes with active tabs
  activeWindowsAndTabs.forEach(window => {
    // Initialize array for this window's tabs
    windowSwimlanes[window.id] = [];
    
    // Add current tabs to the window's swimlane
    window.tabs.forEach(tab => {
      windowSwimlanes[window.id].push({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        favIconUrl: tab.favIconUrl,
        lastAccessed: tab.lastAccessed,
        windowId: window.id,
        isCurrentTab: true
      });
      
      // Store reference for history matching
      activeTabs.set(tab.url, { windowId: window.id, tab });
    });
  });

  // Then categorize history items
  history.forEach(item => {
    const activeTab = activeTabs.get(item.url);
    
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
    activeWindowsAndTabs, // Add this to pass through active windows data
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

function showTooltipInfo(info) {
  document.getElementById('default-stats').style.display = 'none';
  const tooltipInfo = document.getElementById('tooltip-info');
  tooltipInfo.textContent = info;
  tooltipInfo.style.display = 'inline';
}

function hideTooltipInfo() {
  document.getElementById('tooltip-info').style.display = 'none';
  document.getElementById('default-stats').style.display = 'inline';
}


