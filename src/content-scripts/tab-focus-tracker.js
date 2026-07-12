/**
 * Tab Focus Tracker - Content Script
 * 
 * This script helps track when a tab receives focus by sending messages
 * to the background script when page visibility changes or the tab becomes active.
 * Works in conjunction with the browserState.trackTabFocus method.
 */

// Track when the document becomes visible
document.addEventListener("visibilitychange", function() {
  if (document.visibilityState === "visible") {
    // Tab has been focused - send message to background script
    notifyTabFocus();
  }
});

// Also track focus when the page loads
window.addEventListener("load", function() {
  if (document.visibilityState === "visible") {
    // Initial focus on page load
    notifyTabFocus();
  }
});

// Track when window gets focus
window.addEventListener("focus", function() {
  notifyTabFocus();
});

/**
 * Send a message to the background script to track this tab focus event
 */
function notifyTabFocus() {
  // Bail if the extension context is gone — e.g. the extension was reloaded while
  // this content script kept running in an already-open tab. That orphaned script
  // throws "Extension context invalidated" the moment it touches chrome.runtime;
  // chrome.runtime.id is undefined in that state, so this guard short-circuits it.
  if (!chrome.runtime?.id) return;

  try {
    // Get the current tab ID
    chrome.runtime.sendMessage({ action: "getTabId" }, function (response) {
      if (chrome.runtime.lastError) return; // context went away mid-call
      if (response && response.tabId) {
        // Send a message to track the focus event
        chrome.runtime.sendMessage({
          action: "updateTabActivity",
          tabId: response.tabId,
          event: { timestamp: Date.now(), type: "focus" }
        }, () => { void chrome.runtime.lastError; });
      }
    });
  } catch (e) {
    // Orphaned content script after an extension reload — nothing to do.
  }
}
