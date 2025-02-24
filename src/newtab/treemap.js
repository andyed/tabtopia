import { getFaviconUrl, formatDistanceToNow, formatSessionDuration } from './utility.js';

let categorizedDataCache = null;
let readoutTimeout = null;
let currentData = null;  // Add this line
let currentFocusIndex = -1;
let focusableNodes = [];

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

function calculateOptimalLayout(totalTabs, width, viewportHeight) {
    // Start with maximum icon size
    let iconSize = 128;
    const minIconSize = 16;
    const padding = 10;
    const textHeight = 40; // Approximate height for text
    
    // Calculate minimum cell size needed for each icon size
    while (iconSize > minIconSize) {
        const cellSize = iconSize + padding * 2 + textHeight;
        const cellsPerRow = Math.floor(width / cellSize);
        const rows = Math.ceil(totalTabs / cellsPerRow);
        const totalHeight = rows * cellSize;
        
        // If it fits in viewport, use this size
        if (totalHeight <= viewportHeight) {
            return {
                iconSize,
                height: viewportHeight, // Use full viewport
                enableScroll: false
            };
        }
        
        // Try next smaller icon size
        iconSize -= 16;
    }
    
    // If we get here, even smallest icons don't fit
    return {
        iconSize: minIconSize,
        height: Math.max(viewportHeight, (Math.ceil(totalTabs / Math.floor(width / (minIconSize + padding * 2 + textHeight)))) * (minIconSize + padding * 2 + textHeight)),
        enableScroll: true
    };
}

