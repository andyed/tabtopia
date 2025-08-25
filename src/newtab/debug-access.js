/**
 * Debug Access Script
 * Provides keyboard shortcut access to debug tools from any page
 * Alt+D opens the debug page
 */

// Add keyboard shortcut listener (Alt+D) to open debug page
document.addEventListener('keydown', (event) => {
    // Alt+D shortcut to access debug page
    if (event.altKey && event.key === 'd') {
        event.preventDefault();
        window.location.href = 'debug.html';
    }
    
    // Add Shift+Alt+D to reveal all debug links
    if (event.altKey && event.shiftKey && event.key === 'D') {
        event.preventDefault();
        const debugLinks = document.querySelectorAll('#debug-link');
        debugLinks.forEach(link => {
            link.style.opacity = link.style.opacity === '1' ? '0.05' : '1';
        });
    }
});
