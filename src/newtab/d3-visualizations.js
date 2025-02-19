import { getFaviconUrl } from './utility.js';

const margin = { top: 20, right: 30, bottom: 30, left: 60 };
const sharedTimeScale = d3.scaleTime();

export function initializeTimeline() {
  const container = d3.select('#timeline-svg');
  const width = container.node().getBoundingClientRect().width - margin.left - margin.right;
  const height = container.node().getBoundingClientRect().height - margin.top - margin.bottom;

  // Clear existing content
  container.selectAll('*').remove();

  // Create main group
  const g = container.append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  // Add axes groups
  g.append('g')
    .attr('class', 'x-axis')
    .attr('transform', `translate(0,${height - margin.bottom})`);

  // Add plot area group
  g.append('g')
    .attr('class', 'plot-area');

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
  const { historySwimlane = [], windowSwimlanes = {}, activeWindowsAndTabs = [] } = data || {};
  
  const container = d3.select('#timeline-svg');
  const element = container.node();
  
  if (!element) {
    console.error('Timeline container not found');
    return;
  }

  const width = element.getBoundingClientRect().width - margin.left - margin.right;
  const height = element.getBoundingClientRect().height - margin.top - margin.bottom;

  // Filter out windows with only chrome:// URLs, with null check
  const validWindows = (activeWindowsAndTabs || []).filter(window => 
    window?.tabs?.some(tab => !tab.url.startsWith('chrome://'))
  );

  // Calculate swimlane heights
  const historyHeight = 80; // Double height for history
  const windowHeight = 40;
  
  // Create time scale with fallback for empty history
  const timeExtent = d3.extent(historySwimlane || [], d => new Date(d.lastVisitTime)) || [new Date(), new Date()];
  sharedTimeScale
    .domain(timeExtent)
    .range([0, width]);

  // Create jitter scale for history swimlane
  const jitterScale = d3.randomNormal(historyHeight / 2, historyHeight / 6);

  // Clear existing content
  const plotArea = container.select('.plot-area');
  plotArea.selectAll('*').remove();

  // Add history swimlane
  plotArea.append('rect')
    .attr('class', 'timeline-swimlane history')
    .attr('x', 0)
    .attr('y', 0)
    .attr('width', width)
    .attr('height', historyHeight);

  // Add window swimlanes
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

  // Plot history points with jitter
  const historyPoints = plotArea.selectAll('.history-point')
    .data(historySwimlane)
    .enter()
    .append('g')
    .attr('class', 'timeline-point history')
    .attr('transform', d => {
      const x = sharedTimeScale(new Date(d.lastVisitTime));
      const y = jitterScale(); // Add vertical jitter
      return `translate(${x},${y})`;
    });

  // Plot window points
  validWindows.forEach((window, i) => {
    const tabs = windowSwimlanes[window.id] || [];
    const windowPoints = plotArea.selectAll(`.window-point-${window.id}`)
      .data(tabs)
      .enter()
      .append('g')
      .attr('class', `timeline-point window-${window.id}`)
      .attr('transform', d => {
        const x = sharedTimeScale(new Date(d.lastVisitTime || d.lastAccessed));
        const y = historyHeight + (i * windowHeight) + (windowHeight / 2);
        return `translate(${x},${y})`;
      });

    addFaviconsToPoints(windowPoints);
  });

  // Add favicons to history points
  addFaviconsToPoints(historyPoints);

  // Update x-axis with time format
  const xAxis = d3.axisBottom(sharedTimeScale)
    .tickFormat(d3.timeFormat('%H:%M'));
  
  container.select('.x-axis')
    .call(xAxis);
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

  // Add favicon images
  points.append('image')
    .attr('xlink:href', d => `chrome://favicon/size/16@1x/${d.url}`)
    .attr('x', -8)
    .attr('y', -8)
    .attr('width', 16)
    .attr('height', 16)
    .attr('clip-path', function() {
      return `url(#${this.parentNode.querySelector('clipPath').id})`;
    });
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
  const zoom = d3.zoom()
    .on('zoom', (event) => {
      // Update both visualizations when zooming
      const newScale = event.transform.rescaleX(sharedTimeScale);
      
      // Update timeline
      d3.select('#timeline-svg .x-axis').call(d3.axisBottom(newScale));
      // Update timeline elements...

      // Update graph
      d3.select('#graph-svg .x-axis').call(d3.axisTop(newScale));
      // Update graph elements...
    });

  // Apply zoom to both containers
  d3.select('#timeline-svg').call(zoom);
  d3.select('#graph-svg').call(zoom);
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
  tooltipInfo.textContent = info;
  tooltipInfo.style.display = 'inline';
}

function hideTooltipInfo() {
  document.getElementById('tooltip-info').style.display = 'none';
  document.getElementById('default-stats').style.display = 'inline';
}
