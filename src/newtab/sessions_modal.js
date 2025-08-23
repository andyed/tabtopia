// Session Modal functionality for expanded card view

/**
 * Creates and shows a modal with expanded session details
 * @param {Object} session - The session to display in the modal
 * @returns {HTMLElement} - The created modal overlay element
 */
export function showSessionModal(session) {
  // Check if a modal already exists, if so, remove it
  removeExistingModals();
  
  // Create modal overlay
  const modalOverlay = document.createElement('div');
  modalOverlay.className = 'session-modal-overlay';
  document.body.appendChild(modalOverlay);
  
  // Get color from the card for visual consistency
  let colorStyle = '';
  const cardElement = document.querySelector(`.session-card[data-session-id="${session.id}"]`);
  if (cardElement) {
    const hue = cardElement.getAttribute('data-age-hue');
    const lightness = cardElement.getAttribute('data-age-lightness');
    if (hue && lightness) {
      const bgColor = `hsla(${hue}, 65%, ${lightness}%, 0.95)`;
      const accentColor = `hsla(${hue}, 65%, ${Math.min(parseFloat(lightness) + 10, 40)}%, 0.7)`;
      const cardColor = session.color ? session.color.background : '#1e2630';
      const cardTextColor = session.color ? session.color.text : '#ffffff';
  
      // Set time-of-day color based on hue for better visual harmony
      let timeColor = '#ffcc66'; // Default warm color
      
      // Adjust time color based on background hue
      if (hue) {
        const hueNum = parseInt(hue);
        if (hueNum >= 0 && hueNum < 60) {
          timeColor = '#66ccff'; // Cool blue for red/orange backgrounds
        } else if (hueNum >= 60 && hueNum < 180) {
          timeColor = '#ffcc66'; // Warm gold for green/teal backgrounds
        } else if (hueNum >= 180 && hueNum < 240) {
          timeColor = '#ff9966'; // Orange for blue backgrounds
        } else {
          timeColor = '#66ffcc'; // Teal for purple backgrounds
        }
      }
  
      colorStyle = `style="--modal-bg-color: ${cardColor}; --modal-text-color: ${cardTextColor}; --time-of-day-color: ${timeColor};"`;
    }
  }
  
  // Preprocess session data
  const processedSession = preprocessSessionData(session);
  
  // Format start date
  const startDate = new Date(processedSession.startTime);
  const dateOptions = {
    year: 'numeric', 
    month: 'short', 
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  };
  
  let formattedDate = 'Date unknown';
  let timeOfDay = '';
  
  if (!isNaN(startDate.getTime())) {
    formattedDate = startDate.toLocaleString(undefined, dateOptions);
    timeOfDay = getTimeOfDay(startDate);
    // Format date with time of day more prominently
    formattedDate = `<span class="modal-time-of-day">${timeOfDay}</span> ${formattedDate}`;
  }
  
  // Extract title from session or first page if needed
  const sessionTitle = processedSession.name || extractTitleFromSession(processedSession) || 'Browsing Session';
  
  // Create modal content
  modalOverlay.innerHTML = `
    <div class="session-modal" ${colorStyle}>
      <div class="session-modal-header">
        <div>
          <h2 class="session-modal-title">${sessionTitle}</h2>
          <div class="session-modal-stats">
            <span>${formattedDate}</span>
            <span>${processedSession.pages.length} page${processedSession.pages.length !== 1 ? 's' : ''}</span>
            <span>${processedSession.formattedDuration}</span>
          </div>
        </div>
        <button class="session-modal-close" aria-label="Close modal">&times;</button>
      </div>
      <div class="session-modal-content">
        <div id="session-modal-details" class="session-modal-details">
          Loading session details...
        </div>
      </div>
    </div>
  `;
  
  // Add modal to body
  document.body.appendChild(modalOverlay);
  
  // Reveal the modal with animation
  setTimeout(() => {
    modalOverlay.classList.add('active');
  }, 10);
  
  // Setup event listeners
  setupModalEventListeners(modalOverlay);
  
  // Populate modal content
  populateModalContent(session, modalOverlay.querySelector('#session-modal-details'));
  
  return modalOverlay;
}

/**
 * Sets up event listeners for the modal
 * @param {HTMLElement} modalOverlay - The modal overlay element
 */
