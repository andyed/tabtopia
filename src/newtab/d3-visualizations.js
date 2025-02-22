import { getFaviconUrl } from './utility.js';
import { showTooltipInfo, hideTooltipInfo, updateStats } from './d3-readout.js';
import { updateNodeReadout, clearReadout } from './d3-readout.js';

// Add near the top with other utility functions

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Update margin constant at the top
const margin = { top: 0, right: 0, bottom: 20, left: 0 }; // Only keep bottom margin for axis
export const sharedTimeScale = d3.scaleTime();
let width, height; // Declare these at file scope
let currentData = null;
let resizeTimer;
let zoom; // Add this line

// Add to top of file with other constants
const TRANSITION_DURATION = 300;

// Add new focus force constant at top with other constants
const focusForce = d3.forceRadial(0, 0, 0).strength(0);

// Update the force simulation settings
const graphSimulation = d3.forceSimulation()
  .force('link', d3.forceLink().id(d => d.id).distance(100).strength(0.5)) // Increase link distance and adjust strength
  .force('charge', d3.forceManyBody().strength(-300)) // Increase repulsion
  .force('center', d3.forceCenter())
  .force('collision', d3.forceCollide().radius(30).strength(1)) // Increase collision radius and strength
  .force('x', d3.forceX())
  .force('y', d3.forceY())
  .force('custom', customForce([])) // Initialize with empty array
  .alphaDecay(0.1)        // Faster initial decay
  .velocityDecay(0.6)     // More damping
  .alpha(0.3);            // Lower initial energy

// Add near the top with other constants
let activeLanes = ['history']; // Initialize with history lane
const LANE_HEIGHT = 100; // Height per swimlane

// Add near top with other constants
const PAN_STEP = 200; // Pixels to pan per keypress
const ZOOM_FACTOR = 1.5; // Zoom in/out multiplier
const ZOOM_DURATION = 750; // MS for zoom transitions

// Update near top with other constants
const KEYBOARD_NAV = {
  PAN_STEP: 100,          // Pixels to pan per keypress
  ZOOM_FACTOR: 1.5,       // More pronounced zoom steps
  MIN_ZOOM: 0.25,          // Allow good overview
  MAX_ZOOM: 30,          // Increased to allow 2-minute detail view
  TRANSITION_MS: 300      // Smooth transitions
};

const EDGE_TYPES = {
  SEQUENTIAL: {
    name: 'sequential',
    stroke: '#4285f4',
    strokeWidth: 0,
    strokeDasharray: 'none',
    opacity: 0,
    forceStrength: -60
  },
  NAVIGATION: {
    name: 'navigation',
    stroke: '#34a853',
    strokeWidth: 2,
    strokeDasharray: 'none',
    opacity: 0.9,
    forceStrength: -90
  },
  WINDOW: {
    name: 'window',
    stroke: '#fbbc04',
    strokeWidth: 0,
    strokeDasharray: '4none',
    opacity: 0,
    forceStrength: -10
  },
  SESSION_BREAK: {
    name: 'session-break',
    stroke: 'none',
    strokeWidth: 0,
    opacity: 0,
    forceStrength: 0
  }
};

const WINDOW_COLORS = [
  '#34a853', // green
  '#ea4335', // red
  '#fbbc04', // yellow
  '#4285f4', // blue
  '#9334e6', // purple
];

const ACTIVE_WINDOW_STYLES = {
  padding: 4,
  cornerRadius: 4,
  glowColor: 'rgba(66, 133, 244, 0.3)', // Google Blue with transparency
  glowSpread: '0 0 0 4px'
};

const HIGHLIGHT_STYLES = {
  fill: 'rgba(66, 133, 244, 0.1)', // Very light blue
  cornerRadius: 4,
  width: 28,
  height: 28
};

// Add to constants at top
const TEMPORAL_LAYOUT = {
  xPadding: 0.1,    // 10% padding on each side
  yPadding: 0.1,    // 10% padding on each side
  timeStrength: 0.8, // Strong horizontal alignment
  recentStrength: 0.4 // Moderate vertical push
};

// Add new visualization constants
const EDGE_TRANSITIONS = {
  LINK_CLICK: {
    strengthMultiplier: 1.2,  // Stronger forces for explicit navigation
    distance: 120
  },
  FORM_SUBMIT: {
    strengthMultiplier: 1.2,
    distance: 120
  },
  WINDOW: {
    strengthMultiplier: 0.8,  // Weaker forces for window relationships
    distance: 80
  },
  TYPED: {
    strengthMultiplier: 0,    // No forces for typed URLs
    distance: 0
  }
};

// Add near other constants
const LAYOUT = {
    TIMELINE_HEIGHT: 170,    // Timeline visualization height
    HEADER_HEIGHT: 43,      // Header section height
    Y_AXIS_HEIGHT: 22,      // Y-axis height
    ROW_HEIGHT: 32,         // Height per swimlane row
    AXIS_HEIGHT: 50,        // X-axis height
    AXIS_MARGIN: 70,        // Additional margin
    HISTORY_ROWS: 2,        // Number of history rows
    READOUT_HEIGHT: 45      // Default height for readout
};

export function initializeTimeline() {
  const container = d3.select('#timeline-svg');
  const element = container.node();
  
  if (!element) return;

  // Initialize with minimum dimensions
  width = element.getBoundingClientRect().width - margin.left - margin.right;
  height = 100; // Minimum initial height

  // Clear existing content
  container.selectAll('*').remove();

  // Create main group
  const g = container.append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  g.append('g').attr('class', 'plot-area');
  g.append('g').attr('class', 'x-axis')
    .attr('transform', `translate(0,${height - margin.bottom})`);

  // Initialize stats with default time scale
  updateStats(sharedTimeScale, currentData);
  
  setupZooming();
  handleResize();

  // Add event listener for keyboard navigation
  document.addEventListener('keydown', handleTimelineKeyboard);

  return { width, height, g };
}

