import {  exitSearchMode, clearSearchResults } from './search.js';
import { activateNode } from './treemap.js';

// Track currently focused elements
let currentFocusedNode = null;

export function handleKeyNavigation(event, node, data, state) {
    switch (event.key) {
        case ' ': // Space
            event.preventDefault();
            activateNode(node, data);
            break;
        case 'Enter':
            event.preventDefault();
            if (data.data.isBookmark) {
                chrome.tabs.create({ url: data.data.url, active: true });
            } else {
                const windowId = parseInt(data.data.windowId, 10);
                const tabId = parseInt(data.data.id.replace('tab', ''), 10);
                chrome.windows.update(windowId, { focused: true }, () => {
                    chrome.tabs.update(tabId, { active: true });
                });
            }
            break;
        case 'Tab':
            // Only handle Tab if we're in search mode
            if (document.querySelector('.cell-search-match')) {
                event.preventDefault();
                navigateSearchResults(event.shiftKey ? 'prev' : 'next');
            }
            break;
        case 'Escape':
            exitSearchMode();
            break;
        case 'ArrowRight':
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'ArrowDown':
            const nextNode = findClosestNodeInDirection(node, event.key, state.focusableNodes);
            if (nextNode) {
                nextNode.focus();
            }
            break;
    }
}

export function initializeKeyboardNavigation() {
    console.log('Initializing keyboard navigation...');
    
    // Make the treemap container focusable
    const treemap = document.getElementById('treemap');
    if (!treemap) {
        console.error('Treemap container not found');
        return;
    }
    
    // Make treemap focusable
    treemap.setAttribute('tabindex', '0');
    
    // Global keyboard event listener
    document.addEventListener('keydown', handleGlobalKeyboardNavigation);
    
    // Listen for focus and click events to manage focus states
    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('focusin', handleFocusIn);
    
    console.log('Keyboard navigation initialized');
}

// Handle global keyboard events
function handleGlobalKeyboardNavigation(event) {
    // Skip if we're in an input field
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
        return;
    }
    
    console.log('Keyboard nav event:', event.key);
    
    switch (event.key) {
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight':
            event.preventDefault();
            navigateTreemap(event.key);
            break;
        case 'Enter':
        case ' ': // Space
            event.preventDefault();
            activateCurrentNode();
            break;
        case 'Escape':
            event.preventDefault();
            clearAllFocus();
            break;
        case '/':
            event.preventDefault();
            focusSearch();
            break;
    }
}

// Clear focus from all elements and reset state
export function clearAllFocus() {
    console.log('Clearing all focus states');
    
    // Clear any selected cells
    d3.selectAll('.cell')
        .classed('cell-focused', false)
        .classed('cell-selected', false)
        .classed('keyboard-focused', false);
    
    // Clear current focus tracking
    currentFocusedNode = null;
    
    // Focus back on treemap container
    const treemap = document.getElementById('treemap');
    if (treemap) {
        treemap.focus();
    }
}

// Handle document clicks to clear keyboard focus when clicking
function handleDocumentClick(event) {
    // If clicking outside a cell, clear keyboard focus
    if (!event.target.closest('.cell')) {
        d3.selectAll('.cell').classed('keyboard-focused', false);
        currentFocusedNode = null;
    }
}

// Track when elements receive focus
function handleFocusIn(event) {
    // If focusing on the treemap container, clear cell focus
    if (event.target.id === 'treemap') {
        d3.selectAll('.cell').classed('keyboard-focused', false);
        currentFocusedNode = null;
    }
    
    // If focusing on a search input, clear cell focus
    if (event.target.id === 'tabSearch') {
        d3.selectAll('.cell').classed('keyboard-focused', false);
        currentFocusedNode = null;
    }
}

// Navigate between cells using keyboard
function navigateTreemap(direction) {
    console.log('Navigating treemap:', direction);
    
    const cells = d3.selectAll('.cell').nodes();
    if (cells.length === 0) return;
    
    // Find currently focused cell or start with first
    let currentIndex = -1;
    if (currentFocusedNode) {
        currentIndex = cells.indexOf(currentFocusedNode);
    }
    
    // Determine next cell to focus
    let nextIndex;
    switch (direction) {
        case 'ArrowRight':
            nextIndex = currentIndex < cells.length - 1 ? currentIndex + 1 : 0;
            break;
        case 'ArrowLeft':
            nextIndex = currentIndex > 0 ? currentIndex - 1 : cells.length - 1;
            break;
        case 'ArrowDown':
            // Find cell in row below current position
            nextIndex = findCellBelow(cells, currentFocusedNode);
            break;
        case 'ArrowUp':
            // Find cell in row above current position
            nextIndex = findCellAbove(cells, currentFocusedNode);
            break;
        default:
            nextIndex = 0;
    }
    
    // If no current focus, start with first cell
    if (currentIndex === -1) nextIndex = 0;
    
    // Update focus state
    setFocusToCell(cells[nextIndex]);
}

// Set focus to a specific cell
function setFocusToCell(cellElement) {
    if (!cellElement) return;
    
    console.log('Setting focus to cell');
    
    // Clear previous focus
    d3.selectAll('.cell').classed('keyboard-focused', false);
    
    // Set new focus
    d3.select(cellElement).classed('keyboard-focused', true);
    currentFocusedNode = cellElement;
    
    // Make cell focusable and focus it
    cellElement.setAttribute('tabindex', '0');
    cellElement.focus();
}

