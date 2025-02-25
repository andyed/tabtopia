export function getMotivationalMessage(windows, tabs) {
    // Helper function to randomly select a message from an array
    const pickRandom = arr => arr[Math.floor(Math.random() * arr.length)];

    // Find the matching condition and return a random message
    // Start with most extreme cases first, then work down to simpler cases
    
    // The Extremes
    if (windows > 200 && tabs > 10000) {
        return pickRandom([
            "Ten thousand tabs and two hundred windows? This is beyond comprehension.",
            "You are the supreme overlord of the Internet.",
            "Your browser has transcended time and space."
        ]);
    }
    
    if (windows > 100 && tabs > 5000) {
        return pickRandom([
            "Five thousand tabs and a hundred windows? You are a legend.",
            "Your browser has officially become an operating system.",
            "Achievement unlocked: Browser Titan."
        ]);
    }

    // Critical Mass
    if (windows >= 25 && tabs >= 1000) {
        return pickRandom([
            "A thousand tabs and twenty-five windows? Are you even human?",
            "Your browser has ascended to a higher plane of existence.",
            "Congratulations, you are now the ruler of Tabtopia."
        ]);
    }

    // ... continue with all other conditions in descending order of complexity ...

    // Fresh Start States (base cases)
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

    // Default message if no conditions match
    return "Browse on!";
}