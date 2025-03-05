import { tabSearch } from './search.js';
import { getDomainFromUrl, getFaviconUrl } from './utility.js';

// Graph visualization data
let nodes = [];
let links = [];
let simulation;
let svg;
let zoom;
let timeScale; // Add timeScale as a global variable
let width, height; // Add near the top of your file with other globals

// State tracking
let currentlyOpenTabs = new Map();
let bookmarkedUrls = new Set();
let filterState = 'all';  // 'all', 'active', 'bookmarks'
let currentViewMode = 'time'; // 'time' or 'domain'

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
        if (window.tabs) {
            window.tabs.forEach(tab => {
                currentlyOpenTabs.set(tab.id, tab);
            });
        }
    });

    // Build graph data
    processHistoryData(historyItems, bookmarks, windows);
    
    // Create the visualization
    createForceGraph();

    // Set up search functionality
    setupSearch();
    
    // Set up view mode switching
    setupViewModes();
    
    // REMOVE THIS LINE: setupControls();
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
    
    // Limit history items to 300 most recent
    if (historyItems.length > 300) {
        console.log(`Limiting visualization to 300 most recent items out of ${historyItems.length}`);
        historyItems = historyItems
            .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
            .slice(0, 300);
    }

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

// Add this function to handle window resize events
function handleResize() {
    if (!svg) return;
    
    // Get container dimensions
    width = document.getElementById('graph').clientWidth;
    height = document.getElementById('graph').clientHeight;
    
    // Update SVG size
    svg.attr('width', width)
       .attr('height', height);
    
    // Update simulation center force
    if (simulation) {
        simulation.force('center', d3.forceCenter(width / 2, height / 2).strength(0.05));
        
        // Update any height-dependent forces
        if (currentViewMode === 'time') {
            simulation.force('y', d3.forceY(d => {
                if (d.isActive) {
                    return height * (0.2 + Math.random() * 0.2);
                }
                const domainHash = hashString(d.domain);
                return height * 0.35 + domainHash * height * 0.5;
            }).strength(0.1));
        }
        
        // Update time scale if needed
        if (timeScale) {
            timeScale.range([150, width - 150]);
        }
        
        // Restart simulation gently
        simulation.alpha(0.1).restart();
    }
}

