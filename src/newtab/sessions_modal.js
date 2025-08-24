// Session Modal functionality for expanded card view
import { getCachedSummary, createTruncatedSummary, summaryCache } from './readout.js';
// Note: D3 is loaded globally via script tag in HTML files

// Global variables for graph state
let graphNodesReady = false;
let tooltipElement = null; // Global reference to the tooltip element

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
  item.setAttribute('data-url', page.url);
  
  // Set a consistent ID to enable bidirectional highlighting
  const safeId = `page-item-${btoa(page.url).replace(/[=+/]/g, '-')}`;
  item.id = safeId;
  
  // We'll use direct event handlers on the item to make sure they're applied
  const pageUrl = page.url; // Store URL in closure to ensure it's available in event handlers
  
  // These are the event handlers for the list item
  function handleMouseEnter() {
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
    // Small delay to prevent flickering
    setTimeout(() => unhighlightAllGraphNodes(), 50);
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
      const node = {
        id: index, // Use index as ID to ensure uniqueness
        url: page.url,
        title: page.title || page.url,
        domain: domain,
        timestamp: timestamp, // Ensure a valid timestamp
        favicon: getFaviconDisplayUrl(domain),
        referral: page.referral,
        // Set initial positions to prevent NaN
        x: Math.random() * width,
        y: Math.random() * height
      };
      
      nodes.push(node);
      nodesMap.set(index, node);
    });
    
    // Create links between consecutive pages
    for (let i = 0; i < nodes.length - 1; i++) {
      links.push({
        source: nodes[i], // Use direct node references instead of IDs
        target: nodes[i + 1],
        value: 1
      });
    }
    
    // Add links based on referral information
    nodes.forEach((node, i) => {
      if (node.referral && node.referral.referringURL) {
        // Try to find the referring node
        const referringNode = nodes.find(n => n.url === node.referral.referringURL);
        if (referringNode && referringNode !== node) {
          // Add a stronger link for actual referrals
          links.push({
            source: referringNode,
            target: node,
            value: 2, // Stronger connection
            isReferral: true
          });
        }
      }
    });
    
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
        .distance(90)
        .strength(0.7)) // Increased strength for faster stabilization
      .force('charge', window.d3.forceManyBody().strength(-100))
      .force('center', window.d3.forceCenter(width / 2, height / 2).strength(0.1)) // Stronger centering
      .force('collision', window.d3.forceCollide().radius(12))
      .alphaDecay(0.05) // Faster decay like in graph.js
      .velocityDecay(0.4) // Better damping
      .alpha(1); // Start with maximum heat
    
    // Add time-based positioning force for time view
    if (viewMode === 'time') {
      // Cap the x-position to keep nodes within the visible area
      const maxX = width - 50;
      const minX = 50;
      
      simulation
        .force('x', window.d3.forceX(d => {
          // Ensure timestamp is valid and apply time scale safely
          if (d.timestamp && !isNaN(d.timestamp)) {
            // Map to time scale but constrain to visible width
            const xPos = timeScale(d.timestamp);
            return Math.min(Math.max(xPos, minX), maxX);
          }
          // Fallback to center if timestamp is invalid
          return Math.min(width / 2, 300);
        }).strength(0.5))
        .force('y', window.d3.forceY(height / 2).strength(0.1));
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
      .attr('class', 'graph-link')
      .attr('fill', 'none')
      .attr('stroke', d => d.isReferral ? '#ffcc00' : '#ffffff')
      .attr('stroke-opacity', d => d.isReferral ? 0.8 : 0.5)
      .attr('stroke-width', d => d.isReferral ? 2 : 1);
    
    // Create node groups
    const node = nodesGroup.selectAll('.graph-node')
      .data(nodes)
      .enter().append('g')
      .attr('class', 'graph-node')
      // Default position (will be updated after warmup)
      .attr('transform', `translate(${width/2},${height/2})`);
      
    // Add circles to nodes
    node.append('circle')
      .attr('r', 8)
      .attr('fill', d => {
        // Color by domain using a simple hash function
        const hash = hashString(d.domain) % 10;
        const colors = [
          '#4285F4', '#EA4335', '#FBBC05', '#34A853', '#FF6D01',  // Google colors
          '#46BDC6', '#7B66FF', '#FB724A', '#FFBD5C', '#36B37E'   // Additional colors
        ];
        return colors[hash];
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
    // This positions nodes with intentional separation based on domain
    nodes.forEach((node, i) => {
      // Use angle-based positioning for better initial spread
      const angle = (i / nodes.length) * 2 * Math.PI;
      const radius = Math.min(width, height) * 0.4; // 40% of smaller dimension
      
      // Convert polar to cartesian coordinates with center offset
      node.x = width/2 + radius * Math.cos(angle);
      node.y = height/2 + radius * Math.sin(angle);
      
      // Add small jitter to prevent perfect overlaps
      node.x += (Math.random() - 0.5) * 20;
      node.y += (Math.random() - 0.5) * 20;
    });
    
    // Shorter but more intense warmup phase like in graph.js
    const warmupIterations = 120;
    const alphaStart = 0.8; // Higher start heat
    const alphaEnd = 0.01;
    const alphaStep = (alphaStart - alphaEnd) / warmupIterations;
    
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
    
    // Run multiple ticks with decreasing alpha to stabilize the layout
    for (let i = 0; i < warmupIterations; ++i) {
      simulation.alpha(alphaStart - (i * alphaStep)).tick();
    }
    
    // Apply the final positions from warmup immediately
    ticked();
    
    // After warm-up, adjust forces for smoother running simulation
    simulation
      .alphaDecay(0.02) // Slightly faster decay for normal operation
      .velocityDecay(0.35) // Lower velocity decay for smoother motion
      .force('charge', window.d3.forceManyBody().strength(-120)) // Stronger repulsion
      .force('link', window.d3.forceLink(links)
        .id(d => d.url)
        .distance(90) // Slightly longer links
        .strength(0.6)); // Stronger link forces
        
    // Set up the tick function for ongoing animation
    simulation.on('tick', ticked);
    
    // Apply drag behavior to nodes
    node.call(window.d3.drag()
      .on('start', dragstarted)
      .on('drag', dragged)
      .on('end', dragended));
    
    // Force an initial tick to set everything in the right position
    ticked();
    
    // Add hover effects and tooltips
    node
      .on('mouseover', function(event, d) {
        // Show tooltip
        window.d3.select(tooltipElement)
          .style('opacity', 1)
          .style('left', (event.pageX + 10) + 'px')
          .style('top', (event.pageY + 10) + 'px')
          .html(`
            <div class="graph-tooltip-title">${d.title || 'Untitled'}</div>
            <div class="graph-tooltip-url">${d.url}</div>
            <div>${new Date(d.timestamp).toLocaleTimeString()}</div>
          `);
        
        // Add highlighting class to the graph node
        window.d3.select(this).classed('highlighted', true);
        const circle = this.querySelector('circle');
        if (circle) {
          circle.setAttribute('r', 10);
        }
        
        // Find and highlight corresponding page list item
        const safeId = `page-item-${btoa(d.url).replace(/[=+\/]/g, '-')}`;
        const pageItem = document.getElementById(safeId);
        
        if (pageItem) {
          // Remove highlight from any previously highlighted items
          const previouslyHighlighted = document.querySelectorAll('.session-page-item.highlighted');
          previouslyHighlighted.forEach(item => item.classList.remove('highlighted'));
          
          // Add highlight to this item
          pageItem.classList.add('highlighted');
          
          // Scroll the item into view with smooth behavior
          pageItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      })
      .on('mousemove', function(event) {
        window.d3.select(tooltipElement)
          .style('left', (event.pageX + 10) + 'px')
          .style('top', (event.pageY + 10) + 'px');
      })
      .on('mouseout', function() {
        window.d3.select(tooltipElement).style('opacity', 0);
        
        // Remove graph node highlighting immediately
        unhighlightAllGraphNodes();
        
        // Remove page list item highlighting
        const highlighted = document.querySelectorAll('.session-page-item.highlighted');
        highlighted.forEach(item => item.classList.remove('highlighted'));
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
        // Small delay to prevent flickering
        setTimeout(() => unhighlightAllGraphNodes(), 50);
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
    
    // Apply the drag behavior to nodes
    node.call(drag);
    
    // Drag functions with simulation in scope
    function dragstarted(event) {
      // Higher alpha target makes nodes respond more immediately
      if (!event.active) simulation.alphaTarget(0.8).restart();
      
      // Pin the node in place at start of drag
      const d = event.subject;
      d.fx = d.x;
      d.fy = d.y;
      
      // Increase node size temporarily to show it's being dragged
      window.d3.select(event.sourceEvent.target.closest('.graph-node'))
        .select('circle')
        .transition().duration(200)
        .attr('r', 10);
    }
    
    function dragged(event) {
      // Update fixed position to drag position (bounded to prevent going offscreen)
      const d = event.subject;
      d.fx = Math.max(10, Math.min(width - 10, event.x));
      d.fy = Math.max(10, Math.min(height - 10, event.y));
      
      // Force an immediate tick to update connected links
      simulation.alpha(0.5).restart();
      ticked();
    }
    
    function dragended(event) {
      // Gradually cool down the simulation
      if (!event.active) simulation.alphaTarget(0);
      
      // Release the node if we're not pinning nodes
      const d = event.subject;
      d.fx = null;
      d.fy = null;
      
      // Reset node size
      window.d3.select(event.sourceEvent.target.closest('.graph-node'))
        .select('circle')
        .transition().duration(300)
        .attr('r', 8);
    }
    
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
    
    // Add hover effects and tooltips for nodes
    node.on('mousemove', function(event) {
      window.d3.select(tooltipElement)
        .style('left', (event.pageX + 10) + 'px')
        .style('top', (event.pageY + 10) + 'px');
    })
    .on('mouseout', function() {
      window.d3.select(tooltipElement).style('opacity', 0);
      
      // Remove graph node highlighting immediately
      unhighlightAllGraphNodes();
      
      // Remove page list item highlighting
      const highlighted = document.querySelectorAll('.session-page-item.highlighted');
      highlighted.forEach(item => item.classList.remove('highlighted'));
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
        // Small delay to prevent flickering
        setTimeout(() => unhighlightAllGraphNodes(), 50);
      };
    });
    
    // Using the shared ticked function defined earlier for consistent behavior
    simulation.on('tick', ticked);
    
    // Drag behavior is already defined and applied to nodes earlier in the code
    
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
  
  try {
    // Use D3 to select and unhighlight all nodes
    window.d3.selectAll('.graph-node')
      .classed('highlighted', false)
      .selectAll('circle')
      .attr('r', 7);
    
    console.log('Removed all node highlights');
  } catch (e) {
    console.error('Error unhighlighting nodes:', e);
  }
}

// Utility function to hash a string
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash) / 2147483647; // Normalize between 0 and 1
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
  
  // Google
  if (hostname.includes('google.')) {
    return searchParams.get('q');
  }
  
  // Bing
  if (hostname.includes('bing.')) {
    return searchParams.get('q');
  }
  
  // Yahoo
  if (hostname.includes('yahoo.')) {
    return searchParams.get('p');
  }
  
  // DuckDuckGo
  if (hostname.includes('duckduckgo.')) {
    return searchParams.get('q');
  }
  
  // Baidu
  if (hostname.includes('baidu.')) {
    return searchParams.get('wd');
  }
  
  // YouTube search
  if (hostname.includes('youtube.')) {
    return searchParams.get('search_query');
  }
  
  return null;
}