export function drawTreemap(categorizedData) {
    // Validate input data
    if (!categorizedData?.activeWindows) {
        console.warn('Invalid treemap data:', categorizedData);
        return;
    }

    categorizedDataCache = categorizedData;
    currentData = categorizedData;

    // Update container and SVG setup
    const container = document.getElementById('treemap');
    const viewportHeight = window.innerHeight;
    const width = container.offsetWidth || 800;
    const totalTabs = categorizedData.activeWindows.reduce((sum, w) => sum + w.tabs.length, 0);
    
    // Calculate optimal layout
    const layout = calculateOptimalLayout(totalTabs, width, viewportHeight);
    
    // Apply scroll only if necessary
    container.style.height = `${viewportHeight}px`;
    container.style.overflowY = layout.enableScroll ? 'auto' : 'hidden';
    container.style.overflowX = 'hidden';

    // Create SVG with calculated height
    d3.select('#treemap').selectAll('*').remove();
    const svg = d3.select('#treemap')
        .append('svg')
        .attr('width', width)
        .attr('height', layout.height);

    // Create color schemes
    const lightColors = [
        '#e3f2fd', '#e8f5e9', '#fff3e0', '#ffebee', 
        '#f3e5f5', '#e0f7fa', '#fffde7', '#efebe9'
    ];

    const windowColors = new Map();
    categorizedData.activeWindows.forEach((window, index) => {
        windowColors.set(window.id, lightColors[index % lightColors.length]);
    });

    // Create hierarchy data
    const hierarchyData = {
        name: 'root',
        children: categorizedData.activeWindows.map(window => ({
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

    // Create and configure treemap
    const treemap = d3.treemap()
        .size([width, layout.height])
        .paddingInner(5)
        .paddingOuter(10);

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

        const baseColor = d3.color(windowColors.get(parseInt(windowNode.data.name.replace('Window ', ''), 10)));
        if (!baseColor) {
            console.error('Base color not found for window:', windowNode.data.name);
            return;
        }

        const colorScale = d3.scaleLinear()
            .domain([minLastAccessed, maxLastAccessed])
            .range([baseColor.darker(0.5), baseColor.brighter(0.2)]);

        tabs.forEach(tab => {
            tab.data.color = colorScale(tab.data.lastAccessed);
        });

        // Sort tabs by lastAccessed to determine the most recent ones
        tabs.sort((a, b) => b.data.lastAccessed - a.data.lastAccessed);

        // Ensure the colors for the three most recent items are different
        if (tabs.length > 0) tabs[0].data.color = baseColor.brighter(0.2);
        if (tabs.length > 1) tabs[1].data.color = baseColor;
        if (tabs.length > 2) tabs[2].data.color = baseColor.darker(0.5);
    });

    // Add background rectangles for each window
    root.children.forEach(windowNode => {
        svg.append('rect')
            .attr('x', windowNode.x0)
            .attr('y', windowNode.y0)
            .attr('width', windowNode.x1 - windowNode.x0)
            .attr('height', windowNode.y1 - windowNode.y0)
            .attr('fill', d3.color(windowColors.get(parseInt(windowNode.data.name.replace('Window ', ''), 10))).darker(0.5))
            .attr('stroke', 'none');
    });

    // Create nodes with both keyboard and mouse interactions
    const nodes = svg.selectAll('g')
        .data(root.leaves())
        .enter()
        .append('g')
        .attr('transform', d => `translate(${d.x0},${d.y0})`)
        .style('cursor', 'pointer')
        .attr('tabindex', (d, i) => i) // Make nodes focusable
        .attr('role', 'button') // Add ARIA role
        .attr('aria-label', d => d.data.title) // Add ARIA label
        // Add hover effects
        .on('mouseenter', function(event, d) {
            // Store original color for restoration
            d3.select(this).attr('data-original-color', d.data.color);
            // Update both rectangle and stroke
            d3.select(this).select('rect')
                .attr('fill', '#ffff99')
                .attr('stroke', '#ffff99')
                .attr('stroke-width', '2px');
            displayReadout(d.data, false);
        })
        .on('mouseleave', function(event, d) {
            // Restore original color
            const originalColor = d3.select(this).attr('data-original-color');
            d3.select(this).select('rect')
                .attr('fill', originalColor)
                .attr('stroke', 'none')
                .attr('stroke-width', null);
            hideReadout();
        })
        .on('dblclick', function(event, d) {
            // Navigate to tab on double click
            const windowId = parseInt(d.data.windowId, 10);
            const tabId = parseInt(d.data.id.replace('tab', ''), 10);
            chrome.windows.update(windowId, { focused: true }, () => {
                chrome.tabs.update(tabId, { active: true });
            });
        })
        .on('click', function(event, d) {
            displayReadout(d.data, true);
        })
        .on('focus', function(event, d) {
            currentFocusIndex = parseInt(this.getAttribute('tabindex'));
            displayReadout(d.data, false);
            d3.select(this).select('rect')
                .attr('fill', '#ffff99')
                .attr('stroke', '#ffff99');
        })
        .on('blur', function(event, d) {
            d3.select(this).select('rect')
                .attr('fill', d.data.color)
                .attr('stroke', 'none');
            hideReadout();
        })
        .on('keydown', function(event, d) {
            handleKeyNavigation(event, this, d);
        });

    // Store focusable nodes for navigation
    focusableNodes = nodes.nodes();

    // Background rectangles
    nodes.append('rect')
        .attr('id', d => d.data.id)
        .attr('width', d => d.x1 - d.x0)
        .attr('height', d => d.y1 - d.y0)
        .attr('fill', d => d.data.color)
        .attr('opacity', d => d.parent.data.focused ? 1 : 0.7)
        .attr('stroke', 'none');

    // Use calculated icon size instead of recalculating
    const iconSize = layout.iconSize;

    // Create centered container for content
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

    // Add placeholder images first
    cellContent.append('image')
        .attr('xlink:href', '')
        .attr('width', d => d.iconSize)
        .attr('height', d => d.iconSize)
        .attr('x', d => -d.iconSize/2)
        .attr('y', d => -d.iconSize/2);

    // Update favicons asynchronously
    cellContent.each(function(d) {
        if (d.data?.url) {
            updateCellFavicon(d3.select(this), d.data.url, d.iconSize);
        }
    });

    // Favicon or SVG icon for Chrome URLs
    cellContent.append('image')
        .attr('xlink:href', d => {
            if (d.data.url.startsWith('chrome://')) {
                return 'data:image/svg+xml;base64,' + btoa(`
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${windowColors.get(d.data.windowId)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-settings">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
                        <path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z" />
                        <path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" />
                    </svg>
                `);
            } else {
                return d.data.favIconUrl || `${new URL(d.data.url).origin}/favicon.ico?size=${d.iconSize}`;
            }
        })
        .attr('width', d => d.iconSize)
        .attr('height', d => d.iconSize)
        .attr('x', d => -d.iconSize/2)
        .attr('y', d => -d.iconSize/2)
        .on('error', function(event, d) {
            d3.select(this)
                .attr('xlink:href', `${new URL(d.data.url).origin}/favicon.ico?size=16`)
                .attr('width', d.iconSize)
                .attr('height', d.iconSize);
        });

    // Centered text below favicon
    const textElement = cellContent.append('text')
        .attr('text-anchor', 'middle')
        .attr('y', d => d.iconSize/2 + 20) // Position text below icon
        .attr('fill', 'black') // Black font color
        .attr('opacity', 0.8) // 80% opacity
        .attr('pointer-events', 'none')
        .text(d => d.data.title);

    // Adjust font size to fit the available cell space
    nodes.each(function(d) {
        const text = d3.select(this).select('text');
        fitTextToCell(text, d.x1 - d.x0 - 16, d.y1 - d.y0 - (d.iconSize + 44)); // Account for icon size
    });

    console.log('Text adjusted to fit cell'); // Debug

    console.log('Treemap drawn'); // Debug
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

function displayReadout(tabData, sticky) {
    const readoutContainer = document.getElementById('readout');
    if (!readoutContainer) {
        console.error('Readout container not found');
        return;
    }

    // Collect history of URLs with the same tabId
    const history = [];
    categorizedDataCache.activeWindows.forEach(window => {
        window.tabs.forEach(tab => {
            if (tab.id === tabData.id) {
                history.push({
                    timestamp: tab.lastAccessed,
                    url: tab.url,
                    title: tab.title
                });
            }
        });
    });

    const readoutHtml = `
        <h2>${tabData.title}</h2>
        <p><a href="${tabData.url}" target="_blank">${tabData.url}</a></p>
        <p>Last accessed: ${formatDistanceToNow(new Date(tabData.lastAccessed))}</p>
        <p>Time spent: ${tabData.timeSpent ? `${tabData.timeSpent} seconds` : 'N/A'}</p>
        <h3>History</h3>
        <ul>
            ${history.sort((a, b) => b.timestamp - a.timestamp).map(entry => `
                <li>${new Date(entry.timestamp).toLocaleString()}: <a href="${entry.url}" target="_blank">${entry.title || entry.url}</a></li>
            `).join('')}
        </ul>
    `;

    readoutContainer.innerHTML = readoutHtml;

    if (!sticky) {
        clearTimeout(readoutTimeout);
        readoutTimeout = setTimeout(() => {
            if (!readoutContainer.classList.contains('sticky')) {
                readoutContainer.innerHTML = '';
            }
        }, 3000);
    }

    if (sticky) {
        readoutContainer.classList.add('sticky');
    } else {
        readoutContainer.classList.remove('sticky');
    }
}

function hideReadout() {
    const readoutContainer = document.getElementById('readout');
    if (!readoutContainer.classList.contains('sticky')) {
        readoutContainer.innerHTML = '';
    }
}

// Add resize handler
window.onresize = () => {
    if (categorizedDataCache) {
        drawTreemap(categorizedDataCache);
    }
};

// Listen for messages from background.js
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'tabUpdated') {
        handleTabUpdated(message);
    } else if (message.action === 'tabRemoved') {
        handleTabRemoved(message.tabId, message.removeInfo);
    } else if (message.action === 'tabCreated') {
        handleTabCreated(message.tab);
    }
});

