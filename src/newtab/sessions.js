// Sessions view JavaScript
console.log('sessions.js loaded');

// Import the summary cache and helper functions from readout.js
import { summaryCache, getCachedSummary } from './readout.js';

// Helper function to create a truncated summary display (simplified version from readout.js)
function createTruncatedSummary(summary, searchTerm = '') {
    if (!summary) return '';
    
    const MAX_SUMMARY_LINES = 3;
    const lines = summary.split('\n');
    const isTruncated = lines.length > MAX_SUMMARY_LINES;
    
    let truncatedSummary = isTruncated 
        ? lines.slice(0, MAX_SUMMARY_LINES).join('\n')
        : summary;
    
    // Highlight search term if provided
    if (searchTerm && searchTerm.trim() !== '') {
        truncatedSummary = highlightText(truncatedSummary, searchTerm);
    }
    
    return `
        <div class="summary-content">
            <div class="summary-text">
                ${truncatedSummary}
            </div>
            ${isTruncated ? `
                <div class="summary-expand">
                    <button class="show-more-btn" onclick="this.parentElement.parentElement.innerHTML = \`${summary.replace(/`/g, '\\`')}\`">
                        Show more...
                    </button>
                </div>
            ` : ''}
        </div>
    `;
}

// Helper function to highlight search matches in text
function highlightText(text, searchTerm) {
    if (!searchTerm || !text) return text;
    
    const searchRegex = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return text.replace(searchRegex, match => `<span class="search-highlight">${match}</span>`);
}

let allSessionsData = []; // To store the original full list of sessions
let currentSearchTerm = ''; // Track current search term for highlighting

