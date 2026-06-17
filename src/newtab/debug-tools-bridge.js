/**
 * Debug Tools Bridge for ES Modules
 * This module provides access to tabtopiaDebug functions for ES modules
 * and exposes them to the global scope for console debugging
 */

// Create a promise-based interface to the debug tools
let debugTools = null;
let debugToolsPromise = new Promise(resolve => {
  // If debug tools are already available, resolve immediately
  if (window.tabtopiaDebug) {
    debugTools = window.tabtopiaDebug;
    resolve(window.tabtopiaDebug);
  }
  
  // Otherwise listen for the tabtopiaDebugReady event
  document.addEventListener('tabtopiaDebugReady', (event) => {
    debugTools = event.detail;
    resolve(event.detail);
  }, { once: true });
  
  // Add timeout to avoid hanging forever
  setTimeout(() => {
    if (!debugTools) {
      console.warn('Debug tools not available within timeout period');
      resolve(null);
    }
  }, 2000);
});

// Expose debug functions to global scope for console access
debugToolsPromise.then(tools => {
  if (tools) {
    // Create global namespace for debug functions
    window.tabtopiaConsoleDebug = {
      viewStoredHeroImages: () => tools.viewStoredHeroImages(),
      forceExtractHeroImages: () => tools.forceExtractHeroImages(),
      clearAllHeroImages: () => tools.clearAllHeroImages()
    };
    
    console.log('%c🛠️ Hero Image Debug Tools Ready', 'color: green; font-weight: bold');
    console.log('%cAvailable commands:', 'font-weight: bold');
    console.log('%c- tabtopiaConsoleDebug.forceExtractHeroImages()', 'color: blue');
    console.log('%c- tabtopiaConsoleDebug.viewStoredHeroImages()', 'color: blue');
    console.log('%c- tabtopiaConsoleDebug.clearAllHeroImages()', 'color: blue');
  }
});

// Export functions that mirror the debug tools API
export async function viewStoredHeroImages() {
  const tools = await debugToolsPromise;
  return tools ? tools.viewStoredHeroImages() : null;
}

/**
 * Force the extraction of hero images for the current tab
 * Logs detailed information about the extraction process
 * @param {boolean} debug - Whether to show detailed debug info
 * @returns {Promise<Object>} - Information about the extraction
 */
export async function forceExtractHeroImages(debug = true) {
  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    return { success: false, error: 'No active tab found' };
  }
  
  console.log(`📸 Forcing hero image extraction for: ${tab.url}`);
  
  // Send message to content script to extract images
  try {
    // If debug mode, inject a script that logs all steps of the extraction process
    if (debug) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // Temporary override for debugging
          window.__heroImageDebug = true;
          console.log('🔍 Hero image debug mode activated');
        }
      });
    }
    
    const response = await chrome.tabs.sendMessage(tab.id, { 
      action: 'forceExtractHeroImages',
      debug: debug 
    });
    
    // Log the results
    if (response && response.images) {
      console.log(`📸 Hero images found (${response.images.length}):`, response.images);
    }
    
    return { 
      success: true, 
      url: tab.url,
      response 
    };
  } catch (error) {
    console.error('Error forcing hero image extraction:', error);
    return { 
      success: false, 
      url: tab.url,
      error: error.toString() 
    };
  }
}

export async function clearAllHeroImages() {
  const tools = await debugToolsPromise;
  return tools ? tools.clearAllHeroImages() : null;
}

// Export the raw promise for advanced usage
export const debugToolsReady = debugToolsPromise;
