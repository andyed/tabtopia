/**
 * Debug tools for Tabtopia extension
 * Provides UI for inspecting and managing localStorage data
 */

document.addEventListener('DOMContentLoaded', () => {
    console.log('Debug UI initializing...');
    
    // Check if we're running in the Chrome extension context
    if (typeof chrome === 'undefined' || !chrome.runtime) {
        console.error('❌ Debug page opened outside Chrome extension context');
        document.body.innerHTML = `
            <div style="padding: 40px; text-align: center; font-family: Arial, sans-serif;">
                <h1 style="color: #e74c3c;">⚠️ Chrome Extension Context Required</h1>
                <p style="font-size: 18px; margin: 20px 0;">
                    This debug page must be opened within the Chrome extension context.
                </p>
                <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                    <h3>How to access debug tools:</h3>
                    <ol style="text-align: left; max-width: 500px; margin: 0 auto;">
                        <li>Open a new tab in Chrome (the extension's newtab page will load)</li>
                        <li>Look for a debug button or link in the extension interface</li>
                        <li>Click the debug button to open the debug tools</li>
                    </ol>
                </div>
                <p style="color: #666;">
                    Current URL: ${window.location.href}
                </p>
            </div>
        `;
        return;
    }
    
    // Force browserState init check
    setTimeout(async () => {
        console.log('Checking browserState initialization...');
        if (window.browserState) {
            console.log('browserState is available, loading initial data');
            try {
                const state = await window.browserState.getState();
                console.log('Initial state loaded:', state ? 'success' : 'empty');
                if (state) {
                    // Force reload of all data sections
                    loadHistoryData();
                    loadRelationshipData();
                    loadActivityData();
                    loadGraphData();
                    loadLocalStorageData();
                }
            } catch (err) {
                console.error('Failed to get initial state:', err);
            }
        } else {
            console.error('browserState not available after initialization');
        }
    }, 1000); // Wait 1 second after page load
    
    // Add global refresh button
    const header = document.querySelector('header');
    if (header) {
        const refreshButton = document.createElement('button');
        refreshButton.id = 'global-refresh-button';
        refreshButton.innerText = '🔄 Refresh All Data';
        refreshButton.className = 'action-button primary-action';
        refreshButton.style.marginLeft = 'auto';
        refreshButton.style.marginRight = '10px';
        refreshButton.addEventListener('click', async () => {
            console.log('Manually refreshing all debug data...');
            if (window.browserState && window.browserState.refreshState) {
                try {
                    await window.browserState.refreshState();
                    console.log('State refreshed, reloading all data tabs...');
                    // Reload all data sections
                    loadHistoryData();
                    loadRelationshipData();
                    loadActivityData();
                    loadGraphData();
                    loadNanoSummariesData();
                    loadLocalStorageData();
                    updateQueueStatus();
                    
                    // Flash animation to show refresh happened
                    refreshButton.classList.add('refreshing');
                    setTimeout(() => {
                        refreshButton.classList.remove('refreshing');
                    }, 500);
                } catch (error) {
                    console.error('Error refreshing data:', error);
                    alert('Error refreshing data: ' + error.message);
                }
            } else {
                console.error('browserState or refreshState method not available');
                alert('Cannot refresh: browserState not initialized');
            }
        });
        header.appendChild(refreshButton);
        
        // Add CSS for the refresh button
        const style = document.createElement('style');
        style.textContent = `
            #global-refresh-button.refreshing {
                animation: pulse 0.5s 1;
                background-color: #4CAF50;
                color: white;
            }
            @keyframes pulse {
                0% { transform: scale(1); }
                50% { transform: scale(1.1); }
                100% { transform: scale(1); }
            }
        `;
        document.head.appendChild(style);
    }
    
    // Initialize tabs
    initTabs();
    initGraphSubtabs();
    loadTabData();
    
    // Load data for the active tab
    const activeTab = document.querySelector('.tab-btn.active');
    const activeTabId = activeTab ? activeTab.getAttribute('data-tab') : 'history';
    loadTabData(activeTabId);
    
    // Initialize event listeners
    document.getElementById('refresh-storage').addEventListener('click', loadLocalStorageData);
    document.getElementById('export-json').addEventListener('click', exportLocalStorageAsJson);
    
    // Nano summaries event listeners
    document.getElementById('refresh-nano-summaries').addEventListener('click', loadNanoSummariesData);
    document.getElementById('clear-nano-summaries').addEventListener('click', clearNanoSummariesData);
    document.getElementById('nano-summaries-filter').addEventListener('input', filterNanoSummariesItems);
    document.getElementById('clear-summary-queue').addEventListener('click', clearSummaryQueueFromDebug);
    document.getElementById('process-summary-queue').addEventListener('click', processSummaryQueueFromDebug);
    document.getElementById('reset-crash-counter').addEventListener('click', resetCrashCounterFromDebug);
    document.getElementById('clear-all').addEventListener('click', clearAllStorage);
    document.getElementById('storage-filter').addEventListener('input', filterStorageItems);
    
    // Histospire-specific listeners
    document.getElementById('refresh-history')?.addEventListener('click', loadHistoryData);
    document.getElementById('clear-history')?.addEventListener('click', clearHistoryData);
    document.getElementById('history-filter')?.addEventListener('input', filterHistoryItems);
    
    document.getElementById('refresh-relationships')?.addEventListener('click', loadRelationshipData);
    document.getElementById('visualize-relationships')?.addEventListener('click', visualizeRelationships);
    document.getElementById('relationships-filter')?.addEventListener('input', filterRelationshipItems);
    
    document.getElementById('refresh-activity')?.addEventListener('click', loadActivityData);
    document.getElementById('clear-activity')?.addEventListener('click', clearActivityData);
    document.getElementById('activity-filter')?.addEventListener('input', filterActivityItems);
    document.getElementById('activity-type-filter')?.addEventListener('change', filterActivityItems);
    
    document.getElementById('refresh-graph-data')?.addEventListener('click', loadGraphData);
    document.getElementById('export-graph-data')?.addEventListener('click', exportGraphData);
    document.getElementById('clear-graph-data')?.addEventListener('click', clearGraphData);
    
    // Graph subtabs are initialized in initGraphSubtabs()
});

/**
 * Add this script to all pages to enable keyboard shortcut access to debug page
 * Alt+D will open the debug page
 */
if (window.location.href.indexOf('debug.html') === -1) {
    document.addEventListener('keydown', (event) => {
        // Alt+D shortcut to access debug page
        if (event.altKey && event.key === 'd') {
            event.preventDefault();
            window.location.href = 'debug.html';
        }
    });
}

/**
 * Initialize tab functionality
 */
function initTabs() {
    const tabButtons = document.querySelectorAll('.tab-btn');
    
    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            // Remove active class from all buttons and contents
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            
            // Add active class to clicked button and corresponding content
            button.classList.add('active');
            const tabId = button.getAttribute('data-tab');
            document.getElementById(tabId).classList.add('active');
            
            // Load data for the selected tab
            loadTabData(tabId);
        });
    });
}

/**
 * Initialize graph subtabs
 */
function initGraphSubtabs() {
    document.querySelectorAll('.graph-subtabs .tab-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            document.querySelectorAll('.graph-subtabs .tab-btn').forEach(btn => btn.classList.remove('active'));
            document.querySelectorAll('.subtab-content').forEach(content => content.classList.remove('active'));
            
            e.target.classList.add('active');
            const subtabId = e.target.getAttribute('data-subtab');
            document.getElementById(`${subtabId}-content`).classList.add('active');
            
            // Reload the appropriate data for the subtab
            switch(subtabId) {
                case 'graph-summaries':
                    loadGraphSummaries();
                    break;
                case 'graph-edges':
                    loadGraphEdges();
                    break;
                case 'graph-positions':
                    loadGraphPositions();
                    break;
            }
        });
    });
}

/**
 * Load data for the selected tab
 * @param {string} tabId - ID of the selected tab
 */
