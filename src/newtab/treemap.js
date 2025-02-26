import { getFaviconUrl, formatDistanceToNow, formatSessionDuration } from './utility.js';
import { displayReadout, hideReadout } from './readout.js';
import { handleKeyNavigation } from './keyboardNav.js';
import { fetchRecentBookmarks } from './init.js';

let categorizedDataCache = null;
let readoutTimeout = null;
let currentData = null;  // Add this line
let currentFocusIndex = -1;
let focusableNodes = [];
let currentTabOrder = []; // Store current tab order IDs

// Add state management at the top of file
const interactionState = {
    focusedNode: null,
    activeNode: null,
    isKeyboardMode: false,
    focusableNodes: [],
    currentTabOrder: []
};

// State management at top of file
const state = {
    data: null,
    activeWindowCount: 0,
    get needsBookmarks() {
        return this.getTotalTabs() < 4;
    },
    getTotalTabs() {
        return this.data?.activeWindows?.reduce((sum, w) => sum + w.tabs.length, 0) || 0;
    },
    hasWindows() {
        return this.data?.activeWindows?.length > 0;
    },
    getWindowById(windowId) {
        return this.data?.activeWindows?.find(w => w.id === windowId);
    }
};

// Add at the top with other state management
const updateState = {
    lastUpdate: Date.now(),
    isUpdating: false,
    debounceTime: 100 // ms
};

// Initialize state from background
async function initializeState() {
    try {
        const initialState = await chrome.runtime.sendMessage({ type: 'getInitialState' });
        if (!initialState?.activeWindows) {
            console.warn('Invalid initial state:', initialState);
            return;
        }

        state.data = initialState;
        console.log('State initialized:', {
            windows: state.data.activeWindows.length,
            totalTabs: state.getTotalTabs(),
            windowsList: state.data.activeWindows.map(w => w.id)
        });

        // Draw initial treemap if we have windows
        if (state.hasWindows()) {
            drawTreemap(state.data);
        } else {
            showEmptyState();
        }
    } catch (error) {
        console.error('Failed to initialize state:', error);
        showEmptyState();
    }
}

// Update favicon loading function
async function updateCellFavicon(cell, url, size) {
    try {
        // Request favicon through background script
        chrome.runtime.sendMessage({
            type: 'getFavicon',
            url: url,
            size: size
        }, response => {
            if (response?.faviconUrl) {
                cell.select('image')
                    .attr('xlink:href', response.faviconUrl)
                    .attr('width', size)
                    .attr('height', size)
                    .attr('x', -size/2)
                    .attr('y', -size/2)
                    .on('error', function() {
                        // If high-res fails, try smaller size
                        chrome.runtime.sendMessage({
                            type: 'getFavicon',
                            url: url,
                            size: 16
                        }, fallbackResponse => {
                            if (fallbackResponse?.faviconUrl) {
                                d3.select(this)
                                    .attr('xlink:href', fallbackResponse.faviconUrl);
                            }
                        });
                    });
            }
        });
    } catch (error) {
        console.warn('Error loading favicon for:', url, error);
    }
}

function calculateOptimalIconSize(root, width, height) {
    // Get total area and count of leaf nodes
    const totalArea = width * height;
    const leafCount = root.leaves().length;
    
    // Calculate average cell area
    const avgCellArea = totalArea / leafCount;
    
    // Calculate shortest side of average cell (assuming square)
    const avgCellSide = Math.sqrt(avgCellArea);
    
    // Calculate icon size (max 128, min 16)
    const iconSize = Math.max(16, Math.min(128, Math.floor(avgCellSide / 2)));
    
    console.log(`Calculated icon size: ${iconSize}px for ${leafCount} nodes`);
    return iconSize;
}

// Update the layout calculation to ensure minimum 4 cells
function calculateOptimalLayout(totalTabs, width, viewportHeight) {
    let iconSize = 128;
    const minIconSize = 16;
    const padding = 10;
    const textHeight = 40;
    
    // Calculate cells needed
    const minimumCells = Math.max(4, totalTabs);
    
    while (iconSize > minIconSize) {
        const cellSize = iconSize + padding * 2 + textHeight;
        const cellsPerRow = Math.floor(width / cellSize);
        const rows = Math.ceil(minimumCells / cellsPerRow);
        const totalHeight = rows * cellSize;
        
        if (totalHeight <= viewportHeight) {
            return {
                iconSize,
                height: viewportHeight,
                cellsPerRow,
                rows,
                minimumCells,
                enableScroll: false
            };
        }
        
        iconSize -= 16;
    }
    
    // If we get here, use minimum size
    const cellSize = minIconSize + padding * 2 + textHeight;
    const cellsPerRow = Math.floor(width / cellSize);
    
    return {
        iconSize: minIconSize,
        height: Math.max(viewportHeight, Math.ceil(minimumCells / cellsPerRow) * cellSize),
        cellsPerRow,
        rows: Math.ceil(minimumCells / cellsPerRow),
        minimumCells,
        enableScroll: true
    };
}

