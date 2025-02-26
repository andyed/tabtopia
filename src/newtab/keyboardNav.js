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