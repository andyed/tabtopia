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
    // Calculate swimlane heights
    const numWindows = currentData?.windowSwimlanes ? 
        Object.keys(currentData.windowSwimlanes).length : 0;
    const swimlaneRows = LAYOUT.HISTORY_ROWS + numWindows;
    const swimlaneHeight = swimlaneRows * LAYOUT.ROW_HEIGHT;
    
    // Calculate total timeline height
    const timelineHeight = swimlaneHeight + 
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
    const readoutHeight = readoutContainer?.getBoundingClientRect().height || 
                         LAYOUT.READOUT_HEIGHT;
    
    const totalHeight = window.innerHeight;
    const graphStartY = timelineHeight + readoutHeight;
    const graphHeight = totalHeight - graphStartY;

    return {
        timelineHeight,
        readoutHeight,
        graphStartY,
        graphHeight,
        totalHeight,
        width,
        height
    };
}

export function handleResize(currentData, updateTimeline, updateGraph) {
    // Get dimensions
    const container = d3.select('#timeline-svg');
    const element = container.node();
    if (!element) return;

    // Update timeline dimensions
    const width = element.getBoundingClientRect().width;
    const numWindows = currentData?.windowSwimlanes ? 
        Object.keys(currentData.windowSwimlanes).length : 0;
    const swimlaneRows = LAYOUT.HISTORY_ROWS + numWindows;
    const height = (swimlaneRows * LAYOUT.ROW_HEIGHT) + 
                   LAYOUT.AXIS_HEIGHT + 
                   LAYOUT.AXIS_MARGIN;

    // Update containers
    container
        .attr('width', width)
        .attr('height', height);

    // Update visualizations
    if (currentData) {
        updateTimeline(currentData);
        updateGraph(currentData);
    }

    return { width, height };
}

// Create debounced resize handler
export const debouncedResize = debounce(handleResize, 250);