export async function drawTreemap(data) {
    if (!data?.activeWindows) {
        console.warn('Invalid data for treemap:', data);
        return;
    }

    console.log('Drawing treemap with:', {
        windows: data.activeWindows.length,
        totalTabs: data.activeWindows.reduce((sum, w) => sum + w.tabs.length, 0)
    });

    const container = document.getElementById('treemap');
    const viewportHeight = window.innerHeight - 48;
    const width = container.offsetWidth || 800;
    const totalTabs = data.activeWindows.reduce((sum, w) => sum + w.tabs.length, 0);

    // Calculate optimal layout
    const layout = calculateOptimalLayout(totalTabs, width, viewportHeight);

    console.log('Layout calculation:', {
        totalTabs,
        minimumCells: layout.minimumCells,
        cellsPerRow: layout.cellsPerRow,
        rows: layout.rows
    });

    // Apply scroll only if necessary
    container.style.height = `${viewportHeight}px`;
    container.style.overflowY = layout.enableScroll ? 'auto' : 'hidden';
    container.style.overflowX = 'hidden';

    // Create SVG with calculated height
    d3.select('#treemap').selectAll('*').remove();

    const margin = { top: 0, right: 0, bottom: 0, left: 0 };

    const svg = d3.select('#treemap')
        .append('svg')
        .style('margin', '0')
        .style('padding', '0')
        .attr('width', width)
        .attr('height', layout.height);

    const svgRoot = svg.append('g')
        .attr('transform', `translate(${margin.left},${margin.top})`);

    // Create color schemes
    const lightColors = [
        '#e3f2fd', '#e8f5e9', '#fff3e0', '#ffebee', 
        '#f3e5f5', '#e0f7fa', '#fffde7', '#efebe9'
    ];

    const windowColors = new Map();

    // First, set colors for active windows
    data.activeWindows.forEach((window, index) => {
        windowColors.set(window.id, lightColors[index % lightColors.length]);
    });

    // Set a default color for the bookmark window
    windowColors.set('bookmark', '#f5f5f5'); // Light gray for bookmarks

    // Create hierarchy data
    const hierarchyData = {
        name: 'root',
        children: data.activeWindows.map(window => ({
            name: `Window ${window.id}`,
            children: window.tabs.map(tab => ({
                id: `tab${tab.id}`,
                windowId: window.id,
                title: tab.title || 'Untitled',
                url: tab.url || '',
                favIconUrl: tab.favIconUrl,
                lastAccessed: tab.lastAccessed,
                timeSpent: tab.totalTimeSpent || 1, // Use actual time spent
                children: []
            }))
        }))
    };

    // Calculate empty cells needed
    const currentTabs = hierarchyData.children.flatMap(window => window.children);
    const emptyCells = calculateEmptyCells(currentTabs.length);

    console.log('Empty cells calculation:', {
        currentTabs: currentTabs.length,
        minimumCellCount: 4,
        emptyCells,
        windowColors: Array.from(windowColors.entries())
    });

    // Fill empty cells with bookmarks
    if (emptyCells > 0) {
        const bookmarkWindow = await fillEmptyCellsWithBookmarks(emptyCells);
        hierarchyData.children.push(bookmarkWindow);
    }

    // Create and configure treemap
    const treemap = d3.treemap()
        .size([width, layout.height])
        .paddingTop(5)    // Add padding between windows
        .paddingRight(5)
        .paddingBottom(5)
        .paddingLeft(5)
        .paddingInner(1)  // Small gap between tabs in same window
        .round(true);     // Round to whole pixels

    // Keep the d3 hierarchy root as 'root'
    const root = d3.hierarchy(hierarchyData)
        .sum(d => d.timeSpent)
        .sort((a, b) => b.value - a.value);

    treemap(root);

    console.log('Treemap layout applied:', root); // Debug

    // Create a color scale for recency of visit within each window
    root.children.forEach(windowNode => {
        const tabs = windowNode.children;
        const maxLastAccessed = d3.max(tabs, d => d.data.lastAccessed);
        const minLastAccessed = d3.min(tabs, d => d.data.lastAccessed);

        // Get window ID, handling bookmark window correctly
        const windowId = windowNode.data.name.includes('bookmark') ? 'bookmark' : 
            parseInt(windowNode.data.name.replace('Window ', ''), 10);
        
        const baseColor = d3.color(windowColors.get(windowId));
        if (!baseColor) {
            console.warn(`No color found for window ${windowId}, using default`);
            // Set a default color for unknown windows
            windowColors.set(windowId, '#f5f5f5');
            return;
        }

        const colorScale = d3.scaleLinear()
            .domain([minLastAccessed, maxLastAccessed])
            .range([baseColor.darker(0.5), baseColor.brighter(0.2)]);

        tabs.forEach(tab => {
            tab.data.color = tab.data.isBookmark ? '#f5f5f5' : colorScale(tab.data.lastAccessed);
        });
    });

    // Add background rectangles for each window
    root.children.forEach(windowNode => {
        const baseColor = d3.color(windowColors.get(parseInt(windowNode.data.name.replace('Window ', ''), 10)));
        if (!baseColor) {
            console.error('Base color not found for window:', windowNode.data.name);
            return;
        }

        svg.append('rect')
            .attr('x', windowNode.x0)
            .attr('y', windowNode.y0)
            .attr('width', windowNode.x1 - windowNode.x0)
            .attr('height', windowNode.y1 - windowNode.y0)
            .attr('fill', baseColor.darker(0.5))
            .attr('stroke', '#999')        // Add border
            .attr('stroke-width', '2px')   // Border width
            .attr('rx', '4')              // Rounded corners
            .attr('ry', '4');
    });

    // Create sorted tab order based on lastAccessed
    const allTabs = root.leaves().sort((a, b) => {
        return b.data.lastAccessed - a.data.lastAccessed;
    });

    // Store the current tab order
    currentTabOrder = allTabs.map(tab => tab.data.id);

    console.log('Nodes data:', root.leaves());

    // 1. Create base node structure
    const nodes = svg.selectAll('.cell')
        .data(root.leaves())
        .enter()
        .append('g')
        .attr('class', 'cell')
        .attr('transform', d => `translate(${d.x0},${d.y0})`)
        .style('cursor', 'pointer')
        .attr('tabindex', d => currentTabOrder.indexOf(d.data.id))
        .attr('role', 'button')
        .attr('aria-label', d => d.data.title)
        .classed('bookmark-cell', d => d.data.isBookmark);

    // 2. Add background rectangles for each node
    nodes.append('rect')
        .attr('id', d => d.data.id)
        .attr('width', d => d.x1 - d.x0)
        .attr('height', d => d.y1 - d.y0)
        .attr('fill', d => d.data.isBookmark ? '#f8f9fa' : d.data.color)
        .attr('opacity', d => d.data.isBookmark ? 0.4 : 1) // More translucent for bookmarks
        .attr('stroke', d => d.data.isBookmark ? '#ddd' : 'none')
        .attr('stroke-dasharray', d => d.data.isBookmark ? '4,4' : 'none') // Dashed border for bookmarks
        .attr('rx', d => d.data.isBookmark ? '8' : '4') // More rounded corners for bookmarks
        .attr('ry', d => d.data.isBookmark ? '8' : '4');

    // 3. Add cell content container
    const cellContent = nodes.append('g')
        .attr('class', 'cell-content')
        .attr('transform', d => {
            const cellWidth = d.x1 - d.x0;
            const cellHeight = d.y1 - d.y0;
            return `translate(${cellWidth / 2},${cellHeight / 2})`;
        })
        .each(function(d) {
            // Calculate icon size for this specific cell
            const cellWidth = d.x1 - d.x0;
            const cellHeight = d.y1 - d.y0;
            d.iconSize = calculateCellIconSize(cellWidth, cellHeight);
        });

    // 4. Add favicon and text to content container
    cellContent.append('image')
        .attr('class', 'favicon')
        .attr('xlink:href', d => {
            // Only proceed if we have valid data
            if (!d.data?.url) return null;

            try {
                // Use existing favicon if available
                if (d.data.favIconUrl && d.data.favIconUrl !== 'chrome://favicon/') {
                    return d.data.favIconUrl;
                }

                // Handle chrome:// URLs with settings icon
                if (d.data.url.startsWith('chrome://')) {
                    return 'data:image/svg+xml;base64,' + btoa(`
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
                            <path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.4 .2l-2.2 2.933l-2.2 -2.933a1 1 0 1 0 -1.6 1.2l2.55 3.4l-2.55 3.4a1 1 0 1 0 1.6 1.2l2.2 -2.933l2.2 2.933a1 1 0 0 0 1.6 -1.2l-2.55 -3.4l2.55 -3.4a1 1 0 0 0 -.2 -1.4"/>
                        </svg>
                    `);
                }

                // For regular URLs, try to get favicon from origin
                const url = new URL(d.data.url);
                return `${url.origin}/favicon.ico`;

            } catch (e) {
                console.warn('Invalid URL or favicon:', d.data.url);
                return null;
            }
        })
        .attr('width', d => d.iconSize)
        .attr('height', d => d.iconSize)
        .attr('x', d => -d.iconSize/2)
        .attr('y', d => -d.iconSize/2)
        .on('error', function() {
            // On error, set to default icon
            d3.select(this).attr('xlink:href', 'data:image/svg+xml;base64,' + btoa(`
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
                    <rect width="24" height="24" rx="4" fill="#eeeeee"/>
                    <text x="12" y="16" font-size="14" text-anchor="middle" fill="#999999">?</text>
                </svg>
            `));
        });

    // Centered text below favicon
    const textElement = cellContent.append('text')
        .attr('text-anchor', 'middle')
        .attr('y', d => d.iconSize/2 + 20) // Position text below icon
        .attr('fill', 'black') // Black font color
        .attr('opacity', 0.8) // 80% opacity
        .attr('pointer-events', 'none')
        .text(d => formatTitle(d.data.title));

    // Adjust font size to fit the available cell space
    nodes.each(function(d) {
        const text = d3.select(this).select('text');
        fitTextToCell(text, d.x1 - d.x0 - 16, d.y1 - d.y0 - (d.iconSize + 44)); // Account for icon size
    });

    console.log('Text adjusted to fit cell'); // Debug

    // Add after cell content creation
    nodes.filter(d => !d.data.isBookmark) // Only add close button to non-bookmarks
        .append('g')
        .attr('class', 'close-button')
        .style('cursor', 'pointer')
        .attr('transform', d => {
            const cellWidth = d.x1 - d.x0;
            return `translate(${cellWidth - 32}, 8)`;  // Position in top right
        })
        .html(() => `
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#cc0000" class="icon icon-tabler icons-tabler-filled icon-tabler-xbox-x">
                <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
                <path d="M12 2c5.523 0 10 4.477 10 10s-4.477 10 -10 10s-10 -4.477 -10 -10s4.477 -10 10 -10m3.6 5.2a1 1 0 0 0 -1.4 .2l-2.2 2.933l-2.2 -2.933a1 1 0 1 0 -1.6 1.2l2.55 3.4l-2.55 3.4a1 1 0 1 0 1.6 1.2l2.2 -2.933l2.2 2.933a1 1 0 0 0 1.6 -1.2l-2.55 -3.4l2.55 -3.4a1 1 0 0 0 -.2 -1.4"/>
            </svg>
        `)
        .on('click', async function(event, d) {
            event.stopPropagation();
            const tabId = parseInt(d.data.id.replace('tab', ''), 10);
            try {
                await chrome.tabs.remove(tabId);
                // Let the onRemoved handler deal with the UI update
                console.log('Tab removal requested:', tabId);
            } catch (error) {
                console.error('Error removing tab:', error);
            }
        });

    // Add after close button creation
    nodes.append('g')
        .attr('class', 'bookmark-button')
        .style('cursor', 'pointer')
        .attr('transform', d => {
            const cellWidth = d.x1 - d.x0;
            return `translate(8, 8)`; // Position in top left
        })
        .html(d => d.data.isBookmark ? `
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#FFD700" stroke="#FFD700" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-filled icon-tabler-star">
                <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
                <path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z" />
            </svg>
        ` : `
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-star">
                <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
                <path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z" />
            </svg>
        `)
        .on('click', function(event, d) {
            event.stopPropagation();
            // Check if URL is valid before attempting to bookmark
            if (!d.data.url) {
                console.warn('No URL to bookmark:', d.data);
                return;
            }
            
            try {
                chrome.bookmarks.create({
                    title: d.data.title || 'Untitled',
                    url: d.data.url
                }, (result) => {
                    if (chrome.runtime.lastError) {
                        console.error('Error creating bookmark:', chrome.runtime.lastError);
                        return;
                    }
                    // Update star to filled state
                    d3.select(this).select('svg')
                        .attr('fill', '#FFD700')
                        .attr('stroke', '#FFD700');
                });
            } catch (error) {
                console.error('Failed to create bookmark:', error);
            }
        });

    // In the node creation section, add event listeners
    nodes
        .on('dblclick', function(event, d) {
            event.stopPropagation();
            if (d.data.isBookmark) {
                // Handle bookmark double-click
                chrome.tabs.create({
                    url: d.data.url,
                    active: true
                });
            } else {
                // Handle regular tab double-click
                const windowId = parseInt(d.data.windowId, 10);
                const tabId = parseInt(d.data.id.replace('tab', ''), 10);
                chrome.windows.update(windowId, { focused: true }, () => {
                    chrome.tabs.update(tabId, { active: true });
                });
            }
        })
        .on('click', function(event, d) {
            // ... existing click handler ...
        });

    // Add debug logging
    console.log('Event listeners attached:', {
        nodes: nodes.size(),
        withDblClick: nodes.filter(function() {
            return d3.select(this).on('dblclick');
        }).size()
    });

    // Add background click handler to clear selection
    d3.select('#treemap').on('click', function(event) {
        if (event.target.tagName === 'svg' || event.target.id === 'treemap') {
            nodes.classed('cell-selected', false)
                .select('rect')
                .attr('fill', d => d.data.color)
                .attr('stroke', 'none');
            hideReadout();
        }
    });

    console.log('Treemap drawn'); // Debug

    // Add event handlers right after node creation
    nodes
        .on('mouseenter', function(event, d) {
            console.log('Node hover:', {
                data: d.data,
                id: d.data.id,
                title: d.data.title,
                url: d.data.url,
                fullNode: d
            });
            
            if (!interactionState.activeNode) {
                focusNode(this, d);
            }
        })
        .on('mouseleave', function(event, d) {
            if (!interactionState.activeNode && !interactionState.isKeyboardMode) {
                unfocusNode(this);
            }
        })
        .on('click', function(event, d) {
            event.stopPropagation();
            activateNode(this, d);
        })
        .on('dblclick', handleNodeDblClick)
        .on('focus', function(event, d) {
            interactionState.isKeyboardMode = true;
            focusNode(this, d);
        })
        .on('blur', function(event, d) {
            if (!interactionState.activeNode) {
                unfocusNode(this);
            }
        })
        .on('keydown', function(event, d) {
            handleKeyNavigation(event, this, d, interactionState);
        });

    // Store nodes for keyboard navigation
    interactionState.focusableNodes = nodes.nodes();
    
    // Debug logging
    console.log('Event handlers attached:', {
        nodes: nodes.size(),
        focusable: interactionState.focusableNodes.length
    });

    
}

