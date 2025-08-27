/**
 * Early Crash Suppression System
 * 
 * This script must load before any other scripts to effectively suppress
 * Chrome Summarizer API crash messages during extension startup.
 */

// Immediate crash message suppression for launch
let crashMessageCount = 0;
let globalSummarizerDisabled = false;
const GLOBAL_DISABLE_DURATION = 600000; // 10 minutes

const crashPatterns = [
    'model process crashed too many times',
    'The model process crashed',
    'crashed too many times',
    'Summarizer.*crashed',
    'AI.*crashed'
];

function isCrashMessage(message) {
    return crashPatterns.some(pattern => {
        if (pattern.includes('.*')) {
            return new RegExp(pattern, 'i').test(message);
        }
        return message.toLowerCase().includes(pattern.toLowerCase());
    });
}

// Override console methods immediately
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.warn = function(...args) {
    const message = args.join(' ');
    if (isCrashMessage(message)) {
        crashMessageCount++;
        if (crashMessageCount <= 1) { // Only show first crash message
            originalConsoleWarn.apply(console, ['🚫 Chrome Summarizer crashed - suppressing further messages']);
        }
        globalSummarizerDisabled = true;
        setTimeout(() => {
            globalSummarizerDisabled = false;
            crashMessageCount = 0;
        }, GLOBAL_DISABLE_DURATION);
        return;
    }
    originalConsoleWarn.apply(console, args);
};

console.error = function(...args) {
    const message = args.join(' ');
    if (isCrashMessage(message)) {
        crashMessageCount++;
        if (crashMessageCount <= 1) { // Only show first crash message
            originalConsoleError.apply(console, ['🚫 Chrome Summarizer crashed - suppressing further messages']);
        }
        globalSummarizerDisabled = true;
        setTimeout(() => {
            globalSummarizerDisabled = false;
            crashMessageCount = 0;
        }, GLOBAL_DISABLE_DURATION);
        return;
    }
    originalConsoleError.apply(console, args);
};

// Make global state available to other scripts
window.summarizerCrashState = {
    get disabled() { return globalSummarizerDisabled; },
    get crashCount() { return crashMessageCount; }
};

console.log('✅ Crash suppression system initialized');