// Modify the createForceGraph function to use the global width/height
function createForceGraph() {
    // Get container dimensions
    width = document.getElementById('graph').clientWidth;
    height = document.getElementById('graph').clientHeight;
    
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
    
    // Calculate temporal scale - only define once
    // Find min and max timestamps for normalization
    const timeExtent = d3.extent(nodes, d => d.lastVisitTime);
    timeScale = d3.scaleLinear()
        .domain(timeExtent)
        .range([150, width - 150]); // More padding on sides

    // REVERSE the time direction so recent items are on the left (more visible initially)
    // This is a simple change with big impact
    timeScale = d3.scaleLinear()
        .domain([timeExtent[1], timeExtent[0]]) // Reverse the domain
        .range([150, width - 150]);

    // Assign initial positions with more randomness to avoid stacking
    nodes.forEach(node => {
        // Position x based on time plus random jitter
        const jitterX = Math.random() * 80 - 40; // Random offset between -40 and 40
        node.x = timeScale(node.lastVisitTime) + jitterX;
        
        // Position y with more spread
        const domainHash = hashString(node.domain);
        // More vertical spread
        const heightSpread = height * 0.7;
        const centerY = height * 0.5;
        // Add some randomness to y-position
        const jitterY = Math.random() * 50 - 25; // Random offset between -25 and 25
        node.y = centerY + (domainHash * heightSpread - heightSpread/2) + jitterY;
    });

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
    
    // Create nodes with proper class assignment
    const node = g.append('g')
        .attr('class', 'nodes')
        .selectAll('.node')
        .data(nodes)
        .enter()
        .append('g')
        .attr('class', d => {
            // Set appropriate CSS class based on node type
            const classes = ['node'];
            if (d.isActive) classes.push('node-active');
            if (d.type === 'bookmark') classes.push('node-bookmark');
            if (!d.isActive && d.type !== 'bookmark') classes.push('node-history');
            return classes.join(' ');
        })
        // ADD THESE LINES to store title and URL data on DOM nodes
        .attr('data-title', d => d.title || '')
        .attr('data-url', d => d.url || '')
        .call(d3.drag()
            .on('start', dragstarted)
            .on('drag', dragged)
            .on('end', dragended));
    
    // Add this function to calculate node size using both visit count and time spent
    function calculateNodeSize(node) {
        // Handle special cases first
        if (node.isActive) return 12; // Fixed size for active tabs
        if (node.type === 'bookmark') return 10; // Fixed size for bookmarks
        
        // Base size for all nodes
        const baseSize = 5;
        
        // Visit count component (using log scale)
        const visitFactor = Math.log(node.visitCount + 1) / Math.log(10); // log10(visits + 1)
        const visitComponent = visitFactor * 3; // Scale factor for visits
        
        // Time spent component - if we had it (using log scale)
        // For now we'll just use visit count, but this can be expanded later
        const timeSpent = node.timeSpent || (node.visitCount * 30000); // Estimate 30 seconds per visit if no data
        const timeFactor = Math.log(timeSpent / 1000 + 1) / Math.log(10); // log10(seconds + 1)
        const timeComponent = timeFactor * 2; // Scale factor for time spent
        
        // Combine components with appropriate weighting
        const combinedSize = baseSize + (visitComponent * 0.6) + (timeComponent * 0.4);
        
        // Apply min/max constraints
        return Math.max(4, Math.min(combinedSize, 16));
    }

    // Then modify your circle creation code:
    node.append('circle')
        .attr('r', d => calculateNodeSize(d))
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

    // Create force simulation with forces based on current view mode
    simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links)
            .id(d => d.id)
            .distance(80)
            .strength(d => d.strength * 0.7 || 0.1)) // Increased strength
        .force('collision', d3.forceCollide().radius(d => calculateNodeSize(d) + 2))
        .force('center', d3.forceCenter(width / 2, height / 2).strength(0.1)) // Stronger centering
        .alphaDecay(0.05) // Much faster decay (default is 0.0228)
        .velocityDecay(0.4) // Slightly higher damping (default is 0.4)
        .alpha(1); // Start with maximum heat
    
    // Apply the appropriate forces based on view mode
    if (currentViewMode === 'time') {
        simulation
            .force('charge', d3.forceManyBody().strength(-100)) // Stronger repulsion
            .force('x', d3.forceX(d => timeScale(d.lastVisitTime)).strength(0.4)) // Stronger time positioning
            .force('y', d3.forceY(d => {
                if (d.isActive) {
                    return height * (0.2 + Math.random() * 0.2);
                }
                const domainHash = hashString(d.domain);
                return height * 0.35 + domainHash * height * 0.5;
            }).strength(0.2)); // Stronger vertical positioning
    } else {
        simulation
            .force('charge', d3.forceManyBody().strength(-80)) // Stronger repulsion
            .force('x', d3.forceX(d => timeScale(d.lastVisitTime)).strength(0.1))
            .force('y', d3.forceY(height / 2).strength(0.1))
            .force('domain', createDomainClusterForce(0.8)); // Stronger domain clustering
    }
    
    simulation.on('tick', ticked);

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
        if (!event.active) simulation.alphaTarget(0.5).restart(); // Higher target alpha
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

    // Add this to the end of the function
    // Set up resize event listener
    window.addEventListener('resize', handleResize);

    // Call the focus function after simulation stabilizes
    //simulation.on('end', focusOnRecentNodes);

    // Also add a button to jump to recent content
    // This can be added as a floating action button in the corner
    const actionButtons = d3.select('#graph')
        .append('div')
        .attr('class', 'action-buttons')
        .style('position', 'absolute')
        .style('bottom', '20px')
        .style('right', '20px')
        .style('z-index', '100');

    actionButtons.append('button')
        .attr('class', 'recent-button')
        .text('Recent')
        .on('click', focusOnRecentNodes);
}

