/**
 * Debug Tools Injector for Tabtopia
 * This injects hero image debug functionality into any web page
 */

console.log('🔍 Tabtopia debug injector loaded');

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

// Button overlay removed as hero image extraction is working properly now
// The extraction functionality can still be accessed through the console API
