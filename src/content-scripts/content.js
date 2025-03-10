// Listen for messages from the extension
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getPageContent") {
        // Get the main content of the page
        const content = document.body.innerText;
        
        // Send the content back
        sendResponse({ content });
    }
    // Required for async response
    return true;
});