function loadTabData(tabId) {
    // Clear any existing loading indicators
    const loadingIndicator = document.getElementById('loading-indicator') || createLoadingIndicator();
    showLoadingIndicator(loadingIndicator, true);
    
    try {
        switch (tabId) {
            case 'history':
                loadHistoryData();
                break;
            case 'relationships':
                loadRelationshipData();
                break;
            case 'activity':
                loadActivityData();
                break;
            case 'graphs':
                loadGraphData();
                break;
            case 'nanoSummaries':
                loadNanoSummariesData();
                break;
            case 'localStorage':
                loadLocalStorageData();
                break;
            case 'sessionStorage':
                // Not implemented yet
                break;
            case 'indexedDB':
                // Not implemented yet
                break;
            case 'chrome':
                // Not implemented yet
                break;
        }
    } catch (error) {
        console.error(`Error loading data for tab ${tabId}:`, error);
    } finally {
        showLoadingIndicator(loadingIndicator, false);
    }
}

/**
 * Create a loading indicator element
 * @returns {HTMLElement} The loading indicator element
 */
function createLoadingIndicator() {
    // Check if it already exists
    let indicator = document.getElementById('loading-indicator');
    if (indicator) return indicator;
    
    // Create new indicator
    indicator = document.createElement('div');
    indicator.id = 'loading-indicator';
    indicator.textContent = 'Loading data...';
    indicator.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background-color: rgba(0, 0, 0, 0.7);
        color: white;
        padding: 10px 15px;
        border-radius: 4px;
        font-size: 14px;
        z-index: 1000;
        display: none;
    `;
    
    // Add to DOM
    document.body.appendChild(indicator);
    return indicator;
}

/**
 * Show or hide the loading indicator
 * @param {HTMLElement} indicator - The loading indicator element
 * @param {boolean} show - Whether to show or hide the indicator
 */
function showLoadingIndicator(indicator, show) {
    if (indicator) {
        indicator.style.display = show ? 'block' : 'none';
    }
}

/**
 * Load browsing history data from browserState
 */
async function loadHistoryData() {
    const historyContainer = document.getElementById('history-entries');
    if (!historyContainer) return;
    
    historyContainer.innerHTML = '<div class="loading">Loading browsing history...</div>';
    
    try {
        // Get browserState from the window object (it's defined in state.js)
        if (!window.browserState) {
            historyContainer.innerHTML = '<div class="error">Error: browserState not available</div>';
            return;
        }
        
        // Get state from browserState
        const state = await window.browserState.getState();
        console.log('Retrieved state for history:', state);
        console.log('tabHistory data:', state.tabHistory);
        console.log('tabHistory type:', typeof state.tabHistory);
        console.log('tabHistory length/size:', Array.isArray(state.tabHistory) ? state.tabHistory.length : state.tabHistory?.size || 'unknown');
        const tabHistory = state.tabHistory;
        
        if (!tabHistory || (Array.isArray(tabHistory) && tabHistory.length === 0) || 
            (tabHistory instanceof Map && tabHistory.size === 0)) {
            historyContainer.innerHTML = '<div class="info-message">No browsing history found</div>';
            updateHistoryStats(0);
            return;
        }
        
        // Process tabHistory into a flattened array of entries
        const historyEntries = [];
        let totalEntries = 0;
        
        console.log('Processing tabHistory...');
        
        // Handle both Map and Array formats
        if (tabHistory instanceof Map) {
            console.log('Processing as Map format');
            // Process as Map (original format)
            for (const [tabId, entries] of tabHistory.entries()) {
                totalEntries += entries.length;
                entries.forEach(entry => {
                    historyEntries.push({
                        tabId,
                        ...entry,
                    });
                });
            }
        } else if (Array.isArray(tabHistory)) {
            console.log('Processing as Array format');
            // Process as Array (format from background script)
            totalEntries = tabHistory.length;
            tabHistory.forEach(entry => {
                historyEntries.push(entry);
            });
        } else {
            console.error('Unknown tabHistory format:', tabHistory);
            historyContainer.innerHTML = '<div class="error">Error: Unknown tabHistory format</div>';
            return;
        }
        
        console.log('Processed history entries:', historyEntries.length);
        console.log('Sample entry:', historyEntries[0]);
        
        // Sort by timestamp (descending)
        historyEntries.sort((a, b) => b.timestamp - a.timestamp);
        
        // Update stats
        updateHistoryStats(historyEntries.length, totalEntries);
        
        // Render history entries
        console.log('Rendering history entries...');
        historyContainer.innerHTML = '';
        console.log('History container element:', historyContainer);
        console.log('History container innerHTML cleared');
        
        historyEntries.forEach((entry, index) => {
            console.log(`Creating element for entry ${index}:`, entry);
            const entryElement = createHistoryEntryElement(entry);
            historyContainer.appendChild(entryElement);
        });
        
        console.log('Finished rendering history entries');
        console.log('Final container innerHTML length:', historyContainer.innerHTML.length);
        
        // Add filter counts
        document.getElementById('history-total-count').textContent = historyEntries.length;
        document.getElementById('history-filtered-count').textContent = historyEntries.length;
        
    } catch (error) {
        console.error('Error loading browsing history:', error);
        historyContainer.innerHTML = `<div class="error">Error loading history: ${error.message}</div>`;
    }
}

/**
 * Update history statistics display
 * @param {number} visibleEntries - Number of visible entries
 * @param {number} totalEntries - Total number of entries
 */
function updateHistoryStats(visibleEntries, totalEntries = visibleEntries) {
    // If we add stats display elements later, update them here
    console.log(`History stats: ${visibleEntries} visible of ${totalEntries} total`);
}

/**
 * Create a DOM element for displaying a history entry
 * @param {Object} entry - The history entry
 * @returns {HTMLElement} - The entry element
 */
function createHistoryEntryElement(entry) {
    const itemElement = document.createElement('div');
    itemElement.className = 'storage-item';
    itemElement.dataset.tabId = entry.tabId;
    itemElement.dataset.url = entry.url;
    
    // Format timestamp
    const date = new Date(entry.timestamp);
    const formattedDate = date.toLocaleString();
    
    // Get favicon if available
    const faviconUrl = getFaviconUrl(entry.url);
    const faviconImg = faviconUrl ? `<img src="${faviconUrl}" class="favicon" onerror="this.style.display='none'" alt="" />` : '';
    
    // Create content
    itemElement.innerHTML = `
        <div class="storage-key">
            <span class="tab-id">${entry.tabId}</span>
            <br><small>${formattedDate}</small>
        </div>
        <div class="storage-value">
            ${faviconImg} ${escapeHtml(entry.title || entry.url)}
            <br><small>${escapeHtml(entry.url)}</small>
            ${entry.dwellTimeMs ? `<span class="dwell-time">${formatDuration(entry.dwellTimeMs)}</span>` : ''}
        </div>
        <div class="storage-actions">
            <button class="view-details" title="View details">👁️</button>
        </div>
    `;
    
    // Add event listeners
    const viewDetailsButton = itemElement.querySelector('.view-details');
    if (viewDetailsButton) {
        viewDetailsButton.addEventListener('click', () => {
            showHistoryEntryDetails(entry);
        });
    }
    
    return itemElement;
}

/**
 * Filter history items based on input text
 */
function filterHistoryItems() {
    const filterText = document.getElementById('history-filter').value.toLowerCase();
    const items = document.querySelectorAll('#history-entries .storage-item');
    let visibleCount = 0;
    
    items.forEach(item => {
        const url = item.dataset.url.toLowerCase();
        const tabId = item.dataset.tabId;
        const textContent = item.textContent.toLowerCase();
        
        if (url.includes(filterText) || tabId.includes(filterText) || textContent.includes(filterText)) {
            item.style.display = '';
            visibleCount++;
        } else {
            item.style.display = 'none';
        }
    });
    
    document.getElementById('history-filtered-count').textContent = visibleCount;
}

/**
 * Show details popup for a history entry
 * @param {Object} entry - The history entry
 */
function showHistoryEntryDetails(entry) {
    // Create modal if it doesn't exist
    let modal = document.getElementById('details-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'details-modal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content">
                <span class="close-modal">&times;</span>
                <h3>Entry Details</h3>
                <div id="modal-content"></div>
            </div>
        `;
        document.body.appendChild(modal);
        
        // Add close button functionality
        const closeBtn = modal.querySelector('.close-modal');
        closeBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });
        
        // Close on click outside
        window.addEventListener('click', (event) => {
            if (event.target === modal) {
                modal.style.display = 'none';
            }
        });
        
        // Add styles if needed
        const style = document.createElement('style');
        style.textContent = `
            .modal {
                display: none;
                position: fixed;
                z-index: 1000;
                left: 0;
                top: 0;
                width: 100%;
                height: 100%;
                background-color: rgba(0,0,0,0.4);
            }
            .modal-content {
                background-color: white;
                margin: 10% auto;
                padding: 20px;
                border-radius: 5px;
                width: 80%;
                max-width: 800px;
                max-height: 80vh;
                overflow-y: auto;
            }
            .close-modal {
                color: #aaa;
                float: right;
                font-size: 28px;
                font-weight: bold;
                cursor: pointer;
            }
            .close-modal:hover {
                color: black;
            }
            .detail-row {
                display: flex;
                padding: 8px 0;
                border-bottom: 1px solid #eee;
            }
            .detail-label {
                font-weight: bold;
                width: 30%;
            }
            .detail-value {
                width: 70%;
                word-break: break-all;
            }
        `;
        document.head.appendChild(style);
    }
    
    // Populate modal content
    const modalContent = modal.querySelector('#modal-content');
    modalContent.innerHTML = '';
    
    // Append all entry properties
    Object.entries(entry).forEach(([key, value]) => {
        const row = document.createElement('div');
        row.className = 'detail-row';
        
        let formattedValue = value;
        if (key === 'timestamp') {
            formattedValue = new Date(value).toLocaleString();
        } else if (key === 'dwellTimeMs') {
            formattedValue = `${value} ms (${formatDuration(value)})`;
        } else if (typeof value === 'object' && value !== null) {
            formattedValue = JSON.stringify(value, null, 2);
        }
        
        row.innerHTML = `
            <div class="detail-label">${key}</div>
            <div class="detail-value">${escapeHtml(String(formattedValue))}</div>
        `;
        
        modalContent.appendChild(row);
    });
    
    // Add additional information if available
    if (window.browserState) {
        // Add a section for looking up related data
        const actionSection = document.createElement('div');
        actionSection.className = 'detail-row action-section';
        actionSection.innerHTML = `
            <div class="detail-label">Actions</div>
            <div class="detail-value">
                <button id="find-related-tabs">Find Related Tabs</button>
                <button id="find-related-activity">Find Activity</button>
            </div>
        `;
        modalContent.appendChild(actionSection);
        
        // Add event listeners for actions
        actionSection.querySelector('#find-related-tabs').addEventListener('click', () => {
            findRelatedTabs(entry.tabId);
        });
        
        actionSection.querySelector('#find-related-activity').addEventListener('click', () => {
            findRelatedActivity(entry.tabId, entry.url);
        });
    }
    
    // Show the modal
    modal.style.display = 'block';
}

