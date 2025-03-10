// Modify the link click handler to use event capturing and avoid interference
document.addEventListener('click', function(event) {
  // Find closest anchor in case we clicked on a child element
  const target = event.target.closest('a');
  if (!target || !target.href) return;
  
  // Collect essential link data
  const linkData = {
    href: target.href,
    text: target.innerText || target.textContent || '',
    title: target.title || '',
    timestamp: Date.now()
  };
  
  // Send data to background script without blocking
  chrome.runtime.sendMessage({
    type: 'LINK_TEXT_CAPTURED',
    data: linkData
  });
  
  // Don't interfere with normal event flow
}, true); // true = use capturing phase to get event first

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

    if (request.action === "getPageContent") {
        sendResponse({ content: document.body.innerText });
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

// Fix chrome.runtime.sendMessage calls by removing .catch() and adding proper error handling
function safelySendMessage(message) {
    try {
        chrome.runtime.sendMessage(message, response => {
            if (chrome.runtime.lastError) {
                console.warn('Error sending message:', chrome.runtime.lastError);
            }
        });
    } catch (err) {
        console.warn('Failed to send message:', err);
    }
}

// Fix handleUrlChange function
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

    // Send a single consolidated message instead of multiple ones
    safelySendMessage({
        type: 'navigation_event',
        action: 'updateNavigation',
        data: {
            tabId: currentTabId,
            windowId: null, // Don't reference chrome.windows here
            type: 'navigation',
            sourceUrl: document.referrer,
            targetUrl: url,
            title: title,
            text: title,
            favIconUrl: favIconUrl,
            timestamp: timestamp,
            status: 'complete'
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
    safelySendMessage({
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
    });
}

// Fix initializeObservers function
function initializeObservers() {
    // Track URL changes with navigation timing
    let lastNavigationStart = 0;
    let lastUrl = location.href;
    let lastTitle = document.title;
    let lastFavicon = getFavIconUrl();

    // Performance observer with error handling
    try {
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
    } catch (err) {
        console.warn('PerformanceObserver error:', err);
    }

    // Add a flag to avoid recursive triggers from DOM observer
    let isHandlingUpdate = false;
    
    // Watch for DOM changes with better debouncing
    let updateTimeout = null;
    const domObserver = new MutationObserver(() => {
        if (isHandlingUpdate) return; // Prevent recursive triggers
        
        if (updateTimeout) clearTimeout(updateTimeout);
        updateTimeout = setTimeout(() => {
            const currentUrl = location.href;
            const currentTitle = document.title;
            const currentFavicon = getFavIconUrl();

            if (currentUrl !== lastUrl || 
                currentTitle !== lastTitle || 
                (currentFavicon && currentFavicon !== lastFavicon)) {
                
                isHandlingUpdate = true;
                lastUrl = currentUrl;
                lastTitle = currentTitle;
                lastFavicon = currentFavicon;
                
                handleUrlChange();
                
                // Reset flag after a short delay to allow DOM to settle
                setTimeout(() => {
                    isHandlingUpdate = false;
                }, 50);
            }
        }, 250);
    });

    // Only observe body to reduce excessive triggers
    if (document.body) {
        domObserver.observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true
        });
    } else {
        // If body isn't available yet, wait for it
        window.addEventListener('load', () => {
            domObserver.observe(document.body, {
                subtree: true,
                childList: true,
                characterData: true
            });
        }, { once: true });
    }

    // More robust favicon detection
    function checkForFaviconChanges() {
        const currentFavicon = getFavIconUrl();
        if (currentFavicon && currentFavicon !== lastFavicon) {
            lastFavicon = currentFavicon;
            safelySendMessage({
                type: 'favicon_updated',
                tabId: currentTabId,
                favIconUrl: currentFavicon
            });
        }
    }
    
    // Check periodically for favicon changes
    setInterval(checkForFaviconChanges, 1000);
}

// Improve getFavIconUrl to get more favicon sources
function getFavIconUrl() {
    // Try multiple selectors in order of preference
    const favicon = document.querySelector('link[rel="icon"][sizes="32x32"]') || 
                   document.querySelector('link[rel="icon"][sizes="16x16"]') ||
                   document.querySelector('link[rel="shortcut icon"]') ||
                   document.querySelector('link[rel="icon"]') ||
                   document.querySelector('link[rel="apple-touch-icon"]');
                   
    if (favicon && favicon.href) {
        return favicon.href;
    }
    
    // Fallback to default location
    const defaultIcon = new URL('/favicon.ico', window.location.origin).href;
    return defaultIcon;
}