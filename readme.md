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
   - Built-in Chrome AI Summarizer API for URL content with fallback support
   - Aggressive crash detection and recovery system
   - Smart context detection and adaptive readout generation
   - Background worker content extraction to bypass security restrictions
   - Automatic fallback to heuristic summaries when AI is unavailable

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

## Debug Tools and Console Functions

The extension provides several debug functions accessible via the browser console for troubleshooting and monitoring:

### Summary Queue Management
```javascript
// View current summary queue statistics
getQueueStats()
// Returns: { queueSize, isProcessing, stats, config }

// Add URL to summary generation queue
addToSummaryQueue("https://example.com")

// Clear all pending summaries from queue
clearSummaryQueue()

// Manually process the summary queue
processSummaryQueue()
```

### Chrome Summarizer API Debugging
```javascript
// Check current summarizer status and crash information
getSummarizerStatus()
// Returns: { crashCount, inBackoff, globallyDisabled, etc. }

// Reset crash counter and re-enable summarizer
resetSummarizerCrashCounter()

// Flush all cached summaries (forces regeneration)
flushSummaryCache()
```

### Audio Playback Tracking
```javascript
// View audio playback statistics for all tabs
getAudioTrackingStats()
// Returns: { totalTrackedTabs, currentlyAudibleTabs, totalAudioDuration, trackedTabs[] }

// Get current audio duration for a specific tab (includes ongoing playback)
getCurrentAudioDuration(tabId)
// Returns: duration in milliseconds

// Reset audio tracking data (optionally for specific tab)
resetAudioTracking()        // Reset all tabs
resetAudioTracking(tabId)   // Reset specific tab only
```

### Debug Access
- **Triple-click the "Debug" link** in the header to access debug tools
- Navigate to `chrome-extension://[extension-id]/src/newtab/debug.html` directly
- Debug tools include state inspection, cache management, and API testing

### Console Debugging
Open browser DevTools (F12) and use these commands:

```javascript
// View all available debug functions
console.log(Object.keys(window).filter(k => k.includes('Queue') || k.includes('Summarizer')));

// Monitor summary generation in real-time
window.addEventListener('summaryGenerated', (e) => {
    console.log('Summary generated:', e.detail);
});

// Check extension state
chrome.runtime.sendMessage({type: 'getInitialState'}, console.log);
```

## Troubleshooting

### Common Issues and Solutions

#### Chrome Summarizer API Issues
**Problem**: "The model process crashed too many times" error messages
**Solution**: 
- The extension automatically detects and suppresses these messages
- Summarizer is disabled for 10 minutes after crashes to prevent spam
- Use `resetSummarizerCrashCounter()` in console to manually re-enable
- Fallback summaries are generated using URL structure and metadata

#### Treemap Not Loading
**Problem**: Empty treemap or "Invalid data" warnings
**Solution**:
- Check console for specific error messages
- Use `chrome.runtime.sendMessage({type: 'getInitialState'}, console.log)` to inspect data
- Extension automatically attempts to repair malformed data structures
- Refresh the page if state becomes corrupted

#### Summary Generation Issues
**Problem**: Summaries not appearing or stuck in loading state
**Solution**:
```javascript
// Check queue status
getQueueStats()

// Clear stuck queue
clearSummaryQueue()

// Force regeneration
flushSummaryCache()

// Check summarizer availability
getSummarizerStatus()
```

#### Performance Issues
**Problem**: Extension running slowly or consuming memory
**Solution**:
- Summary cache is automatically cleaned every 5 minutes
- Use `flushSummaryCache()` to clear all cached data
- Queue processing is limited to 2 concurrent operations
- Background worker handles content extraction to reduce main thread load

### Debug Mode Access
1. **Via UI**: Triple-click the "Debug" link in the extension header
2. **Direct URL**: Navigate to `chrome-extension://[your-extension-id]/src/newtab/debug.html`
3. **Console Access**: All debug functions are available in browser DevTools

### Reporting Issues
When reporting bugs, please include:
- Console output from DevTools
- Output from `getSummarizerStatus()` and `getQueueStats()`
- Chrome version and extension version
- Steps to reproduce the issue

## Technical Details

### Architecture
- **D3.js Visualizations**: Interactive treemaps and force-directed graph layouts
- **Chrome Extension APIs**: Integration with browser history, tabs, windows, and bookmarks
- **Responsive Design**: Dynamic layout management with window resize handling
- **Enhanced Content Extraction System**:
  - Background worker content extraction bypasses security restrictions
  - Multi-strategy content retrieval (direct injection, metadata, URL analysis)
  - Fallback content generation for restricted pages
  - Intelligent content validation and filtering
- **Data Enrichment Layer**: 
  - Page dwell time calculation for relevance scoring
  - Navigation referral tracking (link text, search queries)
  - Audio playback duration tracking across all tabs (focus-independent)
  - Session boundary detection and organization
  - Visual hierarchy based on interaction metrics
- **Robust Error Handling**:
  - Automatic crash detection and recovery for AI services
  - Graceful degradation when APIs are unavailable
  - Comprehensive state validation and repair
  - User-friendly error messages and debugging tools


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

## Development Guidelines

### Content Security Policy (CSP) Compliance
⚠️ **CRITICAL**: Chrome extensions enforce strict Content Security Policy rules.

**❌ Never use inline scripts:**
```html
<!-- This will cause CSP violations -->
<script>
    console.log('This breaks CSP!');
</script>
```

**✅ Always use external script files:**
```html
<!-- This is CSP compliant -->
<script src="my-script.js"></script>
```

**Other CSP Requirements:**
- No `eval()` or `new Function()` 
- No inline event handlers (`onclick="..."`)
- No inline styles (use external CSS files)
- Use `chrome.runtime.getURL()` for extension resources

### Extension Development Best Practices

1. **Error Handling**
   - Always implement graceful fallbacks for API failures
   - Use try-catch blocks around Chrome API calls
   - Provide meaningful error messages to users

2. **Performance**
   - Debounce frequent operations (DOM updates, API calls)
   - Use background workers for heavy processing
   - Implement caching for expensive operations
   - Clean up event listeners and timers

3. **Permissions**
   - Request minimum necessary permissions
   - Handle permission denials gracefully
   - Document why each permission is needed

4. **Chrome API Usage**
   - Always check `chrome.runtime.lastError` after API calls
   - Use `sendResponse()` properly in message handlers
   - Return `true` from async message handlers
   - Validate all incoming message data

5. **State Management**
   - Validate data structures before use
   - Implement state repair mechanisms
   - Use consistent data formats across components
   - Handle edge cases (empty states, missing data)

### Testing and Debugging

- Use the built-in debug functions documented above
- Test with various tab/window configurations
- Verify CSP compliance in DevTools
- Test permission edge cases
- Monitor memory usage during development

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