/**
 * Find related tabs for a given tab ID
 * @param {string} tabId - The tab ID to find related tabs for
 */
function findRelatedTabs(tabId) {
    // Switch to relationships tab
    const relationshipsTab = document.querySelector('.tab-btn[data-tab="relationships"]');
    if (relationshipsTab) {
        relationshipsTab.click();
        
        // Set the filter to the tab ID
        const filter = document.getElementById('relationships-filter');
        if (filter) {
            filter.value = tabId;
            filterRelationshipItems();
        }
    }
}

/**
 * Find activity for a given tab ID and URL
 * @param {string} tabId - The tab ID
 * @param {string} url - The URL
 */
function findRelatedActivity(tabId, url) {
    // Switch to activity tab
    const activityTab = document.querySelector('.tab-btn[data-tab="activity"]');
    if (activityTab) {
        activityTab.click();
        
        // Set the filter to the tab ID
        const filter = document.getElementById('activity-filter');
        if (filter) {
            filter.value = tabId;
            filterActivityItems();
        }
    }
}

/**
 * Clear browsing history data
 */
function clearHistoryData() {
    if (confirm('Are you sure you want to clear browsing history data?')) {
        // Send message to background script to clear history
        chrome.runtime.sendMessage({ 
            action: 'clearTabHistory' 
        }, (response) => {
            if (response && response.success) {
                loadHistoryData(); // Reload the data
                alert('Browsing history cleared successfully');
            } else {
                alert('Failed to clear browsing history');
            }
        });
    }
}

/**
 * Get favicon URL for a given URL
 * @param {string} url - The URL to get the favicon for
 * @returns {string} - The favicon URL
 */
function getFaviconUrl(url) {
    try {
        const urlObj = new URL(url);
        return `chrome://favicon/${urlObj.origin}`;
    } catch (e) {
        return '';
    }
}

/**
 * Format duration in milliseconds to a human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} - Formatted duration string
 */
function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
}

/**
 * Load tab relationship data from browserState
 */
async function loadRelationshipData() {
    const relationshipContainer = document.getElementById('relationship-entries');
    if (!relationshipContainer) return;
    
    relationshipContainer.innerHTML = '<div class="loading">Loading tab relationships...</div>';
    
    try {
        if (!window.browserState) {
            relationshipContainer.innerHTML = '<div class="error">Error: browserState not available</div>';
            return;
        }
        
        const state = await window.browserState.getState();
        console.log('Retrieved state for relationships:', state);
        const tabRelationships = state.tabRelationships;
        
        if (!tabRelationships || 
            (tabRelationships instanceof Map && tabRelationships.size === 0) ||
            (Array.isArray(tabRelationships) && tabRelationships.length === 0)) {
            relationshipContainer.innerHTML = '<div class="info-message">No tab relationships found</div>';
            return;
        }
        
        // Process relationships into an array
        const relationshipEntries = [];
        
        // Handle both Map and Array formats
        if (tabRelationships instanceof Map) {
            // Process as Map (original format)
            for (const [tabId, relationship] of tabRelationships.entries()) {
                relationshipEntries.push({
                    tabId,
                    ...relationship
                });
            }
        } else if (Array.isArray(tabRelationships)) {
            // Process as Array (format from background script)
            tabRelationships.forEach(entry => {
                relationshipEntries.push(entry);
            });
        } else {
            console.error('Unknown tabRelationships format:', tabRelationships);
            relationshipContainer.innerHTML = '<div class="error">Error: Unknown relationship format</div>';
            return;
        }
        
        // Sort by most recent first if creation time is available
        relationshipEntries.sort((a, b) => {
            if (a.creationTime && b.creationTime) {
                return b.creationTime - a.creationTime;
            }
            return 0;
        });
        
        // Render relationships
        relationshipContainer.innerHTML = '';
        relationshipEntries.forEach(entry => {
            const entryElement = createRelationshipElement(entry);
            relationshipContainer.appendChild(entryElement);
        });
        
    } catch (error) {
        console.error('Error loading tab relationships:', error);
        relationshipContainer.innerHTML = `<div class="error">Error loading relationships: ${error.message}</div>`;
    }
}

/**
 * Create a DOM element for displaying a relationship entry
 * @param {Object} relationship - The relationship entry
 * @returns {HTMLElement} - The entry element
 */
function createRelationshipElement(relationship) {
    const itemElement = document.createElement('div');
    itemElement.className = 'storage-item relationship-item';
    itemElement.dataset.tabId = relationship.tabId;
    if (relationship.referringTabId) itemElement.dataset.referringTabId = relationship.referringTabId;
    
    // Get creation time if available
    let timeDisplay = '';
    if (relationship.creationTime) {
        const date = new Date(relationship.creationTime);
        timeDisplay = `<br><small>${date.toLocaleString()}</small>`;
    }
    
    // Create content
    itemElement.innerHTML = `
        <div class="storage-key">
            <span class="tab-id">${relationship.tabId}</span>${timeDisplay}
        </div>
        <div class="storage-value">
            ${relationship.referringTabId ? 
                `Opened from <span class="referring-tab">Tab ${relationship.referringTabId}</span>` : 
                'Root tab (no referrer)'}
            ${relationship.referringURL ? 
                `<br><small>From: ${escapeHtml(relationship.referringURL)}</small>` : ''}
            ${relationship.linkText ? 
                `<br><span class="link-text">${escapeHtml(relationship.linkText)}</span>` : ''}
        </div>
        <div class="storage-actions">
            <button class="view-details" title="View details">👁️</button>
        </div>
    `;
    
    // Add event listeners
    const viewDetailsButton = itemElement.querySelector('.view-details');
    if (viewDetailsButton) {
        viewDetailsButton.addEventListener('click', () => {
            showRelationshipDetails(relationship);
        });
    }
    
    return itemElement;
}

