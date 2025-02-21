import { getFaviconUrl } from './utility.js';

// Update margin constant at the top
const margin = { top: 0, right: 0, bottom: 20, left: 0 }; // Only keep bottom margin for axis
const sharedTimeScale = d3.scaleTime();
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

// Add near top with other constants
const PAN_STEP = 200; // Pixels to pan per keypress
const ZOOM_FACTOR = 1.5; // Zoom in/out multiplier
const ZOOM_DURATION = 750; // MS for zoom transitions

// Update near top with other constants
const KEYBOARD_NAV = {
  PAN_STEP: 100,          // Pixels to pan per keypress
  ZOOM_FACTOR: 1.5,       // More pronounced zoom steps
  MIN_ZOOM: 0.5,          // Allow good overview
  MAX_ZOOM: 30,          // Increased to allow 2-minute detail view
  TRANSITION_MS: 300      // Smooth transitions
};

const EDGE_TYPES = {
  SEQUENTIAL: {
    name: 'sequential',
    stroke: '#4285f4',
    strokeWidth: 1,
    strokeDasharray: '2',
    opacity: 0.6,
    forceStrength: -50 // Attractive force
  },
  WINDOW: {
    name: 'window',
    stroke: 'none', // Ensure stroke is defined
    strokeWidth: 1.5,
    strokeDasharray: 'none',
    opacity: 0.8,
    forceStrength: 0 // Neutral force
  },
  SESSION_BREAK: {
    name: 'session-break',
    stroke: 'none',  // Ensure stroke is defined
    strokeWidth: 0,  // No stroke width
    opacity: 0,      // Fully transparent
    forceStrength: 0 // Neutral force
  }
};

const WINDOW_COLORS = [
  '#34a853', // green
  '#ea4335', // red
  '#fbbc04', // yellow
  '#4285f4', // blue
  '#9334e6', // purple
];

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
  updateStats(sharedTimeScale);
  
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
  
  if (!element) return;

  const width = element.getBoundingClientRect().width;
  const height = element.getBoundingClientRect().height;

  container.selectAll('*').remove();

  // Create main group without margins
  const g = container.append('g')
    .attr('class', 'plot-area');

  // Add zoom behavior
  const zoom = d3.zoom()
    .scaleExtent([0.5, 4]) // Set min/max zoom levels
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
    });

  container.call(zoom);

  // Initialize simulation
  graphSimulation
    .force('center')
    .x(width / 2)
    .y(height / 2);

  return { width, height, g };
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
  const historyHeight = 32;   // Reduced from 40
  const windowHeight = 32;    // Reduced from 40
  const swimlanePadding = 4;  // Reduced from 8
  const totalWindows = validWindows.length;
  const requiredHeight = historyHeight + (totalWindows * (windowHeight + swimlanePadding));
  
  // Update container dimensions with reduced margins
  width = element.getBoundingClientRect().width - margin.left - margin.right;
  height = Math.min(requiredHeight + margin.top + margin.bottom, 160); // Cap at 160px

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
    const yPos = historyHeight + swimlanePadding + (i * (windowHeight + swimlanePadding)) + (windowHeight / 2);
    
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
    .data([{type: 'history'}, ...validWindows.map(w => ({type: 'window', windowId: w.id}))])
    .join('g')
    .attr('class', 'swimlane-label')
    .attr('transform', (d, i) => {
      const y = d.type === 'history' 
        ? (historyHeight / 2) - 2
        : historyHeight + (i-1) * (windowHeight + swimlanePadding) + (windowHeight / 2);
      return `translate(8, ${y})`;
    })
    .each(function(d) {
      createSwimlaneLabel(d3.select(this), d.type, d.windowId);
    });
}

