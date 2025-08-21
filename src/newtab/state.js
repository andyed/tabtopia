/**
 * State Management Module for Tabtopia
 * 
 * This module implements a Redux-inspired state management system with:
 * - Single source of truth (store)
 * - Read-only state
 * - Actions for state changes
 * - Pure reducer functions
 * - Middleware support
 * 
 * @module state
 */

/**
 * Action Types
 * Constants for all possible state changes
 */
export const ActionTypes = {
  // Tab actions
  TAB_CREATED: 'TAB_CREATED',
  TAB_UPDATED: 'TAB_UPDATED',
  TAB_REMOVED: 'TAB_REMOVED',
  TAB_ACTIVATED: 'TAB_ACTIVATED',
  
  // Window actions
  WINDOW_CREATED: 'WINDOW_CREATED',
  WINDOW_UPDATED: 'WINDOW_UPDATED',
  WINDOW_REMOVED: 'WINDOW_REMOVED',
  
  // UI actions
  UI_SELECT_TAB: 'UI_SELECT_TAB',
  UI_CHANGE_VIEW: 'UI_CHANGE_VIEW',
  
  // Relationship actions
  RELATIONSHIP_ADDED: 'RELATIONSHIP_ADDED',
  RELATIONSHIP_REMOVED: 'RELATIONSHIP_REMOVED',
  
  // Data actions
  SUMMARY_STORED: 'SUMMARY_STORED',
  NODE_POSITION_UPDATED: 'NODE_POSITION_UPDATED',
  
  // Batch actions
  BATCH_STATE_UPDATE: 'BATCH_STATE_UPDATE',
};

/**
 * Initial state for the Redux store
 */
const initialState = {
  // Browser state
  tabs: new Map(),
  windows: new Map(),
  tabHistory: new Map(),
  tabRelationships: new Map(),
  tabActivityLog: new Map(), // Added for dwell time and activity
  
  // UI state
  ui: {
    selectedTab: null,
    selectedWindow: null,
    currentView: 'treemap',
    searchQuery: '',
  },
  
  // Persistent data
  graphData: {
    summaries: {},
    customEdges: [],
    nodePositions: {},
    lastUpdated: null
  },
  
  // Cache
  cache: {
    favicons: new Map(),
    lastFetch: Date.now()
  }
};

/**
 * Central browser state interface with Redux-inspired architecture
 * @namespace browserState
 */
