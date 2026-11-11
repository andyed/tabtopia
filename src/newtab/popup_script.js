/**
 * Lightweight treemap visualization for Chrome extension popup
 */

import { createLetterFavicon, getWindowColor } from "./utility.js";

document.addEventListener("DOMContentLoaded", () => {
    // Get DOM elements
    const treemapContainer = document.getElementById("popup-treemap");
    const searchInput = document.getElementById("popupSearch");
    const tabCountEl = document.getElementById("tabCount");
    const windowCountEl = document.getElementById("windowCount");
    const tooltip = document.getElementById("tooltip");
    const settingsButton = document.getElementById("openSettings");

    settingsButton?.addEventListener("click", async () => {
        await chrome.runtime.openOptionsPage();
        window.close();
    });

    // Focus the search input as soon as the popup loads
    if (searchInput) {
        searchInput.focus();
        // Optionally select all text for quick overwrite
        searchInput.select();
    }

    // Logo click: jump to an open main view (newtab page), or open one
    const logo = document.querySelector(".logo");
    if (logo) {
        logo.addEventListener("click", openMainView);
        logo.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openMainView();
            }
        });
    }

    /**
     * Focus an existing tabtopia main view tab, or create one.
     * Matches by this extension's own newtab URL (prefix, so hash/query
     * permalink states still count) — a second loaded copy of the
     * extension won't be mistaken for ours.
     */
    async function openMainView() {
        const mainViewBaseUrl = chrome.runtime.getURL("src/newtab/newtab.html");
        const mainViewUrl = `${mainViewBaseUrl}#/home`;
        const tabs = await chrome.tabs.query({});
        const existing = tabs.find(tab =>
            (tab.url || tab.pendingUrl || "").startsWith(mainViewBaseUrl)
        );

        if (existing) {
            chrome.tabs.update(existing.id, { active: true, url: mainViewUrl });
            chrome.windows.update(existing.windowId, { focused: true });
        } else {
            chrome.tabs.create({ url: mainViewUrl, active: true });
        }

        window.close();
    }

    
    // Add these variables at the top of your script
    let focusableElements = [];
    let currentFocusIndex = -1;
    let isKeyboardNavigating = false;
    
    // Initialize loading state
    showLoading();
    
    // Initialize D3 treemap
    const width = treemapContainer.clientWidth;
    const height = treemapContainer.clientHeight;
    
    const svg = d3.select("#popup-treemap")
        .append("svg")
        .attr("width", width)
        .attr("height", height);
    
    const root = svg.append("g");
    
    // Fetch and render browser data
    fetchBrowserData()
        .then(data => {
            hideLoading();
            renderTreemap(data);
            
            // Update stats
            updateStats(data);
            
            // Setup event listeners
            setupEventListeners();
        })
        .catch(error => {
            console.error("Error fetching browser data:", error);
            showEmptyState("Could not load tab data. Please try again.");
        });
    
    /**
     * Fetch browser tab data (windows and tabs)
     */
    async function fetchBrowserData() {
        return new Promise((resolve) => {
            chrome.windows.getAll({ populate: true }, windows => {
                const hierarchicalData = {
                    name: "root",
                    children: windows.map(window => {
                        // Sort tabs by lastAccessed time if available
                        const sortedTabs = [...window.tabs].sort((a, b) => {
                            // Use Chrome's lastAccessed if available, or fallback to index ordering
                            const timeA = a.lastAccessed || a.index;
                            const timeB = b.lastAccessed || b.index;
                            return timeB - timeA; // Most recent first
                        });
                        
                        return {
                            name: `Window ${window.id}`,
                            id: window.id,
                            focused: window.focused,
                            children: sortedTabs.map((tab, index) => ({
                                id: tab.id,
                                windowId: window.id,
                                title: tab.title || "Untitled",
                                url: tab.url || "",
                                favIconUrl: tab.favIconUrl || getLetterFavicon(tab.url || ""),
                                active: tab.active,
                                lastAccessed: tab.lastAccessed || Date.now() - (index * 60000), // Fallback to fake timestamps
                                index: index, // Store position for coloring
                                totalInWindow: window.tabs.length // Store total for calculating color intensity
                            }))
                        };
                    })
                };
                
                resolve(hierarchicalData);
            });
        });
    }
    
    /**
     * Render treemap visualization from data
     */
    function renderTreemap(data) {
        // Clear previous content
        root.selectAll("*").remove();
        
        // Debug data
        console.log("Rendering treemap with data:", data);
        
        // Check if we have valid data
        if (!data || !data.children || data.children.length === 0) {
            showEmptyState("No browser windows found");
            return;
        }
        
        // Configure treemap layout
        const treemapLayout = d3.treemap()
            .size([width, height])
            .paddingOuter(3)
            .paddingInner(2)
            .round(true);
        
        // Generate hierarchy
        const hierarchy = d3.hierarchy(data)
            .sum(() => 1) // Equal size for all tabs
            .sort((a, b) => b.value - a.value);
        
        // Debug hierarchy
        console.log("Hierarchy:", hierarchy);
        
        // Run treemap algorithm
        treemapLayout(hierarchy);
        
        // Create groups for windows
        const windows = root.selectAll(".window")
            .data(hierarchy.children)
            .enter()
            .append("g")
            .attr("class", d => `window${d.data.focused ? " is-focused" : ""}`)
            .style("--window-tint", d => `hsl(${getWindowColor(d.data.id).hue}, 35%, 60%)`)
            .attr("transform", d => `translate(${d.x0},${d.y0})`);
        
        // Add window background
        windows.append("rect")
            .attr("class", "window-frame")
            .attr("width", d => d.x1 - d.x0)
            .attr("height", d => d.y1 - d.y0)
            .attr("rx", 3)
            .attr("ry", 3);
        
        // Add window label
        windows.append("text")
            .attr("class", "window-label")
            .attr("x", 4)
            .attr("y", 12)
            .text(d => `Window ${d.data.id}`);
        
        // Add cells for each tab
        windows.each(function(windowNode) {
            d3.select(this).selectAll(".cell")
                .data(windowNode.children || [])
                .enter()
                .append("g")
                .attr("class", d => `cell${d.data.active ? " is-active" : ""}`)
                // Preserve recency order while keeping the fill inside the dark palette.
                .style("--tab-tint", d => `${30 - 18 * d.data.index / Math.max(1, d.data.totalInWindow - 1)}%`)
                .attr("role", "button")
                .attr("aria-label", d => d.data.title)
                .attr("tabindex", "0") // Make focusable
                .attr("transform", d => `translate(${d.x0 - windowNode.x0},${d.y0 - windowNode.y0})`)
                .on("click", handleTabClick)
                .on("mouseover", showTabTooltip)
                .on("mouseout", hideTooltip)
                .on("focus", handleCellFocus) // Add focus handler
                .on("blur", handleCellBlur)   // Add blur handler
                .each(function(d) {
                    const cell = d3.select(this);
                    const width = d.x1 - d.x0;
                    const height = d.y1 - d.y0;
                    
                    // Background rectangle
                    cell.append("rect")
                        .attr("width", width)
                        .attr("height", height)
                        .attr("rx", 2)
                        .attr("ry", 2);
                    
                    // Favicon
                    cell.append("image")
                        .attr("class", "favicon")
                        .attr("x", width / 2 - 8)
                        .attr("y", height / 2 - 8)
                        .attr("width", 16)
                        .attr("height", 16)
                        .on("error", function(event, d) {
                            // A stale favicon URL should not leave a broken-image glyph.
                            if (this.dataset.fallback) return;
                            this.dataset.fallback = "true";
                            d3.select(this).attr("href", getLetterFavicon(d.data.url));
                        })
                        .attr("href", d => d.data.favIconUrl || getLetterFavicon(d.data.url));
                });
        });

        // After rendering is complete, update the focusable elements list
        setTimeout(() => {
            refreshFocusableElements();
            console.log(`Found ${focusableElements.length} focusable tab elements`);
        }, 100);
    }
    
    /**
     * Generate letter-based favicon for URLs without an icon
     */
    function getLetterFavicon(url) {
        return createLetterFavicon(url);
    }

    /**
     * Show loading state
     */
    function showLoading() {
        const loadingEl = document.createElement("div");
        loadingEl.className = "loading";
        loadingEl.innerHTML = "<div class=\"spinner\"></div>";
        treemapContainer.appendChild(loadingEl);
    }
    
    /**
     * Hide loading state
     */
    function hideLoading() {
        const loadingEl = treemapContainer.querySelector(".loading");
        if (loadingEl) {
            loadingEl.remove();
        }
    }
    
    /**
     * Show empty state message
     */
    function showEmptyState(message) {
        hideLoading();
        
        const emptyStateEl = document.createElement("div");
        emptyStateEl.className = "empty-state";
        emptyStateEl.innerHTML = `
            <div class="empty-state-icon">📁</div>
            <div class="empty-state-text">${message || "No tabs open"}</div>
        `;
        treemapContainer.appendChild(emptyStateEl);
    }
    
    /**
     * Update statistics display
     */
    function updateStats(data) {
        const windowCount = data.children.length;
        let tabCount = 0;
        
        data.children.forEach(window => {
            tabCount += window.children.length;
        });
        
        tabCountEl.textContent = `${tabCount} tab${tabCount !== 1 ? "s" : ""}`;
        windowCountEl.textContent = `${windowCount} window${windowCount !== 1 ? "s" : ""}`;
    }
    
    /**
     * Handle tab click
     */
    function handleTabClick(event, d) {
        const tabId = d.data.id;
        const windowId = d.data.windowId;
        
        // Activate tab and focus window
        chrome.tabs.update(tabId, { active: true });
        chrome.windows.update(windowId, { focused: true });
        
        // Close popup
        window.close();
    }
    
    function renderTooltipContent(tabData, keyboard = false) {
        const title = document.createElement("div");
        title.className = "tooltip-title";
        title.textContent = tabData.title;
        const url = document.createElement("div");
        url.className = "tooltip-url";
        url.textContent = tabData.url;
        tooltip.replaceChildren(title, url);
        if (keyboard) {
            const hint = document.createElement("div");
            hint.className = "tooltip-hint";
            hint.textContent = "Press Enter to activate";
            tooltip.append(hint);
        }
    }

    /**
     * Show tooltip with tab info
     */
    function showTabTooltip(event, d) {
        const tabData = d.data;
        
        // Skip if already showing keyboard tooltip
        if (tooltip.classList.contains("keyboard-tooltip")) {
            return;
        }
        
        tooltip.style.display = "block";
        renderTooltipContent(tabData);
        
        // Position tooltip differently depending on whether it was triggered by mouse or keyboard
        if (event) {
            // Mouse-triggered tooltip
            let left = event.clientX - tooltip.offsetWidth / 2;
            let top = event.clientY - tooltip.offsetHeight - 10;
            
            // Keep tooltip within viewport
            if (left < 5) left = 5;
            if (left + tooltip.offsetWidth > window.innerWidth - 5) {
                left = window.innerWidth - tooltip.offsetWidth - 5;
            }
            
            // If tooltip would go above viewport, show it below
            if (top < 5) {
                top = event.clientY + 20;
            }
            
            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
        }
    }
    
    /**
     * Hide tooltip
     */
    function hideTooltip() {
        tooltip.style.display = "none";
    }
    
    /**
     * Handle cell focus event
     */
    function handleCellFocus(event, d) {
        // Mark the current element as focused
        d3.select(this).classed("keyboard-focused", true);
        
        // Show tooltip with a keyboard-specific class
        const tabData = d.data;
        
        tooltip.style.display = "block";
        tooltip.classList.add("keyboard-tooltip");
        renderTooltipContent(tabData, true);
        
        // Position tooltip near the focused cell
        const rect = event.target.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        
        let left = rect.left + rect.width / 2 - tooltipRect.width / 2;
        let top = rect.top - tooltipRect.height - 10;
        
        // Keep tooltip within viewport
        if (left < 5) left = 5;
        if (left + tooltipRect.width > window.innerWidth - 5) {
            left = window.innerWidth - tooltipRect.width - 5;
        }
        
        // If tooltip would go above viewport, show it below
        if (top < 5) {
            top = rect.bottom + 10;
        }
        
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
        
        // Update current focus index
        currentFocusIndex = focusableElements.indexOf(event.target);
        isKeyboardNavigating = true;
    }
    
    /**
     * Handle cell blur event
     */
    function handleCellBlur() {
        // Remove focus styling
        d3.select(this).classed("keyboard-focused", false);
        
        // Hide tooltip with a small delay to prevent flashing during focus changes
        setTimeout(() => {
            if (!document.activeElement.classList.contains("cell")) {
                tooltip.style.display = "none";
                tooltip.classList.remove("keyboard-tooltip");
            }
        }, 50);
    }
    
    /**
     * Handle keyboard navigation
     */
    function handleKeyNavigation(e) {
        // Only handle if we have focusable elements
        if (focusableElements.length === 0) return;

        // The query owns normal text-editing keys. Up/Down cross the boundary
        // into the filtered result set, matching the full-page recall SERPs.
        if (e.target === searchInput) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                moveFocusToIndex(e.key === "ArrowDown" ? 0 : focusableElements.length - 1);
            }
            return;
        }

        const traversingSearchResults = Boolean(searchInput?.value.trim());
        
        // Handle various key presses
        switch (e.key) {
            case "ArrowRight":
                e.preventDefault();
                moveFocus(1);
                break;
                
            case "ArrowLeft":
                e.preventDefault();
                moveFocus(-1);
                break;
                
            case "ArrowDown":
                e.preventDefault();
                if (traversingSearchResults) {
                    moveFocus(1);
                } else {
                    // Preserve spatial treemap navigation outside search mode.
                    const itemsPerRow = Math.max(1, Math.floor(treemapContainer.clientWidth / 50));
                    moveFocus(itemsPerRow);
                }
                break;
                
            case "ArrowUp":
                e.preventDefault();
                if (traversingSearchResults) {
                    moveFocus(-1);
                } else {
                    const itemsPerRowUp = Math.max(1, Math.floor(treemapContainer.clientWidth / 50));
                    moveFocus(-itemsPerRowUp);
                }
                break;
                
            case "Home":
                e.preventDefault();
                moveFocusToIndex(0);
                break;
                
            case "End":
                e.preventDefault();
                moveFocusToIndex(focusableElements.length - 1);
                break;
                
            case "Enter":
            case " ": // Space
                if (document.activeElement.classList.contains("cell")) {
                    e.preventDefault();
                    // Trigger activation of the focused tab
                    const focusedElement = document.activeElement;
                    const elementData = d3.select(focusedElement).datum();
                    handleTabClick(null, elementData);
                }
                break;
        }
    }
    
    /**
     * Move focus by relative offset
     */
    function moveFocus(offset) {
        // If nothing is focused, start with first element
        if (currentFocusIndex === -1) {
            currentFocusIndex = 0;
        } else {
            // Calculate new index with wrap-around
            currentFocusIndex = (currentFocusIndex + offset + focusableElements.length) % focusableElements.length;
        }
        
        // Focus the element
        if (focusableElements[currentFocusIndex]) {
            focusableElements[currentFocusIndex].focus();
        }
        
        isKeyboardNavigating = true;
    }
    
    /**
     * Move focus to specific index
     */
    function moveFocusToIndex(index) {
        if (index >= 0 && index < focusableElements.length) {
            currentFocusIndex = index;
            focusableElements[index].focus();
            isKeyboardNavigating = true;
        }
    }
    
    /**
     * Reset keyboard navigation when using mouse
     */
    function handleMouseMovement() {
        if (isKeyboardNavigating) {
            isKeyboardNavigating = false;
        }
    }
    
    /**
     * Setup event listeners
     */
    function setupEventListeners() {
        // Search
        searchInput.addEventListener("input", handleSearch);
        
        // Keyboard navigation
        document.addEventListener("keydown", handleKeyNavigation);
        
        // Mouse interaction
        document.addEventListener("mousemove", handleMouseMovement);
        
        // Update focusable elements list when window resizes
        window.addEventListener("resize", () => {
            setTimeout(() => {
                refreshFocusableElements();
            }, 200);
        });
    }
    
    /**
     * Handle search input
     */
    function handleSearch() {
        const query = searchInput.value.toLowerCase();
        // Filter tabs based on search
        d3.selectAll(".cell")
            .style("opacity", d => {
                const tabData = d.data;
                const matchesTitle = tabData.title.toLowerCase().includes(query);
                const matchesUrl = tabData.url.toLowerCase().includes(query);
                return (matchesTitle || matchesUrl || !query) ? 1 : 0.3;
            });
        refreshFocusableElements({ resetFocus: true });
    }

    function refreshFocusableElements({ resetFocus = false } = {}) {
        const query = searchInput?.value.toLowerCase() || "";
        focusableElements = Array.from(document.querySelectorAll(".cell")).filter(el => {
            const d = d3.select(el).datum();
            const title = d.data.title.toLowerCase();
            const url = d.data.url.toLowerCase();
            return !query || title.includes(query) || url.includes(query);
        });
        currentFocusIndex = resetFocus
            ? -1
            : focusableElements.indexOf(document.activeElement);
    }
});
