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
    sendMessageWithErrorHandling({
        action: eventType,
        data: data,
        timestamp: Date.now()
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
  console.log("upating tab timespent", tabId);
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
  sendMessageWithErrorHandling({
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
      sendMessageWithErrorHandling({
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
        case 'linkClicked':
            console.log('Link click detected:', {
                fromUrl: sender.tab.url,
                toUrl: message.url,
                tabId: sender.tab.id
            });
            
            // Store the click so we can connect it to the subsequent navigation
            browserState.recentClicks = browserState.recentClicks || {};
            browserState.recentClicks[sender.tab.id] = {
                timestamp: Date.now(),
                sourceUrl: sender.tab.url,
                targetUrl: message.url
            };
            break;
        case 'LINK_TEXT_CAPTURED':
            if (sender.tab) {
                const tabId = sender.tab.id;
                console.debug(`Link text captured in tab ${tabId}:`, message.data);
                
                // Store for correlation with navigation events
                pendingLinkData[tabId] = message.data;
                
                // Clean up after timeout to prevent memory leaks
                setTimeout(() => {
                  if (pendingLinkData[tabId]) {
                    delete pendingLinkData[tabId];
                  }
                }, 5000);
              }
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
        sendMessageWithErrorHandling({
            action: 'tabUpdated',
            tabId,
            changeInfo: { title, url, favIconUrl },
            tab: tabData
        });
    }
}

// Add this helper function for navigation detection
function detectNavigationType(tabId, url, changeInfo) {
    // First check for history-based navigation
    if (!browserState.tabHistory.has(tabId)) {
        browserState.tabHistory.set(tabId, []);
        return 'newNavigation';
    }

    const history = browserState.tabHistory.get(tabId);
    const urlIndex = history.findIndex(entry => entry.url === url);
    
    // Check if this is a back/forward navigation
    if (urlIndex >= 0) {
        const currentPos = history.findIndex(entry => entry.isCurrent);
        
        // Already at this position - likely a refresh
        if (urlIndex === currentPos) return 'refresh';
        
        // Back or forward navigation
        return urlIndex < currentPos ? 'backNavigation' : 'forwardNavigation';
    }
    
    // Now distinguish between URL bar navigation and other new navigations
    
    // Check if this was from a link click (detected by content script)
    const isLinkClick = browserState.recentClicks && 
                        browserState.recentClicks[tabId] &&
                        (Date.now() - browserState.recentClicks[tabId].timestamp < 2000);
    
    // If no active link click in past 2 seconds, it's likely URL bar navigation
    if (!isLinkClick && changeInfo.transitionType === 'typed') {
        return 'urlBarNavigation';
    }
    
    // Default to new navigation
    return 'newNavigation';
}

// Add this utility function to detect URL bar navigation
function detectURLBarNavigation(url, tabId) {
    return new Promise(resolve => {
        // Look up visit information for this URL
        chrome.history.getVisits({ url }, visits => {
            if (!visits || visits.length === 0) {
                resolve(false);
                return;
            }
            
            // Get the most recent visit
            const latestVisit = visits[visits.length - 1];
            
            // Check transition type - "typed" means URL bar input
            const isURLBar = latestVisit.transition === 'typed';
            
            console.log('Navigation transition detected:', {
                url,
                tabId,
                transition: latestVisit.transition,
                isURLBar
            });
            
            resolve(isURLBar);
        });
    });
}


// Helper to update tab in window structure
function updateTabInWindows(tabId, tabData) {
    if (!tabData || !tabData.windowId) return;
    
    let windowFound = false;
    
    // Update in windows collection
    browserState.windows.forEach((windowData, windowId) => {
        if (windowId === tabData.windowId) {
            windowFound = true;
            // Check if tab exists in this window
            const tabIndex = windowData.tabs.indexOf(tabId);
            if (tabIndex < 0) {
                // Add tab to window
                windowData.tabs.push(tabId);
                console.log(`Added tab ${tabId} to window ${windowId}`);
            }
        }
    });
    
    // If window not found, create it
    if (!windowFound) {
        browserState.windows.set(tabData.windowId, {
            id: tabData.windowId,
            tabs: [tabId],
            lastUpdate: Date.now()
        });
        console.log(`Created new window ${tabData.windowId} for tab ${tabId}`);
    }
}

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
        sendMessageWithErrorHandling({
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
  sendMessageWithErrorHandling({
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
                sendMessageWithErrorHandling({
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
    sendMessageWithErrorHandling({
        action: 'tabRemoved',
        tabId,
        data: {
            tab: removedTab,
            history: tabHistoryData,
            relationships,
            removeInfo,
            timestamp: Date.now()
        }
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
                sendMessageWithErrorHandling(message)
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

// Add the webNavigation listener for accurate transition detection
chrome.webNavigation.onCommitted.addListener((details) => {
    // Only process main frame navigations
    if (details.frameId !== 0) return;
    
    const { tabId, url, transitionType, transitionQualifiers } = details;
    
    console.log('WebNavigation event detected:', {
        tabId,
        url,
        transitionType,         // 'link', 'typed', 'auto_bookmark', 'reload', etc.
        transitionQualifiers,   // ['from_address_bar', 'forward_back', etc.]
        timestamp: Date.now()
    });
    
    // Determine precise navigation type
    let navigationType = 'unknown';
    
    if (transitionType === 'typed' || transitionQualifiers.includes('from_address_bar')) {
        navigationType = 'urlBarNavigation';
    } else if (transitionType === 'link') {
        // We might have link text from our content script
        navigationType = 'linkClick';
        
        // Check if we have stored link info from the content script
        const linkInfo = browserState.recentClicks && browserState.recentClicks[tabId];
        const linkText = linkInfo?.text || '';
        
        console.log('Link navigation with potential text:', {
            tabId,
            hasStoredInfo: !!linkInfo,
            linkText
        });
    } else if (transitionType === 'reload') {
        navigationType = 'refresh';
    } else if (transitionQualifiers.includes('forward_back')) {
        navigationType = transitionQualifiers.includes('forward') ? 'forwardNavigation' : 'backNavigation';
    } else {
        navigationType = transitionType; // Use the raw type for other cases
    }
    
    // Update tab data with this navigation info
    chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return;
        
        const tabData = sanitizeTabData(tab);
        if (!tabData) return;
        
        // Update browser state with this new navigation
        const existingTab = browserState.tabs.get(tabId) || {};
        browserState.tabs.set(tabId, {
            ...existingTab,
            ...tabData,
            navigationType,
            transitionType,
            lastNavigationTime: Date.now()
        });
        
        // Get link context if it exists
        const linkContext = browserState.recentClicks ? 
                           browserState.recentClicks[tabId] : null;
        
        // Send enhanced message with all navigation data
        sendMessageWithErrorHandling({
            action: 'tabUpdated',
            tabId,
            changeInfo: {
                url,
                navigationType,
                transitionType,
                transitionQualifiers,
                isUrlBar: navigationType === 'urlBarNavigation',
                isLinkClick: navigationType === 'linkClick',
                isBackForward: ['backNavigation', 'forwardNavigation'].includes(navigationType),
                linkText: linkContext?.text || null,
                sourcePage: linkContext?.sourceUrl || null
            },
            tab: tabData
        });
        
        // Update tab in window structure
        updateTabInWindows(tabId, tabData);
    });
});



// Replace all instances of direct chrome.runtime.sendMessage with this wrapper
function sendMessageWithErrorHandling(message) {
    return chrome.runtime.sendMessage(message)
        .catch(error => {
            // This is expected when no listeners exist, just log and continue
            console.log(`Message not delivered (${message.action}): No receivers`);
            return null;
        });
}

// Add temporary storage for link data
let pendingLinkData = {};

// Listen for captured link text from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'LINK_TEXT_CAPTURED' && sender.tab) {
    const tabId = sender.tab.id;
    console.debug(`Link text captured in tab ${tabId}:`, message.data);
    
    // Store for correlation with navigation events
    pendingLinkData[tabId] = message.data;
    
    // Clean up after timeout to prevent memory leaks
    setTimeout(() => {
      if (pendingLinkData[tabId]) {
        delete pendingLinkData[tabId];
      }
    }, 5000);
  }
  return true;
});

// Add or modify the navigation event listener
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  // Ignore subframe navigations
  if (details.frameId !== 0) return;
  
  const linkData = pendingLinkData[details.tabId];
  if (linkData && linkData.href === details.url) {
    console.debug(`Navigation matched with link data for tab ${details.tabId}`);
    
    // Update state with combined data
    updateBrowserState({
      type: 'LINK_NAVIGATION',
      tabId: details.tabId,
      url: details.url,
      linkText: linkData.text,
      title: linkData.title || '',
      timestamp: linkData.timestamp
    });
    
    // Clean up after using
    delete pendingLinkData[details.tabId];
  }
});

// Make sure this function exists or modify your existing state update function
function updateBrowserState(eventData) {
  // Update your unified state model with the navigation event
  // This will need to integrate with your existing state management logic
  
  // Then notify state.js about the change
  broadcastStateChange({
    type: 'STATE_UPDATED',
    event: eventData
  });
}

// Track which navigations have already been processed
const processedNavigations = new Map();

// Primary navigation handler using webNavigation
chrome.webNavigation.onCommitted.addListener((details) => {
    // Only process main frame navigations
    if (details.frameId !== 0) return;
    
    const { tabId, url, transitionType, transitionQualifiers } = details;
    
    // Skip chrome:// URLs and extension pages
    if (url.startsWith('chrome://') || url.startsWith(chrome.runtime.getURL(''))) return;
    
    console.log(`Navigation committed: ${url} (${transitionType})`, transitionQualifiers);
    
    // Store a unique identifier for this navigation to avoid duplicate processing
    const navigationId = `${tabId}-${url}-${Date.now()}`;
    processedNavigations.set(navigationId, {
        timestamp: Date.now(),
        handled: true,
        type: transitionType
    });
    
    // Clean old entries from processedNavigations map
    cleanProcessedNavigations();
    
    // Get tab data
    chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
            console.error('Error getting tab:', chrome.runtime.lastError);
            return;
        }
        
        // Record the navigation with detailed transition information
        recordNavigation({
            tabId,
            url,
            title: tab.title || '',
            transitionType,
            transitionQualifiers,
            timestamp: Date.now(),
            navigationId
        });
    });
});



// Record a navigation event and update state
function recordNavigation(details) {
    const { tabId, url, title, transitionType, timestamp, navigationId } = details;
    
    // Get existing tab data or create new entry
    let tabData = browserState.tabs.get(tabId) || {
        id: tabId,
        history: [],
        created: timestamp
    };
    
    // Update tab data
    tabData = {
        ...tabData,
        url,
        title: title || tabData.title || '',
        lastNavigation: {
            url,
            timestamp,
            type: transitionType
        },
        lastUpdate: timestamp
    };
    
    // Add to history (with size limit)
    if (!tabData.history) tabData.history = [];
    tabData.history.unshift({ url, timestamp, type: transitionType });
    
    // Limit history size
    if (tabData.history.length > 50) {
        tabData.history = tabData.history.slice(0, 50);
    }
    
    // Save updated tab data
    browserState.tabs.set(tabId, tabData);
    
    // Only send one message for this navigation
    sendMessageWithErrorHandling({
        action: 'tabNavigated',
        tabId,
        url,
        title,
        transitionType,
        timestamp
    });
    
    // Additional processing for specific navigation types
    processNavigationByType(tabData, details);
}

// Update tab metadata without recording a new navigation
function updateTabMetadata(tabId, changes) {
    // Get existing tab data
    const tabData = browserState.tabs.get(tabId);
    if (!tabData) return;
    
    // Update fields that changed
    let hasChanges = false;
    
    if (changes.title && changes.title !== tabData.title) {
        tabData.title = changes.title;
        hasChanges = true;
    }
    
    if (changes.favIconUrl && changes.favIconUrl !== tabData.favIconUrl) {
        tabData.favIconUrl = changes.favIconUrl;
        hasChanges = true;
    }
    
    if (changes.status === 'complete' && tabData.status !== 'complete') {
        tabData.status = 'complete';
        tabData.loadCompleted = Date.now();
        hasChanges = true;
    }
    
    if (hasChanges) {
        tabData.lastUpdate = Date.now();
        browserState.tabs.set(tabId, tabData);
        
        // Only notify for significant changes to reduce message traffic
        sendMessageWithErrorHandling({
            action: 'tabMetadataUpdated',
            tabId,
            changes
        });
    }
}

// Process different navigation types
function processNavigationByType(tabData, details) {
    const { transitionType, transitionQualifiers } = details;
    
    // Handle different navigation types
    if (transitionType === 'link') {
        // Link click navigation
        processLinkNavigation(tabData, details);
    } 
    else if (transitionType === 'typed' || transitionType === 'generated') {
        // URL bar navigation or address entered
        processDirectNavigation(tabData, details);
    }
    else if (transitionType === 'reload') {
        // Page reload
        processReload(tabData, details);
    }
    else if (transitionType === 'auto_bookmark') {
        // Navigation from bookmark
        processBookmarkNavigation(tabData, details);
    }
    else if (transitionQualifiers.includes('forward_back')) {
        // Back/forward navigation
        processHistoryNavigation(tabData, details);
    }
}

// Clean up old entries from the processed navigations map
function cleanProcessedNavigations() {
    const now = Date.now();
    for (const [id, data] of processedNavigations) {
        // Remove entries older than 5 seconds
        if (now - data.timestamp > 5000) {
            processedNavigations.delete(id);
        }
    }
}

// Consolidate these three onUpdated listeners into ONE comprehensive handler
// Keep only this one and remove the other two
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // First check if webNavigation already handled this (for URL changes)
    if (changeInfo.url && processedNavigations.has(`${tabId}-${changeInfo.url}-${Date.now() - 1000}`)) {
        console.log('Skipping duplicate URL change already handled by webNavigation');
        return;
    }
    
    // Handle different update types appropriately
    if (changeInfo.url) {
        // URL changes (that weren't caught by webNavigation)
        handleUrlChange(tabId, changeInfo, tab);
    } 
    else if (changeInfo.title || changeInfo.favIconUrl) {
        // Metadata changes only
        updateTabMetadata(tabId, changeInfo);
    }
    else if (changeInfo.status === 'complete') {
        // Load complete events
        handleLoadComplete(tabId, tab);
    }
});

// Add this debounce utility function
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// Rate-limit message sending
let messageCounter = 0;
const MESSAGE_RATE_LIMIT = 20; // max messages per second
let lastMessageReset = Date.now();

function sendMessageWithRateLimit(message) {
    const now = Date.now();
    
    // Reset counter every second
    if (now - lastMessageReset > 1000) {
        messageCounter = 0;
        lastMessageReset = now;
    }
    
    // Check rate limit
    if (messageCounter >= MESSAGE_RATE_LIMIT) {
        console.log('Message rate limit exceeded, dropping:', message.action);
        return Promise.resolve();
    }
    
    messageCounter++;
    return sendMessageWithErrorHandling(message);
}

// Move complex navigation logic out of the direct handler
function handleUrlChange(tabId, changeInfo, tab) {
    // Queue this work to avoid blocking the main thread
    setTimeout(() => {
        try {
            const navigationType = detectNavigationType(tabId, changeInfo.url, changeInfo);
            recordNavigation({
                tabId,
                url: changeInfo.url,
                title: tab.title || '',
                transitionType: changeInfo.transitionType || 'unknown',
                navigationType,
                timestamp: Date.now()
            });
        } catch (err) {
            console.error('Error processing URL change:', err);
        }
    }, 0);
}