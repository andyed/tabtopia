// Hero image extraction for Histospire
// Captures hero images from pages with >60s dwell time and >500px scroll
// or significant engagement before unload

let pageLoadTime = Date.now();
let maxScrollDepth = 0;
let hasExtractedHeroImages = false;
let scrollTimer;
let dwellTimer;

// Minimum thresholds for extraction on unload
// Less strict than the main thresholds since we're catching exit events
const UNLOAD_MIN_DWELL_MS = 15000; // 15 seconds
const UNLOAD_MIN_SCROLL_PX = 300;  // 300px scroll

// Start dwell timer (60s threshold)
const DWELL_THRESHOLD_MS = 60000; // 60 seconds
const SCROLL_THRESHOLD_PX = 500; // 500px scroll depth

// Set a timer to check if we've been on the page long enough
dwellTimer = setTimeout(() => {
  // If we've scrolled enough, extract hero images
  if (maxScrollDepth > SCROLL_THRESHOLD_PX && !hasExtractedHeroImages) {
    extractAndSendHeroImages();
  }
}, DWELL_THRESHOLD_MS);

// Track maximum scroll depth
document.addEventListener('scroll', () => {
  const scrollDepth = Math.max(
    window.pageYOffset,
    document.documentElement.scrollTop,
    document.body.scrollTop
  );
  
  maxScrollDepth = Math.max(maxScrollDepth, scrollDepth);
  
  // Clear existing timer if any
  if (scrollTimer) {
    clearTimeout(scrollTimer);
  }
  
  // Wait a bit after scrolling stops to check if we should extract images
  scrollTimer = setTimeout(() => {
    // If we've been on page long enough and scrolled enough
    if (Date.now() - pageLoadTime > DWELL_THRESHOLD_MS && 
        maxScrollDepth > SCROLL_THRESHOLD_PX && 
        !hasExtractedHeroImages) {
      extractAndSendHeroImages();
    }
  }, 1000);
});

// Check for page unload/navigation away
window.addEventListener('beforeunload', () => {
  const dwellTime = Date.now() - pageLoadTime;
  
  // Only extract if we haven't already AND we meet minimum engagement criteria
  // This ensures we don't waste resources on quickly bounced pages
  if (!hasExtractedHeroImages && 
      dwellTime > UNLOAD_MIN_DWELL_MS && 
      maxScrollDepth > UNLOAD_MIN_SCROLL_PX) {
    
    console.log(`📸 Capturing hero images on page unload after ${Math.round(dwellTime/1000)}s dwell and ${maxScrollDepth}px scroll`);
    extractAndSendHeroImages();
    
    // Minor delay to ensure message has time to send
    // This might not always work due to the nature of beforeunload
    const start = Date.now();
    while (Date.now() - start < 50) {
      // Tiny delay loop to give the message time to send
      // This is a best-effort approach
    }
  }
});

/**
 * Extract hero images based on heuristics and send them to the background script
 */
function extractAndSendHeroImages() {
  hasExtractedHeroImages = true;
  
  const heroImages = findHeroImages();
  const pageUrl = document.location.href;
  const pageTitle = document.title;
  
  // Send the extracted hero images to the background script
  chrome.runtime.sendMessage({
    action: 'storeHeroImages',
    data: {
      url: pageUrl,
      title: pageTitle,
      timestamp: Date.now(),
      heroImages: heroImages,
      scrollDepth: maxScrollDepth,
      dwellTime: Date.now() - pageLoadTime
    }
  });
}

/**
 * Find potential hero images on the page using multiple heuristics
 * @returns {Array} An array of image objects with URL, dimensions, and score
 */
