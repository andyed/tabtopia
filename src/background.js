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
let tabEdges = new Map(); // Initialize tabEdges as a Map

// State variables
const browserState = {
    tabs: new Map(),
    windows: new Map(),
    tabHistory: new Map(), // Moved from separate declaration 
    tabRelationships: new Map(), // Moved from separate declaration
    tabActivityLog: new Map(), // Moved from separate declaration
    lastActive: null,
    listeners: [],
    
    // Add notification method
    notifyChange(changeType, data) {
        console.log(`State change: ${changeType}`, data);
        this.listeners.forEach(listener => {
            try {
                listener(changeType, data);
            } catch (error) {
                console.error('Error in state listener:', error);
            }
        });
    },
    
    // Add subscription method
    subscribe(callback) {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter(cb => cb !== callback);
        };
    },
    
    // Helper to get tab data with all related info
    getTabData(tabId) {
        const tab = this.tabs.get(tabId);
        if (!tab) return null;
        
        return {
            ...tab,
            history: this.tabHistory.get(tabId) || [],
            relationship: this.tabRelationships.get(tabId),
            activity: this.tabActivityLog.get(tabId)
        };
    }
};

// Add tracking constants
const TAB_ACTIVITY = {
  ACTIVE_THRESHOLD: 1000,    // 1 second minimum to count as active time
  IDLE_THRESHOLD: 300000,    // 5 minutes without interaction = idle
  UPDATE_INTERVAL: 5000      // Update active tab time every 5 seconds
};

// Add this new tracking Map after the browserState declaration
const navigationEvents = new Map(); // Track navigation sequence per tab

// Centralized event dispatcher
function dispatchTabEvent(eventType, data) {
    chrome.runtime.sendMessage({
        action: eventType,
        data: data,
        timestamp: Date.now()
    }).catch(err => {
        console.log('No listeners for event:', eventType);
    });
}

// Clean tab data before sending
function sanitizeTabData(tab) {
    if (!tab || !tab.id) {
        console.warn('Invalid tab data:', tab);
        return null;
    }

    return {
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title || 'Untitled',
        url: tab.url || '',
        favIconUrl: tab.favIconUrl,
        active: tab.active,
        lastAccessed: Date.now(),
        timeSpent: browserState.tabs.get(tab.id)?.timeSpent || 0
    };
}

// Add after the TAB_ACTIVITY constant definition
function findTabById(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        console.log(`Tab ${tabId} not found:`, chrome.runtime.lastError);
        resolve(null);
      } else {
        console.log(`Found tab:`, tab);
        resolve(tab);
      }
    });
  });
}

// Update the existing edge creation code to use the Promise-based findTabById
async function updateGraphWithNewEdge(edge) {
  console.log('Creating new edge:', edge);
  
  try {
    const sourceTab = await findTabById(edge.source);
    const targetTab = await findTabById(edge.target);
    
    if (sourceTab && targetTab) {
      browserState.tabRelationships.set(targetTab.id, {
        referringTabId: sourceTab.id,
        referringURL: sourceTab.url,
        timestamp: Date.now()
      });
      console.log('Added tab relationship:', browserState.tabRelationships.get(targetTab.id));
    }
  } catch (error) {
    console.error('Error creating edge:', error);
  }
}

// Add time tracking function
function updateTabActivity(tabId, isActive) {
  const now = Date.now();
  const activity = browserState.tabActivityLog.get(tabId) || {
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

  browserState.tabActivityLog.set(tabId, activity);
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

// Consolidate message listeners into one handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Background received message:', {
        type: message.type,
        action: message.action,
        sender: sender.tab?.id
    });

    switch (message.type) {
        case 'contentUpdate':
            handleContentUpdate(message.data, sender);
            break;
        case 'getTabId':
            sendResponse({ tabId: sender.tab.id });
            break;
        case 'getTabHistory':
            const history = browserState.tabHistory.get(message.tabId) || [];
            const relationship = browserState.tabRelationships.get(message.tabId);
            sendResponse({ history, relationship });
            break;
        case 'store_link_context':
            handleLinkContext(message, sender);
            break;
    }
    return true;
});