// Activate the currently focused node (same behavior as double-click)
function activateCurrentNode() {
    if (!currentFocusedNode) return;
    
    console.log('Activating current node');
    
    // Get data associated with node
    const nodeData = d3.select(currentFocusedNode).datum();
    if (!nodeData || !nodeData.data) return;
    
    // Implement double-click behavior
    if (nodeData.data.isBookmark) {
        // Handle bookmark - open in a new tab
        chrome.tabs.create({
            url: nodeData.data.url,
            active: true
        });
    } else {
        // Handle regular tab - focus window and activate tab
        const windowId = parseInt(nodeData.data.windowId, 10);
        const tabId = parseInt(nodeData.data.id, 10);
        
        // First focus the window
        chrome.windows.update(windowId, { focused: true }, () => {
            // Then activate the tab
            chrome.tabs.update(tabId, { active: true });
        });
    }
}

// Focus the search box
function focusSearch() {
    const searchInput = document.getElementById('tabSearch');
    if (searchInput) {
        searchInput.focus();
    }
}

// Helper functions for grid navigation
function findCellBelow(cells, currentCell) {
    if (!currentCell) return 0;
    
    // Get current cell position and dimensions
    const currentRect = currentCell.getBoundingClientRect();
    const currentCenterX = currentRect.left + currentRect.width / 2;
    const currentBottom = currentRect.bottom;
    
    // Find cells below current position
    const cellsBelow = cells.filter(cell => {
        const rect = cell.getBoundingClientRect();
        return rect.top >= currentBottom;
    });
    
    if (cellsBelow.length === 0) return 0;
    
    // Find the closest cell below
    let closestCell = cellsBelow[0];
    let minDistance = Number.MAX_VALUE;
    
    cellsBelow.forEach(cell => {
        const rect = cell.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const distance = Math.abs(centerX - currentCenterX);
        
        if (distance < minDistance) {
            minDistance = distance;
            closestCell = cell;
        }
    });
    
    return cells.indexOf(closestCell);
}

function findCellAbove(cells, currentCell) {
    if (!currentCell) return 0;
    
    // Get current cell position and dimensions
    const currentRect = currentCell.getBoundingClientRect();
    const currentCenterX = currentRect.left + currentRect.width / 2;
    const currentTop = currentRect.top;
    
    // Find cells above current position
    const cellsAbove = cells.filter(cell => {
        const rect = cell.getBoundingClientRect();
        return rect.bottom <= currentTop;
    });
    
    if (cellsAbove.length === 0) return 0;
    
    // Find the closest cell above
    let closestCell = cellsAbove[0];
    let minDistance = Number.MAX_VALUE;
    
    cellsAbove.forEach(cell => {
        const rect = cell.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const distance = Math.abs(centerX - currentCenterX);
        
        if (distance < minDistance) {
            minDistance = distance;
            closestCell = cell;
        }
    });
    
    return cells.indexOf(closestCell);
}

// Additional function to coordinate with search.js
export function focusCellById(id) {
    if (!id) return;
    
    const cell = d3.selectAll('.cell')
        .filter(d => d.data.id === id)
        .node();
    
    if (cell) {
        setFocusToCell(cell);
    }
}

function findClosestNodeInDirection(currentNode, direction, allNodes) {
    if (!currentNode || !allNodes?.length) return null;

    const currentRect = currentNode.getBoundingClientRect();
    const currentCenter = {
        x: currentRect.left + currentRect.width / 2,
        y: currentRect.top + currentRect.height / 2
    };

    // Filter nodes based on direction
    const candidates = allNodes.filter(node => {
        if (node === currentNode) return false;
        const rect = node.getBoundingClientRect();
        const center = {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
        };

        switch (direction) {
            case 'ArrowRight':
                return center.x > currentCenter.x;
            case 'ArrowLeft':
                return center.x < currentCenter.x;
            case 'ArrowUp':
                return center.y < currentCenter.y;
            case 'ArrowDown':
                return center.y > currentCenter.y;
            default:
                return false;
        }
    });

    // Find closest node in that direction
    return candidates.reduce((closest, node) => {
        const rect = node.getBoundingClientRect();
        const center = {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
        };
        const distance = Math.sqrt(
            Math.pow(center.x - currentCenter.x, 2) +
            Math.pow(center.y - currentCenter.y, 2)
        );
        
        if (!closest) return node;
        const closestRect = closest.getBoundingClientRect();
        const closestCenter = {
            x: closestRect.left + closestRect.width / 2,
            y: closestRect.top + closestRect.height / 2
        };
        const closestDistance = Math.sqrt(
            Math.pow(closestCenter.x - currentCenter.x, 2) +
            Math.pow(closestCenter.y - currentCenter.y, 2)
        );
        
        return distance < closestDistance ? node : closest;
    }, null);
}

function navigateSearchResults(direction) {
    const matches = Array.from(document.querySelectorAll('.cell-search-match'));
    if (!matches.length) return;

    const currentFocus = document.activeElement;
    const currentIndex = matches.indexOf(currentFocus);
    
    let nextIndex;
    if (direction === 'next') {
        nextIndex = currentIndex < matches.length - 1 ? currentIndex + 1 : 0;
    } else {
        nextIndex = currentIndex > 0 ? currentIndex - 1 : matches.length - 1;
    }

    matches[nextIndex].focus();
}