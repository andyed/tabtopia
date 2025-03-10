/**
 * Lightweight treemap visualization for Chrome extension popup
 */

document.addEventListener('DOMContentLoaded', () => {
    // Get DOM elements
    const treemapContainer = document.getElementById('popup-treemap');
    const searchInput = document.getElementById('popupSearch');
    const tabCountEl = document.getElementById('tabCount');
    const windowCountEl = document.getElementById('windowCount');
    const tooltip = document.getElementById('tooltip');

    
    // Add these variables at the top level inside your DOMContentLoaded event handler
    const windowColorCache = new Map();
    const colorPalettes = {};
    
    // Add these variables at the top of your script
    let focusableElements = [];
    let currentFocusIndex = -1;
    let isKeyboardNavigating = false;
    
    // Initialize loading state
    showLoading();
    
    // Initialize D3 treemap
    const width = treemapContainer.clientWidth;
    const height = treemapContainer.clientHeight;
    
    const svg = d3.select('#popup-treemap')
        .append('svg')
        .attr('width', width)
        .attr('height', height);
    
    const root = svg.append('g');
    
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
            console.error('Error fetching browser data:', error);
            showEmptyState('Could not load tab data. Please try again.');
        });
    
    /**
     * Fetch browser tab data (windows and tabs)
     */
    async function fetchBrowserData() {
        return new Promise((resolve) => {
            chrome.windows.getAll({ populate: true }, windows => {
                const hierarchicalData = {
                    name: 'root',
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
                                title: tab.title || 'Untitled',
                                url: tab.url || '',
                                favIconUrl: tab.favIconUrl || getLetterFavicon(tab.url || ''),
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
        root.selectAll('*').remove();
        
        // Debug data
        console.log("Rendering treemap with data:", data);
        
        // Check if we have valid data
        if (!data || !data.children || data.children.length === 0) {
            showEmptyState('No browser windows found');
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
        const windows = root.selectAll('.window')
            .data(hierarchy.children)
            .enter()
            .append('g')
            .attr('class', 'window')
            .attr('transform', d => `translate(${d.x0},${d.y0})`);
        
        // Add window background
        windows.append('rect')
            .attr('width', d => d.x1 - d.x0)
            .attr('height', d => d.y1 - d.y0)
            .attr('fill', '#2f2b26')
            .attr('stroke', d => d.data.focused ? '#64b5f6' : '#403c36')
            .attr('stroke-width', d => d.data.focused ? 2 : 1)
            .attr('rx', 3)
            .attr('ry', 3);
        
        // Add window label
        windows.append('text')
            .attr('class', 'window-label')
            .attr('x', 4)
            .attr('y', 12)
            .text(d => `Window ${d.data.id}`);
        
        // Add cells for each tab
        windows.each(function(windowNode) {
            d3.select(this).selectAll('.cell')
                .data(windowNode.children || [])
                .enter()
                .append('g')
                .attr('class', 'cell')
                .attr('tabindex', '0') // Make focusable
                .attr('transform', d => `translate(${d.x0 - windowNode.x0},${d.y0 - windowNode.y0})`)
                .on('click', handleTabClick)
                .on('mouseover', showTabTooltip)
                .on('mouseout', hideTooltip)
                .on('focus', handleCellFocus) // Add focus handler
                .on('blur', handleCellBlur)   // Add blur handler
                .each(function(d) {
                    const cell = d3.select(this);
                    const width = d.x1 - d.x0;
                    const height = d.y1 - d.y0;
                    
                    // Background rectangle
                    cell.append('rect')
                        .attr('width', width)
                        .attr('height', height)
                        .attr('fill', d => getColorForTab(d.data))
                        .attr('rx', 2)
                        .attr('ry', 2)
                        // Add a stroke for active tabs
                        .attr('stroke', d => d.data.active ? '#ffffff' : 'none')
                        .attr('stroke-width', d => d.data.active ? 1 : 0);
                    
                    // Favicon
                    cell.append('image')
                        .attr('class', 'favicon')
                        .attr('x', width / 2 - 8)
                        .attr('y', height / 2 - 8)
                        .attr('width', 16)
                        .attr('height', 16)
                        .attr('href', d => d.data.favIconUrl || getLetterFavicon(d.data.url));
                });
        });

        // After rendering is complete, update the focusable elements list
        setTimeout(() => {
            focusableElements = Array.from(document.querySelectorAll('.cell'));
            console.log(`Found ${focusableElements.length} focusable tab elements`);
        }, 100);
    }
    
    /**
     * Generate letter-based favicon for URLs without an icon
     */
    function getLetterFavicon(url) {
        try {
            // Get first letter of domain
            let letter = '?';
            
            if (url.startsWith('chrome://')) {
                const parts = url.split('/');
                letter = parts[2] ? parts[2].charAt(0).toUpperCase() : 'C';
            } 
            else if (url.startsWith('file://')) {
                letter = 'F';
            }
            else {
                try {
                    const domain = new URL(url).hostname;
                    letter = domain.charAt(0).toUpperCase();
                } catch (e) {
                    letter = url.charAt(0).toUpperCase();
                }
            }
            
            // Generate color based on letter
            const colors = [
                '#F44336', '#E91E63', '#9C27B0', '#673AB7', '#3F51B5', 
                '#2196F3', '#03A9F4', '#00BCD4', '#009688', '#4CAF50',
                '#8BC34A', '#CDDC39', '#FFC107', '#FF9800', '#FF5722'
            ];
            
            const colorIndex = letter.charCodeAt(0) % colors.length;
            const color = colors[colorIndex];
            
            // Create SVG data URI
            const svg = `
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
                    <rect width="16" height="16" fill="${color}" rx="2" ry="2"/>
                    <text x="8" y="12" font-family="Arial, sans-serif" font-size="10" 
                          fill="white" text-anchor="middle" font-weight="bold">${letter}</text>
                </svg>
            `;
            
            return `data:image/svg+xml;base64,${btoa(svg)}`;
        } catch (error) {
            console.error('Error generating letter favicon:', error);
            return 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiBmaWxsPSIjNzU3NTc1IiByeD0iMiIgcnk9IjIiLz48dGV4dCB4PSI4IiB5PSIxMiIgZm9udC1mYW1pbHk9IkFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjEwIiBmaWxsPSJ3aGl0ZSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC13ZWlnaHQ9ImJvbGQiPj88L3RleHQ+PC9zdmc+';
        }
    }
    
    /**
     * Generate a color palette for a window
     * @param {number} windowId - Window identifier
     * @returns {Array} Color palette with gradient colors
     */
    function getWindowPalette(windowId) {
        // Return cached palette if we already generated one for this window
        if (colorPalettes[windowId]) {
            return colorPalettes[windowId];
        }
        
        // Generate a base color from window ID
        // Windows get a distinct hue from the color wheel
        let baseHue;
        
        if (windowColorCache.has(windowId)) {
            baseHue = windowColorCache.get(windowId);
        } else {
            // Generate a unique color based on window ID
            // Space them evenly around the color wheel
            baseHue = (windowId * 137.5) % 360; // Golden angle approximation for good distribution
            windowColorCache.set(windowId, baseHue);
        }
        
        // Generate a palette of colors with varying lightness and saturation
        const palette = [];
        const paletteSize = 20; // More than enough colors for tabs in a window
        
        // Active tab gets a more saturated version
        const activeColor = `hsl(${baseHue}, 70%, 45%)`;
        
        // Generate gradient from light to dark
        for (let i = 0; i < paletteSize; i++) {
            // More recent tabs get brighter colors
            const lightness = 40 - (i * 1.2); // 40% down to 16%
            const saturation = 50 - (i * 1.5); // 50% down to 20%
            palette.push(`hsl(${baseHue}, ${saturation}%, ${lightness}%)`);
        }
        
        // Store active color as the first one (index -1)
        palette[-1] = activeColor;
        
        // Cache the palette
        colorPalettes[windowId] = palette;
        
        return palette;
    }
    
    /**
     * Get color for a tab based on its state and recency
     */
    function getColorForTab(tab) {
        const palette = getWindowPalette(tab.windowId);
        
        // Active tabs get special treatment
        if (tab.active) {
            return palette[-1]; // Use the active color
        }
        
        // Use the tab's index to determine its color
        // This represents recency order since we sorted earlier
        const colorIndex = Math.min(tab.index, palette.length - 1);
        return palette[colorIndex];
    }
    
    /**
     * Show loading state
     */
    function showLoading() {
        const loadingEl = document.createElement('div');
        loadingEl.className = 'loading';
        loadingEl.innerHTML = '<div class="spinner"></div>';
        treemapContainer.appendChild(loadingEl);
    }
    
    /**
     * Hide loading state
     */
    function hideLoading() {
        const loadingEl = treemapContainer.querySelector('.loading');
        if (loadingEl) {
            loadingEl.remove();
        }
    }
    
    /**
     * Show empty state message
     */
    function showEmptyState(message) {
        hideLoading();
        
        const emptyStateEl = document.createElement('div');
        emptyStateEl.className = 'empty-state';
        emptyStateEl.innerHTML = `
            <div class="empty-state-icon">📁</div>
            <div class="empty-state-text">${message || 'No tabs open'}</div>
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
        
        tabCountEl.textContent = `${tabCount} tab${tabCount !== 1 ? 's' : ''}`;
        windowCountEl.textContent = `${windowCount} window${windowCount !== 1 ? 's' : ''}`;
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
    
    /**
     * Show tooltip with tab info
     */
    function showTabTooltip(event, d) {
        const tabData = d.data;
        
        // Skip if already showing keyboard tooltip
        if (tooltip.classList.contains('keyboard-tooltip')) {
            return;
        }
        
        tooltip.style.display = 'block';
        tooltip.innerHTML = `
            <div>${tabData.title}</div>
            <div style="font-size:10px; color:#9e9e9e; margin-top:4px; overflow:hidden; text-overflow:ellipsis;">${tabData.url}</div>
        `;
        
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
        tooltip.style.display = 'none';
    }
    
    /**
     * Handle cell focus event
     */
    function handleCellFocus(event, d) {
        // Mark the current element as focused
        d3.select(this).classed('keyboard-focused', true);
        
        // Show tooltip with a keyboard-specific class
        const tabData = d.data;
        
        tooltip.style.display = 'block';
        tooltip.classList.add('keyboard-tooltip');
        tooltip.innerHTML = `
            <div><strong>${tabData.title}</strong></div>
            <div style="font-size:10px; color:#9e9e9e; margin-top:4px; overflow:hidden; text-overflow:ellipsis;">${tabData.url}</div>
            <div style="margin-top:8px; font-size:11px; color:#aaa;">Press Enter to activate</div>
        `;
        
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
        d3.select(this).classed('keyboard-focused', false);
        
        // Hide tooltip with a small delay to prevent flashing during focus changes
        setTimeout(() => {
            if (!document.activeElement.classList.contains('cell')) {
                tooltip.style.display = 'none';
                tooltip.classList.remove('keyboard-tooltip');
            }
        }, 50);
    }
    
    /**
     * Handle keyboard navigation
     */
    function handleKeyNavigation(e) {
        // Only handle if we have focusable elements
        if (focusableElements.length === 0) return;
        
        // Handle various key presses
        switch (e.key) {
            case 'ArrowRight':
                e.preventDefault();
                moveFocus(1);
                break;
                
            case 'ArrowLeft':
                e.preventDefault();
                moveFocus(-1);
                break;
                
            case 'ArrowDown':
                e.preventDefault();
                // Estimate number of items per row based on container width
                const itemsPerRow = Math.max(1, Math.floor(treemapContainer.clientWidth / 50));
                moveFocus(itemsPerRow);
                break;
                
            case 'ArrowUp':
                e.preventDefault();
                const itemsPerRowUp = Math.max(1, Math.floor(treemapContainer.clientWidth / 50));
                moveFocus(-itemsPerRowUp);
                break;
                
            case 'Home':
                e.preventDefault();
                moveFocusToIndex(0);
                break;
                
            case 'End':
                e.preventDefault();
                moveFocusToIndex(focusableElements.length - 1);
                break;
                
            case 'Enter':
            case ' ': // Space
                if (document.activeElement.classList.contains('cell')) {
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
        searchInput.addEventListener('input', handleSearch);
        
        // Keyboard navigation
        document.addEventListener('keydown', handleKeyNavigation);
        
        // Mouse interaction
        document.addEventListener('mousemove', handleMouseMovement);
        
        // Update focusable elements list when window resizes
        window.addEventListener('resize', () => {
            setTimeout(() => {
                focusableElements = Array.from(document.querySelectorAll('.cell'));
            }, 200);
        });
    }
    
    /**
     * Handle search input
     */
    function handleSearch() {
        const query = searchInput.value.toLowerCase();
        
        // Filter tabs based on search
        d3.selectAll('.cell')
            .style('opacity', d => {
                const tabData = d.data;
                const matchesTitle = tabData.title.toLowerCase().includes(query);
                const matchesUrl = tabData.url.toLowerCase().includes(query);
                return (matchesTitle || matchesUrl || !query) ? 1 : 0.3;
            });
    }
});