// Add dedicated content update handler
function handleContentUpdate(data, sender) {
    const { tabId, title, url, favIconUrl } = data;
    
    console.log('Processing content update:', {
        tabId,
        title,
        url,
        sender: sender.tab?.id
    });

    // Update internal state
    const tabData = sanitizeTabData({
        id: tabId,
        windowId: sender.tab.windowId,
        title,
        url,
        favIconUrl,
        active: sender.tab.active
    });

    if (tabData) {
        browserState.tabs.set(tabId, tabData);

        // Notify treemap
        chrome.runtime.sendMessage({
            action: 'tabUpdated',
            tabId,
            changeInfo: { title, url, favIconUrl },
            tab: tabData
        }).catch(err => {
            console.log('No listeners for content update');
        });
    }
}

// Add this helper function for navigation detection
function detectNavigationType(tabId, url) {
    if (!browserState.tabHistory.has(tabId)) {
        browserState.tabHistory.set(tabId, []);
        return 'newNavigation';
    }

    const history = browserState.tabHistory.get(tabId);
    
    // Find the URL in history
    const urlIndex = history.findIndex(entry => entry.url === url);
    
    if (urlIndex >= 0) {
        // Calculate where this URL is relative to current position
        const currentPos = history.findIndex(entry => entry.isCurrent);
        
        // Already at this position
        if (urlIndex === currentPos) return 'refresh';
        
        // If URL exists in history but at different position
        return urlIndex < currentPos ? 'backNavigation' : 'forwardNavigation';
    }
    
    return 'newNavigation';
}

// Update the tab update listener to better detect back/forward navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    console.log('Tab update detected:', { 
        tabId, 
        changeInfo,
        hasUrl: !!changeInfo.url,
        hasTitle: !!changeInfo.title,
        status: changeInfo.status
    });

    // Track all navigation status changes
    if (changeInfo.status) {
        if (!navigationEvents.has(tabId)) {
            navigationEvents.set(tabId, []);
        }
        
        const events = navigationEvents.get(tabId);
        events.push({
            status: changeInfo.status,
            url: tab.url,
            timestamp: Date.now()
        });
        
        // Limit event history size
        if (events.length > 20) events.shift();
    }

    // Always update state and notify for URL changes
    if (changeInfo.url || changeInfo.title || changeInfo.favIconUrl || changeInfo.status === 'complete') {
        const tabData = sanitizeTabData(tab);
        if (!tabData) return;

        // Update state
        browserState.tabs.set(tabId, tabData);

        // Special handling for URL changes - detect back/forward navigation
        if (changeInfo.url) {
            const navigationType = detectNavigationType(tabId, changeInfo.url);
            
            // Add this URL to history if it's new
            const history = browserState.tabHistory.get(tabId);
            
            // Update current position for all entries
            history.forEach(entry => entry.isCurrent = false);
            
            // Add new entry or update existing
            if (navigationType === 'newNavigation') {
                history.push({
                    url: changeInfo.url,
                    title: tab.title,
                    timestamp: Date.now(),
                    isCurrent: true
                });
                
                // Keep history at reasonable size
                if (history.length > 50) history.shift();
            } else if (navigationType === 'backNavigation' || navigationType === 'forwardNavigation') {
                // Find and mark the current entry
                const entryIndex = history.findIndex(entry => entry.url === changeInfo.url);
                if (entryIndex >= 0) {
                    history[entryIndex].isCurrent = true;
                    history[entryIndex].lastVisited = Date.now();
                }
            }
            
            // Include navigation type in the update
            console.log(`Tab navigation: ${navigationType}`, {
                tabId, 
                url: changeInfo.url
            });
            
            // Send message with navigation type info
            chrome.runtime.sendMessage({
                action: 'tabUpdated',
                tabId,
                changeInfo: {
                    ...changeInfo,
                    navigationType
                },
                tab: sanitizeTabData(tab),
                type: navigationType
            }).catch(() => {
                // Expected when no listeners
                console.log('No active listeners for navigation update');
            });
        } else {
            // For non-URL changes, just send regular updates
            chrome.runtime.sendMessage({
                action: 'tabUpdated',
                tabId,
                changeInfo,
                tab: tabData
            }).catch(err => {
                // Expected when no listeners
                console.log('No active listeners for tab update');
            });
        }
    }
});