// When the simulation is no longer needed (e.g., when navigating away)
function cleanupGraph() {
    // Remove resize event listener to prevent memory leaks
    window.removeEventListener('resize', handleResize);
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

// 3. Update the setupSearch function with a try/catch to handle potential issues
function setupSearch() {
    const searchInput = document.getElementById('graphSearch');
    if (!searchInput) return;
    
    searchInput.addEventListener('input', () => {
        const query = searchInput.value.toLowerCase().trim();
        
        // If search is cleared, show all nodes
        if (!query) {
            resetVisibility();
            return;
        }
        
        try {
            // Try to use the imported tabSearch function
            const matchedNodes = typeof tabSearch === 'function' 
                ? tabSearch(query, nodes) 
                : localSearch(query, nodes);
            
            const matchedIds = new Set(matchedNodes.map(node => node.id));
            
            // Update visibility of nodes and links
            updateVisibility(matchedIds);
        } catch (error) {
            console.error("Search error:", error);
            // Fallback to showing everything
            resetVisibility();
        }
    });
}

// Add this function to reset all nodes and links to visible
function resetVisibility() {
    // Make all nodes visible
    d3.selectAll('.node')
        .style('opacity', 1)
        .style('pointer-events', 'all');
    
    // Make all links visible but maintain their original opacity
    d3.selectAll('.links line')
        .style('opacity', function() {
            // Get the original opacity, or use default if not set
            const originalOpacity = d3.select(this).attr('stroke-opacity') || 0.6;
            return originalOpacity;
        })
        .style('pointer-events', 'all');
}

// Update the function that changes visibility based on search
function updateVisibility(matchedIds) {
    // Update node visibility
    d3.selectAll('.node')
        .style('opacity', d => matchedIds.has(d.id) ? 1 : 0.2)
        .style('pointer-events', d => matchedIds.has(d.id) ? 'all' : 'none');
    
    // Update link visibility - only show links between matched nodes
    d3.selectAll('.links line')
        .style('opacity', d => {
            const sourceMatched = matchedIds.has(d.source.id);
            const targetMatched = matchedIds.has(d.target.id);
            if (sourceMatched && targetMatched) {
                // Use the original opacity for matched links
                return d3.select(this).attr('stroke-opacity') || 0.6;
            }
            return 0.05; // Very low opacity for non-matched links
        })
        .style('pointer-events', d => {
            const sourceMatched = matchedIds.has(d.source.id);
            const targetMatched = matchedIds.has(d.target.id);
            return (sourceMatched && targetMatched) ? 'all' : 'none';
        });
}

function setupViewModes() {
    document.getElementById('timeViewBtn').addEventListener('click', () => {
        if (currentViewMode !== 'time') {
            currentViewMode = 'time';
            updateViewMode();
            setActiveButton('timeViewBtn');
        }
    });
    
    document.getElementById('domainViewBtn').addEventListener('click', () => {
        if (currentViewMode !== 'domain') {
            currentViewMode = 'domain';
            updateViewMode();
            setActiveButton('domainViewBtn');
        }
    });

    // Add title attributes to buttons
    document.getElementById('timeViewBtn').title = "Arrange nodes by time of visit";
    document.getElementById('domainViewBtn').title = "Group nodes by website domain";
}

// Helper function to update button appearance
function setActiveButton(activeId) {
    document.querySelectorAll('.view-mode-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.getElementById(activeId).classList.add('active');
}

// Function to update the force layout based on current view mode
function updateViewMode() {
    if (!simulation) return;
    
    // Get width and height
    const width = document.getElementById('graph').clientWidth;
    const height = document.getElementById('graph').clientHeight;
    
    // Make sure timeScale exists
    if (!timeScale) {
        const timeExtent = d3.extent(nodes, d => d.lastVisitTime);
        timeScale = d3.scaleLinear()
            .domain(timeExtent)
            .range([150, width - 150]);
    }
    
    // Stop the current simulation
    simulation.stop();
    
    if (currentViewMode === 'time') {
        // Time view - Strong x-positioning based on time, looser domain clustering
        simulation
            .force('x', d3.forceX(d => timeScale(d.lastVisitTime)).strength(0.2))
            .force('y', d3.forceY(d => {
                if (d.isActive) {
                    return height * (0.2 + Math.random() * 0.2);
                }
                const domainHash = hashString(d.domain);
                return height * 0.35 + domainHash * height * 0.5;
            }).strength(0.1))
            .force('charge', d3.forceManyBody().strength(-80));
            
        // Remove any domain-specific forces
        simulation.force('domain', null);
    } 
    else if (currentViewMode === 'domain') {
        // Domain view - Weaker x time positioning, stronger domain clustering
        simulation
            .force('x', d3.forceX(d => timeScale(d.lastVisitTime)).strength(0.05))
            .force('y', d3.forceY(height / 2).strength(0.05))
            .force('charge', d3.forceManyBody().strength(-60))
            // Add a new force to cluster by domain
            .force('domain', createDomainClusterForce());
    }
    
    // Restart the simulation with a higher alpha and faster decay
    simulation
        .alphaDecay(0.05)
        .alpha(0.6)
        .restart();
}

// Create a custom force that attracts nodes of the same domain
function createDomainClusterForce(strength = 0.5) {
    // Group nodes by domain
    const domainGroups = {};
    nodes.forEach(node => {
        if (!domainGroups[node.domain]) {
            domainGroups[node.domain] = [];
        }
        domainGroups[node.domain].push(node);
    });
    
    // Return the custom force function
    return function(alpha) {
        // For each domain group, pull nodes toward their domain center
        Object.values(domainGroups).forEach(domainNodes => {
            // Skip tiny groups
            if (domainNodes.length <= 1) return;
            
            // Find the centroid of this domain group
            let centerX = 0, centerY = 0;
            domainNodes.forEach(node => {
                centerX += node.x;
                centerY += node.y;
            });
            centerX /= domainNodes.length;
            centerY /= domainNodes.length;
            
            // Pull each node toward the center of its domain
            domainNodes.forEach(node => {
                node.vx += (centerX - node.x) * alpha * strength;
                node.vy += (centerY - node.y) * alpha * strength;
            });
        });
    };
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

// After the simulation creation and initialization, 
// Add this at the end of createForceGraph():
function focusOnRecentNodes() {
  // Find nodes from the last 24 hours
  const last24Hours = Date.now() - (24 * 60 * 60 * 1000);
  const recentNodes = nodes.filter(d => d.lastVisitTime > last24Hours);
  
  if (recentNodes.length === 0) return; // No recent nodes
  
  // Find the bounding box of recent nodes
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  
  recentNodes.forEach(node => {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  });
  
  // Add asymmetric padding - more on the left side
  const leftPadding = 120;  // More padding on the left
  const rightPadding = 80;  // Standard padding on the right
  const verticalPadding = 80;  // Standard padding top/bottom
  
  minX -= leftPadding;
  minY -= verticalPadding;
  maxX += rightPadding;
  maxY += verticalPadding;
  
  // Calculate the center and size of the bounding box
  const centerX = 50+ ((minX + maxX) / 2);
  const centerY = (minY + maxY) / 2;
  const boxWidth = maxX - minX;
  const boxHeight = maxY - minY;
  
  // Calculate zoom scale to fit the bounding box
  const scale = Math.min(
    width / boxWidth,
    height / boxHeight,
    1.8  // Cap at 1.8x zoom (slightly lower than before)
  );
  
  // Apply the transform to center and zoom into recent nodes - immediately
  svg.call(
    zoom.transform,
    d3.zoomIdentity
      .translate(width / 2, height / 2)
      .scale(scale * 0.75)  // Use 85% of the max scale for more margin
      .translate(-centerX, -centerY)
  );
}

// Reattach search functionality
document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('tabSearch');
  if (searchInput) {
    // Clear any existing listeners (if any)
    searchInput.removeEventListener('input', handleSearchInput);
    
    // Add the listener back
    searchInput.addEventListener('input', handleSearchInput);
    
    // Restore any previous search value if it exists
    if (window.sessionStorage.getItem('tabSearchQuery')) {
      searchInput.value = window.sessionStorage.getItem('tabSearchQuery');
      // Trigger the search with the restored value
      handleSearchInput({target: searchInput});
    }
  }
  
  function handleSearchInput(event) {
    const query = event.target.value.toLowerCase().trim();
    
    // Store search query in session storage for persistence between page changes
    window.sessionStorage.setItem('tabSearchQuery', query);
    
    // Filter nodes in the graph based on the query
    filterGraphBySearch(query);
  }
  
  function filterGraphBySearch(query) {
    // This needs to match the filtering function used in your graph visualization
    const nodes = document.querySelectorAll('.node');
    
    if (!query) {
      // If query is empty, show all nodes
      nodes.forEach(node => {
        node.style.opacity = 1;
        node.style.pointerEvents = 'all';
      });
      return;
    }
    
    // Otherwise filter nodes
    nodes.forEach(node => {
      const nodeText = node.getAttribute('data-title')?.toLowerCase() || '';
      const nodeUrl = node.getAttribute('data-url')?.toLowerCase() || '';
      
      if (nodeText.includes(query) || nodeUrl.includes(query)) {
        node.style.opacity = 1;
        node.style.pointerEvents = 'all';
      } else {
        node.style.opacity = 0.2;
        node.style.pointerEvents = 'none';
      }
    });
  }
});

// Add keyboard shortcuts for common actions
document.addEventListener('keydown', (e) => {
  // Press 'r' to focus on recent nodes
  if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
    focusOnRecentNodes();
  }
  
  // Press 't' for time view
  if (e.key === 't' && !e.ctrlKey && !e.metaKey) {
    if (currentViewMode !== 'time') {
      currentViewMode = 'time';
      updateViewMode();
      setActiveButton('timeViewBtn');
    }
  }
  
  // Press 'd' for domain view
  if (e.key === 'd' && !e.ctrlKey && !e.metaKey) {
    if (currentViewMode !== 'domain') {
      currentViewMode = 'domain';
      updateViewMode();
      setActiveButton('domainViewBtn');
    }
  }
});

