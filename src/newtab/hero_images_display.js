// Hero images display for sessions view
import { showSessionModal, extractTitleFromSession } from "./sessions_modal.js";

import { formatTimeAgo } from "./timeago.js";
import { getLocalFaviconUrl } from "./utility.js";

// Global registry of seen image URLs to prevent duplicates across pages/sessions
const globalSeenImageUrls = new Set();

/**
 * Creates a session card, either double-width with hero image or standard size
 * @param {Object} session - Session data object with pages
 * @param {Object} options - Options including relativeAge (0-1 scale, 0 = newest, 1 = oldest)
 * @returns {HTMLElement} - Card element with appropriate size based on content
 */
export async function createSessionCard(session, options = {}) {
  if (!session?.pages || session.pages.length === 0) {
    return null;
  }

  // Filter and prioritize active pages (pages that were focused during the session)
  const activePages = session.pages.filter(page => page.wasActiveInSession === true);
  const inactivePages = session.pages.filter(page => page.wasActiveInSession !== true);

  // Use active pages first, then inactive pages for display
  // Keep original session data intact but prioritize active pages
  const displaySession = {
    ...session,
    pages: [...activePages, ...inactivePages]
  };

  // Track if we have any active pages for highlighting
  const hasActivePagesInSession = activePages.length > 0;

  // Helper function to extract domain from URL
  function extractDomainFromUrl(url) {
    if (!url) return "";

    // Add protocol if it's missing
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }

    try {
      const urlObj = new URL(url);
      return urlObj.hostname || "";
    } catch (e) {
      // Try to extract domain using regex as fallback
      const domainMatch = url.match(/[^/]*\.[^./]+(\.[^./]+)?/);
      return domainMatch ? domainMatch[0] : "";
    }
  }

  // Helper: favicon URL for a domain via Chrome's local cache (not the external
  // Google service).
  function getFaviconUrl(domain) {
    return getLocalFaviconUrl(domain, 32);
  }

  // Collects hero images from pages within a session
  function collectHeroImagesFromSession(session, maxImages = 5) {
    const seenImageUrls = new Set(); // To track duplicate image URLs locally
    const heroImages = [];

    // First pass: collect images from pages with significant dwell time
    session.pages.forEach(page => {
      if (page.heroImage && page.dwellTimeMs > 10000 &&
        heroImages.length < maxImages &&
        !seenImageUrls.has(page.heroImage) &&
        !globalSeenImageUrls.has(page.heroImage)) {

        const domain = extractDomainFromUrl(page.url || "");
        const imgObj = {
          src: page.heroImage,
          alt: page.title || "",
          pageTitle: page.title || "",
          pageUrl: page.url || "",
          domain: domain,
          favicon: getFaviconUrl(domain),
          quality: Math.min(page.dwellTimeMs / 1000, 300) // Cap quality at 300 (5 minutes)
        };
        heroImages.push(imgObj);
        seenImageUrls.add(page.heroImage);
        globalSeenImageUrls.add(page.heroImage); // Add to global registry
      }
    });

    // Second pass: add more images if needed
    if (heroImages.length < maxImages) {
      session.pages.forEach(page => {
        if (page.heroImage &&
          !seenImageUrls.has(page.heroImage) &&
          !globalSeenImageUrls.has(page.heroImage) &&
          heroImages.length < maxImages) {

          const imgObj = {
            src: page.heroImage,
            alt: page.title || "",
            pageTitle: page.title || "",
            pageUrl: page.url || "",
            quality: Math.min((page.dwellTimeMs || 1000) / 1000, 60) // Default to 1 second if no dwell time
          };
          heroImages.push(imgObj);
          seenImageUrls.add(page.heroImage);
          globalSeenImageUrls.add(page.heroImage); // Add to global registry
        }
      });
    }

    // Sort by quality (higher is better)
    heroImages.sort((a, b) => b.quality - a.quality);

    // Return at most maxImages
    return heroImages.slice(0, maxImages);
  }

  // Find the most significant pages based on dwell time
  const significantPages = displaySession.pages
    .filter(page => page.dwellTimeMs > 30000) // Pages with at least 30s dwell time
    .sort((a, b) => b.dwellTimeMs - a.dwellTimeMs); // Sort by dwell time descending

  // Collect hero images from significant pages first, then from any page
  let heroImages = collectHeroImagesFromSession(displaySession);
  let hasHeroImage = heroImages.length > 0;
  let imageQuality = 0; // 0-100 scale for image quality/importance

  // If we don't have enough images, look through all pages
  if (heroImages.length < 5) {
    for (const page of displaySession.pages) {
      // Skip pages we've already processed
      if (significantPages.some(p => p.url === page.url)) {
        continue;
      }

      const images = await getHeroImagesForUrl(page.url);
      if (images && images.length > 0) {
        // Only add images that haven't been seen globally
        const uniqueImages = images.filter(img => !globalSeenImageUrls.has(img.src));

        if (uniqueImages.length > 0) {
          const enhancedImages = uniqueImages.map(img => {
            // Mark this image URL as seen globally
            globalSeenImageUrls.add(img.src);

            return {
              ...img,
              pageTitle: page.title || "",
              pageUrl: page.url,
              quality: 40 + Math.min(20, (page.dwellTimeMs / 30000) * 5) // Quality 40-60 for regular pages
            };
          });

          heroImages.push(...enhancedImages);
          hasHeroImage = true;

          // Once we have 5 images, we have enough
          if (heroImages.length >= 5) {
            break;
          }
        }
      }
    }
  }

  // Sort images by quality
  heroImages.sort((a, b) => b.quality - a.quality);

  // Take only the top 5 images
  heroImages = heroImages.slice(0, 5);

  // Set the main hero image and quality
  const heroImage = heroImages.length > 0 ? heroImages[0] : null;
  const pageTitle = heroImages.length > 0 ? heroImages[0].pageTitle : "";
  const pageUrl = heroImages.length > 0 ? heroImages[0].pageUrl : "";
  imageQuality = heroImages.length > 0 ? heroImages[0].quality : 0;

  // Decide if this should be a double-width card
  // Make it double-width if it has good quality hero images AND
  // either has many pages OR long duration OR multiple images
  const isLongSession = session.duration > 10 * 60000; // > 10 minutes
  const hasManyPages = session.pages.length > 10;
  const hasQualityImage = hasHeroImage && imageQuality > 60;
  const hasMultipleImages = heroImages.length > 1;
  const shouldBeDoubleWidth = (hasQualityImage || hasMultipleImages) && (isLongSession || hasManyPages || hasMultipleImages);

  // Create the card element with appropriate class
  const card = document.createElement("div");
  card.className = shouldBeDoubleWidth ? "session-card double-width" : "session-card standard-width";
  if (!hasHeroImage) {
    card.classList.add("no-image");
  }

  // Add active indicator if the session has active pages
  if (hasActivePagesInSession) {
    card.classList.add("has-active-pages");
  }

  // Add data attributes for age-based hue and session id for modal matching
  card.dataset.sessionId = session.id || crypto.randomUUID();

  // Apply age-based color coding
  if (options.relativeAge !== undefined) {
    // Apply color based on age (0 = newest, 1 = oldest)
    const hue = 200 - (options.relativeAge * 160); // Blue (200) to red-orange (40)
    const lightness = 25 - (options.relativeAge * 8); // Slightly darker for older items

    if (!hasHeroImage) {
      // For cards without images, apply color to the background
      card.style.background = `linear-gradient(135deg, hsl(${hue}, 70%, ${lightness + 5}%) 0%, hsl(${hue}, 80%, ${lightness - 5}%) 100%)`;
    } else {
      // For cards with images, apply color to the content section
      card.dataset.ageHue = hue;
      card.dataset.ageLightness = lightness;
    }
  }

  // Create session details
  const durationMinutes = Math.round(session.duration / 60000);
  const formattedDuration = durationMinutes < 60
    ? `${durationMinutes}m`
    : `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`;

  // Calculate time since session start for timeline visualization using timeago approach
  const timeAgoString = formatTimeAgo(session.startTime);

  // Calculate top domains
  const domains = displaySession.pages.map(page => {
    try {
      return new URL(page.url).hostname;
    } catch (e) {
      return null;
    }
  }).filter(Boolean);

  const domainCounts = {};
  domains.forEach(domain => {
    domainCounts[domain] = (domainCounts[domain] || 0) + 1;
  });

  const topDomains = Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5) // Get top 5 domains for favicons and cards
    .map(entry => entry[0]);

  // Get first and last page titles for summary
  const firstPage = displaySession.pages.length > 0 ? displaySession.pages[0] : null;
  const lastPage = displaySession.pages.length > 0 ? displaySession.pages[displaySession.pages.length - 1] : null;

  const firstPageTitle = firstPage?.title || "Unknown page";
  const lastPageTitle = lastPage?.title || "Unknown page";

  // Build the card HTML with different layouts based on type
  // Check if card is double-width or standard
  const isDoubleWidth = card.classList.contains("double-width");

  if (hasHeroImage) {
    if (isDoubleWidth) {
      // Double-width card with content side by side
      card.innerHTML = `
        <div class="card-image-section">
          ${heroImages.length > 1 ?
          `<div class="session-mosaic mosaic-${heroImages.length}">
              ${heroImages.map((img, i) => {
            const domain = extractDomainFromUrl(img.pageUrl || "");
            const faviconUrl = getFaviconUrl(domain);
            return `<div class="mosaic-item-wrapper mosaic-item-${heroImages.length}-${i + 1}">
                  <img src="${img.src}" alt="${img.alt || img.pageTitle || "Session image"}" 
                       class="mosaic-item hero-image-element" 
                       title="${img.pageTitle || ""}" 
                       data-page-url="${img.pageUrl || ""}">
                  <img src="${faviconUrl}" alt="Favicon for ${domain}" 
                       class="mosaic-favicon" 
                       title="${domain}">  
                </div>`;
          }).join("")}
            </div>
            <div class="image-source">${pageTitle ? `From: ${pageTitle.substring(0, 40)}${pageTitle.length > 40 ? "..." : ""}` : ""}</div>` :
          `<img src="${heroImage.src}" alt="${heroImage.alt || pageTitle || "Session image"}" class="card-image hero-image-element">
             <div class="image-source">${pageTitle ? `From: ${pageTitle.substring(0, 40)}${pageTitle.length > 40 ? "..." : ""}` : ""}</div>`
        }
        </div>
        <div class="card-content-section"${card.dataset.ageHue ? ` style="background-color: hsla(${card.dataset.ageHue}, 70%, ${card.dataset.ageLightness}%, 0.9)"` : ""}>
          <h3 class="card-title">${session.name || extractTitleFromSession(session) || "Browsing Session"}</h3>
          
          <div class="card-stats">
            <!-- Combined page count and favicon stack -->
            <div class="stat-item pages-with-favicons">
              <span class="page-count">${displaySession.pages.length}</span>
              <div class="favicon-stack">
                ${topDomains.slice(0, 5).map((domain, index) =>
          `<img src="${getLocalFaviconUrl(domain, 16)}" 
                   class="stacked-favicon" 
                   style="z-index:${10 - index}; margin-left:${index * -6}px" 
                   title="${domain}" />`).join("")}
              </div>
            </div>
            <!-- Timeline visualization for duration and start time -->
            <div class="stat-item timeline-visualization">
              <div class="timeline-bar">
                <div class="timeline-duration" 
                     style="width:${Math.min(100, Math.max(10, Math.log10(session.duration / 1000) * 20))}%" 
                     title="Duration: ${formattedDuration}"></div>
              </div>
              <div class="timeline-labels">
                <span class="duration-label">${formattedDuration}</span>
                <span class="time-ago-label">${timeAgoString}</span>
              </div>
            </div>
          </div>
          
          <div class="card-domains">
            ${topDomains.map(domain => `<span class="domain-tag"><img src="${getLocalFaviconUrl(domain, 16)}" class="domain-favicon" alt="" />${domain.replace("www.", "")}</span>`).join("")}
          </div>
          
          <div class="card-summary">
            <div class="journey-summary">From "${firstPageTitle.substring(0, 30)}${firstPageTitle.length > 30 ? "..." : ""}" to "${lastPageTitle.substring(0, 30)}${lastPageTitle.length > 30 ? "..." : ""}"</div>
            ${session.summary ? `
            <div class="session-page-summary">
              <h4>Session Summary</h4>
              <div class="summary-content">${session.summary.substring(0, 200)}${session.summary.length > 200 ? "..." : ""}</div>
            </div>` : ""}
          </div>
        </div>
      `;
    } else {
      // Standard-width card with images on top, content below
      card.innerHTML = `
        <div class="card-image-section compact">
          ${heroImages.length > 1 ?
          `<div class="session-mosaic mosaic-${heroImages.length}">
              ${heroImages.map((img, i) => {
            const domain = extractDomainFromUrl(img.pageUrl || "");
            const faviconUrl = getFaviconUrl(domain);
            return `<div class="mosaic-item-wrapper mosaic-item-${heroImages.length}-${i + 1}">
                  <img src="${img.src}" alt="${img.alt || img.pageTitle || "Session image"}" 
                       class="mosaic-item hero-image-element" 
                       title="${img.pageTitle || ""}" 
                       data-page-url="${img.pageUrl || ""}">
                  <img src="${faviconUrl}" alt="Favicon for ${domain}" 
                       class="mosaic-favicon" 
                       title="${domain}">  
                </div>`;
          }).join("")}
            </div>` :
          `<img src="${heroImage.src}" alt="${heroImage.alt || pageTitle || "Session image"}" class="card-image hero-image-element">`
        }
        </div>
        <div class="card-content-section compact"${card.dataset.ageHue ? ` style="background-color: hsla(${card.dataset.ageHue}, 70%, ${card.dataset.ageLightness}%, 0.9)"` : ""}>
          <h3 class="card-title compact">${session.name || extractTitleFromSession(session) || "Browsing Session"}</h3>
          
          <div class="card-stats compact">
            <!-- Combined page count and favicon stack (compact version) -->
            <div class="stat-item pages-with-favicons">
              <span class="page-count">${displaySession.pages.length}</span>
              <div class="favicon-stack">
                ${topDomains.slice(0, 5).map((domain, index) =>
          `<img src="${getLocalFaviconUrl(domain, 16)}" 
                   class="stacked-favicon" 
                   style="z-index:${10 - index}; margin-left:${index * -6}px" 
                   title="${domain}" />`).join("")}
              </div>
            </div>
            <!-- Timeline visualization (compact version) -->
            <div class="stat-item timeline-visualization compact">
              <div class="timeline-bar">
                <div class="timeline-duration" 
                     style="width:${Math.min(100, Math.max(10, Math.log10(session.duration / 1000) * 20))}%" 
                     title="Duration: ${formattedDuration}"></div>
              </div>
              <div class="timeline-labels">
                <span class="duration-label">${formattedDuration}</span>
              </div>
            </div>
          </div>
          
          <div class="card-domains compact">
            ${topDomains.slice(0, 2).map(domain => `<span class="domain-tag"><img src="${getLocalFaviconUrl(domain, 16)}" class="domain-favicon" alt="" />${domain.replace("www.", "")}</span>`).join("")}
          </div>
          
          ${session.summary ? `
          <div class="session-page-summary compact">
            <div class="summary-content">${session.summary.substring(0, 100)}${session.summary.length > 100 ? "..." : ""}</div>
          </div>` : ""}
        </div>
      `;
    }
  } else {
    // Fallback layout for cards without images
    card.innerHTML = `
      <div class="card-content-section full-width">
        <h3 class="card-title">${session.name || extractTitleFromSession(session) || "Browsing Session"}</h3>
        
        <div class="card-stats">
          <!-- Combined page count and favicon stack -->
          <div class="stat-item pages-with-favicons">
            <span class="page-count">${displaySession.pages.length}</span>
            <div class="favicon-stack">
              ${topDomains.slice(0, 5).map((domain, index) =>
      `<img src="${getLocalFaviconUrl(domain, 16)}" 
                 class="stacked-favicon" 
                 style="z-index:${10 - index}; margin-left:${index * -6}px" 
                 title="${domain}" />`).join("")}
            </div>
          </div>
          <!-- Timeline visualization for duration and start time -->
          <div class="stat-item timeline-visualization">
            <div class="timeline-bar">
              <div class="timeline-duration" 
                   style="width:${Math.min(100, Math.max(10, Math.log10(session.duration / 1000) * 20))}%" 
                   title="Duration: ${formattedDuration}"></div>
            </div>
            <div class="timeline-labels">
              <span class="duration-label">${formattedDuration}</span>
              <span class="time-ago-label">${timeAgoString}</span>
            </div>
          </div>
        </div>
        
        <div class="card-domains">
          ${topDomains.map(domain => `<span class="domain-tag"><img src="${getLocalFaviconUrl(domain, 16)}" class="domain-favicon" alt="" />${domain.replace("www.", "")}</span>`).join("")}
        </div>
        
        <div class="card-journey">
          <span class="first-page" title="${firstPageTitle}">${firstPageTitle.substring(0, 20)}${firstPageTitle.length > 20 ? "..." : ""}</span>
          <span class="journey-arrow">→</span>
          <span class="last-page" title="${lastPageTitle}">${lastPageTitle.substring(0, 20)}${lastPageTitle.length > 20 ? "..." : ""}</span>
        </div>
        
        ${session.summary ? `
        <div class="session-page-summary">
          <h4>Session Summary</h4>
          <div class="summary-content">${session.summary.substring(0, 200)}${session.summary.length > 200 ? "..." : ""}</div>
        </div>` : ""}
      </div>
    `;
  }

  // Make the entire card clickable to open the modal
  card.addEventListener("click", (e) => {
    // Keep original pages in the session when showing modal
    const modalSession = { ...session };
    // If the click is on a mosaic image or favicon, navigate to that URL
    if ((e.target.classList.contains("mosaic-item") || e.target.classList.contains("mosaic-favicon")) &&
      (e.target.dataset.pageUrl || (e.target.closest(".mosaic-item-wrapper") &&
        e.target.closest(".mosaic-item-wrapper").querySelector(".mosaic-item").dataset.pageUrl))) {

      e.stopPropagation(); // Prevent opening the modal
      const url = e.target.dataset.pageUrl ||
        e.target.closest(".mosaic-item-wrapper").querySelector(".mosaic-item").dataset.pageUrl;
      window.open(url, "_blank");
    } else {
      // Otherwise show the session modal
      showSessionModal(modalSession);
    }
  });

  // Apply error handling to all hero images after card is created
  setupHeroImageErrorHandling(card);
  return card;
}

