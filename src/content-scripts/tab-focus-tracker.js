/**
 * Tab Focus Tracker - Content Script
 * 
 * This script helps track when a tab receives focus by sending messages
 * to the background script when page visibility changes or the tab becomes active.
 * Works in conjunction with the browserState.trackTabFocus method.
 */

// Track when the document becomes visible
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') {
    // Tab has been focused - send message to background script
    notifyTabFocus();
  }
});

// Also track focus when the page loads
window.addEventListener('load', function() {
  if (document.visibilityState === 'visible') {
    // Initial focus on page load
    notifyTabFocus();
  }
});

// Track when window gets focus
window.addEventListener('focus', function() {
  notifyTabFocus();
});

/**
 * Send a message to the background script to track this tab focus event
 */
function notifyTabFocus() {
  // Get the current tab ID
  chrome.runtime.sendMessage({ action: 'getTabId' }, function(response) {
    if (response && response.tabId) {
      const tabId = response.tabId;
      
      // Send a message to track the focus event
      chrome.runtime.sendMessage({ 
        action: 'updateTabActivity', 
        tabId: tabId, 
        event: {
          timestamp: Date.now(),
          type: 'focus'
        }
      });
      
      console.log(`Tab ${tabId} focus event sent from content script at ${new Date().toISOString()}`);
    }
  });
}
