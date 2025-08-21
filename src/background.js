/**
 * Tabtopia - Background Service Worker
 * 
 * This service worker powers the tab visualization and relationship tracking system.
 * It serves as the central data hub that maintains tab state across the browser
 * and provides real-time updates to visualization components.
 * 
 * Architecture Overview:
 * - Uses Maps for efficient tab and window state tracking
 * - Implements a comprehensive event system for real-time UI updates
 * - Leverages Chrome's webNavigation API for accurate navigation tracking
 * - Features an intelligent favicon queue system with progressive retries
 * - Provides bidirectional tab relationship mapping for graph visualization
 * 
 * Data Flow:
 * 1. Chrome events (tab created, updated, etc.) → Background script
 * 2. Background script processes and updates browserState
 * 3. Notifications sent to visualization components
 * 4. UI updates reflect current browser state
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log("Tabtopia installed successfully.");
});

/**
 * Navigation deduplication system
 * 
 * Chrome sometimes fires multiple events for the same navigation.
 * This map tracks already processed navigations to prevent duplicate handling.
 * 
 * Format: { "tabId-url-timestamp": { timestamp, handled, type, qualifiers } }
 */
const processedNavigations = new Map();

// Global error handlers to ensure service worker stability
self.addEventListener("error", (event) => {
  console.error("Uncaught error in service worker:", event.error);
});

self.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
});

/**
 * Browser state cache collections
 * 
 * These structures maintain lightweight references to browser state
 * that can be quickly serialized and sent to visualization components.
 */
let historyEntries = [];  // Recent browsing history entries
let activeTabs = [];      // Currently active tabs across all windows
let lastClickedLink = null; // Tracks the most recently clicked link for relationship mapping
let tabEdges = new Map(); // Graph edge data connecting related tabs
let tabActivationTimeout = null; // Timeout for debouncing tab activation events

/**
 * Core application state manager
 * 
 * The browserState object is the central data structure that maintains
 * the complete state of all tabs, windows, and their relationships.
 * It uses Maps for O(1) lookups and efficient memory usage.
 * 
 * This is the source of truth for all tab visualizations.
 */
const browserState = {
  tabs: new Map(),              // All tabs by ID with complete metadata
  windows: new Map(),           // Window grouping data with tab references
  tabHistory: new Map(),        // Navigation history sequence per tab
  heroImages: new Map(),        // Hero images by URL
  tabRelationships: new Map(),  // Parent/child and sibling relationships between tabs
  tabActivityLog: new Map(),    // User interaction and time-spent data
  lastActive: null,             // Last active tab and window reference
  listeners: [],                // State change subscribers

  /**
   * Notifies all registered listeners about state changes
   * This enables reactive UI updates without polling
   * 
   * @param {string} changeType - Category of state change (tab, window, etc)
   * @param {Object} data - Relevant change details
   */
  notifyChange(changeType, data) {
    console.log(`State change: ${changeType}`, data);
    this.listeners.forEach(listener => {
      try {
        listener(changeType, data);
      } catch (error) {
        console.error("Error in state listener:", error);
      }
    });
  },

  /**
   * Registers a callback for state changes with automatic cleanup
   * Returns an unsubscribe function to prevent memory leaks
   * 
   * @param {Function} callback - Function to call on state changes
   * @return {Function} Unsubscribe function to remove the listener
   */
  subscribe(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback);
    };
  },

  /**
   * Retrieves complete tab data with related information
   * Combines core tab data with history and relationship context
   * 
   * @param {number} tabId - Chrome tab ID to fetch
   * @return {Object|null} Comprehensive tab data or null if not found
   */
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

/**
 * Activity tracking configuration constants
 * 
 * These thresholds determine how tab activity time is calculated
 * and when tabs are considered active vs idle
 */
const TAB_ACTIVITY = {
  ACTIVE_THRESHOLD: 1000,    // Min milliseconds to count as active time (prevents counting quick tab switches)
  IDLE_THRESHOLD: 300000,    // Time without interaction to consider tab idle (5 minutes)
  UPDATE_INTERVAL: 5000      // How often to update active tab time counters
};

/**
 * Navigation sequence tracker
 * 
 * Maps tab IDs to arrays of navigation events for that tab
 * Enables back/forward detection and navigation classification
 */
const navigationEvents = new Map();

/**
 * Favicon queue system
 * 
 * Manages efficient favicon fetching with intelligent retries.
 * Implements progressive backoff for failed requests and
 * batch processing to reduce browser API load.
 * 
 * Key features:
 * - Prioritized processing (critical favicons first)
 * - Automatic retries with exponential backoff
 * - Batch processing for performance
 * - Special URL handling
 */