function setupModalEventListeners(modalOverlay) {
  // Close button
  const closeButton = modalOverlay.querySelector('.session-modal-close');
  if (closeButton) {
    closeButton.addEventListener('click', () => {
      closeModal(modalOverlay);
    });
  }
  
  // Click outside to close
  modalOverlay.addEventListener('click', (event) => {
    if (event.target === modalOverlay) {
      closeModal(modalOverlay);
    }
  });
  
  // ESC key to close
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeModal(modalOverlay);
    }
  });
}

/**
 * Closes the modal with animation
 * @param {HTMLElement} modalOverlay - The modal overlay element
 */
function closeModal(modalOverlay) {
  modalOverlay.classList.remove('active');
  
  // Remove after animation completes
  setTimeout(() => {
    if (modalOverlay.parentNode) {
      modalOverlay.parentNode.removeChild(modalOverlay);
    }
  }, 300);
}

/**
 * Removes any existing modals from the DOM
 */
function removeExistingModals() {
  const existingModals = document.querySelectorAll('.session-modal-overlay');
  existingModals.forEach((modal) => {
    modal.parentNode.removeChild(modal);
  });
}

/**
 * Preprocesses session data to ensure it has all required fields with valid values
 * @param {Object} session - The raw session object
 * @returns {Object} - The processed session object
 */
function preprocessSessionData(session) {
  if (!session) return {};
  
  const processedSession = {...session};
  
  // Ensure session has pages
  if (!processedSession.pages) {
    processedSession.pages = [];
  }
  
  // Pre-process page data to ensure we have valid timestamps, titles and durations
  processedSession.pages = processedSession.pages.map((page, index) => {
    const processedPage = {...page};
    
    // Ensure the page has a valid timestamp
    const rawTimestamp = page.timestamp || page.visitTimestamp || page.lastVisitTime || session.startTime;
    const timestamp = new Date(rawTimestamp);
    
    if (!isNaN(timestamp.getTime())) {
      processedPage.processedTimestamp = timestamp;
    } else {
      // If no valid timestamp, estimate based on position in session
      const sessionStart = new Date(session.startTime || Date.now());
      processedPage.processedTimestamp = new Date(sessionStart.getTime() + (index * 60000)); // Add minutes per page
    }
    
    // Ensure the page has a valid title
    processedPage.processedTitle = page.title || extractTitleFromURL(page.url) || 'Unknown Page';
    
    return processedPage;
  });
  
  // Sort pages by timestamp
  processedSession.pages.sort((a, b) => a.processedTimestamp - b.processedTimestamp);
  
  // Calculate or validate session duration
  if (!processedSession.duration || processedSession.duration <= 0) {
    if (processedSession.pages.length >= 2) {
      const firstPage = processedSession.pages[0];
      const lastPage = processedSession.pages[processedSession.pages.length - 1];
      
      processedSession.duration = lastPage.processedTimestamp.getTime() - 
                                  firstPage.processedTimestamp.getTime() + 
                                  60000; // Add a minute for the last page
    } else if (processedSession.pages.length === 1) {
      processedSession.duration = 60000; // Default 1 minute for single page sessions
    } else {
      processedSession.duration = 0;
    }
  }
  
  // Format the session duration
  processedSession.formattedDuration = formatDuration(processedSession.duration);
  
  // Ensure we have valid timestamps for each page transition (for dwell times)
  processedSession.pages = processedSession.pages.map((page, index, pages) => {
    // Calculate dwell time if not provided
    if (!page.dwellTimeMs || page.dwellTimeMs <= 0) {
      if (index < pages.length - 1) {
        page.dwellTimeMs = pages[index + 1].processedTimestamp.getTime() - page.processedTimestamp.getTime();
      } else {
        // Last page, use a default duration or a percentage of session time
        page.dwellTimeMs = Math.max(processedSession.duration * 0.2, 30000); // At least 30 seconds
      }
    }
    return page;
  });
  
  return processedSession;
}

/**
 * Formats a duration in milliseconds to a human-readable string
 * @param {number} durationMs - Duration in milliseconds
 * @returns {string} - Formatted duration string
 */
function formatDuration(durationMs) {
  if (!durationMs || durationMs <= 0) {
    return 'Duration unknown';
  } 
  
  if (durationMs < 60000) {
    return `${Math.round(durationMs / 1000)}s duration`;
  } 
  
  if (durationMs < 3600000) {
    return `${Math.round(durationMs / 60000)}m duration`;
  }
  
  const hours = Math.floor(durationMs / 3600000);
  const minutes = Math.round((durationMs % 3600000) / 60000);
  return `${hours}h${minutes > 0 ? ` ${minutes}m` : ''} duration`;
}

