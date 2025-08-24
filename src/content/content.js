// Enhanced link click handler with rich context capture
document.addEventListener('click', function(event) {
  // Find closest anchor in case we clicked on a child element
  const target = event.target.closest('a');
  if (!target || !target.href) return;
  
  // Get surrounding text context (up to 100 chars before and after)
  let surroundingText = '';
  if (target.parentElement) {
    const parentText = target.parentElement.innerText || target.parentElement.textContent || '';
    const targetText = target.innerText || target.textContent || '';
    const targetIndex = parentText.indexOf(targetText);
    
    if (targetIndex !== -1) {
      const startIndex = Math.max(0, targetIndex - 100);
      const endIndex = Math.min(parentText.length, targetIndex + targetText.length + 100);
      surroundingText = parentText.substring(startIndex, endIndex);
    }
  }
  
  try {
    // Collect rich link data
    const linkData = {
      sourceUrl: window.location.href,
      targetUrl: target.href,
      text: (target.innerText || target.textContent || '').trim().substring(0, 200),
      title: target.title || '',
      timestamp: Date.now(),
      interactionType: 'click',
      elementType: 'link',
      surroundingText,
      // Include attributes that might help with context
      attributes: {
        id: target.id,
        className: target.className,
        rel: target.rel,
        ariaLabel: target.getAttribute('aria-label')
      },
      // Add page context
      pageContext: {
        title: document.title,
        path: window.location.pathname
      }
    };
    
    // Send the enriched data to the background script
    chrome.runtime.sendMessage({
      type: 'store_link_context',
      data: linkData
    });
    
    // Also send for legacy support
    chrome.runtime.sendMessage({
      type: 'LINK_TEXT_CAPTURED',
      data: linkData
    });
    
    console.log('Link click captured with rich context:', linkData.text);
  } catch (err) {
    console.warn('Error capturing link context:', err);
  }
  
  // Don't interfere with normal event flow
}, true); // true = use capturing phase to get event first

// Enhanced form submission tracking
document.addEventListener('submit', (event) => {
  const form = event.target;
  const submitButton = form.querySelector('input[type="submit"], button[type="submit"]');
  
  try {
    // Extract form fields (non-sensitive) to provide context
    const formFields = {};
    const fieldElements = form.querySelectorAll('input:not([type="password"]), select, textarea');
    fieldElements.forEach(el => {
      if (el.name && el.value && el.type !== 'password') {
        // Only include non-sensitive fields with names and values
        // Skip password fields for privacy
        formFields[el.name] = el.type === 'text' || el.type === 'search' ? el.value : '[FIELD_VALUE]';
      }
    });
    
    // Look for search inputs specifically
    const searchInputs = Array.from(form.querySelectorAll('input[type="search"], input[name*="search"], input[placeholder*="search" i]'));
    const searchQuery = searchInputs.length > 0 ? searchInputs[0].value : null;
    
    const formInfo = {
      type: 'form',
      url: form.action,
      targetUrl: form.action,
      sourceUrl: window.location.href,
      text: submitButton ? (submitButton.value || submitButton.innerText || 'Submit') : 'Form Submit',
      elementType: 'form',
      interactionType: 'submit',
      timestamp: Date.now(),
      isFormSubmission: true,
      formData: {
        id: form.id,
        method: form.method || 'get',
        action: form.action,
        // Only include field info if there's a search query to avoid privacy concerns
        searchQuery: searchQuery,
        fieldCount: fieldElements.length
      },
      // Add page context
      pageContext: {
        title: document.title,
        path: window.location.pathname
      }
    };

    // Send to background script for both tabs and navigation tracking
    chrome.runtime.sendMessage({
      type: 'store_link_context', // Use the same handler for consistency
      data: formInfo
    });

    // Also send via legacy format for compatibility
    chrome.runtime.sendMessage({
      type: 'navigation_event',
      data: formInfo
    });
    
    console.log('Form submission captured:', form.action);
  } catch (err) {
    console.warn('Error capturing form submission:', err);
  }
}, true);

// Enhanced right-click context menu handler
document.addEventListener('contextmenu', (event) => {
  let target = event.target;
  while (target && target !== document.body) {
    if (target.tagName === 'A') {
      // Get surrounding text context (up to 100 chars before and after)
      let surroundingText = '';
      if (target.parentElement) {
        const parentText = target.parentElement.innerText || target.parentElement.textContent || '';
        const targetText = target.innerText || target.textContent || '';
        const targetIndex = parentText.indexOf(targetText);
        
        if (targetIndex !== -1) {
          const startIndex = Math.max(0, targetIndex - 100);
          const endIndex = Math.min(parentText.length, targetIndex + targetText.length + 100);
          surroundingText = parentText.substring(startIndex, endIndex);
        }
      }

      // Store the enhanced link info in background script
      chrome.runtime.sendMessage({
        type: 'store_link_context',
        data: {
          sourceUrl: window.location.href,
          targetUrl: target.href,
          text: (target.innerText || target.textContent || '').trim().substring(0, 200),
          title: target.title || '',
          timestamp: Date.now(),
          interactionType: 'contextmenu',
          elementType: 'link',
          surroundingText,
          // Include attributes that might help with context
          attributes: {
            id: target.id,
            className: target.className,
            rel: target.rel,
            ariaLabel: target.getAttribute('aria-label')
          },
          // Add page context
          pageContext: {
            title: document.title,
            path: window.location.pathname
          }
        }
      });
      console.log('Context menu on link captured:', target.href);
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