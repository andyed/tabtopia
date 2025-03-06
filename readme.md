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
   - Close tabs directly from the visualization
   - Drag nodes to move tabs between windows
   - Bookmark tabs with a single click
   - View domain-specific history and bookmarks in the readout panel

3. **Smart Features**
   - AI-powered URL summarization in the readout panel
   - Quick search with real-time filtering
   - Domain grouping and window organization
   - Automatic tab count and window statistics

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

Inspiration
- - [Galaxy Tab](https://github.com/Katee/galaxy-tab): a D3 force visualization from 12 years ago, still works!


See also github's [Browser Extension topic](https://github.com/topics/browser-extension)
---
