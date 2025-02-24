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
        const tabData = {
            title: document.title,
            url: window.location.href,
            favIconUrl: document.querySelector('link[rel~="icon"]') ? document.querySelector('link[rel~="icon"]').href : '',
            lastAccessed: Date.now()
        };
        sendResponse(tabData);
    }
});