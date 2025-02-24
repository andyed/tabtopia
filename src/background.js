// This file contains the background script for the Chrome extension. 
// It listens for browser events and manages the state of the extension, 
// including tracking browser history and active tabs.

chrome.runtime.onInstalled.addListener(() => {
  console.log("Chrome History Plugin installed.");
  console.log('Extension installed');
});

let historyEntries = [];
let activeTabs = [];
let lastClickedLink = null;
let tabActivityLog = new Map();
let navigationEvents = new Map();
let tabEdges = new Map(); // Initialize tabEdges as a Map

// Add tracking constants
const TAB_ACTIVITY = {
  ACTIVE_THRESHOLD: 1000,    // 1 second minimum to count as active time
  IDLE_THRESHOLD: 300000,    // 5 minutes without interaction = idle
  UPDATE_INTERVAL: 5000      // Update active tab time every 5 seconds
};

// Add time tracking function
function updateTabActivity(tabId, isActive) {
  const now = Date.now();
  const activity = tabActivityLog.get(tabId) || {
    totalTimeSpent: 0,
    firstSeen: now,
    lastTouch: null
  };

  if (isActive) {
    if (activity.lastTouch) {
      const timeSpent = now - activity.lastTouch;
      if (timeSpent > TAB_ACTIVITY.ACTIVE_THRESHOLD) {
        activity.totalTimeSpent += timeSpent;
      }
    }
    activity.lastTouch = now;
  }

  tabActivityLog.set(tabId, activity);
}

// Function to update history entries
function updateHistory() {
  chrome.history.search({ text: '', maxResults: 100 }, (results) => {
      historyEntries = results;
      chrome.storage.local.set({ historyEntries })
          .catch(error => {
              console.error('Error saving history entries:', error);
          });
  });
}

// Function to update active tabs
function updateActiveTabs() {
  chrome.tabs.query({ active: true }, (tabs) => {
      activeTabs = tabs;
      chrome.storage.local.set({ activeTabs })
          .catch(error => {
              console.error('Error saving active tabs:', error);
          });
  });
}

// Function to get favicon URL for a given tab
function getFaviconUrl(url) {
  return `chrome://favicon/size/16@1x/${url}`;
}

// Listen for history changes
chrome.history.onVisited.addListener((result) => {
  updateHistory();
  // Add favicon information
  const faviconUrl = getFaviconUrl(result.url);
  console.log(`New history entry: ${result.url} with favicon: ${faviconUrl}`);
  // Broadcast the new history entry to any listening tabs
  chrome.runtime.sendMessage({
      type: 'newHistoryEntry',
      data: {
          url: result.url,
          faviconUrl: faviconUrl,
          timestamp: new Date().getTime()
      }
  });
});

// Listen for tab changes
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  updateTabActivity(activeInfo.tabId, true);
  updateActiveTabs();
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    console.log('Tab activated:', tab);
  } catch (error) {
    console.error('Error getting tab info:', error);
  }
  chrome.tabs.get(activeInfo.tabId, (tab) => {
      const faviconUrl = getFaviconUrl(tab.url);
      console.log(`New active tab: ${tab.url} with favicon: ${faviconUrl}`);
      chrome.runtime.sendMessage({
          type: 'tabChanged',
          data: {
              url: tab.url,
              faviconUrl: faviconUrl,
              timestamp: new Date().getTime()
          }
      });
  });
});

// Listen for favicon requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'getFavicon') {
    // Create a proxy URL that we can use in our extension
    const proxyUrl = chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(request.url)}`);
    sendResponse({ faviconUrl: proxyUrl });
    return true; // Keep the message channel open for the async response
  }
  return true;
});

// Add this listener to handle the proxy requests
chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    const url = new URL(details.url);
    const pageUrl = url.searchParams.get('pageUrl');
    if (pageUrl) {
      return {
        redirectUrl: `chrome-extension://${chrome.runtime.id}/_favicon/${pageUrl}`
      };
    }
    return {};
  },
  { urls: ["*://*/*"] }
);

// Add to existing background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_TAB_ACTIVITY') {
    sendResponse({
      tabActivityLog: Array.from(tabActivityLog.entries()),
      navigationEvents: Array.from(navigationEvents.entries())
    });
    return true; // Keep message channel open for async response
  }
});

// Store context for potential new tab/window opens
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'store_link_context') {
    lastClickedLink = {
      ...message.data,
      sourceTabId: sender.tab.id,
      sourceWindowId: sender.tab.windowId
    };
    // Clear after 5 seconds if not used
    setTimeout(() => {
      if (lastClickedLink?.timestamp === message.data.timestamp) {
        lastClickedLink = null;
      }
    }, 5000);
  }
});

// Track new tabs from context menu
chrome.tabs.onCreated.addListener((tab) => {
  if (lastClickedLink && tab.pendingUrl === lastClickedLink.targetUrl) {
    const edge = {
      source: lastClickedLink.sourceTabId,
      target: tab.id,
      type: 'link-click',
      text: lastClickedLink.text,
      sourceUrl: lastClickedLink.sourceUrl,
      targetUrl: tab.pendingUrl,
      timestamp: lastClickedLink.timestamp,
      openContext: 'new_tab'
    };
    tabEdges.set(`${lastClickedLink.sourceTabId}-${tab.id}`, edge);
    lastClickedLink = null; // Clear after use
  }
  chrome.runtime.sendMessage({
    action: 'tabCreated',
    tab: tab
  });
});

// Track new windows from context menu
chrome.windows.onCreated.addListener(async (window) => {
  if (!lastClickedLink) return;

  // Wait for the tab to be fully loaded
  const checkTab = async (attempts = 0) => {
    if (attempts > 10) {
      console.log('Max attempts reached waiting for window tab');
      return;
    }

    const [tab] = await chrome.tabs.query({ windowId: window.id });
    
    if (!tab || (!tab.url && !tab.pendingUrl)) {
      // Wait 100ms and try again
      await new Promise(resolve => setTimeout(resolve, 100));
      return checkTab(attempts + 1);
    }

    const targetUrl = tab.pendingUrl || tab.url;
    if (targetUrl === lastClickedLink.targetUrl) {
      const edge = {
        source: lastClickedLink.sourceTabId,
        target: tab.id,
        type: 'link-click',
        text: lastClickedLink.text,
        sourceUrl: lastClickedLink.sourceUrl,
        targetUrl: targetUrl,
        timestamp: lastClickedLink.timestamp,
        openContext: 'new_window'
      };
      tabEdges.set(`${lastClickedLink.sourceTabId}-${tab.id}`, edge);
      lastClickedLink = null; // Clear after use
    }
  };

  await checkTab();
});

// Add cleanup for closed tabs
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  tabActivityLog.delete(tabId);
  // Cleanup any navigation events
  navigationEvents.delete(tabId);
  chrome.runtime.sendMessage({
    action: 'tabRemoved',
    tabId: tabId,
    removeInfo: removeInfo
  });
});

// Add tab update listener
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  try {
    if (!tabEdges) {
      tabEdges = new Map(); // Initialize if undefined
    }
    
    if (changeInfo.status === 'complete') {
      console.log('Tab updated:', tab);
    }
    
    // Rest of your handler code...
  } catch (error) {
    console.error('Error in tab update handler:', error);
  }
  if (changeInfo.url || changeInfo.title) {
    chrome.runtime.sendMessage({
      action: 'tabUpdated',
      tabId: tabId,
      changeInfo: changeInfo,
      tab: tab
    });
  }
});

// Initial population of history and active tabs
updateHistory();
updateActiveTabs();