// Sessions view JavaScript
// This file will handle the logic for displaying and interacting with browsing sessions.

console.log('sessions.js loaded');

document.addEventListener('DOMContentLoaded', () => {
    // Initialization code for the sessions view will go here
    console.log('Sessions view DOM fully loaded and parsed');

    // Example: Fetch session data from background script
    // chrome.runtime.sendMessage({ type: 'getSessionsData' }, (response) => {
    //     if (chrome.runtime.lastError) {
    //         console.error('Error fetching session data:', chrome.runtime.lastError.message);
    //         return;
    //     }
    //     if (response && response.data) {
    //         renderSessions(response.data);
    //     } else {
    //         console.log('No session data received or data is empty.');
    //     }
    // });
});

function renderSessions(sessionsData) {
    const container = document.getElementById('sessions-container');
    if (!container) {
        console.error('Sessions container not found');
        return;
    }
    // Clear previous content
    container.innerHTML = '<p>Rendering sessions...</p>'; 

    // Add your session rendering logic here
    // For example:
    // const ul = document.createElement('ul');
    // sessionsData.forEach(session => {
    //     const li = document.createElement('li');
    //     li.textContent = `Session started at ${new Date(session.startTime).toLocaleString()}`;
    //     ul.appendChild(li);
    // });
    // container.appendChild(ul);
    console.log('Placeholder for renderSessions:', sessionsData);
}