function addFaviconsToPoints(points) {
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
      const info = `
        ${d.title || 'Untitled'}
        <br/>
        ${formatUrl(d.url)}
        ${d.isCurrentTab ? '<br/><em>Current Tab</em>' : ''}
      `.trim();
      
      showTooltipInfo(info);
      
      // Highlight point
      d3.select(this.parentNode)
        .select('.favicon-background')
        .classed('highlighted', true);

      // Center and highlight corresponding graph node
      focusGraphNode(d.url);  // Replace centerGraphNode with focusGraphNode
    })
    .on('mouseout', function(event, d) {
      hideTooltipInfo();
      
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

// Update the relevant section in updateGraph function
export function updateGraph(data) {
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

  // Process history nodes first
  data.historySwimlane.forEach((item, index) => {
    const itemTime = new Date(item.lastVisitTime);
    if (itemTime >= startTime && itemTime <= endTime) {
      // Add node with initial position
      visibleNodes.set(item.id, {
        ...item,
        type: 'history',
        radius: 8,
        x: Math.random() * graphWidth,
        y: Math.random() * graphHeight
      });

      // Link to previous history item if not typed
      if (index > 0 && item.transition !== 'typed') {
        const prevItem = data.historySwimlane[index - 1];
        const prevTime = new Date(prevItem.lastVisitTime);
        if (prevTime >= startTime && prevTime <= endTime) {
          visibleLinks.push({
            source: prevItem.id,
            target: item.id,
            type: 'sequential',
            timeGap: new Date(item.lastVisitTime) - prevTime
          });
        }
      }
    }
  });

  // Process window nodes
  Object.values(data.windowSwimlanes).forEach(tabs => {
    tabs.forEach((tab, index) => {
      const tabTime = new Date(tab.lastVisitTime || tab.lastAccessed);
      if (tabTime >= startTime && tabTime <= endTime) {
        if (!visibleNodes.has(tab.id)) {
          visibleNodes.set(tab.id, {
            ...tab,
            type: 'current',
            radius: 8,
            x: Math.random() * graphWidth,
            y: Math.random() * graphHeight
          });
        }

        if (index > 0) {
          const prevTab = tabs[index - 1];
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
    .on('mouseenter', handleNodeHover)
    .on('mouseleave', handleNodeHover)
    .call(d3.drag()
      .on('start', dragStarted)
      .on('drag', dragged)
      .on('end', dragEnded));

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
    updateStats(newTimeScale);
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

function showTooltipInfo(info) {
  document.getElementById('default-stats').style.display = 'none';
  const tooltipInfo = document.getElementById('tooltip-info');
  tooltipInfo.innerHTML = info; // Changed from textContent to innerHTML
  tooltipInfo.style.display = 'inline';
}

function hideTooltipInfo() {
  document.getElementById('tooltip-info').style.display = 'none';
  document.getElementById('default-stats').style.display = 'inline';
}

function handleResize() {
  const timelineContainer = d3.select('#timeline-svg');
  const graphContainer = d3.select('#graph-svg');
  
  // Update timeline dimensions
  const timelineWidth = timelineContainer.node().getBoundingClientRect().width;
  timelineContainer
    .attr('width', timelineWidth)
    .attr('height', height + margin.top + margin.bottom);

  // Update graph dimensions
  const graphElement = graphContainer.node();
  const graphWidth = graphElement.getBoundingClientRect().width;
  const graphHeight = graphElement.getBoundingClientRect().height;
  
  graphContainer
    .attr('width', graphWidth)
    .attr('height', graphHeight);

  // Update force simulation center
  graphSimulation.force('center')
    .x(graphWidth / 2)
    .y(graphHeight / 2);

  // Restart simulation
  if (currentData) {
    updateTimeline(currentData);
    updateGraph(currentData);
  }
}

// Replace the lodash debounce with our own implementation
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

// Update the resize listener
const debouncedResize = debounce(handleResize, 250);
window.addEventListener('resize', debouncedResize);

function formatUrl(url) {
  try {
    const urlObj = new URL(url);
    let cleanHost = urlObj.hostname.replace(/^www\./, '');
    let cleanPath = urlObj.pathname;
    
    // Get first parameter if exists
    let params = '';
    const searchParams = new URLSearchParams(urlObj.search);
    const firstParam = searchParams.entries().next().value;
    if (firstParam) {
      params = `?${firstParam[0]}=${firstParam[1]}${searchParams.size > 1 ? '...' : ''}`;
    }
    
    return `${cleanHost}${cleanPath}${params}`;
  } catch (e) {
    return url; // Fallback to original URL if parsing fails
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
  const xStrength = 0.8;  // Stronger horizontal alignment
  const yStrength = 0.3;
  const layerHeight = height / 4; // Divide height into layers

  // Calculate time-based x positions first
  const timeScale = sharedTimeScale.copy()
    .range([width * 0.1, width * 0.9]);

  // Create hierarchical layout
  graphSimulation
    .force('x')
    .strength(xStrength)
    .x(d => timeScale(new Date(d.lastVisitTime || d.lastAccessed)));

  // Layer-based Y positioning
  graphSimulation
    .force('y')
    .strength(yStrength)
    .y(d => {
      if (d.type === 'history') {
        return layerHeight; // History items in top layer
      }
      // Window tabs in layers based on window ID
      return layerHeight * (2 + (d.windowId % 2));
    });

  // Adjust other forces
  graphSimulation
    .force('charge')
    .strength(-100) // Reduced repulsion
    .distanceMax(width * 0.1); // Limit charge effect range

  graphSimulation
    .force('collision')
    .radius(12) // Slightly larger to prevent overlap
    .strength(0.8); // Stronger collision avoidance

  // Use curved links for better visibility
  plotArea.selectAll('.graph-link')
    .attr('d', d => {
      const sourceX = d.source.x;
      const sourceY = d.source.y;
      const targetX = d.target.x;
      const targetY = d.target.y;
      
      // Calculate control points for curve
      const midX = (sourceX + targetX) / 2;
      const midY = (sourceY + targetY) / 2;
      const dx = targetX - sourceX;
      const dy = targetY - sourceY;
      const curvature = 0.5;
      
      // Curve upward if going to higher layer, downward if going to lower
      const sign = sourceY > targetY ? -1 : 1;
      const controlX = midX;
      const controlY = midY + (sign * Math.abs(dx) * curvature);
      
      return `M${sourceX},${sourceY} Q${controlX},${controlY} ${targetX},${targetY}`;
    });

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

function updateStats(currentTimeScale) {
  // Add null check for currentData
  if (!currentData?.historySwimlane) {
    // Set default values when no data is available
    document.getElementById('time-range-stat').textContent = '--:-- - --:--';
    document.getElementById('events-stat').textContent = '0 shown';
    document.getElementById('sessions-stat').textContent = '0';
    return;
  }

  const [start, end] = currentTimeScale.domain();
  const timeRange = `${d3.timeFormat('%H:%M')(start)} - ${d3.timeFormat('%H:%M')(end)}`;
  
  // Count visible nodes in the graph
  const visibleNodes = currentData.historySwimlane.filter(d => {
    const time = new Date(d.lastVisitTime);
    return time >= start && time <= end;
  }).length;

  // Count sessions (gaps > 30 min)
  const sessions = countSessions(currentData.historySwimlane, start, end);

  document.getElementById('time-range-stat').textContent = timeRange;
  document.getElementById('events-stat').textContent = `${visibleNodes} shown`;
  document.getElementById('sessions-stat').textContent = sessions;
}

function countSessions(data, start, end) {
  const SHORT_GAP = 2 * 60 * 1000;    // 5 minutes
  const MEDIUM_GAP = 5 * 60 * 1000;  // 15 minutes
  const LONG_GAP = 10 * 60 * 1000;    // 30 minutes
  
  let sessionCount = 0;
  let lastTime = null;
  let lastDomain = null;
  let interactionBurst = 0;

  // Sort and filter data first
  const visibleData = [...data]
    .sort((a, b) => new Date(a.lastVisitTime) - new Date(b.lastVisitTime))
    .filter(d => {
      const time = new Date(d.lastVisitTime);
      return time >= start && time <= end;
    });

  if (visibleData.length === 0) return 0;

  // Initialize first session
  sessionCount = 1;
  lastTime = new Date(visibleData[0].lastVisitTime);
  lastDomain = new URL(visibleData[0].url).hostname;

  // Check sequential events
  for (let i = 1; i < visibleData.length; i++) {
    const currentTime = new Date(visibleData[i].lastVisitTime);
    const currentDomain = new URL(visibleData[i].url).hostname;
    const timeDiff = currentTime - lastTime;
    
    // Detect session breaks based on:
    // 1. Long gaps always break sessions
    // 2. Medium gaps break sessions unless we're in same domain
    // 3. Short gaps only break sessions if domain changes and no recent activity
    if (timeDiff > LONG_GAP || 
        (timeDiff > MEDIUM_GAP && currentDomain !== lastDomain) ||
        (timeDiff > SHORT_GAP && currentDomain !== lastDomain && interactionBurst < 3)) {
      sessionCount++;
      interactionBurst = 0;
    } else {
      // Track rapid interactions
      if (timeDiff < SHORT_GAP) {
        interactionBurst++;
      } else {
        interactionBurst = Math.max(0, interactionBurst - 1);
      }
    }

    lastTime = currentTime;
    lastDomain = currentDomain;
  }

  return sessionCount;
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