/**
 * Filter relationship items based on input text
 */
function filterRelationshipItems() {
    const filterText = document.getElementById('relationships-filter').value.toLowerCase();
    const items = document.querySelectorAll('#relationship-entries .storage-item');
    let visibleCount = 0;
    
    items.forEach(item => {
        const tabId = item.dataset.tabId;
        const referringTabId = item.dataset.referringTabId || '';
        const textContent = item.textContent.toLowerCase();
        
        if (tabId.includes(filterText) || referringTabId.includes(filterText) || textContent.includes(filterText)) {
            item.style.display = '';
            visibleCount++;
        } else {
            item.style.display = 'none';
        }
    });
}

/**
 * Show details popup for a relationship entry
 * @param {Object} relationship - The relationship entry
 */
function showRelationshipDetails(relationship) {
    // Reuse the same modal as history details
    showHistoryEntryDetails(relationship);
}

/**
 * Visualize tab relationships in a graph
 */
function visualizeRelationships() {
    // Create modal if it doesn't exist
    let modal = document.getElementById('visualization-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'visualization-modal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content full-size">
                <span class="close-modal">&times;</span>
                <h3>Tab Relationship Graph</h3>
                <div id="graph-container" style="width: 100%; height: 500px;"></div>
            </div>
        `;
        document.body.appendChild(modal);
        
        // Add close button functionality
        const closeBtn = modal.querySelector('.close-modal');
        closeBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });
        
        // Close on click outside
        window.addEventListener('click', (event) => {
            if (event.target === modal) {
                modal.style.display = 'none';
            }
        });
        
        // Add styles
        const style = document.createElement('style');
        style.textContent = `
            .full-size {
                width: 90%;
                max-width: 1200px;
                height: 80%;
            }
        `;
        document.head.appendChild(style);
    }
    
    // Show the modal
    modal.style.display = 'block';
    
    // Load relationship data for visualization
    loadRelationshipsForGraph();
}

/**
 * Load relationship data for graph visualization
 */
async function loadRelationshipsForGraph() {
    const graphContainer = document.getElementById('graph-container');
    if (!graphContainer) return;
    
    graphContainer.innerHTML = 'Loading graph data...';
    
    try {
        if (!window.browserState) {
            graphContainer.innerHTML = 'Error: browserState not available';
            return;
        }
        
        const state = await window.browserState.getState();
        const tabRelationships = state.tabRelationships;
        
        if (!tabRelationships || tabRelationships.size === 0) {
            graphContainer.innerHTML = 'No tab relationships found';
            return;
        }
        
        // Check if D3 is available
        if (!window.d3) {
            // Try to load D3 dynamically
            try {
                await loadScript('/src/lib/d3.min.js');
            } catch (e) {
                graphContainer.innerHTML = 'Error: D3.js not available. Unable to visualize relationships.';
                return;
            }
        }
        
        // Now create the graph
        createRelationshipGraph(graphContainer, tabRelationships);
        
    } catch (error) {
        console.error('Error loading graph data:', error);
        graphContainer.innerHTML = `Error loading graph data: ${error.message}`;
    }
}

/**
 * Create a force-directed graph of tab relationships
 * @param {HTMLElement} container - Container for the graph
 * @param {Map} tabRelationships - Tab relationships data
 */
function createRelationshipGraph(container, tabRelationships) {
    // Clear the container
    container.innerHTML = '';
    
    // Set up the data structures for D3
    const nodes = [];
    const links = [];
    const nodeMap = new Map();
    
    // First pass: create all nodes
    for (const [tabId, relationship] of tabRelationships.entries()) {
        if (!nodeMap.has(tabId)) {
            const node = { id: tabId, group: 1 };
            nodes.push(node);
            nodeMap.set(tabId, node);
        }
        
        // Make sure referring tab is also a node
        if (relationship.referringTabId && !nodeMap.has(relationship.referringTabId)) {
            const node = { id: relationship.referringTabId, group: 2 };
            nodes.push(node);
            nodeMap.set(relationship.referringTabId, node);
        }
    }
    
    // Second pass: create links
    for (const [tabId, relationship] of tabRelationships.entries()) {
        if (relationship.referringTabId) {
            links.push({
                source: relationship.referringTabId,
                target: tabId,
                value: 1,
                linkText: relationship.linkText || ''
            });
        }
    }
    
    // Set up the SVG
    const width = container.clientWidth;
    const height = container.clientHeight || 500;
    
    const svg = d3.select(container).append('svg')
        .attr('width', width)
        .attr('height', height);
    
    // Create the simulation
    const simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id(d => d.id).distance(100))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('center', d3.forceCenter(width / 2, height / 2));
    
    // Draw the links
    const link = svg.append('g')
        .selectAll('line')
        .data(links)
        .enter().append('line')
        .attr('stroke', '#999')
        .attr('stroke-opacity', 0.6)
        .attr('stroke-width', d => Math.sqrt(d.value));
    
    // Draw the nodes
    const node = svg.append('g')
        .selectAll('circle')
        .data(nodes)
        .enter().append('circle')
        .attr('r', 5)
        .attr('fill', d => d.group === 1 ? '#3498db' : '#e74c3c')
        .call(drag(simulation));
    
    // Add node labels
    const label = svg.append('g')
        .selectAll('text')
        .data(nodes)
        .enter().append('text')
        .attr('font-size', 10)
        .attr('dx', 8)
        .attr('dy', '.35em')
        .text(d => d.id);
    
    // Update positions on tick
    simulation.on('tick', () => {
        link
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);
        
        node
            .attr('cx', d => d.x)
            .attr('cy', d => d.y);
        
        label
            .attr('x', d => d.x)
            .attr('y', d => d.y);
    });
    
    // Drag functionality
    function drag(simulation) {
        function dragstarted(event) {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            event.subject.fx = event.subject.x;
            event.subject.fy = event.subject.y;
        }
        
        function dragged(event) {
            event.subject.fx = event.x;
            event.subject.fy = event.y;
        }
        
        function dragended(event) {
            if (!event.active) simulation.alphaTarget(0);
            event.subject.fx = null;
            event.subject.fy = null;
        }
        
        return d3.drag()
            .on('start', dragstarted)
            .on('drag', dragged)
            .on('end', dragended);
    }
}

/**
 * Load script dynamically
 * @param {string} src - Script source URL
 * @returns {Promise} - Promise that resolves when script is loaded
 */
function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
        document.head.appendChild(script);
    });
}

/**
 * Load graph data from browserState
 */
async function loadGraphData() {
    const graphDataContainer = document.getElementById('graph-data');
    if (!graphDataContainer) return;
    
    // Find active subtab
    const activeSubtab = document.querySelector('.graph-subtabs .tab-btn.active');
    const activeSubtabId = activeSubtab ? activeSubtab.getAttribute('data-subtab') : 'graph-summaries';
    
    // Load data based on active subtab
    switch (activeSubtabId) {
        case 'graph-summaries':
            loadGraphSummaries();
            break;
        case 'graph-edges':
            loadGraphEdges();
            break;
        case 'graph-positions':
            loadGraphPositions();
            break;
    }
}

/**
 * Load graph summaries data
 */
async function loadGraphSummaries() {
    const container = document.getElementById('graph-summaries-content');
    if (!container) return;
    
    container.innerHTML = '<div class="loading">Loading graph summaries...</div>';
    
    try {
        if (!window.browserState) {
            container.innerHTML = '<div class="error">Error: browserState not available</div>';
            return;
        }
        
        const state = await window.browserState.getState();
        console.log('Retrieved state for graph summaries:', state);
        console.log('graphData object:', state.graphData);
        console.log('graphData type:', typeof state.graphData);
        console.log('graphData keys:', state.graphData ? Object.keys(state.graphData) : 'null');
        const graphData = state.graphData?.summaries;
        
        if (!graphData || Object.keys(graphData).length === 0) {
            container.innerHTML = `
                <div class="info-message">
                    <h4>No graph summaries found</h4>
                    <p>Graph summaries are generated when you browse websites and the Chrome Summarizer API creates nano summaries.</p>
                    <p>Try browsing some websites and then check back here to see generated summaries.</p>
                </div>`;
            return;
        }
        
        // Display graph summaries
        container.innerHTML = '';
        
        for (const [key, value] of Object.entries(graphData)) {
            const itemElement = document.createElement('div');
            itemElement.className = 'storage-item';
            itemElement.dataset.key = key;
            
            itemElement.innerHTML = `
                <div class="storage-key">${escapeHtml(key)}</div>
                <div class="storage-value">${escapeHtml(JSON.stringify(value, null, 2))}</div>
                <div class="storage-actions">
                    <button class="view-details" title="View details">👁️</button>
                </div>
            `;
            
            // Add event listeners
            const viewDetailsButton = itemElement.querySelector('.view-details');
            if (viewDetailsButton) {
                viewDetailsButton.addEventListener('click', () => {
                    showGraphDataDetails(key, value);
                });
            }
            
            container.appendChild(itemElement);
        }
        
    } catch (error) {
        console.error('Error loading graph summaries:', error);
        container.innerHTML = `<div class="error">Error loading graph summaries: ${error.message}</div>`;
    }
}

/**
 * Load graph edges data
 */
async function loadGraphEdges() {
    const container = document.getElementById('graph-edges-content');
    if (!container) return;
    
    container.innerHTML = '<div class="loading">Loading graph edges...</div>';
    
    try {
        if (!window.browserState) {
            container.innerHTML = '<div class="error">Error: browserState not available</div>';
            return;
        }
        
        const state = await window.browserState.getState();
        console.log('Retrieved state for graph edges:', state);
        console.log('graphData for edges:', state.graphData);
        const graphData = state.graphData?.customEdges || (state.graphData && Array.isArray(state.graphData.edges) ? state.graphData.edges : []);
        
        if (!graphData || graphData.length === 0) {
            container.innerHTML = `
                <div class="info-message">
                    <h4>No custom graph edges found</h4>
                    <p>Custom edges are created when you interact with the graph visualization and create connections between nodes.</p>
                    <p>Try using the graph visualization feature to create some custom edges.</p>
                </div>`;
            return;
        }
        
        // Display graph edges
        container.innerHTML = '';
        
        graphData.forEach((edge, index) => {
            const itemElement = document.createElement('div');
            itemElement.className = 'storage-item';
            itemElement.dataset.index = index;
            
            // Format source and target nodes
            const sourceNode = edge.source ? `${edge.source.id || 'Unknown'}` : 'Unknown';
            const targetNode = edge.target ? `${edge.target.id || 'Unknown'}` : 'Unknown';
            
            itemElement.innerHTML = `
                <div class="storage-key">Edge ${index + 1}</div>
                <div class="storage-value">
                    <strong>From:</strong> ${escapeHtml(sourceNode)}<br>
                    <strong>To:</strong> ${escapeHtml(targetNode)}<br>
                    <strong>Type:</strong> ${edge.type || 'standard'}
                </div>
                <div class="storage-actions">
                    <button class="view-details" title="View details">👁️</button>
                </div>
            `;
            
            // Add event listeners
            const viewDetailsButton = itemElement.querySelector('.view-details');
            if (viewDetailsButton) {
                viewDetailsButton.addEventListener('click', () => {
                    showGraphDataDetails(`Edge ${index + 1}`, edge);
                });
            }
            
            container.appendChild(itemElement);
        });
        
    } catch (error) {
        console.error('Error loading graph edges:', error);
        container.innerHTML = `<div class="error">Error loading graph edges: ${error.message}</div>`;
    }
}

/**
 * Load graph node positions data
 */
async function loadGraphPositions() {
    const container = document.getElementById('graph-positions-content');
    if (!container) return;
    
    container.innerHTML = '<div class="loading">Loading node positions...</div>';
    
    try {
        if (!window.browserState) {
            container.innerHTML = '<div class="error">Error: browserState not available</div>';
            return;
        }
        
        const state = await window.browserState.getState();
        console.log('Retrieved state for graph positions:', state);
        console.log('graphData for positions:', state.graphData);
        const graphData = state.graphData?.nodePositions || (state.graphData && state.graphData.positions ? state.graphData.positions : {});
        
        if (!graphData || Object.keys(graphData).length === 0) {
            container.innerHTML = `
                <div class="info-message">
                    <h4>No node positions found</h4>
                    <p>Node positions are saved when you move nodes around in the graph visualization.</p>
                    <p>Try using the graph visualization feature and moving some nodes to save their positions.</p>
                </div>`;
            return;
        }
        
        // Display node positions
        container.innerHTML = '';
        
        for (const [nodeId, position] of Object.entries(graphData)) {
            const itemElement = document.createElement('div');
            itemElement.className = 'storage-item';
            itemElement.dataset.nodeId = nodeId;
            
            itemElement.innerHTML = `
                <div class="storage-key">${escapeHtml(nodeId)}</div>
                <div class="storage-value">
                    <strong>X:</strong> ${position.x || 0}<br>
                    <strong>Y:</strong> ${position.y || 0}
                </div>
                <div class="storage-actions">
                    <button class="view-details" title="View details">👁️</button>
                </div>
            `;
            
            // Add event listeners
            const viewDetailsButton = itemElement.querySelector('.view-details');
            if (viewDetailsButton) {
                viewDetailsButton.addEventListener('click', () => {
                    showGraphDataDetails(nodeId, position);
                });
            }
            
            container.appendChild(itemElement);
        }
        
    } catch (error) {
        console.error('Error loading node positions:', error);
        container.innerHTML = `<div class="error">Error loading node positions: ${error.message}</div>`;
    }
}

/**
 * Show details popup for graph data
 * @param {string} key - The key or identifier
 * @param {Object} data - The data object
 */
function showGraphDataDetails(key, data) {
    // Use same modal as history details
    showHistoryEntryDetails({ id: key, data: data });
}

/**
 * Export graph data as JSON
 */
function exportGraphData() {
    window.browserState.getState().then(state => {
        const graphData = state.graphData || {};
        const jsonContent = JSON.stringify(graphData, null, 2);
        const blob = new Blob([jsonContent], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        // Create download link
        const a = document.createElement('a');
        a.href = url;
        a.download = 'histospire-graph-data.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }).catch(error => {
        console.error('Error exporting graph data:', error);
        alert('Failed to export graph data: ' + error.message);
    });
}

/**
 * Clear graph data
 */
function clearGraphData() {
    if (confirm('Are you sure you want to clear graph data? This will remove custom edges, node positions, and summaries.')) {
        // Send message to background script to clear graph data
        chrome.runtime.sendMessage({ 
            action: 'clearGraphData' 
        }, (response) => {
            if (response && response.success) {
                loadGraphData(); // Reload the data
                alert('Graph data cleared successfully');
            } else {
                alert('Failed to clear graph data');
            }
        });
    }
}

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} unsafe - The unsafe string
 * @returns {string} - HTML-escaped string
 */
function escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return String(unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Load activity log data from browserState
 */
async function loadActivityData() {
    const activityContainer = document.getElementById('activity-entries');
    if (!activityContainer) return;
    
    activityContainer.innerHTML = '<div class="loading">Loading activity log...</div>';
    
    try {
        if (!window.browserState) {
            activityContainer.innerHTML = '<div class="error">Error: browserState not available</div>';
            return;
        }
        
        const state = await window.browserState.getState();
        console.log('Retrieved state for activity:', state);
        const tabActivityLog = state.tabActivityLog;
        
        if (!tabActivityLog || 
            (tabActivityLog instanceof Map && tabActivityLog.size === 0) || 
            (Array.isArray(tabActivityLog) && tabActivityLog.length === 0)) {
            activityContainer.innerHTML = '<div class="info-message">No activity log found</div>';
            return;
        }
        
        // Process activity log into an array
        const activityEntries = [];
        
        console.log('Processing tabActivityLog:', tabActivityLog);
        console.log('tabActivityLog type:', typeof tabActivityLog);
        console.log('tabActivityLog is Array:', Array.isArray(tabActivityLog));
        console.log('tabActivityLog is Map:', tabActivityLog instanceof Map);
        
        // Handle both Map and Array formats
        if (tabActivityLog instanceof Map) {
            console.log('Processing as Map format');
            // Process as Map (original format)
            for (const [tabId, activities] of tabActivityLog.entries()) {
                console.log(`Processing tab ${tabId}:`, activities);
                if (Array.isArray(activities)) {
                    activities.forEach(activity => {
                        console.log('Activity from array:', activity);
                        activityEntries.push({
                            tabId,
                            ...activity
                        });
                    });
                } else if (typeof activities === 'object' && activities !== null) {
                    console.log('Activity from object:', activities);
                    activityEntries.push({
                        tabId,
                        ...activities
                    });
                }
            }
        } else if (Array.isArray(tabActivityLog)) {
            console.log('Processing as Array format');
            // Process as Array (format from background script)
            tabActivityLog.forEach((entry, index) => {
                console.log(`Activity entry ${index}:`, entry);
                activityEntries.push(entry);
            });
        } else {
            console.error('Unknown tabActivityLog format:', tabActivityLog);
            activityContainer.innerHTML = '<div class="error">Error: Unknown activity log format</div>';
            return;
        }
        
        console.log('Processed activity entries:', activityEntries);
        console.log('Sample activity entry:', activityEntries[0]);
        
        // Sort by timestamp (descending)
        activityEntries.sort((a, b) => b.timestamp - a.timestamp);
        
        // Render activity entries
        console.log('Rendering activity entries...');
        activityContainer.innerHTML = '';
        activityEntries.forEach((entry, index) => {
            console.log(`Creating element for activity ${index}:`, entry);
            const entryElement = createActivityElement(entry);
            activityContainer.appendChild(entryElement);
        });
        
    } catch (error) {
        console.error('Error loading activity log:', error);
        activityContainer.innerHTML = `<div class="error">Error loading activity log: ${error.message}</div>`;
    }
}

/**
 * Create a DOM element for displaying an activity entry
 * @param {Object} activity - The activity entry
 * @returns {HTMLElement} - The entry element
 */
function createActivityElement(activity) {
    console.log('Creating activity element for:', activity);
    console.log('Activity properties:', Object.keys(activity));
    
    const itemElement = document.createElement('div');
    itemElement.className = 'storage-item';
    itemElement.dataset.tabId = activity.tabId || 'unknown';
    
    // Format timestamps
    const firstSeenDate = activity.firstSeen ? new Date(activity.firstSeen) : null;
    const lastTouchDate = activity.lastTouch ? new Date(activity.lastTouch) : null;
    
    const formattedFirstSeen = firstSeenDate ? firstSeenDate.toLocaleString() : 'Unknown';
    const formattedLastTouch = lastTouchDate ? lastTouchDate.toLocaleString() : 'Unknown';
    
    // Count events and navigations
    const eventCount = activity.events ? activity.events.length : 0;
    const navigationCount = activity.navigations ? activity.navigations.length : 0;
    
    // Format total time spent
    const totalTimeFormatted = activity.totalTimeSpent ? 
        Math.round(activity.totalTimeSpent / 1000) + 's' : '0s';
    
    // Get sample event info
    let sampleEvent = 'No events';
    if (activity.events && activity.events.length > 0) {
        const firstEvent = activity.events[0];
        sampleEvent = firstEvent.type || 'Unknown event';
        if (firstEvent.url) {
            sampleEvent += ` - ${firstEvent.url.substring(0, 50)}...`;
        }
    }
    
    // Create content
    itemElement.innerHTML = `
        <div class="storage-key">
            <span class="tab-id">${activity.tabId || 'Unknown'}</span>
            <br><small>First seen: ${formattedFirstSeen}</small>
            <br><small>Last touch: ${formattedLastTouch}</small>
        </div>
        <div class="storage-value">
            <strong>Total time: ${totalTimeFormatted}</strong><br>
            <small>Events: ${eventCount} | Navigations: ${navigationCount}</small><br>
            <small>Sample: ${escapeHtml(sampleEvent)}</small>
        </div>
        <div class="storage-actions">
            <button class="view-details" title="View details">👁️</button>
        </div>
    `;
    
    // Add event listeners
    const viewDetailsButton = itemElement.querySelector('.view-details');
    if (viewDetailsButton) {
        viewDetailsButton.addEventListener('click', () => {
            showActivityDetails(activity);
        });
    }
    
    return itemElement;
}

/**
 * Filter activity items based on input text and type
 */
function filterActivityItems() {
    const filterText = document.getElementById('activity-filter').value.toLowerCase();
    const filterType = document.getElementById('activity-type-filter').value;
    const items = document.querySelectorAll('#activity-entries .storage-item');
    let visibleCount = 0;
    
    items.forEach(item => {
        const tabId = item.dataset.tabId;
        const type = item.dataset.type;
        const textContent = item.textContent.toLowerCase();
        
        const matchesText = tabId.includes(filterText) || textContent.includes(filterText);
        const matchesType = filterType === 'all' || type === filterType;
        
        if (matchesText && matchesType) {
            item.style.display = '';
            visibleCount++;
        } else {
            item.style.display = 'none';
        }
    });
}

/**
 * Show details popup for an activity entry
 * @param {Object} activity - The activity entry
 */
function showActivityDetails(activity) {
    // Create a detailed view of the activity
    let detailsHtml = `
        <h3>Activity Details for Tab ${activity.tabId || 'Unknown'}</h3>
        <div class="activity-summary">
            <p><strong>Total Time Spent:</strong> ${activity.totalTimeSpent ? Math.round(activity.totalTimeSpent / 1000) + 's' : '0s'}</p>
            <p><strong>First Seen:</strong> ${activity.firstSeen ? new Date(activity.firstSeen).toLocaleString() : 'Unknown'}</p>
            <p><strong>Last Touch:</strong> ${activity.lastTouch ? new Date(activity.lastTouch).toLocaleString() : 'Unknown'}</p>
            <p><strong>Total Events:</strong> ${activity.events ? activity.events.length : 0}</p>
            <p><strong>Total Navigations:</strong> ${activity.navigations ? activity.navigations.length : 0}</p>
        </div>
    `;
    
    // Show events if available
    if (activity.events && activity.events.length > 0) {
        detailsHtml += '<h4>Events:</h4><div class="events-list">';
        activity.events.forEach((event, index) => {
            detailsHtml += `
                <div class="event-item">
                    <strong>Event ${index + 1}:</strong> ${event.type || 'Unknown'}<br>
                    <small>Time: ${event.timestamp ? new Date(event.timestamp).toLocaleString() : 'Unknown'}</small>
                    ${event.url ? `<br><small>URL: ${escapeHtml(event.url)}</small>` : ''}
                    ${event.linkText ? `<br><small>Link: ${escapeHtml(event.linkText)}</small>` : ''}
                </div>
            `;
        });
        detailsHtml += '</div>';
    }
    
    // Show navigations if available
    if (activity.navigations && activity.navigations.length > 0) {
        detailsHtml += '<h4>Navigations:</h4><div class="navigations-list">';
        activity.navigations.forEach((nav, index) => {
            detailsHtml += `
                <div class="navigation-item">
                    <strong>Navigation ${index + 1}:</strong><br>
                    <small>Time: ${nav.timestamp ? new Date(nav.timestamp).toLocaleString() : 'Unknown'}</small>
                    ${nav.url ? `<br><small>URL: ${escapeHtml(nav.url)}</small>` : ''}
                    ${nav.title ? `<br><small>Title: ${escapeHtml(nav.title)}</small>` : ''}
                </div>
            `;
        });
        detailsHtml += '</div>';
    }
    
    // Show the details in a modal
    showModal('Activity Details', detailsHtml);
}

/**
 * Clear activity log data
 */
function clearActivityData() {
    if (confirm('Are you sure you want to clear the activity log?')) {
        // Send message to background script to clear activity log
        chrome.runtime.sendMessage({ 
            action: 'clearTabActivityLog' 
        }, (response) => {
            if (response && response.success) {
                loadActivityData(); // Reload the data
                alert('Activity log cleared successfully');
            } else {
                alert('Failed to clear activity log');
            }
        });
    }
}

/**
 * Load and display all localStorage data
 */
function loadLocalStorageData() {
    const storageItems = document.getElementById('storage-items');
    storageItems.innerHTML = '';
    
    let totalSize = 0;
    let largestKey = '';
    let largestSize = 0;
    
    try {
        // Get all localStorage items
        const keys = Object.keys(localStorage).sort();
        
        // Update stats
        document.getElementById('localStorage-count').textContent = keys.length;
        document.getElementById('total-count').textContent = keys.length;
        document.getElementById('filtered-count').textContent = keys.length;
        
        // Process each key
        keys.forEach(key => {
            try {
                const value = localStorage.getItem(key);
                const size = new Blob([value]).size;
                totalSize += size;
                
                if (size > largestSize) {
                    largestSize = size;
                    largestKey = key;
                }
                
                // Create item element
                const itemElement = createStorageItemElement(key, value, size);
                storageItems.appendChild(itemElement);
            } catch (e) {
                console.error(`Error processing key: ${key}`, e);
            }
        });
        
        // Update size info
        document.getElementById('localStorage-size').textContent = formatSize(totalSize);
        document.getElementById('largest-key').textContent = largestKey ? `${largestKey} (${formatSize(largestSize)})` : '-';
        
        // Attempt to find install date
        try {
            const installDate = localStorage.getItem('installDate') || 'Unknown';
            document.getElementById('install-date').textContent = installDate !== 'Unknown' ? 
                new Date(parseInt(installDate)).toLocaleDateString() : 'Unknown';
        } catch (e) {
            document.getElementById('install-date').textContent = 'Error parsing date';
        }
        
    } catch (e) {
        console.error('Error loading localStorage data', e);
        storageItems.innerHTML = `<div class="storage-item"><div class="storage-value">Error accessing localStorage: ${e.message}</div></div>`;
    }
}

/**
 * Create a DOM element for displaying a localStorage item
 */
function createStorageItemElement(key, value, size) {
    const itemElement = document.createElement('div');
    itemElement.className = 'storage-item';
    itemElement.dataset.key = key;
    
    // Try to parse JSON for pretty display
    let displayValue = value;
    let isJson = false;
    
    try {
        const parsed = JSON.parse(value);
        if (typeof parsed === 'object' && parsed !== null) {
            displayValue = JSON.stringify(parsed, null, 2);
            isJson = true;
        }
    } catch (e) {
        // Not JSON, use as is
    }
    
    itemElement.innerHTML = `
        <div class="storage-key">${escapeHtml(key)}<br><small>${formatSize(size)}</small></div>
        <div class="storage-value">${isJson ? escapeHtml(displayValue) : escapeHtml(value)}</div>
        <div class="storage-actions">
            <button class="delete-item" title="Delete this item">🗑️</button>
            ${isJson ? '<button class="expand-item" title="Expand/collapse">⤢</button>' : ''}
        </div>
    `;
    
    // Add event listeners
    const deleteButton = itemElement.querySelector('.delete-item');
    deleteButton.addEventListener('click', () => {
        if (confirm(`Are you sure you want to delete "${key}" from localStorage?`)) {
            localStorage.removeItem(key);
            itemElement.remove();
            loadLocalStorageData(); // Reload to update stats
        }
    });
    
    // Add expand/collapse functionality for JSON
    if (isJson) {
        const expandButton = itemElement.querySelector('.expand-item');
        expandButton.addEventListener('click', () => {
            const valueElement = itemElement.querySelector('.storage-value');
            valueElement.classList.toggle('expanded');
            expandButton.textContent = valueElement.classList.contains('expanded') ? '⤡' : '⤢';
        });
    }
    
    return itemElement;
}

/**
 * Filter storage items based on input text
 */
function filterStorageItems() {
    const filterText = document.getElementById('storage-filter').value.toLowerCase();
    const items = document.querySelectorAll('.storage-item');
    let visibleCount = 0;
    
    items.forEach(item => {
        const key = item.dataset.key.toLowerCase();
        if (key.includes(filterText)) {
            item.style.display = '';
            visibleCount++;
        } else {
            item.style.display = 'none';
        }
    });
    
    document.getElementById('filtered-count').textContent = visibleCount;
}

/**
 * Export localStorage data as a downloadable JSON file
 */
function exportLocalStorageAsJson() {
    try {
        const storageData = {};
        
        // Get all localStorage items
        Object.keys(localStorage).forEach(key => {
            let value = localStorage.getItem(key);
            
            // Try to parse JSON values
            try {
                value = JSON.parse(value);
            } catch (e) {
                // Not JSON, use as is
            }
            
            storageData[key] = value;
        });
        
        // Create a blob with the data
        const jsonString = JSON.stringify(storageData, null, 2);
        const blob = new Blob([jsonString], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        
        // Create a link and trigger download
        const a = document.createElement('a');
        a.href = url;
        a.download = `tabtopia-storage-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        
        // Clean up
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 0);
        
    } catch (e) {
        console.error('Error exporting localStorage data', e);
        alert(`Error exporting data: ${e.message}`);
    }
}

