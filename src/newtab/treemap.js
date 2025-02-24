import { getFaviconUrl, formatDistanceToNow, formatSessionDuration } from './utility.js';

let categorizedDataCache = null;
let readoutTimeout = null;

export function drawTreemap(categorizedData) {
    categorizedDataCache = categorizedData; // Cache the data for redraw
    console.log('Drawing treemap with data:', categorizedData); // Debug

    const container = document.getElementById('treemap-container');
    if (!container) {
        console.error('Treemap container not found');
        return;
    }

    const width = container.offsetWidth;
    const height = window.innerHeight;

    console.log('Treemap dimensions:', { width, height }); // Debug

    // Clear existing content
    d3.select('#treemap').selectAll('*').remove();

    const svg = d3.select('#treemap')
        .append('svg')
        .attr('width', width)
        .attr('height', height);

    console.log('SVG created:', svg); // Debug

    // Create a color scale for windows
    const lightColors = [
        '#e3f2fd', // very light blue
        '#e8f5e9', // very light green
        '#fff3e0', // very light orange
        '#ffebee', // very light red
        '#f3e5f5', // very light purple
        '#e0f7fa', // very light cyan
        '#fffde7', // very light yellow
        '#efebe9', // very light brown
    ];

    // Create a map of window IDs to colors
    const windowColors = new Map();
    categorizedData.activeWindows.forEach((window, index) => {
        windowColors.set(window.id, lightColors[index % lightColors.length]);
    });

    console.log('Window colors:', windowColors); // Debug

    // Transform data into hierarchy
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
                timeSpent: 100,
                children: tab.openInNewTab ? tab.openInNewTab.map(newTab => ({
                    id: `tab${newTab.id}`,
                    windowId: window.id,
                    title: newTab.title || 'Untitled',
                    url: newTab.url || '',
                    favIconUrl: newTab.favIconUrl,
                    lastAccessed: newTab.lastAccessed,
                    timeSpent: 100
                })) : []
            }))
        }))
    };

    console.log('Hierarchy data:', hierarchyData); // Debug

    const treemap = d3.treemap()
        .size([width, height])
        .paddingInner(5) // Inner padding between nodes
        .paddingOuter(10); // Outer padding around the treemap

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

    const nodes = svg.selectAll('g')
        .data(root.leaves())
        .enter()
        .append('g')
        .attr('transform', d => `translate(${d.x0},${d.y0})`)
        .style('cursor', 'pointer')
        .on('mouseover', function(event, d) {
            console.log('Node info:', d.data);
            displayReadout(d.data, false);
            d3.select(this).select('rect')
                .attr('fill', '#ffff99') // Light yellow color on hover
                .attr('stroke', '#ffff99'); // Match stroke to fill color on hover
        })
        .on('mouseout', function(event, d) {
            d3.select(this).select('rect')
                .attr('fill', d.data.color) // Revert to original color
                .attr('stroke', 'none'); // Remove stroke
            hideReadout();
        })
        .on('click', (event, d) => {
            displayReadout(d.data, true);
        })
        .on('dblclick', (event, d) => {
            const windowId = parseInt(d.data.windowId, 10);
            const tabId = parseInt(d.data.id.replace('tab', ''), 10);
            
            chrome.windows.update(windowId, { focused: true }, () => {
                chrome.tabs.update(tabId, { active: true });
            });
        });

    console.log('Nodes created:', nodes); // Debug

    // Background rectangles
    nodes.append('rect')
        .attr('id', d => d.data.id)
        .attr('width', d => d.x1 - d.x0)
        .attr('height', d => d.y1 - d.y0)
        .attr('fill', d => d.data.color)
        .attr('opacity', d => d.parent.data.focused ? 1 : 0.7)
        .attr('stroke', 'none');

    console.log('Rectangles added to nodes'); // Debug

    // Create centered container for content
    const cellContent = nodes.append('g')
        .attr('class', 'cell-content')
        .attr('transform', d => {
            const cellWidth = d.x1 - d.x0;
            const cellHeight = d.y1 - d.y0;
            return `translate(${cellWidth / 2},${cellHeight / 2})`;
        });

    console.log('Cell content containers created'); // Debug

    // Favicon
    cellContent.append('image')
        .attr('xlink:href', d => d.data.favIconUrl || `${new URL(d.data.url).origin}/favicon.ico?size=128`)
        .attr('width', 128)
        .attr('height', 128)
        .attr('x', -64) // Center horizontally
        .attr('y', -64) // Center vertically
        .attr('onerror', function() {
            d3.select(this)
                .attr('xlink:href', d => d.data.favIconUrl || `${new URL(d.data.url).origin}/favicon.ico?size=16`)
                .attr('width', 128)
                .attr('height', 128);
        });

    console.log('Favicons added to cell content'); // Debug

    // Centered text below favicon
    const textElement = cellContent.append('text')
        .attr('text-anchor', 'middle')
        .attr('y', 80) // Adjusted for favicon height and padding
        .attr('fill', 'black') // Black font color
        .attr('opacity', 0.8) // 80% opacity
        .attr('pointer-events', 'none')
        .text(d => d.data.title);

    // Adjust font size to fit the available cell space
    nodes.each(function(d) {
        const text = d3.select(this).select('text');
        fitTextToCell(text, d.x1 - d.x0 - 16, d.y1 - d.y0 - 144); // Adjusted for padding and favicon height
    });

    console.log('Text added to cell content'); // Debug

    console.log('Treemap drawn'); // Debug
}

function fitTextToCell(textElement, cellWidth, cellHeight) {
    const words = textElement.text().split(' ');
    let lines = [];
    let line = [];
    let lineNumber = 0;
    const lineHeight = 1.1; // ems
    const y = textElement.attr('y');
    const dy = 0;

    // Determine the number of lines based on the number of words
    if (words.length <= 2) {
        lines = [words.join(' ')];
    } else if (words.length === 3) {
        lines = words;
    } else {
        const mid = Math.ceil(words.length / 2);
        lines = [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
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

    const readoutHtml = `
        <h2>${tabData.title}</h2>
        <p><a href="${tabData.url}" target="_blank">${tabData.url}</a></p>
        <p>Last accessed: ${formatDistanceToNow(new Date(tabData.lastAccessed))}</p>
        <p>Time spent: ${tabData.timeSpent ? `${tabData.timeSpent} seconds` : 'N/A'}</p>
        <h3>History</h3>
        <ul>
            ${tabData.history ? tabData.history.sort((a, b) => b.timestamp - a.timestamp).map(entry => `
                <li>${new Date(entry.timestamp).toLocaleString()}: <a href="${entry.url}" target="_blank">${entry.title || entry.url}</a></li>
            `).join('') : ''}
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