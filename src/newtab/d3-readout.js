import { formatUrl } from './utility.js';

export function showTooltipInfo(info) {
  console.log(info)
  document.getElementById('default-stats').style.display = 'none';
  const tooltipInfo = document.getElementById('tooltip-info');
  tooltipInfo.innerHTML = info; // Changed from textContent to innerHTML
  tooltipInfo.style.display = 'inline';
}

export function hideTooltipInfo() {
  document.getElementById('tooltip-info').style.display = 'none';
  document.getElementById('default-stats').style.display = 'inline';
}

export function updateStats(data, type = 'events') {
    // Get all stat elements
    const timeRangeStat = document.getElementById('time-range-stat');
    const eventsStat = document.getElementById('events-stat');
    const sessionsStat = document.getElementById('sessions-stat');

    if (!timeRangeStat || !eventsStat || !sessionsStat) return;

    // Handle different types of updates
    if (data?.domain) {
        // It's a time scale update
        const [start, end] = data.domain();
        const timeRange = `${d3.timeFormat('%H:%M')(start)} - ${d3.timeFormat('%H:%M')(end)}`;
        timeRangeStat.textContent = timeRange;
    } 
    else if (typeof data === 'object' && data.graphNodes !== undefined) {
        // It's a node count update
        eventsStat.textContent = data.graphNodes;
        sessionsStat.textContent = data.timelineNodes;
    }
}

export function updateNodeReadout(node) {
    const readout = document.getElementById('readout');
    if (!readout || !node) return;

    const primaryText = readout.querySelector('.primary-text');
    const urlText = readout.querySelector('.secondary-text.url');
    const timeText = readout.querySelector('.secondary-text.time');

    // Set title as primary text
    primaryText.textContent = node.title || formatUrl(node.url);

    // Set truncated URL as secondary
    urlText.textContent = formatUrl(node.url);

    // Format time
    const visitDate = new Date(node.lastVisitTime);
    const now = new Date();
    const isToday = visitDate.toDateString() === now.toDateString();
    
    timeText.textContent = isToday 
        ? `Visited at ${visitDate.toLocaleTimeString()}` 
        : `Visited on ${visitDate.toLocaleDateString()} at ${visitDate.toLocaleTimeString()}`;
}

export function clearReadout() {
    const readout = document.getElementById('readout');
    if (!readout) return;

    readout.querySelector('.primary-text').textContent = '';
    readout.querySelector('.secondary-text.url').textContent = '';
    readout.querySelector('.secondary-text.time').textContent = '';
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