function findHeroImages() {
  const images = Array.from(document.querySelectorAll('img'));
  const heroImages = [];
  
  // First check for explicit metadata
  const ogImage = document.querySelector('meta[property="og:image"]')?.content;
  if (ogImage) {
    heroImages.push({
      src: ogImage,
      width: 1200, // Typical OG image size
      height: 630,
      score: 100,
      isMetaImage: true
    });
  }
  
  // Check for twitter image
  const twitterImage = document.querySelector('meta[name="twitter:image"]')?.content;
  if (twitterImage && twitterImage !== ogImage) {
    heroImages.push({
      src: twitterImage,
      width: 1200,
      height: 600,
      score: 95,
      isMetaImage: true
    });
  }
  
  // Wiki-specific extraction - check for main wiki images
  // These often appear in infoboxes, galleries, or at the beginning of articles
  if (window.location.hostname.includes('wiki')) {
    console.log('Wiki page detected, using specialized image extraction');
    
    // For Wikibooks specifically, look for images in specific locations
    if (window.location.hostname.includes('wikibooks')) {
      console.log('Wikibooks page detected - using specialized Wikibooks extraction');
      
      // Special case for cookbook/recipe pages
      if (window.location.pathname.includes('Cookbook:')) {
        console.log('Recipe page detected, checking for recipe images');
        
        // First check if page has Wikipedia Commons links that might contain images
        const commonsLinks = Array.from(document.querySelectorAll('a[href*="commons.wikimedia.org"]'));
        console.log(`Found ${commonsLinks.length} wikimedia commons links`);
        
        // Find image on linked Wikipedia page if this recipe doesn't have direct images
        // Often recipe books link to Wikipedia articles which have images
        const wikipediaLinks = Array.from(document.querySelectorAll('a[href*="wikipedia.org"]'))
          .filter(link => {
            // Only consider links in the main content area that are likely related
            const isInContent = link.closest('.mw-body-content') !== null;
            const linkText = link.textContent.toLowerCase();
            const pageTitle = document.title.toLowerCase();
            
            // Check if link is relevant to the page topic
            const isTitleMatch = pageTitle.includes(linkText) || linkText.includes(pageTitle.split(':').pop());
            return isInContent && isTitleMatch;
          });
          
        console.log(`Found ${wikipediaLinks.length} relevant Wikipedia links`);
        if (wikipediaLinks.length > 0) {
          // We can't directly fetch the Wikipedia page content, but we can use this to inform the user
          console.log(`Consider checking linked Wikipedia article: ${wikipediaLinks[0].href} for images`);
        }
      }
      
      // Get ALL images on page with much lower threshold for wikibooks
      // Wikibooks often has smaller but meaningful images
      const allWikiImages = Array.from(document.querySelectorAll('img'))
        .filter(img => img.complete && img.naturalWidth >= 30 && img.naturalHeight >= 30 && !img.src.includes('Special:'));
      
      console.log(`Found ${allWikiImages.length} potential wiki images to analyze`);
      
      // Sort by area (largest first)
      allWikiImages
        .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight))
        .slice(0, 5) // Take more images for wiki pages
        .forEach(img => {
          const rect = img.getBoundingClientRect();
          const relativeToDoc = img.getBoundingClientRect().top + window.scrollY;
          // Much lower threshold for wikibooks
          const isWorthCapturing = img.naturalWidth >= 80 && img.naturalHeight >= 80;
          
          console.log(`Wiki image candidate: ${img.src}`, {
            dimensions: `${img.naturalWidth}x${img.naturalHeight}`, 
            position: `${Math.round(relativeToDoc)}px from top`,
            isWorthCapturing
          });
          
          if (isWorthCapturing) {
            heroImages.push({
              src: img.src,
              width: img.naturalWidth,
              height: img.naturalHeight,
              score: 95,
              isWikiImage: true,
              alt: img.alt || '',
              documentPosition: relativeToDoc
            });
          }
        });
    }
    
    // Check for infobox images (typically right-aligned tables with images)
    const infoboxImages = document.querySelectorAll('.infobox img, .thumbimage, .image img, .thumb img');
    if (infoboxImages && infoboxImages.length > 0) {
      console.log(`Found ${infoboxImages.length} infobox/thumb images`);
      Array.from(infoboxImages).forEach(img => {
        if (img.complete && img.naturalWidth > 100 && img.naturalHeight > 100) {
          heroImages.push({
            src: img.src,
            width: img.naturalWidth,
            height: img.naturalHeight,
            score: 90, // High score for infobox images
            isWikiImage: true,
            alt: img.alt || ''
          });
        }
      });
    }
    
    // Check for featured/main images that might be within content
    // Wiki pages often have these in specific sections or with certain class names
    const contentImages = document.querySelectorAll('.mw-body-content img, .mw-content-ltr img');
    if (contentImages && contentImages.length > 0) {
      console.log(`Found ${contentImages.length} content images`);
      // Sort by size (largest first) for content images
      const sortedImages = Array.from(contentImages)
        .filter(img => img.complete && img.naturalWidth >= 200 && img.naturalHeight >= 200)
        .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
      
      // Take the largest content images
      sortedImages.slice(0, 2).forEach(img => {
        heroImages.push({
          src: img.src,
          width: img.naturalWidth,
          height: img.naturalHeight,
          score: 85,
          isWikiContentImage: true,
          alt: img.alt || ''
        });
      });
    }
  }
  
  // Score visible images on page
  images.forEach(img => {
    // Skip tiny images, hidden images, or data URIs
    if (!img.complete || !img.naturalWidth || !img.naturalHeight ||
        img.naturalWidth < 100 || img.naturalHeight < 100 ||
        !isVisibleInViewport(img) || img.src.startsWith('data:')) {
      return;
    }
    
    let score = 0;
    
    // Position score - higher for images near the top
    const rect = img.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    if (rect.top < viewportHeight) {
      score += 10 * (1 - rect.top / viewportHeight);
    }
    
    // Size score
    const area = img.naturalWidth * img.naturalHeight;
    const viewportArea = window.innerWidth * window.innerHeight;
    score += 20 * Math.min(area / viewportArea, 1);
    
    // Check for hero-related classes/IDs
    const heroTerms = ['hero', 'banner', 'featured', 'main', 'cover', 'header'];
    const parentElements = [img, img.parentElement, img.parentElement?.parentElement];
    
    for (const el of parentElements) {
      if (!el) continue;
      for (const term of heroTerms) {
        if ((el.id && el.id.toLowerCase().includes(term)) || 
            (el.className && typeof el.className === 'string' && el.className.toLowerCase().includes(term))) {
          score += 15;
          break;
        }
      }
    }
    
    // Non-decorative image check (has alt text)
    if (img.alt && img.alt.length > 3) {
      score += 5;
    }
    
    // Check if near an h1/h2
    const nearby = img.closest('section, article, div');
    if (nearby && nearby.querySelector('h1, h2')) {
      score += 10;
    }
    
    // Add to hero images array if score is high enough
    if (score > 20) {
      heroImages.push({
        src: img.src,
        width: img.naturalWidth,
        height: img.naturalHeight,
        score: score,
        alt: img.alt || ''
      });
    }
  });
  
  // Sort by score (highest first)
  heroImages.sort((a, b) => b.score - a.score);
  
  // Return top 5 images
  return heroImages.slice(0, 5);
}

/**
 * Check if an element is visible in the viewport or would be visible when scrolling
 * @param {Element} el - The element to check
 * @param {Boolean} relaxedCheck - If true, use more lenient criteria (for wiki pages)
 * @returns {Boolean} - Whether the element is visible or would be visible
 */
function isVisibleInViewport(el) {
  if (!el) return false;
  
  const rect = el.getBoundingClientRect();
  const isWikiPage = window.location.hostname.includes('wiki');
  
  // For wiki pages, we're more lenient about visibility
  // We want to capture images even if they're partially outside viewport
  // or if they would become visible with a bit of scrolling
  if (isWikiPage) {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    
    // Check if at least 25% of the image is in/near the viewport
    // or if it's in the top 2000px of the page (important area)
    const imgArea = rect.width * rect.height;
    const visibleWidth = Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0);
    const visibleHeight = Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0);
    const visibleArea = visibleWidth * visibleHeight;
    const isPartiallyVisible = visibleArea > 0;
    const isInImportantArea = rect.top < 2000 && rect.bottom > 0;
    
    return isPartiallyVisible || isInImportantArea;
  }
  
  // Standard strict check for normal pages
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
  );
}
