/**
 * Common utility functions for the sessions view
 */

/**
 * Extracts domain from a URL.
 * @param {string} url - The URL to extract domain from
 * @returns {string|null} - Domain name or null if invalid URL
 */
export function getDomainFromUrl(url) {
  if (!url) return null;
  
  try {
    // Handle chrome:// and other special URLs
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
      return url.split('/')[2];
    }
    
    // Handle regular URLs
    const urlObj = new URL(url);
    // Remove 'www.' prefix if present
    let domain = urlObj.hostname.replace(/^www\./, '');
    return domain;
  } catch (e) {
    return null;
  }
}

/**
 * Generate a set of unique colors based on domains
 * @param {Array<string>} domains - Array of domain names
 * @param {number} count - Maximum number of colors to return
 * @returns {Array<string>} - Array of HSL color values
 */
export function getUniqueColors(domains, count = 5) {
  if (!domains || !domains.length) {
    return [];
  }
  
  const uniqueDomains = [...new Set(domains)].slice(0, count);
  return uniqueDomains.map(domain => {
    const hue = Math.abs(hashString(domain) % 360);
    return `hsl(${hue}, 60%, 85%)`;
  });
}

/**
 * Simple string hash function for consistent colors
 * @param {string} str - String to hash
 * @return {number} - Hash code
 */
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
