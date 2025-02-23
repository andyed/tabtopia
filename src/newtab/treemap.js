import { getFaviconUrl } from './utility.js';

export function drawTreemap(categorizedData) {
    // Create a color scale for windows
    const lightColors = [
        '#90caf9', // light blue
        '#a5d6a7', // light green
        '#ffcc80', // light orange
        '#ef9a9a', // light red
        '#ce93d8', // light purple
        '#80deea', // light cyan
        '#fff59d', // light yellow
        '#bcaaa4', // light brown
    ];

    // Create a map of window IDs to colors
    const windowColors = new Map();
    categorizedData.activeWindows.forEach((window, index) => {
        windowColors.set(window.id, lightColors[index % lightColors.length]);
    });

    const sidebar = document.getElementById('sidebar');
    if (!sidebar) {
        console.error('Sidebar element not found');
        return;
    }

    const width = sidebar.offsetWidth;
    const height = window.innerHeight;

    // Clear any existing content
    d3.select('#treemap').selectAll('*').remove();

    const svg = d3.select('#treemap')
        .append('svg')
        .attr('width', width)
        .attr('height', height);

    const treemap = d3.treemap()
        .size([width, height])
        .padding(1);

    // Transform data into hierarchy
    const hierarchyData = {
        name: 'root',
        children: categorizedData.activeWindows.map(window => ({
            name: `Window ${window.id}`,
            children: window.tabs.map(tab => ({
                id: `tab${tab.id}`,
                windowId: tab.windowId,  // Make sure this is included
                title: tab.title || 'Untitled',
                url: tab.url || '',
                favIconUrl: tab.favIconUrl || getFaviconUrl(tab.url),
                timeSpent: 100 // Default value until we implement time tracking
            }))
        }))
    };

    const root = d3.hierarchy(hierarchyData)
        .sum(d => d.timeSpent)
        .sort((a, b) => b.value - a.value);

    treemap(root);

    const nodes = svg.selectAll('g')
        .data(root.leaves())
        .enter()
        .append('g')
        .attr('transform', d => `translate(${d.x0},${d.y0})`)
        .style('cursor', 'pointer')
        .on('dblclick', (event, d) => {
            const windowId = parseInt(d.data.windowId, 10);
            const tabId = parseInt(d.data.id.replace('tab', ''), 10);
            
            // Focus the tab
            chrome.windows.update(windowId, { focused: true }, () => {
                chrome.tabs.update(tabId, { active: true });
            });
        });

    // Background rectangles
    nodes.append('rect')
        .attr('id', d => d.data.id)
        .attr('width', d => d.x1 - d.x0)
        .attr('height', d => d.y1 - d.y0)
        .attr('fill', d => windowColors.get(d.data.windowId))
        .attr('opacity', d => d.parent.data.focused ? 1 : 0.7);

    // Create centered container for content
    const cellContent = nodes.append('g')
        .attr('class', 'cell-content')
        .attr('transform', d => {
            const cellWidth = d.x1 - d.x0;
            const cellHeight = d.y1 - d.y0;
            return `translate(${cellWidth/2},${cellHeight/2})`;
        });

    // Favicon with larger size request
    cellContent.append('image')
        .attr('xlink:href', d => {
            const url = new URL(d.data.url);
            return `${url.origin}/favicon.ico?size=128`;
        })
        .attr('width', 32)
        .attr('height', 32)
        .attr('x', -16) // Center the image
        .attr('y', -16)
        .attr('preserveAspectRatio', 'xMidYMid meet');

    // Centered text below favicon
    cellContent.append('text')
        .attr('text-anchor', 'middle')
        .attr('y', 24)  // Position below the favicon
        .attr('font-size', '10px')
        .attr('fill', 'white')
        .attr('pointer-events', 'none')
        .text(d => {
            const maxLength = Math.floor((d.x1 - d.x0) / 6);  // Approximate characters that fit
            return d.data.title.length > maxLength 
                ? d.data.title.substring(0, maxLength - 3) + '...'
                : d.data.title;
        });
}

// Helper function to wrap text
function wrap(text, width) {
    text.each(function() {
        const text = d3.select(this);
        const words = text.text().split(/\s+/).reverse();
        let word;
        let line = [];
        let lineNumber = 0;
        const lineHeight = 1.1;
        const y = text.attr('y');
        const dy = parseFloat(text.attr('dy')) || 0;
        let tspan = text.text(null).append('tspan')
            .attr('x', text.attr('x'))
            .attr('y', y)
            .attr('dy', dy + 'em');

        while (word = words.pop()) {
            line.push(word);
            tspan.text(line.join(' '));
            if (tspan.node().getComputedTextLength() > width) {
                line.pop();
                tspan.text(line.join(' '));
                line = [word];
                tspan = text.append('tspan')
                    .attr('x', text.attr('x'))
                    .attr('y', y)
                    .attr('dy', ++lineNumber * lineHeight + dy + 'em')
                    .text(word);
            }
        }
    });
}

document.addEventListener('DOMContentLoaded', function () {
    if (window.categorizedData) {
        drawTreemap(window.categorizedData);
    }
});