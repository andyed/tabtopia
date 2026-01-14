# Enriched History Tracking

Tabtopia goes beyond standard browser history by enriching the data with context, relationships, and attention metrics. This document details the mechanisms used to capture this data.

## 1. Dwell Time & Attention Tracking
Standard history only tells you *that* a page was visited. Tabtopia tells you *if it mattered*.

### How it works
- **Active Tab Polling**: The background script tracks the currently active tab ID and window ID.
- **Attention Thresholds**:
  - **Active Threshold**: User must be on the tab for at least 1 second (1000ms) for it to count as a "visit". This eliminates noise from rapid tab switching.
  - **Idle Threshold**: If a tab receives no interaction for 5 minutes, it is considered "idle" even if it is technically the active tab.
- **Accumulation**: Time is accumulated in a `tabActivityLog` map. When a tab loses focus or is closed, the accumulated duration is committed to the history record.

## 2. Audio Tracking
Identifying media-heavy sessions is key to understanding browsing context.

### detection
- **Chrome Tabs API**: We listen for the `audible` property change events from the Tabs API.
- **Session Tracking**:
  - When audio starts: We record the `audioStartTime`.
  - When audio stops: We calculate the duration (`Date.now() - audioStartTime`) and add it to the tab's `totalAudioDuration`.
- **Enrichment**: This data allows the UI to show visual indicators (speaker icons) and prioritize potential media tabs in summaries.

## 3. Relationship Mapping (The "History Graph")
To visualize the "web" of your browsing, we must understand how pages connect.

### Edge Types
We track several types of relationships between pages (Nodes):

1.  **Navigation (Referrer)**:
    - **Source**: The `referer` header or the tab that initiated the navigation.
    - **Confidence**: High. This is a direct causal link.
    - **Transition Types**: We distinguish between `link` clicks, `typed` URLs, and `auto_bookmark` openings.

2.  **Redirects**:
    - **Chain Tracking**: We capture the full redirect chain (e.g., Short Link -> Analytics -> Final Page).
    - **Graph Representation**: These are represented as dotted lines or merged edges to show the path without cluttering the view.

3.  **Opener (Parent/Child)**:
    - **Mechanism**: When a new tab is opened, we capture its `openerTabId`.
    - **Usage**: Critical for the Treemap view to group "child" tabs (e.g., search results) with their "parent" (e.g., search page).

4.  **Temporal Sequence (Fallback)**:
    - **Logic**: If Page B is visited < 2 minutes after Page A, and no other link exists, we infer a weak temporal connection.
    - **Visualization**: Shown as faint, low-opacity edges in the graph.

## 4. Session Context
Browsing isn't a continuous stream; it happens in bursts or "sessions".

### Segmentation Logic
- **Inactivity Timeout**: A global inactivity period of > 30 minutes triggers the creation of a new "Session".
- **Micro-Sessions**: Granular clusters of activity defined by:
  - 5 minutes of inactivity.
  - Opening a new window.
  - A burst of rapid new tab creations.

### Semantic Titling
Sessions aren't just "Session #12". They are titled based on content:
- **Search Query Extraction**: If a session starts with a Google search for "React hooks", the session is named "React hooks".
- **Dominant Domain**: If mostly browsing `reddit.com`, it's named "Reddit Session".
- **Link Text**: We attempt to capture the text of the link that started the session.

## Data Storage
- **Browser State**: In-memory `Map` structures in the Background Service Worker for fast O(1) access.
- **Persistence**: Periodically flushed to `chrome.storage.local` to survive browser restarts.
