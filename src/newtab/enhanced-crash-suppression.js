/**
 * Enhanced Crash Suppression System
 * 
 * This script aggressively suppresses Chrome Summarizer API crash messages
 * from multiple sources including browser internals.
 */

// IMMEDIATE and AGGRESSIVE crash suppression
(function () {
    console.log("🚫 Initializing ENHANCED crash suppression...");

    let suppressionCount = 0;

    // Store original methods immediately
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalLog = console.log;
    const originalInfo = console.info;

    // Target crash message patterns
    const crashPatterns = [
        "The model process crashed too many times for this version.",
        "The model process crashed too many times",
        "model process crashed too many times",
        "crashed too many times for this version",
        "crashed too many times"
    ];

    function isCrashMessage(message) {
        const msg = String(message).toLowerCase();
        const isMatch = crashPatterns.some(pattern => msg.includes(pattern.toLowerCase()));
        if (isMatch) {
            console.log("🔍 [DEBUG] Crash message detected:", message);
        }
        return isMatch;
    }

    function suppressMessage(originalMethod, args) {
        const message = args.join(" ");
        if (isCrashMessage(message)) {
            suppressionCount++;
            if (suppressionCount === 1) {
                originalMethod.call(console, "🚫 [ENHANCED SUPPRESSION] Chrome Summarizer crash detected - suppressing messages");
            }
            return true; // Suppressed
        }
        return false; // Not suppressed
    }

    // Override ALL console methods with NUCLEAR suppression
    console.warn = function (...args) {
        if (!suppressMessage(originalWarn, args)) {
            originalWarn.apply(console, args);
        }
    };

    console.error = function (...args) {
        if (!suppressMessage(originalError, args)) {
            originalError.apply(console, args);
        }
    };

    console.log = function (...args) {
        if (!suppressMessage(originalLog, args)) {
            originalLog.apply(console, args);
        }
    };

    console.info = function (...args) {
        if (!suppressMessage(originalInfo, args)) {
            originalInfo.apply(console, args);
        }
    };

    // NUCLEAR OPTION: Override console object entirely for crash messages
    const originalConsole = window.console;
    const consoleProxy = new Proxy(originalConsole, {
        get(target, prop) {
            if (["warn", "error", "log", "info"].includes(prop)) {
                return function (...args) {
                    if (!suppressMessage(target[prop], args)) {
                        return target[prop].apply(target, args);
                    }
                };
            }
            return target[prop];
        }
    });

    // Replace the console object
    Object.defineProperty(window, "console", {
        value: consoleProxy,
        writable: false,
        configurable: true
    });

    // Intercept error events at window level
    window.addEventListener("error", function (event) {
        if (event.message && isCrashMessage(event.message)) {
            suppressionCount++;
            if (suppressionCount === 1) {
                console.log("🚫 [ENHANCED SUPPRESSION] Window error event suppressed");
            }
            event.preventDefault();
            event.stopPropagation();
            return false;
        }
    }, true); // Use capture phase

    // Intercept unhandled promise rejections
    window.addEventListener("unhandledrejection", function (event) {
        if (event.reason && isCrashMessage(String(event.reason))) {
            suppressionCount++;
            if (suppressionCount === 1) {
                console.log("🚫 [ENHANCED SUPPRESSION] Promise rejection suppressed");
            }
            event.preventDefault();
            return false;
        }
    });

    // Try to intercept Chrome's internal logging (experimental)
    if (typeof chrome !== "undefined" && chrome.runtime) {
        // Override potential Chrome internal logging
        const originalSendMessage = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = function (...args) {
            try {
                if (args.length > 0 && typeof args[0] === "object" && args[0].message) {
                    if (isCrashMessage(args[0].message)) {
                        suppressionCount++;
                        console.log("🚫 [ENHANCED SUPPRESSION] Chrome runtime message suppressed");
                        return;
                    }
                }
            } catch (e) {
                // Ignore errors in message inspection
            }
            return originalSendMessage.apply(this, args);
        };
    }

    // Global error handler as last resort
    const originalOnError = window.onerror;
    window.onerror = function (message, source, lineno, colno, error) {
        if (message && isCrashMessage(message)) {
            suppressionCount++;
            if (suppressionCount === 1) {
                console.log("🚫 [ENHANCED SUPPRESSION] Global error handler suppressed crash");
            }
            return true; // Prevent default error handling
        }
        if (originalOnError) {
            return originalOnError.call(this, message, source, lineno, colno, error);
        }
        return false;
    };

    // Make global state available
    window.enhancedCrashSuppression = {
        suppressionCount: () => suppressionCount,
        reset: () => {
            suppressionCount = 0;
            console.log("🔄 Enhanced crash suppression reset");
        }
    };

    console.log("✅ ENHANCED crash suppression active - monitoring all channels");

    // Additional debugging: Log when we detect potential Summarizer API access
    let originalSummarizer = window.Summarizer;
    Object.defineProperty(window, "Summarizer", {
        get() {
            if (originalSummarizer) {
                console.log("🔍 [DEBUG] Summarizer API accessed");
            }
            return originalSummarizer;
        },
        set(value) {
            console.log("🔍 [DEBUG] Summarizer API set to:", value);
            originalSummarizer = value;
        }
    });

    // Monitor for any AI-related property access
    if (window.ai) {
        console.log("🔍 [DEBUG] window.ai detected at startup");
    }

    // Log page load timing
    console.log("🔍 [DEBUG] Enhanced crash suppression loaded at:", new Date().toISOString());
})();

// Export for debugging
if (typeof module !== "undefined" && module.exports) {
    module.exports = { enhancedCrashSuppression: true };
}
