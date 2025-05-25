// Sessions view JavaScript
console.log('sessions.js loaded');

let allSessionsData = []; // To store the original full list of sessions
let searchDebounceTimer;
const DEBOUNCE_DELAY = 300; // milliseconds

document.addEventListener('DOMContentLoaded', () => {
    console.log('Sessions view DOM fully loaded and parsed');
    initSessions();

    // Use the existing search input from the header
    const searchInput = document.getElementById('sessionSearch'); 
    if (searchInput) {
        searchInput.addEventListener('input', (event) => {
            const searchTerm = event.target.value.toLowerCase();
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
                filterAndRenderSessions(searchTerm);
            }, DEBOUNCE_DELAY);
        });
    }
});

function filterAndRenderSessions(searchTerm) {
    if (!allSessionsData) return;

    if (!searchTerm || searchTerm.trim() === '') {
        renderSessions(allSessionsData); // Render all if search is empty
        return;
    }

    const filteredSessions = allSessionsData.filter(session => {
        // Check session name
        if (session.name && session.name.toLowerCase().includes(searchTerm)) {
            return true;
        }
        // Check pages within the session
        if (session.pages) {
            for (const page of session.pages) {
                if (page.title && page.title.toLowerCase().includes(searchTerm)) {
                    return true;
                }
                if (page.url && page.url.toLowerCase().includes(searchTerm)) {
                    return true;
                }
            }
        }
        return false;
    });
    renderSessions(filteredSessions);
}

async function initSessions() {
    const container = document.getElementById('sessions-container');
    if (container) {
        container.innerHTML = '<p class="loading-message">Loading session data...</p>';
    }

    try {
        // Fetch data similar to graph.js
        const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        const [historyItems, allWindows] = await Promise.all([
            chrome.history.search({ text: '', maxResults: 1000, startTime: sevenDaysAgo }), // Fetch more for session processing
            chrome.windows.getAll({ populate: true })
        ]);

        console.log('Fetched history items:', historyItems.length);
        console.log('Fetched windows:', allWindows.length);

        // Placeholder for processing data into sessions
        const sessionsData = processDataIntoSessions(historyItems, allWindows);
        allSessionsData = sessionsData; // Store the full dataset
        
        renderSessions(allSessionsData); // Initial render with all data

    } catch (error) {
        console.error('Failed to initialize sessions view:', error);
        if (container) {
            container.innerHTML = `<p class="error-message">Error loading sessions: ${error.message}</p>`;
        }
    }
}

function processDataIntoSessions(historyItems, allWindows) {
    console.log('Processing data into sessions...');
    const SESSION_GAP_THRESHOLD = 30 * 60 * 1000; // 30 minutes in milliseconds
    let processedSessions = [];

    // 1. Combine history items and active tabs into a single list of activities
    let activities = historyItems.map(item => ({
        url: item.url,
        title: item.title || item.url,
        timestamp: item.lastVisitTime,
        type: 'history'
    }));

    allWindows.forEach(window => {
        if (window.tabs) {
            window.tabs.forEach(tab => {
                if (tab.url && !tab.url.startsWith('chrome://')) { // Exclude internal chrome pages
                    activities.push({
                        url: tab.url,
                        title: tab.title || tab.url,
                        timestamp: tab.lastAccessTime || Date.now(), // lastAccessTime might not be available for all tabs, fallback to now
                        type: 'active_tab'
                    });
                }
            });
        }
    });

    // Remove duplicates based on url and timestamp (prefer active_tab if timestamps are close)
    activities = activities.reduce((acc, current) => {
        const x = acc.find(item => item.url === current.url && Math.abs(item.timestamp - current.timestamp) < 1000);
        if (!x) {
            return acc.concat([current]);
        } else if (current.type === 'active_tab' && x.type === 'history') {
            // Replace history with active_tab if it's essentially the same event
            return acc.filter(item => item !== x).concat([current]);
        }
        return acc;
    }, []);


    // 2. Sort activities chronologically (oldest first for session building)
    activities.sort((a, b) => a.timestamp - b.timestamp);

    if (activities.length === 0) {
        console.log('No activities to process into sessions.');
        return [];
    }

    // 3. Group activities into sessions
    let currentSession = null;

    activities.forEach((activity, index) => {
        if (!activity.url) return; // Skip activities without a URL

        if (currentSession === null) {
            // Start the first session
            currentSession = createNewSession(activity);
        } else {
            const timeDiff = activity.timestamp - currentSession.endTime;
            if (timeDiff > SESSION_GAP_THRESHOLD) {
                // Time gap is too large, finalize previous session and start a new one
                finalizeSession(currentSession);
                processedSessions.push(currentSession);
                currentSession = createNewSession(activity);
            } else {
                // Activity is part of the current session
                currentSession.pages.push({
                    url: activity.url,
                    title: activity.title,
                    visitTime: activity.timestamp
                });
                currentSession.endTime = activity.timestamp;
            }
        }
    });

    // Finalize the last session
    if (currentSession) {
        finalizeSession(currentSession);
        processedSessions.push(currentSession);
    }
    
    console.log('Processed sessions:', processedSessions);
    return processedSessions;
}