// Add listener for content script updates
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'navigation_event') {
        const { tabId, windowId } = sender.tab;
        console.log('Navigation event:', {
            tabId,
            windowId,
            url: message.data.targetUrl
        });

        // Force treemap update
        chrome.runtime.sendMessage({
            action: 'tabUpdated',
            tabId,
            changeInfo: {
                url: message.data.targetUrl,
                title: message.data.text
            },
            tab: {
                id: tabId,
                windowId,
                url: message.data.targetUrl,
                title: message.data.text
            }
        }).catch(err => {
            console.log('No listeners for navigation event');
        });
    }
    return true;
});

// Store context for potential new tab/window opens
function handleLinkContext(message, sender) {
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

    console.log('New window created:', {
        windowId: window.id,
        context: lastClickedLink
    });

    // Wait for the tab to be fully loaded
    const checkTab = async (attempts = 0) => {
        if (attempts > 10) {
            console.log('Max attempts reached waiting for window tab');
            return;
        }

        try {
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
                
                // Update relationships
                browserState.tabRelationships.set(tab.id, {
                    referringTabId: lastClickedLink.sourceTabId,
                    referringURL: lastClickedLink.sourceUrl,
                    timestamp: Date.now()
                });

                // Send update to treemap
                chrome.runtime.sendMessage({
                    action: 'tabCreated',
                    tab: {
                        id: tab.id,
                        windowId: window.id,
                        title: tab.title || 'New Tab',
                        url: targetUrl,
                        favIconUrl: tab.favIconUrl,
                        active: tab.active,
                        lastAccessed: Date.now(),
                        referringTabId: lastClickedLink.sourceTabId
                    }
                }).catch(err => {
                    console.log('No active listeners for new window tab');
                });

                console.log('Created edge for new window:', {
                    edge,
                    tab: tab.id,
                    window: window.id
                });

                lastClickedLink = null; // Clear after use
            }
        } catch (error) {
            console.error('Error checking new window tab:', error);
        }
    };

    await checkTab();
});

// Main tab removal listener
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    console.log('Tab being removed:', {
        tabId,
        removeInfo,
        hasState: browserState.tabs.has(tabId)
    });

    // Get tab data before cleanup
    const removedTab = browserState.tabs.get(tabId);
    const tabHistoryData = browserState.tabHistory.get(tabId); // Renamed to avoid collision
    const relationships = browserState.tabRelationships.get(tabId);

    // Send removal event with complete data
    chrome.runtime.sendMessage({
        action: 'tabRemoved',
        tabId,
        data: {
            tab: removedTab,
            history: tabHistoryData,
            relationships,
            removeInfo,
            timestamp: Date.now()
        }
    }).catch(err => {
        console.log('No listeners for tab removal');
    });

    // Clean up all references
    browserState.tabs.delete(tabId);
    browserState.tabHistory.delete(tabId);
    browserState.tabActivityLog.delete(tabId);
    navigationEvents.delete(tabId);
    browserState.tabRelationships.delete(tabId);
    browserState.tabHistory.delete(tabId);

    // Clean up any edges where this tab was source or target
    for (const [key, edge] of tabEdges) {
        if (edge.source === tabId || edge.target === tabId) {
            tabEdges.delete(key);
        }
    }

    console.log('Tab cleanup complete:', {
        tabId,
        remainingTabs: browserState.tabs.size,
        remainingEdges: tabEdges.size
    });
});

// Track window focus
chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) {
        browserState.lastActive = {
            windowId,
            timestamp: Date.now()
        };
    }
});

// Initial population of history and active tabs
updateHistory();
updateActiveTabs();

// Update message sending functions to handle errors properly
function notifyTreemap(message) {
    try {
        // Check if we have any listeners before sending
        chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }, (contexts) => {
            if (contexts.length > 0) {
                chrome.runtime.sendMessage(message)
                    .then(() => {
                        console.log('Message sent successfully:', message.action);
                    })
                    .catch(err => {
                        // Expected when no active listeners
                        console.log('No active listeners for message (expected)');
                    });
            }
        });
    } catch (error) {
        console.error('Error in notifyTreemap:', error);
    }
}