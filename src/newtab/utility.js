// Utility functions can be added here

export function abbreviateTitle(title, maxLength) {
  if (title.length > maxLength) {
    return title.substring(0, maxLength) + "...";
  }
  return title;
}

export function formatUrl(url) {
  try {
    const urlObj = new URL(url);
    let cleanHost = urlObj.hostname.replace(/^www\./, "");
    let cleanPath = urlObj.pathname;
    
    let params = "";
    const searchParams = new URLSearchParams(urlObj.search);
    const firstParam = searchParams.entries().next().value;
    if (firstParam) {
      params = `?${firstParam[0]}=${firstParam[1]}${searchParams.size > 1 ? "..." : ""}`;
    }
    
    return `${cleanHost}${cleanPath}${params}`;
  } catch (e) {
    return url;
  }
}

export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Add this function to generate SVG favicon with domain initial
export function createLetterFavicon(url) {
  try {
    // Get domain and extract first letter
    const domain = getDomainFromUrl(url) || "unknown";
    let letter = domain.charAt(0).toUpperCase();
    
    // Handle numeric or special character domains
    if (!letter.match(/[A-Z]/i)) {
      letter = domain.charAt(1).toUpperCase() || "X";
      if (!letter.match(/[A-Z]/i)) {
        letter = "X";
      }
    }
    
    // Generate random but consistent color based on domain
    const hue = Math.abs(hashString(domain) % 360);
    const bgColor = `hsl(${hue}, 60%, 85%)`;
    const textColor = `hsl(${hue}, 70%, 35%)`;
    
    // Create SVG icon
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="16" fill="${bgColor}" />
      <text x="16" y="22" font-family="Arial, sans-serif" font-size="16" font-weight="bold" 
        text-anchor="middle" fill="${textColor}">${letter}</text>
    </svg>`;
    
    // Convert SVG to base64 data URL
    return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
  } catch (error) {
    console.warn("Error creating letter favicon:", error);
    return "/images/default-favicon.png";
  }
}

// Add this simple hash function for consistent colors
function hashString(str) {
  let hash = 0;
  if (str.length === 0) return hash;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash;
}

// Update favicon handling function
export async function getFaviconUrl(url, preferredSize = 128) {
  // Internal/privileged URLs (chrome://, chrome-extension://, file://, about:,
  // data:) have no fetchable favicon. Asking Google's favicon service for them
  // redirects to gstatic and 404s — an external request on a page that should
  // stay offline-capable. Go straight to the generated letter favicon.
  if (!url || !/^https?:\/\//i.test(url)) {
    return createLetterFavicon(url || "");
  }
  // Try to get favicon using chrome.tabs.favIconUrl for active tabs
  try {
    const tab = await new Promise(resolve => {
      chrome.tabs.query({ url }, tabs => resolve(tabs[0]));
    });
    
    if (tab?.favIconUrl) {
      // Check if we have a high-res favicon
      if (tab.favIconUrl.includes("chrome://favicon/size/128")) {
        return tab.favIconUrl;
      }
      // Try to request high-res version
      try {
        const highResFavicon = `chrome://favicon/size/${preferredSize}/${url}`;
        return highResFavicon;
      } catch (error) {
        return tab.favIconUrl; // Fallback to original favicon
      }
    }
  } catch (error) {
    console.warn("Error fetching tab favicon:", error);
  }

  // Fallback 1: Try chrome.favicon API if available
  if (chrome.favicon) {
    try {
      return new Promise(resolve => {
        // Try large favicon first
        chrome.favicon.getFavicon({
          url: url,
          size: preferredSize
        }, favicon => {
          if (favicon) {
            resolve(favicon);
          } else {
            // Fallback to smaller size if large one isn't available
            chrome.favicon.getFavicon({
              url: url,
              size: 16
            }, smallFavicon => {
              resolve(smallFavicon);
            });
          }
        });
      });
    } catch (error) {
      console.warn("Error with chrome.favicon API:", error);
    }
  }

  // Fallback 2: Chrome's local favicon cache (_favicon/ API) instead of the
  // external Google service — no network request and no slow image-load probe.
  try {
    return getLocalFaviconUrl(url, preferredSize);
  } catch (error) {
    console.warn("Error building local favicon URL:", error);
  }

  // Final fallback: Generate letter favicon
  return createLetterFavicon(url);
}

