/**
 * Provides access to browser state for visualizations
 */
export const browserState = {
  /**
   * Get current browser state snapshot
   * @returns {Promise} Promise resolving to state snapshot
   */
  async getState() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'getState' }, (response) => {
        resolve(response);
      });
    });
  },
  
  /**
   * Subscribe to state changes
   * @param {Function} callback Function to call when state changes
   * @returns {Function} Unsubscribe function
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
   * Get a prepared data structure for treemap
   * @returns {Promise} Promise resolving to treemap-ready data
   */
  async getTreemapData() {
    const stateSnapshot = await this.getState();
    return this.formatDataForTreemap(stateSnapshot);
  },
  
  /**
   * Format state data for treemap visualization
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
  }
};