/**
 * Populates the modal content with session details
 * @param {Object} session - The session object
 * @param {HTMLElement} container - The container element for the content
 */
async function populateModalContent(session, container) {
  if (!session || !container) return;
  
  const detailsContainer = container;
  detailsContainer.innerHTML = ''; // Clear loading message
  
  // Process the session data if not already done
  const processedSession = session.formattedDuration ? session : preprocessSessionData(session);
  
  // Create and add hero image
  const heroImageSection = await createModalHeroImage(processedSession);
  if (heroImageSection) {
    detailsContainer.appendChild(heroImageSection);
  } else if (processedSession.heroImageUrl) {
    const heroContainer = document.createElement('div');
    heroContainer.className = 'session-modal-hero';
    const heroImg = document.createElement('img');
    heroImg.src = processedSession.heroImageUrl;
    heroImg.alt = '';
    heroImg.className = 'modal-hero-image';
    heroImg.addEventListener('error', function() {
      this.style.display = 'none';
    });
    heroContainer.appendChild(heroImg);
    detailsContainer.appendChild(heroContainer);
  }
  const pagesUl = document.createElement('ul');
  pagesUl.className = 'session-page-list';
  
  // Create domains section
  const domainsSection = createModalDomains(processedSession);
  container.appendChild(domainsSection);
  
  // Create chronological list of pages
  const pagesList = document.createElement('div');
  pagesList.className = 'session-pages-section';
  
  const pagesTitle = document.createElement('h3');
  pagesTitle.textContent = 'Pages Visited';
  pagesList.appendChild(pagesTitle);
  
  // Sort pages chronologically
  const sortedPages = [...processedSession.pages].sort((a, b) => a.processedTimestamp - b.processedTimestamp);
  
  // Track the last displayed timestamp to avoid showing duplicate times
  let lastTimeStr = null;
  
  for (const page of sortedPages) {
    const pageItem = createPageListItem(page, processedSession, lastTimeStr);
    pagesUl.appendChild(pageItem);
    
    // Update the last displayed timestamp if this page showed one
    if (page.processedTimestamp) {
      const currentTimeStr = page.processedTimestamp.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
      lastTimeStr = currentTimeStr;
    }
  }
  
  pagesList.appendChild(pagesUl);
  container.appendChild(pagesList);
}

/**
 * Creates a hero image section for the modal
 * @param {Object} session - The session object
 * @returns {HTMLElement|null} - The hero image section element or null
 */
async function createModalHeroImage(session) {
  // Find the most significant page with an image
  for (const page of session.pages) {
    try {
      const images = await getHeroImagesForUrl(page.url);
      if (images && images.length > 0) {
        // Validate image URL before using it
        const heroImage = images[0];
        if (!heroImage || !heroImage.src) {
          console.warn('Hero image missing src attribute:', heroImage);
          continue;
        }
        
        // Validate URL format
        let isValidUrl = false;
        try {
          if (heroImage.src.startsWith('data:') || new URL(heroImage.src)) {
            isValidUrl = true;
          }
        } catch (e) {
          console.warn('Invalid hero image URL:', heroImage.src);
        }
        
        if (!isValidUrl) continue;
        
        const heroSection = document.createElement('div');
        heroSection.className = 'session-modal-hero';
        
        const img = document.createElement('img');
        img.src = heroImage.src;
        img.alt = page.title || 'Session image';
        img.onerror = function() {
          console.error(`Failed to load hero image: ${img.src}`);
          this.style.display = 'none';
          if (heroSection.parentElement) {
            heroSection.parentElement.removeChild(heroSection);
          }
        };
        
        heroSection.appendChild(img);
        return heroSection;
      }
    } catch (error) {
      console.error(`Error creating hero image for ${page.url}:`, error);
    }
  }
  
  return null;
}

/**
 * Creates a domains section for the modal with proportionally sized favicons in the header
 * @param {Object} session - The session object
 * @returns {HTMLElement} - The domains section element
 */
