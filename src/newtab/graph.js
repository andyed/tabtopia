import { tabSearch } from './search.js';
import { getDomainFromUrl, getFaviconUrl } from './utility.js';

// Graph visualization data
let nodes = [];
let links = [];
let simulation;
let svg;
let zoom;

// State tracking
let currentlyOpenTabs = new Map();
let bookmarkedUrls = new Set();
let filterState = 'all';  // 'all', 'active', 'bookmarks'

// Initialize the visualization
async function init() {
    // Fetch data
    const [historyItems, windows] = await Promise.all([
        chrome.history.search({ text: '', maxResults: 200, startTime: Date.now() - 7 * 24 * 60 * 60 * 1000 }),
        chrome.windows.getAll({ populate: true })
    ]);

    // Get bookmarks
    const bookmarks = await fetchBookmarks();
    
    // Track currently open tabs
    windows.forEach(window => {
        window.tabs.forEach(tab => {
            currentlyOpenTabs.set(tab.id, tab);
            if (tab.url) {
                // Mark bookmarked URLs
                bookmarkedUrls.add(tab.url);
            }
        });
    });

    // Build graph data
    processHistoryData(historyItems, bookmarks, windows);
    
    // Create the visualization
    createForceGraph();

    // Set up search functionality
    setupSearch();

    // Set up controls
    setupControls();
}

async function fetchBookmarks() {
    return new Promise((resolve) => {
        chrome.bookmarks.getTree(function(bookmarkTreeNodes) {
            const bookmarks = [];
            
            function processNode(node) {
                if (node.url) {
                    bookmarks.push({
                        id: node.id,
                        title: node.title,
                        url: node.url,
                        dateAdded: node.dateAdded
                    });
                    bookmarkedUrls.add(node.url);
                }
                
                if (node.children) {
                    node.children.forEach(processNode);
                }
            }
            
            bookmarkTreeNodes.forEach(processNode);
            resolve(bookmarks);
        });
    });
}

