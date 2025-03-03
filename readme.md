# Tabtopia

## Overview
Tabtopia is a Chrome extension that visualizes your browser history and open tabs using interactive D3.js visualizations. Explore your browsing data through intuitive treemap and network graph layouts. The application also adds more precise tracking of "browsing trails" than the browser typically allows. 

## Features

- **Dynamic Visualizations**
  - **Treemap View**: Organize tabs by window with size reflecting usage time
  - **Network Graph View**: Explore connections between history items with two distinct modes

- **Responsive Layout**: Automatically adjusts to your browser window size
- **Tab Management**: Close, switch, or bookmark tabs directly from the visualization
- **Contextual Information**: View detailed metadata about tabs and their relationships

## How to Use

### Visualization Modes
- **Treemap**: See all tabs organized hierarchically by window
- **Graph**: Explore connections between browsing history items with two modes:
  - **Timeline Mode**: Visualize your browsing journey chronologically, showing the sequence of page visits
  - **Domain Clustered Mode**: Group related pages by domain, revealing website-based relationships

### Controls
- **Hover** over elements to see details
- **Click** to select and focus
- **Double-click** on tab representations to navigate to that tab
- **Search** to filter by title or URL
- **Toggle** between visualization modes using the view selector

## Technical Details

### Architecture
- **D3.js Visualizations**: Interactive treemaps and force-directed graph layouts
- **Chrome Extension APIs**: Integration with browser history, tabs, windows, and bookmarks
- **Responsive Design**: Dynamic layout management with window resize handling

### Implementation Notes
- Debounced event handlers for performance optimization
- Modular component design for maintainability
- Dynamic calculation of layout dimensions

## Development Notes

This extension was developed as an exploration of browser data visualization, with significant portions of the code generated with the assistance of AI tools. The AI helped with:

- D3.js visualization implementations and layout algorithms
- Event handling and responsive design
- Chrome extension API integration
- UI component structure and styling

Human oversight, editing, and testing were applied throughout development to ensure quality, performance, and proper integration with browser APIs.



---

*Tabtopia: Visualize your browsing, understand your habits*