// Helper function to format title
function formatTitle(title) {
    // If title has more than one underscore, split and join with spaces
    if ((title.match(/_/g) || []).length > 1) {
        return title.split('_').join(' ');
    }
    return title;
}

function fitTextToCell(textElement, cellWidth, cellHeight) {
    const words = textElement.text().split(' ');
    let lines = [];
    let line = [];
    const maxWordsPerLine = 4;
    const maxLines = 3;
    const lineHeight = 1.1; // ems
    const y = textElement.attr('y');
    const dy = 0;

    // Determine the number of lines based on the number of words
    for (let i = 0; i < words.length; i += maxWordsPerLine) {
        lines.push(words.slice(i, i + maxWordsPerLine).join(' '));
        if (lines.length === maxLines) {
            if (i + maxWordsPerLine < words.length) {
                lines[lines.length - 1] += '...';
            }
            break;
        }
    }

    textElement.text(null);
    lines.forEach((line, index) => {
        textElement.append('tspan')
            .attr('x', 0)
            .attr('dy', index * lineHeight + dy + 'em')
            .text(line);
    });

    // Adjust font size to fit the available cell space
    let fontSize = 12; // Start with a base font size
    textElement.attr('font-size', fontSize + 'px');

    while (textElement.node().getBBox().width < cellWidth && textElement.node().getBBox().height < cellHeight) {
        fontSize += 1;
        textElement.attr('font-size', fontSize + 'px');
    }

    // Reduce font size by 1 to fit within the cell
    textElement.attr('font-size', (fontSize - 1) + 'px');
}

