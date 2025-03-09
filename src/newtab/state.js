/**
 * State Management Module for Tabtopia
 * 
 * This module provides a facade for accessing and manipulating browser state data,
 * handling communication with the background script, and formatting data for
 * different visualization types. It implements a pub/sub pattern for real-time
 * updates to UI components when browser state changes.
 * 
 * Architecture:
 * - Communication Layer: Chrome messaging API interface
 * - Data Transformation: Converts raw browser state to visualization-friendly formats
 * - State Persistence: Manages local storage for persistent graph data
 * - Cache Management: Implements memory caching for performance-critical resources
 * 
 * @module state
 */

/**
 * Central browser state interface providing reactive access to Chrome's state
 * @namespace browserState
 */
export const browserState = {
  /**
   * Retrieves a complete snapshot of the current browser state
   * 
   * Communicates with the background service worker to get the current state
   * of all windows, tabs, and their relationships. This serves as the source
   * of truth for visualizations.
   * 
   * @async
   * @returns {Promise<Object>} Current browser state with windows, tabs, and relationships
   * @property {Map<number, Object>} windows - Map of window objects by ID
   * @property {Map<number, Object>} tabs - Map of tab objects by ID
   * @property {Map<number, Array>} tabHistory - Navigation history by tab ID
   * @property {Map<number, Object>} tabRelationships - Tab relationships by ID
   */
  async getState() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'getState' }, (response) => {
        resolve(response);
      });
    });
  },
  
  /**
   * Subscribes to browser state changes with automatic event filtering
   * 
   * Sets up a listener for relevant Chrome events and calls the provided callback
   * when state changes occur. Only passes events that affect the visualization.
   * Returns an unsubscribe function to prevent memory leaks.
   * 
   * @param {Function} callback - Function to call when state changes
   * @param {Object} callback.message - Message object with action and associated data
   * @param {string} callback.message.action - Type of state change (tabUpdated, tabCreated, etc.)
   * @param {Object} callback.message.data - Relevant data for the state change
   * @returns {Function} Unsubscribe function to remove the listener
   */
  subscribe(callback) {
    const listener = (message) => {
      if (message.action === 'tabUpdated' || 
          message.action === 'tabCreated' || 
          message.action === 'tabRemoved' ||
          message.action === 'windowUpdated') {
        callback(message);
      }
    };
    
    chrome.runtime.onMessage.addListener(listener);
    
    // Return unsubscribe function
    return () => chrome.runtime.onMessage.removeListener(listener);
  },
  
  /**
   * Retrieves and formats data specifically for treemap visualization
   * 
   * Gets current state and transforms it into the hierarchical structure
   * required by the D3 treemap visualization. Handles data normalization
   * and ensures consistent structure regardless of background data format.
   * 
   * @async
   * @returns {Promise<Object>} Hierarchical data structure ready for D3 treemap
   * @property {string} name - Root node name
   * @property {Array<Object>} children - Window nodes with their tab children
   */
  async getTreemapData() {
    const stateSnapshot = await this.getState();
    return this.formatDataForTreemap(stateSnapshot);
  },
  
  /**
   * Transforms raw browser state into treemap-compatible hierarchical format
   * 
   * Converts Maps to arrays and structures data as a nested hierarchy with
   * windows as parent nodes and tabs as children. Handles potential inconsistencies
   * in data format between in-memory and serialized states.
   * 
   * @param {Object} stateSnapshot - Browser state object from getState()
   * @returns {Object} Hierarchical data structure for treemap visualization
   * @property {string} name - Root node name
   * @property {Array<Object>} children - Window nodes containing tab nodes
   */
  formatDataForTreemap(stateSnapshot) {
    // Convert windows map to array if needed
    const windows = Array.isArray(stateSnapshot.windows) 
      ? stateSnapshot.windows.map(w => w[1]) // If array of entries [id, window]
      : Array.from(stateSnapshot.windows?.values() || []);
    
    // Convert tabs map to array if needed
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
   * Persists graph visualization data to local storage
   * 
   * Stores custom relationships, node positions, and content summaries
   * so they persist between browser sessions. Updates timestamp to track
   * when data was last modified.
   * 
   * @async
   * @param {Object} graphData - Graph visualization data to store
   * @param {Object} [graphData.summaries={}] - URL to summary text mapping
   * @param {Array} [graphData.customEdges=[]] - Custom relationship edges
   * @param {Object} [graphData.nodePositions={}] - Saved node position coordinates
   * @returns {Promise<void>} Promise that resolves when storage is complete
   */
  async storeGraphData(graphData) {
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
   * Retrieves stored graph data from local storage
   * 
   * Gets persistent graph data including custom relationships,
   * node positions, and content summaries. Returns empty defaults
   * if no stored data exists.
   * 
   * @async
   * @returns {Promise<Object>} Stored graph data or default empty structure
   * @property {Object} summaries - URL to summary text mapping
   * @property {Array} customEdges - Custom relationship edges between nodes
   * @property {Object} nodePositions - Saved position coordinates by node ID
   * @property {number|null} lastUpdated - Timestamp of last data modification
   */
  async getGraphData() {
    return new Promise((resolve) => {
      chrome.storage.local.get('graphPersistentData', (result) => {
        resolve(result.graphPersistentData || {
          summaries: {},
          customEdges: [],
          nodePositions: {},
          lastUpdated: null
        });
      });
    });
  },

  /**
   * Stores a generated summary for a URL
   * 
   * Persists AI-generated or user-provided content summaries for URLs
   * to improve graph node readability and context.
   * 
   * @async
   * @param {string} url - The URL to store a summary for
   * @param {string} summary - The summary text to store
   * @returns {Promise<void>} Promise that resolves when storage is complete
   */
  async storeSummary(url, summary) {
    const graphData = await this.getGraphData();
    graphData.summaries[url] = summary;
    return this.storeGraphData(graphData);
  },

  /**
   * Retrieves a stored summary for a URL if available
   * 
   * @async
   * @param {string} url - The URL to get a summary for
   * @returns {Promise<string|null>} The summary text or null if not available
   */
  async getSummary(url) {
    const graphData = await this.getGraphData();
    return graphData.summaries[url] || null;
  },

  /**
   * Stores or updates a custom relationship edge between nodes
   * 
   * Creates or updates a user-defined relationship between graph nodes.
   * Checks for existing edges to prevent duplicates and handles bidirectional
   * relationships automatically.
   * 
   * @async
   * @param {Object} edge - Edge definition object
   * @param {string} edge.source - Source node identifier
   * @param {string} edge.target - Target node identifier
   * @param {string} edge.type - Relationship type (semantic, temporal, etc.)
   * @param {number} [edge.strength=1] - Relationship strength (0-1)
   * @returns {Promise<void>} Promise that resolves when storage is complete
   */
  async storeCustomEdge(edge) {
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
   * Persists node positions from graph visualization
   * 
   * Saves node coordinates to maintain visual consistency between sessions
   * and preserve user-arranged graph layouts.
   * 
   * @async
   * @param {Array<Object>} nodes - Array of node objects with positions
   * @param {string} nodes[].id - Node identifier
   * @param {number} nodes[].x - X-coordinate position
   * @param {number} nodes[].y - Y-coordinate position
   * @param {boolean} [nodes[].fixed=false] - Whether position is pinned
   * @returns {Promise<void>} Promise that resolves when storage is complete
   */
  async storeNodePositions(nodes) {
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
   * In-memory cache for favicons to improve performance
   * 
   * Maps domains to favicon URLs or promises representing
   * pending favicon requests.
   * 
   * @type {Map<string, string|Promise<string>>}
   */
  faviconCache: new Map(),

  /**
   * Retrieves favicon URL with memory caching
   * 
   * First checks the in-memory cache, then requests favicon from
   * the background script if needed. Handles parallel requests efficiently
   * by caching promises for in-flight requests.
   * 
   * @async
   * @param {string} url - The URL to get favicon for
   * @returns {Promise<string|null>} Promise resolving to favicon URL or null on failure
   */
  async getFaviconWithCache(url) {
    // Try cache first
    const domain = this._getDomainFromUrl(url);
    if (this.faviconCache.has(domain)) {
      return this.faviconCache.get(domain);
    }
    
    // If not in cache, fetch and store
    try {
      // Asynchronously fetch icon in background
      const fetchPromise = new Promise(async (resolve) => {
        // Send message to background script to get favicon
        chrome.runtime.sendMessage(
          { type: 'getFavicon', url, size: 16 },
          response => {
            if (response && response.faviconUrl) {
              this.faviconCache.set(domain, response.faviconUrl);
              resolve(response.faviconUrl);
            } else {
              // Try direct domain favicon
              const directUrl = `https://${domain}/favicon.ico`;
              this.faviconCache.set(domain, directUrl);
              resolve(directUrl);
            }
          }
        );
      });
      
      // Store promise in cache to handle parallel requests
      this.faviconCache.set(domain, fetchPromise);
      return fetchPromise;
    } catch (error) {
      console.warn('Error fetching favicon:', error);
      return null;
    }
  },

  /**
   * Extract domain from a URL string
   * 
   * Safely parses URLs and extracts hostname, handling edge cases
   * like missing protocols and invalid URLs.
   * 
   * @private
   * @param {string} url - URL to extract domain from
   * @returns {string} Domain name or 'unknown' if parsing fails
   */
  _getDomainFromUrl(url) {
    try {
      if (!url || typeof url !== 'string') return 'unknown';
      if (!url.includes('://')) url = 'https://' + url;
      return new URL(url).hostname || 'unknown';
    } catch (e) {
      return 'unknown';
    }
  }
};