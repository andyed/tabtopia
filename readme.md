
#### Overview

We will develop a Chrome extension using D3.js to create two linked visualizations of the user's recent browsing history. The visualizations will include:

1. A sessionized view of the recent history (last ~200 events).
2. A node-link force graph of the actual URLs visited.

#### Visualizations

1. **Timeline (Top Visualization)**
    
    - Displays a history swimlane and a swimlane for each window.
    - History entries from closed windows and tabs will be shown in the history swimlane.
    - The history swimlane will be double height with jittered x-axis for better visualization.
2. **Node-Link Force Graph (Bottom Visualization)**
    
    - Displays the actual URLs visited as nodes.
    - Edges between nodes will be created based on the browser history transition type (e.g., no edges for typed URL visits).

#### Initialization and Updates

- The extension will initialize with both history and active window/tab data.
- The graph will update dynamically as users browse.

#### Details

- **Favicons**:
    
    - Use favicons for the default display of sessions or URLs.
    - Differentiate session favicons from visited URLs.
- **Brushing**:
    
    - When a user mouses over a swimlane, highlight the corresponding nodes in the graph from that window.
- **Zooming**:
    
    - Allow users to zoom into more recent history.
    - Zooming will reduce the range of time viewed and adjust the layout of elements in both the timeline and the graph.

#### Features

- **Edge Creation**:
    
    - Use the browser history transition type to determine edge creation between nodes.
    - No edges for typed URL visits.
- **Swimlane Visualization**:
    
    - History swimlane will be double height.
    - X-axis will be jittered for better visualization.
- **Dynamic Updates**:
    
    - The visualizations will update in real-time as users continue to browse.