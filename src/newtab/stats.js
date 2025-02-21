export function updateStats(currentTimeScale, currentData) {
  if (!currentData?.historySwimlane) {
    document.getElementById('time-range-stat').textContent = '--:-- - --:--';
    document.getElementById('events-stat').textContent = '0 shown';
    document.getElementById('sessions-stat').textContent = '0';
    return;
  }

  const [start, end] = currentTimeScale.domain();
  const timeRange = `${d3.timeFormat('%H:%M')(start)} - ${d3.timeFormat('%H:%M')(end)}`;
  
  const visibleNodes = currentData.historySwimlane.filter(d => {
    const time = new Date(d.lastVisitTime);
    return time >= start && time <= end;
  }).length;

  const sessions = countSessions(currentData.historySwimlane, start, end);

  document.getElementById('time-range-stat').textContent = timeRange;
  document.getElementById('events-stat').textContent = `${visibleNodes} shown`;
  document.getElementById('sessions-stat').textContent = sessions;
}

function countSessions(data, start, end) {
  const SHORT_GAP = 2 * 60 * 1000;    // 5 minutes
  const MEDIUM_GAP = 5 * 60 * 1000;   // 15 minutes
  const LONG_GAP = 10 * 60 * 1000;    // 30 minutes
  
  let sessionCount = 0;
  let lastTime = null;
  let lastDomain = null;
  let interactionBurst = 0;

  const visibleData = [...data]
    .sort((a, b) => new Date(a.lastVisitTime) - new Date(b.lastVisitTime))
    .filter(d => {
      const time = new Date(d.lastVisitTime);
      return time >= start && time <= end;
    });

  if (visibleData.length === 0) return 0;

  sessionCount = 1;
  lastTime = new Date(visibleData[0].lastVisitTime);
  lastDomain = new URL(visibleData[0].url).hostname;

  for (let i = 1; i < visibleData.length; i++) {
    const currentTime = new Date(visibleData[i].lastVisitTime);
    const currentDomain = new URL(visibleData[i].url).hostname;
    const timeDiff = currentTime - lastTime;
    
    if (timeDiff > LONG_GAP || 
        (timeDiff > MEDIUM_GAP && currentDomain !== lastDomain) ||
        (timeDiff > SHORT_GAP && currentDomain !== lastDomain && interactionBurst < 3)) {
      sessionCount++;
      interactionBurst = 0;
    } else {
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