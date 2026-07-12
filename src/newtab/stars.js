// Stars view JavaScript
import {
    readSharedQuery,
    publishSharedQuery,
    decorateViewLinks,
    onSharedQueryChange
} from "./search-persistence.js";

console.log("stars.js loaded");

document.addEventListener("DOMContentLoaded", () => {
    console.log("Stars view DOM fully loaded and parsed");
    initStars();
    initStarsSearch();
});

async function initStars() {
    const container = document.getElementById("stars-container");
    container.innerHTML = "<p class=\"loading-message\">Loading starred pages...</p>";

    try {
        const bookmarks = await fetchRecentBookmarks(100);
        const starSessions = await createStarSessions(bookmarks);
        renderStarSessions(starSessions, container);
        // Cards exist now — apply any query carried in from another view.
        const carried = document.getElementById("starsSearch")?.value;
        if (carried) filterStars(carried);
        await applyCachedSummaries(container);
    } catch (error) {
        console.error("Error initializing stars view:", error);
        container.innerHTML = "<p class=\"error-message\">Error loading starred pages.</p>";
    }
}

// Filter rendered .session-card elements based on the live #starsSearch value.
// Matches against bookmark title/URL and any context page titles/URLs.
function initStarsSearch() {
    const input = document.getElementById("starsSearch");
    if (!input) return;

    // Seed with the query carried from another view (URL ?q= or chrome.storage.session)
    // and keep the header links carrying it onward. The filter itself runs in
    // initStars once the cards are rendered.
    const initialQuery = readSharedQuery();
    input.value = initialQuery;
    decorateViewLinks(initialQuery.trim());

    let debounceTimer = null;
    input.addEventListener("input", (event) => {
        publishSharedQuery(event.target.value.trim());
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => filterStars(event.target.value), 150);
    });

    // Live-sync with edits made in other open views.
    onSharedQueryChange((query) => {
        input.value = query;
        filterStars(query);
        decorateViewLinks(query.trim());
    });
}

function filterStars(rawQuery) {
    const query = (rawQuery || "").trim().toLowerCase();
    const cards = document.querySelectorAll(".session-card");

    cards.forEach(card => {
        if (!query) {
            card.style.display = "";
            return;
        }
        const haystack = card.textContent.toLowerCase();
        card.style.display = haystack.includes(query) ? "" : "none";
    });

    // Hide empty session groups so headers don't float above no results.
    document.querySelectorAll(".session-group").forEach(group => {
        const visibleCard = group.querySelector(".session-card:not([style*=\"display: none\"])");
        group.style.display = (query && !visibleCard) ? "none" : "";
    });
}

// Pull cached AI summaries from chrome.storage.local['nanoSummaries'] (populated
// by readout.js's summarizer queue) and inject them into the rendered cards.
// Replaces the previous fire-and-forget chrome.runtime.sendMessage({action:'getSummaries'})
// whose response was never consumed.
async function applyCachedSummaries(container) {
    try {
        const result = await chrome.storage.local.get(["nanoSummaries"]);
        const summaries = result.nanoSummaries || {};
        if (!Object.keys(summaries).length) return;

        container.querySelectorAll(".session-card").forEach(card => {
            const url = card.dataset.bookmarkUrl;
            if (!url) return;
            const entry = summaries[url];
            if (!entry || !entry.summary) return;

            const content = card.querySelector(".session-card-content");
            if (!content) return;

            const summaryDiv = document.createElement("div");
            summaryDiv.className = "star-summary";
            summaryDiv.textContent = entry.summary;
            content.insertBefore(summaryDiv, content.firstChild);
        });
    } catch (error) {
        console.error("Error loading cached summaries:", error);
    }
}

async function createStarSessions(bookmarks) {
    // Fetch each bookmark's ±15min history context concurrently. This was a
    // serial await loop — one chrome.history.search per bookmark, each waiting
    // for the previous — so boot scaled linearly with bookmark count (up to
    // ~100 sequential round-trips). Promise.all collapses it to ~one, preserving
    // bookmark order.
    return Promise.all(
        bookmarks.map(async bookmark => ({
            bookmark,
            context: await getBookmarkContext(bookmark.dateAdded)
        }))
    );
}

async function getBookmarkContext(timestamp) {
    const fifteenMinutes = 15 * 60 * 1000;
    const startTime = timestamp - fifteenMinutes;
    const endTime = timestamp + fifteenMinutes;

    return new Promise((resolve) => {
        chrome.history.search({ text: "", startTime, endTime, maxResults: 100 }, (historyItems) => {
            resolve(historyItems);
        });
    });
}

function renderStarSessions(sessions, container) {
    container.innerHTML = ""; // Clear loading message

    if (!sessions || sessions.length === 0) {
        container.innerHTML = "<p class=\"info-message\">No recent bookmarks found.</p>";
        return;
    }

    const groupedSessions = groupSessionsByDate(sessions);

    for (const groupTitle in groupedSessions) {
        const groupContainer = document.createElement("div");
        groupContainer.className = "session-group";

        const groupHeader = document.createElement("h2");
        groupHeader.className = "session-group-header";
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
        "This Week": [],
        "Last Week": [],
        "This Month": [],
        "Older": [],
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
            groups["This Week"].push(session);
        } else if (sessionDate >= lastWeek) {
            groups["Last Week"].push(session);
        } else if (sessionDate >= thisMonth) {
            groups["This Month"].push(session);
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

import { formatTimeAgo } from "./timeago.js";
import { getLocalFaviconUrl } from "./utility.js";

function createStarCard(session) {
    const card = document.createElement("div");
    card.className = "session-card";

    const bookmark = session.bookmark;
    const context = session.context;

    // Stamp URL on the element so applyCachedSummaries() can match it later.
    card.dataset.bookmarkUrl = bookmark.url || "";

    let contextHTML = "";
    let contextSummary = "";
    if (context && context.length > 0) {
        contextSummary = `<p>${context.length} pages of context</p>`;
        contextHTML = "<ul class=\"session-pages-ul\" style=\"display:none;\">";
        for (const item of context) {
            const faviconUrl = getLocalFaviconUrl(item.url, 32);
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
        contextHTML += "</ul>";
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

    const toggleButton = card.querySelector(".toggle-context");
    toggleButton.addEventListener("click", () => {
        const contextList = card.querySelector(".session-pages-ul");
        if (contextList.style.display === "none") {
            contextList.style.display = "block";
        } else {
            contextList.style.display = "none";
        }
    });

    return card;
}

async function fetchRecentBookmarks(count) {
    return new Promise((resolve) => {
        chrome.bookmarks.getRecent(count, (bookmarks) => {
            resolve(bookmarks);
        });
    });
}