const faviconQueue = {
  pending: new Map(),  // Map of tabId -> {url, attempts, lastCheck, priority}
  processing: false,   // Whether queue is currently being processed
  
  /**
   * Add a favicon check to the queue with optional priority
   * 
   * @param {number} tabId - Tab ID to check favicon for
   * @param {string} url - URL to fetch favicon for
   * @param {string} priority - 'normal' or 'high' priority
   */
  enqueue(tabId, url, priority = "normal") {
    // Skip special URLs that can't use chrome://favicon
    if (url.startsWith("chrome://") || url.startsWith("file://") || 
        url.startsWith("about:") || !url) {
      return;
    }
    
    // Update existing entry or add new one
    const existing = this.pending.get(tabId);
    if (existing && existing.url === url) {
      // Don't reset attempts if already in queue
      existing.priority = priority === "high" ? "high" : existing.priority;
      this.pending.set(tabId, existing);
    } else {
      // New entry
      this.pending.set(tabId, {
        url,
        attempts: 0,
        lastCheck: 0,
        priority
      });
    }
    
    // Start processing if not already running
    if (!this.processing) {
      this.processQueue();
    }
  },
  
  /**
   * Process the favicon queue in prioritized batches
   * 
   * Processes favicons in order of:
   * 1. High priority items first
   * 2. Then by time since last check (oldest first)
   * 
   * Uses batching to limit Chrome API load and improve performance
   */
  processQueue() {
    if (this.pending.size === 0) {
      this.processing = false;
      return;
    }
    
    this.processing = true;
    
    // Sort queue by priority and time since last check
    const entries = Array.from(this.pending.entries())
      .sort(([, a], [, b]) => {
        // High priority first
        if (a.priority === "high" && b.priority !== "high") return -1;
        if (a.priority !== "high" && b.priority === "high") return 1;
        // Then by time since last check
        return (a.lastCheck - b.lastCheck);
      });
    
    // Process first batch of up to 5 entries
    const batch = entries.slice(0, 5);
    
    // Remove processed entries from pending queue
    batch.forEach(([tabId]) => this.pending.delete(tabId));
    
    // Process batch
    Promise.all(batch.map(([tabId, item]) => this.checkFavicon(tabId, item)))
      .finally(() => {
        // Schedule next batch after a short delay
        setTimeout(() => this.processQueue(), 50);
      });
  },
  
  /**
   * Check favicon for a specific tab with progressive retry logic
   * 
   * Implements smart detection and fallback mechanisms:
   * 1. Try to get favicon directly from tab
   * 2. If missing, retry with progressive backoff
   * 3. After 3 attempts, use Chrome's favicon service as fallback
   * 4. Send notifications when favicon is found
   * 
   * @param {number} tabId - Tab ID to check
   * @param {Object} item - Queue item with URL and attempt data
   */
  async checkFavicon(tabId, item) {
    const { url, attempts } = item;
    
    try {
      // Mark as checked
      item.lastCheck = Date.now();
      item.attempts++;
      
      // Get tab info
      const tab = await new Promise(resolve => {
        chrome.tabs.get(tabId, tab => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(tab);
          }
        });
      });
      
      // Tab doesn't exist anymore or URL changed
      if (!tab || tab.url !== url) {
        return;
      }
      
      // Tab already has favicon
      if (tab.favIconUrl) {
        updateTabMetadata(tabId, { favIconUrl: tab.favIconUrl });
        
        // Explicit notification
        sendMessageWithErrorHandling({
          action: "explicitFaviconUpdate",
          tabId,
          favIconUrl: tab.favIconUrl,
          timestamp: Date.now()
        });
        return;
      }
      
      // If no favicon after 3 attempts, use fallback
      if (attempts >= 3) {
        const fallbackFavicon = `chrome://favicon/size/16@1x/${encodeURIComponent(url)}`;
        updateTabMetadata(tabId, { favIconUrl: fallbackFavicon });
        
        // Notify about fallback favicon
        sendMessageWithErrorHandling({
          action: "explicitFaviconUpdate",
          tabId,
          favIconUrl: fallbackFavicon,
          timestamp: Date.now()
        });
        return;
      }
      
      // Requeue with progressive backoff if favicon still missing
      // Exponential backoff with 1.5x multiplier (500ms → 750ms → 1125ms...)
      const delay = Math.min(500 * Math.pow(1.5, attempts), 3000);
      setTimeout(() => {
        this.pending.set(tabId, item);
        if (!this.processing) {
          this.processQueue();
        }
      }, delay);
      
    } catch (error) {
      console.error("Error checking favicon:", error);
    }
  }
};

/**
 * Centralized event dispatcher for UI notifications
 * @param {string} eventType - Type of event
 * @param {Object} data - Event data payload
 */
// eslint-disable-next-line no-unused-vars
function dispatchTabEvent(eventType, data) {
    sendMessageWithErrorHandling({
        action: eventType,
        data: data,
        timestamp: Date.now()
    });
}

/**
 * Clean and normalize tab data for messaging and storage
 * @param {Object} tab - Chrome tab object
 * @return {Object|null} Sanitized tab data or null if invalid
 */
function sanitizeTabData(tab) {
    if (!tab || !tab.id) {
        console.warn("Invalid tab data:", tab);
        return null;
    }

    return {
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title || "Untitled",
        url: tab.url || "",
        favIconUrl: tab.favIconUrl,
        active: tab.active,
        lastAccessed: Date.now(),
        timeSpent: browserState.tabs.get(tab.id)?.timeSpent || 0
    };
}

/**
 * Find tab by ID with error handling
 * @param {number} tabId - Chrome tab ID
 * @return {Promise<Object|null>} Tab object or null if not found
 */
function findTabById(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        console.log(`Tab ${tabId} not found:`, chrome.runtime.lastError);
        resolve(null);
      } else {
        console.log("Found tab:", tab);
        resolve(tab);
      }
    });
  });
}

/**
 * Updates the graph with a new edge representing a tab relationship
 * Creates bidirectional references to track parent-child relationships
 * @param {Object} edge - Edge data with source and target tabs
 */
async function updateGraphWithNewEdge(edge) {
  console.log("Creating new edge:", edge);
  
  try {
    const sourceTab = await findTabById(edge.source);
    const targetTab = await findTabById(edge.target);
    
    if (sourceTab && targetTab) {
      // Enhanced relationship model with detailed navigation metadata
      browserState.tabRelationships.set(targetTab.id, {
        referringTabId: sourceTab.id,
        referringURL: sourceTab.url,
        timestamp: Date.now(),
        transitionType: edge.transitionType || "unknown",
        transitionQualifiers: edge.transitionQualifiers || [],
        linkText: edge.linkText || null,
        isFormSubmission: edge.isFormSubmission || false,
        previousTab: browserState.lastActive?.tabId !== sourceTab.id ? browserState.lastActive?.tabId : null,
        interactionData: edge.interactionData || null
      });
      
      // Store bidirectional reference - also track this on source tab
      const sourceRelationships = browserState.tabRelationships.get(sourceTab.id) || {};
      if (!sourceRelationships.childTabs) {
        sourceRelationships.childTabs = [];
      }
      sourceRelationships.childTabs.push({
        tabId: targetTab.id,
        url: targetTab.url,
        timestamp: Date.now(),
        transitionType: edge.transitionType
      });
      browserState.tabRelationships.set(sourceTab.id, sourceRelationships);
      
      console.log("Added enhanced tab relationship:", browserState.tabRelationships.get(targetTab.id));
    }
  } catch (error) {
    console.error("Error creating edge:", error);
  }
}

