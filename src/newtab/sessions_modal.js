// Session Modal functionality for expanded card view
import { getCachedSummary, createTruncatedSummary, summaryCache } from './readout.js';
// Note: D3 is loaded globally via script tag in HTML files

// Global variables
let lastModalId = 0;
let graphNodesReady = false;
let tooltipElement = null; // Global reference to the tooltip element
let hoverTimeout = null; // For debouncing hover effects
let activeHighlightURL = null; // Track currently highlighted URL

// Exports
export { showSessionModal, highlightGraphNodeForUrl, unhighlightAllGraphNodes };


/**
 * Creates and shows a modal with expanded session details
 * @param {Object} session - The session to display in the modal
 * @returns {HTMLElement} - The created modal overlay element
 */
function showSessionModal(session) {
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
  processedSession.formattedDuration = formatDwellDuration(processedSession.duration);
  
  // Ensure we have valid timestamps for each page transition (for dwell times)
  console.log(`[Dwell Time] Processing dwell times for ${processedSession.pages.length} pages in session ${processedSession.id}`);
  
  processedSession.pages = processedSession.pages.map((page, index, pages) => {
    // Debug log initial dwell time state
    console.log(`[Dwell Time] Page ${index} (${new URL(page.url).hostname}): Initial dwellTimeMs = ${page.dwellTimeMs}`);
    
    // Calculate dwell time if not provided
    if (!page.dwellTimeMs || page.dwellTimeMs <= 0) {
      if (index < pages.length - 1) {
        // Calculate based on next page timestamp
        const oldValue = page.dwellTimeMs;
        page.dwellTimeMs = pages[index + 1].processedTimestamp.getTime() - page.processedTimestamp.getTime();
        
        // Ensure we have a minimum reasonable dwell time
        if (page.dwellTimeMs < 1000) {
          page.dwellTimeMs = 5000; // Default minimum of 5 seconds
        }
        
        console.log(`[Dwell Time] Page ${index}: Calculated from next page timestamp. Was: ${oldValue}, Now: ${page.dwellTimeMs}ms`);
      } else {
        // Last page, use a default duration or a percentage of session time
        const oldValue = page.dwellTimeMs;
        page.dwellTimeMs = Math.max(processedSession.duration * 0.2, 30000); // At least 30 seconds
        
        console.log(`[Dwell Time] Page ${index} (LAST PAGE): Using fallback calculation. Was: ${oldValue}, Now: ${page.dwellTimeMs}ms (20% of session duration: ${processedSession.duration * 0.2}ms)`);
      }
    }
    
    // Always ensure dwellTimeMs has a valid numeric value
    if (isNaN(page.dwellTimeMs) || page.dwellTimeMs <= 0) {
      page.dwellTimeMs = 5000; // Default fallback
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
function formatDwellDuration(durationMs) {
  // Convert input to a number if it isn't already
  durationMs = parseFloat(durationMs);
  
  // Debug logging for duration calculations
  if (isNaN(durationMs)) {
    console.log(`[Duration Debug] Showing 'Duration unknown' because:`, {
      durationValue: durationMs,
      isNull: durationMs === null,
      isUndefined: durationMs === undefined,
      isZero: durationMs === 0,
      isNegative: durationMs < 0,
      typeOf: typeof durationMs,
      stack: new Error().stack.split('\n').slice(1, 4).join('\n')
    });
    return 'Duration unknown';
  }
  
  // Handle negative durations
  if (durationMs < 0) {
    console.log(`[Duration Debug] Negative duration found:`, durationMs);
    return 'Duration unknown';
  }
  
  // Handle zero or very small durations
  if (durationMs === 0) {
    console.log(`[Duration Debug] Zero duration - using brief view time message`);
    return 'Brief view';
  }
  
  if (durationMs < 1000) {
    return '< 1s duration';
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
  
  // Clear existing content
  container.innerHTML = '';
  
  // Check if session is long enough to warrant a graph
  const GRAPH_THRESHOLD = 8;
  const shouldShowGraph = session.pages && session.pages.length >= GRAPH_THRESHOLD;
  
  // Create a flex container for side-by-side layout
  const flexContainer = document.createElement('div');
  flexContainer.className = 'session-content-flex-container';
  container.appendChild(flexContainer);
  
  // If the session is long enough, add a graph visualization
  if (shouldShowGraph) {
    // Create a column for the graph
    const graphColumn = document.createElement('div');
    graphColumn.className = 'session-graph-column';
    flexContainer.appendChild(graphColumn);
    
    createSessionGraph(session, graphColumn);
    
    // Create a column for the session details
    const detailsColumn = document.createElement('div');
    detailsColumn.className = 'session-details-column';
    flexContainer.appendChild(detailsColumn);
    
    // Use detailsColumn as the container for page list
    container = detailsColumn;
  }
  
  // Process the session data if not already done
  const processedSession = session.formattedDuration ? session : preprocessSessionData(session);
  
  // Create and add hero image
  const heroImageSection = await createModalHeroImage(processedSession);
  if (heroImageSection) {
    container.appendChild(heroImageSection);
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
    container.appendChild(heroContainer);
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
 * Extracts a meaningful title from a session based on pages and link text
 * @param {Object} session - The session object
 * @returns {string} - A descriptive title for the session
 */
export function extractTitleFromSession(session) {
  if (!session || !session.pages || !session.pages.length) {
    return null;
  }
  
  // Find the most interesting/significant page in the session
  // First look for pages with referral link text as they're often most meaningful
  let significantPage = null;
  let linkText = null;
  
  // First check for pages with link text (clicked links)
  for (const page of session.pages) {
    if (page.referral && page.referral.linkText && 
        page.title && page.title !== 'New Tab' && page.title !== 'about:blank') {
      significantPage = page;
      linkText = page.referral.linkText;
      break;
    }
  }
  
  // If no page with link text, check for search query pages
  if (!significantPage) {
    for (const page of session.pages) {
      const searchQuery = page.searchQuery || (page.processedData && page.processedData.searchQuery);
      if (searchQuery) {
        significantPage = page;
        linkText = searchQuery;
        break;
      }
    }
  }
  
  // If still no significant page found, take the first page with a title
  if (!significantPage) {
    significantPage = session.pages.find(p => 
      p.title && p.title !== 'New Tab' && p.title !== 'about:blank' &&
      p.url && !p.url.startsWith('chrome://') && !p.url.startsWith('about:'));
  }
  
  // If we have a significant page, create a descriptive title
  if (significantPage) {
    // Get the domain part
    let domain = '';
    try {
      const url = new URL(significantPage.url);
      domain = url.hostname.replace(/^www\./i, '');
    } catch (e) {
      // URL parsing failed
      domain = 'website';
    }
    
    // Truncate domain if too long
    if (domain.length > 20) {
      domain = domain.substring(0, 18) + '...';
    }
    
    // If we have link text, create a title in the format: "domain → (linkText)"
    if (linkText) {
      // Truncate link text if too long
      const maxLinkTextLength = 40;
      const shortenedLinkText = linkText.length > maxLinkTextLength ? 
        linkText.substring(0, maxLinkTextLength - 3) + '...' : 
        linkText;
      
      return `${domain} → "${shortenedLinkText}"`;
    }
    
    // If no link text but we have a title, use domain + title
    if (significantPage.title) {
      const maxTitleLength = 40;
      const shortenedTitle = significantPage.title.length > maxTitleLength ?
        significantPage.title.substring(0, maxTitleLength - 3) + '...' :
        significantPage.title;
        
      return `${domain}: ${shortenedTitle}`;
    }
    
    // Fallback to just domain
    return domain;
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
  item.setAttribute('data-url', page.url);
  
  // Set a consistent ID to enable bidirectional highlighting
  const safeId = `page-item-${btoa(page.url).replace(/[=+/]/g, '-')}`;
  item.id = safeId;
  
  // We'll use direct event handlers on the item to make sure they're applied
  const pageUrl = page.url; // Store URL in closure to ensure it's available in event handlers
  
  // These are the event handlers for the list item
  function handleMouseEnter() {
    // Clear any pending unhighlight operations
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      hoverTimeout = null;
    }
    
    // Set this as the active highlighted URL
    activeHighlightURL = pageUrl;
    
    console.log('Page item mouseenter:', pageUrl);
    if (graphNodesReady) {
      highlightGraphNodeForUrl(pageUrl);
      // Also highlight the list item itself
      item.classList.add('highlighted');
    } else {
      console.log('Graph not ready yet, skipping highlight');
    }
  }
  
  function handleMouseLeave() {
    console.log('Page item mouseleave:', pageUrl);
    // Remove highlight from this item
    item.classList.remove('highlighted');
    
    // Only unhighlight if this is still the active URL
    if (activeHighlightURL === pageUrl) {
      // Use longer delay and debounce to prevent flickering
      hoverTimeout = setTimeout(() => {
        unhighlightAllGraphNodes();
        activeHighlightURL = null;
      }, 150); // Increased timeout for better stability
    }
  }
  
  // Attach event handlers directly
  item.onmouseenter = handleMouseEnter;
  item.onmouseleave = handleMouseLeave;
  
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
  
  // Always show some kind of time value, no more em dashes
  if (!dwellTime || dwellTime <= 0) {
    dwellStr = '5s'; // Default minimum value instead of em dash
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
  
  // Dwell time removed from list view per request
  // But we still calculate it for graph visualization
  
  // Add main sections to the item
  item.appendChild(timeDomainContainer);
  item.appendChild(titleDiv);
  
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
  
  // Add page summary if available
  if (page.url && !page.url.startsWith('chrome://') && !page.url.startsWith('chrome-extension://')) {
    const summaryContainer = document.createElement('div');
    summaryContainer.className = 'session-page-summary';
    
    // Check if we already have a cached summary
    const cachedSummary = getCachedSummary(page.url);
    
    if (cachedSummary) {
      // If we have a cached summary, display it
      summaryContainer.innerHTML = createTruncatedSummary(cachedSummary);
    } else {
      // Otherwise show a placeholder and attempt to queue the summary generation
      summaryContainer.innerHTML = '<div class="summary-loading">Generating summary...</div>';
      
      // Try to generate a summary asynchronously
      setTimeout(() => {
        // Add this URL to the summary queue in readout.js
        if (typeof summaryQueue !== 'undefined') {
          summaryQueue.add(page.url);
          if (typeof processSummaryQueue === 'function') {
            processSummaryQueue().catch(console.error);
          }
          
          // Poll for summary updates
          const checkInterval = setInterval(() => {
            const newSummary = getCachedSummary(page.url);
            if (newSummary) {
              clearInterval(checkInterval);
              summaryContainer.innerHTML = createTruncatedSummary(newSummary);
            }
          }, 2000);
          
          // Clean up the interval after 30 seconds if summary never arrives
          setTimeout(() => clearInterval(checkInterval), 30000);
        } else {
          summaryContainer.innerHTML = ''; // Hide placeholder if queue isn't available
        }
      }, 100);
    }
    
    // Add summary container after the list item
    item.insertAdjacentElement('afterend', summaryContainer);
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

// Cache for in-flight hero image requests and recent results
const heroImageRequestCache = {
  inFlight: new Map(), // URL -> Promise
  lastRequested: new Map(), // URL -> timestamp
  cooldownPeriod: 2000 // ms between allowed repeat requests
};

/**
 * Helper function copied from hero_images_display.js
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
    if (typeof browserState !== 'undefined' && browserState.heroImages && browserState.heroImages.get) {
      const heroImageData = browserState.heroImages.get(url);
      if (heroImageData && heroImageData.images) {
        resolve(heroImageData.images);
        return;
      }
    }
    
    // Then check local storage
    chrome.storage.local.get(['heroImages'], (result) => {
      const heroImagesStore = result.heroImages || {};
      if (heroImagesStore[url]) {
        resolve(heroImagesStore[url].images);
      } else {
        // If not in storage, try asking background script directly
        chrome.runtime.sendMessage({ action: 'getHeroImagesForUrl', url: url }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('❌ Error getting hero images:', chrome.runtime.lastError);
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

/**
 * Creates a force-directed graph visualization for session navigation
 * @param {Object} session - The session object containing pages
 * @param {HTMLElement} container - The container element to place the graph
 */
function createSessionGraph(session, container) {
  // Check for required dependencies and parameters
  if (!session || !session.pages || !container || !window.d3) {
    console.error('Missing dependencies or parameters for graph creation');
    return;
  }
  
  // Set dimensions
  const width = container.clientWidth;
  const height = container.clientHeight || 400; // Use container height or default to 400px
  
  // Create graph container
  const graphContainer = document.createElement('div');
  graphContainer.className = 'session-graph-container';
  
  // Create header - this will be our main heading container
  const header = document.createElement('div');
  header.className = 'session-graph-heading';
  
  // Create title element
  const title = document.createElement('h3');
  title.className = 'session-graph-title';
  title.textContent = 'Session Graph';
  
  // Create view modes container
  const graphViewModes = document.createElement('div');
  graphViewModes.className = 'session-graph-controls';
  
  // Create controls
  const controls = document.createElement('div');
  controls.className = 'session-graph-mode-buttons';
  
  // Define switchViewMode function at this scope level so it's accessible to the button event listeners
  function switchViewMode(mode) {
    if (mode === currentViewMode) return;
    currentViewMode = mode;
    
    // Update button styles
    timeBtn.className = mode === 'time' ? 'session-graph-btn active' : 'session-graph-btn';
    domainBtn.className = mode === 'domain' ? 'session-graph-btn active' : 'session-graph-btn';
    
    // Update visualization
    // Re-process data with the new view mode
    const { nodes, links } = processSessionData(session, width, height);
    createVisualization(nodes, links, mode, linksGroup, nodesGroup, width, height, { value: graphNodesReady });
  }
  
  // Add view mode buttons
  const timeBtn = document.createElement('button');
  timeBtn.className = 'session-graph-btn';
  timeBtn.textContent = 'Time';
  timeBtn.addEventListener('click', () => switchViewMode('time'));
  
  const domainBtn = document.createElement('button');
  domainBtn.className = 'session-graph-btn active';
  domainBtn.textContent = 'Domain';
  domainBtn.addEventListener('click', () => switchViewMode('domain'));
  
  // Add buttons to controls
  controls.appendChild(timeBtn);
  controls.appendChild(domainBtn);
  
  // Add title and controls to header
  graphViewModes.appendChild(title);
  graphViewModes.appendChild(controls);
  
  // Add header to container
  graphContainer.appendChild(graphViewModes);
  
  // Create SVG for the graph
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('session-graph-svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  
  // Create tooltip
  tooltipElement = document.createElement('div');
  tooltipElement.className = 'graph-tooltip';
  
  // Add SVG and tooltip to the graph container
  // Note: we don't append header here since graphViewModes is our header
  graphContainer.appendChild(svg);
  graphContainer.appendChild(tooltipElement);
  
  // Add the graph container to the provided container
  container.appendChild(graphContainer);
  
  // Process session data to create nodes and links
  let currentSession = session;
  let currentSessionPages = [];
  let currentViewMode = 'domain'; // Default to domain view
  // Use the global graphNodesReady variable instead of declaring a local one
  
  // Create a D3 selection for the SVG
  const svgSelection = window.d3.select(svg);
  
  // Create containers for links and nodes
  const g = svgSelection.append('g');
  const linksGroup = g.append('g').attr('class', 'graph-links');
  const nodesGroup = g.append('g').attr('class', 'graph-nodes');
  
  // Create zoom behavior
  const zoom = window.d3.zoom()
    .scaleExtent([0.1, 3])
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
    });
  
  svgSelection.call(zoom);
  
  // Process data and create the visualization
  const { nodes, links } = processSessionData(session, width, height);
  // Reset the global flag when creating a new visualization
  graphNodesReady = false;
  
  // Simply pass needed parameters
  createVisualization(nodes, links, currentViewMode, linksGroup, nodesGroup, width, height);
  
  // Add a small delay to make sure event listeners are attached properly
  console.log('Initializing graph event handling with a small delay');
  setTimeout(() => {
    // Force the graphNodesReady flag to true after a delay
    graphNodesReady = true;
    console.log('Delayed graph initialization complete, ready for interactions. graphNodesReady =', graphNodesReady);
  }, 500);
}
  /**
   * Process the session data to create nodes and links
   * @param {Object} session - The session object containing pages data
   * @param {number} width - The width of the graph container
   * @param {number} height - The height of the graph container
   */
  function processSessionData(session, width, height) {
    if (!session.pages || session.pages.length === 0) return { nodes: [], links: [] };
    
    // Define nodes and links arrays
    const nodes = [];
    const links = [];
    
    const nodesMap = new Map();
    const timeExtent = window.d3.extent(session.pages, p => p.timestamp);
    
    // Function to get the domain from a URL
    function getDomainFromUrl(url) {
      try {
        return new URL(url).hostname;
      } catch (e) {
        return '';
      }
    }
    
    // Create nodes from pages
    session.pages.forEach((page, index) => {
      if (!page.url) return;
      
      const domain = getDomainFromUrl(page.url);
      if (!domain) return;
      
      const timestamp = page.timestamp || page.visitTimestamp || Date.now();
      // Calculate normalized dwell time for node sizing
      // Ensure dwellTimeMs is always stored as a number, not a string
      const dwellTimeMs = parseFloat(page.dwellTimeMs || 0);
      
      // Log dwell time data for debugging
      if (index < 3 || index > nodes.length - 3) {
        console.log(`[Graph Node] Page ${index}: dwellTimeMs type = ${typeof dwellTimeMs}, value = ${dwellTimeMs}`, {
          originalValue: page.dwellTimeMs,
          originalType: typeof page.dwellTimeMs,
          url: page.url
        });
      }
      
      const node = {
        id: index, // Use index as ID to ensure uniqueness
        url: page.url,
        title: page.title || page.url,
        domain: domain,
        timestamp: timestamp, // Ensure a valid timestamp
        favicon: getFaviconDisplayUrl(domain),
        referral: page.referral,
        dwellTimeMs: dwellTimeMs, // Store dwell time for node sizing
        // Set initial positions to prevent NaN
        x: Math.random() * width,
        y: Math.random() * height
      };
      
      nodes.push(node);
      nodesMap.set(index, node);
    });

    // Track domains for domain transitions
    let lastDomainNode = null;
    let currentDomain = null;
    let domainNodes = new Map(); // domain -> first node in that domain
    
    // Process links between pages with a more selective connectivity model
    // This creates a sparser, more meaningful graph
    for (let i = 0; i < nodes.length - 1; i++) {
      const currentNode = nodes[i];
      const nextNode = nodes[i + 1];
      const timeDiff = nextNode.timestamp - currentNode.timestamp;
      const isDomainChange = currentNode.domain !== nextNode.domain;
      
      // Get dwell times to use for link importance evaluation
      const currentDwellTime = currentNode.dwellTimeMs || 0;
      const isSignificantDwell = currentDwellTime > 20000; // > 20 seconds is significant
      
      // Track the first node we see for each domain
      if (!domainNodes.has(currentNode.domain)) {
        domainNodes.set(currentNode.domain, currentNode);
      }
      
      // IMPROVED FILTERING: Balance between showing relevant links and not being too sparse
      // 1. Always show domain changes (relaxed from requiring dwell time)
      // 2. Same domain with moderate time gap (30+ seconds)
      // 3. Any page with moderate dwell time
      if (isDomainChange || 
          timeDiff > 30000 || 
          currentDwellTime > 10000) { // Relaxed threshold to ensure we see connections
        
        links.push({
          source: currentNode,
          target: nextNode,
          value: isDomainChange ? 1.8 : 1.2, // Stronger for domain changes
          type: 'sequential',
          // Store dwell time for tooltip/debug
          timeDiff: timeDiff,
          dwellTime: currentDwellTime
        });
      }
      
      // Track domain transitions for domain-transition links
      // IMPROVED: More selective about domain transition links
      if (isDomainChange) {
        if (currentDomain !== currentNode.domain) {
          currentDomain = currentNode.domain;
          // Only track as last domain node if there was significant dwell
          if (currentDwellTime > 10000) {
            lastDomainNode = currentNode;
          }
        }
        
        // When we change domains, add domain transition links more liberally
        // to ensure graph connectivity isn't too sparse
        if (lastDomainNode && 
            lastDomainNode !== currentNode && 
            timeDiff < 300000) { // Back to 5 min window to ensure we see connections
          
          links.push({
            source: lastDomainNode,
            target: nextNode,
            value: 0.7, // Weaker connection
            type: 'domain-transition'
          });
        }
      }
    }
    
    // Add referral links - these are high-value connections and should ALWAYS be shown
    // We'll track the referrals we find to ensure we have some connectivity
    let referralCount = 0;
    
    nodes.forEach((node) => {
      if (node.referral && node.referral.referringURL) {
        // Try to find the referring node
        const referringNode = nodes.find(n => n.url === node.referral.referringURL);
        if (referringNode && referringNode !== node) {
          // Add a stronger link for actual referrals
          links.push({
            source: referringNode,
            target: node,
            value: 2.5, // Strongest connection
            type: 'referral'
          });
          referralCount++;
        }
      }
    });
    
    // If we still have no links at all, ensure minimum connectivity by adding sequential links
    // between all adjacent pages
    if (links.length === 0) {
      console.log('No links found, adding minimum sequential links for connectivity');
      for (let i = 0; i < nodes.length - 1; i++) {
        links.push({
          source: nodes[i],
          target: nodes[i + 1],
          value: 1.0, // Basic connection
          type: 'sequential',
          isBackupLink: true // Mark as backup link for debugging
        });
      }
    }
    
    // Return the processed nodes and links
    return { nodes, links };
  }
  
  /**
   * Create the force-directed graph visualization
   * @param {Array} nodes - Array of node objects
   * @param {Array} links - Array of link objects
   * @param {string} viewMode - The current view mode ('time' or 'domain')
   * @param {Object} linksGroup - D3 selection for links container
   * @param {Object} nodesGroup - D3 selection for nodes container
   * @param {number} width - The width of the graph container
   * @param {number} height - The height of the graph container
   */
  function createVisualization(nodes, links, viewMode, linksGroup, nodesGroup, width, height) {
    if (!nodes || nodes.length === 0) return;
    
    // Clear any existing visualization
    linksGroup.selectAll('*').remove();
    nodesGroup.selectAll('*').remove();
    
    // Create a time scale for the x-axis with safety checks
    let timeExtent = window.d3.extent(nodes, d => d.timestamp);
    
    // Handle edge cases where timestamps might be invalid
    if (!timeExtent[0] || !timeExtent[1] || timeExtent[0] === timeExtent[1]) {
      const now = Date.now();
      timeExtent = [now - 3600000, now]; // Default to a 1-hour range
    }
    
    const timeScale = window.d3.scaleLinear()
      .domain(timeExtent)
      .range([50, width - 50]);
    
    // Assign initial positions with jitter to prevent clumping
    nodes.forEach(node => {
      // Position x with random jitter across width
      const jitterX = Math.random() * 80 - 40; // Random offset between -40 and 40
      node.x = (width / 2) + jitterX;
      
      // Position y with domain-based spread plus jitter
      const domainHash = hashString(node.domain);
      const heightSpread = height * 0.7;
      const centerY = height * 0.5;
      const jitterY = Math.random() * 50 - 25; // Random offset between -25 and 25
      node.y = centerY + (domainHash * heightSpread - heightSpread/2) / 100 + jitterY;
    });

    // Create simulation with optimized parameters based on graph.js
    // First ensure all links reference node objects, not just URLs or IDs
    links.forEach(link => {
      // Convert source/target from ID/URL to direct object references
      if (typeof link.source === 'string') {
        const sourceNode = nodes.find(n => n.url === link.source || n.id === link.source);
        if (sourceNode) link.source = sourceNode;
      }
      if (typeof link.target === 'string') {
        const targetNode = nodes.find(n => n.url === link.target || n.id === link.target);
        if (targetNode) link.target = targetNode;
      }
    });
    
    const simulation = window.d3.forceSimulation(nodes)
      .force('link', window.d3.forceLink(links)
        .id(d => d.url)
        .distance(100) // Increased distance for better node separation
        .strength(0.6)) // Slightly reduced to maintain structured layout better
      .force('charge', window.d3.forceManyBody()
        .strength(-130) // Stronger repulsion
        .distanceMin(20) // Minimum distance for charge effect
        .distanceMax(300)) // Maximum distance for charge effect
      .force('center', window.d3.forceCenter(width / 2, height / 2).strength(0.08)) // Reduced center pull
      .force('collision', window.d3.forceCollide().radius(15).strength(0.8)) // Stronger collision avoidance
      .alphaDecay(0.04) // Slightly slower decay for better relaxation
      .velocityDecay(0.35) // Slightly reduced damping
      .alpha(1); // Start with maximum heat
    
    // Add time-based positioning force for time view
    if (viewMode === 'time') {
      // Cap the x-position to keep nodes within the visible area
      const maxX = width - 50;
      const minX = 50;
      
      // Create a time scale for y-axis for top-down distribution (recent at top)
      const timeScaleY = window.d3.scaleLinear()
        .domain(timeExtent)
        .range([80, height - 80]); // Top to bottom with more padding
      
      // Group nodes by domain for domain-based horizontal positioning
      const domainMap = {};
      nodes.forEach(node => {
        if (!domainMap[node.domain]) {
          domainMap[node.domain] = [];
        }
        domainMap[node.domain].push(node);
      });
      
      // Calculate horizontal positions for domains
      const domains = Object.keys(domainMap);
      const domainScale = window.d3.scalePoint()
        .domain(domains)
        .range([minX + 50, maxX - 50])
        .padding(0.5);
        
      simulation
        // Use very strong horizontal force to maintain strict domain columns
        .force('x', window.d3.forceX(d => {
          // Get exact fixed position for this domain with zero jitter
          const domainPosition = domainScale(d.domain) || width / 2;
          // Ensure the position is valid and store it as a fixed position
          d.fx = domainPosition; // Fixed X position for perfect column alignment
          return domainPosition;
        }).strength(1.0)) // Maximum strength for perfect column alignment
        .force('y', window.d3.forceY(d => {
          // Top-down distribution: most recent (highest timestamp) at top
          if (d.timestamp && !isNaN(d.timestamp)) {
            // Use timestamp for accurate vertical positioning
            const yPos = timeScaleY(d.timestamp);
            const boundedY = Math.max(80, Math.min(height - 80, yPos));
            
            // Store as semi-fixed position (we'll allow some minor adjustment)
            // Using fy with high strength rather than perfect fixing to allow small adjustments
            // between nodes with very similar timestamps
            if (!d.dragging) { // Don't fix Y during active dragging
              d.fy = boundedY;
            }
            return boundedY;
          }
          // Fallback for nodes without timestamp
          return height / 2;
        }).strength(1.0)); // Maximum strength for perfect vertical ordering
        
        // Add additional separation force to prevent overlapping in columns
        simulation.force('domainSeparation', window.d3.forceY(d => {
          // Get all nodes in this domain
          const domainNodes = domainMap[d.domain] || [];
          if (domainNodes.length <= 1) return d.y; // No need for separation with single node
          
          // Sort domain nodes by timestamp
          const sortedNodes = [...domainNodes].sort((a, b) => b.timestamp - a.timestamp);
          const nodeIndex = sortedNodes.findIndex(n => n.url === d.url);
          if (nodeIndex === -1) return d.y;
          
          // Calculate ideal vertical spacing between nodes in the same domain
          const availableHeight = height - 160; // Leave padding
          const nodeSpacing = Math.min(50, availableHeight / (sortedNodes.length + 1));
          
          // Return position with proper spacing
          const baseY = timeScaleY(d.timestamp) || height/2;
          return baseY + (nodeIndex * nodeSpacing * 0.2); // Small additional offset for same-timestamp nodes
        }).strength(0.3)); // Light force just to add some separation
    } else {
      // For domain view, create domain clusters
      // Constrain the center to be within the visible area
      const centerX = Math.min(width / 2, 300);
      
      simulation
        .force('x', window.d3.forceX(centerX).strength(0.2))
        .force('y', window.d3.forceY(height / 2).strength(0.2))
        .force('domain', createDomainClusterForce());
    }
    
    // Helper function to check if a value is valid for rendering
    const isValid = (val) => typeof val === 'number' && !isNaN(val) && isFinite(val);
    
    // Create SVG elements for graph visualization
    // Draw links as SVG path elements for more flexibility than lines
    // This approach works better with the transform-based node positioning
    const link = linksGroup.selectAll('path')
      .data(links)
      .enter()
      .append('path')
      .attr('class', d => `graph-link ${d.type ? `${d.type}-link` : ''}`)
      .attr('fill', 'none')
      .attr('stroke', d => {
        // Color links differently based on type
        if (d.type === 'referral') return '#ff7043';       // Orange for referrals
        if (d.type === 'sequential') return '#42a5f5';     // Blue for sequential
        if (d.type === 'domain-transition') return '#b0bec5'; // Light gray for domain transitions
        return '#78909c'; // Default gray
      })
      .attr('stroke-opacity', d => {
        // Vary opacity based on link strength
        if (d.type === 'referral') return 0.9;
        if (d.type === 'sequential') return 0.7;
        if (d.type === 'domain-transition') return 0.5;
        return 0.6;
      })
      .attr('stroke-width', d => {
        // Set stroke width based on value/type of link
        if (d.type === 'referral') return 2.5;
        if (d.type === 'sequential' && d.value > 1) return 2;
        if (d.type === 'domain-transition') return 1;
        return 1.5;
      })
      .attr('stroke-dasharray', d => {
        // Use dashed lines for certain link types
        if (d.type === 'domain-transition') return '3,3';
        return null;
      });
    
    // Create node groups
    const node = nodesGroup.selectAll('.graph-node')
      .data(nodes)
      .enter().append('g')
      .attr('class', 'graph-node')
      // Default position (will be updated after warmup)
      .attr('transform', `translate(${width/2},${height/2})`);
      
    // Helper function to calculate node radius based on dwell time buckets
    function calculateNodeRadius(dwellTimeMs) {
      // Ensure input is a number
      dwellTimeMs = parseFloat(dwellTimeMs || 0);
      
      // Base radius for all nodes
      const baseRadius = 5;
      
      // Bucketed thresholds as requested
      // >30s, >3m, >6m, >12m
      const threshold30s = 30 * 1000;    // 30 seconds
      const threshold3m = 3 * 60 * 1000;  // 3 minutes
      const threshold6m = 6 * 60 * 1000;  // 6 minutes
      const threshold12m = 12 * 60 * 1000; // 12 minutes
      
      // Distinct sizes for each bucket
      if (dwellTimeMs < threshold30s) {
        return baseRadius;           // Base size
      } else if (dwellTimeMs < threshold3m) {
        return baseRadius + 2;       // >30s bucket
      } else if (dwellTimeMs < threshold6m) {
        return baseRadius + 4;       // >3m bucket
      } else if (dwellTimeMs < threshold12m) {
        return baseRadius + 6;       // >6m bucket
      } else {
        return baseRadius + 8;       // >12m bucket (largest)
      }
    }
    
    // Add circles to nodes with size based on dwell time
    node.append('circle')
      .attr('r', d => calculateNodeRadius(d.dwellTimeMs || 0))
      .attr('fill', d => {
        // Color by domain using a simple hash function
        const hash = hashString(d.domain) % 10;
        const colors = [
          '#4285F4', '#EA4335', '#FBBC05', '#34A853', '#FF6D01',  // Google colors
          '#46BDC6', '#7B66FF', '#FB724A', '#FFBD5C', '#36B37E'   // Additional colors
        ];
        return colors[hash];
      });
      
    // Add a tooltip attribute to show dwell time
    node.append('title')
      .text(d => {
        const dwellTime = d.dwellTimeMs || 0;
        const dwellSeconds = Math.round(dwellTime / 1000);
        const dwellMinutes = Math.floor(dwellSeconds / 60);
        const remainingSeconds = dwellSeconds % 60;
        
        let timeString = '';
        if (dwellMinutes > 0) {
          timeString = `${dwellMinutes}m ${remainingSeconds}s`;
        } else {
          timeString = `${dwellSeconds}s`;
        }
        
        return `${d.title}\nDwell time: ${timeString}`;
      });
    
    // Add favicon images to nodes
    node.append('image')
      .attr('class', 'graph-node-image')
      .attr('x', -8)
      .attr('y', -8)
      .attr('width', 16)
      .attr('height', 16)
      .attr('href', d => d.favicon);
      
    // Pre-initialize node positions before warmup
    // Position based on view mode - time (top-down) or domain (circular)
    if (viewMode === 'time') {
      // Sort nodes by timestamp for time-based view
      const sortedNodes = [...nodes].sort((a, b) => b.timestamp - a.timestamp);
      
      // Get domains for better horizontal distribution
      const uniqueDomains = new Set(nodes.map(n => n.domain));
      const domainArray = Array.from(uniqueDomains);
      const domainPositions = {};
      
      // Assign horizontal positions to domains, spaced evenly
      domainArray.forEach((domain, i) => {
        // Map domains across 80% of width
        const position = (width * 0.1) + (i / Math.max(1, domainArray.length - 1)) * (width * 0.8);
        domainPositions[domain] = position;
      });
      
      // Distribute nodes top to bottom based on recency with more structured horizontal positioning
      sortedNodes.forEach((node, i) => {
        // Position vertically based on index in sorted array (newer at top)
        const verticalPosition = (i / sortedNodes.length) * (height * 0.8) + height * 0.1;
        
        // Position horizontally based on domain
        let horizontalPosition;
        if (domainPositions[node.domain]) {
          // Use pre-calculated domain position with small jitter
          horizontalPosition = domainPositions[node.domain] + (Math.random() - 0.5) * 50;
        } else {
          // Fallback center position
          horizontalPosition = width / 2 + (Math.random() - 0.5) * 40;
        }
        
        // Apply calculated positions
        node.x = horizontalPosition;
        node.y = verticalPosition;
      });
    } else {
      // Domain view - use improved domain-based circular layout
      const uniqueDomains = new Set(nodes.map(n => n.domain));
      const domainGroups = {};
      
      // Group nodes by domain
      nodes.forEach(node => {
        if (!domainGroups[node.domain]) {
          domainGroups[node.domain] = [];
        }
        domainGroups[node.domain].push(node);
      });
      
      // Position domains in a circular layout
      const domainCount = Object.keys(domainGroups).length;
      const angleStep = (2 * Math.PI) / Math.max(domainCount, 1);
      const radius = Math.min(width, height) * 0.35;
      
      // Place each domain's nodes in their own cluster
      let domainIndex = 0;
      for (const domain in domainGroups) {
        const domainNodes = domainGroups[domain];
        const domainAngle = domainIndex * angleStep;
        const domainX = width/2 + radius * Math.cos(domainAngle);
        const domainY = height/2 + radius * Math.sin(domainAngle);
        
        // Position nodes in a small cluster around domain center
        domainNodes.forEach((node, i) => {
          const nodeAngle = (i / domainNodes.length) * Math.PI * 0.5 + domainAngle - Math.PI * 0.25;
          const nodeRadius = 30 + Math.random() * 20;
          
          node.x = domainX + nodeRadius * Math.cos(nodeAngle);
          node.y = domainY + nodeRadius * Math.sin(nodeAngle);
        });
        
        domainIndex++;
      }
    }
    
    // Improve warmup phase with staged relaxation
    // First stage: high repulsion to separate nodes
    // Second stage: gradually reduce forces to settle
    // Third stage: fine-tune positions with weak forces
    
    // Define the tick function that will be used both for warmup and animation
    function ticked() {
      // Update node positions with bounds checking
      node.attr('transform', d => {
        // Ensure node coordinates are valid and within bounds
        const x = Math.max(10, Math.min(width - 10, isValid(d.x) ? d.x : width/2));
        const y = Math.max(10, Math.min(height - 10, isValid(d.y) ? d.y : height/2));
        
        // Store bounded positions back to the node object for link consistency
        d.x = x;
        d.y = y;
        
        return `translate(${x},${y})`;
      });
      
      // Update link positions with path drawing for better edge-node alignment
      link.attr('d', d => {
        // Get valid source and target coordinates
        const sourceX = isValid(d.source.x) ? d.source.x : 0;
        const sourceY = isValid(d.source.y) ? d.source.y : 0;
        const targetX = isValid(d.target.x) ? d.target.x : 0;
        const targetY = isValid(d.target.y) ? d.target.y : 0;
        
        // Create a straight line path
        return `M${sourceX},${sourceY}L${targetX},${targetY}`;
      });
    }
    
    // Stage 1: High repulsion to ensure nodes separate properly
    simulation.force('charge').strength(-200);
    for (let i = 0; i < 50; ++i) {
      simulation.alpha(0.9).tick();
    }
    
    // Stage 2: Reduced forces, focus on applying constraints
    simulation.force('charge').strength(-150);
    if (viewMode === 'time') {
      // Strengthen y-positioning in time mode
      simulation.force('y').strength(0.95);
    }
    for (let i = 0; i < 50; ++i) {
      simulation.alpha(0.7).tick();
    }
    
    // Stage 3: Fine tuning with gentler forces
    simulation.force('charge').strength(-130);
    for (let i = 0; i < 50; ++i) {
      simulation.alpha(0.5).tick();
    }
    
    // Apply the final positions from warmup immediately
    ticked();
    
    // Restart the simulation with a lower alpha
    simulation.alpha(0.3).restart();
    
    // Signal that graph nodes are ready for highlighting
    graphNodesReady = true; // Set the global flag
    console.log('Graph nodes ready for highlighting: ', graphNodesReady);
    
    // Initialize event handlers for all existing page items
    document.querySelectorAll('.session-page-item').forEach(item => {
      const url = item.getAttribute('data-url');
      if (!url) return;
      
      // Re-initialize event handlers now that graph is ready
      item.onmouseenter = function() {
        // Clear any pending unhighlight operations
        if (hoverTimeout) {
          clearTimeout(hoverTimeout);
          hoverTimeout = null;
        }
        
        // Set this as the active highlighted URL
        activeHighlightURL = url;
        
        console.log('Page item mouseenter (re-attached):', url);
        if (graphNodesReady) {
          highlightGraphNodeForUrl(url);
          // Also highlight the list item itself
          item.classList.add('highlighted');
        } else {
          console.log('Graph not ready yet, skipping highlight');
        }
      };
      
      item.onmouseleave = function() {
        console.log('Page item mouseleave (re-attached):', url);
        // Remove highlight from this item
        item.classList.remove('highlighted');
        
        // Only unhighlight if this is still the active URL
        if (activeHighlightURL === url) {
          // Use longer delay and debounce to prevent flickering
          hoverTimeout = setTimeout(() => {
            unhighlightAllGraphNodes();
            activeHighlightURL = null;
          }, 150); // Increased timeout for better stability
        }
      };
    });
    
    // Create optimized tick function for better edge-node synchronization
    function ticked() {
      // Update node positions with bounds checking
      node.attr('transform', d => {
        // Ensure node coordinates are valid and within bounds
        const x = Math.max(10, Math.min(width - 10, isValid(d.x) ? d.x : width/2));
        const y = Math.max(10, Math.min(height - 10, isValid(d.y) ? d.y : height/2));
        
        // Store bounded positions back to the node object for link consistency
        d.x = x;
        d.y = y;
        
        return `translate(${x},${y})`;
      });
      
      // Update link positions with path drawing for better edge-node alignment
      link.attr('d', d => {
        // Get valid source and target coordinates
        const sourceX = isValid(d.source.x) ? d.source.x : 0;
        const sourceY = isValid(d.source.y) ? d.source.y : 0;
        const targetX = isValid(d.target.x) ? d.target.x : 0;
        const targetY = isValid(d.target.y) ? d.target.y : 0;
        
        // Create a straight line path
        return `M${sourceX},${sourceY}L${targetX},${targetY}`;
      });
    }
    
    // Set up the tick function
    simulation.on('tick', ticked);
    
    // Create drag behaviors with simulation passed as context
    const drag = window.d3.drag()
      .on('start', dragstarted)
      .on('drag', dragged)
      .on('end', dragended);
    
    // Apply drag behavior to nodes
    node.call(drag);
    
    // Function to handle drag start
    function dragstarted(event) {
      // Warm up the simulation when drag starts
      if (!event.active) simulation.alphaTarget(0.3).restart();
      
      // Mark the node as being dragged and store original positions
      const d = event.subject;
      d.dragging = true;
      
      // Remember original fixed positions if any
      d._originalFx = d.fx;
      d._originalFy = d.fy;
      
      // Fix position for dragging
      d.fx = d.x;
      d.fy = d.y;
      
      // Visually indicate the node is being dragged
      window.d3.select(event.sourceEvent.target.closest('.graph-node'))
        .select('circle')
        .transition().duration(200)
        .attr('r', 12);
    }
    
    function dragged(event) {
      // Update fixed position to drag position (bounded to prevent going offscreen)
      const d = event.subject;
      d.fx = Math.max(10, Math.min(width - 10, event.x));
      d.fy = Math.max(10, Math.min(height - 10, event.y));
      
      // During dragging, directly update the node position for immediate visual feedback
      d.x = d.fx;
      d.y = d.fy;
      
      // Force immediate update of this node's visual representation
      window.d3.select(event.sourceEvent.target.closest('.graph-node'))
        .attr('transform', `translate(${d.x},${d.y})`);
      
      // Update all connected links to this node
      link.filter(l => l.source === d || l.target === d)
        .attr('d', linkLine => {
          const sourceX = isValid(linkLine.source.x) ? linkLine.source.x : 0;
          const sourceY = isValid(linkLine.source.y) ? linkLine.source.y : 0;
          const targetX = isValid(linkLine.target.x) ? linkLine.target.x : 0;
          const targetY = isValid(linkLine.target.y) ? linkLine.target.y : 0;
          return `M${sourceX},${sourceY}L${targetX},${targetY}`;
        });
      
      // Force an immediate tick with higher alpha for more responsive movement
      simulation.alpha(0.7).restart();
      ticked();
    }
    
    function dragended(event) {
      // Gradually cool down the simulation
      if (!event.active) simulation.alphaTarget(0);
      
      // Handle node release based on view mode
      const d = event.subject;
      
      if (viewMode === 'time') {
        // In time view, maintain domain column alignment by restoring x position
        // but allow y position to be adjusted
        d.fx = d._originalFx; // Restore domain column position
        d.fy = null; // Allow vertical adjustment based on time forces
      } else {
        // In domain view, fully release node to forces
        d.fx = null;
        d.fy = null;
      }
      
      // Mark as no longer dragging
      d.dragging = false;
      
      // Reset node appearance
      window.d3.select(event.sourceEvent.target.closest('.graph-node'))
        .select('circle')
        .transition().duration(200)
        .attr('r', 7);
      
      // Reheat simulation slightly to allow positions to settle after drag
      simulation.alpha(0.3).restart();
    }
    
    // Add hover effects and tooltips for nodes
    node.on('mouseenter', function(event, d) {
      // Clear any pending unhighlight operations
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
        hoverTimeout = null;
      }
      
      // Set this as the active highlighted URL
      activeHighlightURL = d.url;
      
      // Find the corresponding page item in the list
      const pageItem = document.querySelector(`.session-page-item[data-url="${d.url}"]`);
      
      if (pageItem) {
        // Remove highlight from any previously highlighted items
        const previouslyHighlighted = document.querySelectorAll('.session-page-item.highlighted');
        previouslyHighlighted.forEach(item => item.classList.remove('highlighted'));
        
        // Add highlight to this item
        pageItem.classList.add('highlighted');
        
        // Scroll the item into view with smooth behavior
        pageItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      
      // Create enhanced tooltip with rich referral information
      let tooltipHtml = `
        <div class="tooltip-title">${d.title || 'Unknown Title'}</div>
        <div class="tooltip-url">${d.url}</div>
        <div class="tooltip-section">Domain: <span class="tooltip-highlight">${d.domain || 'Unknown'}</span></div>
        <div class="tooltip-section">Dwell time: <span class="tooltip-highlight">${formatDwellDuration(parseFloat(d.dwellTimeMs || 0))}</span></div>
      `;
      
      // Check for search terms in current URL
      try {
        const urlObj = new URL(d.url);
        const searchTerm = extractSearchTerm(urlObj);
        if (searchTerm) {
          tooltipHtml += `<div class="tooltip-section">Search: <span class="tooltip-highlight">${searchTerm}</span></div>`;
        }
      } catch (e) {}
      
      // Add rich referral information if available
      if (d.referral) {
        tooltipHtml += '<hr/><div class="tooltip-section-header">Referral Information</div>';
        
        if (d.referral.type === 'tabOpen') {
          tooltipHtml += `<div class="tooltip-section">Type: <span class="tooltip-highlight">Tab opened from another tab</span></div>`;
          if (d.referral.sourceUrl) {
            tooltipHtml += `<div class="tooltip-section">Source: <span class="tooltip-highlight">${formatSourceUrl(d.referral.sourceUrl)}</span></div>`;
            
            // Check for search terms in the referrer URL
            try {
              const refUrlObj = new URL(d.referral.sourceUrl);
              const refSearchTerm = extractSearchTerm(refUrlObj);
              if (refSearchTerm) {
                tooltipHtml += `<div class="tooltip-section">Search query: <span class="tooltip-highlight">${refSearchTerm}</span></div>`;
                // Add this to the referral object for consistency
                if (!d.referral.searchQuery) {
                  d.referral.searchQuery = refSearchTerm;
                }
              }
            } catch (e) {}
          }
          if (d.referral.linkText) {
            tooltipHtml += `<div class="tooltip-section">Link text: <span class="tooltip-highlight">${d.referral.linkText}</span></div>`;
          }
        } 
        else if (d.referral.type === 'intraTab') {
          tooltipHtml += `<div class="tooltip-section">Type: <span class="tooltip-highlight">Same-tab navigation</span></div>`;
          if (d.referral.sourceUrl) {
            tooltipHtml += `<div class="tooltip-section">Source: <span class="tooltip-highlight">${formatSourceUrl(d.referral.sourceUrl)}</span></div>`;
            
            // Check for search terms in the source URL
            try {
              const srcUrlObj = new URL(d.referral.sourceUrl);
              const srcSearchTerm = extractSearchTerm(srcUrlObj);
              if (srcSearchTerm) {
                tooltipHtml += `<div class="tooltip-section">From search: <span class="tooltip-highlight">${srcSearchTerm}</span></div>`;
                // Add this to the referral object for consistency
                if (!d.referral.searchQuery) {
                  d.referral.searchQuery = srcSearchTerm;
                }
              }
            } catch (e) {}
          }
          if (d.referral.interactionType) {
            tooltipHtml += `<div class="tooltip-section">Interaction: <span class="tooltip-highlight">${d.referral.interactionType}</span></div>`;
          }
          if (d.referral.linkText) {
            tooltipHtml += `<div class="tooltip-section">Link text: <span class="tooltip-highlight">${d.referral.linkText}</span></div>`;
          }
          if (d.referral.surroundingText) {
            const shortenedText = d.referral.surroundingText.length > 100 
              ? d.referral.surroundingText.substring(0, 97) + '...' 
              : d.referral.surroundingText;
            tooltipHtml += `<div class="tooltip-section">Context: <span class="tooltip-highlight">${shortenedText}</span></div>`;
          }
        }
        else if (d.referral.type === 'navigation') {
          tooltipHtml += `<div class="tooltip-section">Type: <span class="tooltip-highlight">${d.referral.transitionType || 'Navigation'}</span></div>`;
          if (d.referral.isTypedEntry) {
            tooltipHtml += `<div class="tooltip-section"><span class="tooltip-highlight">Directly typed URL</span></div>`;
          }
          if (d.referral.isBookmark) {
            tooltipHtml += `<div class="tooltip-section"><span class="tooltip-highlight">From bookmark</span></div>`;
          }
          if (d.referral.isReload) {
            tooltipHtml += `<div class="tooltip-section"><span class="tooltip-highlight">Page reload or back/forward</span></div>`;
          }
        }
        
        // Display search query if available (check multiple sources)
        const searchQuery = d.searchQuery || d.referral?.searchQuery || null;
        
        // If we have a search query, display it prominently
        if (searchQuery) {
          tooltipHtml += `<div class="tooltip-section">Search query: <span class="tooltip-highlight">${searchQuery}</span></div>`;
        }
      }
      
      // Display the tooltip
      window.d3.select(tooltipElement)
        .style('opacity', 0.9)
        .style('left', (event.pageX + 10) + 'px')
        .style('top', (event.pageY + 10) + 'px')
        .html(tooltipHtml);
    })
  .on('mousemove', function(event) {
    window.d3.select(tooltipElement)
      .style('left', (event.pageX + 10) + 'px')
      .style('top', (event.pageY + 10) + 'px');
  })
  .on('mouseout', function(event, d) {
    window.d3.select(tooltipElement).style('opacity', 0);
    
    // Remove page list item highlighting immediately
    const highlighted = document.querySelectorAll('.session-page-item.highlighted');
    highlighted.forEach(item => item.classList.remove('highlighted'));
    
    // Only unhighlight if this is still the active URL
    if (activeHighlightURL === d.url) {
      // Use debounce to prevent flickering when moving between node and list item
      hoverTimeout = setTimeout(() => {
        unhighlightAllGraphNodes();
        activeHighlightURL = null;
      }, 150);
    }
  })
  .on('click', function(event, d) {
    window.open(d.url, '_blank');
  });
      
    // Restart the simulation with a lower alpha
    simulation.alpha(0.3).restart();
    
    // Signal that graph nodes are ready for highlighting
    graphNodesReady = true; // Set the global flag
    console.log('Graph nodes ready for highlighting: ', graphNodesReady);
    
    // Initialize event handlers for all existing page items
    document.querySelectorAll('.session-page-item').forEach(item => {
      const url = item.getAttribute('data-url');
      if (!url) return;
      
      // Re-initialize event handlers now that graph is ready
      item.onmouseenter = function() {
        // Clear any pending unhighlight operations
        if (hoverTimeout) {
          clearTimeout(hoverTimeout);
          hoverTimeout = null;
        }
        
        // Set this as the active highlighted URL
        activeHighlightURL = url;
        
        console.log('Page item mouseenter (re-attached):', url);
        if (graphNodesReady) {
          highlightGraphNodeForUrl(url);
          // Also highlight the list item itself
          item.classList.add('highlighted');
        } else {
          console.log('Graph not ready yet, skipping highlight');
        }
      };
      
      item.onmouseleave = function() {
        console.log('Page item mouseleave (re-attached):', url);
        // Remove highlight from this item
        item.classList.remove('highlighted');
        
        // Only unhighlight if this is still the active URL
        if (activeHighlightURL === url) {
          // Use longer delay and debounce to prevent flickering
          hoverTimeout = setTimeout(() => {
            unhighlightAllGraphNodes();
            activeHighlightURL = null;
          }, 150); // Increased timeout for better stability
        }
      };
    });
    
    // Function to create domain clustering force
    function createDomainClusterForce() {
      const domainGroups = {};
      const centerX = Math.min(width / 2, 300); // Constrained center X position
      
      // Group nodes by domain
      nodes.forEach(node => {
        if (!domainGroups[node.domain]) {
          domainGroups[node.domain] = [];
        }
        domainGroups[node.domain].push(node);
      });
      
      // Calculate initial offset positions for each domain group
      const domainCount = Object.keys(domainGroups).length;
      const angleStep = (2 * Math.PI) / Math.max(domainCount, 1);
      const radius = Math.min(width, height) / 4;
      
      const domainCenters = {};
      let i = 0;
      
      // Assign domain centers in a circular pattern around the main center
      Object.keys(domainGroups).forEach(domain => {
        const angle = i * angleStep;
        // Use constrained centerX instead of width/2
        domainCenters[domain] = {
          x: centerX + radius * Math.cos(angle),
          y: height/2 + radius * Math.sin(angle)
        };
        i++;
      });
      
      return function(alpha) {
        // For each domain group, pull nodes toward their domain center
        Object.entries(domainGroups).forEach(([domain, domainNodes]) => {
          if (domainNodes.length <= 1) return;
          
          // Use the pre-calculated domain center
          const center = domainCenters[domain] || { x: centerX, y: height/2 };
          
          // Pull each node toward the center
          domainNodes.forEach(node => {
            node.x += (center.x - node.x) * alpha * 0.5;
            node.y += (center.y - node.y) * alpha * 0.5;
          });
        });
      };
    }
  } // End of createVisualization function

// Highlights a graph node that corresponds to a specific URL
function highlightGraphNodeForUrl(url) {
  console.log('highlightGraphNodeForUrl called for URL:', url, 'graphNodesReady:', graphNodesReady);
  if (!graphNodesReady) {
    console.log('Graph nodes not ready yet, will not highlight:', url);
    return false;
  }
  
  // Clear any pending unhighlight operations
  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }
  
  // Update active highlight tracking
  activeHighlightURL = url;
  
  console.log('Highlighting graph node for URL:', url);
  
  // Find graph nodes that match this URL
  let found = false;
  
  try {
    // Use D3 to select nodes and filter by URL
    const matchingNodes = window.d3.selectAll('.graph-node')
      .filter(function(d) {
        return d && d.url === url;
      });
    
    if (!matchingNodes.empty()) {
      // Clear any previous highlights
      window.d3.selectAll('.graph-node').classed('highlighted', false)
        .selectAll('circle').attr('r', 7);
      
      // Apply highlighting
      matchingNodes.classed('highlighted', true)
        .selectAll('circle').attr('r', 10);
      
      found = true;
      console.log('Found and highlighted node for URL:', url);
    } else {
      console.log('No matching nodes found for URL:', url);
    }
  } catch (e) {
    console.error('Error highlighting graph node:', e);
  }
  
  return found;
}

// Removes highlighting from all graph nodes
function unhighlightAllGraphNodes() {
  console.log('unhighlightAllGraphNodes called, graphNodesReady:', graphNodesReady);
  if (!graphNodesReady) return;
  
  // Clear any existing hover timeout to prevent race conditions
  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }
  
  try {
    // Use D3 to select and unhighlight all nodes
    window.d3.selectAll('.graph-node')
      .classed('highlighted', false)
      .selectAll('circle')
      .attr('r', 7);
    
    // Reset active highlight tracking
    activeHighlightURL = null;
    
    console.log('Removed all node highlights');
  } catch (e) {
    console.error('Error unhighlighting nodes:', e);
  }
  
  // Add a small delay before allowing re-highlighting to prevent flicker
  hoverTimeout = setTimeout(() => {
    hoverTimeout = null;
  }, 50);
}

/**
 * Hash a string to a number between 0 and 1
 * @param {string} str - The string to hash
 * @returns {number} A value between 0 and 1
 */
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash % 100) / 100; // Normalize to 0-1
}

/**
 * Format a source URL to be more readable in the tooltip
 * @param {string} url - The URL to format
 * @returns {string} Formatted URL
 */
function formatSourceUrl(url) {
  try {
    if (!url) return 'Unknown';
    
    const urlObj = new URL(url);
    // Show hostname plus truncated pathname if it's too long
    const path = urlObj.pathname.length > 20 ? urlObj.pathname.substring(0, 17) + '...' : urlObj.pathname;
    return urlObj.hostname + path;
  } catch (e) {
    return url.substring(0, 30) + (url.length > 30 ? '...' : '');
  }
}

/**
 * Extract search terms from common search engine URLs
 * @param {URL} urlObj - A parsed URL object
 * @returns {string|null} - The extracted search term or null if none found
 */
function extractSearchTerm(urlObj) {
  if (!urlObj) return null;
  
  const hostname = urlObj.hostname;
  const searchParams = urlObj.searchParams;
  
  // Google search
  if (hostname.includes('google.com') || hostname.includes('google.') && !hostname.includes('mail.google')) {
    const q = searchParams.get('q');
    if (q) return q;
  }
  
  // Bing search
  if (hostname.includes('bing.com')) {
    const q = searchParams.get('q');
    if (q) return q;
  }
  
  // Yahoo search
  if (hostname.includes('yahoo.com') && urlObj.pathname.includes('/search')) {
    const p = searchParams.get('p');
    if (p) return p;
  }
  
  // DuckDuckGo
  if (hostname.includes('duckduckgo.com')) {
    const q = searchParams.get('q');
    if (q) return q;
  }
  
  // YouTube
  if (hostname.includes('youtube.com') && urlObj.pathname.includes('/results')) {
    const search_query = searchParams.get('search_query');
    if (search_query) return search_query;
  }
  
  // Amazon search
  if (hostname.includes('amazon.') && urlObj.pathname.includes('/s')) {
    const k = searchParams.get('k');
    if (k) return k;
  }
  
  // Baidu
  if (hostname.includes('baidu.com')) {
    const wd = searchParams.get('wd');
    if (wd) return wd;
  }
  
  // Yandex
  if (hostname.includes('yandex.')) {
    const text = searchParams.get('text');
    if (text) return text;
  }
  
  return null;
}