// Fix the Escape key handler to properly clear search filtering

// Handle Escape key to clear search
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    console.log("Escape key pressed");
    
    // Try both potential search input IDs - we have a mismatch in the code
    const tabSearchInput = document.getElementById('tabSearch');
    const graphSearchInput = document.getElementById('graphSearch');
    
    // Use whichever search input exists and has a value
    const searchInput = (tabSearchInput && tabSearchInput.value) ? tabSearchInput : 
                       (graphSearchInput && graphSearchInput.value) ? graphSearchInput : 
                       null;
    
    if (searchInput && searchInput.value) {
      console.log("Clearing search:", searchInput.id, "value:", searchInput.value);
      
      // Clear the search box
      searchInput.value = '';
      
      // Clear the stored search query in session storage
      window.sessionStorage.removeItem('tabSearchQuery');
      
      // IMPORTANT: This is a more direct way to reset all nodes
      // Instead of calling filterGraphBySearch which might have issues
      d3.selectAll('.node')
        .style('opacity', 1)
        .style('pointer-events', 'all')
        .classed('search-result', false)
        .classed('search-dimmed', false);
      
      // Reset link visibility
      d3.selectAll('.links line')
        .style('opacity', function() {
          return d3.select(this).attr('stroke-opacity') || 0.6;
        })
        .style('pointer-events', 'all');
      
      // Apply any global filters that should remain active
      if (typeof applyFilters === 'function') {
        applyFilters();
      }
      
      // Fire an event to notify that search was cleared
      const event = new CustomEvent('searchCleared');
      document.dispatchEvent(event);
      
      console.log("Search clearing complete");
    }
  }
});

