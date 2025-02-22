// Track link clicks and form submissions
document.addEventListener('click', (event) => {
  let target = event.target;
  let linkInfo = null;

  // Check if click was on or inside an anchor tag
  while (target && target !== document.body) {
    if (target.tagName === 'A') {
      linkInfo = {
        type: 'link',
        url: target.href,
        text: target.innerText.trim() || target.title || target.href,
        sourceUrl: window.location.href,
        timestamp: Date.now()
      };
      break;
    }
    target = target.parentElement;
  }

  if (linkInfo) {
    chrome.runtime.sendMessage({
      type: 'navigation_event',
      data: linkInfo
    });
  }
}, true);

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