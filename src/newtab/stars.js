// Stars view JavaScript
console.log('stars.js loaded');

document.addEventListener('DOMContentLoaded', () => {
    console.log('Stars view DOM fully loaded and parsed');
    initStars();
});

async function initStars() {
    const container = document.getElementById('stars-container');
    container.innerHTML = '<p class="loading-message">Loading starred pages...</p>';

    try {
        const bookmarks = await fetchRecentBookmarks(100);
        const starSessions = await createStarSessions(bookmarks);
        renderStarSessions(starSessions, container);
        requestSummaries(starSessions);
    } catch (error) {
        console.error('Error initializing stars view:', error);
        container.innerHTML = '<p class="error-message">Error loading starred pages.</p>';
    }
}

async function createStarSessions(bookmarks) {
    const sessions = [];
    for (const bookmark of bookmarks) {
        const context = await getBookmarkContext(bookmark.dateAdded);
        sessions.push({ bookmark, context });
    }
    return sessions;
}

async function getBookmarkContext(timestamp) {
    const fifteenMinutes = 15 * 60 * 1000;
    const startTime = timestamp - fifteenMinutes;
    const endTime = timestamp + fifteenMinutes;

    return new Promise((resolve) => {
        chrome.history.search({ text: '', startTime, endTime, maxResults: 100 }, (historyItems) => {
            resolve(historyItems);
        });
    });
}

function renderStarSessions(sessions, container) {
    container.innerHTML = ''; // Clear loading message

    if (!sessions || sessions.length === 0) {
        container.innerHTML = '<p class="info-message">No recent bookmarks found.</p>';
        return;
    }

    const groupedSessions = groupSessionsByDate(sessions);

    for (const groupTitle in groupedSessions) {
        const groupContainer = document.createElement('div');
        groupContainer.className = 'session-group';

        const groupHeader = document.createElement('h2');
        groupHeader.className = 'session-group-header';
        groupHeader.textContent = groupTitle;
        groupContainer.appendChild(groupHeader);

        for (const session of groupedSessions[groupTitle]) {
            const card = createStarCard(session);
            groupContainer.appendChild(card);
        }

        container.appendChild(groupContainer);
    }
}

function groupSessionsByDate(sessions) {
    const groups = {
        Today: [],
        Yesterday: [],
        'This Week': [],
        'Last Week': [],
        'This Month': [],
        'Older': [],
    };

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const thisWeek = new Date(today);
    thisWeek.setDate(thisWeek.getDate() - now.getDay());
    const lastWeek = new Date(thisWeek);
    lastWeek.setDate(lastWeek.getDate() - 7);
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    for (const session of sessions) {
        const sessionDate = new Date(session.bookmark.dateAdded);

        if (sessionDate >= today) {
            groups.Today.push(session);
        } else if (sessionDate >= yesterday) {
            groups.Yesterday.push(session);
        } else if (sessionDate >= thisWeek) {
            groups['This Week'].push(session);
        } else if (sessionDate >= lastWeek) {
            groups['Last Week'].push(session);
        } else if (sessionDate >= thisMonth) {
            groups['This Month'].push(session);
        } else {
            groups.Older.push(session);
        }
    }

    // Remove empty groups
    for (const groupTitle in groups) {
        if (groups[groupTitle].length === 0) {
            delete groups[groupTitle];
        }
    }

    return groups;
}

import { formatTimeAgo } from './timeago.js';

function createStarCard(session) {
    const card = document.createElement('div');
    card.className = 'session-card';

    const bookmark = session.bookmark;
    const context = session.context;

    let contextHTML = '';
    let contextSummary = '';
    if (context && context.length > 0) {
        contextSummary = `<p>${context.length} pages of context</p>`;
        contextHTML = '<ul class="session-pages-ul" style="display:none;">';
        for (const item of context) {
            const faviconUrl = `https://www.google.com/s2/favicons?domain=${new URL(item.url).hostname}&sz=32`;
            contextHTML += `
                <li class="session-page-item">
                    <div class="favicon-domain-container">
                        <img class="page-favicon-img" src="${faviconUrl}" alt="">
                        <span class="domain-pill">${new URL(item.url).hostname}</span>
                    </div>
                    <div class="page-item-details">
                        <a class="page-title-link" href="${item.url}" target="_blank">${item.title || item.url}</a>
                        <span class="page-url-text">${item.url}</span>
                    </div>
                </li>`;
        }
        contextHTML += '</ul>';
    }

    card.innerHTML = `
        <div class="session-card-header">
            <h3><a href="${bookmark.url}" target="_blank">${bookmark.title || bookmark.url}</a></h3>
            <div class="session-card-time">${formatTimeAgo(bookmark.dateAdded)}</div>
        </div>
        <div class="session-card-content">
            <h4>Browsing Context:</h4>
            ${contextSummary}
            <button class="toggle-context">Show/Hide</button>
            ${contextHTML}
        </div>
    `;

    const toggleButton = card.querySelector('.toggle-context');
    toggleButton.addEventListener('click', () => {
        const contextList = card.querySelector('.session-pages-ul');
        if (contextList.style.display === 'none') {
            contextList.style.display = 'block';
        } else {
            contextList.style.display = 'none';
        }
    });

    return card;
}

function requestSummaries(sessions) {
    const urls = [];
    for (const session of sessions) {
        urls.push(session.bookmark.url);
        if (session.context) {
            for (const item of session.context) {
                urls.push(item.url);
            }
        }
    }

    chrome.runtime.sendMessage({ action: 'getSummaries', urls });
}

async function fetchRecentBookmarks(count) {
    return new Promise((resolve) => {
        chrome.bookmarks.getRecent(count, (bookmarks) => {
            resolve(bookmarks);
        });
    });
}