// Replace the search handling code with this simplified version

document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('tabSearch');
  if (searchInput) {
    // Clear any existing listeners
    searchInput.removeEventListener('input', handleSearchInput);
    
    // Add the listener back
    searchInput.addEventListener('input', handleSearchInput);
    
    // Restore previous search value if it exists
    if (window.sessionStorage.getItem('tabSearchQuery')) {
      searchInput.value = window.sessionStorage.getItem('tabSearchQuery');
      // Trigger the search with the restored value
      handleSearchInput({target: searchInput});
    }
  }
  
  function handleSearchInput(event) {
    const query = event.target.value.toLowerCase().trim();
    
    // Store search query in session storage for persistence
    window.sessionStorage.setItem('tabSearchQuery', query);
    
    // Apply filtering directly - same logic as the Escape key handler
    if (!query) {
      // Reset all nodes and links if query is empty
      d3.selectAll('.node')
        .style('opacity', 1)
        .style('pointer-events', 'all')
        .classed('search-result', false)
        .classed('search-dimmed', false);
      
      // Reset link visibility
      d3.selectAll('.links line')
        .style('opacity', function() {
          return d3.select(this).attr('stroke-opacity') || 0.6;
        })
        .style('pointer-events', 'all');
        
      // Apply any global filters
      if (typeof applyFilters === 'function') {
        applyFilters();
      }
    } else {
      // Filter nodes based on query
      d3.selectAll('.node').each(function(d) {
        const nodeText = d.title?.toLowerCase() || '';
        const nodeUrl = d.url?.toLowerCase() || '';
        const isMatch = nodeText.includes(query) || nodeUrl.includes(query);
        
        d3.select(this)
          .style('opacity', isMatch ? 1 : 0.2)
          .style('pointer-events', isMatch ? 'all' : 'none')
          .classed('search-result', isMatch)
          .classed('search-dimmed', !isMatch);
      });
      
      // Update link visibility
      d3.selectAll('.links line').each(function(d) {
        const sourceMatched = d3.select(`[data-url="${d.source.id}"]`).classed('search-result');
        const targetMatched = d3.select(`[data-url="${d.target.id}"]`).classed('search-result');
        
        d3.select(this)
          .style('opacity', (sourceMatched && targetMatched) ? 
            (d3.select(this).attr('stroke-opacity') || 0.6) : 0.05)
          .style('pointer-events', (sourceMatched && targetMatched) ? 'all' : 'none');
      });
    }
  }
});