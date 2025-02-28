// Utility functions can be added here

export function abbreviateTitle(title, maxLength) {
  if (title.length > maxLength) {
    return title.substring(0, maxLength) + '...';
  }
  return title;
}

export function formatUrl(url) {
  try {
    const urlObj = new URL(url);
    let cleanHost = urlObj.hostname.replace(/^www\./, '');
    let cleanPath = urlObj.pathname;
    
    let params = '';
    const searchParams = new URLSearchParams(urlObj.search);
    const firstParam = searchParams.entries().next().value;
    if (firstParam) {
      params = `?${firstParam[0]}=${firstParam[1]}${searchParams.size > 1 ? '...' : ''}`;
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

// Update favicon handling function
export async function getFaviconUrl(url, preferredSize = 128) {
  // Try to get favicon using chrome.tabs.favIconUrl for active tabs
  try {
    const tab = await new Promise(resolve => {
      chrome.tabs.query({ url }, tabs => resolve(tabs[0]));
    });
    
    if (tab?.favIconUrl) {
      // Check if we have a high-res favicon
      if (tab.favIconUrl.includes('chrome://favicon/size/128')) {
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
    console.warn('Error fetching tab favicon:', error);
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
              resolve(smallFavicon || '/images/default-favicon.png');
            });
          }
        });
      });
    } catch (error) {
      console.warn('Error with chrome.favicon API:', error);
    }
  }

  // Fallback 2: Try Google's favicon service with size parameter
  const hostname = encodeURIComponent(new URL(url).hostname);
  return `https://www.google.com/s2/favicons?sz=${preferredSize}&domain=${hostname}`;
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

  if (years > 0) return `${years} year${years > 1 ? 's' : ''} ago`;
  if (months > 0) return `${months} month${months > 1 ? 's' : ''} ago`;
  if (weeks > 0) return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  return `${seconds} second${seconds > 1 ? 's' : ''} ago`;
}

export function formatSessionDuration(start, end) {
  const duration = end - start;

  const seconds = Math.floor(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? 's' : ''}`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
  return `${seconds} second${seconds > 1 ? 's' : ''}`;
}

export function applyColorCoding(tabs, windowColors) {
    return;
    tabs.forEach((tab, index) => {
        const windowId = tab.data.windowId;
        const baseColor = d3.color(windowColors.get(windowId));
        if (!baseColor) {
            console.warn(`No color found for window ${windowId}, using default`);
            tab.data.color = '#f5f5f5'; // Default color
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