// Synchronous local favicon URL via Chrome's _favicon/ API (needs the "favicon"
// permission + _favicon/* in web_accessible_resources — both present in the
// manifest). Returns a chrome-extension:// URL served from Chrome's own favicon
// cache: no network request, works offline. Use this for <img src> in place of
// the external google.com/s2/favicons service. Accepts a full URL or a domain.
export function getLocalFaviconUrl(pageUrlOrDomain, size = 32) {
  const raw = pageUrlOrDomain || "";
  const pageUrl = /^[a-z]+:\/\//i.test(raw) ? raw : (raw ? `https://${raw}` : "");
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`);
}

function exportSession() {
  const sessionData = {
    timestamp: Date.now(),
    windows: currentData.windowSwimlanes,
    history: currentData.historySwimlane
  };
  return JSON.stringify(sessionData);
}

export function formatDistanceToNow(date) {
  const now = new Date();
  const elapsed = now - date;

  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (years > 0) return `${years} year${years > 1 ? "s" : ""} ago`;
  if (months > 0) return `${months} month${months > 1 ? "s" : ""} ago`;
  if (weeks > 0) return `${weeks} week${weeks > 1 ? "s" : ""} ago`;
  if (days > 0) return `${days} day${days > 1 ? "s" : ""} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
  return `${seconds} second${seconds > 1 ? "s" : ""} ago`;
}