/**
 * Update tab activity time tracking
 * Records time spent in each tab for analytics
 * @param {number} tabId - Tab ID to update
 * @param {boolean} isActive - Whether tab is currently active
 */
function updateTabActivity(tabId, isActive) {
  console.log("Updating tab timespent", tabId);
  const now = Date.now();
  const activity = browserState.tabActivityLog.get(tabId) || {
    totalTimeSpent: 0,
    firstSeen: now,
    lastTouch: null
  };

  if (isActive) {
    if (activity.lastTouch) {
      const timeSpent = now - activity.lastTouch;
      // Only count if above threshold to avoid counting quick tab switches
      if (timeSpent > TAB_ACTIVITY.ACTIVE_THRESHOLD) {
        activity.totalTimeSpent += timeSpent;
      }
    }
    activity.lastTouch = now;
  }

  browserState.tabActivityLog.set(tabId, activity);
}

/**
 * Update history entries cache
 * Retrieves recent browsing history and stores it for visualization
 */
function updateHistory() {
  chrome.history.search({ text: "", maxResults: 100 }, (results) => {
      historyEntries = results;
      chrome.storage.local.set({ historyEntries })
          .catch(error => {
              console.error("Error saving history entries:", error);
          });
  });
}

/**
 * Update active tabs cache
 * Maintains a list of currently active tabs across all windows
 */
function updateActiveTabs() {
  chrome.tabs.query({ active: true }, (tabs) => {
      activeTabs = tabs;
      chrome.storage.local.set({ activeTabs })
          .catch(error => {
              console.error("Error saving active tabs:", error);
          });
  });
}

/**
 * Get standard favicon URL for a given page URL
 * Uses Chrome's built-in favicon service
 * @param {string} url - Page URL to get favicon for
 * @return {string} Chrome favicon service URL
 */
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
      type: "newHistoryEntry",
      data: {
          url: result.url,
          faviconUrl: faviconUrl,
          timestamp: new Date().getTime()
      }
  });
});

/**
 * Handle tab activation with optimized event flow
 * Uses debouncing to reduce unnecessary processing
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        // Track active time immediately
        updateTabActivity(activeInfo.tabId, true);
        
        // Record tab focus event
        const focusEvent = {
            timestamp: Date.now(),
            type: 'focus'
        };
        
        // Update or initialize tab activity log
        const activityLog = browserState.tabActivityLog.get(activeInfo.tabId) || [];
        activityLog.push(focusEvent);
        browserState.tabActivityLog.set(activeInfo.tabId, activityLog);
        
        // Log for debugging
        console.log(`Tab ${activeInfo.tabId} focus event recorded in background at ${new Date().toISOString()}`);
        
        // Notify all tabs about this focus event
        sendMessageWithRateLimit({
            action: "tabFocusEvent", 
            tabId: activeInfo.tabId,
            event: focusEvent
        });
        
        // Quick notification with just tab ID (lightweight)
        sendMessageWithRateLimit({
            type: "tabChanged",
            data: {
                tabId: activeInfo.tabId,
                timestamp: Date.now()
            }
        });
        
        // Debounce full tab data update to reduce overhead
        // Using global variable instead of window (which doesn't exist in service workers)
        if (typeof tabActivationTimeout !== 'undefined') {
            clearTimeout(tabActivationTimeout);
        }
        
        tabActivationTimeout = setTimeout(() => {
            chrome.tabs.get(activeInfo.tabId, tab => {
                if (chrome.runtime.lastError) return;
                
                const faviconUrl = getFaviconUrl(tab.url);
                sendMessageWithRateLimit({
                    type: "tabFullyChanged",
                    data: {
                        url: tab.url,
                        faviconUrl: faviconUrl,
                        timestamp: Date.now()
                    }
                });
            });
        }, 250); // Delay full processing for better performance
    } catch (error) {
        console.error("Error in tab activation handler:", error);
    }
});

/**
 * Process content script updates to tab metadata
 * @param {Object} data - Tab metadata from content script
 * @param {Object} sender - Message sender info
 */
function handleContentUpdate(data, sender) {
    const { tabId, title, url, favIconUrl } = data;
    
    console.log("Processing content update:", {
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
            action: "tabUpdated",
            tabId,
            changeInfo: { title, url, favIconUrl },
            tab: tabData
        });
    }
}

/**
 * Detect type of navigation for better classification
 * Identifies back/forward, refresh, and URL bar navigations
 * @param {number} tabId - Tab ID
 * @param {string} url - New URL
 * @param {Object} changeInfo - Change info from Chrome
 * @return {string} Navigation type classification
 */
function detectNavigationType(tabId, url, changeInfo) {
    // First check for history-based navigation
    if (!browserState.tabHistory.has(tabId)) {
        browserState.tabHistory.set(tabId, []);
        return "newNavigation";
    }

    const history = browserState.tabHistory.get(tabId);
    const urlIndex = history.findIndex(entry => entry.url === url);
    
    // Check if this is a back/forward navigation
    if (urlIndex >= 0) {
        const currentPos = history.findIndex(entry => entry.isCurrent);
        
        // Already at this position - likely a refresh
        if (urlIndex === currentPos) return "refresh";
        
        // Back or forward navigation
        return urlIndex < currentPos ? "backNavigation" : "forwardNavigation";
    }
    
    // Check if this was from a link click (detected by content script)
    const isLinkClick = browserState.recentClicks && 
                        browserState.recentClicks[tabId] &&
                        (Date.now() - browserState.recentClicks[tabId].timestamp < 2000);
    
    // If no active link click in past 2 seconds, it's likely URL bar navigation
    if (!isLinkClick && changeInfo.transitionType === "typed") {
        return "urlBarNavigation";
    }
    
    // Default to new navigation
    return "newNavigation";
}

/**
 * Detect if navigation came from URL bar based on history API
 * @param {string} url - URL being navigated to
 * @param {number} tabId - Tab ID
 * @return {Promise<boolean>} Whether navigation was from URL bar
 */
// eslint-disable-next-line no-unused-vars
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
            const isURLBar = latestVisit.transition === "typed";
            
            console.log("Navigation transition detected:", {
                url,
                tabId,
                transition: latestVisit.transition,
                isURLBar
            });
            
            resolve(isURLBar);
        });
    });
}