function processHistoryData(historyItems, bookmarks, windows) {
    // Create nodes map to avoid duplicates
    const nodesMap = new Map();
    
    // Process history items
    historyItems.forEach(item => {
        const domain = getDomainFromUrl(item.url);
        if (!domain) return;
        
        // Add node if not exists
        if (!nodesMap.has(item.url)) {
            nodesMap.set(item.url, {
                id: item.url,
                title: item.title,
                url: item.url,
                domain: domain,
                visitCount: item.visitCount,
                lastVisitTime: item.lastVisitTime,
                type: bookmarkedUrls.has(item.url) ? 'bookmark' : 'history',
                isActive: Array.from(currentlyOpenTabs.values()).some(tab => tab.url === item.url)
            });
        }
    });
    
    // Add currently open tabs if not in history
    currentlyOpenTabs.forEach(tab => {
        if (tab.url && !nodesMap.has(tab.url)) {
            const domain = getDomainFromUrl(tab.url);
            if (!domain) return;
            
            nodesMap.set(tab.url, {
                id: tab.url,
                title: tab.title,
                url: tab.url,
                domain: domain,
                visitCount: 1,
                lastVisitTime: Date.now(),
                type: bookmarkedUrls.has(tab.url) ? 'bookmark' : 'history',
                isActive: true
            });
        } else if (tab.url) {
            // Mark existing node as active
            const node = nodesMap.get(tab.url);
            if (node) {
                node.isActive = true;
            }
        }
    });
    
    // Convert nodes map to array
    nodes = Array.from(nodesMap.values());
    
    // Track edge sources to avoid duplicates
    const edgeMap = new Map();
    
    // 1. Create edges based on browser navigation data (highest confidence)
    // These would come from your background.js tabEdges or browserState.tabRelationships
    // We'll simulate fetching this data for now
    chrome.runtime.sendMessage({ action: 'getTabRelationships' }, (response) => {
        if (response && response.tabRelationships) {
            // Process real navigation relationships
            response.tabRelationships.forEach((relationship, tabId) => {
                if (relationship.referringTabId && relationship.referringURL) {
                    const sourceNode = nodes.find(n => n.url === relationship.referringURL);
                    const targetNode = nodes.find(n => n.id.includes(tabId));
                    
                    if (sourceNode && targetNode) {
                        const edgeId = `${sourceNode.id}-${targetNode.id}`;
                        if (!edgeMap.has(edgeId)) {
                            edgeMap.set(edgeId, {
                                source: sourceNode.id,
                                target: targetNode.id,
                                type: 'navigation',
                                transitionType: relationship.transitionType || 'link',
                                strength: 0.6,  // Highest strength for actual navigations
                                visible: true
                            });
                        }
                    }
                }
            });
        }
    });
    
    // 2. Create edges based on window/tab parent relationships (high confidence)
    windows.forEach(window => {
        if (window.tabs && window.tabs.length > 0) {
            // Find tabs that were opened from other tabs (opener relationship)
            window.tabs.forEach(tab => {
                if (tab.openerTabId) {
                    const opener = window.tabs.find(t => t.id === tab.openerTabId);
                    if (opener) {
                        const sourceNode = nodes.find(n => n.url === opener.url);
                        const targetNode = nodes.find(n => n.url === tab.url);
                        
                        if (sourceNode && targetNode) {
                            const edgeId = `${sourceNode.id}-${targetNode.id}`;
                            if (!edgeMap.has(edgeId)) {
                                edgeMap.set(edgeId, {
                                    source: sourceNode.id,
                                    target: targetNode.id,
                                    type: 'opener',
                                    strength: 0.5,  // Strong connection
                                    visible: true
                                });
                            }
                        }
                    }
                }
            });
        }
    });
    
    // 3. Add bookmark relationships (medium confidence)
    // Connect bookmarks with their non-bookmark variants
    nodes.forEach(node => {
        if (node.type === 'bookmark') {
            // Find non-bookmark version of the same URL
            const nonBookmarkVersion = nodes.find(n => 
                n.url === node.url && n.type !== 'bookmark');
            
            if (nonBookmarkVersion) {
                const edgeId = `${node.id}-${nonBookmarkVersion.id}`;
                if (!edgeMap.has(edgeId)) {
                    edgeMap.set(edgeId, {
                        source: node.id,
                        target: nonBookmarkVersion.id,
                        type: 'bookmark-relation',
                        strength: 0.4,
                        visible: true
                    });
                }
            }
        }
    });
    
    // 4. Add temporal sequence edges only as fallback (lower confidence)
    // But be more restrictive with them
    const sortedNodes = [...nodes].sort((a, b) => a.lastVisitTime - b.lastVisitTime);
    const timeThreshold = 2 * 60 * 1000; // 2 minutes
    
    for (let i = 0; i < sortedNodes.length - 1; i++) {
        const current = sortedNodes[i];
        const next = sortedNodes[i + 1];
        
        if (next.lastVisitTime - current.lastVisitTime < timeThreshold) {
            const edgeId = `${current.id}-${next.id}`;
            if (!edgeMap.has(edgeId)) {
                edgeMap.set(edgeId, {
                    source: current.id,
                    target: next.id,
                    type: 'sequence',
                    strength: 0.2, // Lower strength for time-based edges
                    visible: true
                });
            }
        }
    }
    
    // Convert edges map to array
    links = Array.from(edgeMap.values());
}