// Add resize handler
window.onresize = () => {
    if (categorizedDataCache) {
        drawTreemap(categorizedDataCache);
    }
};

// Move listener setup to initialization
function initializeMessageHandling() {
    console.log('Setting up message handlers...');
    
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log('Treemap received message:', {
            action: message?.action,
            type: message?.type,
            tabId: message?.tabId,
            url: message?.tab?.url,
            changeInfo: message?.changeInfo
        });

        try {
            // Handle both action and type-based messages
            switch (message.action) {
                case 'tabUpdated':
                    handleTabUpdated(message);
                    break;
                case 'tabRemoved':
                    handleTabRemoved(message.tabId, message.removeInfo);
                    break;
                case 'windowRemoved':
                    handleWindowRemoved(message.windowId);
                    break;
                case 'tabCreated':
                    handleTabCreated(message.tab);
                    break;
                default:
                    if (message.type === 'navigation_event') {
                        handleTabUpdated({
                            tabId: sender.tab.id,
                            changeInfo: { url: message.data.targetUrl },
                            tab: {
                                id: sender.tab.id,
                                url: message.data.targetUrl,
                                windowId: sender.tab.windowId
                            }
                        });
                    }
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
        
        return true; // Important: keeps message port open for async response
    });
}

// Update the DOMContentLoaded handler to initialize message handling
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await initializeState();
        initializeMessageHandling();  // Add this line
        console.log('Treemap initialization complete');
    } catch (error) {
        console.error('Failed to initialize treemap:', error);
    }
});