/**
 * Sets up error handling for all hero image elements in the card
 * This avoids inline event handlers which violate Content Security Policy
 * @param {HTMLElement} card - The card containing hero images
 */
function setupHeroImageErrorHandling(card) {
  // Find all hero image elements
  const heroImages = card.querySelectorAll(".hero-image-element");

  // Add error handling to each image
  heroImages.forEach(img => {
    img.addEventListener("error", function () {
      // Hide the image
      this.style.display = "none";

      // Add error class to parent container
      if (this.parentNode) {
        this.parentNode.classList.add("image-error");
      }

      console.error(`Failed to load hero image: ${this.src}`);
    });
  });
}

/**
 * Creates a mosaic layout of hero images for a session
 * @param {Object} session - Session data object with pages
 * @returns {Promise<HTMLElement|null>} - Mosaic container or null if no images
 */
export async function createSessionMosaic(session) {
  if (!session?.pages || session.pages.length === 0) {
    return null;
  }

  // Get hero images from all pages in the session
  let allImages = [];

  // Track seen URLs for this mosaic to avoid duplicates
  const localSeenUrls = new Set();

  // Collect hero images from all pages
  await Promise.all(session.pages.map(async (page) => {
    const images = await getHeroImagesForUrl(page.url);
    if (images && images.length > 0) {
      // Filter out images already seen globally or locally
      const uniqueImages = images.filter(img =>
        !globalSeenImageUrls.has(img.src) &&
        !localSeenUrls.has(img.src)
      );

      if (uniqueImages.length > 0) {
        // Store the page title and URL with the image for reference
        const enhancedImages = uniqueImages.map(img => {
          localSeenUrls.add(img.src);
          globalSeenImageUrls.add(img.src); // Track globally as well

          return {
            ...img,
            pageTitle: page.title,
            pageUrl: page.url
          };
        });
        allImages = [...allImages, ...enhancedImages];
      }
    }
  }));

  // If no images found, return null
  if (allImages.length === 0) {
    return null;
  }

  // Validate image URLs before displaying
  const validImages = allImages.filter(img => {
    if (!img || !img.src) {
      console.warn("Hero image missing src attribute:", img);
      return false;
    }

    // Basic URL validation
    try {
      // Check if it's a valid URL or a data URI
      if (img.src.startsWith("data:")) {
        return true;
      }
      try {
        Boolean(new URL(img.src));
        return true;
      } catch (e) {
        return false;
      }
    } catch (e) {
      console.warn("Invalid hero image URL:", img.src);
      return false;
    }
    return false;
  });

  if (!validImages.length) {
    console.warn("No valid hero images found");
    return;
  }

  // Create the mosaic container
  const mosaicContainer = document.createElement("div");
  mosaicContainer.className = "session-mosaic";

  // Only use up to 5 images for the mosaic
  const mosaicImages = validImages.slice(0, 5);

  // Add the images to the mosaic with different layout based on count
  mosaicImages.forEach((img, index) => {
    const imgElement = document.createElement("img");
    imgElement.src = img.src;
    imgElement.alt = img.alt || img.pageTitle || "";
    imgElement.className = `mosaic-item mosaic-item-${mosaicImages.length}-${index + 1}`;

    // Add error handling
    imgElement.onerror = function () {
      this.onerror = null;
      this.style.display = "none";
      if (this.parentNode) {
        this.parentNode.classList.add("image-error");
      }
      console.error(`Failed to load hero image: ${this.src}`);
    };

    // Add data attributes for tooltip/details
    imgElement.dataset.pageTitle = img.pageTitle || "";
    imgElement.dataset.pageUrl = img.pageUrl || "";

    // Add click handler to navigate to the page
    imgElement.addEventListener("click", (e) => {
      e.stopPropagation(); // Don't trigger session expansion
      if (img.pageUrl) {
        window.open(img.pageUrl, "_blank");
      }
    });

    // Add tooltip with page title on hover
    if (img.pageTitle) {
      imgElement.title = img.pageTitle;
    }

    mosaicContainer.appendChild(imgElement);
  });

  return mosaicContainer;
}

