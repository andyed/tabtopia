# Graph Visualization & Layout Techniques

The Graph View in Tabtopia uses a force-directed layout engine (D3.js) to visualize the relationships and temporal patterns of your browsing history. This document explains the specific forces and algorithms used.

## 1. Node Properties

Each circle in the graph represents a URL (page).

*   **Sizing (`r`)**:
    *   **Active Tabs**: Fixed large size (`12px`) to stand out.
    *   **Bookmarks**: Fixed medium size (`10px`).
    *   **History Items**: Dynamic sizing based on a weighted formula:
        *   `Base Size`: 5px
        *   `Visit Factor`: Logarithmic scale of visit count.
        *   `Time Factor`: Logarithmic scale of total time spent (dwell time).
        *   Formula: `Base + (VisitFactor * 0.6) + (TimeFactor * 0.4)`
*   **Coloring**:
    *   **Spectral Interpolation**: A hash of the domain name (e.g., "google.com") maps to a color on the spectral spectrum. This ensures all pages from the same domain share a consistent color.
    *   **Active/Bookmark overrides**: Active tabs get a distinct blue (`#64b5f6`), bookmarks green (`#66bb6a`).

## 2. Layout Modes & Forces

The simulation uses different "forces" depending on the selected View Mode to achieve different insights.

### Common Forces
These active in all modes:
*   **Link Force**: Pulls connected nodes together. Length `80px`. Strength varies by relationship confidence (Navigation > Opener > Temporal).
*   **Collision**: Prevents nodes from overlapping (`radius + 2px`).
*   **Center**: A weak gravity pulling everything to the middle of the canvas.

### Mode A: Time View (Chronological)
Focuses on *when* things happened.

*   **X-Axis (Time)**:
    *   Nodes are positioned horizontally based on their `lastVisitTime`.
    *   Uses a `d3.scaleLinear` to map time to the canvas width.
*   **Y-Axis (Scatter)**:
    *   **Active Tabs**: Levitated to the top 20-40% of the screen.
    *   **History**: Scattered vertically between 35-85% of screen height based on their domain hash. This creates "lanes" where similar domains appear at similar heights, reducing clutter.
*   **Charge**: Strong repulsion (`-100`) to increase spacing.

### Mode B: Domain View (Clustering)
Focuses on *what* belongs together.

*   **Domain Clustering Force**:
    *   A custom force (`createDomainClusterForce`) that calculates the centroid (geometric center) of all nodes sharing the same domain.
    *   It gently pulls all constituent nodes toward that specific centroid.
    *   Result: Distinct "islands" or clusters of related content (e.g., a "YouTube island", a "GitHub island").
*   **Weak Time Pull**: Still maintains a slight chronological order on the X-axis so history flows roughly left-to-right, but clustering takes precedence.

## 3. Edge Styling
Edges are styled to convey the nature of the relationship:

*   **Solid Blue**: Direct navigation (clicked a link).
*   **Solid Purple**: Opener relation (right-click "Open in new tab").
*   **Dashed Red**: Redirect chain (usually invisible to user).
*   **Faint Grey**: Temporal proximity (inferred relationship).

## 4. Interaction Physics
*   **Sticky Drag**: Dragging a node "heats up" the simulation (`alphaTarget(0.3)`), causing the graph to reorganize dynamically around the moved node.
*   **Pinning**: Nodes can be "fixed" in place (pinned) to manually organize the view. Double-clicking unpins them.