/**
 * Clear all localStorage data with confirmation
 */
function clearAllStorage() {
    if (confirm('Are you sure you want to delete ALL localStorage data? This cannot be undone.')) {
        if (confirm('LAST WARNING: This will delete ALL your browsing data stored by Tabtopia. Continue?')) {
            try {
                localStorage.clear();
                loadLocalStorageData();
                alert('All localStorage data has been cleared.');
            } catch (e) {
                console.error('Error clearing localStorage', e);
                alert(`Error clearing data: ${e.message}`);
            }
        }
    }
}

/**
 * Format byte size to human readable format
 */
function formatSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') {
        return String(unsafe);
    }
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Load nano summaries data from chrome.storage.local
 */
async function loadNanoSummariesData() {
    const container = document.getElementById('nano-summaries-entries');
    if (!container) return;
    
    container.innerHTML = '<div class="loading">Loading nano summaries...</div>';
    
    try {
        // Check if Chrome API is available
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
            container.innerHTML = `
                <div class="info-message">
                    <h4>Chrome API Not Available</h4>
                    <p>This debug page must be opened within the Chrome extension context.</p>
                    <p>Please open this page from the extension's newtab page or popup.</p>
                </div>`;
            return;
        }
        
        const result = await chrome.storage.local.get(['nanoSummaries']);
        const summaries = result.nanoSummaries || {};
        
        if (Object.keys(summaries).length === 0) {
            container.innerHTML = '<div class="info-message">No nano summaries found</div>';
            updateNanoSummariesStats(0);
            return;
        }
        
        // Convert to array and sort by timestamp (newest first)
        const summaryEntries = Object.entries(summaries).map(([url, data]) => ({
            url,
            ...data
        })).sort((a, b) => b.timestamp - a.timestamp);
        
        // Update stats
        updateNanoSummariesStats(summaryEntries.length);
        
        // Render summaries
        container.innerHTML = '';
        summaryEntries.forEach(entry => {
            const entryElement = createNanoSummaryElement(entry);
            container.appendChild(entryElement);
        });
        
        // Update filter counts
        document.getElementById('nano-summaries-total-count').textContent = summaryEntries.length;
        document.getElementById('nano-summaries-filtered-count').textContent = summaryEntries.length;
        
    } catch (error) {
        console.error('Error loading nano summaries:', error);
        container.innerHTML = `<div class="error">Error loading nano summaries: ${error.message}</div>`;
    }
}

