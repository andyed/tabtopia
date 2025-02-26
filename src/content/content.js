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
    if (request.action === 'getTabData') {
        // Get current tab info from sender
        const tabId = sender.tab?.id;
        const windowId = sender.tab?.windowId;

        const tabData = {
            title: document.title,
            url: window.location.href,
            favIconUrl: document.querySelector('link[rel~="icon"]') ? document.querySelector('link[rel~="icon"]').href : '',
            lastAccessed: Date.now(),
            tabId: tabId,
            windowId: windowId
        };
        sendResponse(tabData);
    }
});

// Add MutationObserver for URL and title changes
let currentTabId;

chrome.runtime.sendMessage({ type: 'getTabId' }, (response) => {
    if (response && response.tabId) {
        currentTabId = response.tabId;
        initializeObservers();
    }
});

function handleUrlChange() {
    const url = location.href;
    const title = document.title;
    const favIconUrl = getFavIconUrl();
    const timestamp = Date.now();
    
    console.log('URL change detected:', {
        url,
        title,
        tabId: currentTabId,
        timestamp
    });

    // Send a single consolidated update message
    chrome.runtime.sendMessage({
        action: 'tabUpdated',
        tabId: currentTabId,
        changeInfo: {
            url,
            title,
            favIconUrl,
            status: 'complete'  // Important for treemap update trigger
        },
        tab: {
            id: currentTabId,
            url,
            title,
            favIconUrl,
            windowId: chrome.windows?.WINDOW_ID_CURRENT,
            active: true,
            timestamp
        },
        source: 'content_script'  // Add source for debugging
    }).then(() => {
        console.log('Tab update sent successfully:', {
            url,
            title,
            tabId: currentTabId
        });
    }).catch(error => {
        console.warn('Failed to send tab update:', error);
    });

    // Also track in history
    chrome.runtime.sendMessage({
        type: 'navigation_event',
        data: {
            type: 'navigation',
            sourceUrl: document.referrer,
            targetUrl: url,
            text: title,
            timestamp,
            tabId: currentTabId
        }
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
    // Send initial state immediately
    handleUrlChange();

    // Set up URL change detection with debounce
    let lastUrl = location.href;
    let lastTitle = document.title;
    let updateTimeout = null;

    const debouncedUpdate = () => {
        if (updateTimeout) {
            clearTimeout(updateTimeout);
        }
        updateTimeout = setTimeout(() => {
            const currentUrl = location.href;
            const currentTitle = document.title;

            if (currentUrl !== lastUrl || currentTitle !== lastTitle) {
                lastUrl = currentUrl;
                lastTitle = currentTitle;
                handleUrlChange();
            }
        }, 250); // Debounce time
    };

    // Watch for DOM changes that might indicate navigation
    const observer = new MutationObserver(debouncedUpdate);
    observer.observe(document, {
        subtree: true,
        childList: true,
        characterData: true
    });

    // History API monitoring
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function() {
        originalPushState.apply(this, arguments);
        debouncedUpdate();
    };

    history.replaceState = function() {
        originalReplaceState.apply(this, arguments);
        debouncedUpdate();
    };

    // Navigation events
    window.addEventListener('popstate', debouncedUpdate);
    window.addEventListener('hashchange', debouncedUpdate);
    window.addEventListener('load', handleUrlChange);
}

function getFavIconUrl() {
    const favicon = document.querySelector('link[rel="shortcut icon"]') ||
                   document.querySelector('link[rel="icon"]');
    return favicon ? favicon.href : '';
}