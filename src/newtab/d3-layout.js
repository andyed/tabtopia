// Layout constants
export const LAYOUT = {
    TIMELINE_HEIGHT: 170,
    HEADER_HEIGHT: 43,
    Y_AXIS_HEIGHT: 22,
    ROW_HEIGHT: 30,
    AXIS_HEIGHT: 30,
    AXIS_MARGIN: 10,
    HISTORY_ROWS: 2,
    READOUT_HEIGHT: 45
};

// Layout state
let width = 800;
let height = 600;

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

export function updateLayout(currentData) {
    // Calculate section heights
    const numWindows = currentData?.windowSwimlanes ? 
        Object.keys(currentData.windowSwimlanes).length : 0;
    const swimlaneRows = LAYOUT.HISTORY_ROWS + numWindows;
    
    // Include TIMELINE_HEIGHT in calculation
    const swimlaneHeight = swimlaneRows * LAYOUT.ROW_HEIGHT;
    const timelineHeight = LAYOUT.TIMELINE_HEIGHT + 
                          swimlaneHeight + 
                          LAYOUT.AXIS_HEIGHT + 
                          LAYOUT.AXIS_MARGIN;

    // Position readout
    const readoutContainer = document.getElementById('readout-container');
    if (readoutContainer) {
        readoutContainer.style.position = 'absolute';
        readoutContainer.style.top = `${timelineHeight}px`;
        readoutContainer.style.width = '100%';
        readoutContainer.style.zIndex = '2';
    }

    // Calculate remaining heights
    const readoutHeight = readoutContainer?.getBoundingClientRect().height || LAYOUT.READOUT_HEIGHT;
    const totalHeight = window.innerHeight;
    const graphStartY = timelineHeight + readoutHeight;
    const graphHeight = totalHeight - graphStartY;

    // Position graph
    const graphContainer = d3.select('#graph-container');
    graphContainer
        .style('position', 'absolute')
        .style('top', `${graphStartY}px`)
        .style('height', `${graphHeight}px`)
        .style('width', '100%');

    return { timelineHeight, readoutHeight, graphStartY, graphHeight, totalHeight };
}

export function handleResize(currentData, updateTimeline, updateGraph) {
    const dimensions = updateLayout(currentData);
    if (currentData) {
        updateTimeline(currentData);
        updateGraph(currentData);
    }
    return dimensions;
}

// Create debounced resize handler
export const debouncedResize = debounce((currentData, updateTimeline, updateGraph) => {
    handleResize(currentData, updateTimeline, updateGraph);
}, 250);

// Remove old resize listeners
window.removeEventListener('resize', debouncedResize);

// Add new resize listener with proper parameters
window.addEventListener('resize', () => debouncedResize(currentData, updateTimeline, updateGraph));