/**
 * Create a DOM element for displaying a nano summary entry
 * @param {Object} entry - The summary entry
 * @returns {HTMLElement} - The entry element
 */
function createNanoSummaryElement(entry) {
    const itemElement = document.createElement('div');
    itemElement.className = 'storage-item';
    itemElement.dataset.url = entry.url;
    
    // Format timestamp
    const date = new Date(entry.timestamp);
    const formattedDate = date.toLocaleString();
    
    // Get favicon if available
    const faviconUrl = getFaviconUrl(entry.url);
    const faviconImg = faviconUrl ? `<img src="${faviconUrl}" class="favicon" onerror="this.style.display='none'" alt="" />` : '';
    
    // Truncate summary for display
    const truncatedSummary = entry.summary.length > 200 
        ? entry.summary.substring(0, 200) + '...' 
        : entry.summary;
    
    // Create content
    itemElement.innerHTML = `
        <div class="storage-key">
            ${faviconImg} ${escapeHtml(formatUrlForDisplay(entry.url))}
            <br><small>${formattedDate}</small>
            <br><small>Source: ${entry.source || 'unknown'}</small>
        </div>
        <div class="storage-value">
            <div class="summary-text">${escapeHtml(truncatedSummary)}</div>
        </div>
        <div class="storage-actions">
            <button class="view-details" title="View full summary">👁️</button>
            <button class="delete-item" title="Delete this summary">🗑️</button>
        </div>
    `;
    
    // Add event listeners
    const viewDetailsButton = itemElement.querySelector('.view-details');
    if (viewDetailsButton) {
        viewDetailsButton.addEventListener('click', () => {
            showNanoSummaryDetails(entry);
        });
    }
    
    const deleteButton = itemElement.querySelector('.delete-item');
    if (deleteButton) {
        deleteButton.addEventListener('click', () => {
            deleteNanoSummary(entry.url);
        });
    }
    
    return itemElement;
}