function createNewSession(activity) {
    return {
        id: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        startTime: activity.timestamp,
        endTime: activity.timestamp,
        pages: [{
            url: activity.url,
            title: activity.title,
            visitTime: activity.timestamp
        }],
        pageCount: 0, // Will be calculated in finalizeSession
        duration: 0, // Will be calculated in finalizeSession
        topDomains: [], // Will be calculated in finalizeSession
        linkTexts: [], // Placeholder
        searchQueries: [], // Placeholder
        name: '' // Will be generated in finalizeSession
    };
}

function getFaviconDisplayUrl(pageUrlOrDomain) {
    try {
        let domain = pageUrlOrDomain;
        // If it's a full URL, extract the hostname
        if (pageUrlOrDomain.includes('://')) {
            domain = new URL(pageUrlOrDomain).hostname;
        }
        // Remove www. if it exists, as Google's service sometimes works better without it for some domains
        // domain = domain.replace(/^www\./, '');
        // The above line is commented out as it might be too aggressive. Let's test without it first.
        return `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
    } catch (e) {
        console.warn('Could not generate favicon URL for:', pageUrlOrDomain, e);
        return ''; // Return empty or a default placeholder icon URL
    }
}

function finalizeSession(session) {
    session.duration = session.endTime - session.startTime;
    
    const uniqueUrls = new Set(session.pages.map(p => p.url));
    session.pageCount = uniqueUrls.size;

    // Updated session naming
    if (session.pages.length > 0) {
        const firstPageTitle = session.pages[0].title;
        if (firstPageTitle && firstPageTitle.toLowerCase() !== 'new tab' && firstPageTitle.length > 10) {
            session.name = `${firstPageTitle.substring(0,70)}${firstPageTitle.length > 70 ? '...' : ''}`;
        } else {
            session.name = `Session from ${new Date(session.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} - ${new Date(session.startTime).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
        }
    } else {
        session.name = `Brief Session - ${new Date(session.startTime).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
    }

    const domainCounts = session.pages.reduce((acc, page) => {
        try {
            const domain = new URL(page.url).hostname;
            acc[domain] = (acc[domain] || 0) + 1;
        } catch (e) {
            console.warn('Invalid URL encountered for domain extraction:', page.url);
        }
        return acc;
    }, {});

    // Dynamic number of top domains
    let numTopDomains = 5; // Default
    if (session.pageCount < 5) {
        numTopDomains = 3;
    } else if (session.pageCount >= 15) {
        numTopDomains = 7;
    }

    session.topDomains = Object.entries(domainCounts)
        .sort(([,a],[,b]) => b-a)
        .slice(0, numTopDomains)
        .map(([domain]) => ({
            domain: domain,
            faviconUrl: getFaviconDisplayUrl(domain) // Get favicon for the domain itself
        }));
}

function formatDuration(milliseconds) {
    if (milliseconds < 0 || isNaN(milliseconds)) return 'N/A';
    let totalSeconds = Math.floor(milliseconds / 1000);
    let hours = Math.floor(totalSeconds / 3600);
    let minutes = Math.floor((totalSeconds % 3600) / 60);
    let seconds = totalSeconds % 60;

    let parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    
    return parts.join(' ');
}

function createListElement(items, title) {
    if (!items || items.length === 0) return null;
    const listContainer = document.createElement('div');
    listContainer.className = 'session-detail-list';
    const listTitle = document.createElement('strong');
    listTitle.textContent = `${title}: `;
    listContainer.appendChild(listTitle);
    const ul = document.createElement('ul');
    items.forEach(item => {
        const li = document.createElement('li');
        li.textContent = item;
        ul.appendChild(li);
    });
    listContainer.appendChild(ul);
    return listContainer;
}

function createDomainListElement(domains, title) {
    if (!domains || domains.length === 0) return null;
    const listContainer = document.createElement('div');
    listContainer.className = 'session-detail-list session-domain-list';
    const listTitle = document.createElement('strong');
    listTitle.textContent = `${title}: `;
    listContainer.appendChild(listTitle);
    const ul = document.createElement('ul');
    domains.forEach(item => {
        const li = document.createElement('li');
        if (item.faviconUrl) {
            const img = document.createElement('img');
            img.src = item.faviconUrl;
            img.alt = `${item.domain} favicon`;
            img.className = 'favicon-img';
            li.appendChild(img);
        }
        li.appendChild(document.createTextNode(`${item.faviconUrl ? ' ' : ''}${item.domain}`));
        ul.appendChild(li);
    });
    listContainer.appendChild(ul);
    return listContainer;
}

function renderSessionPageList(pages) {
    const pageListContainer = document.createElement('div');
    pageListContainer.className = 'session-pages-list';
    const ul = document.createElement('ul');

    // Sort pages chronologically if not already sorted (oldest to newest for display)
    const sortedPages = [...pages].sort((a,b) => a.visitTime - b.visitTime);

    sortedPages.forEach(page => {
        const li = document.createElement('li');
        li.className = 'session-page-item';

        const faviconImg = document.createElement('img');
        faviconImg.className = 'page-favicon-img';
        faviconImg.src = getFaviconDisplayUrl(page.url);
        faviconImg.alt = ''; // Decorative
        li.appendChild(faviconImg);

        const pageDetails = document.createElement('div');
        pageDetails.className = 'page-item-details';

        const titleLink = document.createElement('a');
        titleLink.href = page.url;
        titleLink.textContent = page.title || page.url;
        titleLink.className = 'page-title-link';
        titleLink.target = '_blank'; // Open in new tab
        pageDetails.appendChild(titleLink);

        const urlText = document.createElement('span');
        urlText.className = 'page-url-text';
        urlText.textContent = page.url;
        pageDetails.appendChild(urlText);
        
        const visitTimeText = document.createElement('span');
        visitTimeText.className = 'page-visit-time';
        visitTimeText.textContent = `Visited: ${new Date(page.visitTime).toLocaleString()}`;
        pageDetails.appendChild(visitTimeText);

        li.appendChild(pageDetails);
        ul.appendChild(li);
    });

    pageListContainer.appendChild(ul);
    return pageListContainer;
}

function renderSessions(sessionsData) {
    const container = document.getElementById('sessions-container');
    if (!container) {
        console.error('Sessions container not found');
        return;
    }
    container.innerHTML = ''; // Clear previous content (e.g., loading message)

    if (!sessionsData || sessionsData.length === 0) {
        container.innerHTML = '<p class="info-message">No sessions to display at the moment.</p>';
        console.log('No sessions data to render.');
        return;
    }

    // Sort sessions by startTime in descending order (most recent first)
    sessionsData.sort((a, b) => b.startTime - a.startTime);

    sessionsData.forEach(session => {
        const sessionElement = document.createElement('div');
        sessionElement.className = 'session-item';
        sessionElement.setAttribute('data-session-id', session.id);

        const sessionHeader = document.createElement('h3');
        sessionHeader.className = 'session-name';
        sessionHeader.textContent = session.name || `Session from ${new Date(session.startTime).toLocaleString()}`;
        sessionElement.appendChild(sessionHeader);

        // Create a container for collapsible content
        const collapsibleContent = document.createElement('div');
        collapsibleContent.className = 'session-collapsible-content';
        // Initially hidden
        collapsibleContent.style.display = 'none'; 

        // Add click listener to the header to toggle details
        sessionHeader.addEventListener('click', () => {
            const isExpanded = collapsibleContent.style.display === 'block';
            collapsibleContent.style.display = isExpanded ? 'none' : 'block';
            sessionElement.classList.toggle('expanded', !isExpanded);

            // If expanding and content isn't there yet, render it
            if (!isExpanded && collapsibleContent.childElementCount === 0) {
                 // Check if pages exist and are not empty
                if (session.pages && session.pages.length > 0) {
                    const pageListElement = renderSessionPageList(session.pages);
                    collapsibleContent.appendChild(pageListElement);
                } else {
                    const noPagesMessage = document.createElement('p');
                    noPagesMessage.textContent = 'No page details available for this session.';
                    noPagesMessage.className = 'no-pages-message';
                    collapsibleContent.appendChild(noPagesMessage);
                }
            }
        });

        const extentElement = document.createElement('p');
        extentElement.className = 'session-extent';
        const durationFormatted = formatDuration(session.duration);
        extentElement.textContent = `Extent: ${session.pageCount || 'N/A'} pages, Duration: ${durationFormatted}`;
        sessionElement.appendChild(extentElement);

        const topDomainsElement = createDomainListElement(session.topDomains, 'Top Domains');
        if (topDomainsElement) sessionElement.appendChild(topDomainsElement);

        const linkTextsElement = createListElement(session.linkTexts, 'Clicked Links');
        if (linkTextsElement) sessionElement.appendChild(linkTextsElement);

        const searchQueriesElement = createListElement(session.searchQueries, 'Search Queries');
        if (searchQueriesElement) sessionElement.appendChild(searchQueriesElement);

        // Append the collapsible content container to the session element
        sessionElement.appendChild(collapsibleContent);

        container.appendChild(sessionElement);
    });
    console.log('Sessions rendered.');
}
