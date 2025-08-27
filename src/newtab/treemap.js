/**
 * Treemap.js - Interactive D3 visualization of browser tabs and windows
 * 
 * This module provides a responsive treemap visualization of browser tabs and windows,
 * with support for drag-and-drop tab management, interactive searching, and
 * detailed readout panels. The treemap visualizes tabs grouped by window, with
 * sizing based on tab usage and color-coding for recency.
 * 
 * Architecture Overview:
 * - Uses D3.js for visualization and interaction
 * - Maintains local state as a cache of browser data
 * - Communicates with background service worker via Chrome messaging
 * - Implements drag & drop for moving tabs between windows
 * - Provides keyboard navigation and accessibility features
 * - Integrates with readout panel for detailed tab information
 * 
 * State Management:
 * - treemapState: Core visualization data including windows and tabs
 * - interactionState: Tracks user focus, selection, and keyboard navigation
 * - updateState: Controls rendering timing and debounce logic
 * 
 * @module treemap
 * @requires d3
 * @requires utility
 * @requires readout
 * @requires keyboardNav
 * @requires init
 * @requires state
 */

import { getFaviconUrl, formatDistanceToNow, formatSessionDuration } from './utility.js';
import { displayReadout, hideReadout } from './readout.js';
import { handleKeyNavigation } from './keyboardNav.js';
import { fetchRecentBookmarks, fetchRecentHistory } from './init.js';
import { browserState } from './state.js';
import { applyColorCoding } from './utility.js';

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
const treemapState = {
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

// Add drag-and-drop functionality to the treemap view

// Add these variables at the top of your file to track drag state
let isDragging = false;
let dragTab = null;
let dragElement = null;
let dropTarget = null;
let dragGhost = null;

// Add this variable at the top of your file with other state variables
let lastValidTargetTime = 0;

// Initialize state from background
async function initializeState() {
    try {
        const initialState = await chrome.runtime.sendMessage({ type: 'getInitialState' });
        
        // More robust validation with better error handling
        if (!initialState) {
            console.warn('No initial state received from background script');
            showEmptyState();
            return;
        }
        
        if (!initialState.activeWindows || !Array.isArray(initialState.activeWindows)) {
            console.warn('Invalid initial state - missing or invalid activeWindows:', {
                hasState: !!initialState,
                hasActiveWindows: !!initialState.activeWindows,
                isArray: Array.isArray(initialState.activeWindows),
                type: typeof initialState.activeWindows,
                keys: Object.keys(initialState || {})
            });
            
            // Try to fix the state structure if possible
            if (initialState && typeof initialState === 'object') {
                // Check if activeWindows is nested elsewhere
                if (initialState.data?.activeWindows) {
                    console.log('Found activeWindows in nested data structure');
                    initialState.activeWindows = initialState.data.activeWindows;
                } else {
                    // Create empty state structure
                    console.log('Creating empty activeWindows structure');
                    initialState.activeWindows = [];
                }
            } else {
                showEmptyState();
                return;
            }
        }

        treemapState.data = initialState;
        console.log('State initialized:', {
            windows: treemapState.data.activeWindows.length,
            totalTabs: treemapState.getTotalTabs(),
            windowsList: treemapState.data.activeWindows.map(w => w.id)
        });

        // Draw initial treemap if we have windows
        if (treemapState.hasWindows()) {
            await drawTreemap(treemapState.data);
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

// Add a default color scale
const defaultColor = d3.scaleOrdinal(d3.schemeCategory10);

// Add a color safety function
function getSafeColor(d) {
    try {
        // If d has a color property, use it
        if (d.data && d.data.color) {
            return d3.color(d.data.color) || defaultColor(d.data.id);
        }
        // Otherwise use the default color scale
        return defaultColor(d.data ? d.data.id : d.id || 0);
    } catch (error) {
        console.warn('Error getting color for node:', d);
        return d3.color(defaultColor(0)); // Ensure we return a valid color object
    }
}

// Add a helper function to safely get darker color
function getDarkerColor(d, amount = 0.5) {
    try {
        const baseColor = getSafeColor(d);
        return baseColor ? baseColor.darker(amount) : d3.color(defaultColor(0)).darker(amount);
    } catch (error) {
        console.warn('Error getting darker color:', error);
        return d3.color(defaultColor(0)).darker(amount);
    }
}

/**
 * Draw treemap visualization based on provided data
 * 
 * Creates a hierarchical treemap visualization of browser windows and tabs
 * using D3.js. Handles adaptive sizing, color coding, and interaction setup.
 * 
 * Features:
 * - Window grouping with hierarchical structure
 * - Favicon loading with fallbacks
 * - Tab and window color-coding by activity and recency
 * - Automatic bookmark insertion for empty spaces
 * - Drag and drop between windows
 * - Interactive node selection
 * 
 * @param {Object} data - Browser state data with activeWindows array
 * @returns {Promise<void>} - Resolves when treemap is fully rendered
 */
export async function drawTreemap(data) {
    // Enhanced data validation
    if (!data) {
        console.warn('No data provided to drawTreemap');
        showEmptyState();
        return;
    }
    
    if (!data.activeWindows) {
        console.warn('No activeWindows in treemap data:', {
            hasData: !!data,
            dataKeys: Object.keys(data || {}),
            activeWindowsType: typeof data.activeWindows
        });
        showEmptyState();
        return;
    }
    
    if (!Array.isArray(data.activeWindows)) {
        console.warn('activeWindows is not an array:', {
            type: typeof data.activeWindows,
            value: data.activeWindows
        });
        showEmptyState();
        return;
    }
    
    if (data.activeWindows.length === 0) {
        console.log('No active windows available');
        showEmptyState();
        return;
    }

    console.log('Drawing treemap with:', {
        data: data,
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

    // Calculate color scale for each window
    hierarchyData.children.forEach(windowNode => {
        const tabs = windowNode.children;
        const maxLastAccessed = d3.max(tabs, d => d.lastAccessed);
        const minLastAccessed = d3.min(tabs, d => d.lastAccessed);

        console.log(`Window ${windowNode.name} - Min: ${minLastAccessed}, Max: ${maxLastAccessed}`); // Debugging

        const windowId = windowNode.name.includes('bookmark') ? 'bookmark' : 
            parseInt(windowNode.name.replace('Window ', ''), 10);

        const baseColor = d3.color(lightColors[windowId % lightColors.length]);
 

        const colorScale = d3.scaleLinear()
            .domain([minLastAccessed, maxLastAccessed])
            .range([baseColor.darker(0.5), baseColor.brighter(0.2)]);

        tabs.forEach(tab => {
            // Check both the tab's isBookmark property AND if it belongs to the bookmark window
            tab.color = (tab.isBookmark || windowNode.name === 'Window bookmark' || windowId === 'bookmark') 
                ? '#e8f4f8'  // Light blue for bookmarks (more distinct than light gray)
                : colorScale(tab.lastAccessed);
        });
    });

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

    // Apply colors to nodes
    const nodes = svg.selectAll('.cell')
        .data(root.leaves())
        .enter()
        .append('g')
        .attr('class', d => {
            // Use the same comprehensive check for bookmarks as the color assignment
            const isBookmark = d.data.isBookmark || 
                              (d.parent && d.parent.data.name === 'Window bookmark') || 
                              (d.parent && d.parent.data.id === 'bookmark');
            return isBookmark ? 'cell bookmark-cell' : 'cell';
        })
        .attr('transform', d => `translate(${d.x0},${d.y0})`)
        .style('cursor', 'pointer')
        .attr('tabindex', d => currentTabOrder.indexOf(d.data.id))
        .attr('role', 'button')
        .attr('aria-label', d => d.data.title)
        // Add these two data attributes for drag and drop
        .attr('data-tabid', d => d.data.id)
        .attr('data-windowid', d => d.data.windowId)
        .attr('data-window-id', d => d.data.windowId); // Add this additional attribute

    nodes.append('rect')
        .attr('id', d => d.data.id)
        .attr('width', d => d.x1 - d.x0)
        .attr('height', d => d.y1 - d.y0)
        .attr('fill', d => {
            const isBookmark = d.data.isBookmark || 
                             (d.parent && d.parent.data.name === 'Window bookmark') || 
                             (d.parent && d.parent.data.id === 'bookmark');
            return isBookmark ? '#e8f4f8' : getSafeColor(d);
        })
        .attr('opacity', d => {
            const isBookmark = d.data.isBookmark || 
                             (d.parent && d.parent.data.name === 'Window bookmark') || 
                             (d.parent && d.parent.data.id === 'bookmark');
            return isBookmark ? 0.9 : 1;
        })
        .attr('stroke', d => {
            const isBookmark = d.data.isBookmark || 
                             (d.parent && d.parent.data.name === 'Window bookmark') || 
                             (d.parent && d.parent.data.id === 'bookmark');
            return isBookmark ? '#99c2d7' : getDarkerColor(d, 0.2);
        })
        .attr('stroke-width', 1);

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
            if (!d.data?.url) {
                return createPlaceholderFavicon('?');
            }

            // Handle special URLs that can't use chrome://favicon
            if (d.data.url.startsWith('chrome://') || 
                d.data.url.startsWith('chrome-extension://') || 
                d.data.url.startsWith('file://') || 
                d.data.url.startsWith('about:')) {
                
                // Use letter favicon immediately for special URLs
                return createLetterFaviconForURL(d.data.url);
            }
            
            // Return existing favicon if available
            if (d.data.favIconUrl && !d.data.favIconUrl.includes('chrome://favicon')) {
                return d.data.favIconUrl;
            }
            
            // Otherwise generate a letter favicon
            return createLetterFaviconForURL(d.data.url);
        })
        .attr('width', d => d.iconSize)
        .attr('height', d => d.iconSize)
        .attr('x', d => -d.iconSize/2)
        .attr('y', d => -d.iconSize/2)
        .on('error', function(event, d) {
            // On error, set to letter favicon based on URL
            d3.select(this).attr('xlink:href', 
                d.data?.url ? createLetterFaviconForURL(d.data.url) : createPlaceholderFavicon('?'));
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
                console.log('Tab removal requested:', tabId, event);
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
        .on('click', handleNodeClick);

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

    // Call initDragDrop after the treemap is initialized
    setTimeout(initDragDrop, 500); // Initialize drag after treemap is fully rendered

    // Add this to the end of the function
    setTimeout(() => {
        // Focus moved tab if needed
        focusMovedTabAfterReload();
    }, 500); // Short delay to ensure nodes are fully rendered
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
    setTimeout(initDragDrop, 500); 
}



// Move listener setup to initialization
function initializeMessageHandling() {
    chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
        // Check for URL bar navigation specifically
        if (message.action === 'tabUpdated' && 
            message.changeInfo?.navigationType === 'urlBarNavigation') {
            
            console.log('URL bar navigation detected - updating treemap');
            
            // For URL bar navigation, we want to ensure we have the latest data
            chrome.runtime.sendMessage({ type: 'getInitialState' }, async (freshState) => {
                treemapState.data = freshState;
                await drawTreemap(treemapState.data);
            });
            
            return true;
        }
        
        // Handle other message types as before...
        console.log('Treemap received message:', {
            type: message?.type,
            action: message?.action,
            hasData: !!message?.data,
            linkText: message?.data?.text || 'No text'
        });

        // Handle navigation_event specifically to capture link text
        if (message.type === 'navigation_event' && message.data) {
            console.log('Link navigation detected with text:', message.data.text);
            
            // Store the clicked link text data in our state to preserve it
            if (!treemapState.linkTextCache) {
                treemapState.linkTextCache = {};
            }
            
            // Cache the link text by URL so we can use it later
            treemapState.linkTextCache[message.data.targetUrl] = {
                text: message.data.text,
                timestamp: message.data.timestamp
            };
            
            // Use the data for immediate update
            const updateData = {
                tabId: sender.tab.id,
                changeInfo: { 
                    url: message.data.targetUrl,
                    linkText: message.data.text, // Add this for the handler to use
                    navigationType: 'linkClick'
                },
                tab: {
                    id: sender.tab.id,
                    url: message.data.targetUrl,
                    windowId: sender.tab.windowId,
                    // Use link text as initial title until page loads
                    title: message.data.text || 'Loading...',
                    lastAccessed: Date.now()
                }
            };
            
            // Update treemap immediately
            await handleTabUpdated(updateData);
            return true;
        }
        
        // Handle other message types...
        return true;
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

// Update the handleTabUpdated function with proper change detection
async function handleTabUpdated(message) {
    const { tabId, changeInfo, tab } = message;
    
    console.log('Processing tab update:', {
        tabId,
        changeInfo,
        currentUrl: tab?.url,
        hasState: !!treemapState.data,
        stateWindows: treemapState.data?.activeWindows?.length
    });

    if (!treemapState.data?.activeWindows) {
        console.warn('No state data available');
        return;
    }

    // Only process meaningful updates
    if (!changeInfo.url && !changeInfo.title && !changeInfo.favIconUrl) {
        console.log('Skipping non-content update');
        return;
    }

    let updated = false;
    let hasContentChange = false; // Track actual content changes

    treemapState.data.activeWindows = treemapState.data.activeWindows.map(window => {
        const updatedTabs = window.tabs.map(t => {
            if (t.id === tabId) {
                // Determine the best title to use
                let bestTitle = null;
                
                // If this is a link click with text, prefer that
                if (changeInfo.linkText) {
                    bestTitle = changeInfo.linkText;
                }
                // Otherwise try the tab title
                else if (tab.title && tab.title !== 'New Tab') {
                    bestTitle = tab.title;
                }
                // If we have cached link text for this URL, use that
                else if (treemapState.linkTextCache && 
                         treemapState.linkTextCache[tab.url || changeInfo.url]) {
                    bestTitle = treemapState.linkTextCache[tab.url || changeInfo.url].text;
                }
                // Fall back to the existing title
                else {
                    bestTitle = tab.title || t.title;
                }
                
                // Check if anything actually changed
                const urlChanged = (changeInfo.url && changeInfo.url !== t.url);
                const titleChanged = (bestTitle && bestTitle !== t.title);
                const faviconChanged = (tab.favIconUrl && tab.favIconUrl !== t.favIconUrl);
                
                // Only mark as having content change if something meaningful changed
                hasContentChange = urlChanged || titleChanged || faviconChanged;
                
                if (hasContentChange) {
                    console.log('Content changed:', {
                        urlChanged,
                        titleChanged,
                        faviconChanged,
                        oldTitle: t.title,
                        newTitle: bestTitle
                    });
                    
                    updated = true;
                    const updatedTab = {
                        ...t,
                        title: bestTitle,
                        url: changeInfo.url || tab.url || t.url,
                        favIconUrl: tab.favIconUrl || t.favIconUrl,
                        lastAccessed: hasContentChange ? Date.now() : t.lastAccessed // Only update timestamp if something changed
                    };
                    
                    console.log('Updating tab in window:', {
                        windowId: window.id,
                        tabId,
                        oldUrl: t.url,
                        newUrl: updatedTab.url
                    });
                    return updatedTab;
                }
                
                // If nothing changed, return the tab as-is
                return t;
            }
            return t;
        });
        return { ...window, tabs: updatedTabs };
    });

    if (updated && hasContentChange) {
        console.log('Redrawing treemap after content change');
        
        // Use debouncing to prevent multiple redraws in quick succession
        clearTimeout(updateState.debounceTimer);
        updateState.debounceTimer = setTimeout(async () => {
            await drawTreemap(treemapState.data);
        }, 300); // Wait 300ms before redrawing
    } else if (updated) {
        console.log('Tab updated but no visual content change, skipping redraw');
    } else {
        console.warn('Tab not found in any window:', tabId);
    }
}

// Add a helper to log state changes
function logStateChange(action, details) {
    console.log('State update:', {
        action,
        windowCount: treemapState.data?.activeWindows?.length,
        tabCount: treemapState.getTotalTabs(),
        details
    });
}

// Update handleTabRemoved to be more robust
async function handleTabRemoved(tabId, removeInfo) {
    console.log('Tab removed:', { tabId, removeInfo });

    if (!treemapState.data?.activeWindows) {
        console.warn('No state data for tab removal');
        return;
    }

    // Remove the tab from each window's tabs array
    treemapState.data.activeWindows = treemapState.data.activeWindows.map(window => ({
        ...window,
        tabs: window.tabs.filter(t => t.id !== tabId)
    }));

    // Remove empty windows (except bookmark window)
    treemapState.data.activeWindows = treemapState.data.activeWindows.filter(window => 
        window.tabs.length > 0 || window.id === 'bookmark'
    );

    const totalTabs = treemapState.getTotalTabs();
    console.log('After tab removal:', { totalTabs, windows: treemapState.data.activeWindows });

    // Update bookmark state if needed
    if (treemapState.needsBookmarks) {
        updateBookmarkState(totalTabs);
    } else {
        // Remove bookmark window if we have enough tabs
        treemapState.data.activeWindows = treemapState.data.activeWindows
            .filter(w => w.id !== 'bookmark');
    }

    // Remove from search index
    removeFromIndex(`tab${tabId}`);

    // Redraw immediately
    await drawTreemap(treemapState.data); // Ensure this is awaited
}

// Update handleTabCreated for better state management
async function handleTabCreated(tab) {
    console.log('Tab created:', tab);

    if (!tab?.id) {
        console.warn('Invalid tab data:', tab);
        return;
    }

    if (!treemapState.data?.activeWindows) {
        console.warn('State not initialized, deferring tab creation');
        initializeState().then(() => handleTabCreated(tab));
        return;
    }

    // Find or create window
    let targetWindow = treemapState.data.activeWindows.find(w => w.id === tab.windowId);
    if (!targetWindow) {
        targetWindow = {
            id: tab.windowId,
            tabs: []
        };
        treemapState.data.activeWindows.push(targetWindow);
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
        totalTabs: treemapState.getTotalTabs()
    });

    // Update UI
    await drawTreemap(treemapState.data); // Ensure this is awaited
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
async function updateBookmarkState(totalTabs) {
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
            const bookmarks = await fetchRecentBookmarks();
            const bookmarkWindow = treemapState.data.activeWindows.find(w => w.id === 'bookmark');
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
            await drawTreemap(treemapState.data);
        } else {
            // Remove bookmark window if present
            const hadBookmarks = treemapState.data.activeWindows.some(w => w.id === 'bookmark');
            if (hadBookmarks) {
                treemapState.data.activeWindows = treemapState.data.activeWindows.filter(w => w.id !== 'bookmark');
                await drawTreemap(treemapState.data);
            }
        }
    } finally {
        updateState.isUpdating = false;
    }
}


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
    console.log('passing to readout', data.data)
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
    console.log("passing to readout", data)
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

async function handleWindowRemoved(windowId) {
    console.log('Window removal detected:', {
        windowId,
        currentWindows: treemapState.data?.activeWindows?.length,
        windowsList: treemapState.data?.activeWindows?.map(w => w.id)
    });

    if (!treemapState.data?.activeWindows) {
        console.warn('No state data for window removal');
        return;
    }

    // Remove the window
    treemapState.data.activeWindows = treemapState.data.activeWindows.filter(w => w.id !== windowId);

    console.log('After window removal:', {
        remainingWindows: treemapState.data.activeWindows.length,
        windowsList: treemapState.data.activeWindows.map(w => w.id)
    });

    // If we still have windows, update the treemap
    if (treemapState.data.activeWindows.length > 0) {
        console.log('Updating treemap with remaining windows');
        await drawTreemap(treemapState.data);
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

// Update your initialization
async function initializeTreemap() {
    // Get initial data
    const treeData = await browserState.getTreemapData();
    
    // Draw initial treemap
    await drawTreemap(treeData);
    
    // Subscribe to changes
    browserState.subscribe(async (update) => {
      console.log('State update received:', update);
      
      // Request fresh data and update the visualization
      const freshData = await browserState.getTreemapData();
      await drawTreemap(freshData);
    });
  }

// Fix click handler for readout display
function handleNodeClick(event, d) {
    // Make sure we extract data correctly and pass both parameters
    const nodeData = d?.data || d || d3.select(event.currentTarget).datum()?.data;
    
    if (nodeData) {
        // Fetch bookmarks and history items
        Promise.all([
            fetchRecentBookmarks(5),
            fetchRecentHistory(5)
        ]).then(([bookmarks, history]) => {
            // Pass both the data and the fetched bookmarks and history
            console.log("Passing to displayReadout", nodeData, bookmarks, history);
            displayReadout(nodeData, bookmarks, history);
            
            // Open the URL if it's a real tab
            if (nodeData.url && !nodeData.isBookmark) {
                chrome.tabs.update(nodeData.id, { active: true });
                chrome.windows.update(nodeData.windowId, { focused: true });
            }
        }).catch(error => {
            console.error('Error fetching bookmarks or history:', error);
        });
    }
}

// Improved drag implementation that works with your specific treemap structure

// Track drag state
let draggedTab = null;

/**
 * Initialize drag and drop functionality for the treemap
 * 
 * Sets up D3 drag behavior on tab cells to enable moving tabs between windows
 * by dragging. Configures drag start, drag, and drag end handlers and identifies
 * valid drop targets.
 * 
 * Key interactions:
 * - Drag start: Highlights dragged tab and potential drop targets
 * - Dragging: Shows drag ghost and updates drop target highlighting
 * - Drop: Moves tab to target window via Chrome API and refreshes visualization
 * 
 * @param {Event} event - D3 drag event
 * @param {Object} d - Tab data object
 * @param {HTMLElement} node - DOM element being dragged
 */
function initDragDrop() {
    let longPressTimer;
    let isDragging = false;
    let dragNode = null;

    const drag = d3.drag()
        .on('start', function(event, d) {
            // Clear any existing timer
            if (longPressTimer) {
                clearTimeout(longPressTimer);
            }
            
            // Set up long press timer
            longPressTimer = setTimeout(() => {
                if (!isDragging) {
                    isDragging = true;
                    dragNode = this;
                    dragStarted(event, d, this);
                }
            }, 750); // 750ms delay for long press
        })
        .on('drag', function(event, d) {
            // If drag movement happens before long press timer, cancel the timer
            if (!isDragging) {
                if (longPressTimer) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
                return;
            }
            
            if (isDragging && dragNode === this) {
                dragging(event, d, this);
            }
        })
        .on('end', function(event, d) {
            // Clear the timer if it exists
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            
            if (isDragging && dragNode === this) {
                dragEnded(event, d, this);
                isDragging = false;
                dragNode = null;
            }
        });

    // Apply drag behavior to all cells
    d3.selectAll('.cell').call(drag);
}

// Keep the original working dragStarted function
/**
 * Handle start of drag operation
 * 
 * Creates visual feedback for drag start and identifies the tab being dragged.
 * Sets up ghost element to follow cursor and highlights potential drop targets.
 * 
 * @param {Event} event - D3 drag event
 * @param {Object} d - Tab data object
 * @param {HTMLElement} node - DOM element being dragged
 */
function dragStarted(event, d, node) {
  console.log("Drag started for:", d);
  
  // Extract tab ID and window ID
  let tabId = null;
  if (d && d.data && d.data.id) {
    tabId = parseInt(d.data.id.toString().replace('tab', ''));
  }
  
  const windowId = d && d.data ? d.data.windowId : null;
  
  if (!tabId || !windowId) {
    console.log("Missing tab or window ID, can't start drag");
    return;
  }
  
  // Store the dragged tab info
  draggedTab = {
    id: tabId,
    windowId: windowId,
    element: node,
    data: d
  };
  
  // Highlight the dragged element
  d3.select(node).classed('being-dragged', true);
  
  // Create drag ghost
  const ghost = document.createElement('div');
  ghost.className = 'dragging-tab';
  ghost.textContent = 'Moving: ' + (d.data.title || ('Tab ' + tabId));
  ghost.style.position = 'fixed';
  ghost.style.left = event.sourceEvent.clientX + 'px';
  ghost.style.top = event.sourceEvent.clientY + 'px';
  ghost.style.zIndex = 10000;
  ghost.style.pointerEvents = 'none';
  document.body.appendChild(ghost);
  
  draggedTab.ghost = ghost;
  
  // Highlight potential drop targets (other windows)
  d3.selectAll('.window-group')
    .each(function() {
      const targetWindowId = parseInt(this.getAttribute('data-window-id'));
      if (targetWindowId && targetWindowId !== windowId) {
        d3.select(this).classed('valid-drop-target', true);
      }
    });
    
  console.log("Drag started successfully");
}

// Improved dragging function with better tab cell detection

// Add a variable to track the last valid drop target
let lastValidTarget = null;

/**
 * Handle drag movement
 * 
 * Updates ghost element position and detects potential drop targets under cursor.
 * Implements "sticky" target detection with timeout to improve usability.
 * 
 * @param {Event} event - D3 drag event
 * @param {Object} d - Tab data object
 * @param {HTMLElement} node - DOM element being dragged
 */
function dragging(event, d, node) {
  if (!draggedTab || !draggedTab.ghost) return;
  
  // Update ghost position
  draggedTab.ghost.style.left = (event.sourceEvent.clientX + 10) + 'px';
  draggedTab.ghost.style.top = (event.sourceEvent.clientY + 10) + 'px';
  
  // Find what's under the cursor
  const elemBelow = document.elementFromPoint(
    event.sourceEvent.clientX,
    event.sourceEvent.clientY
  );
  
  if (!elemBelow) return;
  
  // First check if we're directly over a cell with data-window-id
  let targetWindowId = null;
  let current = elemBelow;
  
  // Look up the DOM, increasing the search depth to find cell containers
  let searchDepth = 0;
  while (current && current !== document.body && !targetWindowId && searchDepth < 6) {
    searchDepth++;
    
    // Check for direct data-window-id attribute first
    if (current.hasAttribute && current.hasAttribute('data-window-id')) {
      targetWindowId = parseInt(current.getAttribute('data-window-id'), 10);
      console.log(`Found target directly with data-window-id: ${targetWindowId}`);
      break;
    }
    
    // Also check for data-windowid attribute for compatibility
    if (current.hasAttribute && current.hasAttribute('data-windowid')) {
      targetWindowId = parseInt(current.getAttribute('data-windowid'), 10);
      console.log(`Found target with data-windowid: ${targetWindowId}`);
      break;
    }
    
    // Check if this is a cell with D3 data - use D3's data to get windowId
    if (current.classList && current.classList.contains('cell')) {
      const cellData = d3.select(current).datum();
      if (cellData && cellData.data && cellData.data.windowId) {
        targetWindowId = parseInt(cellData.data.windowId, 10);
        console.log(`Found target from cell D3 data: ${targetWindowId}`);
        break;
      }
    }
    
    current = current.parentElement;
  }
  
  // Reset highlights
  d3.selectAll('.window-group').classed('drop-target-active', false);
  
  // If we found a window ID and it's different from source
  if (targetWindowId && targetWindowId !== draggedTab.windowId) {
    // Find the window group element
    const windowGroup = d3.select(`.window-group[data-window-id="${targetWindowId}"]`).node();
    
    if (windowGroup) {
      // Highlight as drop target
      d3.select(windowGroup).classed('drop-target-active', true);
      
      // Store as drop target
      draggedTab.dropTarget = {
        element: windowGroup,
        windowId: targetWindowId
      };
      
      // IMPORTANT: Also store in our independent tracker
      lastValidTarget = {
        element: windowGroup,
        windowId: targetWindowId,
        timestamp: Date.now()
      };
      
      console.log(`Valid drop target: Window ${targetWindowId}`);
    }
  } else {
    // Make the sticky target behavior MORE sticky - increase duration to 800ms
    const timeSinceValidTarget = Date.now() - (lastValidTarget?.timestamp || 0);
    const stickyDuration = 800; // Increased stickiness
    
    if (timeSinceValidTarget > stickyDuration || !lastValidTarget) {
      draggedTab.dropTarget = null;
    } else {
      // Use the last valid target
      draggedTab.dropTarget = {
        element: lastValidTarget.element,
        windowId: lastValidTarget.windowId
      };
      
      if (lastValidTarget.element) {
        d3.select(lastValidTarget.element).classed('drop-target-active', true);
        console.log(`Using sticky target: Window ${lastValidTarget.windowId}`);
      }
    }
  }
}

// Fix the dragEnded function to properly convert windowId to integer
// Update dragEnded to always check lastValidTarget as a fallback
/**
 * Handle end of drag operation
 * 
 * Determines final drop target and initiates tab move if valid.
 * Handles fallback from stored targets and cleans up visual elements.
 * 
 * @param {Event} event - D3 drag event
 * @param {Object} d - Tab data object
 * @param {HTMLElement} node - DOM element being dragged
 */
function dragEnded(event, d, node) {
    if (!draggedTab) return;
    
    // First try to detect the window directly under the cursor at release
    let finalTargetWindowId = null;
    
    // Get the element under the cursor when the drag ended
    const elemBelow = document.elementFromPoint(
        event.sourceEvent.clientX,
        event.sourceEvent.clientY
    );
    
    if (elemBelow) {
        // Look up from the release point to find a window ID
        let current = elemBelow;
        let searchDepth = 0;
        
        while (current && current !== document.body && !finalTargetWindowId && searchDepth < 6) {
            searchDepth++;
            
            // Check data-window-id attribute first
            if (current.hasAttribute && current.hasAttribute('data-window-id')) {
                finalTargetWindowId = parseInt(current.getAttribute('data-window-id'), 10);
                console.log(`Final drop directly found window ID: ${finalTargetWindowId}`);
                break;
            }
            
            // Also check data-windowid
            if (current.hasAttribute && current.hasAttribute('data-windowid')) {
                finalTargetWindowId = parseInt(current.getAttribute('data-windowid'), 10);
                console.log(`Final drop found windowid: ${finalTargetWindowId}`);
                break;
            }
            
            current = current.parentElement;
        }
    }
    
    // If we didn't find anything directly, use the last stored dropTarget
    if (!finalTargetWindowId && draggedTab.dropTarget && draggedTab.dropTarget.windowId) {
        finalTargetWindowId = parseInt(draggedTab.dropTarget.windowId, 10);
        console.log(`Using stored dropTarget window ID: ${finalTargetWindowId}`);
    }
    
    // If still nothing, try lastValidTarget as final fallback
    if (!finalTargetWindowId && lastValidTarget && lastValidTarget.windowId) {
        const timeSinceLastValid = Date.now() - (lastValidTarget.timestamp || 0);
        if (timeSinceLastValid < 1000) { // Only use if recent (within last second)
            finalTargetWindowId = parseInt(lastValidTarget.windowId, 10);
            console.log(`Using lastValidTarget as fallback: ${finalTargetWindowId}`);
        }
    }
    
    // Log the final decision
    console.log(`Final drop decision - Source: ${draggedTab.windowId}, Target: ${finalTargetWindowId}`);
    
    // Only proceed if we have a valid target different from source
    if (finalTargetWindowId && finalTargetWindowId !== draggedTab.windowId) {
        const tabId = draggedTab.id;
        
        console.log(`Moving tab ${tabId} to window ${finalTargetWindowId}`);
        
        chrome.tabs.move(tabId, { windowId: finalTargetWindowId, index: -1 }, function(movedTab) {
            if (chrome.runtime.lastError) {
                console.error('Move failed:', chrome.runtime.lastError);
                showNotification('Failed to move tab: ' + chrome.runtime.lastError.message, 'error');
                return;
            }
            
            console.log('Tab moved successfully:', movedTab);
            showNotification('Tab moved successfully', 'success');
            
            // Store the moved tab ID in sessionStorage to focus after reload
            sessionStorage.setItem('focusTabAfterMove', tabId.toString());
            
            // Reload the page after a short delay to update the visualization
            setTimeout(() => {
                window.location.reload();
            }, 500);
        });
    } else {
        console.log('No valid drop target found or source and target window are the same');
    }
    
    // Clean up
    d3.select(draggedTab.element).classed('being-dragged', false);
    d3.selectAll('.window-group')
        .classed('valid-drop-target', false)
        .classed('drop-target-active', false);
    
    if (draggedTab.ghost) {
        draggedTab.ghost.remove();
    }
    
    // Reset state variables
    draggedTab = null;
    lastValidTarget = null;
}

// Add message listener to update treemap when tabs are moved

// Add this function at the top of your file
function setupTabMoveListener() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Listen for tab movement notifications
    if (message.action === 'tabMoved') {
      console.log('Tab move detected in UI:', message);
      
      // Refresh the data and redraw the treemap
      refreshTreemapAfterTabMove(message.tabId, message.tab.windowId);
    }
  });
  
  console.log("Tab move listener initialized");
}

// Call this during initialization
setupTabMoveListener();



// Replace or update your existing fetchDataAndBuildTreemap function
function fetchDataAndBuildTreemap() {
  console.log("Fetching fresh data for treemap");
  
  // Get fresh data from background page
  chrome.runtime.sendMessage({ action: 'getTreemapData' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error fetching treemap data:', chrome.runtime.lastError);
      return;
    }
    
    console.log("Received fresh treemap data:", response);
    
    // Draw treemap with new data
    if (response && response.data) {
      drawTreemap(response.data);
    }
  });
}

// Update your moveTabToWindow function to handle the update better
function moveTabToWindow(tabId, windowId) {
  console.log(`Moving tab ${tabId} to window ${windowId}`);
  
  chrome.tabs.move(tabId, { windowId, index: -1 })
    .then(tab => {
      console.log('Tab moved successfully:', tab);
      showNotification('Tab moved successfully', 'success');
      
      // No need to manually refresh - the event listener will handle it
    })
    .catch(error => {
      console.error('Error moving tab:', error);
      showNotification('Failed to move tab: ' + error.message, 'error');
    });
}

function refreshTreemapAfterTabMove(tabId, newWindowId) {
  console.log(`Refreshing treemap after moving tab ${tabId} to window ${newWindowId}`);
  
  // Show loading indicator
  const loadingIndicator = document.createElement('div');
  loadingIndicator.className = 'loading-indicator';
  loadingIndicator.innerHTML = 'Updating visualization...';
  loadingIndicator.style.position = 'fixed';
  loadingIndicator.style.top = '10px';
  loadingIndicator.style.left = '50%';
  loadingIndicator.style.transform = 'translateX(-50%)';
  loadingIndicator.style.background = 'rgba(0, 0, 0, 0.7)';
  loadingIndicator.style.color = 'white';
  loadingIndicator.style.padding = '10px 20px';
  loadingIndicator.style.borderRadius = '4px';
  loadingIndicator.style.zIndex = '9999';
  document.body.appendChild(loadingIndicator);
  
  // Wait a bit and then reload the page to get fresh data
  setTimeout(() => {
    window.location.reload();
  }, 300);
  
  // This will never execute due to reload, but keeping for future reference
  setTimeout(() => {
    if (loadingIndicator.parentNode) {
      loadingIndicator.parentNode.removeChild(loadingIndicator);
    }
  }, 2000);
}

// Add a function to focus on a specific tab after reload
function focusMovedTabAfterReload() {
  const tabIdToFocus = sessionStorage.getItem('focusTabAfterMove');
  
  if (!tabIdToFocus) return; // Nothing to focus
  
  console.log(`Looking for tab ${tabIdToFocus} to focus after move`);
  
  // Clear the storage so we don't focus again on next reload
  sessionStorage.removeItem('focusTabAfterMove');
  
  // Use a longer delay to ensure DOM is fully ready
  setTimeout(() => {
    // Find the tab node in the treemap
    let foundNode = null;
    
    d3.selectAll('.cell').each(function(d) {
      if (!d || !d.data || !d.data.id) return;
      
      const nodeTabId = d.data.id.toString().replace('tab', '');
      
      if (nodeTabId === tabIdToFocus) {
        foundNode = { node: this, data: d };
        console.log('Found moved tab element:', this);
        return;
      }
    });
    
    if (foundNode) {
      console.log('Found moved tab, focusing:', foundNode);
      
      // Focus the node using your existing focus function
      focusNode(foundNode.node, foundNode.data);
      
      // Scroll the node into view
      foundNode.node.scrollIntoView({ 
        behavior: 'smooth', 
        block: 'center' 
      });
      
      // Add a STRONG highlight effect with both D3 and direct DOM methods
      const $node = d3.select(foundNode.node);
      $node.classed('moved-tab-highlight', true);
      
      // Also add an outline directly for immediate feedback
      foundNode.node.style.outline = '3px solid #ff5722';
      foundNode.node.style.outlineOffset = '-3px';
      foundNode.node.style.boxShadow = '0 0 20px rgba(255, 87, 34, 0.8)';
      foundNode.node.style.zIndex = '1000';
      foundNode.node.style.position = 'relative';
      
      // Flash effect
      let flashCount = 0;
      const flashInterval = setInterval(() => {
        if (flashCount >= 5) {
          clearInterval(flashInterval);
          return;
        }
        
        foundNode.node.style.opacity = flashCount % 2 === 0 ? '0.5' : '1';
        flashCount++;
      }, 250);
      
      // Remove the highlight effects after a delay
      setTimeout(() => {
        $node.classed('moved-tab-highlight', false);
        foundNode.node.style.outline = '';
        foundNode.node.style.outlineOffset = '';
        foundNode.node.style.boxShadow = '';
        foundNode.node.style.opacity = '1';
      }, 3000);
    } else {
      console.log(`Could not find moved tab ${tabIdToFocus} in the treemap`);
    }
  }, 800); // Longer delay to ensure DOM is ready
}

// Make sure this call is present at the end of your drawTreemap function
setTimeout(() => {
  focusMovedTabAfterReload();
}, 1000); // Increased delay


// Add this function definition before dragEnded
/**
 * Show notification message to the user
 * 
 * Displays a temporary notification message with animation
 * and automatic dismissal. Supports success and error types.
 * 
 * @param {string} message - Message to display
 * @param {string} type - Notification type ('success', 'error', or 'info')
 */
function showNotification(message, type) {
  // Prevent duplicates by removing existing notifications of the same type
  const existingNotifications = document.querySelectorAll(`.notification.${type}`);
  existingNotifications.forEach(notification => notification.remove());
  
  // Create notification element
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  
  // Style the notification
  notification.style.position = 'fixed';
  notification.style.bottom = '20px';
  notification.style.right = '20px';
  notification.style.padding = '12px 20px';
  notification.style.borderRadius = '4px';
  notification.style.color = 'white';
  notification.style.fontWeight = '500';
  notification.style.boxShadow = '0 3px 10px rgba(0,0,0,0.2)';
  notification.style.zIndex = '10000';
  
  // Apply type-specific styling
  if (type === 'success') {
    notification.style.backgroundColor = '#43a047';
  } else if (type === 'error') {
    notification.style.backgroundColor = '#e53935';
  } else {
    notification.style.backgroundColor = '#1976d2';
  }
  
  // Initial state for animation
  notification.style.transform = 'translateY(100px)';
  notification.style.opacity = '0';
  notification.style.transition = 'all 0.3s ease';
  
  // Add to document
  document.body.appendChild(notification);
  
  // Trigger animation to show
  setTimeout(() => {
    notification.style.transform = 'translateY(0)';
    notification.style.opacity = '1';
  }, 10);
  
  // Remove after delay
  setTimeout(() => {
    notification.style.transform = 'translateY(100px)';
    notification.style.opacity = '0';
    
    // Remove from DOM after transition
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

/**
 * Creates a letter favicon for a URL
 * @param {string} url - URL to create favicon for
 * @return {string} - Data URL for SVG favicon
 */
function createLetterFaviconForURL(url) {
    try {
        // Extract domain or URL part for the letter
        let letter = '?';
        let domain = '';
        
        if (url.startsWith('chrome://')) {
            letter = 'C';
            domain = 'chrome';
        } 
        else if (url.startsWith('chrome-extension://')) {
            letter = 'E';
            domain = 'extension';
        }
        else if (url.startsWith('file://')) {
            letter = 'F';
            domain = 'file';
        }
        else if (url.startsWith('about:')) {
            letter = 'A';
            domain = 'about';
        }
        else {
            try {
                const urlObj = new URL(url);
                domain = urlObj.hostname.replace(/^www\./, '');
                letter = domain.charAt(0).toUpperCase();
                
                // Handle domains starting with numbers or symbols
                if (!letter.match(/[A-Z]/i)) {
                    letter = domain.charAt(1)?.toUpperCase() || 'X';
                    if (!letter.match(/[A-Z]/i)) {
                        letter = 'X';
                    }
                }
            } catch (e) {
                letter = url.charAt(0).toUpperCase() || '?';
            }
        }
        
        // Generate color based on domain for consistency
        const hue = Math.abs(hashCode(domain || url) % 360);
        const color = `hsl(${hue}, 60%, 70%)`;
        const textColor = `hsl(${hue}, 70%, 30%)`;
        
        return createLetterFaviconSVG(letter, color, textColor);
    } catch (error) {
        console.warn('Error creating letter favicon:', error);
        return createPlaceholderFavicon('?');
    }
}

/**
 * Simple string hash function for consistent colors
 * @param {string} str - String to hash
 * @return {number} - Hash code
 */
function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
}

/**
 * Creates an SVG favicon with a letter
 * @param {string} letter - Letter to display
 * @param {string} bgColor - Background color
 * @param {string} textColor - Text color
 * @return {string} - Data URL for SVG favicon
 */
function createLetterFaviconSVG(letter, bgColor = '#e0e0e0', textColor = '#505050') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
        <rect width="32" height="32" fill="${bgColor}" rx="4" />
        <text x="16" y="22" font-family="Arial, sans-serif" font-size="16" 
              fill="${textColor}" text-anchor="middle" font-weight="bold">${letter}</text>
    </svg>`;
    
    return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/**
 * Creates a placeholder favicon
 * @param {string} symbol - Symbol to display
 * @return {string} - Data URL for SVG favicon
 */
function createPlaceholderFavicon(symbol = '?') {
    return createLetterFaviconSVG(symbol, '#eeeeee', '#999999');
}