function createForceGraph() {
    const width = document.getElementById('graph').clientWidth;
    const height = document.getElementById('graph').clientHeight;
    
    // Create SVG
    svg = d3.select('#graph')
        .append('svg')
        .attr('width', width)
        .attr('height', height);
    
    // Add zoom behavior
    zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => {
            g.attr('transform', event.transform);
        });
    
    svg.call(zoom);
    
    // Create container group for zoom
    const g = svg.append('g');
    
    // Create links with appropriate styling based on confidence
    const link = g.append('g')
        .attr('class', 'links')
        .selectAll('line')
        .data(links.filter(d => d.visible !== false))
        .enter()
        .append('line')
        .attr('class', d => d.type)
        .attr('stroke-width', d => {
            switch (d.type) {
                case 'navigation': return 2;
                case 'opener': return 1.5;
                case 'bookmark-relation': return 1.2;
                case 'sequence': return 0.8;
                default: return 1;
            }
        })
        .attr('stroke-opacity', d => {
            switch (d.type) {
                case 'navigation': return 0.9;
                case 'opener': return 0.8;
                case 'bookmark-relation': return 0.7;
                case 'sequence': return 0.5;
                default: return 0.6;
            }
        })
        .attr('stroke', d => {
            switch (d.type) {
                case 'navigation': 
                    // Different colors based on transition type
                    if (d.transitionType === 'link') return '#90CAF9'; // Blue
                    if (d.transitionType === 'typed') return '#A5D6A7'; // Green
                    if (d.transitionType === 'auto_bookmark') return '#FFF59D'; // Yellow
                    return '#90CAF9'; // Default blue
                case 'opener': return '#CE93D8'; // Purple
                case 'bookmark-relation': return '#80DEEA'; // Teal
                case 'sequence': return '#BDBDBD'; // Gray
                default: return '#E0E0E0';
            }
        });
    
    // Create nodes
    const node = g.append('g')
        .attr('class', 'nodes')
        .selectAll('.node')
        .data(nodes)
        .enter()
        .append('g')
        .attr('class', 'node')
        .call(d3.drag()
            .on('start', dragstarted)
            .on('drag', dragged)
            .on('end', dragended));
    
    // Add circles to nodes
    node.append('circle')
        .attr('r', d => Math.sqrt(d.visitCount) * 2 + 5)
        .attr('class', d => {
            if (d.isActive) return 'node-active';
            if (d.type === 'bookmark') return 'node-bookmark';
            return 'node-history';
        })
        .attr('fill', d => {
            if (d.isActive) return '#64b5f6';
            if (d.type === 'bookmark') return '#66bb6a';
            
            // Color by domain using a hash function
            const hash = hashString(d.domain);
            return d3.interpolateSpectral(hash / 100);
        });
    
    // Add favicon images to nodes with placeholder
    const nodeImages = node.append('image')
        .attr('x', -8)
        .attr('y', -8)
        .attr('width', 16)
        .attr('height', 16)
        .attr('clip-path', 'circle(8px)')
        .attr('xlink:href', ''); // Empty placeholder initially
    
    // Asynchronously load favicons using our standard utility function
    nodes.forEach(async (d, i) => {
        if (d.url) {
            try {
                const faviconUrl = await getFaviconUrl(d.url, 16);
                if (faviconUrl) {
                    // Update the favicon URL for this specific node
                    d3.select(nodeImages.nodes()[i])
                        .attr('xlink:href', faviconUrl);
                }
            } catch (e) {
                console.warn('Error loading favicon for:', d.url);
            }
        }
    });
    
    // Handle node hover for tooltip
    node.on('mouseover', (event, d) => {
        showTooltip(event, d);
    })
    .on('mousemove', (event) => {
        // Move tooltip with mouse
        d3.select('#tooltip')
            .style('left', (event.pageX + 10) + 'px')
            .style('top', (event.pageY + 10) + 'px');
    })
    .on('mouseout', () => {
        hideTooltip();
    })
    .on('click', (event, d) => {
        // Navigate to URL on click
        chrome.tabs.create({ url: d.url });
    });

    // Create force simulation - apply forces to ALL links regardless of visibility
    simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links)  // Use all links for force calculation
            .id(d => d.id)
            .distance(100)
            .strength(d => d.strength || 0.1))
        .force('charge', d3.forceManyBody().strength(-100))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(d => Math.sqrt(d.visitCount) * 2 + 10))
        .force('x', d3.forceX(width / 2).strength(0.05))
        .force('y', d3.forceY(height / 2).strength(0.05))
        .on('tick', ticked);

    // Tick function to update positions
    function ticked() {
        link
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);

        node
            .attr('transform', d => `translate(${d.x},${d.y})`);
    }

    // Drag functions
    function dragstarted(event, d) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
    }

    function dragged(event, d) {
        d.fx = event.x;
        d.fy = event.y;
    }

    function dragended(event, d) {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
    }
}

function showTooltip(event, d) {
    const tooltip = d3.select('#tooltip')
        .style('left', (event.pageX + 10) + 'px')
        .style('top', (event.pageY + 10) + 'px')
        .style('opacity', 1);
    
    tooltip.html(`
        <div class="tooltip-title">${d.title || 'Untitled'}</div>
        <div class="tooltip-url">${d.url}</div>
        <div>Domain: ${d.domain}</div>
        <div>Visit count: ${d.visitCount}</div>
        <div>Last visit: ${new Date(d.lastVisitTime).toLocaleString()}</div>
        ${d.isActive ? '<div><strong>Currently open</strong></div>' : ''}
        ${d.type === 'bookmark' ? '<div><strong>Bookmarked</strong></div>' : ''}
    `);
}

function hideTooltip() {
    d3.select('#tooltip').style('opacity', 0);
}

