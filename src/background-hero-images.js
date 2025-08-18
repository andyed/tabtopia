// Hero Image Extension for Background Script
// Handles storage and retrieval of hero images from pages

// Store for hero images keyed by URL
let heroImageStore = new Map();

// Listen for hero image data from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'storeHeroImages') {
    handleHeroImages(message.data, sender);
    sendResponse({ success: true });
    return true;
  }
});

/**
 * Process and store hero images from a page
 * @param {Object} data - Data containing hero images and page metadata
 * @param {Object} sender - Information about the sender
 */
function handleHeroImages(data, sender) {
  const { url, heroImages, dwellTime, scrollDepth } = data;
  
  if (!url || !heroImages || !heroImages.length) {
    console.log('Invalid hero image data received');
    return;
  }
  
  console.log(`Received ${heroImages.length} hero images for ${url}`);
  console.log(`Page metrics: ${dwellTime/1000}s dwell time, ${scrollDepth}px scroll depth`);
  
  // Only store if we have valid images
  if (heroImages.length > 0) {
    // Store in our Map
    heroImageStore.set(url, {
      timestamp: Date.now(),
      images: heroImages,
      metrics: {
        dwellTime,
        scrollDepth
      }
    });
    
    // Also store in chrome.storage for persistence
    chrome.storage.local.get(['heroImages'], (result) => {
      const existingImages = result.heroImages || {};
      
      // Add new images, overwrite if already exists
      existingImages[url] = {
        timestamp: Date.now(),
        images: heroImages.map(img => ({
          src: img.src,
          width: img.width,
          height: img.height,
          score: img.score
        })).slice(0, 5), // Store max 5 images
        metrics: {
          dwellTime,
          scrollDepth
        }
      };
      
      // Limit storage to prevent excessive size
      const urls = Object.keys(existingImages);
      if (urls.length > 500) {
        // Remove oldest entries if we have too many
        const sortedUrls = urls.sort((a, b) => 
          existingImages[a].timestamp - existingImages[b].timestamp);
        
        // Remove oldest 100 entries
        sortedUrls.slice(0, 100).forEach(oldUrl => {
          delete existingImages[oldUrl];
        });
      }
      
      chrome.storage.local.set({ heroImages: existingImages }, () => {
        if (chrome.runtime.lastError) {
          console.error('Error saving hero images:', chrome.runtime.lastError);
        } else {
          console.log(`Stored hero images for ${url}`);
        }
      });
    });
  }
}

/**
 * Get hero images for a URL
 * @param {string} url - URL to get hero images for
 * @returns {Promise<Array>} - Promise resolving to hero images array or null
 */
function getHeroImagesForUrl(url) {
  return new Promise((resolve) => {
    // First check in-memory cache
    if (heroImageStore.has(url)) {
      resolve(heroImageStore.get(url).images);
      return;
    }
    
    // Fall back to persistent storage
    chrome.storage.local.get(['heroImages'], (result) => {
      const existingImages = result.heroImages || {};
      if (existingImages[url]) {
        // Also update in-memory cache
        heroImageStore.set(url, existingImages[url]);
        resolve(existingImages[url].images);
      } else {
        resolve(null);
      }
    });
  });
}

// Export functionality to be used in the main background script
export { handleHeroImages, getHeroImagesForUrl };
