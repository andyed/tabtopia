# Tabtopia

## Overview
Tabtopia is a Chrome extension that visualizes your browser history and open tabs using interactive D3.js visualizations. There are two core views -- treemap and graph. Both support search using the excellent [lunr.js](https://github.com/olivernn/lunr.js) library. The extension leverages Chrome's built-in AI capabilities to provide smart features like URL summarization.

## How To Use

### Treemap Navigation
1. **Basic Navigation**
   - Double-click or press Enter/Space to jump to a tab
   - Use arrow keys for keyboard navigation after selecting a node
   - Single-click a node to make the readout panel sticky
   - Press Escape to clear selection

2. **Tab Management**
   - Long press (750ms) on a node to initiate drag and drop
   - Drag nodes to move tabs between windows
   - Bookmark tabs with a single click
   - View domain-specific history and bookmarks in the readout panel

3. **Smart Features**
   - AI-powered URL summarization in the readout panel
   - Quick search with real-time filtering
   - Domain grouping and window organization
   - Automatic tab count and window statistics
   - Readout panel updates only when selected element changes

### Graph Exploration
1. **View Modes**
   - Press 't' for time-based view
   - Press 'd' for domain-based view
   - Press 'r' to reset the view

2. **Interaction**
   - Drag the canvas to pan
   - Use scroll wheel to zoom
   - Hover over nodes for details
   - Click to focus on specific domains or time periods

### Session View
1. **Smart Session Organization**
   - Automatic session grouping based on user activity
   - Micro-sessions for more granular activity tracking
   - Window and tab context-aware separation
   - Search query and clicked link tracking

2. **Visual Representation**
   - Descriptive session titles based on link text and search queries
   - Graph visualization with dwell time-based node sizing
   - Domain grouping and session timelines
   - Favicon and hero image enrichment

## Technical Architecture

### Core Components
1. **Tab Synchronization Engine**
   - Real-time tab state monitoring
   - Cross-window communication
   - Event-driven updates
   - Bookmark integration

2. **History Trail System**
   - Continuous browsing activity tracking
   - Domain-based aggregation
   - Temporal pattern analysis
   - Search indexing
   - Dwell time tracking and page importance scoring
   - Navigation source classification (link clicks, search results, direct entry)

3. **AI Integration**
   - Built-in Chrome AI Summarizer API for URL content
   - Smart context detection
   - Adaptive readout generation

### Use Cases and Extensions
The underlying synchronization and history trail system can be leveraged for various scenarios:

1. **Productivity Enhancement**
   - Work session analysis
   - Research path tracking
   - Context switching optimization
   - Tab organization patterns

2. **Knowledge Management**
   - Topic-based browsing clusters
   - Research journey mapping
   - Content relationship discovery
   - Domain expertise tracking

3. **Workflow Optimization**
   - Tab usage patterns
   - Window organization strategies
   - Frequent path identification
   - Context restoration

## Screenshots

### Treemap View
![Treemap visualization](screenshots/treemap.png)

### Graph View
![Graph visualization](screenshots/graph.png)




## Developer Installation
1. Clone this repository or download the zip
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer Mode" in the top-right corner
4. Click "Load Unpacked" and select the repository folder



## Technical Details

### Architecture
- **D3.js Visualizations**: Interactive treemaps and force-directed graph layouts
- **Chrome Extension APIs**: Integration with browser history, tabs, windows, and bookmarks
- **Responsive Design**: Dynamic layout management with window resize handling
- **Data Enrichment Layer**: 
  - Page dwell time calculation for relevance scoring
  - Navigation referral tracking (link text, search queries)
  - Session boundary detection and organization
  - Visual hierarchy based on interaction metrics


## Session View Implementation

The session view provides an enhanced way to visualize and explore browsing history organized into meaningful sessions:

### Smart Session Titles
- **Link-based Titles**: Uses referral link text to create descriptive titles (e.g., "example.com → 'Interesting Article'") 
- **Search-based Titles**: Falls back to search queries when no link text is available
- **Domain-based Titles**: Uses domain and page title as final fallback
- **Automatic truncation** of overly long titles for better UI presentation

### Graph Visualization
- **Dwell Time Node Sizing**: Page importance visually indicated through node size
  - Base size: < 30 seconds
  - Larger sizes: > 30 seconds, > 3 minutes, > 6 minutes, > 12 minutes
- **Edge Direction**: Shows navigation flow between pages
- **Interactive tooltips**: Displays page title, URL, and search queries

### Data Collection
- **Dwell Time**: Time spent on each page calculated through tab focus events and navigation
- **Referral Information**: How users arrived at pages (link clicks, search, direct navigation)
- **Search Queries**: Extraction and association with resulting page visits

## Development Notes

This extension was developed as an exploration of browser data visualization, with significant portions of the code generated with the assistance of AI tools. The AI helped with:

- D3.js visualization implementations and layout algorithms
- Event handling and responsive design
- Chrome extension API integration
- UI component structure and styling

Anthropic and OpenAI models inside Visual Studio Code were the primary contributors, but a minority of development also occurred in Cursor with similar models. 

Human oversight, editing, and testing were applied throughout development to ensure quality, performance, and proper integration with browser APIs.

## Related Projects 

Alternatives with similar functionality
- [Tab Manager Plus](https://github.com/stefanXO/Tab-Manager-Plus): a treemap of favicons using an overlay
- [Fuzzy Finder](https://github.com/siadat/chrome-ff): 'ff' to url bar search your open tabs with fuzzy matching
- Older: [Tab Switcher](https://github.com/kamranahmedse/tab-switcher), [fast tab switcher](https://github.com/BinaryMuse/chrome-fast-tab-switcher)
- [Search All Tabs](https://github.com/lunu-bounir/search-all-tabs)

Inspiration
- - [Galaxy Tab](https://github.com/Katee/galaxy-tab): a D3 force visualization from 12 years ago, still works!


See also github's [Browser Extension topic](https://github.com/topics/browser-extension)
and [makeuseof 10 tab management extensions](https://www.makeuseof.com/tag/10-extensions-chrome-tab-management/)
---
