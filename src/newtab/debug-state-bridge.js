/**
 * Debug State Bridge for Tabtopia
 * Provides access to browserState from the newtab page to the debug UI
 */

// Create a mock browserState object that will communicate with the background script
window.browserState = {
  // Storage for cached data
  _cache: {
    lastFetch: 0,
    data: null
  },
  
  /**
   * Get the current browser state
   * @returns {Promise<Object>} The browser state
   */
  getState: async function() {
    try {
      console.log("Requesting browserState data from background script...");
      
      // Check cache first (only use cache for 5 seconds)
      const now = Date.now();
      if (this._cache.data && (now - this._cache.lastFetch < 5000)) {
        console.log("Using cached browserState data");
        return this._cache.data;
      }
      
      // Check if we're in a context where chrome.runtime is available
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
        console.warn("Chrome runtime not available, using mock data for debugging");
        return this.getMockState();
      }
      
      // Request fresh data from background
      return new Promise((resolve, reject) => {
        console.log("Sending getDebugState message to background script...");
        
        // Add timeout to prevent hanging
        const timeoutId = setTimeout(() => {
          console.warn("Timeout waiting for background script response, using mock data");
          resolve(this.getMockState());
        }, 5000); // 5 second timeout
        
        chrome.runtime.sendMessage({ 
          action: "getDebugState"
        }, response => {
          clearTimeout(timeoutId); // Clear timeout on response
          if (chrome.runtime.lastError) {
            console.error("Error getting browserState:", chrome.runtime.lastError);
            reject(chrome.runtime.lastError);
            return;
          }
          
          console.log("Received response from background:", response);
          console.log("Response type:", typeof response);
          console.log("Response keys:", response ? Object.keys(response) : "null/undefined");
          
          // Handle case where response is null/undefined
          if (!response) {
            console.error("No response received from background script");
            reject(new Error("No response from background script"));
            return;
          }
          
          // Log the full state structure to help debugging
          if (response.state) {
            console.log("State structure:", {
              "tabHistory type": Array.isArray(response.state.tabHistory) ? "array" : typeof response.state.tabHistory,
              "tabHistory length": Array.isArray(response.state.tabHistory) ? response.state.tabHistory.length : "n/a",
              "tabRelationships type": typeof response.state.tabRelationships,
              "tabActivityLog type": typeof response.state.tabActivityLog,
              "graphData type": typeof response.state.graphData,
              "tabs type": Array.isArray(response.state.tabs) ? "array" : typeof response.state.tabs,
              "tabs length": Array.isArray(response.state.tabs) ? response.state.tabs.length : "n/a"
            });
          } else {
            console.warn("No state property in response");
          }
          
          if (response.success && response.state) {
            console.log("✅ Successfully received browserState data:", response.state);
            console.log("Data keys available:", Object.keys(response.state));
            
            // Log specific data collections for debugging
            if (response.state.tabHistory) {
              console.log("tabHistory data is present:", 
                Array.isArray(response.state.tabHistory) ? `Array with ${response.state.tabHistory.length} entries` : 
                response.state.tabHistory instanceof Map ? `Map with ${response.state.tabHistory.size} entries` :
                `Unknown format: ${typeof response.state.tabHistory}`);
            } else {
              console.warn("❌ tabHistory data is missing");
            }
            
            if (response.state.tabRelationships) {
              console.log("tabRelationships data is present:", 
                Array.isArray(response.state.tabRelationships) ? `Array with ${response.state.tabRelationships.length} entries` : 
                response.state.tabRelationships instanceof Map ? `Map with ${response.state.tabRelationships.size} entries` :
                `Unknown format: ${typeof response.state.tabRelationships}`);
            } else {
              console.warn("❌ tabRelationships data is missing");
            }

            if (response.state.tabActivityLog) {
              console.log("tabActivityLog data is present:", 
                Array.isArray(response.state.tabActivityLog) ? `Array with ${response.state.tabActivityLog.length} entries` : 
                response.state.tabActivityLog instanceof Map ? `Map with ${response.state.tabActivityLog.size} entries` :
                `Unknown format: ${typeof response.state.tabActivityLog}`);
            } else {
              console.warn("❌ tabActivityLog data is missing");
            }

            if (response.state.graphData) {
              console.log("graphData is present:", response.state.graphData);
            } else {
              console.warn("❌ graphData is missing");
            }
            
            // Cache the data
            this._cache.data = response.state;
            this._cache.lastFetch = now;
            resolve(response.state);
          } else {
            console.error("Invalid response structure from background script", response);
            console.error("Response success:", response.success);
            console.error("Response has state:", !!response.state);
            reject(new Error("Invalid response from background script"));
          }
        });
      });
    } catch (error) {
      console.error("Failed to get browserState:", error);
      throw error;
    }
  },
  
  /**
   * Force refresh the state cache
   */
  refreshState: function() {
    console.log("🔄 Forcing browserState refresh...");
    this._cache = {
      data: null,
      lastFetch: 0
    };
    console.log("Cache cleared, requesting fresh data...");
    return this.getState();
  },
  
  /**
   * Debug function to log the current state structure
   */
  logStateStructure: async function() {
    try {
      const state = await this.getState();
      console.log("🔍 STATE STRUCTURE DEBUG:");
      console.table({
        "tabHistory": {
          type: Array.isArray(state.tabHistory) ? "array" : typeof state.tabHistory,
          count: Array.isArray(state.tabHistory) ? state.tabHistory.length : "unknown",
          sample: Array.isArray(state.tabHistory) && state.tabHistory.length > 0 ? JSON.stringify(state.tabHistory[0]).substring(0, 100) + "..." : "none"
        },
        "tabRelationships": {
          type: Array.isArray(state.tabRelationships) ? "array" : typeof state.tabRelationships,
          count: Array.isArray(state.tabRelationships) ? state.tabRelationships.length : "unknown",
          sample: Array.isArray(state.tabRelationships) && state.tabRelationships.length > 0 ? JSON.stringify(state.tabRelationships[0]).substring(0, 100) + "..." : "none"
        },
        "tabActivityLog": {
          type: Array.isArray(state.tabActivityLog) ? "array" : typeof state.tabActivityLog,
          count: Array.isArray(state.tabActivityLog) ? state.tabActivityLog.length : "unknown",
          sample: Array.isArray(state.tabActivityLog) && state.tabActivityLog.length > 0 ? JSON.stringify(state.tabActivityLog[0]).substring(0, 100) + "..." : "none"
        },
        "graphData": {
          type: typeof state.graphData,
          keys: state.graphData ? Object.keys(state.graphData).join(", ") : "none"
        },
        "tabs": {
          type: Array.isArray(state.tabs) ? "array" : typeof state.tabs,
          count: Array.isArray(state.tabs) ? state.tabs.length : "unknown"
        }
      });
      return state;
    } catch (error) {
      console.error("Error logging state structure:", error);
      return null;
    }
  },
  
  /**
   * Get mock state for debugging when background script is not available
   * @returns {Object} Mock state data
   */
  getMockState: function() {
    console.log("Returning mock state for debugging");
    return {
      tabs: [],
      windows: [],
      tabHistory: [],
      tabRelationships: [],
      tabActivityLog: [],
      graphData: {
        summaries: {},
        customEdges: [],
        nodePositions: {}
      }
    };
  }
};

