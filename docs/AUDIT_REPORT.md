# Enriched History & Tracking Audit Report

**Date:** 2026-01-14
**Status:** ⚠️ Partial Implementation Match

This document summarizes the results of an accuracy audit comparing the `ENRICHED_HISTORY.md` documentation against the actual codebase (`background.js`, `sessions.js`).

## ✅ Verified Features

The following features function exactly as documented:

1.  **Navigation Source Tracking**
    *   **Mechanism:** `chrome.webRequest.onBeforeSendHeaders` correctly captures the `Referer` header.
    *   **Status:** Active. Data is stored in `webRequestData` and linked to navigation events.

2.  **Transition Type Classification**
    *   **Mechanism:** `chrome.webNavigation.onCommitted` correctly extracts `transitionType` (e.g., `link`, `typed`, `auto_bookmark`) and `transitionQualifiers`.
    *   **Status:** Active.

3.  **Session Segmentation Strategy**
    *   **Mechanism:** `sessions.js` implements the 30-minute `SESSION_GAP_THRESHOLD` and 5-minute `MICRO_SESSION_GAP_THRESHOLD`.
    *   **Status:** Active. The logic correctly segments linear history into logical blocks.

4.  **Data Deduplication**
    *   **Mechanism:** Navigation events are debounced and checked against `processedNavigations` to prevent duplicate entries from Chrome's API quirks.

## ⚠️ Discrepancies & Gaps

The following areas show logic gaps or deviations from the documentation:

### 1. Audio Tracking Triggers
*   **Documented:** "We listen for the audible property change events."
*   **Finding:** The function `updateAudioTracking` exists, but there is no call site in `chrome.tabs.onUpdated` that specifically listens for `changeInfo.audible`.
*   **Impact:** Real-time audio status changes (e.g., muting/unmuting or auto-play start) may be missed unless a full tab update (title/url) occurs simultaneously.

### 2. Opener Relationship Persistence
*   **Documented:** "When a new tab is opened, we capture its openerTabId."
*   **Finding:** The `background.js` file does not appear to have a `chrome.tabs.onCreated` listener that explicitly saves `openerTabId` to the `tabRelationships` map.
*   **Impact:** Parent/Child relationships are correctly visualized for *currently open* tabs (via `graph.js` querying live browser state), but this relationship data is not persisted to history after tabs are closed.

### 3. Dwell Time Thresholds
*   **Documented:** "Active Threshold: 1 second (1000ms)".
*   **Finding:** The code uses mixed thresholds.
    *   `TAB_ACTIVITY.ACTIVE_THRESHOLD` is `1000ms`.
    *   However, `chrome.tabs.onActivated` uses a hardcoded `> 500ms` check to record history dwell time.
*   **Impact:** Minor inconsistency. visits between 0.5s and 1.0s are recorded in history but might be excluded from aggregate "time spent" analytics.

### 4. Idle Detection
*   **Documented:** "Idle Threshold: 5 minutes".
*   **Finding:** `TAB_ACTIVITY.IDLE_THRESHOLD` is defined as `300000` (5 mins), but no code currently uses this constant to stop active timers.
*   **Impact:** If a user leaves a tab open and active but walks away from the computer, the dwell time timer continues indefinitely until the computer sleeps or the window focus changes.

## Recommendations

1.  **Fix Audio Listener:** Add `if (changeInfo.audible !== undefined) updateAudioTracking(tabId, changeInfo.audible);` to the `chrome.tabs.onUpdated` listener in `background.js`.
2.  **Persist Opener IDs:** Add a `chrome.tabs.onCreated` listener in `background.js` to immediately capture and store `openerTabId` in `tabRelationships`.
3.  **Implement Idle Check:** usage `chrome.idle` API to pause active timers when the system is locked or idle.