/**
 * Update tab in all window-related data structures
 * @param {Object} tab - Chrome tab object
 */
// eslint-disable-next-line no-unused-vars
function updateTabInWindows(tabData) {
    if (!tabData || !tabData.windowId) return;
    const tabId = tabData.id;
    
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

/**
 * Handle link context information from content scripts
 * Tracks details about clicked links for correlation with navigation events
 * @param {Object} message - Message with link data
 * @param {Object} sender - Sender information
 */
function handleLinkContext(message, sender) {
    lastClickedLink = {
        ...message.data,
        sourceTabId: sender.tab.id,
        sourceWindowId: sender.tab.windowId,
        // Enhanced with more metadata
        linkText: message.data.text || null,
        sourceTitle: sender.tab.title || null,
        interactionType: message.data.interactionType || "click",
        isFormSubmission: !!message.data.formData,
        formData: message.data.formData || null,
        sourceElementType: message.data.elementType || "link"
    };
    
    // Store in tab activity log for correlation
    const tabActivity = browserState.tabActivityLog.get(sender.tab.id) || { events: [] };
    if (!tabActivity.events) tabActivity.events = [];
    
    tabActivity.events.push({
        type: "link_interaction",
        timestamp: Date.now(),
        data: lastClickedLink
    });
    
    browserState.tabActivityLog.set(sender.tab.id, tabActivity);
    
    // Clear after 5 seconds if not used to prevent memory leaks
    setTimeout(() => {
        if (lastClickedLink?.timestamp === message.data.timestamp) {
            lastClickedLink = null;
        }
    }, 5000);
}

/**
 * Handle new tab creation and track relationships
 * Links new tabs to their source tabs in the relationship graph
 */
chrome.tabs.onCreated.addListener((tab) => {
  // Get the last active tab before this creation
  const previousActiveTab = browserState.lastActive?.tabId;
  
  if (lastClickedLink && tab.pendingUrl === lastClickedLink.targetUrl) {
    // This tab was created from a link click we tracked
    const edge = {
      source: lastClickedLink.sourceTabId,
      target: tab.id,
      type: "link-click",
      text: lastClickedLink.text,
      linkText: lastClickedLink.linkText,
      sourceUrl: lastClickedLink.sourceUrl,
      targetUrl: tab.pendingUrl,
      timestamp: lastClickedLink.timestamp,
      openContext: "new_tab",
      transitionType: "link",
      isFormSubmission: lastClickedLink.isFormSubmission,
      formData: lastClickedLink.formData,
      previousTab: previousActiveTab !== lastClickedLink.sourceTabId ? previousActiveTab : null,
      sourceElementType: lastClickedLink.sourceElementType,
      interactionData: {
        interactionType: lastClickedLink.interactionType,
        sourceTitle: lastClickedLink.sourceTitle
      }
    };
    
    tabEdges.set(`${lastClickedLink.sourceTabId}-${tab.id}`, edge);
    updateGraphWithNewEdge(edge);
    lastClickedLink = null; // Clear after use
  } else {
    // For tabs created without a detected link click
    // (e.g. Ctrl+T or New Tab button)
    const edge = {
      target: tab.id,
      type: "new_tab_command",
      timestamp: Date.now(),
      openContext: "user_command",
      transitionType: "generated",
      previousTab: previousActiveTab
    };
    
    // If we have a last active tab, consider it the source
    if (previousActiveTab) {
      edge.source = previousActiveTab;
      tabEdges.set(`${previousActiveTab}-${tab.id}`, edge);
      updateGraphWithNewEdge(edge);
    }
  }
  
  sendMessageWithRateLimit({
    action: "tabCreated",
    tab: tab
  });
});

/**
 * Handle new window creation and track relationships
 * Correlates new windows with the link clicks that created them
 */
chrome.windows.onCreated.addListener(async (window) => {
    if (!lastClickedLink) return;

    console.log("New window created:", {
        windowId: window.id,
        context: lastClickedLink
    });

    // Wait for the tab to be fully loaded
    const checkTab = async (attempts = 0) => {
        if (attempts > 10) {
            console.log("Max attempts reached waiting for window tab");
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
                    type: "link-click",
                    text: lastClickedLink.text,
                    sourceUrl: lastClickedLink.sourceUrl,
                    targetUrl: targetUrl,
                    timestamp: lastClickedLink.timestamp,
                    openContext: "new_window"
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
                    action: "tabCreated",
                    tab: {
                        id: tab.id,
                        windowId: window.id,
                        title: tab.title || "New Tab",
                        url: targetUrl,
                        favIconUrl: tab.favIconUrl,
                        active: tab.active,
                        lastAccessed: Date.now(),
                        referringTabId: lastClickedLink.sourceTabId
                    }
                });

                console.log("Created edge for new window:", {
                    edge,
                    tab: tab.id,
                    window: window.id
                });

                lastClickedLink = null; // Clear after use
            }
        } catch (error) {
            console.error("Error checking new window tab:", error);
        }
    };

    await checkTab();
});

/**
 * Handle tab removal and clean up references
 * Ensures no memory leaks from removed tabs
 */
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    console.log("Tab being removed:", {
        tabId,
        removeInfo,
        hasState: browserState.tabs.has(tabId)
    });

    // Get tab data before cleanup
    const removedTab = browserState.tabs.get(tabId);
    const tabHistoryData = browserState.tabHistory.get(tabId);
    const relationships = browserState.tabRelationships.get(tabId);

    // Send removal event with complete data
    sendMessageWithErrorHandling({
        action: "tabRemoved",
        tabId,
        data: {
            tab: removedTab,
            history: tabHistoryData,
            relationships,
            removeInfo,
            timestamp: Date.now()
        }
    });

    // Clean up all references to prevent memory leaks
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

    console.log("Tab cleanup complete:", {
        tabId,
        remainingTabs: browserState.tabs.size,
        remainingEdges: tabEdges.size
    });
});

