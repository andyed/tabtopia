import { getFaviconUrl } from './utility.js';

// Update margin constant at the top
const margin = { top: 20, right: 20, bottom: 30, left: 20 }; // Reduced left margin
const sharedTimeScale = d3.scaleTime();
let width, height; // Declare these at file scope
let currentData = null;
let resizeTimer;

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
    .attr('transform', `translate(0,${height - margin.bottom})`); // Changed from top to bottom

  setupZooming();
  handleResize();

  return { width, height, g };
}

export function initializeGraph() {
  const container = d3.select('#graph-svg');
  const element = container.node();
  
  if (!element) {
    console.error('Graph container not found');
    return;
  }

  const width = element.getBoundingClientRect().width - margin.left - margin.right;
  const height = element.getBoundingClientRect().height - margin.top - margin.bottom;

  // Use the shared time scale
  container.append('g')
    .attr('class', 'x-axis')
    .attr('transform', `translate(${margin.left},${margin.top})`)
    .call(d3.axisTop(sharedTimeScale)); // Note: using axisTop here

  // Rest of graph initialization
  console.log('Initializing graph');
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

  // Calculate dynamic dimensions
  const historyHeight = 60; // Base height for history swimlane
  const windowHeight = 32; // Base height for window swimlanes
  const totalWindows = validWindows.length;
  
  // Calculate total height needed
  const requiredHeight = historyHeight + (totalWindows * windowHeight);
  
  // Update container dimensions
  width = element.getBoundingClientRect().width - margin.left - margin.right;
  height = requiredHeight + margin.top + margin.bottom;

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

  // Add swimlane backgrounds
  plotArea.append('rect')
    .attr('class', 'timeline-swimlane history')
    .attr('x', 0)
    .attr('y', 0)
    .attr('width', width)
    .attr('height', historyHeight);

  validWindows.forEach((window, i) => {
    const yPos = historyHeight + (i * windowHeight);
    plotArea.append('rect')
      .attr('class', 'timeline-swimlane window')
      .attr('x', 0)
      .attr('y', yPos)
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
    const yPos = historyHeight + (i * windowHeight) + (windowHeight / 2);
    
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
}

function addFaviconsToPoints(points) {
  // Add unique IDs to clip paths
  points.append('clipPath')
    .attr('id', (d, i) => `clip-${Math.random().toString(36).substr(2, 9)}`)
    .append('circle')
    .attr('r', 8);

  // Add background circle
  points.append('circle')
    .attr('class', 'favicon-background')
    .attr('r', 8);

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
    })
    .on('mouseout', function() {
      hideTooltipInfo();
      
      // Remove highlight
      d3.select(this.parentNode)
        .select('.favicon-background')
        .classed('highlighted', false);
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

// Add this new function
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

export function updateGraph(data) {
  // Update the node-link force graph visualization with new data
  console.log('Updating graph with data', data);
}

export function setupBrushing() {
  // Set up brushing interaction for the timeline
  console.log('Setting up brushing');
}

export function setupZooming() {
  const svg = d3.select('#timeline-svg');
  const plotArea = svg.select('.plot-area');

  // Create zoom behavior
  const zoom = d3.zoom()
    .scaleExtent([1, 20]) // Limit zoom scale
    .on('zoom', zoomed)
    // Constrain panning
    .translateExtent([
      [0, -Infinity], // Allow vertical panning
      [width, Infinity]
    ]);

  // Add zoom to SVG
  svg.call(zoom);

  // Initialize with slight zoom into recent time
  const initialTransform = d3.zoomIdentity
    .scale(1.5)
    .translate(-width * 0.3, 0); // Move right to show recent items

  svg.call(zoom.transform, initialTransform);

  function zoomed(event) {
    const newTimeScale = event.transform.rescaleX(sharedTimeScale);
    
    // Prevent zooming past future limit
    const domain = newTimeScale.domain();
    const now = new Date();
    const futureLimit = new Date(now.getTime() + 60000);
    
    if (domain[1] > futureLimit) {
      const adjustment = domain[1] - futureLimit;
      event.transform.x += newTimeScale(futureLimit) - newTimeScale(domain[1]);
      svg.call(zoom.transform, event.transform);
    }

    // Update axis and points
    svg.select('.x-axis')
      .call(d3.axisBottom(newTimeScale)
        .tickFormat(d3.timeFormat('%H:%M')));

    // Update all points using stored y positions
    plotArea.selectAll('.timeline-point')
      .attr('transform', d => {
        const x = newTimeScale(new Date(d.lastVisitTime || d.lastAccessed));
        return `translate(${x},${d.yPos})`;
      })
      .style('display', d => {
        const x = newTimeScale(new Date(d.lastVisitTime || d.lastAccessed));
        return x >= 0 && x <= width ? '' : 'none';
      });
  }
}

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
  // Debounce resize events
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const container = d3.select('#timeline-svg');
    const element = container.node();
    
    if (!element || !currentData) return;

    // Calculate dynamic dimensions
    const { historySwimlane = [], activeWindowsAndTabs = [] } = currentData;
    const validWindows = (activeWindowsAndTabs || []).filter(window => 
      window?.tabs?.some(tab => !tab.url.startsWith('chrome://'))
    );

    const historyHeight = 60;
    const windowHeight = 32;
    const totalWindows = validWindows.length;
    const requiredHeight = historyHeight + (totalWindows * windowHeight);

    // Update dimensions
    width = element.getBoundingClientRect().width - margin.left - margin.right;
    height = requiredHeight + margin.top + margin.bottom;

    // Update SVG size
    container
      .attr('width', width + margin.left + margin.right)
      .attr('height', height);

    // Update scales
    sharedTimeScale.range([0, width]);

    // Trigger update with current data
    if (currentData) {
      updateTimeline(currentData);
    }
  }, 250);
}

// Add resize listener
window.addEventListener('resize', handleResize);

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