// Update the handleTabUpdated function with better error handling
function handleTabUpdated(message) {
    const { tabId, changeInfo, tab } = message;
    
    console.log('Processing tab update:', {
        tabId,
        changeInfo,
        currentUrl: tab?.url,
        hasState: !!state.data,
        stateWindows: state.data?.activeWindows?.length
    });

    if (!state.data?.activeWindows) {
        console.warn('No state data available');
        return;
    }

    // Only process meaningful updates
    if (!changeInfo.url && !changeInfo.title && !changeInfo.favIconUrl) {
        console.log('Skipping non-content update');
        return;
    }

    let updated = false;
    state.data.activeWindows = state.data.activeWindows.map(window => {
        const updatedTabs = window.tabs.map(t => {
            if (t.id === tabId) {
                updated = true;
                const updatedTab = {
                    ...t,
                    title: tab.title || t.title,
                    url: changeInfo.url || tab.url || t.url,
                    favIconUrl: tab.favIconUrl || t.favIconUrl,
                    lastAccessed: Date.now()
                };
                console.log('Updating tab in window:', {
                    windowId: window.id,
                    tabId,
                    oldUrl: t.url,
                    newUrl: updatedTab.url
                });
                return updatedTab;
            }
            return t;
        });
        return { ...window, tabs: updatedTabs };
    });

    if (updated) {
        console.log('Redrawing treemap after URL change');
        drawTreemap(state.data);
    } else {
        console.warn('Tab not found in any window:', tabId);
    }
}

