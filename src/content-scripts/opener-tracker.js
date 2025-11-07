if (window.opener) {
  chrome.runtime.sendMessage({ type: 'hasOpener' });
}