export const browserState = {
  /**
   * Private store holding the actual state
   * @private
   */
  _store: { ...initialState },
  
  /**
   * State change listeners
   * @private
   */
  _listeners: [],
  
  /**
   * Middleware functions to process actions
   * @private
   */
  _middleware: [],
  
  /**
   * Retrieves a complete snapshot of the current browser state
   * 
   * @async
   * @returns {Promise<Object>} Current browser state
   */
  async getState() {
    // First try getting fresh state from background service
    try {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'getState' }, (response) => {
          if (response) {
            // Update local store with fresh data
            this._dispatch({
              type: ActionTypes.BATCH_STATE_UPDATE,
              payload: response
            });
            resolve(response);
          } else {
            // Fall back to local store if no response
            resolve(this._getLocalState());
          }
        });
      });
    } catch (error) {
      console.error('Error fetching state:', error);
      return this._getLocalState();
    }
  },
  
  /**
   * Get current state from local store
   * @private
   * @returns {Object} Current local state
   */
  _getLocalState() {
    return {
      tabs: this._store.tabs,
      windows: this._store.windows,
      tabHistory: this._store.tabHistory,
      tabRelationships: this._store.tabRelationships,
      tabActivityLog: this._store.tabActivityLog // Added for dwell time and activity
    };
  },
  
  /**
   * Subscribe to state changes
   * 
   * @param {Function} callback - Function to call when state changes
   * @returns {Function} Unsubscribe function
   */
  subscribe(callback) {
    const listener = (message) => {
      // Map Chrome message events to actions
      if (message.action === 'tabUpdated') {
        this._dispatch({
          type: ActionTypes.TAB_UPDATED,
          payload: message.data
        });
      } else if (message.action === 'tabCreated') {
        this._dispatch({
          type: ActionTypes.TAB_CREATED,
          payload: message.data
        });
      } else if (message.action === 'tabRemoved') {
        this._dispatch({
          type: ActionTypes.TAB_REMOVED,
          payload: message.data
        });
      } else if (message.action === 'windowUpdated') {
        this._dispatch({
          type: ActionTypes.WINDOW_UPDATED,
          payload: message.data
        });
      }
      
      // Forward original message to maintain backward compatibility
      callback(message);
    };
    
    chrome.runtime.onMessage.addListener(listener);
    this._listeners.push(callback);
    
    // Return unsubscribe function
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      this._listeners = this._listeners.filter(cb => cb !== callback);
    };
  },
  
  /**
   * Add middleware to process actions
   * 
   * @param {Function} middleware - Middleware function
   * @returns {Function} Function to remove middleware
   */
  addMiddleware(middleware) {
    this._middleware.push(middleware);
    return () => {
      this._middleware = this._middleware.filter(m => m !== middleware);
    };
  },
  
  /**
   * Dispatch an action to update state
   * Public method for components to trigger state changes
   * 
   * @param {Object} action - Redux-style action object
   * @param {string} action.type - Action type constant
   * @param {*} action.payload - Action payload data
   */
  dispatch(action) {
    this._dispatch(action);
  },
  
  /**
   * Internal dispatch implementation with middleware support
   * 
   * @private
   * @param {Object} action - Action object
   */
  _dispatch(action) {
    console.log('Action dispatched:', action);
    
    // Run action through middleware
    let processedAction = action;
    for (const middleware of this._middleware) {
      processedAction = middleware(processedAction, this._store);
      // Middleware can cancel action by returning null/undefined
      if (!processedAction) return;
    }
    
    // Apply action using reducer
    const newState = this._reducer(this._store, processedAction);
    
    // Update store with new state
    this._store = newState;
    
    // Notify listeners about state change
    const changeType = action.type;
    this._notifyListeners(changeType, action.payload);
  },
  
  /**
   * Notify all listeners of state change
   * 
   * @private
   * @param {string} changeType - Type of change
   * @param {*} data - Change data
   */
  _notifyListeners(changeType, data) {
    this._listeners.forEach(listener => {
      try {
        listener({
          action: this._mapActionTypeToLegacyAction(changeType),
          data: data
        });
      } catch (error) {
        console.error('Error in state listener:', error);
      }
    });
  },
  
  /**
   * Map Redux action types to legacy action names
   * 
   * @private
   * @param {string} actionType - Redux action type
   * @returns {string} Legacy action name
   */
  _mapActionTypeToLegacyAction(actionType) {
    const mapping = {
      [ActionTypes.TAB_CREATED]: 'tabCreated',
      [ActionTypes.TAB_UPDATED]: 'tabUpdated',
      [ActionTypes.TAB_REMOVED]: 'tabRemoved',
      [ActionTypes.WINDOW_UPDATED]: 'windowUpdated',
      // Add more mappings as needed
    };
    return mapping[actionType] || 'stateChanged';
  },
  
  /**
   * Root reducer function to handle all actions
   * 
   * @private
   * @param {Object} state - Current state
   * @param {Object} action - Action object
   * @returns {Object} New state
   */
  _reducer(state, action) {
    switch (action.type) {
      case ActionTypes.TAB_CREATED:
        return this._reducers.tabCreated(state, action.payload);
        
      case ActionTypes.TAB_UPDATED:
        return this._reducers.tabUpdated(state, action.payload);
        
      case ActionTypes.TAB_REMOVED:
        return this._reducers.tabRemoved(state, action.payload);
        
      case ActionTypes.WINDOW_UPDATED:
        return this._reducers.windowUpdated(state, action.payload);
        
      case ActionTypes.UI_SELECT_TAB:
        return this._reducers.uiSelectTab(state, action.payload);
        
      case ActionTypes.UI_CHANGE_VIEW:
        return this._reducers.uiChangeView(state, action.payload);
        
      case ActionTypes.SUMMARY_STORED:
        return this._reducers.summaryStored(state, action.payload);
        
      case ActionTypes.NODE_POSITION_UPDATED:
        return this._reducers.nodePositionUpdated(state, action.payload);
        
      case ActionTypes.BATCH_STATE_UPDATE:
        return this._reducers.batchStateUpdate(state, action.payload);
        
      default:
        return state;
    }
  },
  
  /**
   * Individual reducer functions for each action type
   * @private
   */
  _reducers: {
    /**
     * Handle tab created action
     * @param {Object} state - Current state
     * @param {Object} payload - Tab data
     * @returns {Object} New state
     */
    tabCreated(state, payload) {
      const { tabId, tab } = payload;
      const newTabs = new Map(state.tabs);
      newTabs.set(tabId, { ...tab });
      
      return {
        ...state,
        tabs: newTabs
      };
    },
    
    /**
     * Handle tab updated action
     * @param {Object} state - Current state
     * @param {Object} payload - Update data
     * @returns {Object} New state
     */
    tabUpdated(state, payload) {
      const { tabId, changes } = payload;
      const newTabs = new Map(state.tabs);
      
      const existingTab = newTabs.get(tabId) || {};
      newTabs.set(tabId, { 
        ...existingTab, 
        ...changes,
        lastUpdate: Date.now()
      });
      
      return {
        ...state,
        tabs: newTabs
      };
    },
    
    /**
     * Handle tab removed action
     * @param {Object} state - Current state
     * @param {Object} payload - Tab ID
     * @returns {Object} New state
     */
    tabRemoved(state, payload) {
      const { tabId } = payload;
      const newTabs = new Map(state.tabs);
      newTabs.delete(tabId);
      
      return {
        ...state,
        tabs: newTabs
      };
    },
    
    /**
     * Handle window updated action
     * @param {Object} state - Current state
     * @param {Object} payload - Window data
     * @returns {Object} New state
     */
    windowUpdated(state, payload) {
      const { windowId, window } = payload;
      const newWindows = new Map(state.windows);
      
      if (window) {
        newWindows.set(windowId, window);
      } else {
        // If no window data, it might be a removal
        newWindows.delete(windowId);
      }
      
      return {
        ...state,
        windows: newWindows
      };
    },
    
    /**
     * Handle UI tab selection
     * @param {Object} state - Current state
     * @param {Object} payload - Selected tab ID
     * @returns {Object} New state
     */
    uiSelectTab(state, payload) {
      return {
        ...state,
        ui: {
          ...state.ui,
          selectedTab: payload
        }
      };
    },
    
    /**
     * Handle UI view change
     * @param {Object} state - Current state
     * @param {Object} payload - New view name
     * @returns {Object} New state
     */
    uiChangeView(state, payload) {
      return {
        ...state,
        ui: {
          ...state.ui,
          currentView: payload
        }
      };
    },
    
    /**
     * Handle summary storage or clearing
     * @param {Object} state - Current state
     * @param {Object} payload - Summary data or clear flag
     * @returns {Object} New state
     */
    summaryStored(state, payload) {
      // Handle clear operation
      if (payload.clear) {
        console.log('Clearing all summaries from state');
        return {
          ...state,
          graphData: {
            ...state.graphData,
            summaries: {},
            lastUpdated: Date.now()
          }
        };
      }
      
      // Handle normal summary storage
      const { url, summary } = payload;
      return {
        ...state,
        graphData: {
          ...state.graphData,
          summaries: {
            ...state.graphData.summaries,
            [url]: summary
          },
          lastUpdated: Date.now()
        }
      };
    },
    
    /**
     * Handle node position update
     * @param {Object} state - Current state
     * @param {Object} payload - Node position data
     * @returns {Object} New state
     */
    nodePositionUpdated(state, { nodes }) {
      const nodePositions = { ...state.graphData.nodePositions };
      
      nodes.forEach(node => {
        if (node.id && (node.x !== undefined && node.y !== undefined)) {
          nodePositions[node.id] = {
            x: node.x,
            y: node.y,
            fixed: node.fixed || false
          };
        }
      });
      
      return {
        ...state,
        graphData: {
          ...state.graphData,
          nodePositions,
          lastUpdated: Date.now()
        }
      };
    },
    
    /**
     * Handle batch state update (e.g. from background script)
     * @param {Object} state - Current state
     * @param {Object} payload - Full state data
     * @returns {Object} New state
     */
    batchStateUpdate(state, payload) {
      // Convert Maps if they come as arrays of entries
      const tabs = payload.tabs instanceof Map 
        ? payload.tabs 
        : new Map(payload.tabs || []);
        
      const windows = payload.windows instanceof Map 
        ? payload.windows 
        : new Map(payload.windows || []);
        
      const tabHistory = payload.tabHistory instanceof Map 
        ? payload.tabHistory 
        : new Map(payload.tabHistory || []);
        
      const tabRelationships = payload.tabRelationships instanceof Map 
        ? payload.tabRelationships 
        : new Map(payload.tabRelationships || []);
        
      const tabActivityLog = payload.tabActivityLog instanceof Map 
        ? payload.tabActivityLog 
        : new Map(payload.tabActivityLog || []);
      
      return {
        ...state,
        tabs,
        windows,
        tabHistory,
        tabRelationships,
        tabActivityLog,
        // Ensure other parts of the state are also updated if present in payload
        ui: payload.ui ? { ...state.ui, ...payload.ui } : state.ui,
        graphData: payload.graphData ? { ...state.graphData, ...payload.graphData } : state.graphData,
        cache: payload.cache ? { ...state.cache, ...payload.cache } : state.cache,
        lastUpdated: Date.now()
      };
    }
  },
  
  // --- Maintain existing API methods ---
  
  /**
   * Get data formatted for treemap visualization
   * @async
   * @returns {Promise<Object>} Formatted treemap data
   */
  async getTreemapData() {
    const stateSnapshot = await this.getState();
    return this.formatDataForTreemap(stateSnapshot);
  },
  
  /**
   * Format data for treemap
   * @param {Object} stateSnapshot - State data
   * @returns {Object} Formatted treemap data
   */
  formatDataForTreemap(stateSnapshot) {
    // Keep existing implementation...
    const windows = Array.isArray(stateSnapshot.windows) 
      ? stateSnapshot.windows.map(w => w[1])
      : Array.from(stateSnapshot.windows?.values() || []);
    
    const tabs = stateSnapshot.tabs instanceof Map 
      ? stateSnapshot.tabs 
      : new Map(stateSnapshot.tabs || []);
    
    return {
      name: 'root',
      children: windows.map(window => ({
        name: `Window ${window.id}`,
        id: window.id,
        children: (window.tabs || []).map(tabId => {
          const tab = tabs.get(tabId) || { id: tabId };
          return {
            id: `tab${tabId}`,
            windowId: window.id,
            title: tab.title || 'Untitled',
            url: tab.url || '',
            favIconUrl: tab.favIconUrl,
            lastAccessed: tab.lastAccessed,
            active: tab.active,
            children: []
          };
        })
      }))
    };
  },
  
  /**
   * Store graph data
   * @async
   * @param {Object} graphData - Graph data to store
   */
  async storeGraphData(graphData) {
    // Dispatch through Redux flow instead of direct storage
    this.dispatch({
      type: ActionTypes.BATCH_STATE_UPDATE,
      payload: {
        graphData: {
          summaries: graphData.summaries || {},
          customEdges: graphData.customEdges || [],
          nodePositions: graphData.nodePositions || {},
          lastUpdated: Date.now()
        }
      }
    });
    
    // Also persist to storage
    return chrome.storage.local.set({ 
      'graphPersistentData': {
        summaries: graphData.summaries || {},
        customEdges: graphData.customEdges || [],
        nodePositions: graphData.nodePositions || {},
        lastUpdated: Date.now()
      }
    });
  },
  
  /**
   * Get graph data
   * @async
   * @returns {Promise<Object>} Graph data
   */
  async getGraphData() {
    // First check local store
    if (this._store.graphData.lastUpdated) {
      return this._store.graphData;
    }
    
    // Otherwise fetch from storage
    return new Promise((resolve) => {
      chrome.storage.local.get('graphPersistentData', (result) => {
        const data = result.graphPersistentData || {
          summaries: {},
          customEdges: [],
          nodePositions: {},
          lastUpdated: null
        };
        
        // Update store with fetched data
        this.dispatch({
          type: ActionTypes.BATCH_STATE_UPDATE,
          payload: { graphData: data }
        });
        
        resolve(data);
      });
    });
  },
  
  /**
   * Store URL summary
   * @async
   * @param {string} url - URL to store summary for
   * @param {string} summary - Summary text
   */
  async storeSummary(url, summary) {
    // Dispatch through Redux flow
    this.dispatch({
      type: ActionTypes.SUMMARY_STORED,
      payload: { url, summary }
    });
  },
  
  /**
   * Clear all stored summaries from state
   * This allows for cache refreshing when summaries need to be regenerated
   * @async
   */
  async clearSummaries() {
    // Dispatch through Redux flow
    this.dispatch({
      type: ActionTypes.SUMMARY_STORED,
      payload: { clear: true }
    });
    
    // Then update persistent storage
    const graphData = await this.getGraphData();
    graphData.summaries = {}; // Clear all summaries
    return this.storeGraphData(graphData);
  },
  
  /**
   * Get URL summary
   * @async
   * @param {string} url - URL to get summary for
   * @returns {Promise<string|null>} Summary text or null
   */
  async getSummary(url) {
    // Check local store first for better performance
    if (this._store.graphData.summaries[url]) {
      return this._store.graphData.summaries[url];
    }
    
    const graphData = await this.getGraphData();
    return graphData.summaries[url] || null;
  },
  
  /**
   * Store custom edge
   * @async
   * @param {Object} edge - Edge data
   */
  async storeCustomEdge(edge) {
    // Original implementation
    const graphData = await this.getGraphData();
    
    // Check if edge already exists (in either direction)
    const existingEdgeIndex = graphData.customEdges.findIndex(
      e => (e.source === edge.source && e.target === edge.target) || 
           (e.source === edge.target && e.target === edge.source)
    );
    
    if (existingEdgeIndex >= 0) {
      graphData.customEdges[existingEdgeIndex] = edge;
    } else {
      graphData.customEdges.push(edge);
    }
    
    return this.storeGraphData(graphData);
  },
  
  /**
   * Store node positions
   * @async
   * @param {Array<Object>} nodes - Node position data
   */
  async storeNodePositions(nodes) {
    // Dispatch through Redux flow
    this.dispatch({
      type: ActionTypes.NODE_POSITION_UPDATED,
      payload: { nodes }
    });
    
    // Also update persistent storage
    const graphData = await this.getGraphData();
    const nodePositions = {};
    
    nodes.forEach(node => {
      if (node.id && (node.x !== undefined && node.y !== undefined)) {
        nodePositions[node.id] = {
          x: node.x,
          y: node.y,
          fixed: node.fixed || false
        };
      }
    });
    
    graphData.nodePositions = nodePositions;
    return this.storeGraphData(graphData);
  },
  
  /**
   * Favicon cache
   */
  faviconCache: new Map(),
  
  /**
   * Get favicon with cache
   * @async
   * @param {string} url - URL to get favicon for
   * @returns {Promise<string|null>} Favicon URL
   */
  async getFaviconWithCache(url) {
    // Keep existing implementation...
    const domain = this._getDomainFromUrl(url);
    if (this.faviconCache.has(domain)) {
      return this.faviconCache.get(domain);
    }
    
    try {
      const fetchPromise = new Promise(async (resolve) => {
        chrome.runtime.sendMessage(
          { type: 'getFavicon', url, size: 16 },
          response => {
            if (response && response.faviconUrl) {
              this.faviconCache.set(domain, response.faviconUrl);
              resolve(response.faviconUrl);
            } else {
              const directUrl = `https://${domain}/favicon.ico`;
              this.faviconCache.set(domain, directUrl);
              resolve(directUrl);
            }
          }
        );
      });
      
      this.faviconCache.set(domain, fetchPromise);
      return fetchPromise;
    } catch (error) {
      console.warn('Error fetching favicon:', error);
      return null;
    }
  },
  
  /**
   * Extract domain from URL
   * @param {string} url - URL string
   * @returns {string} Domain
   */
  _getDomainFromUrl(url) {
    try {
      if (!url || typeof url !== 'string') return 'unknown';
      if (!url.includes('://')) url = 'https://' + url;
      return new URL(url).hostname || 'unknown';
    } catch (e) {
      return 'unknown';
    }
  },

  async getPageActivityAndReferrals(pageInfoArray) {
    // Ensure the local store (_store) is up-to-date with the latest from background.js
    await this.getState();

    const enrichedPages = pageInfoArray.map(page => {
      let visitTabId = null;
      let navigationEntry = null;
      let nextNavigationEntry = null;

      // Find the tabId and specific navigation entry for this page visit
      // by searching through all tab histories.
      // Assumes page.visitTimestamp is reasonably accurate.
      if (this._store.tabHistory && this._store.tabHistory.size > 0) {
        for (const [tabId, historyArray] of this._store.tabHistory.entries()) {
          // tabHistory entries are typically newest first (unshifted)
          const entryIndex = historyArray.findIndex(
            (nav) => nav.url === page.url && 
                     Math.abs(nav.timestamp - page.visitTimestamp) < 2000 // Allow 2s delta for timestamp match
          );

          if (entryIndex !== -1) {
            visitTabId = tabId;
            navigationEntry = historyArray[entryIndex];
            // The chronologically next navigation is at the previous index (if it exists)
            if (entryIndex > 0) { 
              nextNavigationEntry = historyArray[entryIndex - 1];
            }
            break; // Found the relevant navigation history for this page
          }
        }
      }

      let dwellTimeMs = null;
      if (navigationEntry && nextNavigationEntry) {
        const duration = nextNavigationEntry.timestamp - navigationEntry.timestamp;
        if (duration > 0) {
          dwellTimeMs = duration;
        }
      } else if (navigationEntry) {
        // This page was the last recorded in its tab's history or tab still open.
        // Dwell time calculation here is less certain without tab closure/session end times.
        // For now, we'll leave it null. sessions.js might refine this later.
      }

      let referral = null;
      if (visitTabId && this._store.tabRelationships && this._store.tabRelationships.has(visitTabId)) {
        const relationship = this._store.tabRelationships.get(visitTabId);
        // This relationship describes how the 'visitTabId' itself was opened.
        if (relationship && relationship.referringTabId) {
          referral = {
            type: 'tabOpen', // Indicates this referral is about how the tab was initiated
            sourceTabId: relationship.referringTabId,
            sourceUrl: relationship.referringURL,
            linkText: relationship.linkText || null,
            timestamp: relationship.timestamp
          };
        }
      }
      // Note: For intra-tab navigations (link clicks not opening new tabs),
      // specific link text might not be available via tabRelationships.
      // The transitionType on the navigationEntry itself (e.g., 'link') can indicate this.

      return {
        ...page, // Keep original page info (pageId, url, visitTimestamp)
        originalTabId: visitTabId, // The tabId in which this specific page visit occurred
        dwellTimeMs,
        referral,
      };
    });

    return enrichedPages;
  },
  
  /**
   * Track when a tab receives focus
   * @param {number} tabId - The ID of the tab that received focus
   * @returns {void}
   */
  trackTabFocus(tabId) {
    if (!tabId) return;
    
    // Make sure tabActivityLog exists
    if (!this._store.tabActivityLog) {
      this._store.tabActivityLog = new Map();
    }
    
    // Initialize tab entry if needed
    if (!this._store.tabActivityLog.has(tabId)) {
      this._store.tabActivityLog.set(tabId, []);
    }
    
    // Add a focus event
    const focusEvent = {
      timestamp: Date.now(),
      type: 'focus'
    };
    
    this._store.tabActivityLog.get(tabId).push(focusEvent);
    
    // For debugging
    console.log(`Tab ${tabId} focus event recorded at ${new Date().toISOString()}`);
    
    // Persist to background script
    chrome.runtime.sendMessage({ 
      action: 'updateTabActivity', 
      tabId, 
      event: focusEvent 
    });
  },
  
  /**
   * Check if a tab was active during a session
   * @param {number} tabId - The ID of the tab to check
   * @param {number} sessionStartTime - Session start timestamp
   * @param {number} sessionEndTime - Session end timestamp
   * @returns {boolean} - Whether the tab was active during the session
   */
  wasTabActiveInSession(tabId, sessionStartTime, sessionEndTime) {
    if (!tabId) return false;
    
    // Check if tab was created during the session
    const tab = this._store.tabs.get(tabId);
    if (tab && tab.creationTime && tab.creationTime >= sessionStartTime && tab.creationTime <= sessionEndTime) {
      return true;
    }
    
    // Check for focus events during the session
    const activityLog = this._store.tabActivityLog.get(tabId) || [];
    return activityLog.some(event => 
      event.type === 'focus' && 
      event.timestamp >= sessionStartTime && 
      event.timestamp <= sessionEndTime
    );
  },
  
  /**
   * Action creators for common operations
   * Convenience methods for components to dispatch standard actions
   */
  actions: {
    /**
     * Select a tab in the UI
     * @param {number} tabId - Tab ID to select
     */
    selectTab(tabId) {
      browserState.dispatch({
        type: ActionTypes.UI_SELECT_TAB,
        payload: tabId
      });
      
      // Also track this as a focus event
      browserState.trackTabFocus(tabId);
    },
    
    /**
     * Change current visualization view
     * @param {string} viewName - View name ('treemap', 'graph', etc.)
     */
    changeView(viewName) {
      browserState.dispatch({
        type: ActionTypes.UI_CHANGE_VIEW,
        payload: viewName
      });
    }
  }
};

// Initialize state from storage at startup
(async function initializeState() {
  try {
    // Load persisted graph data
    const graphData = await new Promise((resolve) => {
      chrome.storage.local.get('graphPersistentData', (result) => {
        resolve(result.graphPersistentData || {
          summaries: {},
          customEdges: [],
          nodePositions: {},
          lastUpdated: null
        });
      });
    });
    
    // Initialize with stored graph data
    browserState._store.graphData = graphData;
  } catch (error) {
    console.error('Error initializing state:', error);
  }
})();