// Update initializeGraph
export function initializeGraph() {
  const container = d3.select('#graph-svg');
  const element = container.node();
  
  // Get the available height from the parent container
  const parentHeight = element.parentElement.getBoundingClientRect().height;
  
  // Set full height
  container
    .attr('width', element.getBoundingClientRect().width)
    .attr('height', parentHeight);

  // Update simulation center force
  graphSimulation
    .force('center')
    .x(width / 2)
    .y(parentHeight / 2);

  return { width, height: parentHeight };
}

export function updateTimeline(data) {
  // Store current data for resize handling
  currentData = data;
  
  const { historySwimlane = [], windowSwimlanes = {}, activeWindowsAndTabs = [] } = data || {};
  
  const container = d3.select('#timeline-svg');
  const element = container.node();
  
  if (!element) return;

  // Filter out windows with only chrome:// URLs
  const validWindows = (activeWindowsAndTabs || []).filter(window => 
    window?.tabs?.some(tab => !tab.url.startsWith('chrome://'))
  );

  // Calculate dynamic dimensions with reduced spacing
  const historyHeight = 64;   // Double height for history lane
  const windowHeight = 32;    // Standard height for window lanes
  const swimlanePadding = 4;  // Padding between lanes
  const totalWindows = validWindows.length;
  const requiredHeight = historyHeight + (totalWindows * (windowHeight + swimlanePadding));
  
  // Update container dimensions with reduced margins
  width = element.getBoundingClientRect().width - margin.left - margin.right;
  height = requiredHeight + margin.top + margin.bottom; // Remove the 160px cap

  // Update SVG size
  container
    .attr('width', width + margin.left + margin.right)
    .attr('height', height);

  // Create time scale with 1-minute future limit
  const now = new Date();
  const futureLimit = new Date(now.getTime() + 60000); // 1 minute into future
  const timeExtent = d3.extent(historySwimlane || [], d => new Date(d.lastVisitTime));
  
  // Use the later of the most recent history item or now
  const latestTime = timeExtent ? 
    d3.max([timeExtent[1], now]) : 
    now;

  sharedTimeScale
    .domain([timeExtent ? timeExtent[0] : d3.timeMinute.offset(now, -30), futureLimit])
    .range([0, width]);

  // Create jitter scale for history swimlane
  const jitterScale = d3.randomNormal(historyHeight / 2, historyHeight / 6);

  // Clear existing content
  const plotArea = container.select('.plot-area');
  plotArea.selectAll('*').remove();

  // Add swimlane backgrounds with correct positioning
  plotArea.selectAll('.timeline-swimlane').remove();

  // Add history swimlane
  plotArea.append('rect')
    .attr('class', 'timeline-swimlane history')
    .attr('x', 0)
    .attr('y', 0) // Remove margin.top offset since plotArea is already transformed
    .attr('width', width)
    .attr('height', historyHeight);

  validWindows.forEach((window, i) => {
    const yPos = historyHeight + (i * (windowHeight + swimlanePadding));
    plotArea.append('rect')
      .attr('class', 'timeline-swimlane window')
      .attr('x', 0)
      .attr('y', yPos) // Remove margin.top offset
      .attr('width', width)
      .attr('height', windowHeight)
      .attr('data-window-id', window.id);
  });

  // Update history points
  const historyPoints = plotArea.selectAll('.timeline-point.history')
    .data(historySwimlane, d => d.url + d.lastVisitTime);

  historyPoints.exit().remove();

  const historyEnter = historyPoints.enter()
    .append('g')
    .attr('class', 'timeline-point history')
    .attr('transform', d => {
      const x = sharedTimeScale(new Date(d.lastVisitTime));
      const y = jitterScale();
      d.yPos = y; // Store y position in data
      return `translate(${x},${y})`;
    });

  addFaviconsToPoints(historyEnter);

  // Update window points
  validWindows.forEach((window, i) => {
    const tabs = windowSwimlanes[window.id] || [];
    const yPos = historyHeight + (i * (windowHeight + swimlanePadding)) + (windowHeight / 2);
    
    const windowPoints = plotArea.selectAll(`.timeline-point.window-${window.id}`)
      .data(tabs, d => d.url + (d.lastVisitTime || d.lastAccessed));

    windowPoints.exit().remove();

    const windowEnter = windowPoints.enter()
      .append('g')
      .attr('class', `timeline-point window-${window.id}`)
      .attr('transform', d => {
        const x = sharedTimeScale(new Date(d.lastVisitTime || d.lastAccessed));
        d.yPos = yPos;
        return `translate(${x},${yPos})`;
      });

    addFaviconsToPoints(windowEnter);
  });

  // Update x-axis position and orientation
  container.select('.x-axis')
    .attr('transform', `translate(0,${height - margin.bottom})`) // Remove left margin offset
    .call(d3.axisBottom(sharedTimeScale) // Changed from axisTop to axisBottom
      .tickFormat(d3.timeFormat('%H:%M')));

  // Update point updates in updateTimeline
  const timelinePoints = plotArea.selectAll('.timeline-point');
  
  timelinePoints
    .attr('class', d => {
      const classes = ['timeline-point'];
      if (d.isCurrentTab) classes.push('current-tab');
      if (d.active) classes.push('active-tab');
      return classes.join(' ');
    })
    .attr('data-window-id', d => d.windowId || 0);  // Move this here

  // In updateTimeline function
  plotArea.selectAll('.swimlane-label')
    .data([{type: 'history'}, ...validWindows.map((w, i) => ({type: 'window', offset: i}))])
    .join('g')
    .attr('class', 'swimlane-label')
    .attr('transform', (d, i) => {
      const y = d.type === 'history' 
        ? (historyHeight / 2) - 12 // Center within history lane, moved up 12px
        : historyHeight + ((i - 1) * (windowHeight + swimlanePadding)) + (windowHeight * 0.5) - 12; // Center within window lane, moved up 12px
      return `translate(8, ${y})`;
    })
    .each(function(d) {
      createSwimlaneLabel(d3.select(this), d.type, d.offset);
    });
}