// Track window focus changes for context awareness
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
// eslint-disable-next-line no-unused-vars
function notifyTreemap(message) {
    try {
        // Check if we have any listeners before sending
        chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }, (contexts) => {
            if (contexts.length > 0) {
                sendMessageWithErrorHandling(message)
                    .then(() => {
                        console.log("Message sent successfully:", message.action);
                    })
                    .catch(() => {
                        // Expected when no active listeners
                        console.log("No active listeners for message (expected)");
                    });
            }
        });
    } catch (error) {
        console.error("Error in notifyTreemap:", error);
    }
}

// Add temporary storage for link data
let pendingLinkData = {};

/**
 * Update browser state with navigation events
 * @param {Object} data - Navigation event data
 */
function updateBrowserState(data) {
  // Dispatch the event to browser state via notifyChange
  if (browserState && browserState.notifyChange) {
    browserState.notifyChange('navigation', data);
    console.debug('Browser state updated with navigation data', data);
  } else {
    console.warn('browserState.notifyChange not available, skipping update', data);
  }
}

// Add or modify the navigation event listener
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  // Ignore subframe navigations
  if (details.frameId !== 0) return;
  
  const linkData = pendingLinkData[details.tabId];
  if (linkData && linkData.href === details.url) {
    console.debug(`Navigation matched with link data for tab ${details.tabId}`);
    
    // Update state with combined data
    updateBrowserState({
      type: "LINK_NAVIGATION",
      tabId: details.tabId,
      url: details.url,
      linkText: linkData.text,
      title: linkData.title || "",
      timestamp: linkData.timestamp
    });
    
    // Clean up after using
    delete pendingLinkData[details.tabId];
  }
});

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
        
        // NEW CODE: If title updates but no favicon, try to fetch favicon
        // This helps with typed navigation where title comes first
        if (!tabData.favIconUrl && tabData.url) {
            // Schedule a favicon check when we get a title update
            setTimeout(() => {
                chrome.tabs.get(tabId, (tab) => {
                    if (chrome.runtime.lastError) return;
                    
                    if (tab.favIconUrl) {
                        updateTabMetadata(tabId, { favIconUrl: tab.favIconUrl });
                    } else {
                        // Use fallback favicon if needed
                        const fallbackFavicon = `chrome://favicon/size/16@1x/${encodeURIComponent(tabData.url)}`;
                        updateTabMetadata(tabId, { favIconUrl: fallbackFavicon });
                    }
                });
            }, 300); // Shorter delay since title already updated
        }
    }
    
    if (changes.favIconUrl && changes.favIconUrl !== tabData.favIconUrl) {
        tabData.favIconUrl = changes.favIconUrl;
        hasChanges = true;
        
        // Specifically notify about favicon changes
        sendMessageWithErrorHandling({
            action: "tabFaviconUpdated",
            tabId,
            favIconUrl: changes.favIconUrl
        });
    }
    
    if (changes.status === "complete" && tabData.status !== "complete") {
        tabData.status = "complete";
        tabData.loadCompleted = Date.now();
        hasChanges = true;
    }
    
    if (hasChanges) {
        tabData.lastUpdate = Date.now();
        browserState.tabs.set(tabId, tabData);
        
        // Only notify for significant changes to reduce message traffic
        sendMessageWithErrorHandling({
            action: "tabMetadataUpdated",
            tabId,
            changes
        });
    }
}

// New function to process link navigations
function processLinkNavigation(tabData, details, baseEdge) {
    const { tabId, url } = details;
    
    // Check for pending link data from content scripts
    const linkData = pendingLinkData[tabId];
    const recentClick = browserState.recentClicks?.[tabId];
    
    // If we have pending link data that matches this navigation
    if (linkData && (linkData.href === url || linkData.targetUrl === url)) {
        const edge = {
            ...baseEdge,
            type: "link-click",
            linkText: linkData.text,
            sourceElementType: linkData.elementType || "link",
            isFormSubmission: !!linkData.formData,
            formData: linkData.formData
        };
        
        // If we know the source tab, create an edge
        if (linkData.sourceTabId && linkData.sourceTabId !== tabId) {
            edge.source = linkData.sourceTabId;
            edge.sourceUrl = linkData.sourceUrl;
            
            tabEdges.set(`${linkData.sourceTabId}-${tabId}-${Date.now()}`, edge);
            updateGraphWithNewEdge(edge);
        }
        
        // Clear used data
        delete pendingLinkData[tabId];
    } 
    // Use recentClicks as fallback
    else if (recentClick && (recentClick.targetUrl === url || url.includes(recentClick.targetUrl))) {
        const edge = {
            ...baseEdge,
            type: "link-click",
            linkText: recentClick.text,
            source: recentClick.sourceTabId,
            sourceUrl: recentClick.sourceUrl
        };
        
        tabEdges.set(`${recentClick.sourceTabId}-${tabId}-${Date.now()}`, edge);
        updateGraphWithNewEdge(edge);
        
        // Clear used data
        delete browserState.recentClicks[tabId];
    }
    
    // Update tab activity log with this navigation
    const activity = browserState.tabActivityLog.get(tabId) || { navigations: [] };
    if (!activity.navigations) activity.navigations = [];
    
    activity.navigations.push({
        type: "link_navigation",
        url: url,
        timestamp: Date.now(),
        transitionType: details.transitionType,
        transitionQualifiers: details.transitionQualifiers || []
    });
    
    browserState.tabActivityLog.set(tabId, activity);
}

// Clean up old entries from the processed navigations map
// eslint-disable-next-line no-unused-vars
function cleanProcessedNavigations() {
    const now = Date.now();
    for (const [id, data] of processedNavigations) {
        // Remove entries older than 5 seconds
        if (now - data.timestamp > 5000) {
            processedNavigations.delete(id);
        }
    }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // First check if webNavigation already handled this (for URL changes)
    if (changeInfo.url && processedNavigations.has(`${tabId}-${changeInfo.url}-${Date.now() - 1000}`)) {
        console.log("Skipping duplicate URL change already handled by webNavigation");
        // But still check for favicon even if URL was handled elsewhere
        if (!tab.favIconUrl) {
            faviconQueue.enqueue(tabId, tab.url);
        }
        return;
    }
    
    console.log(`Tab updated: ${tabId}`, changeInfo);
    
    // Always check favicon for ANY tab update in an existing tab
    // This ensures we don't miss favicon updates for any navigation type
    if (browserState.tabs.has(tabId) && tab.url && !tab.favIconUrl) {
        // Schedule immediate check plus delayed check
        faviconQueue.enqueue(tabId, tab.url);
        faviconQueue.enqueue(tabId, tab.url);
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
    else if (changeInfo.status === "complete") {
        // Load complete events
        handleLoadComplete(tabId, tab);
    }
});