// Add a helper to log state changes
function logStateChange(action, details) {
    console.log('State update:', {
        action,
        windowCount: state.data?.activeWindows?.length,
        tabCount: state.getTotalTabs(),
        details
    });
}

// Update handleTabRemoved to be more robust
function handleTabRemoved(tabId, removeInfo) {
    console.log('Tab removed:', { tabId, removeInfo });

    if (!state.data?.activeWindows) {
        console.warn('No state data for tab removal');
        return;
    }

    // Remove the tab from each window's tabs array
    state.data.activeWindows = state.data.activeWindows.map(window => ({
        ...window,
        tabs: window.tabs.filter(t => t.id !== tabId)
    }));

    // Remove empty windows (except bookmark window)
    state.data.activeWindows = state.data.activeWindows.filter(window => 
        window.tabs.length > 0 || window.id === 'bookmark'
    );

    const totalTabs = state.getTotalTabs();
    console.log('After tab removal:', { totalTabs, windows: state.data.activeWindows });

    // Update bookmark state if needed
    if (state.needsBookmarks) {
        updateBookmarkState(totalTabs);
    } else {
        // Remove bookmark window if we have enough tabs
        state.data.activeWindows = state.data.activeWindows
            .filter(w => w.id !== 'bookmark');
    }

    // Remove from search index
    removeFromIndex(`tab${tabId}`);

    // Redraw immediately
    drawTreemap(state.data);
}