document.addEventListener('DOMContentLoaded', () => {
    console.log('Sessions view DOM fully loaded and parsed');
    initSessions();

    // Use the existing search input from the header
    const searchInput = document.getElementById('sessionSearch'); 
    if (searchInput) {
        searchInput.addEventListener('input', (event) => {
            currentSearchTerm = event.target.value.toLowerCase();
            filterAndRenderSessions(currentSearchTerm);
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
                
                // Check AI summary if available in cache
                const cachedSummary = getCachedSummary(page.url);
                if (cachedSummary && cachedSummary.toLowerCase().includes(searchTerm)) {
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
        const sessionsData = await processDataIntoSessions(historyItems, allWindows); // Added await
        allSessionsData = sessionsData; // Store the full dataset
        
        renderSessions(allSessionsData); // Initial render with all data

    } catch (error) {
        console.error('Failed to initialize sessions view:', error);
        if (container) {
            container.innerHTML = `<p class="error-message">Error loading sessions: ${error.message}</p>`;
        }
    }
}

async function processDataIntoSessions(historyItems, allWindows) { // Made async
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

    // Enrich sessions with dwell time and referral data
    if (typeof browserState !== 'undefined' && browserState.getPageActivityAndReferrals) {
        console.log('Enriching sessions with activity and referral data...');
        for (let i = 0; i < processedSessions.length; i++) {
            const session = processedSessions[i];
            if (session.pages && session.pages.length > 0) {
                const pageInfoForEnrichment = session.pages.map(p => ({
                    url: p.url,
                    visitTimestamp: p.visitTime // Map visitTime to visitTimestamp
                }));

                try {
                    const enrichedPages = await browserState.getPageActivityAndReferrals(pageInfoForEnrichment);
                    session.pages = session.pages.map((originalPage, index) => ({
                        ...originalPage,
                        ...enrichedPages[index] // Adds originalTabId, dwellTimeMs, referral
                    }));
                    console.log(`Enriched ${enrichedPages.length} pages for session ${session.id}`);
                } catch (error) {
                    console.error(`Error enriching pages for session ${session.id}:`, error);
                }
            }
        }
    } else {
        console.warn('browserState.getPageActivityAndReferrals not available. Skipping session enrichment.');
    }
    
    console.log('Processed sessions (enriched):', processedSessions);
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

function extractSearchQuery(url) {
    try {
        const urlObj = new URL(url);
        let query = null;
        
        // Google search
        if (urlObj.hostname.includes('google.') && urlObj.pathname.includes('/search')) {
            query = urlObj.searchParams.get('q');
        }
        // Bing search
        else if (urlObj.hostname.includes('bing.com') && urlObj.pathname.includes('/search')) {
            query = urlObj.searchParams.get('q');
        }
        // DuckDuckGo
        else if (urlObj.hostname.includes('duckduckgo.com')) {
            query = urlObj.searchParams.get('q');
        }
        // Yahoo search
        else if (urlObj.hostname.includes('search.yahoo.com')) {
            query = urlObj.searchParams.get('p');
        }
        // Baidu
        else if (urlObj.hostname.includes('baidu.com') && urlObj.pathname.includes('/s')) {
            query = urlObj.searchParams.get('wd');
        }
        // Yandex
        else if (urlObj.hostname.includes('yandex') && urlObj.pathname.includes('/search')) {
            query = urlObj.searchParams.get('text');
        }
        // Add more search engines as needed
        
        return query;
    } catch (e) {
        console.warn('Error extracting search query:', e);
        return null;
    }
}

function finalizeSession(session) {
    session.duration = session.endTime - session.startTime;
    
    const uniqueUrls = new Set(session.pages.map(p => p.url));
    session.pageCount = uniqueUrls.size;
    
    // Extract search queries from all URLs in the session
    session.searchQueries = [];
    if (session.pages) {
        session.pages.forEach(page => {
            const query = extractSearchQuery(page.url);
            if (query && query.trim() !== '' && !session.searchQueries.includes(query)) {
                session.searchQueries.push(query);
            }
        });
    }

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

    // Populate linkTexts from enriched page data
    session.linkTexts = [];
    if (session.pages) {
        session.pages.forEach(page => {
            if (page.referral && page.referral.linkText && !session.linkTexts.includes(page.referral.linkText)) {
                session.linkTexts.push(page.referral.linkText);
            }
        });
    }
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

function createDomainListElement(domains) { // Removed title parameter
    if (!domains || domains.length === 0) return null;
    const listContainer = document.createElement('div');
    listContainer.className = 'session-detail-list session-domain-list';
    // Removed title element creation
    const ul = document.createElement('ul');
    domains.forEach(item => {
        const li = document.createElement('li');
        const anchor = document.createElement('a');
        anchor.href = '#'; // Prevent page jump, actual navigation handled by JS
        anchor.className = 'domain-pill-link';
        anchor.style.textDecoration = 'none';
        anchor.style.color = 'inherit';
        anchor.style.cursor = 'pointer';

        if (item.faviconUrl) {
            const img = document.createElement('img');
            img.src = item.faviconUrl;
            img.alt = `${item.domain} favicon`;
            img.className = 'favicon-img';
            anchor.appendChild(img);
        }
        anchor.appendChild(document.createTextNode(`${item.faviconUrl ? ' ' : ''}${item.domain}`));
        
        anchor.addEventListener('click', async (event) => {
            event.preventDefault(); // Prevent default anchor behavior
            const domainToFind = item.domain;
            try {
                const tabs = await chrome.tabs.query({});
                let foundTab = null;
                for (const tab of tabs) {
                    if (tab.url) {
                        try {
                            const tabHostname = new URL(tab.url).hostname;
                            if (tabHostname === domainToFind || tabHostname.endsWith('.' + domainToFind)) {
                                foundTab = tab;
                                break;
                            }
                        } catch (e) {
                            // Invalid URL, skip
                        }
                    }
                }

                if (foundTab) {
                    await chrome.tabs.update(foundTab.id, { active: true });
                    await chrome.windows.update(foundTab.windowId, { focused: true });
                } else {
                    await chrome.tabs.create({ url: `https://${domainToFind}` });
                }
            } catch (error) {
                console.error('Error handling domain click:', error);
            }
        });

        li.appendChild(anchor);
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

    // Use the current search term for highlighting
    const searchTerm = currentSearchTerm;
    
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

        // Title with optional highlight
        const titleLink = document.createElement('a');
        titleLink.href = page.url;
        const titleText = page.title || page.url;
        if (searchTerm && titleText.toLowerCase().includes(searchTerm)) {
            titleLink.innerHTML = highlightText(titleText, searchTerm);
        } else {
            titleLink.textContent = titleText;
        }
        titleLink.className = 'page-title-link';
        titleLink.target = '_blank'; // Open in new tab
        pageDetails.appendChild(titleLink);

        // URL with optional highlight
        const urlText = document.createElement('span');
        urlText.className = 'page-url-text';
        if (searchTerm && page.url.toLowerCase().includes(searchTerm)) {
            urlText.innerHTML = highlightText(page.url, searchTerm);
        } else {
            urlText.textContent = page.url;
        }
        pageDetails.appendChild(urlText);
        
        const visitTimeText = document.createElement('span');
        visitTimeText.className = 'page-visit-time';
        visitTimeText.textContent = `Visited: ${new Date(page.visitTime).toLocaleString()}`;
        pageDetails.appendChild(visitTimeText);

        // Display Dwell Time
        if (page.dwellTimeMs && page.dwellTimeMs > 0) {
            const dwellTimeText = document.createElement('span');
            dwellTimeText.className = 'page-dwell-time';
            dwellTimeText.textContent = `Dwell time: ${formatDuration(page.dwellTimeMs)}`;
            pageDetails.appendChild(dwellTimeText);
        }

        // Display Referral Info
        if (page.referral) {
            const referralDiv = document.createElement('div');
            referralDiv.className = 'page-referral-info';
            let referralHtml = 'Referred by: ';
            if (page.referral.type === 'tabOpen') {
                if (page.referral.sourceUrl) {
                    const sourceLink = document.createElement('a');
                    sourceLink.href = page.referral.sourceUrl;
                    sourceLink.textContent = page.referral.sourceUrl.length > 70 ? page.referral.sourceUrl.substring(0, 67) + '...' : page.referral.sourceUrl;
                    sourceLink.target = '_blank';
                    referralDiv.appendChild(document.createTextNode(referralHtml));
                    referralDiv.appendChild(sourceLink);
                } else {
                    referralDiv.textContent = referralHtml + 'an unknown source tab';
                }
                if (page.referral.linkText) {
                    referralDiv.appendChild(document.createTextNode(` (link: "${page.referral.linkText}")`));
                }
            } else {
                 // Fallback for other referral types if ever introduced
                referralDiv.textContent = referralHtml + 'unknown mechanism.';
            }
            pageDetails.appendChild(referralDiv);
        }
        
        // Display cached AI summary if available
        const cachedSummary = getCachedSummary(page.url);
        if (cachedSummary) {
            const summaryDiv = document.createElement('div');
            summaryDiv.className = 'page-summary';
            
            // Add a small label indicating this is an AI summary
            const summaryLabel = document.createElement('div');
            summaryLabel.className = 'summary-label';
            summaryLabel.textContent = 'AI Summary';
            summaryDiv.appendChild(summaryLabel);
            
            // Add the summary content with truncation if needed
            const summaryContent = document.createElement('div');
            
            // Apply highlighting if there's a search match in the summary
            summaryContent.innerHTML = createTruncatedSummary(cachedSummary, searchTerm);
            summaryDiv.appendChild(summaryContent);
            
            pageDetails.appendChild(summaryDiv);
        }

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
        const noSessionsMessage = document.createElement('p');
        noSessionsMessage.className = 'info-message';
        noSessionsMessage.textContent = 'No browsing sessions found. Start browsing or try modifying your filters.';
        container.appendChild(noSessionsMessage);
        return;
    }
    
    // Define time period boundaries (in hours, 24-hour format)
    const timePeriods = [
        { name: 'Early Morning', start: 0, end: 6 },
        { name: 'Morning', start: 6, end: 12 },
        { name: 'Afternoon', start: 12, end: 17 },
        { name: 'Evening', start: 17, end: 21 },
        { name: 'Night', start: 21, end: 24 }
    ];
    
    // Helper function to get time period for a given hour
    function getTimePeriod(hour) {
        return timePeriods.find(period => hour >= period.start && hour < period.end) || timePeriods[0];
    }
    
    // Group sessions by date and time period
    const sessionsByDateAndPeriod = {};
    
    sessionsData.forEach(session => {
        // Get the date string in local timezone
        const sessionDate = new Date(session.startTime);
        const dateKey = sessionDate.toISOString().split('T')[0]; // YYYY-MM-DD format
        const hour = sessionDate.getHours();
        const period = getTimePeriod(hour);
        const dateAndPeriodKey = `${dateKey}_${period.name}`;
        
        if (!sessionsByDateAndPeriod[dateAndPeriodKey]) {
            sessionsByDateAndPeriod[dateAndPeriodKey] = {
                date: dateKey,
                period: period.name,
                hour: period.start, // Use this for sorting
                sessions: []
            };
        }
        
        sessionsByDateAndPeriod[dateAndPeriodKey].sessions.push(session);
    });
    
    // Sort dates in reverse chronological order (newest first)
    // First group by date
    const groupedByDate = {};
    Object.entries(sessionsByDateAndPeriod).forEach(([key, data]) => {
        if (!groupedByDate[data.date]) {
            groupedByDate[data.date] = [];
        }
        groupedByDate[data.date].push(data);
    });
    
    const sortedDates = Object.keys(groupedByDate).sort((a, b) => b.localeCompare(a));
    
    // For each date, process each time period
    sortedDates.forEach(dateKey => {
        const date = new Date(dateKey);
        
        // Format the date nicely for the main date heading
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        
        let dateDisplay;
        let dateNumericFormat = new Intl.DateTimeFormat('en-US', { 
            month: 'numeric', 
            day: 'numeric', 
            year: 'numeric' 
        }).format(date);

        if (dateKey === today.toISOString().split('T')[0]) {
            dateDisplay = `Today: ${dateNumericFormat}`;
        } else if (dateKey === yesterday.toISOString().split('T')[0]) {
            dateDisplay = `Yesterday: ${dateNumericFormat}`;
        } else {
            dateDisplay = `${new Intl.DateTimeFormat('en-US', { 
                weekday: 'long', 
                month: 'long', 
                day: 'numeric'
            }).format(date)}: ${dateNumericFormat}`;
        }
        
        // Create main date milestone
        const dateMilestone = document.createElement('div');
        dateMilestone.className = 'date-milestone main-milestone';
        dateMilestone.textContent = dateDisplay;
        container.appendChild(dateMilestone);
        
        // Sort time periods within this date (evening before morning)
        const timePeriods = groupedByDate[dateKey].sort((a, b) => b.hour - a.hour);
        
        timePeriods.forEach(periodData => {
            const { period, sessions } = periodData;
            
            // Create period milestone if we have sessions in this period
            if (sessions.length > 0) {
                // Get the earliest session time in this period for the time label
                const firstSession = sessions.reduce((earliest, current) => 
                    current.startTime < earliest.startTime ? current : earliest
                );
                
                // Format the time for display
                const periodTime = new Date(firstSession.startTime);
                const timeString = periodTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                
                const periodMilestone = document.createElement('div');
                periodMilestone.className = 'date-milestone period-milestone';
                periodMilestone.textContent = `${period}: ${timeString}`;
                container.appendChild(periodMilestone);
                
                // Create a row for sessions from this period
                const sessionsRow = document.createElement('div');
                sessionsRow.className = 'sessions-row';
                container.appendChild(sessionsRow);
                
                // Sort sessions by descending start time
                sessions.sort((a, b) => b.startTime - a.startTime);
                
                // Calculate time deltas for vertical offset
                let previousTime = sessions[0].startTime; // Start with the most recent session time
                
                // Render each session in the row
                sessions.forEach((session, index) => {
                    // Calculate time difference for vertical offset
                    const timeDelta = index === 0 ? 0 : previousTime - session.startTime;
                    previousTime = session.startTime;
                    
                    // Calculate vertical offset based on time difference
                    // Use logarithmic scale to prevent extreme offsets
                    // 1 minute = small offset, 1 hour = medium offset, > 3 hours = larger offset
                    const timeOffsetMinutes = timeDelta / (1000 * 60); // Convert to minutes
                    let verticalOffsetPx = 0;
                    
                    if (timeOffsetMinutes > 0) {
                        if (timeOffsetMinutes < 10) {
                            // Less than 10 minutes - minimal offset
                            verticalOffsetPx = 5;
                        } else if (timeOffsetMinutes < 30) {
                            // 10-30 minutes - small offset
                            verticalOffsetPx = 15;
                        } else if (timeOffsetMinutes < 60) {
                            // 30-60 minutes - medium offset
                            verticalOffsetPx = 25;
                        } else if (timeOffsetMinutes < 180) {
                            // 1-3 hours - larger offset
                            verticalOffsetPx = 35;
                        } else {
                            // > 3 hours - maximum offset
                            verticalOffsetPx = 45;
                        }
                    }
                    
                    const sessionElement = document.createElement('div');
                    sessionElement.className = 'session-item';
                    sessionElement.setAttribute('data-session-id', session.id);
                    
                    // Apply vertical offset through margin-top
                    if (verticalOffsetPx > 0) {
                        sessionElement.style.marginTop = `${verticalOffsetPx}px`;
                    }

                    const sessionHeader = document.createElement('h3');
                    sessionHeader.className = 'session-name';
                    sessionHeader.textContent = session.name || `Session from ${new Date(session.startTime).toLocaleString()}`;
                    sessionElement.appendChild(sessionHeader);

                    // Create a container for collapsible content
                    const collapsibleContent = document.createElement('div');
                    collapsibleContent.className = 'session-collapsible-content';
                    // Will be initially hidden by CSS

                    // Add click listener to the header to toggle details with improved animation handling
                    sessionHeader.addEventListener('click', () => {
                        const isExpanded = sessionElement.classList.contains('expanded');
                        sessionElement.classList.toggle('expanded', !isExpanded);
                        
                        // Load content on first expansion
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
                    extentElement.textContent = `${session.pageCount || '0'} pages • ${durationFormatted}`;
                    sessionElement.appendChild(extentElement);

                    const detailsPreview = document.createElement('div');
                    detailsPreview.className = 'session-preview-details';

                    const topDomainsElement = createDomainListElement(session.topDomains);
                    if (topDomainsElement) {
                        detailsPreview.appendChild(topDomainsElement); // Add top domains to preview
                    }

                    // Add Clicked Link Texts to preview
                    if (session.linkTexts && session.linkTexts.length > 0) {
                        const linkTextsElement = createListElement(session.linkTexts, 'Clicked Links');
                        if (linkTextsElement) {
                            detailsPreview.appendChild(linkTextsElement);
                        }
                    }
                    
                    // Add Search Queries to preview with enhanced styling
                    if (session.searchQueries && session.searchQueries.length > 0) {
                        const searchQueriesContainer = document.createElement('div');
                        searchQueriesContainer.className = 'session-detail-list';
                        
                        const searchQueriesTitle = document.createElement('strong');
                        searchQueriesTitle.textContent = 'Search Queries: ';
                        searchQueriesContainer.appendChild(searchQueriesTitle);
                        
                        const searchQueriesWrapper = document.createElement('div');
                        searchQueriesWrapper.className = 'search-queries-wrapper';
                        searchQueriesWrapper.style.display = 'flex';
                        searchQueriesWrapper.style.flexWrap = 'wrap';
                        searchQueriesWrapper.style.gap = '5px';
                        searchQueriesWrapper.style.marginTop = '5px';
                        
                        session.searchQueries.forEach(query => {
                            const queryItem = document.createElement('span');
                            queryItem.className = 'search-query-item';
                            
                            const queryIcon = document.createElement('span');
                            queryIcon.className = 'search-query-icon';
                            queryItem.appendChild(queryIcon);
                            
                            queryItem.appendChild(document.createTextNode(query));
                            searchQueriesWrapper.appendChild(queryItem);
                        });
                        
                        searchQueriesContainer.appendChild(searchQueriesWrapper);
                        detailsPreview.appendChild(searchQueriesContainer);
                    }

                    sessionElement.appendChild(detailsPreview);

                    // Append the collapsible content container to the session element
                    sessionElement.appendChild(collapsibleContent);

                    // Add the completed session element to the row
                    sessionsRow.appendChild(sessionElement);
                });
            }
        });
    });
    
    console.log('Sessions rendered with date milestones, time periods, and vertical offsets.');
}

// Close the renderSessions function