// Add this debounce utility function
// eslint-disable-next-line no-unused-vars
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
        console.log("Message rate limit exceeded, dropping:", message.action);
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
                title: tab.title || "",
                transitionType: changeInfo.transitionType || "unknown",
                navigationType,
                timestamp: Date.now()
            });
        } catch (err) {
            console.error("Error processing URL change:", err);
        }
    }, 0);
}

// Clean, focused implementation for web navigation events
chrome.webNavigation.onCommitted.addListener((details) => {
    // Only process main frame navigations
    if (details.frameId !== 0) return;
    
    const { tabId, url, transitionType, transitionQualifiers } = details;
    
    // Skip chrome:// URLs and extension pages
    if (url.startsWith("chrome://") || url.startsWith(chrome.runtime.getURL(""))) return;
    
    // Create a unique ID for this navigation and mark as processed
    const navigationId = `${tabId}-${url}-${Date.now()}`;
    processedNavigations.set(navigationId, {
        timestamp: Date.now(),
        handled: true,
        type: transitionType,
        qualifiers: transitionQualifiers
    });
    
    // Get tab data then record the navigation
    chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
            console.error("Error getting tab:", chrome.runtime.lastError);
            return;
        }
        
        // Record the navigation - no edge creation here
        recordNavigation({
            tabId,
            url,
            title: tab.title || "",
            transitionType,
            transitionQualifiers,
            timestamp: Date.now(),
            navigationId
        });
    });
});

// Add this function if it doesn't exist already, or modify your existing one
function handleLoadComplete(tabId, tab) {
    // When a page load completes, check for favicon
    if (!tab.favIconUrl && tab.url) {
        // For typed navigation, favicon might not be available immediately
        // Set a delayed check to fetch it
        setTimeout(() => {
            chrome.tabs.get(tabId, (updatedTab) => {
                if (chrome.runtime.lastError) return;
                
                if (updatedTab.favIconUrl) {
                    // Now we have the favicon, update it
                    updateTabMetadata(tabId, { favIconUrl: updatedTab.favIconUrl });
                    
                    // Also ensure the tab object in browserState has the favicon
                    const tabData = browserState.tabs.get(tabId);
                    if (tabData) {
                        tabData.favIconUrl = updatedTab.favIconUrl;
                        browserState.tabs.set(tabId, tabData);
                        
                        // Explicitly notify about favicon update
                        sendMessageWithErrorHandling({
                            action: "tabFaviconUpdated",
                            tabId,
                            favIconUrl: updatedTab.favIconUrl
                        });
                    }
                } else if (tab.url) {
                    // If still no favicon, use a chrome://favicon URL as fallback
                    const fallbackFavicon = `chrome://favicon/size/16@1x/${encodeURIComponent(tab.url)}`;
                    updateTabMetadata(tabId, { favIconUrl: fallbackFavicon });
                    
                    const tabData = browserState.tabs.get(tabId);
                    if (tabData) {
                        tabData.favIconUrl = fallbackFavicon;
                        browserState.tabs.set(tabId, tabData);
                        
                        sendMessageWithErrorHandling({
                            action: "tabFaviconUpdated",
                            tabId,
                            favIconUrl: fallbackFavicon
                        });
                    }
                }
            });
        }, 500); // Delay to give the browser time to fetch the favicon
    }
}

// Add this after your chrome.tabs.onUpdated listener
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    console.log(`Tab ${removedTabId} was replaced by ${addedTabId}`);
    
    // Get the new tab data
    chrome.tabs.get(addedTabId, (tab) => {
        if (chrome.runtime.lastError) return;
        
        // Check if favicon was lost during replacement
        if (!tab.favIconUrl && tab.url) {
            // First try immediately with a fallback
            const fallbackFavicon = `chrome://favicon/size/16@1x/${encodeURIComponent(tab.url)}`;
            updateTabMetadata(addedTabId, { favIconUrl: fallbackFavicon });
            
            // Then try again after a delay to get the real favicon
            setTimeout(() => {
                chrome.tabs.get(addedTabId, (updatedTab) => {
                    if (chrome.runtime.lastError) return;
                    
                    if (updatedTab.favIconUrl) {
                        updateTabMetadata(addedTabId, { favIconUrl: updatedTab.favIconUrl });
                    }
                });
            }, 500);
        } else if (tab.favIconUrl) {
            // Make sure we update the favicon if available
            updateTabMetadata(addedTabId, { favIconUrl: tab.favIconUrl });
        }
        
        // Update browserState to reflect the replaced tab
        const tabData = browserState.tabs.get(removedTabId);
        if (tabData) {
            // Transfer any relevant history/data from the removed tab to the added tab
            browserState.tabs.set(addedTabId, {
                ...tabData,
                id: addedTabId,
                url: tab.url,
                title: tab.title || tabData.title || "",
                favIconUrl: tab.favIconUrl || tabData.favIconUrl,
                windowId: tab.windowId,
                active: tab.active,
                lastUpdate: Date.now()
            });
            
            // Clean up the old tab
            browserState.tabs.delete(removedTabId);
        }
        
        // Notify that tab was replaced
        sendMessageWithErrorHandling({
            action: "tabReplaced",
            oldTabId: removedTabId,
            newTabId: addedTabId,
            tab: tab
        });
    });
});

// eslint-disable-next-line no-unused-vars
function checkAndUpdateFavicon(tabId, url) {
    // Just add to queue - the queue system handles the rest
    faviconQueue.enqueue(tabId, url);
}

// Tab focus events are handled by the main chrome.tabs.onActivated listener above