export function formatSessionDuration(start, end) {
  const duration = end - start;

  const seconds = Math.floor(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? "s" : ""}`;
  if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""}`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? "s" : ""}`;
  return `${seconds} second${seconds > 1 ? "s" : ""}`;
}

export function applyColorCoding(tabs, windowColors) {
    return;
    tabs.forEach((tab, index) => {
        const windowId = tab.data.windowId;
        const baseColor = d3.color(windowColors.get(windowId));
        if (!baseColor) {
            console.warn(`No color found for window ${windowId}, using default`);
            tab.data.color = "#f5f5f5"; // Default color
            return;
        }

        if (index === 0) {
            tab.data.color = baseColor.brighter(0.3); // Lightest
        } else if (index === 1) {
            tab.data.color = baseColor.brighter(0.2); // Lighter
        } else if (index === 2) {
            tab.data.color = baseColor.brighter(0.1); // Light
        }
    });
}

export function getDomainFromUrl(url) {
  if (!url) return null;
  
  try {
    // Handle chrome:// and other special URLs
    if (url.startsWith("chrome://") || url.startsWith("chrome-extension://")) {
      return url.split("/")[2];
    }
    
    // Handle regular URLs
    const urlObj = new URL(url);
    // Remove 'www.' prefix if present
    let domain = urlObj.hostname.replace(/^www\./, "");
    return domain;
  } catch (e) {
    return null;
  }
}

// Replace the duplicate sections with this consolidated code

// Color palette cache - SINGLE declaration
const windowColorCache = new Map();
const colorPalettes = {};

/**
 * Get a consistent color palette for a window
 * @param {number} windowId - Window identifier
 * @param {Object} options - Configuration options
 * @returns {Object} - Color palette with various properties
 */
export function getWindowColorPalette(windowId, options = {}) {
  // Default options
  const defaults = {
    paletteSize: 20,
    baseHueFn: (id) => (id * 137.5) % 360, // Golden angle for good distribution
    activeSaturation: 75,
    activeLightness: 55,
    lightnessFn: (i) => 55 - (i * 1.5),  // 55% down to 25% (lighter overall)
    saturationFn: (i) => 60 - (i * 1.5)  // 60% down to 30% (more saturated)
  };
  
  const config = { ...defaults, ...options };
  
  // Use cached palette if available
  const cacheKey = `${windowId}-${JSON.stringify(config)}`;
  if (colorPalettes[cacheKey]) {
    return colorPalettes[cacheKey];
  }
  
  // Generate or get base hue
  let baseHue;
  if (windowColorCache.has(windowId)) {
    baseHue = windowColorCache.get(windowId);
  } else {
    baseHue = config.baseHueFn(windowId);
    windowColorCache.set(windowId, baseHue);
  }
  
  // Generate palette
  const palette = {
    baseHue,
    windowId,
    colors: [],
    activeColor: `hsl(${baseHue}, ${config.activeSaturation}%, ${config.activeLightness}%)`,
    
    // Helper method to get color for a specific tab
    getTabColor: function(tab) {
      if (!tab) return this.colors[0];
      if (tab.active) return this.activeColor;
      const index = Math.min(tab.index || 0, this.colors.length - 1);
      return this.colors[index];
    },
    
    // Background color for window (lighter version)
    getWindowBackground: function() {
      return `hsl(${baseHue}, 15%, 70%)`;
    }
  };
  
  // Generate gradient from light to dark
  for (let i = 0; i < config.paletteSize; i++) {
    const lightness = config.lightnessFn(i);
    const saturation = config.saturationFn(i);
    palette.colors.push(`hsl(${baseHue}, ${saturation}%, ${lightness}%)`);
  }
  
  // Cache palette
  colorPalettes[cacheKey] = palette;
  
  return palette;
}

// Predefined colors for windows - can be used directly in both views
export const lightColors = [
  "#e3f2fd", "#e8f5e9", "#fff3e0", "#ffebee", 
  "#f3e5f5", "#e0f7fa", "#fffde7", "#efebe9"
];

// SINGLE getWindowColor function that combines both approaches
/**
 * Get a consistent color for a window
 * @param {number} windowId - Window identifier
 * @param {Object} options - Optional configuration
 * @returns {Object} - Color information including base color and palette
 */
export function getWindowColor(windowId, options = {}) {
  // Default options
  const config = {
    lightness: options.lightness || 70, // Brighter default (25-75% range)
    saturation: options.saturation || 60,
    fallbackHue: options.fallbackHue || 210, // Default blue
    useLegacy: options.useLegacy || false // Flag to use legacy simple colors
  };
  
  // Legacy mode - simple color from array
  if (config.useLegacy) {
    return {
      base: lightColors[windowId % lightColors.length],
      getTabColor: () => lightColors[windowId % lightColors.length],
      background: lightColors[windowId % lightColors.length],
      getBorder: (focused) => focused ? "#64b5f6" : "#403c36"
    };
  }
  
  // Return cached value if available
  if (windowColorCache.has(windowId)) {
    return windowColorCache.get(windowId);
  }
  
  // Generate a consistent hue based on window ID
  const hue = (windowId * 137.5) % 360; // Golden angle for good distribution
  
  // Create color object with helper methods
  const colorObj = {
    windowId,
    hue,
    
    // Base color for the window (background)
    base: `hsl(${hue}, ${config.saturation}%, ${config.lightness}%)`,
    
    // Get tab color based on activity and recency
    getTabColor: function(tabIndex, isActive = false) {
      if (isActive) {
        return `hsl(${hue}, 80%, 55%)`; // Vibrant color for active tab
      }
      // More recent tabs get brighter colors
      const tabLightness = Math.max(30, Math.min(70, config.lightness - (tabIndex * 2)));
      const tabSaturation = Math.max(40, Math.min(80, config.saturation - (tabIndex * 2)));
      return `hsl(${hue}, ${tabSaturation}%, ${tabLightness}%)`;
    },
    
    // Get window background
    background: `hsl(${hue}, ${Math.max(15, config.saturation - 45)}%, ${Math.min(75, config.lightness + 5)}%)`,
    
    // Get window border
    getBorder: function(focused = false) {
      return focused 
        ? `hsl(${hue}, 70%, 50%)` // Focused window border
        : `hsl(${hue}, 30%, 55%)`; // Normal window border
    }
  };
  
  // Cache the color
  windowColorCache.set(windowId, colorObj);
  return colorObj;
}

// Clear color cache (call this if you want to regenerate colors)
export function resetWindowColors() {
  windowColorCache.clear();
}

// Fallback colors for bookmarks or special windows
export const specialColors = {
  bookmark: {
    base: "hsl(195, 53%, 79%)",
    background: "hsl(195, 33%, 89%)",
    getBorder: (focused) => focused ? "hsl(195, 70%, 50%)" : "hsl(195, 40%, 65%)",
    getTabColor: () => "hsl(195, 53%, 79%)"
  }
};