/**
 * Show details popup for a nano summary entry
 * @param {Object} entry - The summary entry
 */
function showNanoSummaryDetails(entry) {
    // Reuse the same modal as history details
    showHistoryEntryDetails({
        url: entry.url,
        summary: entry.summary,
        timestamp: entry.timestamp,
        source: entry.source,
        type: 'nano-summary'
    });
}

/**
 * Delete a specific nano summary
 * @param {string} url - The URL of the summary to delete
 */
async function deleteNanoSummary(url) {
    if (confirm(`Are you sure you want to delete the summary for "${formatUrlForDisplay(url)}"?`)) {
        try {
            const result = await chrome.storage.local.get(['nanoSummaries']);
            const summaries = result.nanoSummaries || {};
            
            delete summaries[url];
            
            await chrome.storage.local.set({ nanoSummaries: summaries });
            
            // Reload the data
            loadNanoSummariesData();
            
            console.log(`Deleted nano summary for ${url}`);
        } catch (error) {
            console.error('Error deleting nano summary:', error);
            alert('Error deleting summary: ' + error.message);
        }
    }
}

/**
 * Clear all nano summaries
 */
async function clearNanoSummariesData() {
    if (confirm('Are you sure you want to clear all nano summaries? This cannot be undone.')) {
        try {
            await chrome.storage.local.remove(['nanoSummaries']);
            loadNanoSummariesData();
            alert('All nano summaries cleared successfully');
        } catch (error) {
            console.error('Error clearing nano summaries:', error);
            alert('Error clearing summaries: ' + error.message);
        }
    }
}

