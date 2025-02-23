import { getFaviconUrl, formatDistanceToNow, formatSessionDuration } from './utility.js';

export function drawTreemap(categorizedData) {
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
        .padding(0); // Set padding to 0 to remove white space between windows

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

        // Assign border styles to the most recent tabs
        if (tabs.length > 0) tabs[0].data.borderStyle = 'solid';
        if (tabs.length > 1) tabs[1].data.borderStyle = 'dashed';
        if (tabs.length > 2) tabs[2].data.borderStyle = 'dotted';
    });

    const nodes = svg.selectAll('g')
        .data(root.leaves())
        .enter()
        .append('g')
        .attr('transform', d => `translate(${d.x0},${d.y0})`)
        .style('cursor', 'pointer')
        .on('mouseover', (event, d) => {
            console.log('Node info:', d.data);
            displayReadout(d.data, false);
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
        .attr('stroke', d => d.data.borderStyle ? d3.color(d.data.color).darker(2) : 'none')
        .attr('stroke-width', d => d.data.borderStyle ? 3 : 0)
        .attr('stroke-dasharray', d => {
            if (d.data.borderStyle === 'dashed') return '6, 3';
            if (d.data.borderStyle === 'dotted') return '2, 2';
            return 'none';
        });

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
        .attr('xlink:href', d => {
            try {
                const url = new URL(d.data.url);
                return `${url.origin}/favicon.ico?size=128`;
            } catch (e) {
                console.error('Invalid URL:', d.data.url);
                return '';
            }
        })
        .attr('width', 32)
        .attr('height', 32)
        .attr('x', -16)
        .attr('y', -16)
        .attr('preserveAspectRatio', 'xMidYMid meet');

    console.log('Favicons added to cell content'); // Debug

    // Centered text below favicon
    cellContent.append('text')
        .attr('text-anchor', 'middle')
        .attr('y', 48) // Adjusted for larger font size
        .attr('font-size', '20px') // 2x the original size
        .attr('fill', 'black') // Black font color
        .attr('pointer-events', 'none')
        .text(d => {
            const maxLength = Math.floor((d.x1 - d.x0) / 10); // Adjusted for larger font size
            return d.data.title.length > maxLength 
                ? d.data.title.substring(0, maxLength - 3) + '...'
                : d.data.title;
        });

    console.log('Text added to cell content'); // Debug

    console.log('Treemap drawn'); // Debug
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
    `;

    if (sticky) {
        readoutContainer.innerHTML = readoutHtml;
    } else {
        readoutContainer.innerHTML = readoutHtml;
        setTimeout(() => {
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