# Tabtopia Capabilities & Features

Tabtopia transforms your browser history and active tabs into interactive, data-driven visualizations. This document outlines the core capabilities and features available to users.

## 1. Visualizations

### 🌳 Treemap View (Default)
The primary interface is a responsive **Treemap** that visualizes your open tabs and windows.
- **Hierarchical Layout**: Tabs are grouped by their parent window.
- **Size by Activity**: Tabs are sized based on "time spent" or importance (if data available).
- **Color by Recency**: Color gradients indicate which tabs were most recently accessed.
- **Favicon Integration**: Logos and favicons are automatically fetched (with smart letter fallbacks) for quick recognition.
- **Fallback Mode**: Displays recent bookmarks if no windows are open, ensuring the new tab page is never empty.

### 🕸️ Graph View
A force-directed graph visualization that reveals relationships between your browsing habits.
- **Node Connections**: Shows how tabs are related (e.g., opened from parent, same domain).
- **Time/Domain Modes**: Toggle between time-based clustering or domain-based clustering.
- **Interactive Physics**: Drag nodes to rearrange the graph; scroll to zoom in/out.

### 📚 Session View
Organizes your browsing history into logical "sessions" rather than a linear list.
- **Smart Grouping**: Automatically groups activity based on time thresholds (e.g., >30 min inactivity starts a new session).
- **Context Awareness**: Tracks search queries and link clicks to title sessions intelligently.
- **Dwell Time**: Highlights pages you actually read vs. those you quickly closed.

### ⭐ Stars View (Bookmarks)
A dedicated interface for exploring your bookmarks with context.
- **Contextual Recall**: When viewing a bookmark, see what other pages were open at that time (15-min window).
- **Temporal Grouping**: Bookmarks are organized by "Today", "Yesterday", "Last Week", etc.
- **Visual Cards**: Bookmarks appear as rich cards rather than simple text links.

## 2. Interactive Management

### 🖱️ Drag-and-Drop Organization
Manage your windows intuitively directly from the Treemap.
- **Long Press to Drag**: Click and hold a tab for 750ms to "pick it up".
- **Window Transfer**: Drag the tab to another window block to move it instantly in the browser.
- **Visual Feedback**: Valid drop targets highlight as you drag.

### ⌨️ Keyboard Navigation
Navigate your tabs without touching the mouse.
- **Arrow Keys**: Move focus between adjacent tabs in the treemap.
- **Enter/Space**: Switch to the focused tab.
- **'t', 'd', 'r'**: Shortcuts in Graph view for Time/Domain/Reset modes.
- **Esc**: Clear current selection.

### 🔍 Real-time Search
Built-in powerful search using [Lunr.js].
- **Instant Filtering**: Type to filter visible tabs by title or URL.
- **Deep Search**: Indexes history and open tabs.

### 📱 Readout Panel
A sticky side-panel (or overlay) that provides deep details on the selected item.
- **Metadata**: Shows full title, URL, last accessed time, and visit count.
- **Actions**: Quick buttons to bookmark, close, or focus the tab.
- **AI Summary**: Displays a generated summary of the page content.

## 3. Intelligence & Analytics

### 🧠 AI Summarization
Leverages Chrome's local AI capabilities (Gemini Nano) to summarize page content.
- **Privacy-First**: Summarization happens locally or via secure background workers; browsing data doesn't leave your machine.
- **Fallback Mechanisms**: If the AI is unavailable, falls back to heuristic summaries based on metadata.

### ⏱️ Dwell Time & Activity Tracking
Goes beyond simple history to understand *attention*.
- **Active vs. Idle**: Distinguishes between a tab being "open" and being "actively viewed".
- **Time Spent**: Tracks cumulative active time on pages to size them in visualizations.

### 🔊 Audio Tracking
Visualizes tabs that are playing media.
- **Indicators**: Tabs playing audio show a speaker icon or distinct visual marker.
- **History**: Tracks total audio duration per tab.

### 🔗 Link & Context Mapping
- **Origin Tracking**: Remembers *how* you got to a page (e.g., "Opened from Google Search", "Clicked link in Reddit").
- **Back/Forward Tracing**: Visualizes navigation paths in the Session view.