// Create a global getState function that returns the current state
window.getDebugState = async function() {
  return window.browserState.getState();
};

// Signal that browserState is ready
console.log("✅ browserState bridge initialized and ready to use");

// Add a simple test function to verify extension communication
window.testExtensionCommunication = async function() {
  console.log("🧪 Testing extension communication...");
  
  try {
    // Test basic chrome.runtime availability
    if (typeof chrome === "undefined") {
      console.error("❌ Chrome API not available - This page must be opened within the Chrome extension context");
      console.error("💡 To fix this: Open the extension's newtab page and navigate to the debug tools from there");
      return false;
    }
    
    if (!chrome.runtime) {
      console.error("❌ Chrome runtime not available - This page must be opened within the Chrome extension context");
      console.error("💡 To fix this: Open the extension's newtab page and navigate to the debug tools from there");
      return false;
    }
    
    console.log("✅ Chrome runtime available");
    
    // Test sending a simple message
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: "ping" }, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
    
    console.log("✅ Background script responded:", response);
    return true;
    
  } catch (error) {
    console.error("❌ Communication test failed:", error);
    return false;
  }
};

// Test communication on page load
setTimeout(() => {
  window.testExtensionCommunication();
}, 2000);

document.dispatchEvent(new CustomEvent("browserStateReady"));
