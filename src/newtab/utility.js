// Utility functions can be added here

// Update favicon handling function
export async function getFaviconUrl(url) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'getFavicon', url: url },
      response => resolve(response.faviconUrl)
    );
  });
}