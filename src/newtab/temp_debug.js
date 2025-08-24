// This is just to test specific code replacement
console.log('Original code section:');
console.log(`
    // Restart the simulation with a lower alpha
    simulation.alpha(0.3).restart();
    
    // Signal that graph nodes are ready for highlighting
    if (graphReadyRef) graphReadyRef.value = true;
    console.log('Graph nodes ready for highlighting');
`);

console.log('Replacement code should be:');
console.log(`
    // Restart the simulation with a lower alpha
    simulation.alpha(0.3).restart();
    
    // Signal that graph nodes are ready for highlighting
    graphNodesReady = true; // Set the global flag
    console.log('Graph nodes ready for highlighting: true');
`);
