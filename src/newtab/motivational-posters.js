export function getMotivationalMessage(windows, tabs) {
    // Helper function to randomly select a message from an array
    const pickRandom = arr => arr[Math.floor(Math.random() * arr.length)];

    // Find the matching condition and return a random message
    // Start with the most extreme cases first, then work down to simpler cases
    
    // The Extremes
    if (windows >= 50 && tabs >= 500) {
        return pickRandom([
            "Five hundred tabs? Your browser is defying the laws of physics.",
            "Fifty windows and counting. Your RAM salutes you.",
            "You are officially the Multitasking Overlord."
        ]);
    }
    if (windows >= 25 && tabs >= 300) {
        return pickRandom([
            "Three hundred tabs and twenty-five windows? A true multitasking marvel.",
            "Your browser is now a digital skyscraper.",
            "You're running a small city within your browser."
        ]);
    }

    // Escalating Madness
    if (windows >= 15 && tabs >= 200) {
        return pickRandom([
            "Two hundred tabs? Your browser is officially a powerhouse.",
            "Your browser might need a break, but you're unstoppable!",
            "You've reached browser wizard status."
        ]);
    }
    if (windows >= 10 && tabs >= 100) {
        return pickRandom([
            "A hundred tabs and ten windows? You're in full research mode.",
            "Your browser is now a digital metropolis.",
            "Achievement unlocked: Master Multitasker."
        ]);
    }

    // Balanced Chaos
    if (windows >= 5 && tabs / windows >= 15) {
        return pickRandom([
            "Fifteen tabs per window? You're in beast mode.",
            "Your browser is a multitasking symphony.",
            "Each window is its own thriving ecosystem."
        ]);
    }
    if (windows >= 3 && tabs / windows >= 10) {
        return pickRandom([
            "Ten tabs per window? You're juggling like a pro.",
            "A multitasking champion with an eye on the prize.",
            "Each window is a balance of chaos and control."
        ]);
    }

    // Growing Momentum
    if (windows === 1 && tabs >= 50) {
        return pickRandom([
            "One window to rule them all, and in the RAM bind them.",
            "Fifty tabs, a true masterpiece.",
            "Your browser is a force to be reckoned with."
        ]);
    }
    if (windows === 1 && tabs >= 30) {
        return pickRandom([
            "Thirty tabs and counting! You're on a roll.",
            "Your browser is becoming a research powerhouse.",
            "Ideas are flowing, and so are the tabs."
        ]);
    }
    if (windows === 1 && tabs >= 15) {
        return pickRandom([
            "You're starting to build momentum!",
            "Fifteen tabs, a small but growing collection.",
            "Balanced between focus and exploration."
        ]);
    }

    // Minimalist Browsing
    if (windows >= 2 && tabs <= windows) {
        return pickRandom([
            "A minimalist approach to browsing.",
            "One tab per window. Balanced and serene.",
            "Intentional browsing at its finest."
        ]);
    }
    if (windows > 5 && tabs === windows) {
        return pickRandom([
            "Five windows, one tab each. A true master of compartmentalization.",
            "Efficient multitasking with minimal clutter.",
            "Precision browsing in action."
        ]);
    }

    // Fresh Start States
    if (windows === 0 && tabs === 0) {
        return pickRandom([
            "Zero windows, zero tabs. A true moment of zen.",
            "The calm before the storm.",
            "A perfectly empty browser, waiting to be filled."
        ]);
    }
    if (windows === 1 && tabs === 1) {
        return pickRandom([
            "One tab. One goal. Total focus.",
            "The journey begins with a single tab.",
            "Minimal distractions, maximum potential."
        ]);
    }
    if (windows === 1 && tabs === 2) {
        return pickRandom([
            "The journey of a thousand tabs begins with a single window.",
            "Two tabs, double the fun.",
            "Starting small, aiming big."
        ]);
    }
    if (windows === 1 && tabs === 3) {
        return pickRandom([
            "Three tabs, the perfect trilogy.",
            "Three's a charm in the browser world.",
            "Triple the tabs, triple the productivity."
        ]);
    }

    // Default message if no specific conditions match
    return pickRandom([
        "Explore the web, one tab at a time!",
        "Your browsing adventure begins here.",
        "The internet is yours to conquer.",
        "One click away from infinite knowledge.",
        "The digital world is at your fingertips.",
        "Let curiosity guide your journey.",
        "Every tab holds a new opportunity.",
        "Ready. Set. Browse.",
        "Dive into the endless sea of information.",
        "Your browser, your playground."
    ]);
}