// Update the handleTabUpdated function with better error handling
function handleTabUpdated(message) {
    const { tabId, changeInfo, tab } = message;
    
    if (!currentData?.activeWindows) {
        console.warn('No active windows data available:', currentData);
        return;
    }

    const window = currentData.activeWindows.find(w => w.id === tab.windowId);
    if (!window) {
        console.warn(`Window ${tab.windowId} not found in active windows:`, currentData.activeWindows);
        return;
    }

    const tabIndex = window.tabs.findIndex(t => t.id === tabId);
    if (tabIndex !== -1) {
        window.tabs[tabIndex] = {
            ...window.tabs[tabIndex],
            ...tab,
            lastUpdated: Date.now()
        };
        console.log(`Updated tab ${tabId} in window ${tab.windowId}:`, window.tabs[tabIndex]);
        
        // Redraw treemap with updated data
        drawTreemap(currentData);
    }
}

function handleTabRemoved(tabId, removeInfo) {
    // Remove the tab from categorizedDataCache
    categorizedDataCache.activeWindows.forEach(window => {
        window.tabs = window.tabs.filter(t => t.id !== tabId);
    });

    // Redraw the treemap
    drawTreemap(categorizedDataCache);
}

function handleTabCreated(tab) {
    // Add the new tab to categorizedDataCache
    categorizedDataCache.activeWindows.forEach(window => {
        if (window.id === tab.windowId) {
            window.tabs.push({
                id: tab.id,
                windowId: tab.windowId,
                title: tab.title || 'Untitled',
                url: tab.url || '',
                favIconUrl: tab.favIconUrl,
                lastAccessed: Date.now(),
                timeSpent: 100,
                children: []
            });
        }
    });

    // Redraw the treemap
    drawTreemap(categorizedDataCache);
}