function addFaviconsToPoints(points) {
  // Add highlight background (but keep it hidden initially)
  points.append('rect')
    .attr('class', 'hover-highlight')
    .attr('x', -14)
    .attr('y', -14)
    .attr('width', HIGHLIGHT_STYLES.width)
    .attr('height', HIGHLIGHT_STYLES.height)
    .attr('rx', HIGHLIGHT_STYLES.cornerRadius)
    .attr('ry', HIGHLIGHT_STYLES.cornerRadius)
    .attr('fill', HIGHLIGHT_STYLES.fill)
    .style('opacity', 0); // Hidden by default

  // Add highlight rectangle for all open window tabs
  points.filter(d => d.windowId) // Check if the point has a windowId (meaning it's a current window tab)
    .append('rect')
    .attr('class', 'active-window-highlight')
    .attr('x', -12)
    .attr('y', -12)
    .attr('width', 24)
    .attr('height', 24)
    .attr('rx', ACTIVE_WINDOW_STYLES.cornerRadius)
    .attr('ry', ACTIVE_WINDOW_STYLES.cornerRadius)
    .attr('fill', '#ffffff') // Add white background instead of 'none'
    .attr('stroke', d => WINDOW_COLORS[d.windowId % WINDOW_COLORS.length])
    .attr('stroke-width', 2)
    .style('filter', `drop-shadow(${ACTIVE_WINDOW_STYLES.glowSpread} ${ACTIVE_WINDOW_STYLES.glowColor})`);

  // Add unique IDs to clip paths
  points.append('clipPath')
    .attr('id', (d, i) => `clip-${Math.random().toString(36).substr(2, 9)}`)
    .append('circle')
    .attr('r', 8);

  // Add background circle with enhanced current tab styling
  points.append('circle')
    .attr('class', 'favicon-background')
    .attr('r', 8)
    .each(function(d) {
      const point = d3.select(this.parentNode);
      if (d.isCurrentTab) {
        point.classed('current-tab', true);
        if (d.active) {
          point.classed('active-tab', true);
        }
      }
    });

  // Add favicon images with hover and click handlers
  points.append('image')
    .attr('x', -8)
    .attr('y', -8)
    .attr('width', 16)
    .attr('height', 16)
    .attr('clip-path', function() {
      return `url(#${this.parentNode.querySelector('clipPath').id})`;
    })
    .style('cursor', 'pointer')
    .on('mouseover', function(event, d) {
      // Show hover highlight in timeline
      d3.select(this.parentNode)
        .select('.hover-highlight')
        .style('opacity', 1);

      // Highlight corresponding node in graph
      d3.select('#graph-svg')
        .selectAll('.graph-node')
        .filter(n => n.url === d.url)
        .select('.hover-highlight')
        .style('opacity', 1);

      // Update readout with node info
      updateNodeReadout(d);
      
      // Highlight point
      d3.select(this.parentNode)
        .select('.favicon-background')
        .classed('highlighted', true);

      // Center and highlight corresponding graph node
      focusGraphNode(d.url);  // Replace centerGraphNode with focusGraphNode
    })
    .on('mouseout', function(event, d) {
      // Hide hover highlight in timeline
      d3.select(this.parentNode)
        .select('.hover-highlight')
        .style('opacity', 0);

      // Remove highlight from graph
      d3.select('#graph-svg')
        .selectAll('.graph-node')
        .filter(n => n.url === d.url)
        .select('.hover-highlight')
        .style('opacity', 0);

      // Clear readout
      clearReadout();
      
      // Remove highlight
      d3.select(this.parentNode)
        .select('.favicon-background')
        .classed('highlighted', false);

      // Reset graph node
      resetGraphNode(d.url);
    })
    .on('click', function(event, d) {
      event.stopPropagation();
      handlePointClick(d);
    })
    .each(function(d) {
      // Async load favicon
      getFaviconUrl(d.url).then(faviconUrl => {
        d3.select(this)
          .attr('xlink:href', faviconUrl)
          .on('error', function() {
            d3.select(this).attr('xlink:href', '/images/default-favicon.png');
          });
      });
    });
}

// Replace centerGraphNode with new focus behavior
function focusGraphNode(url) {
  const container = d3.select('#graph-svg');
  const plotArea = container.select('.plot-area');
  const node = plotArea.selectAll('.graph-node')
    .filter(d => d.url === url);

  if (!node.empty()) {
    const element = container.node();
    const width = element.getBoundingClientRect().width;
    const height = element.getBoundingClientRect().height;

    // Update focus force center and strength
    focusForce
      .x(width / 2)
      .y(height / 2)
      .strength(0.3);

    // Highlight node and connected links
    node.classed('highlighted', true);
    plotArea.selectAll('.graph-link')
      .filter(d => d.source.url === url || d.target.url === url)
      .classed('highlighted', true);

    // Restart simulation with focus
    graphSimulation.alpha(0.3).restart();
  }
}

// Update resetGraphNode
function resetGraphNode(url) {
  const plotArea = d3.select('#graph-svg').select('.plot-area');
  
  // Remove highlights
  plotArea.selectAll('.graph-node').classed('highlighted', false);
  plotArea.selectAll('.graph-link').classed('highlighted', false);
  
  // Reset focus force
  focusForce.strength(0);
  
  // Gently restart simulation
  graphSimulation.alpha(0.1).restart();
}

// Add these new functions
function centerGraphNode(url) {
  const container = d3.select('#graph-svg');
  const plotArea = container.select('.plot-area');
  const node = plotArea.selectAll('.graph-node')
    .filter(d => d.url === url);

  if (!node.empty()) {
    // Get graph dimensions
    const element = container.node();
    const width = element.getBoundingClientRect().width;
    const height = element.getBoundingClientRect().height;
    
    // Stop simulation temporarily
    graphSimulation.stop();

    // Transition node to center
    node.classed('highlighted', true)
      .transition()
      .duration(TRANSITION_DURATION)
      .attr('transform', `translate(${width/2},${height/2})`);

    // Update connected links
    plotArea.selectAll('.graph-link')
      .filter(d => d.source.url === url || d.target.url === url)
      .classed('highlighted', true);
  }
}