// Update handleTabCreated for better state management
function handleTabCreated(tab) {
    console.log('Tab created:', tab);

    if (!tab?.id) {
        console.warn('Invalid tab data:', tab);
        return;
    }

    if (!state.data?.activeWindows) {
        console.warn('State not initialized, deferring tab creation');
        initializeState().then(() => handleTabCreated(tab));
        return;
    }

    // Find or create window
    let targetWindow = state.data.activeWindows.find(w => w.id === tab.windowId);
    if (!targetWindow) {
        targetWindow = {
            id: tab.windowId,
            tabs: []
        };
        state.data.activeWindows.push(targetWindow);
    }

    // Add new tab with validated ID
    const newTab = {
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title || 'New Tab',
        url: tab.url || '',
        favIconUrl: tab.favIconUrl,
        lastAccessed: Date.now(),
        timeSpent: 100,
        children: []
    };

    targetWindow.tabs.push(newTab);

    // Add to search index with validated data
    indexNode(`tab${tab.id}`, newTab);

    console.log('Tab added to state:', {
        tabId: tab.id,
        windowId: tab.windowId,
        totalTabs: state.getTotalTabs()
    });

    // Update UI
    drawTreemap(state.data);
}

// Initialize state when page loads
document.addEventListener('DOMContentLoaded', initializeState);

function calculateCellIconSize(cellWidth, cellHeight, maxIconSize = 128, minIconSize = 16) {
    // Account for padding and text height
    const padding = 10;
    const textHeight = 40;
    
    // Calculate available space
    const availableWidth = cellWidth - (padding * 2);
    const availableHeight = cellHeight - (padding * 2) - textHeight;
    
    // Get the limiting dimension
    const maxPossibleSize = Math.min(availableWidth, availableHeight);
    
    // Constrain to our min/max bounds
    return Math.max(minIconSize, Math.min(maxPossibleSize, maxIconSize));
}

function updateTabOrder(searchResults) {
    if (!searchResults) {
        // Reset to default last-accessed order
        const sortedNodes = focusableNodes.sort((a, b) => {
            const aData = d3.select(a).datum();
            const bData = d3.select(b).datum();
            return b.data.lastAccessed - aData.data.lastAccessed;
        });
        currentTabOrder = sortedNodes.map(node => d3.select(node).datum().data.id);
    } else {
        // Set order based on search results
        currentTabOrder = searchResults.map(result => result.id);
    }

    // Update tabindex for all nodes
    d3.selectAll('#treemap g[role="button"]')
        .attr('tabindex', d => currentTabOrder.indexOf(d.data.id));
}

// Update the empty cells calculation
const calculateEmptyCells = (currentTabCount) => {
    const minimumCellCount = 4;
    // Only add bookmarks if we're under the minimum
    if (currentTabCount >= minimumCellCount) {
        return 0;
    }
    // Add exactly enough bookmarks to reach minimum
    return minimumCellCount - currentTabCount;
};

// Update the bookmark handling function
function updateBookmarkState(totalTabs) {
    // Prevent rapid updates
    if (updateState.isUpdating) {
        return;
    }

    const now = Date.now();
    if (now - updateState.lastUpdate < updateState.debounceTime) {
        return;
    }

    updateState.isUpdating = true;
    updateState.lastUpdate = now;

    try {
        if (totalTabs < 4) {
            const emptyCells = 4 - totalTabs;
            fetchRecentBookmarks().then(bookmarks => {
                const bookmarkWindow = state.data.activeWindows.find(w => w.id === 'bookmark');
                if (!bookmarkWindow) {
                    addBookmarkWindow(bookmarks.slice(0, emptyCells));
                } else if (bookmarkWindow.tabs.length !== emptyCells) {
                    // Only update if count changed
                    bookmarkWindow.tabs = bookmarks.slice(0, emptyCells).map(bookmark => ({
                        id: `bookmark${bookmark.id}`,
                        windowId: 'bookmark',
                        title: bookmark.title || 'Untitled',
                        url: bookmark.url || '',
                        favIconUrl: bookmark.favIconUrl,
                        lastAccessed: Date.now(),
                        timeSpent: 1,
                        isBookmark: true,
                        children: []
                    }));
                }
                drawTreemap(state.data);
            });
        } else {
            // Remove bookmark window if present
            const hadBookmarks = state.data.activeWindows.some(w => w.id === 'bookmark');
            if (hadBookmarks) {
                state.data.activeWindows = state.data.activeWindows.filter(w => w.id !== 'bookmark');
                drawTreemap(state.data);
            }
        }
    } finally {
        updateState.isUpdating = false;
    }
};

