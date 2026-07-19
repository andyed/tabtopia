// Session renderers for different display modes
import { createSessionCard, createSessionMosaic } from "./hero_images_display.js";
/**
 * Renders sessions in mixed layout with both standard and double-width cards
 * @param {Array} sessions - Array of session objects to render
 * @param {HTMLElement} container - Container element to render sessions into
 * @param {boolean} isRefresh - Whether this is a refresh operation
 */
export async function renderSessionCards(sessions, container, isRefresh = false) {
  // One bulk read replaces the old per-page storage.get + background-message
  // chain in createSessionCard. Missing entries simply render image-free cards,
  // exactly as they did after an empty lookup.
  let heroImagesStore = {};
  try {
    const stored = await chrome.storage.local.get(["heroImages"]);
    heroImagesStore = stored.heroImages || {};
  } catch (error) {
    console.warn("[Sessions Renderer] hero-image cache unavailable", error);
  }

  // If not refreshing, clear the container
  if (!isRefresh) {
    container.innerHTML = "";
  } else {
    // If refreshing, only remove the content inside date groups, but keep the structure
    const dateGroups = container.querySelectorAll(".date-milestone");
    dateGroups.forEach(group => {
      const sessionRow = group.nextElementSibling;
      if (sessionRow && sessionRow.classList.contains("sessions-cards-row")) {
        sessionRow.innerHTML = "";
      }
    });
  }

  // If no sessions, show message
  if (!sessions || sessions.length === 0) {
    container.innerHTML = "<p class=\"info-message\">No browsing sessions found.</p>";
    return;
  }

  // Group sessions by date
  const sessionsByDate = groupSessionsByDate(sessions);

  // Sort dates (newest first)
  const sortedDates = Object.keys(sessionsByDate).sort((a, b) => {
    return new Date(b) - new Date(a);
  });

  // Calculate age range for color coding
  // Find oldest and newest session timestamps
  let oldestTime = Date.now();
  let newestTime = 0;

  sessions.forEach(session => {
    if (session.startTime < oldestTime) oldestTime = session.startTime;
    if (session.startTime > newestTime) newestTime = session.startTime;
  });

  const timeRange = newestTime - oldestTime;

  // Render each date group
  for (const dateKey of sortedDates) {
    const dateDisplay = formatDateDisplay(dateKey);
    const sessionsForDate = sessionsByDate[dateKey];
    console.log("[Sessions Renderer] Rendering date group", { dateKey, dateDisplay, count: sessionsForDate?.length || 0 });

    // Create date milestone if it doesn't exist yet
    let dateGroup = container.querySelector(`[data-date="${dateKey}"]`);
    let cardsRow;

    if (!dateGroup) {
      // Create new date milestone and cards row
      dateGroup = document.createElement("div");
      dateGroup.className = "date-milestone main-milestone";
      dateGroup.setAttribute("data-date", dateKey);
      dateGroup.textContent = dateDisplay;
      container.appendChild(dateGroup);

      // Create cards row container
      cardsRow = document.createElement("div");
      cardsRow.className = "sessions-cards-row";
      container.appendChild(cardsRow);
    } else {
      // Find existing cards row
      cardsRow = dateGroup.nextElementSibling;
      if (!cardsRow || !cardsRow.classList.contains("sessions-cards-row")) {
        cardsRow = document.createElement("div");
        cardsRow.className = "sessions-cards-row";
        dateGroup.insertAdjacentElement("afterend", cardsRow);
      }

      if (isRefresh) {
        cardsRow.innerHTML = ""; // Clear existing cards on refresh
      }
    }

    // Render cards for sessions in this date
    for (const session of sessionsForDate) {
      try {
        // Calculate relative age for color coding (0 = newest, 1 = oldest)
        console.log("[Sessions Renderer] Creating card for session", { id: session?.id, pages: Array.isArray(session?.pages) ? session.pages.length : session?.pages });
        const relativeAge = timeRange === 0 ? 0 : (newestTime - session.startTime) / timeRange;

        // Create session card element with age info
        const card = await createSessionCard(session, { relativeAge, heroImagesStore });
        if (card) {
          cardsRow.appendChild(card);


          // Optional: mark append success for debugging
          console.log("[Sessions Renderer] Appended card", { id: session?.id });
        } else {
          console.warn("[Sessions Renderer] createSessionCard returned null/undefined", { id: session?.id });
        }
      } catch (error) {
        console.error("Error creating session card:", error);
      }
    }
  }
}

/**
 * Render session with mosaic image layout
 * @param {Object} session - Session data object
 * @param {HTMLElement} detailsContainer - Container to append the mosaic to
 */
export async function renderSessionWithMosaic(session, detailsContainer) {
  // Create mosaic element
  try {
    const mosaic = await createSessionMosaic(session);
    if (mosaic) {
      // Add the mosaic element to the session content
      detailsContainer.insertBefore(mosaic, detailsContainer.firstChild);
    }
  } catch (error) {
    console.error("Error creating session mosaic:", error);
  }
}

/**
 * Groups sessions by their date and sorts them by start time (newest first)
 * @param {Array} sessions - Array of session objects
 * @returns {Object} - Object with dates as keys and arrays of sessions as values sorted by recency
 */
function groupSessionsByDate(sessions) {
  const sessionsByDate = {};

  sessions.forEach(session => {
    const date = new Date(session.startTime);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const dateKey = `${year}-${month}-${day}`;

    if (!sessionsByDate[dateKey]) {
      sessionsByDate[dateKey] = [];
    }

    sessionsByDate[dateKey].push(session);
  });

  // Sort sessions within each date group by start time, newest first
  Object.keys(sessionsByDate).forEach(dateKey => {
    sessionsByDate[dateKey].sort((a, b) => b.startTime - a.startTime);
  });

  return sessionsByDate;
}

/**
 * Format date for display
 * @param {string} dateKey - Date key in format YYYY-MM-DD
 * @returns {string} - Formatted date string
 */
function formatDateDisplay(dateKey) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const todayKey = formatDateKey(today);
  const yesterdayKey = formatDateKey(yesterday);

  if (dateKey === todayKey) {
    return "Today";
  } else if (dateKey === yesterdayKey) {
    return "Yesterday";
  } else {
    const dateParts = dateKey.split("-");
    const date = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
    return date.toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });
  }
}

/**
 * Format date as YYYY-MM-DD
 * @param {Date} date - Date object
 * @returns {string} - Formatted date key
 */
function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