async function handlePointClick(d) {
  try {
    // First try to find and activate existing tab
    const tabs = await new Promise(resolve => {
      chrome.tabs.query({ url: d.url }, resolve);
    });

    if (tabs && tabs.length > 0) {
      // Tab exists, activate it
      const tab = tabs[0];
      await new Promise(resolve => {
        chrome.windows.update(tab.windowId, { focused: true }, () => {
          chrome.tabs.update(tab.id, { active: true }, resolve);
        });
      });
    } else {
      // Create new tab in current window
      await new Promise(resolve => {
        chrome.tabs.create({ url: d.url }, resolve);
      });
    }
  } catch (error) {
    console.error('Error handling point click:', error);
  }
}

// Fix the prevItem undefined error in updateGraph
export function updateGraph(data) {
  console.log('updateGraph called with data:', data);
  if (!data?.historySwimlane) return;


  const container = d3.select('#graph-svg');
  const element = container.node();
  
  if (!element) return;

  const graphWidth = element.getBoundingClientRect().width - margin.left - margin.right;
  const graphHeight = element.getBoundingClientRect().height - margin.top - margin.bottom;

  // Update center force with new dimensions
  graphSimulation.force('center')
    .x(graphWidth / 2)
    .y(graphHeight / 2);

  const plotArea = container.select('.plot-area');
  if (!plotArea.size()) {
    container.append('g')
      .attr('class', 'plot-area')
      .attr('transform', `translate(${margin.left},${margin.top})`);
  }

  const timeWindow = sharedTimeScale.domain();
  const [startTime, endTime] = timeWindow;

  // Clear existing nodes and links
  const visibleNodes = new Map();
  const visibleLinks = [];

  // Create time scale for initial positioning
  const timePositionScale = sharedTimeScale.copy()
    .range([graphWidth * 0.1, graphWidth * 0.9]); // Use 80% of width for time positioning

  // Process nodes with improved initial positioning
  data.historySwimlane.forEach((item, index) => {
    const itemTime = new Date(item.lastVisitTime);
    if (itemTime >= startTime && itemTime <= endTime) {
      const timeX = timePositionScale(itemTime);
      const shouldAlign = Math.random() < 0.5; // 50% chance of timeline alignment
      
      visibleNodes.set(item.id, {
        ...item,
        type: 'history',
        radius: 8,
        x: shouldAlign ? timeX : timeX + (Math.random() - 0.5) * graphWidth * 0.2, // Jitter within 20% of width
        y: shouldAlign ? graphHeight * 0.3 : graphHeight * (0.2 + Math.random() * 0.2) // Cluster in top third
      });

      // Move sequential link creation inside the same loop
      if (index > 0) {
        const prevItem = data.historySwimlane[index - 1];
        const prevTime = new Date(prevItem.lastVisitTime);
        
        if (prevTime >= startTime && prevTime <= endTime) {
          // Only create sequential edges if:
          // 1. Not typed URLs
          // 2. Same tab
          // 3. No existing navigation edge between these nodes
          if (item.transitionType !== 'typed' && 
              item.tabId === prevItem.tabId &&
              !visibleLinks.some(link => 
                (link.source === prevItem.id && link.target === item.id) ||
                (link.source === item.id && link.target === prevItem.id))) {
            visibleLinks.push({
              source: prevItem.id,
              target: item.id,
              type: 'sequential',
              timeGap: itemTime - prevTime
            });
          } else if (item.sourceUrl === prevItem.url) {
            // Navigation edge
            visibleLinks.push({
              source: prevItem.id,
              target: item.id,
              type: 'navigation',
              text: item.transitionType === 'form_submit' ? 
                `FORM: ${item.linkText}` : item.linkText,
              timeGap: itemTime - prevTime
            });
          }
        }
      }
    }
  });

  // Process window nodes only if they fall within time window
  Object.values(data.windowSwimlanes).forEach(tabs => {
    tabs.forEach((tab, tabIndex) => {
      const tabTime = new Date(tab.lastVisitTime || tab.lastAccessed);
      const tabHistory = data.historySwimlane.filter(h => h.tabId === tab.id)
        .sort((a, b) => new Date(b.lastVisitTime) - new Date(a.lastVisitTime));
      
      // Only show tab if it exists in the current time window
      if (tabTime >= startTime && tabTime <= endTime) {
        // Find the tab's state at this point in time
        const historicalState = tabHistory.find(h => 
          new Date(h.lastVisitTime) <= endTime
        );

        if (historicalState) {
          // Use historical state data
          visibleNodes.set(tab.id, {
            ...tab,
            url: historicalState.url,
            title: historicalState.title,
            type: 'current',
            active: tab.active, // Preserve active state from current tab
            radius: 8,
            x: timePositionScale(tabTime),
            y: graphHeight * 0.7
          });
        }

        // Window edges only if both tabs exist at this time
        if (tabIndex > 0) {
          const prevTab = tabs[tabIndex - 1];
          if (visibleNodes.has(prevTab.id)) {
            visibleLinks.push({
              source: prevTab.id,
              target: tab.id,
              type: 'window'
            });
          }
        }
      }
    });
  });

  // Process navigation edges first
  data.edges?.forEach(edge => {
    if (edge.type === 'link-click' || edge.type === 'form-submit') {
      visibleLinks.push({
        source: edge.source,
        target: edge.target,
        type: edge.type,
        text: edge.text,      // Include anchor text
        timestamp: edge.timestamp,
        transitionType: edge.type
      });
    }
  });

  // Process navigation events first to ensure they take priority
  data.navigationEvents?.forEach(event => {
    if (event.timestamp >= startTime && event.timestamp <= endTime) {
      visibleLinks.push({
        source: event.sourceTabId,
        target: event.targetTabId,
        type: 'navigation',
        text: event.linkText || event.formText,
        timestamp: event.timestamp,
        sourceUrl: event.sourceUrl,
        targetUrl: event.targetUrl
      });
    }
  });

  // Then process sequential navigation (only if not already connected by navigation)
  data.historySwimlane.forEach((item, index) => {
    const itemTime = new Date(item.lastVisitTime);
    if (itemTime >= startTime && itemTime <= endTime) {
      if (index > 0) {
        const prevItem = data.historySwimlane[index - 1]; // Define prevItem here
        const prevTime = new Date(prevItem.lastVisitTime);
        
        // Only create sequential edges if:
        // 1. Not typed URLs
        // 2. Same tab
        // 3. No existing navigation edge between these nodes
        if (item.transitionType !== 'typed' && 
            item.tabId === prevItem.tabId &&
            !visibleLinks.some(link => 
              (link.source === prevItem.id && link.target === item.id) ||
              (link.source === item.id && link.target === prevItem.id))) {
          visibleLinks.push({
            source: prevItem.id,
            target: item.id,
            type: 'sequential',
            timeGap: itemTime - prevTime
          });
        }
      }
    }
  });

  const nodesArray = Array.from(visibleNodes.values());
  console.log(`Visible nodes: ${nodesArray.length}, links: ${visibleLinks.length}`);

  // Ensure all nodes referenced in links are present in nodesArray
  const validLinks = visibleLinks.filter(link => 
    visibleNodes.has(link.source) && visibleNodes.has(link.target)
  );

  // Stop any existing simulation
  graphSimulation.stop();

  // Update the simulation with new data
  graphSimulation
    .nodes(nodesArray)
    .force('link').links(validLinks);

  // Add a gentle alpha target to smooth transitions
  graphSimulation.alpha(0.3).alphaTarget(0).restart();

  // Update links
  const links = plotArea.selectAll('.graph-link')
    .data(validLinks, d => `${d.source}-${d.target}-${d.type}`);

  links.exit().remove();

  const linkEnter = links.enter()
    .append('line')
    .attr('class', d => `graph-link ${d.type}`)
    .attr('stroke', d => EDGE_TYPES[d.type]?.stroke || 'black') // Default to black if undefined
    .attr('stroke-width', d => EDGE_TYPES[d.type]?.strokeWidth || 1) // Default to 1 if undefined
    .attr('stroke-dasharray', d => EDGE_TYPES[d.type]?.strokeDasharray || 'none') // Default to none if undefined
    .attr('opacity', d => EDGE_TYPES[d.type]?.opacity || 1); // Default to 1 if undefined

  // Update nodes with proper enter selection
  const nodes = plotArea.selectAll('.graph-node')
    .data(nodesArray, d => d.id);
  
  // Remove old nodes
  nodes.exit().remove();

  // Create enter selection
  const nodeEnter = nodes.enter()
    .append('g')
    .attr('class', 'graph-node')
    .on('mouseenter', function(event, d) {
      // Show hover highlight in graph
      d3.select(this)
        .select('.hover-highlight')
        .style('opacity', 1);

      // Highlight corresponding points in timeline
      d3.select('#timeline-svg')
        .selectAll('.timeline-point')
        .filter(n => n.url === d.url)
        .select('.hover-highlight')
        .style('opacity', 1);

      handleNodeHover(event, d);
    })
    .on('mouseleave', function(event, d) {
      // Hide hover highlight in graph
      d3.select(this)
        .select('.hover-highlight')
        .style('opacity', 0);

      // Remove highlight from timeline
      d3.select('#timeline-svg')
        .selectAll('.timeline-point')
        .filter(n => n.url === d.url)
        .select('.hover-highlight')
        .style('opacity', 0);

      handleNodeHover(event, d);
    })
    .call(d3.drag()
      .on('start', dragStarted)
      .on('drag', dragged)
      .on('end', dragEnded));

  // Add hover highlight rect before favicons
  nodeEnter.append('rect')
    .attr('class', 'hover-highlight')
    .attr('x', -14)
    .attr('y', -14)
    .attr('width', HIGHLIGHT_STYLES.width)
    .attr('height', HIGHLIGHT_STYLES.height)
    .attr('rx', HIGHLIGHT_STYLES.cornerRadius)
    .attr('ry', HIGHLIGHT_STYLES.cornerRadius)
    .attr('fill', HIGHLIGHT_STYLES.fill)
    .style('opacity', 0);

  // Add favicons to new nodes
  addFaviconsToPoints(nodeEnter);

  // Add abbreviated titles for current tabs if there are fewer than 30 nodes
  if (nodesArray.length < 30) {
    nodeEnter.filter(d => d.type === 'current')
      .append('text')
      .attr('x', 12)
      .attr('y', 4)
      .attr('font-size', '10px')
      .attr('fill', '#333')
      .text(d => abbreviateTitle(d.title, 15));
  }

  // In the node creation part of updateGraph:
  nodeEnter
    .filter(d => d.active)
    .append('rect')
    .attr('class', 'active-tab-border')
    .attr('x', -12)
    .attr('y', -12)
    .attr('width', 24)
    .attr('height', 24)
    .attr('rx', ACTIVE_WINDOW_STYLES.cornerRadius)
    .attr('ry', ACTIVE_WINDOW_STYLES.cornerRadius)
    .attr('fill', 'none')
    .attr('stroke', d => WINDOW_COLORS[d.windowId % WINDOW_COLORS.length])
    .attr('stroke-width', 2)
    .style('filter', `drop-shadow(${ACTIVE_WINDOW_STYLES.glowSpread} ${ACTIVE_WINDOW_STYLES.glowColor})`);

  // Merge enter + update selections
  const nodesUpdate = nodeEnter.merge(nodes);

  // Update simulation with all nodes
  graphSimulation
    .nodes(nodesArray)
    .force('link').links(validLinks);

  // Set up tick function with merged selection
  graphSimulation.on('tick', () => {
    plotArea.selectAll('.graph-link')
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    nodesUpdate
      .attr('transform', d => `translate(${d.x},${d.y})`);
  });

  // Restart simulation
  graphSimulation.alpha(1).restart();

  // Update force link parameters based on edge type
  graphSimulation.force('link')
    .distance(d => {
      const transitionType = d.type || 'WINDOW';
      return EDGE_TRANSITIONS[transitionType]?.distance || 100;
    })
    .strength(d => {
      const transitionType = d.type || 'WINDOW';
      return (EDGE_TRANSITIONS[transitionType]?.strengthMultiplier || 1) * 0.5;
    });

  // Then in the node update section:
  nodesUpdate.selectAll('.active-tab-border')
    .style('display', d => {
      const nodeTime = new Date(d.lastVisitTime || d.lastAccessed);
      return nodeTime >= startTime && nodeTime <= endTime ? '' : 'none';
    });

  //updateReadoutPosition(data);
}

