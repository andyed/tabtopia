if (window.opener && chrome.runtime?.id) {
  try {
    chrome.runtime.sendMessage({ type: 'hasOpener' }, () => { void chrome.runtime.lastError; });
  } catch (e) {
    // Orphaned content script after an extension reload — nothing to do.
  }
}