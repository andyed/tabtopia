// Utility functions can be added here

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