export function setupBrushing() {
  // Set up brushing interaction for the timeline
  console.log('Setting up brushing');
}

// Update setupZooming function
export function setupZooming() {
  const svg = d3.select('#timeline-svg');
  const plotArea = svg.select('.plot-area');

  // Calculate max zoom based on 2-minute window
  const domain = sharedTimeScale.domain();
  const totalMs = domain[1] - domain[0];
  const twoMinutes = 2 * 60 * 1000;
  const maxZoom = totalMs / twoMinutes;

  // Create zoom behavior with calculated max zoom
  zoom = d3.zoom()
    .scaleExtent([KEYBOARD_NAV.MIN_ZOOM, maxZoom])
    .on('zoom', zoomed)
    .translateExtent([[0, -Infinity], [width, Infinity]]);

  // Add zoom to SVG
  svg.call(zoom);

  // Remove duplicate keyboard listener
  document.removeEventListener('keydown', handleTimelineKeyboard);
  document.addEventListener('keydown', handleTimelineKeyboard);

  function zoomed(event) {
    if (!currentData?.historySwimlane) return;

    const newTimeScale = event.transform.rescaleX(sharedTimeScale);
    updateTimelineView(newTimeScale, svg, plotArea);
    updateStats(newTimeScale, currentData);
  }
}

