// View toggle functionality for sessions page
// This module adds a toggle button to switch between card and list views

/**
 * Initialize view toggle functionality
 */
export function initViewToggle() {
  // Get current display mode from localStorage or default to 'default' (list view)
  const currentMode = localStorage.getItem('sessionDisplayMode') || 'default';
  
  // Create toggle button
  const toggleButton = document.createElement('button');
  toggleButton.className = 'view-toggle-button';
  toggleButton.id = 'view-toggle-button';
  
  // Set initial button state
  updateToggleButton(toggleButton, currentMode);
  
  // Add click handler
  toggleButton.addEventListener('click', () => {
    // Toggle between modes
    const newMode = currentMode === 'default' ? 'card' : 'default';
    localStorage.setItem('sessionDisplayMode', newMode);
    
    // Update button state
    updateToggleButton(toggleButton, newMode);
    
    // Refresh the view
    window.location.reload();
  });
  
  // Find the header controls container to add the button
  const headerControls = document.querySelector('.header-controls');
  if (headerControls) {
    // Add the toggle button to header controls
    headerControls.insertBefore(toggleButton, headerControls.firstChild);
  }
}

/**
 * Update toggle button appearance based on current mode
 * @param {HTMLElement} button - The toggle button element
 * @param {string} mode - Current display mode ('default' or 'card')
 */
function updateToggleButton(button, mode) {
  if (mode === 'card') {
    button.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" 
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="8" y1="6" x2="21" y2="6"></line>
        <line x1="8" y1="12" x2="21" y2="12"></line>
        <line x1="8" y1="18" x2="21" y2="18"></line>
        <line x1="3" y1="6" x2="3.01" y2="6"></line>
        <line x1="3" y1="12" x2="3.01" y2="12"></line>
        <line x1="3" y1="18" x2="3.01" y2="18"></line>
      </svg>
      <span class="tooltip">Switch to List View</span>
    `;
  } else {
    button.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" 
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="7" height="7"></rect>
        <rect x="14" y="3" width="7" height="7"></rect>
        <rect x="14" y="14" width="7" height="7"></rect>
        <rect x="3" y="14" width="7" height="7"></rect>
      </svg>
      <span class="tooltip">Switch to Card View</span>
    `;
  }
}