/**
 * Clears the global seen image URLs registry
 * Call this when refreshing sessions to allow images to appear again
 */
export function clearSeenHeroImages() {
  globalSeenImageUrls.clear();
}

// Cache for in-flight hero image requests and recent results
const heroImageRequestCache = {
  inFlight: new Map(), // URL -> Promise
  lastRequested: new Map(), // URL -> timestamp
  cooldownPeriod: 2000 // ms between allowed repeat requests
};

/**
 * Get hero images for a URL
 * Helper function copied from sessions.js to avoid circular dependencies
 * @param {string} url - URL to get hero images for
 * @returns {Promise<Array>} - Hero images or null
 */
async function getHeroImagesForUrl(url) {
  // Don't allow rapid repeated requests for the same URL
  const now = Date.now();
  const lastRequested = heroImageRequestCache.lastRequested.get(url) || 0;
  if (now - lastRequested < heroImageRequestCache.cooldownPeriod) {
    // Request made too recently, return cached result or null
    const existingRequest = heroImageRequestCache.inFlight.get(url);
    if (existingRequest) {
      return existingRequest;
    }
    return null;
  }

  // Check for in-flight request for this URL
  if (heroImageRequestCache.inFlight.has(url)) {
    return heroImageRequestCache.inFlight.get(url);
  }

  // Create a new request promise
  const requestPromise = new Promise((resolve) => {
    // Update cache
    heroImageRequestCache.lastRequested.set(url, now);

    // First check browserState if available (core shared data structure)
    if (typeof browserState !== "undefined" && browserState.heroImages && browserState.heroImages.get) {
      const heroImageData = browserState.heroImages.get(url);
      if (heroImageData && heroImageData.images) {
        resolve(heroImageData.images);
        return;
      }
    }

    // Then check local storage
    chrome.storage.local.get(["heroImages"], (result) => {
      const heroImagesStore = result.heroImages || {};
      if (heroImagesStore[url]) {
        resolve(heroImagesStore[url].images);
      } else {
        // If not in storage, try asking background script directly
        chrome.runtime.sendMessage({ action: "getHeroImagesForUrl", url: url }, (response) => {
          if (chrome.runtime.lastError) {
            console.error("❌ Error getting hero images:", chrome.runtime.lastError);
            resolve(null);
          } else if (response && response.images) {
            resolve(response.images);
          } else {
            resolve(null);
          }
        });
      }
    });
  });

  // Store the promise in the cache
  heroImageRequestCache.inFlight.set(url, requestPromise);

  // Remove from in-flight cache once resolved
  requestPromise.then(result => {
    heroImageRequestCache.inFlight.delete(url);
    return result;
  }).catch(() => {
    heroImageRequestCache.inFlight.delete(url);
    return null;
  });

  return requestPromise;
}
