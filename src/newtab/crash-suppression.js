/**
 * Early Crash Suppression System
 * 
 * This script must load before any other scripts to effectively suppress
 * Chrome Summarizer API crash messages during extension startup.
 */

// IMMEDIATE crash suppression - execute synchronously
(function() {
    console.log('🚫 Initializing IMMEDIATE crash suppression...');
    
    // Store original methods immediately
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalLog = console.log;
    
    // Override console methods IMMEDIATELY
    console.warn = function(...args) {
        const message = args.join(' ');
        if (message === 'The model process crashed too many times for this version.') {
            originalWarn.call(console, '🚫 [SUPPRESSED] Chrome Summarizer crash message intercepted');
            return;
        }
        originalWarn.apply(console, args);
    };
    
    console.error = function(...args) {
        const message = args.join(' ');
        if (message === 'The model process crashed too many times for this version.') {
            originalError.call(console, '🚫 [SUPPRESSED] Chrome Summarizer crash message intercepted');
            return;
        }
        originalError.apply(console, args);
    };
    
    console.log('✅ IMMEDIATE crash suppression active');
})();

// Immediate crash message suppression for launch
let crashMessageCount = 0;
let globalSummarizerDisabled = false;
const GLOBAL_DISABLE_DURATION = 600000; // 10 minutes

const crashPatterns = [
    'model process crashed too many times',
    'The model process crashed',
    'crashed too many times for this version'
];

function isCrashMessage(message) {
    const messageStr = String(message).toLowerCase();
    return crashPatterns.some(pattern => {
        if (pattern.includes('.*')) {
            return new RegExp(pattern, 'i').test(messageStr);
        }
        return messageStr.includes(pattern.toLowerCase());
    });
}

// Store original console methods for restoration
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

// More targeted approach - only intercept specific Chrome messages
// Instead of overriding all console methods, use event listeners and targeted suppression

// Listen for Chrome's built-in crash messages through error events
window.addEventListener('error', (event) => {
    if (event.message && isCrashMessage(event.message)) {
        crashMessageCount++;
        if (crashMessageCount === 1) {
            console.log('🚫 Chrome Summarizer crashed - suppressing further messages');
        }
        globalSummarizerDisabled = true;
        setTimeout(() => {
            globalSummarizerDisabled = false;
            crashMessageCount = 0;
        }, GLOBAL_DISABLE_DURATION);
        
        // Prevent the error from being displayed
        event.preventDefault();
        event.stopPropagation();
    }
});

// Listen for unhandled promise rejections that might contain crash messages
window.addEventListener('unhandledrejection', (event) => {
    if (event.reason && isCrashMessage(String(event.reason))) {
        crashMessageCount++;
        if (crashMessageCount === 1) {
            console.log('🚫 Chrome Summarizer crashed (promise rejection) - suppressing further messages');
        }
        globalSummarizerDisabled = true;
        setTimeout(() => {
            globalSummarizerDisabled = false;
            crashMessageCount = 0;
        }, GLOBAL_DISABLE_DURATION);
        
        // Prevent the rejection from being displayed
        event.preventDefault();
    }
});

// Minimal console override - only for the most specific crash messages
const originalMethods = {
    warn: console.warn,
    error: console.error,
    log: console.log
};

// Very targeted console override - ONLY for the exact Chrome crash message
console.warn = function(...args) {
    const message = args.join(' ');
    
    // ONLY intercept the exact Chrome Summarizer crash message
    if (message === 'The model process crashed too many times for this version.') {
        crashMessageCount++;
        if (crashMessageCount === 1) {
            originalConsoleWarn.call(console, '🚫 Chrome Summarizer crashed - suppressing further messages');
        }
        globalSummarizerDisabled = true;
        setTimeout(() => {
            globalSummarizerDisabled = false;
            crashMessageCount = 0;
        }, GLOBAL_DISABLE_DURATION);
        return; // Suppress this specific message
    }
    
    // For ALL other messages, use the original method
    originalConsoleWarn.apply(console, args);
};

// Make global state available to other scripts
window.summarizerCrashState = {
    get disabled() { return globalSummarizerDisabled; },
    get crashCount() { return crashMessageCount; },
    reset() {
        globalSummarizerDisabled = false;
        crashMessageCount = 0;
        console.log('🔄 Global crash state reset');
    }
};

// Make reset function available globally for debugging
window.resetGlobalCrashState = () => {
    globalSummarizerDisabled = false;
    crashMessageCount = 0;
    console.log('🔄 Global crash state reset via debug function');
};

console.log('✅ Crash suppression system initialized');