/**
 * Filter nano summary items based on input text
 */
function filterNanoSummariesItems() {
    const filterText = document.getElementById('nano-summaries-filter').value.toLowerCase();
    const items = document.querySelectorAll('#nano-summaries-entries .storage-item');
    let visibleCount = 0;
    
    items.forEach(item => {
        const url = item.dataset.url.toLowerCase();
        const textContent = item.textContent.toLowerCase();
        
        if (url.includes(filterText) || textContent.includes(filterText)) {
            item.style.display = '';
            visibleCount++;
        } else {
            item.style.display = 'none';
        }
    });
    
    document.getElementById('nano-summaries-filtered-count').textContent = visibleCount;
}

/**
 * Update nano summaries statistics display
 * @param {number} count - Number of summaries
 */
function updateNanoSummariesStats(count) {
    console.log(`Nano summaries stats: ${count} summaries`);
}

/**
 * Clear summary queue from debug tools
 */
function clearSummaryQueueFromDebug() {
    if (confirm('Are you sure you want to clear the summary queue?')) {
        if (typeof window.clearSummaryQueue === 'function') {
            window.clearSummaryQueue();
            alert('Summary queue cleared successfully');
        } else {
            alert('Summary queue functions not available');
        }
    }
}

/**
 * Manually trigger summary queue processing from debug tools
 */
function processSummaryQueueFromDebug() {
    if (typeof window.processSummaryQueue === 'function') {
        window.processSummaryQueue().catch(error => {
            console.error('Error processing queue:', error);
            alert('Error processing queue: ' + error.message);
        });
        alert('Queue processing started');
    } else {
        alert('Summary queue functions not available');
    }
}

/**
 * Reset summarizer crash counter from debug tools
 */
function resetCrashCounterFromDebug() {
    if (typeof window.resetSummarizerCrashCounter === 'function') {
        window.resetSummarizerCrashCounter();
        alert('Summarizer crash counter reset successfully');
    } else {
        alert('Summarizer functions not available');
    }
}

/**
 * Format URL for display (remove http:// and www.)
 * @param {string} url - The URL to format
 * @returns {string} - Formatted URL
 */
function formatUrlForDisplay(url) {
    if (!url) return '';
    
    return url
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '');
}

/**
 * Update queue status display in debug tools
 */
function updateQueueStatus() {
    try {
        // Check if we have access to the queue functions
        if (typeof window.getQueueStats === 'function') {
            const stats = window.getQueueStats();
            
            const queueStatusElement = document.getElementById('summary-queue-status');
            const processingStatusElement = document.getElementById('queue-processing-status');
            
            if (queueStatusElement) {
                queueStatusElement.textContent = `${stats.queueSize} items`;
                queueStatusElement.style.color = stats.queueSize > 0 ? '#e67e22' : '#27ae60';
            }
            
            if (processingStatusElement) {
                processingStatusElement.textContent = stats.isProcessing ? 'Processing...' : 'Idle';
                processingStatusElement.style.color = stats.isProcessing ? '#e67e22' : '#27ae60';
            }
        } else {
            // Fallback if queue functions aren't available
            const queueStatusElement = document.getElementById('summary-queue-status');
            const processingStatusElement = document.getElementById('queue-processing-status');
            
            if (queueStatusElement) {
                queueStatusElement.textContent = 'Unknown';
                queueStatusElement.style.color = '#7f8c8d';
            }
            
            if (processingStatusElement) {
                processingStatusElement.textContent = 'Unknown';
                processingStatusElement.style.color = '#7f8c8d';
            }
        }
        
        // Update summarizer status
        if (typeof window.getSummarizerStatus === 'function') {
            const summarizerStatus = window.getSummarizerStatus();
            const summarizerStatusElement = document.getElementById('summarizer-status');
            
            if (summarizerStatusElement) {
                if (summarizerStatus.inBackoff) {
                    summarizerStatusElement.textContent = `Backoff (${summarizerStatus.backoffRemainingSeconds}s)`;
                    summarizerStatusElement.style.color = '#e74c3c';
                } else if (summarizerStatus.crashCount > 0) {
                    summarizerStatusElement.textContent = `Crashes: ${summarizerStatus.crashCount}`;
                    summarizerStatusElement.style.color = '#f39c12';
                } else {
                    summarizerStatusElement.textContent = 'Ready';
                    summarizerStatusElement.style.color = '#27ae60';
                }
            }
        } else {
            const summarizerStatusElement = document.getElementById('summarizer-status');
            if (summarizerStatusElement) {
                summarizerStatusElement.textContent = 'Unknown';
                summarizerStatusElement.style.color = '#7f8c8d';
            }
        }
    } catch (error) {
        console.error('Error updating queue status:', error);
    }
}

// Set up periodic queue status updates
setInterval(updateQueueStatus, 2000); // Update every 2 seconds
