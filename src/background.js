// This file contains the background script for the Chrome extension. 
// It listens for browser events and manages the state of the extension, 
// including tracking browser history and active tabs.

chrome.runtime.onInstalled.addListener(() => {
  console.log("Chrome History Plugin installed.");
});

let historyEntries = [];
let activeTabs = [];

// Function to update history entries
function updateHistory() {
  chrome.history.search({ text: '', maxResults: 100 }, (results) => {
      historyEntries = results;
      chrome.storage.local.set({ historyEntries })
          .catch(error => {
              console.error('Error saving history entries:', error);
          });
  });
}

// Function to update active tabs
function updateActiveTabs() {
  chrome.tabs.query({ active: true }, (tabs) => {
      activeTabs = tabs;
      chrome.storage.local.set({ activeTabs })
          .catch(error => {
              console.error('Error saving active tabs:', error);
          });
  });
}

// Function to get favicon URL for a given tab
function getFaviconUrl(url) {
  return `chrome://favicon/size/16@1x/${url}`;
}

// Listen for history changes
chrome.history.onVisited.addListener((result) => {
  updateHistory();
  // Add favicon information
  const faviconUrl = getFaviconUrl(result.url);
  console.log(`New history entry: ${result.url} with favicon: ${faviconUrl}`);
  // Broadcast the new history entry to any listening tabs
  chrome.runtime.sendMessage({
      type: 'newHistoryEntry',
      data: {
          url: result.url,
          faviconUrl: faviconUrl,
          timestamp: new Date().getTime()
      }
  });
});

// Listen for tab changes
chrome.tabs.onActivated.addListener((activeInfo) => {
  updateActiveTabs();
  chrome.tabs.get(activeInfo.tabId, (tab) => {
      const faviconUrl = getFaviconUrl(tab.url);
      console.log(`New active tab: ${tab.url} with favicon: ${faviconUrl}`);
      chrome.runtime.sendMessage({
          type: 'tabChanged',
          data: {
              url: tab.url,
              faviconUrl: faviconUrl,
              timestamp: new Date().getTime()
          }
      });
  });
});

// Listen for favicon requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'getFavicon') {
    // Create a proxy URL that we can use in our extension
    const proxyUrl = chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(request.url)}`);
    sendResponse({ faviconUrl: proxyUrl });
    return true; // Keep the message channel open for the async response
  }
  return true;
});

// Add this listener to handle the proxy requests
chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    const url = new URL(details.url);
    const pageUrl = url.searchParams.get('pageUrl');
    if (pageUrl) {
      return {
        redirectUrl: `chrome-extension://${chrome.runtime.id}/_favicon/${pageUrl}`
      };
    }
    return {};
  },
  { urls: ["*://*/*"] },
  ["blocking"]
);

// Initial population of history and active tabs
updateHistory();
updateActiveTabs();