// Update handleKeyNavigation to use the same navigation logic
function handleKeyNavigation(event, node, data) {
    const key = event.key;
    const currentIndex = parseInt(node.getAttribute('tabindex'));
    let nextIndex = currentIndex;

    switch (key) {
        case 'Enter':
            // Navigate to tab on Enter key
            const windowId = parseInt(data.data.windowId, 10); // Access through data.data
            const tabId = parseInt(data.data.id.replace(/\D/g, ''), 10); // Access through data.data
            if (!isNaN(windowId) && !isNaN(tabId)) {
                chrome.windows.update(windowId, { focused: true }, () => {
                    chrome.tabs.update(tabId, { active: true });
                });
                console.log(`Navigating to window: ${windowId}, tab: ${tabId}`);
            } else {
                console.warn('Invalid window or tab ID:', { windowId, tabId, data: data.data });
            }
            event.preventDefault();
            break;
        case ' ':
            // Simulate click behavior
            displayReadout(data.data, true); // Access through data.data
            event.preventDefault();
            break;
        case 'ArrowRight':
            nextIndex = findClosestNodeInDirection('right', currentIndex);
            event.preventDefault();
            break;
        case 'ArrowLeft':
            nextIndex = findClosestNodeInDirection('left', currentIndex);
            event.preventDefault();
            break;
        case 'ArrowUp':
            nextIndex = findClosestNodeInDirection('up', currentIndex);
            event.preventDefault();
            break;
        case 'ArrowDown':
            nextIndex = findClosestNodeInDirection('down', currentIndex);
            event.preventDefault();
            break;
    }

    if (nextIndex !== currentIndex) {
        focusableNodes[nextIndex].focus();
    }
}

function findClosestNodeInDirection(direction, currentIndex) {
    const currentNode = focusableNodes[currentIndex];
    const currentRect = currentNode.getBoundingClientRect();
    const currentCenter = {
        x: currentRect.left + currentRect.width / 2,
        y: currentRect.top + currentRect.height / 2
    };

    const candidates = focusableNodes.map((node, index) => {
        const rect = node.getBoundingClientRect();
        return {
            node,
            index,
            rect,
            center: {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2
            },
            distance: 0 // Will be calculated based on direction
        };
    });

    // Filter and score candidates based on direction
    const validCandidates = candidates.filter(c => {
        switch (direction) {
            case 'right':
                return c.center.x > currentCenter.x;
            case 'left':
                return c.center.x < currentCenter.x;
            case 'up':
                return c.center.y < currentCenter.y;
            case 'down':
                return c.center.y > currentCenter.y;
        }
    });

    if (!validCandidates.length) return currentIndex;

    // Calculate weighted distances
    validCandidates.forEach(c => {
        const dx = c.center.x - currentCenter.x;
        const dy = c.center.y - currentCenter.y;
        
        switch (direction) {
            case 'right':
            case 'left':
                // Prefer nodes that are more horizontally aligned
                c.distance = Math.abs(dx) + Math.abs(dy) * 3;
                break;
            case 'up':
            case 'down':
                // Prefer nodes that are more vertically aligned
                c.distance = Math.abs(dy) + Math.abs(dx) * 3;
                break;
        }
    });

    // Return the index of the closest valid candidate
    return validCandidates.reduce((prev, curr) => 
        curr.distance < prev.distance ? curr : prev
    ).index;
}

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