function updateTimelineView(newTimeScale, svg, plotArea) {
  // Update axis
  svg.select('.x-axis')
    .call(d3.axisBottom(newTimeScale)
      .tickFormat(d3.timeFormat('%H:%M')));

  // Update points
  plotArea.selectAll('.timeline-point')
    .attr('transform', d => {
      const x = newTimeScale(new Date(d.lastVisitTime || d.lastAccessed));
      return `translate(${x},${d.yPos})`;
    })
    .style('display', d => {
      const x = newTimeScale(new Date(d.lastVisitTime || d.lastAccessed));
      return x >= 0 && x <= width ? '' : 'none';
    });

  // Update graph
  if (currentData) {
    updateGraph(currentData);
  }
}

function handleTimelineKeyboard(event) {
  if (!currentData?.historySwimlane || !zoom) return;
  
  const svg = d3.select('#timeline-svg');
  let currentTransform = d3.zoomTransform(svg.node());
  const currentTimeScale = currentTransform.rescaleX(sharedTimeScale);
  const [start, end] = currentTimeScale.domain();
  const timeRange = end - start;
  let direction, proposedX, newK, rightEdge, newTransform, factor;
  
  switch (event.key) {
    case 'ArrowLeft':
      event.preventDefault();
      direction = 1; // Pan left
      proposedX = currentTransform.x + (KEYBOARD_NAV.PAN_STEP * direction);
      
      svg.transition()
        .duration(KEYBOARD_NAV.TRANSITION_MS)
        .call(zoom.transform, d3.zoomIdentity.translate(proposedX, currentTransform.y).scale(currentTransform.k))
        .on('end', () => {
          // Update currentTransform after transition
          currentTransform = d3.zoomTransform(svg.node());
        });
      break;
      
    case 'ArrowRight':
      event.preventDefault();
      direction = -1; // Pan right
      proposedX = currentTransform.x + (KEYBOARD_NAV.PAN_STEP * direction);
      
      svg.transition()
        .duration(KEYBOARD_NAV.TRANSITION_MS)
        .call(zoom.transform, d3.zoomIdentity.translate(proposedX, currentTransform.y).scale(currentTransform.k))
        .on('end', () => {
          // Update currentTransform after transition
          currentTransform = d3.zoomTransform(svg.node());
        });
      break;

    case 'ArrowUp':
      event.preventDefault();
      const isZoomIn = true; // Zoom in
      factor = isZoomIn ? KEYBOARD_NAV.ZOOM_FACTOR : 1 / KEYBOARD_NAV.ZOOM_FACTOR;
      newK = Math.max(
        KEYBOARD_NAV.MIN_ZOOM, 
        Math.min(KEYBOARD_NAV.MAX_ZOOM, currentTransform.k * factor)
      );
      
      // Calculate the new transform to keep the most recent visible area in view
      rightEdge = currentTransform.invertX(width);
      newTransform = d3.zoomIdentity
        .scale(newK)
        .translate(width / newK - rightEdge, 0);
      
      svg.transition()
        .duration(KEYBOARD_NAV.TRANSITION_MS)
        .call(zoom.transform, newTransform)
        .on('end', () => {
          // Update currentTransform after transition
          currentTransform = d3.zoomTransform(svg.node());
        });
      break;
      
    case 'ArrowDown':
      event.preventDefault();
      const isZoomOut = false; // Zoom out
      factor = isZoomOut ? KEYBOARD_NAV.ZOOM_FACTOR : 1 / KEYBOARD_NAV.ZOOM_FACTOR;
      newK = Math.max(
        KEYBOARD_NAV.MIN_ZOOM, 
        Math.min(KEYBOARD_NAV.MAX_ZOOM, currentTransform.k * factor)
      );
      
      // Calculate the new transform to keep the most recent visible area in view
      rightEdge = currentTransform.invertX(width);
      newTransform = d3.zoomIdentity
        .scale(newK)
        .translate(width / newK - rightEdge, 0);
      
      svg.transition()
        .duration(KEYBOARD_NAV.TRANSITION_MS)
        .call(zoom.transform, newTransform)
        .on('end', () => {
          // Update currentTransform after transition
          currentTransform = d3.zoomTransform(svg.node());
        });
      break;
  }
}

