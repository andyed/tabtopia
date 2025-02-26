// Track link clicks and form submissions
document.addEventListener('click', (event) => {
  let target = event.target;
  while (target && target !== document.body) {
    if (target.tagName === 'A') {
      const linkInfo = {
        type: 'navigation',
        sourceUrl: window.location.href,
        targetUrl: target.href,
        text: target.innerText.trim() || target.title || target.href,
        timestamp: Date.now()
      };
      chrome.runtime.sendMessage({
        type: 'navigation_event',
        data: linkInfo
      });
      break;
    }
    target = target.parentElement;
  }
});

// Track form submissions
document.addEventListener('submit', (event) => {
  const form = event.target;
  const submitButton = form.querySelector('input[type="submit"], button[type="submit"]');
  
  const formInfo = {
    type: 'form',
    url: form.action,
    text: submitButton ? (submitButton.value || submitButton.innerText || 'Submit') : 'Form Submit',
    sourceUrl: window.location.href,
    timestamp: Date.now()
  };

  chrome.runtime.sendMessage({
    type: 'navigation_event',
    data: formInfo
  });
}, true);

// Track right-clicks for context menu opens
document.addEventListener('contextmenu', (event) => {
  let target = event.target;
  while (target && target !== document.body) {
    if (target.tagName === 'A') {
      // Store the link info temporarily in background script
      chrome.runtime.sendMessage({
        type: 'store_link_context',
        data: {
          sourceUrl: window.location.href,
          targetUrl: target.href,
          text: target.innerText.trim() || target.title || target.href,
          timestamp: Date.now()
        }
      });
      break;
    }
    target = target.parentElement;
  }
}, true);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request.type && !request.action) {
        console.warn('Invalid message format:', request);
        return true;
    }

    console.log('Content script received message:', {
        type: request.type,
        action: request.action,
        sender: sender?.tab?.id
    });

    if (request.type === 'getTabData' || request.action === 'getTabData') {
        const tabData = {
            title: document.title || '',
            url: window.location.href,
            favIconUrl: getFavIconUrl(),
            lastAccessed: Date.now(),
            tabId: sender?.tab?.id,
            windowId: sender?.tab?.windowId
        };
        sendResponse(tabData);
    }

    return true;
});

// Add MutationObserver for URL and title changes
let currentTabId;

// Update initialization message
chrome.runtime.sendMessage({
    type: 'getTabId',
    action: 'initialize',
    timestamp: Date.now()
}, (response) => {
    if (response?.tabId) {
        currentTabId = response.tabId;
        initializeObservers();
    } else {
        console.warn('Failed to get tab ID:', response);
    }
});

function handleUrlChange() {
    const url = window.location.href;
    const title = document.title;
    const favIconUrl = getFavIconUrl();
    const timestamp = Date.now();
    
    console.log('URL change detected:', {
        url,
        title,
        tabId: currentTabId,
        timestamp
    });

    // Send navigation event with required fields
    chrome.runtime.sendMessage({
        type: 'navigation_event',
        action: 'updateNavigation',  // Add explicit action
        data: {
            tabId: currentTabId,     // Add explicit tabId
            windowId: chrome.windows?.WINDOW_ID_CURRENT,
            type: 'navigation',
            sourceUrl: document.referrer,
            targetUrl: url,
            text: title,
            timestamp: Date.now()
        }
    }).catch(err => {
        console.warn('Failed to send navigation event:', err);
    });

    // Also send direct tab update
    chrome.runtime.sendMessage({
        type: 'tabUpdate',
        action: 'tabUpdated',
        tabId: currentTabId,
        changeInfo: {
            url,
            title,
            favIconUrl,
            status: 'complete'
        },
        tab: {
            id: currentTabId,
            url,
            title,
            favIconUrl,
            windowId: chrome.windows?.WINDOW_ID_CURRENT,
            active: true,
            timestamp
        }
    }).catch(err => {
        console.warn('Failed to send tab update:', err);
    });
}

function sendContentUpdate() {
    if (!currentTabId) {
        console.warn('No tab ID available for content update');
        return;
    }

    const url = window.location.href;
    const title = document.title;
    const favIconUrl = getFavIconUrl();
    const timestamp = Date.now();

    // Send direct tab update
    chrome.runtime.sendMessage({
        action: 'tabUpdated',
        tabId: currentTabId,
        changeInfo: {
            url,
            title,
            favIconUrl
        },
        tab: {
            id: currentTabId,
            url,
            title,
            favIconUrl,
            timestamp
        }
    }).catch(error => {
        console.warn('Failed to send tab update:', error);
    });
}

function initializeObservers() {
    // Track URL changes with navigation timing
    let lastNavigationStart = 0;
    let lastUrl = location.href;
    let lastTitle = document.title;

    // Performance observer for navigation timing
    const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
            if (entry.entryType === 'navigation') {
                const currentTime = Date.now();
                // Only trigger if more than 100ms since last navigation
                if (currentTime - lastNavigationStart > 100) {
                    lastNavigationStart = currentTime;
                    handleUrlChange();
                }
            }
        }
    });

    observer.observe({ entryTypes: ['navigation'] });

    // Watch for DOM changes with debounce
    let updateTimeout = null;
    const domObserver = new MutationObserver(() => {
        if (updateTimeout) clearTimeout(updateTimeout);
        updateTimeout = setTimeout(() => {
            const currentUrl = location.href;
            const currentTitle = document.title;

            if (currentUrl !== lastUrl || currentTitle !== lastTitle) {
                lastUrl = currentUrl;
                lastTitle = currentTitle;
                handleUrlChange();
            }
        }, 250);
    });

    domObserver.observe(document, {
        subtree: true,
        childList: true,
        characterData: true
    });

    // History API monitoring
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function() {
        originalPushState.apply(this, arguments);
        handleUrlChange();
    };

    history.replaceState = function() {
        originalReplaceState.apply(this, arguments);
        handleUrlChange();
    };

    // Navigation events
    window.addEventListener('popstate', handleUrlChange);
    window.addEventListener('hashchange', handleUrlChange);
    window.addEventListener('load', handleUrlChange);
}

function getFavIconUrl() {
    const favicon = document.querySelector('link[rel="shortcut icon"]') ||
                   document.querySelector('link[rel="icon"]');
    return favicon ? favicon.href : '';
}