function createModalDomains(session) {
  // Create container with flex row layout for icons
  const domainsContainer = document.createElement('div');
  domainsContainer.className = 'session-domains-container';
  
  // Calculate domain counts and time spent
  const domains = session.pages.map(page => {
    try {
      return {
        domain: new URL(page.url).hostname.replace('www.', ''),
        dwellTimeMs: page.dwellTimeMs || 0,
        url: page.url
      };
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
  
  // Process domain statistics
  const domainStats = {};
  let totalPageCount = 0;
  let totalTimeMs = 0;
  
  domains.forEach(item => {
    if (!domainStats[item.domain]) {
      domainStats[item.domain] = { 
        count: 0, 
        timeMs: 0, 
        url: item.url 
      };
    }
    domainStats[item.domain].count++;
    domainStats[item.domain].timeMs += item.dwellTimeMs;
    totalPageCount++;
    totalTimeMs += item.dwellTimeMs;
  });
  
  // Convert to array and sort by count
  const topDomains = Object.entries(domainStats)
    .map(([domain, stats]) => ({
      domain,
      count: stats.count,
      timeMs: stats.timeMs,
      percentCount: (stats.count / totalPageCount) * 100,
      percentTime: totalTimeMs ? (stats.timeMs / totalTimeMs) * 100 : 0,
      url: stats.url
    }))
    .sort((a, b) => b.count - a.count);
  
  // Only create domain visualization if we have domains
  if (topDomains.length === 0) {
    return domainsContainer; // Return empty container
  }
  
  // Take only the top 8 domains for visualization
  const topDomainsList = topDomains.slice(0, 8);
  
  // Find the maximum count for scaling
  const maxCount = Math.max(...topDomainsList.map(d => d.count));
  
  // Create the domain icons container
  const domainIcons = document.createElement('div');
  domainIcons.className = 'domain-icons-container';
  
  // Create proportionally sized favicons for top domains
  topDomainsList.forEach(domain => {
    // Calculate size based on count relative to max count
    // Min size is 24px, max is 40px (reduced max size to prevent pixelation)
    const minSize = 24;
    const maxSize = 40;
    const size = minSize + ((maxSize - minSize) * (domain.count / maxCount));
    
    // Create favicon container
    const iconContainer = document.createElement('div');
    iconContainer.className = 'domain-icon-container';
    
    // Add badge with count - positioned above favicon
    const countBadge = document.createElement('span');
    countBadge.className = 'domain-count-badge';
    countBadge.textContent = domain.count;
    
    // Create favicon image with reduced max size to prevent pixelation
    const faviconImg = document.createElement('img');
    faviconImg.src = getFaviconDisplayUrl(domain.domain);
    faviconImg.className = 'domain-icon';
    faviconImg.width = size;
    faviconImg.height = size;
    faviconImg.title = `${domain.domain}: ${domain.count} visits`;
    faviconImg.alt = domain.domain;
    faviconImg.style.width = `${size}px`;
    faviconImg.style.height = `${size}px`;
    
    // Add error handler
    faviconImg.addEventListener('error', function() {
      // If favicon fails to load, create a domain initial fallback
      this.style.display = 'none';
      const fallback = document.createElement('div');
      fallback.className = 'domain-icon-fallback';
      fallback.style.width = `${size}px`;
      fallback.style.height = `${size}px`;
      fallback.style.fontSize = `${Math.max(12, size / 2)}px`;
      fallback.textContent = domain.domain.charAt(0).toUpperCase();
      fallback.title = `${domain.domain}: ${domain.count} visits`;
      iconContainer.appendChild(fallback);
    });
    
    // Append elements
    iconContainer.appendChild(countBadge);
    iconContainer.appendChild(faviconImg);
    domainIcons.appendChild(iconContainer);
  });
  
  domainsContainer.appendChild(domainIcons);
  return domainsContainer;
}

/**
 * Extracts a meaningful title from a session based on pages
 * @param {Object} session - The session object
 * @returns {string} - A title for the session
 */
function extractTitleFromSession(session) {
  if (!session || !session.pages || !session.pages.length) {
    return null;
  }
  
  // Try to get the first page with a title
  for (const page of session.pages) {
    if (page.title && page.title !== 'New Tab' && page.title !== 'about:blank') {
      return page.title;
    }
  }
  
  // If no good title found, try to extract from URL
  try {
    const firstValidPage = session.pages.find(p => p.url && !p.url.startsWith('chrome://') && !p.url.startsWith('about:'));
    if (firstValidPage) {
      const url = new URL(firstValidPage.url);
      return url.hostname.replace(/^www\./i, '');
    }
  } catch (e) {
    // URL parsing failed
  }
  
  return null;
}

/**
 * Extract a title from a URL
 * @param {string} url - The URL to extract a title from
 * @returns {string} - An extracted title or null
 */
function extractTitleFromURL(url) {
  if (!url) return null;
  
  try {
    const urlObj = new URL(url);
    // Remove www. prefix and get domain name
    const domain = urlObj.hostname.replace(/^www\./i, '');
    
    // If we have a path, try to extract meaningful info from it
    if (urlObj.pathname && urlObj.pathname !== '/' && urlObj.pathname.length > 1) {
      // Get the last path segment and decode it
      const pathSegments = urlObj.pathname.split('/');
      const lastSegment = pathSegments[pathSegments.length - 1];
      
      if (lastSegment) {
        // Clean up the segment
        return decodeURIComponent(lastSegment)
          .replace(/[-_]/g, ' ')  // Replace dashes and underscores with spaces
          .replace(/\.(html|php|asp|jsp)$/i, '')  // Remove file extensions
          .trim();
      }
    }
    
    return domain;
  } catch (e) {
    return url; // Return original URL as fallback
  }
}

/**
 * Creates a page list item for the modal
 * @param {Object} page - The page object
 * @param {Object} session - The session object
 * @param {string} lastTimeStr - The last displayed timestamp string
 * @returns {HTMLElement} - The page list item
 */
function createPageListItem(page, session, lastTimeStr) {
  const item = document.createElement('li');
  item.className = 'session-page-item';
  
  // Format timestamp with time of day
  let timeStr = '--:--';
  let timeOfDay = '';
  let showTime = true;
  
  if (page.processedTimestamp) {
    timeStr = page.processedTimestamp.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
    timeOfDay = getTimeOfDay(page.processedTimestamp);
    
    // Only show the time if it's different from the last displayed time
    if (lastTimeStr && timeStr === lastTimeStr) {
      showTime = false;
    }
  }
  
  // Format dwell time string
  let dwellStr = '';
  let dwellTime = page.dwellTimeMs;
  
  if (!dwellTime || dwellTime <= 0) {
    dwellStr = '\u2014'; // Em dash for unknown duration
  } else if (dwellTime < 1000) {
    dwellStr = '< 1s';
  } else if (dwellTime < 60000) {
    dwellStr = `${Math.round(dwellTime / 1000)}s`;
  } else if (dwellTime < 3600000) {
    dwellStr = `${Math.floor(dwellTime / 60000)}m`;
  } else {
    const hours = Math.floor(dwellTime / 3600000);
    const minutes = Math.floor((dwellTime % 3600000) / 60000);
    dwellStr = `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`;
  }
  
  // This code has been moved to the preprocessSessionData function

  // Create favicon and extract search term if available
  let domain = '';
  let searchTerm = null;
  
  try {
    const urlObj = new URL(page.url);
    domain = urlObj.hostname;
    
    // Extract search terms from common search engines
    searchTerm = extractSearchTerm(urlObj);
  } catch (e) {
    // Use fallback
  }
  
  // Only use the time without time of day label
  let timeDisplay = timeStr;
  
  // Initialize variables for domain pill
  let domainPillDiv = null;
  
  if (domain) {
    const pillClass = searchTerm ? 'session-page-domain-pill search-term' : 'session-page-domain-pill';
    const pillText = searchTerm || domain;
    // Use Google's favicon service like in the main sessions view
    const faviconUrl = getFaviconDisplayUrl(domain);
    
    // Create domain pill content using DOM API instead of innerHTML
    domainPillDiv = document.createElement('div');
    domainPillDiv.className = 'session-page-domain';
    
    const faviconImg = document.createElement('img');
    faviconImg.src = faviconUrl;
    faviconImg.className = 'session-page-favicon';
    faviconImg.alt = '';
    faviconImg.addEventListener('error', function() {
      this.style.display = 'none';
    });
    
    const pillSpan = document.createElement('span');
    pillSpan.className = pillClass;
    pillSpan.title = domain;
    pillSpan.textContent = pillText;
    
    domainPillDiv.appendChild(faviconImg);
    domainPillDiv.appendChild(pillSpan);
  }

  // Create elements using DOM API instead of innerHTML
  const timeDomainContainer = document.createElement('div');
  timeDomainContainer.className = 'session-page-time-domain-container';
  
  const timeDiv = document.createElement('div');
  timeDiv.className = 'session-page-time';
  timeDiv.style.alignSelf = 'flex-start';
  timeDiv.title = timeOfDay;
  timeDiv.textContent = timeDisplay;
  
  // Only add the time div if we're showing the time
  if (showTime) {
    timeDomainContainer.appendChild(timeDiv);
  }
  
  // If we have domain info, add the domain pill we created earlier
  if (domainPillDiv) {
    timeDomainContainer.appendChild(domainPillDiv);
  }
  
  // Create title section
  const titleDiv = document.createElement('div');
  titleDiv.className = 'session-page-title';
  
  const titleLink = document.createElement('a');
  titleLink.href = page.url;
  titleLink.className = 'session-page-link';
  titleLink.target = '_blank';
  titleLink.textContent = page.processedTitle || page.title || domain || page.url;
  
  titleDiv.appendChild(titleLink);
  
  // Create dwell time section
  const dwellDiv = document.createElement('div');
  dwellDiv.className = 'session-page-dwell';
  dwellDiv.textContent = dwellStr;
  
  // Add all sections to the item
  item.appendChild(timeDomainContainer);
  item.appendChild(titleDiv);
  item.appendChild(dwellDiv);
  
  // Add link to full URL as tooltip
  item.title = page.url;
  
  // Add click handler to open the page
  item.addEventListener('click', () => {
    window.open(page.url, '_blank');
  });
  
  // If there's referral info, add it
  if (page.referral) {
    const referralDiv = document.createElement('div');
    referralDiv.className = 'session-page-referral';
    
    if (page.referral.linkText) {
      referralDiv.textContent = `Clicked: "${page.referral.linkText}"`;
    } else if (page.referral.referringURL) {
      referralDiv.textContent = `From: ${new URL(page.referral.referringURL).hostname}`;
    }
    
    if (referralDiv.textContent) {
      item.insertAdjacentElement('afterend', referralDiv);
    }
  }
  
  return item;
}

/**
 * Get the time of day category (Morning, Afternoon, Evening, Night) based on the hour
 * Always uses the user's local timezone since Date.getHours() returns local hour
 * @param {Date} date - The date object to categorize
 * @returns {string} - The time of day category
 */
function getTimeOfDay(date) {
  if (!date || isNaN(date.getTime())) return '';
  
  const hour = date.getHours();
  
  if (hour >= 5 && hour < 12) {
    return 'Morning';
  } else if (hour >= 12 && hour < 17) {
    return 'Afternoon';
  } else if (hour >= 17 && hour < 21) {
    return 'Evening';
  } else {
    return 'Night';
  }
}

/**
 * Get hero images for a URL
 * Helper function copied from hero_images_display.js
 * @param {string} url - URL to get hero images for
 * @returns {Promise<Array>} - Hero images or null
 */
async function getHeroImagesForUrl(url) {
  return new Promise((resolve) => {
    // First check browserState if available (core shared data structure)
    if (typeof browserState !== 'undefined' && browserState.heroImages && browserState.heroImages.get) {
      const heroImageData = browserState.heroImages.get(url);
      if (heroImageData && heroImageData.images) {
        console.log(`🖼️ Found hero images for ${url} in browserState`, heroImageData.images);
        return resolve(heroImageData.images);
      }
    }
    
    // Then check local storage
    chrome.storage.local.get(['heroImages'], (result) => {
      const heroImagesStore = result.heroImages || {};
      if (heroImagesStore[url]) {
        console.log(`🖼️ Found hero images for ${url} in local storage`, heroImagesStore[url].images);
        resolve(heroImagesStore[url].images);
      } else {
        // If not in storage, try asking background script directly
        console.log(`🔄 Requesting hero images for ${url} from background script`);
        chrome.runtime.sendMessage({ action: 'getHeroImagesForUrl', url: url }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('❌ Error getting hero images:', chrome.runtime.lastError);
            resolve(null);
          } else if (response && response.images) {
            console.log(`✅ Received hero images for ${url} from background script`, response.images);
            resolve(response.images);
          } else {
            console.warn(`⚠️ No hero images found for ${url}`);
            resolve(null);
          }
        });
      }
    });
  });
}

/**
 * Gets a favicon URL for a domain or URL
 * @param {string} pageUrlOrDomain - Domain or full URL
 * @returns {string} - URL to favicon
 */
function getFaviconDisplayUrl(pageUrlOrDomain) {
  try {
    let domain = pageUrlOrDomain;
    // If it's a full URL, extract the hostname
    if (pageUrlOrDomain.includes('://')) {
      domain = new URL(pageUrlOrDomain).hostname;
    }
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  } catch (e) {
    console.warn('Could not generate favicon URL for:', pageUrlOrDomain, e);
    return ''; // Return empty or a default placeholder icon URL
  }
}
