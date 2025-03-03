

## How to Use

### Treemap Visualization
- The main interface shows your open tabs as colored rectangles in a treemap layout
- Each window is a distinct color group
- Rectangle size indicates tab usage time
- Brighter colors indicate recently accessed tabs

### Readout Panel
- **Hover** over a tab to see detailed information in the readout panel
- The panel shows:
  - Tab title and URL
  - Last accessed time
  - Related bookmarks from the same domain
  - Related history entries from the same domain
- **Click** a tab to pin its details (keeps the readout panel open)
- **Click** elsewhere to unpin the details

### Mouse Controls
- **Hover** over a tab to see details
- **Click** a tab to pin its details
- **Double-click** a tab to switch to it
- **Hover** shows a close button (X) in the top-right corner of each tab
- **Click** the close button to close that tab

### Keyboard Navigation
- **Tab** key to move focus between tabs
- **Arrow keys** to navigate between tabs:
  - **←** Move to closest tab on the left
  - **→** Move to closest tab on the right
  - **↑** Move to closest tab above
  - **↓** Move to closest tab below
- **Enter** to switch to the focused tab
- **Backspace** or **Delete** to close the focused tab

### Search
- Use the search box to find tabs by title or URL
- Results will filter the visualization to matching tabs
- Press **Esc** to clear the search and return to the full view

### Visual Indicators
- Focused tabs are highlighted in yellow
- Recently accessed tabs are shown in brighter colors
- Each window's tabs are grouped together with a distinct color scheme
- Bookmarks have a green indicator in the readout panel

### Bookmark Integration
- Related bookmarks from the same domain appear in the readout panel
- Click on a bookmark to open it in a new tab
- Bookmarks are distinguished with a green accent in the readout panel

### History Integration
- Recent history from the same domain appears in the readout panel
- Each history item shows when it was last visited
- Click on a history item to navigate to that page

## Under the Hood

### Data Structures
- **Tab Activity Log**: Maps tab IDs to their activity records, tracking focus time and navigation events
- **Navigation Events**: Tracks page loads and URL changes across tabs
- **Tab Edges**: Maintains a graph of connections between related tabs
- **History Cache**: Optimizes history lookups by caching results by domain

### Event Listeners
- **Chrome History API**: Captures browsing history for visualization and relationship mapping
- **Tab Events**: Monitors tab creation, activation, updates, and removal
- **Window Focus**: Tracks active windows to determine current context
- **Navigation Events**: Records page loads and URL changes for accurate history tracking
- **User Interaction**: Monitors keyboard and mouse activity to determine active browsing vs idle time

### Performance Optimizations
- **Debounced Updates**: Prevents excessive redraws during rapid tab switching
- **Time-based Aggregation**: Consolidates short visits to the same site
- **Cached Lookups**: Minimizes expensive API calls by caching history and bookmark data
- **Throttled Renderings**: Limits visualization updates during high-activity periods

### Visualization Engine
- **D3.js Treemap**: Hierarchical visualization of tabs and windows
- **Dynamic Scaling**: Adapts cell sizes based on tab usage patterns
- **Color Gradients**: Indicates recency and relationships between tabs
- **Spatial Algorithm**: Optimizes tab placement for intuitive navigation



## Other Chrome Extensions
- Searchbox overlay for tab switching
  - https://github.com/kamranahmedse/tab-switcher





# todo

Major Issues:
Duplicate Event Listeners

