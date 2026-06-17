/**
 * Debug Tools for Tabtopia
 * Contains utilities to inspect application data
 */

// Create a self-executing function to avoid polluting the global scope
(function() {
  // Wait for DOM to be ready before initializing
  document.addEventListener('DOMContentLoaded', () => {
    console.log('📊 Tabtopia Debug Tools loading...');
    initDebugTools();
  });

  // Handle the case where DOM is already loaded
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    console.log('📊 Tabtopia Debug Tools loading (DOM already ready)...');
    setTimeout(() => initDebugTools(), 100); // Small delay to ensure browser is ready
  }

  /**
   * Initialize debug tools and attach them to window
   */
  function initDebugTools() {
    // Create global tabtopiaDebug object - attach to window for global access
    window.tabtopiaDebug = {
      viewStoredHeroImages,
      forceExtractHeroImages,
      clearAllHeroImages,
      injectContentScripts
    };
    
    // Create a custom event for modules to listen to
    const event = new CustomEvent('tabtopiaDebugReady', { detail: window.tabtopiaDebug });
    document.dispatchEvent(event);
    
    console.log('✅ Tabtopia Debug Tools loaded - access via window.tabtopiaDebug');
  }

  /**
   * View all hero images currently stored in chrome.storage
   * @returns {Promise<Object>} The hero images data
   */
  async function viewStoredHeroImages() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['heroImages'], (result) => {
        const heroImages = result.heroImages || {};
        console.group('📸 Stored Hero Images');
        console.log(`Found ${Object.keys(heroImages).length} URLs with hero images`);
        
        // Display image counts and timestamps
        Object.entries(heroImages).forEach(([url, data]) => {
          const date = new Date(data.timestamp);
          console.groupCollapsed(`${url} (${data.images?.length || 0} images) - ${date.toLocaleString()}`);
          console.log('Images:', data.images);
          console.log('Metrics:', data.metrics);
          console.groupEnd();
        });
        
        console.groupEnd();
        resolve(heroImages);
      });
    });
  }

  /**
   * Force trigger hero image extraction on the current page
   * regardless of dwell time or scroll depth
   * @returns {Promise<boolean>} Success status
   */
  async function forceExtractHeroImages() {
    return new Promise((resolve) => {
      // This will only work when run on a web page (not in the extension pages)
      if (!document.querySelector('img')) {
        console.warn('No images found on current page');
        resolve(false);
        return;
      }
      
      try {
        // Define temporary extraction function in page context
        const pageUrl = document.location.href;
        const pageTitle = document.title;
        
        // Find potential hero images
        const images = Array.from(document.querySelectorAll('img'))
          .filter(img => img.complete && img.naturalWidth > 100 && img.naturalHeight > 100)
          .map(img => ({
            src: img.src,
            width: img.naturalWidth,
            height: img.naturalHeight,
            score: 50,
            alt: img.alt || ''
          }))
          .slice(0, 5);
        
        if (images.length === 0) {
          console.warn('No suitable images found for extraction');
          resolve(false);
          return;
        }
        
        console.log('Forcing hero image extraction for:', pageUrl);
        console.log('Found', images.length, 'potential hero images');
        
        // Send to background script
        chrome.runtime.sendMessage({
          action: 'storeHeroImages',
          data: {
            url: pageUrl,
            title: pageTitle,
            timestamp: Date.now(),
            heroImages: images,
            scrollDepth: 1000,
            dwellTime: 60000
          }
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('Error sending hero images:', chrome.runtime.lastError);
            resolve(false);
          } else {
            console.log('Successfully sent hero images to background script');
            resolve(true);
          }
        });
      } catch (e) {
        console.error('Failed to force extract hero images:', e);
        resolve(false);
      }
    });
  }

  /**
   * Clear all stored hero images
   * @returns {Promise<boolean>} Success status
   */
  async function clearAllHeroImages() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ heroImages: {} }, () => {
        if (chrome.runtime.lastError) {
          console.error('Error clearing hero images:', chrome.runtime.lastError);
          resolve(false);
        } else {
          console.log('✅ All hero images cleared successfully');
          resolve(true);
        }
      });
    });
  }

  /**
   * Inject content scripts into the active tab to ensure hero-images.js is available
   * Useful for debugging when the automatic content script injection didn't work
   * @returns {Promise<Object>} Result of the injection
   */
  async function injectContentScripts() {
    try {
      // Get the active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        console.error('No active tab found');
        return { success: false, error: 'No active tab found' };
      }
      
      console.log(`Injecting content scripts into tab ${tab.id} (${tab.url})...`);
      
      // Try to inject our hero-images.js script
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content-scripts/hero-images.js']
      });
      
      console.log('✅ Content scripts injected successfully!');
      console.log('You can now run tabtopiaConsoleDebug.forceExtractHeroImages() to test');
      
      return { success: true };
    } catch (error) {
      console.error('Failed to inject content scripts:', error);
      return { success: false, error: error.toString() };
    }
  }
})();
