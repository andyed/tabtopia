export function handleKeyNavigation(event, node, data, focusableNodes, categorizedDataCache) {
    const key = event.key;
    const currentIndex = parseInt(node.getAttribute('tabindex'));
    let nextIndex = currentIndex;

    switch (key) {
        case 'Enter':
            // Navigate to tab on Enter key
            const enterTabId = parseInt(data.data.id.replace(/\D/g, ''), 10);
            const windowId = parseInt(data.data.windowId, 10);
            if (!isNaN(windowId) && !isNaN(enterTabId)) {
                chrome.windows.update(windowId, { focused: true }, () => {
                    chrome.tabs.update(enterTabId, { active: true });
                });
                console.log(`Navigating to window: ${windowId}, tab: ${enterTabId}`);
            } else {
                console.warn('Invalid window or tab ID:', { windowId, tabId: enterTabId, data: data.data });
            }
            event.preventDefault();
            break;
        case ' ':
            // Simulate click behavior
            displayReadout(data.data, true, categorizedDataCache); // Access through data.data
            event.preventDefault();
            break;
        case 'ArrowRight':
            nextIndex = findClosestNodeInDirection('right', currentIndex, focusableNodes);
            event.preventDefault();
            break;
        case 'ArrowLeft':
            nextIndex = findClosestNodeInDirection('left', currentIndex, focusableNodes);
            event.preventDefault();
            break;
        case 'ArrowUp':
            nextIndex = findClosestNodeInDirection('up', currentIndex, focusableNodes);
            event.preventDefault();
            break;
        case 'ArrowDown':
            nextIndex = findClosestNodeInDirection('down', currentIndex, focusableNodes);
            event.preventDefault();
            break;
        case 'Backspace':
        case 'Delete':
            // Close tab when backspace or delete is pressed
            event.preventDefault();
            const closeTabId = parseInt(data.data.id.replace(/\D/g, ''), 10);
            if (!isNaN(closeTabId)) {
                chrome.tabs.remove(closeTabId);
                console.log(`Closing tab: ${closeTabId}`);
            } else {
                console.warn('Invalid tab ID for deletion:', data.data);
            }
            break;
    }

    if (nextIndex !== currentIndex) {
        // Remove hover from current node
        d3.select(node)
            .classed('cell-hover', false);
            
        // Apply hover to next node and focus it
        const nextNode = focusableNodes[nextIndex];
        d3.select(nextNode)
            .classed('cell-hover', true);
        nextNode.focus();
        
        // Update readout
        const nextData = d3.select(nextNode).datum();
        displayReadout(nextData.data, false, categorizedDataCache);
    }
}

function findClosestNodeInDirection(direction, currentIndex, focusableNodes) {
    const currentNode = focusableNodes[currentIndex];
    const currentRect = currentNode.getBoundingClientRect();
    const currentCenter = {
        x: currentRect.left + currentRect.width / 2,
        y: currentRect.top + currentRect.height / 2
    };

    const candidates = focusableNodes.map((node, index) => {
        const rect = node.getBoundingClientRect();
        return {
            node,
            index,
            rect,
            center: {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2
            },
            distance: 0 // Will be calculated based on direction
        };
    });

    // Filter and score candidates based on direction
    const validCandidates = candidates.filter(c => {
        switch (direction) {
            case 'right':
                return c.center.x > currentCenter.x;
            case 'left':
                return c.center.x < currentCenter.x;
            case 'up':
                return c.center.y < currentCenter.y;
            case 'down':
                return c.center.y > currentCenter.y;
        }
    });

    if (!validCandidates.length) return currentIndex;

    // Calculate distances
    validCandidates.forEach(c => {
        c.distance = Math.sqrt(Math.pow(c.center.x - currentCenter.x, 2) + Math.pow(c.center.y - currentCenter.y, 2));
    });

    // Sort by distance and return the closest
    validCandidates.sort((a, b) => a.distance - b.distance);
    return validCandidates[0].index;
}