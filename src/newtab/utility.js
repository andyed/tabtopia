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
export async function getFaviconUrl(url) {
  // Try to get favicon using chrome.tabs.favIconUrl for active tabs
  try {
    const tab = await new Promise(resolve => {
      chrome.tabs.query({ url }, tabs => resolve(tabs[0]));
    });
    
    if (tab?.favIconUrl) {
      return tab.favIconUrl;
    }
  } catch (error) {
    console.warn('Error fetching tab favicon:', error);
  }

  // Fallback 1: Try chrome.favicon API if available
  if (chrome.favicon) {
    try {
      return new Promise(resolve => {
        chrome.favicon.getFavicon({
          url: url,
          size: 16
        }, favicon => {
          resolve(favicon || '/images/default-favicon.png');
        });
      });
    } catch (error) {
      console.warn('Error with chrome.favicon API:', error);
    }
  }

  // Fallback 2: Construct URL for Google's favicon service
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(url).hostname)}`;
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