// Listen for runtime messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Ensure we have a valid message
    if (!message || !message.action) {
        console.warn("Invalid message received:", message);
        return false;
    }
    
    // Handle tab activity events from newtab pages
    if (message.action === 'updateTabActivity' && message.tabId && message.event) {
        const activityLog = browserState.tabActivityLog.get(message.tabId) || [];
        activityLog.push(message.event);
        browserState.tabActivityLog.set(message.tabId, activityLog);
        console.log(`Tab ${message.tabId} activity updated from message:`, message.event);
        return true;
    }

    try {
        const messageType = message.type || message.action;
        console.log(`Message received (${messageType}) from ${sender.tab ? "tab "+sender.tab.id : "extension"}`);
        
        switch (messageType) {
            case "contentUpdate":
                handleContentUpdate(message.data, sender);
                break;
            case "getTabId":
                sendResponse({ tabId: sender.tab?.id });
                break;
            case "getTabHistory":
                const history = browserState.tabHistory.get(message.tabId) || [];
                const relationship = browserState.tabRelationships.get(message.tabId);
                sendResponse({ history, relationship });
                break;
            case "getState":
                // Ensure browserState and its properties are defined
                // console.log('Background: getState received. Sending state:', browserState);
                sendResponse({
                    tabs: browserState.tabs ? [...browserState.tabs.entries()] : [],
                    windows: browserState.windows ? [...browserState.windows.entries()] : [],
                    tabHistory: browserState.tabHistory ? [...browserState.tabHistory.entries()] : [],
                    tabRelationships: browserState.tabRelationships ? [...browserState.tabRelationships.entries()] : [],
                    tabActivityLog: browserState.tabActivityLog ? [...browserState.tabActivityLog.entries()] : [],
                    // Include other parts of state if necessary and managed by background.js
                    // ui: browserState.ui || {},
                    // graphData: browserState.graphData || {},
                    // cache: browserState.cache || {}
                });
                break;
            case "LINK_TEXT_CAPTURED":
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
            case "store_link_context":
                handleLinkContext(message, sender);
                break;
            case "linkClicked":
                console.log("Link click detected:", {
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
            case "navigation_event":
                const { tabId, windowId } = sender.tab;
                console.log("Navigation event:", {
                    tabId,
                    windowId,
                    url: message.data.targetUrl
                });
        
                // Force treemap update
                sendMessageWithErrorHandling({
                    action: "tabUpdated",
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
                break;
            // Add other message types as needed
            // Add this case for getFavicon
            case "getFavicon":
                const proxyUrl = chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(message.url)}`);
                sendResponse({ faviconUrl: proxyUrl });
                break;
                
            case "getHeroImagesForUrl":
                // First check the browserState (in-memory cache)
                if (browserState.heroImages && browserState.heroImages.get && message.url) {
                    const heroImageData = browserState.heroImages.get(message.url);
                    if (heroImageData && heroImageData.images) {
                        console.log("🔍 Returning hero images from browserState for URL:", message.url);
                        sendResponse(heroImageData);
                        return;
                    }
                }
                
                // Then check storage
                chrome.storage.local.get(["heroImages"], (result) => {
                    const heroImagesStore = result.heroImages || {};
                    if (heroImagesStore[message.url]) {
                        console.log("📦 Returning hero images from storage for URL:", message.url);
                        
                        // Update browserState for next time (cache warming)
                        if (browserState.heroImages && browserState.heroImages.set) {
                            browserState.heroImages.set(message.url, heroImagesStore[message.url]);
                        }
                        
                        sendResponse(heroImagesStore[message.url]);
                    } else {
                        console.log("⚠️ No hero images found for URL:", message.url);
                        sendResponse({ images: null });
                    }
                });
                break;
            case "storeHeroImages":
                console.log("📸 HERO IMAGE EXTRACTION:", {
                    url: message.data.url,
                    title: message.data.title,
                    imageCount: message.data.heroImages.length,
                    dwellTime: Math.round(message.data.dwellTime/1000) + "s",
                    scrollDepth: message.data.scrollDepth + "px"
                });
                
                // Log the actual images being extracted
                console.log("📸 Hero images found:", message.data.heroImages.map(img => ({
                    src: img.src.substring(0, 100) + (img.src.length > 100 ? '...' : ''),
                    score: img.score,
                    dimensions: `${img.width}x${img.height}`,
                    isMetaImage: !!img.isMetaImage
                })));
                
                // Add to browserState (core shared data structure)
                const heroImageData = {
                    images: message.data.heroImages,
                    title: message.data.title,
                    timestamp: message.data.timestamp,
                    dwellTime: message.data.dwellTime,
                    scrollDepth: message.data.scrollDepth
                };
                
                // Update browserState with hero image data
                browserState.heroImages.set(message.data.url, heroImageData);
                
                // Notify all listeners about new hero image data
                browserState.notifyListeners('heroImage', {
                    type: 'added',
                    url: message.data.url,
                    data: heroImageData
                });
                
                // Get existing hero images or initialize empty object
                chrome.storage.local.get("heroImages", (result) => {
                    const heroImages = result.heroImages || {};
                    
                    // Store new hero images for this URL
                    heroImages[message.data.url] = heroImageData;
                    
                    // Save back to storage
                    chrome.storage.local.set({ heroImages }, () => {
                        if (chrome.runtime.lastError) {
                            console.error("❌ Error storing hero images:", chrome.runtime.lastError);
                        } else {
                            console.log("✅ Successfully stored hero images for", message.data.url);
                            // Send a response to confirm storage
                            sendResponse({ success: true });
                        }
                    });
                });
                break;
        }
    } catch (error) {
        console.error("Error handling message:", error);
    }
    return true; // Keep the message channel open for async responses
});

/**
 * Send messages with enhanced error handling
 * Gracefully handles "Could not establish connection" errors
 * which happen when there's no receiver for the message
 * @param {Object} message - Message to send
 * @returns {Promise} - Promise that resolves to response or null
 */
function sendMessageWithErrorHandling(message) {
    try {
        // Don't log common expected errors
        const isSilent = message.silent === true;
        
        return chrome.runtime.sendMessage(message).catch(error => {
            // Check for the specific connection error that happens when no receivers exist
            if (error && error.message && error.message.includes("Receiving end does not exist")) {
                if (!isSilent) {
                    // Debug level only - this is an expected condition when no receivers
                    console.debug("Message sent but no receivers available:", message.action || message.type);
                }
            } else {
                // Log other errors as actual problems
                console.error("Error sending message:", error);
            }
            return null;
        });
    } catch (error) {
        console.log("Error in sendMessageWithErrorHandling:", error);
        return Promise.resolve(null);
    }
}

// 3. Add a periodic cleanup function to prevent memory leaks
function cleanupDataStructures() {
    try {
        const now = Date.now();
        const OLD_TAB_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours
        
        // Clean up browserState.tabs for tabs that no longer exist
        chrome.tabs.query({}, (tabs) => {
            const activeTabs = new Set(tabs.map(tab => tab.id));
            
            // Clean up tabs that no longer exist
            for (const [tabId] of browserState.tabs) {
                if (!activeTabs.has(tabId)) {
                    browserState.tabs.delete(tabId);
                    browserState.tabHistory.delete(tabId);
                    browserState.tabRelationships.delete(tabId);
                    browserState.tabActivityLog.delete(tabId);
                }
            }
            
            // Clean up stale edges
            for (const [key, edge] of tabEdges) {
                const sourceExists = activeTabs.has(edge.source);
                const targetExists = activeTabs.has(edge.target);
                
                if (!sourceExists || !targetExists || (now - edge.timestamp > OLD_TAB_THRESHOLD)) {
                    tabEdges.delete(key);
                }
            }
        });
        
        // Clean processedNavigations
        for (const [id, data] of processedNavigations) {
            if (now - data.timestamp > 10000) { // 10 seconds
                processedNavigations.delete(id);
            }
        }
        
        console.log("Data structures cleaned up:", {
            tabs: browserState.tabs.size,
            edges: tabEdges.size,
            processedNavigations: processedNavigations.size
        });
    } catch (error) {
        console.error("Error in cleanup:", error);
    }
}

// Run cleanup every 5 minutes
setInterval(cleanupDataStructures, 5 * 60 * 1000);

// Fix for process navigation function - implement missing methods
// eslint-disable-next-line no-unused-vars
function processDirectNavigation(tabData, details) {
  // Implementation for direct navigation
  const activity = browserState.tabActivityLog.get(details.tabId) || { navigations: [] };
  if (!activity.navigations) activity.navigations = [];
  
  activity.navigations.push({
    type: "direct_navigation",
    url: details.url,
    timestamp: Date.now(),
    transitionType: details.transitionType || "unknown",
    transitionQualifiers: details.transitionQualifiers || []
  });
  
  browserState.tabActivityLog.set(details.tabId, activity);
}

// Focused navigation recorder that only updates state - no edge creation
function recordNavigation(details) {
    const { tabId, url, title, transitionType, transitionQualifiers, timestamp } = details;
    
    try {
        // Update the tab history collection
        const history = browserState.tabHistory.get(tabId) || [];
        
        // Add this navigation to the start (most recent)
        history.unshift({
            url,
            title: title || "",
            timestamp,
            transitionType,
            transitionQualifiers: transitionQualifiers || []
        });
        
        // Limit history size
        if (history.length > 50) {
            history.splice(50); // Remove old entries
        }
        
        // Update collection
        browserState.tabHistory.set(tabId, history);
        
        // Update the current tab data
        let tabData = browserState.tabs.get(tabId);
        if (tabData) {
            tabData.url = url;
            tabData.title = title || tabData.title || "";
            tabData.lastUpdate = timestamp;
            tabData.lastNavigation = {
                url,
                timestamp,
                type: transitionType
            };
            
            browserState.tabs.set(tabId, tabData);
        }
        
        // Notify about the navigation
        sendMessageWithErrorHandling({
            action: "tabNavigated",
            tabId,
            url,
            title,
            transitionType,
            timestamp
        });
        
        // Handle different navigation types
        processNavigationType(tabId, url, transitionType, transitionQualifiers);
    } catch (error) {
        console.error("Error recording navigation:", error);
    }
}

// Process navigation type and conditionally create edges
function processNavigationType(tabId, url, transitionType, transitionQualifiers) {
    // Create a base data object for all navigation types
    const baseData = {
        tabId,
        url,
        timestamp: Date.now(),
        transitionType,
        transitionQualifiers: transitionQualifiers || []
    };
    
    // Handle different types of navigation
    switch (transitionType) {
        case "link":
            // Process link navigation - this can create edges
            processLinkNavigation(tabId, url, baseData);
            break;
            
        case "typed":
            // Direct URL bar entry - no edge creation
            logNavigation(tabId, "typed_navigation", baseData);
            break;
            
        case "auto_bookmark":
            // Bookmark navigation - might create edge if we track bookmarks
            logNavigation(tabId, "bookmark_navigation", baseData);
            break;
            
        case "generated":
            // Auto-generated navigation - no edge needed usually
            logNavigation(tabId, "generated_navigation", baseData);
            break;
            
        default:
            // Other types - just log
            logNavigation(tabId, "other_navigation", baseData);
    }
}

// Helper to consistently log navigations
function logNavigation(tabId, type, data) {
    const activity = browserState.tabActivityLog.get(tabId) || { navigations: [] };
    if (!activity.navigations) activity.navigations = [];
    
    activity.navigations.push({
        type,
        ...data,
        timestamp: Date.now()
    });
    
    browserState.tabActivityLog.set(tabId, activity);
}

// Add this listener if it doesn't exist yet
chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  console.log(`Tab ${tabId} moved:`, moveInfo);
  
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    
    // Update browserState to reflect tab move
    const tabData = browserState.tabs.get(tabId);
    if (tabData) {
      tabData.windowId = tab.windowId;
      tabData.index = tab.index;
      browserState.tabs.set(tabId, tabData);
    }
    
    // Notify UI about the move
    sendMessageWithErrorHandling({
      action: "tabMoved",
      tabId,
      moveInfo,
      tab
    });
  });
});

