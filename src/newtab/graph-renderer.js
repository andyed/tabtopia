

import { getLocalFaviconUrl, escapeHtml } from "./utility.js";

/**
 * Get a synchronous favicon URL for graph rendering.
 * Uses Chrome's local favicon cache (_favicon/), not the external Google service.
 */
function getFaviconUrlSync(url) {
    return getLocalFaviconUrl(url, 32);
}

export function highlightGraphNodeForUrl(svgElement, url) {
    if (!svgElement || !url) return;

    // Convert DOM element to D3 selection if needed
    const svg = svgElement.tagName ? d3.select(svgElement) : svgElement;

    svg.selectAll(".node").classed("highlighted", false);

    svg.selectAll(".node").filter(d => d.url === url)
        .classed("highlighted", true);
}

export function unhighlightAllGraphNodes(svgElement) {
    if (!svgElement) return;

    // Convert DOM element to D3 selection if needed
    const svg = svgElement.tagName ? d3.select(svgElement) : svgElement;

    svg.selectAll(".node").classed("highlighted", false);
}


export function createForceGraph(container, nodes, links, session, viewMode = "time") {
    if (!container || !nodes || !links || !session || !window.d3) {
        console.error("Missing dependencies or parameters for graph creation:", {
            container: !!container,
            nodes: !!nodes,
            links: !!links,
            session: !!session,
            d3: !!window.d3,
            nodesLength: nodes?.length,
            linksLength: links?.length
        });
        return null;
    }

    console.log("Creating force graph:", {
        sessionId: session.id,
        nodeCount: nodes.length,
        linkCount: links.length,
        viewMode
    });

    const width = container.clientWidth;
    const height = container.clientHeight || 400;

    console.log("Graph dimensions:", { width, height });

    container.innerHTML = "";

    const svg = d3.select(container).append("svg")
        .attr("id", `session-graph-${session.id}`)
        .attr("width", width)
        .attr("height", height);

    const g = svg.append("g");

    const zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on("zoom", (event) => {
            g.attr("transform", event.transform);
        });

    svg.call(zoom);

    const timeExtent = d3.extent(nodes, d => d.lastVisitTime);
    const timeScale = d3.scaleLinear()
        .domain(timeExtent)
        .range([150, width - 150]);

    const link = g.append("g")
        .attr("class", "links")
        .selectAll("line")
        .data(links)
        .enter()
        .append("line")
        .attr("class", d => d.type)
        .attr("stroke-width", d => {
            switch (d.type) {
                case "navigation": return 2;
                case "redirect": return 1.5;
                case "opener": return 1.5;
                case "bookmark-relation": return 1.2;
                case "sequence": return 0.8;
                default: return 1;
            }
        })
        .attr("stroke-opacity", d => {
            switch (d.type) {
                case "navigation": return 0.9;
                case "redirect": return 0.8;
                case "opener": return 0.8;
                case "bookmark-relation": return 0.7;
                case "sequence": return 0.5;
                default: return 0.6;
            }
        })
        .attr("stroke-dasharray", d => d.type === "redirect" ? "5,5" : null)
        .attr("stroke", d => {
            switch (d.type) {
                case "navigation":
                    if (d.transitionType === "link") return "#90CAF9";
                    if (d.transitionType === "typed") return "#A5D6A7";
                    if (d.transitionType === "auto_bookmark") return "#FFF59D";
                    return "#90CAF9";
                case "redirect": return "#f44336";
                case "opener": return "#CE93D8";
                case "bookmark-relation": return "#80DEEA";
                case "sequence": return "#BDBDBD";
                default: return "#E0E0E0";
            }
        });

    const node = g.append("g")
        .attr("class", "nodes")
        .selectAll(".node")
        .data(nodes)
        .enter()
        .append("g")
        .attr("class", d => {
            const classes = ["node"];
            if (d.isActive) classes.push("node-active");
            if (d.type === "bookmark") classes.push("node-bookmark");
            if (!d.isActive && d.type !== "bookmark") classes.push("node-history");
            return classes.join(" ");
        })
        .attr("data-title", d => d.title || "")
        .attr("data-url", d => d.url || "");

    function calculateNodeSize(node) {
        if (node.isActive) return 12;
        if (node.type === "bookmark") return 10;
        const baseSize = 5;
        const visitFactor = Math.log(node.visitCount + 1) / Math.log(10);
        const visitComponent = visitFactor * 3;
        const timeSpent = node.timeSpent || (node.visitCount * 30000);
        const timeFactor = Math.log(timeSpent / 1000 + 1) / Math.log(10);
        const timeComponent = timeFactor * 2;
        const combinedSize = baseSize + (visitComponent * 0.6) + (timeComponent * 0.4);
        return Math.max(4, Math.min(combinedSize, 16));
    }

    node.append("circle")
        .attr("r", d => calculateNodeSize(d))
        .attr("fill", d => {
            if (d.isActive) return "#64b5f6";
            if (d.type === "bookmark") return "#66bb6a";
            const hash = hashString(d.domain);
            return d3.interpolateSpectral(hash / 100);
        });

    const nodeImages = node.append("image")
        .attr("class", "favicon")
        .attr("x", -8)
        .attr("y", -8)
        .attr("width", 16)
        .attr("height", 16)
        .attr("clip-path", "circle(8px)")
        .attr("xlink:href", d => getFaviconUrlSync(d.url));

    // Add drag behavior
    const drag = d3.drag()
        .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
        })
        .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
        })
        .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            // Keep node fixed after dragging (double-click to unfix)
            // d.fx = null;
            // d.fy = null;
        });

    // Track click state for double-click detection in session modals
    let clickTimeout = null;
    let clickCount = 0;

    // Add interactions to nodes
    node.call(drag)
        .on("click", (event, d) => {
            // Prevent default to avoid conflicts with drag
            event.stopPropagation();

            // Check if we're in a session modal (has session ID other than 'main-graph')
            const isSessionModal = session && session.id !== "main-graph";

            if (isSessionModal) {
                // In session modal: first click scrolls to page, second click opens
                clickCount++;

                if (clickCount === 1) {
                    // First click: scroll to the page in the list
                    clickTimeout = setTimeout(() => {
                        // Find the page item by matching the data-url attribute exactly
                        const allPageItems = document.querySelectorAll(".session-page-item[data-url]");
                        let pageItem = null;
                        for (const item of allPageItems) {
                            if (item.getAttribute("data-url") === d.url) {
                                pageItem = item;
                                break;
                            }
                        }

                        if (pageItem) {
                            pageItem.scrollIntoView({ behavior: "smooth", block: "center" });
                            // Briefly highlight the item
                            pageItem.classList.add("flash-highlight");
                            setTimeout(() => pageItem.classList.remove("flash-highlight"), 1000);
                        } else {
                            console.warn("Could not find page item for URL:", d.url);
                        }
                        clickCount = 0;
                    }, 300);
                } else if (clickCount === 2) {
                    // Second click: open the URL
                    clearTimeout(clickTimeout);
                    if (d.url) {
                        chrome.tabs.create({ url: d.url });
                    }
                    clickCount = 0;
                }
            } else {
                // In main graph: single click opens URL
                if (d.url) {
                    chrome.tabs.create({ url: d.url });
                }
            }
        })
        .on("dblclick", (event, d) => {
            // Double click - unfix node position
            d.fx = null;
            d.fy = null;
            simulation.alpha(0.3).restart();
        })
        .on("mouseover", function (event, d) {
            // Highlight connected nodes
            d3.select(this).classed("node-hover", true);

            // Show tooltip
            const tooltip = d3.select("#tooltip");
            if (tooltip.empty()) return;

            // Format last visit time
            let lastVisitStr = "";
            if (d.lastVisitTime) {
                const lastVisit = new Date(d.lastVisitTime);
                lastVisitStr = lastVisit.toLocaleString("en-US", {
                    month: "numeric",
                    day: "numeric",
                    year: "numeric",
                    hour: "numeric",
                    minute: "numeric",
                    second: "numeric",
                    hour12: true
                });
            }

            tooltip
                .style("opacity", "1")
                .style("left", (event.pageX + 10) + "px")
                .style("top", (event.pageY - 10) + "px")
                .html(`
                    <div style="font-weight: 600; margin-bottom: 8px;">${escapeHtml(d.title || "Untitled")}</div>
                    <div style="font-size: 11px; color: #aaa; margin-bottom: 4px; word-break: break-all;">${escapeHtml(d.url)}</div>
                    <div style="margin-top: 8px;">
                        ${d.domain ? `<div>Domain: ${escapeHtml(d.domain)}</div>` : ""}
                        ${d.visitCount ? `<div>Visit count: ${d.visitCount}</div>` : ""}
                        ${lastVisitStr ? `<div>Last visit: ${lastVisitStr}</div>` : ""}
                        ${d.isActive ? "<div style=\"color: #64b5f6; font-weight: 600;\">Currently open</div>" : ""}
                    </div>
                `);
        })
        .on("mouseout", function (event, d) {
            d3.select(this).classed("node-hover", false);

            // Hide tooltip
            const tooltip = d3.select("#tooltip");
            if (!tooltip.empty()) {
                tooltip.style("opacity", "0");
            }
        })
        .style("cursor", "pointer");

    const simulation = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(links).id(d => d.id).distance(80).strength(d => d.strength * 0.7 || 0.1))
        .force("collision", d3.forceCollide().radius(d => calculateNodeSize(d) + 2))
        .force("center", d3.forceCenter(width / 2, height / 2).strength(0.1))
        .alphaDecay(0.05)
        .velocityDecay(0.4)
        .alpha(1);

    if (viewMode === "time") {
        simulation
            .force("charge", d3.forceManyBody().strength(-100))
            .force("x", d3.forceX(d => timeScale(d.lastVisitTime)).strength(0.4))
            .force("y", d3.forceY(d => {
                if (d.isActive) {
                    // Deterministic jitter: hash(node.id || url) → [0.2, 0.4).
                    // Math.random() was called on every tick → jittery, non-reproducible layout.
                    const activeHash = hashString(d.id || d.url || "");
                    return height * (0.2 + activeHash * 0.2);
                }
                const domainHash = hashString(d.domain);
                return height * 0.35 + domainHash * height * 0.5;
            }).strength(0.2));
    } else {
        simulation
            .force("charge", d3.forceManyBody().strength(-80))
            .force("x", d3.forceX(d => timeScale(d.lastVisitTime)).strength(0.1))
            .force("y", d3.forceY(height / 2).strength(0.1))
            .force("domain", createDomainClusterForce(nodes, 0.8));
    }

    simulation.on("tick", () => {
        link
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        node
            .attr("transform", d => `translate(${d.x},${d.y})`);
    });

    function hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash % 100) / 100;
    }

    function createDomainClusterForce(nodes, strength = 0.5) {
        const domainGroups = {};
        nodes.forEach(node => {
            if (!domainGroups[node.domain]) {
                domainGroups[node.domain] = [];
            }
            domainGroups[node.domain].push(node);
        });

        return function (alpha) {
            Object.values(domainGroups).forEach(domainNodes => {
                if (domainNodes.length <= 1) return;

                let centerX = 0, centerY = 0;
                domainNodes.forEach(node => {
                    centerX += node.x;
                    centerY += node.y;
                });
                centerX /= domainNodes.length;
                centerY /= domainNodes.length;

                domainNodes.forEach(node => {
                    node.vx += (centerX - node.x) * alpha * strength;
                    node.vy += (centerY - node.y) * alpha * strength;
                });
            });
        };
    }

    // Return both the SVG DOM node and the simulation for external access
    return {
        svg: svg.node(),
        simulation: simulation
    };
}