// Add event listener for keyboard navigation
document.addEventListener('keydown', handleTimelineKeyboard);

export async function drawSwimlanes(categorizedData) {
  if (!categorizedData || !categorizedData.windowSwimlanes) {
    console.error('Invalid categorized data:', categorizedData);
    return;
  }

  const { historySwimlane = [], windowSwimlanes = {}, activeWindowsAndTabs = [] } = categorizedData;

  // Draw history swimlane
  const historyContent = document.getElementById('history-content');
  if (historyContent) {
    historyContent.innerHTML = '';
    
    for (const item of historySwimlane) {
      const favicon = document.createElement('div');
      favicon.className = 'tab-favicon history-item';
      favicon.innerHTML = `
        <img src="${await getFaviconUrl(item.url)}" 
             alt="${item.title || 'No title'}"
             title="${item.title || 'No title'}"
             onerror="this.src='default-favicon.png'">
      `;
      historyContent.appendChild(favicon);
    }
  }

  // Draw window swimlanes
  const windowSwimlaneContainer = document.getElementById('window-swimlanes');
  if (windowSwimlaneContainer) {
    windowSwimlaneContainer.innerHTML = '';
    
    for (const [windowId, tabs] of Object.entries(windowSwimlanes)) {
      const swimlane = document.createElement('div');
      swimlane.className = 'swimlane window-swimlane';
      
      const content = document.createElement('div');
      content.className = 'swimlane-content';
      
      // Sort tabs: current tabs first, then history items
      const sortedTabs = [...tabs].sort((a, b) => {
        if (a.isCurrentTab === b.isCurrentTab) return 0;
        return a.isCurrentTab ? -1 : 1;
      });
      
      for (const tab of sortedTabs) {
        const favicon = document.createElement('div');
        favicon.className = `tab-favicon ${tab.isCurrentTab ? 'current' : 'history'} ${tab.active ? 'active' : ''}`;
        favicon.innerHTML = `
          <img src="${await getFaviconUrl(tab.url)}" 
               alt="${tab.title || 'No title'}"
               title="${tab.title || 'No title'} (${tab.isCurrentTab ? 'Current Tab' : 'History Item'})"
               onerror="this.src='default-favicon.png'">
        `;
        content.appendChild(favicon);
      }
      
      const title = document.createElement('div');
      title.className = 'swimlane-title';
      const window = activeWindowsAndTabs.find(w => w.id === parseInt(windowId));
      title.textContent = `Window ${windowId}${window?.focused ? ' (Focused)' : ''}`;
      
      swimlane.appendChild(title);
      swimlane.appendChild(content);
      windowSwimlaneContainer.appendChild(swimlane);
    }
  }
}

// Update handleResize function
function handleResize() {
    console.log('handleResize called');
    updateLayout();  // Call single layout function
    
    if (currentData) {
        updateTimeline(currentData);
        updateGraph(currentData);
    }
}

// Update the resize event listener
const debouncedResize = debounce(() => {
    console.log('Window resize event triggered');
    handleResize();
}, 250);

// Make sure we're only adding one listener
window.removeEventListener('resize', debouncedResize);
window.addEventListener('resize', debouncedResize);

function formatUrl(url) {
  try {
    const urlObj = new URL(url);
    let cleanHost = urlObj.hostname.replace(/^www\./, '');
    
    // Split path into segments and limit to 3
    let pathSegments = urlObj.pathname.split('/').filter(Boolean);
    let cleanPath = pathSegments.length > 0 
      ? '/' + pathSegments.slice(0, 3).join('/') + (pathSegments.length > 3 ? '/...' : '')
      : '/';
    
    // Get first parameter if exists
    let params = '';
    const searchParams = new URLSearchParams(urlObj.search);
    const firstParam = searchParams.entries().next().value;
    if (firstParam) {
      params = `?${firstParam[0]}=${firstParam[1]}${searchParams.size > 1 ? '...' : ''}`;
    }
    
    // Combine and truncate to 60 chars if needed
    let formatted = `${cleanHost}${cleanPath}${params}`;
    if (formatted.length > 60) {
      formatted = formatted.substring(0, 57) + '...';
    }
    
    return formatted;
  } catch (e) {
    // Fallback to original URL if parsing fails
    return url.length > 60 ? url.substring(0, 57) + '...' : url;
  }
}

// Update cleanup to remove keyboard listener
function cleanup() {
  document.removeEventListener('keydown', handleTimelineKeyboard);
  window.removeEventListener('resize', debouncedResize);
  if (updateTimer) {
    clearInterval(updateTimer);
  }
}

// Update updateGraph function to adjust forces based on aspect ratio
// Update updateForcesByAspectRatio
function updateForcesByAspectRatio(width, height) {
  const timeScale = sharedTimeScale.copy()
    .range([width * TEMPORAL_LAYOUT.xPadding, width * (1 - TEMPORAL_LAYOUT.xPadding)]);
  
  // Get the time range for calculating recency
  const [timeStart, timeEnd] = sharedTimeScale.domain();
  const timeRange = timeEnd - timeStart;

  graphSimulation
    .force('x')
    .strength(TEMPORAL_LAYOUT.timeStrength)
    .x(d => timeScale(new Date(d.lastVisitTime || d.lastAccessed)));

  // Modify Y force to consider recency
  graphSimulation
    .force('y')
    .strength(TEMPORAL_LAYOUT.recentStrength)
    .y(d => {
      const time = new Date(d.lastVisitTime || d.lastAccessed);
      const recencyFactor = (timeEnd - time) / timeRange; // 0 for most recent, 1 for oldest
      const baseY = height * (0.8 - (recencyFactor * 0.6)); // Map 0-1 to 80%-20% of height
      
      // Add some random jitter to prevent exact alignment
      return baseY + (Math.random() - 0.5) * height * 0.1;
    });

  // Adjust other forces for better layout
  graphSimulation
    .force('charge')
    .strength(-100)
    .distanceMax(width * 0.1);

  graphSimulation
    .force('collision')
    .radius(16)
    .strength(0.8);

  // Remove center force as we're using explicit positioning
  graphSimulation.force('center', null);

  // Slower decay for smoother movement
  graphSimulation
    .velocityDecay(0.3)
    .alphaDecay(0.02);
}