function setupSearch() {
    const searchInput = document.getElementById('graphSearch');
    
    searchInput.addEventListener('input', () => {
        const searchTerm = searchInput.value.toLowerCase();
        
        if (!searchTerm) {
            // Reset all nodes
            d3.selectAll('.node circle').style('opacity', 1);
            return;
        }
        
        // Filter nodes
        d3.selectAll('.node')
            .style('opacity', d => {
                const titleMatch = d.title && d.title.toLowerCase().includes(searchTerm);
                const urlMatch = d.url && d.url.toLowerCase().includes(searchTerm);
                return titleMatch || urlMatch ? 1 : 0.2;
            });
    });
    
    searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            searchInput.value = '';
            d3.selectAll('.node circle').style('opacity', 1);
        }
    });
}

function setupControls() {
    // Zoom controls
    document.getElementById('zoomIn').addEventListener('click', () => {
        zoom.scaleBy(svg.transition().duration(750), 1.5);
    });
    
    document.getElementById('zoomOut').addEventListener('click', () => {
        zoom.scaleBy(svg.transition().duration(750), 0.75);
    });
    
    document.getElementById('resetView').addEventListener('click', () => {
        const width = document.getElementById('graph').clientWidth;
        const height = document.getElementById('graph').clientHeight;
        
        svg.transition().duration(750).call(
            zoom.transform,
            d3.zoomIdentity.translate(width / 2, height / 2).scale(1)
        );
    });
    
    // Filter controls
    document.getElementById('filterActive').addEventListener('click', () => {
        filterState = 'active';
        applyFilters();
    });
    
    document.getElementById('filterBookmarks').addEventListener('click', () => {
        filterState = 'bookmarks';
        applyFilters();
    });
    
    document.getElementById('filterAll').addEventListener('click', () => {
        filterState = 'all';
        applyFilters();
    });
    
    // Add domain links toggle
    let domainLinksVisible = false;
    document.getElementById('toggleDomainLinks').addEventListener('click', () => {
        domainLinksVisible = !domainLinksVisible;
        
        // Update button text
        document.getElementById('toggleDomainLinks').textContent = 
            domainLinksVisible ? 'Hide Domain Links' : 'Show Domain Links';
            
        // Update link visibility
        if (domainLinksVisible) {
            // Add domain links with lighter color
            const domainLinks = g.select('.links')
                .selectAll('line.domain-link')
                .data(links.filter(d => d.type === 'domain'))
                .enter()
                .append('line')
                .attr('class', 'domain-link')
                .attr('stroke-width', 0.5)
                .attr('stroke-opacity', 0.4) // Slightly higher opacity
                .attr('stroke', '#b0b0b0') // Light gray color
                .attr('stroke-dasharray', '2,2');
                
            // Update the tick function to include these links
            simulation.on('tick', () => {
                // Update regular links
                g.selectAll('.links line:not(.domain-link)')
                    .attr('x1', d => d.source.x)
                    .attr('y1', d => d.source.y)
                    .attr('x2', d => d.target.x)
                    .attr('y2', d => d.target.y);
                    
                // Update domain links if visible
                g.selectAll('.domain-link')
                    .attr('x1', d => d.source.x)
                    .attr('y1', d => d.source.y)
                    .attr('x2', d => d.target.x)
                    .attr('y2', d => d.target.y);
                
                // Update nodes
                g.selectAll('.node')
                    .attr('transform', d => `translate(${d.x},${d.y})`);
            });
        } else {
            // Remove domain links
            g.selectAll('.domain-link').remove();
        }
    });
}

function applyFilters() {
    d3.selectAll('.node').style('display', d => {
        if (filterState === 'active' && !d.isActive) return 'none';
        if (filterState === 'bookmarks' && d.type !== 'bookmark') return 'none';
        return null;
    });
    
    // Also hide links that connect to hidden nodes
    d3.selectAll('.links line').style('display', d => {
        if (filterState === 'all') return null;
        
        const sourceNode = nodes.find(n => n.id === d.source.id);
        const targetNode = nodes.find(n => n.id === d.target.id);
        
        if (filterState === 'active') {
            if (!sourceNode.isActive || !targetNode.isActive) return 'none';
        } else if (filterState === 'bookmarks') {
            if (sourceNode.type !== 'bookmark' || targetNode.type !== 'bookmark') return 'none';
        }
        
        return null;
    });
}

// Utility function to hash a string
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0; // Convert to 32-bit integer
    }
    return Math.abs(hash % 100) / 100;
}

// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', init);