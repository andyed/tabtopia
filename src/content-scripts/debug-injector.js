/**
 * Debug Tools Injector for Histospire
 * This injects hero image debug functionality into any web page
 */

console.log('🔍 Histospire debug injector loaded');

// Create a button to force hero image extraction
function createDebugButton() {
  const button = document.createElement('button');
  button.textContent = '📸 Extract Hero Images';
  button.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 9999;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.7);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-family: system-ui;
    box-shadow: 0 2px 5px rgba(0,0,0,0.3);
  `;
  
  // Add hover effect
  button.onmouseover = () => {
    button.style.background = 'rgba(0, 0, 0, 0.85)';
  };
  button.onmouseout = () => {
    button.style.background = 'rgba(0, 0, 0, 0.7)';
  };
  
  button.onclick = () => forceExtractHeroImages();
  
  document.body.appendChild(button);
  
  return button;
}

// Force hero image extraction
async function forceExtractHeroImages() {
  try {
    // Find potential hero images on the page
    const images = Array.from(document.querySelectorAll('img'))
      .filter(img => img.complete && img.naturalWidth > 100 && img.naturalHeight > 100)
      .map(img => ({
        src: img.src,
        width: img.naturalWidth,
        height: img.naturalHeight,
        score: 50,
        alt: img.alt || ''
      }))
      .slice(0, 5);
    
    if (images.length === 0) {
      alert('No suitable images found for extraction');
      return;
    }
    
    // Send to background script
    chrome.runtime.sendMessage({
      action: 'storeHeroImages',
      data: {
        url: document.location.href,
        title: document.title,
        timestamp: Date.now(),
        heroImages: images,
        scrollDepth: 1000,
        dwellTime: 60000
      }
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Error sending hero images:', chrome.runtime.lastError);
        alert('❌ Error sending hero images to background script');
      } else {
        console.log('Successfully sent hero images to background script');
        alert(`✅ Successfully extracted ${images.length} hero images!`);
      }
    });
  } catch (e) {
    console.error('Failed to extract hero images:', e);
    alert('❌ Failed to extract hero images: ' + e.message);
  }
}

// Wait for page to be ready
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  createDebugButton();
} else {
  document.addEventListener('DOMContentLoaded', createDebugButton);
}