// Add this function to stop simulation on hover
function handleNodeHover(event, d) {
  if (event.type === 'mouseenter') {
    // Pause simulation
    graphSimulation.alpha(0);
    graphSimulation.stop();
    
    // Fix node position
    d.fx = d.x;
    d.fy = d.y;
  } else if (event.type === 'mouseleave') {
    // Release node position
    d.fx = null;
    d.fy = null;
    
    // Gently restart simulation
    graphSimulation.alpha(0.1).restart();
  }
}

function createSwimlaneLabel(selection, type, windowId = null) {
  const icon = selection.append('svg')
    .attr('width', 24)
    .attr('height', 24)
    .attr('viewBox', '0 0 24 24')
    .attr('fill', 'none')
    .attr('stroke', windowId ? WINDOW_COLORS[windowId % WINDOW_COLORS.length] : 'currentColor')
    .attr('stroke-width', 2)
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .attr('class', 'swimlane-icon');

  if (type === 'history') {
    icon.html(`
      <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
      <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" />
      <path d="M12 7v5l3 3" />
    `);
  } else {
    icon.html(`
      <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
      <path d="M3 5m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z" />
      <path d="M6 8h.01" />
      <path d="M9 8h.01" />
    `);
  }
}

function dragStarted(event, d) {
  if (!event.active) graphSimulation.alphaTarget(0.3).restart();
  d.fx = d.x;
  d.fy = d.y;
}

function dragged(event, d) {
  d.fx = event.x;
  d.fy = event.y;
}

function dragEnded(event, d) {
  if (!event.active) graphSimulation.alphaTarget(0);
  d.fx = null;
  d.fy = null;
}

function abbreviateTitle(title, maxLength) {
  if (title.length > maxLength) {
    return title.substring(0, maxLength) + '...';
  }
  return title;
}

// Custom force for typed nodes
function customForce(nodesArray) {
  return (alpha) => {
    nodesArray.forEach(node => {
      if (node.transition === 'typed') {
        const strength = EDGE_TYPES.TYPED.forceStrength;
        node.vx += strength * alpha;
        node.vy += strength * alpha;
      }
    });
  };
}

// Add a resize handler
function handleGraphResize() {
  const container = d3.select('#graph-svg');
  const element = container.node();
  const parentHeight = element.parentElement.getBoundingClientRect().height;
  
  // Update SVG dimensions
  container
    .attr('width', element.getBoundingClientRect().width)
    .attr('height', parentHeight);

  // Update simulation center
  graphSimulation
    .force('center')
    .x(width / 2)
    .y(parentHeight / 2);

  // Restart simulation gently
  graphSimulation.alpha(0.1).restart();
}

// Add window resize listener
window.addEventListener('resize', debounce(() => {
  handleGraphResize();
}, 250));

export function handleNavigationEvent(event) {
  if (!currentData) return;

  // Add to navigation events collection
  if (!currentData.navigationEvents) {
    currentData.navigationEvents = [];
  }
  currentData.navigationEvents.push(event);

  // Update the graph immediately if within current time window
  const [startTime, endTime] = sharedTimeScale.domain();
  if (event.timestamp   >= startTime && event.timestamp <= endTime) {
    updateGraph(currentData);
  }
}

function updateLayout() {
    // Calculate swimlane heights
    const numWindows = currentData?.windowSwimlanes ? Object.keys(currentData.windowSwimlanes).length : 0;
    const swimlaneRows = LAYOUT.HISTORY_ROWS + numWindows;
    const swimlaneHeight = swimlaneRows * LAYOUT.ROW_HEIGHT;
    
    // Calculate timeline section height
    const timelineHeight = swimlaneHeight +           // Height for all swimlanes
                          LAYOUT.AXIS_HEIGHT +        // X-axis height (30px)
                          LAYOUT.AXIS_MARGIN;         // Margin after x-axis (10px)

    // Position readout after timeline
    const readoutContainer = document.getElementById('readout-container');
    if (readoutContainer) {
        readoutContainer.style.position = 'absolute';
        readoutContainer.style.top = `${timelineHeight}px`;
        readoutContainer.style.width = '100%';
        readoutContainer.style.zIndex = '2';  // Ensure readout is above other elements
    }
    
    // Get actual readout height after positioning
    const readoutHeight = readoutContainer?.getBoundingClientRect().height || LAYOUT.READOUT_HEIGHT;
    
    // Calculate space for graph
    const totalHeight = window.innerHeight;
    const graphStartY = timelineHeight + readoutHeight;
    const graphHeight = totalHeight - graphStartY;

    console.log('Layout calculation:', {
        timelineEnd: timelineHeight,
        readoutHeight,
        graphStartY,
        graphHeight,
        totalHeight
    });

    // Position and size graph container
    const graphContainer = d3.select('#graph-container');
    graphContainer
        .style('position', 'absolute')
        .style('top', `${graphStartY}px`)
        .style('height', `${graphHeight}px`)
        .style('width', '100%');

    // Update graph SVG dimensions
    const graphSvg = d3.select('#graph-svg');
    graphSvg
        .attr('width', '100%')
        .attr('height', graphHeight);

    // Update graph simulation center force
    if (graphSimulation) {
        graphSimulation.force('center')
            .x(width / 2)
            .y(graphHeight / 2);
        graphSimulation.alpha(0.1).restart();
    }
}