// Helper functions
function focusNode(node, data) {
    console.log('Focus node:', {
        nodeElement: node,
        data: data.data,
        title: data.data?.title,
        url: data.data?.url
    });
    
    // Clear previous focus
    if (interactionState.focusedNode) {
        unfocusNode(interactionState.focusedNode);
    }

    interactionState.focusedNode = node;
    d3.select(node)
        .classed('node-focused', true)
        .select('rect')
        .attr('stroke', data.data.isBookmark ? '#4CAF50' : '#2196F3')
        .attr('stroke-width', '2px');

    displayReadout(data.data); // Make sure we're passing the correct data structure
}

function unfocusNode(node) {
    if (!node) return;
    
    interactionState.focusedNode = null;
    d3.select(node)
        .classed('node-focused', false)
        .select('rect')
        .attr('stroke', d => d.data.isBookmark ? '#ddd' : 'none')
        .attr('stroke-width', '1px');

    if (!interactionState.activeNode) {
        hideReadout();
    }
}

function handleNodeDblClick(event, d) {
    event.stopPropagation();
    if (d.data.isBookmark) {
        chrome.tabs.create({ url: d.data.url, active: true });
    } else {
        const windowId = parseInt(d.data.windowId, 10);
        const tabId = parseInt(d.data.id.replace('tab', ''), 10);
        chrome.windows.update(windowId, { focused: true }, () => {
            chrome.tabs.update(tabId, { active: true });
        });
    }
}

// Add to the interaction helper functions section
function activateNode(node, data) {
    if (interactionState.activeNode === node) {
        // Deactivate if already active
        interactionState.activeNode = null;
        unfocusNode(node);
        return;
    }

    // Clear previous activation
    if (interactionState.activeNode) {
        unfocusNode(interactionState.activeNode);
    }

    interactionState.activeNode = node;
    d3.select(node)
        .classed('node-activated', true)
        .select('rect')
        .attr('stroke', '#4CAF50')
        .attr('stroke-width', '3px');

    // Update readout
    displayReadout(data);
}

// Add this helper function
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// Update the bookmark filling logic
async function fillEmptyCellsWithBookmarks(emptyCells) {
    const bookmarks = await fetchRecentBookmarks();
    const randomizedBookmarks = shuffleArray([...bookmarks]);
    
    console.log(`Filling ${emptyCells} empty cells with random bookmarks from ${bookmarks.length} total`);
    
    return {
        name: 'Window bookmark',
        id: 'bookmark',
        children: randomizedBookmarks.slice(0, emptyCells).map(bookmark => ({
            id: `bookmark${bookmark.id}`,
            windowId: 'bookmark',
            title: bookmark.title || 'Untitled',
            url: bookmark.url || '',
            favIconUrl: bookmark.favIconUrl,
            lastAccessed: Date.now(),
            timeSpent: 1,
            isBookmark: true,
            children: []
        }))
    };
}

function handleWindowRemoved(windowId) {
    console.log('Window removal detected:', {
        windowId,
        currentWindows: state.data?.activeWindows?.length,
        windowsList: state.data?.activeWindows?.map(w => w.id)
    });

    if (!state.data?.activeWindows) {
        console.warn('No state data for window removal');
        return;
    }

    // Remove the window
    state.data.activeWindows = state.data.activeWindows.filter(w => w.id !== windowId);

    console.log('After window removal:', {
        remainingWindows: state.data.activeWindows.length,
        windowsList: state.data.activeWindows.map(w => w.id)
    });

    // If we still have windows, update the treemap
    if (state.data.activeWindows.length > 0) {
        console.log('Updating treemap with remaining windows');
        drawTreemap(state.data);
    } else {
        // Clear treemap if no windows remain (but keep state)
        console.log('No remaining windows, clearing treemap');
        showEmptyState();
    }
}

function showEmptyState() {
    const container = document.getElementById('treemap');
    d3.select('#treemap').selectAll('*').remove();

    const svg = d3.select('#treemap')
        .append('svg')
        .attr('width', container.offsetWidth)
        .attr('height', window.innerHeight - 48);

    svg.append('text')
        .attr('x', container.offsetWidth / 2)
        .attr('y', (window.innerHeight - 48) / 2)
        .attr('text-anchor', 'middle')
        .attr('class', 'empty-state-text')
        .text('No open windows')
        .append('tspan')
        .attr('x', container.offsetWidth / 2)
        .attr('dy', '1.5em')
        .text('Open a new window to get started');
}
