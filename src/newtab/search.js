class TabSearch {
    constructor() {
        this.searchIndex = null;
        this.documentLookup = new Map();
        this.lastQuery = '';
    }

    buildIndex(categorizedDataCache) {
        const documents = [];
        
        // Flatten all tabs into searchable documents
        categorizedDataCache.activeWindows.forEach(window => {
            window.tabs.forEach(tab => {
                try {
                    const domain = new URL(tab.url).hostname;
                    const doc = {
                        id: `tab${tab.id}`,
                        title: tab.title || '',
                        url: tab.url || '',
                        domain: domain,
                        windowId: window.id
                    };
                    documents.push(doc);
                    this.documentLookup.set(doc.id, tab);
                } catch (e) {
                    console.warn('Invalid URL in tab:', tab.url);
                }
            });
        });

        // Build lunr index
        this.searchIndex = lunr(function() {
            // Boost factors for different fields
            this.field('title', { boost: 10 });
            this.field('url', { boost: 5 });
            this.field('domain', { boost: 3 });
            
            this.ref('id');

            // Add documents to index
            documents.forEach(doc => this.add(doc));
        });
    }

    search(query) {
        if (!this.searchIndex) return [];
        if (!query.trim()) return [];
        query = '*' + query + '*';
        this.lastQuery = query;
        console.log("Searching for " + query);
        try {
            // Perform lunr search
            const results = this.searchIndex.search(query);
            
            // Map results to tabs with scores
            return results.map(result => ({
                score: result.score,
                tab: this.documentLookup.get(result.ref),
                matches: result.matchData.metadata
            }));
        } catch (e) {
            console.warn('Search error, falling back to basic search:', e);
            
            // Fallback to basic substring search
            const searchTerm = query.toLowerCase();
            return Array.from(this.documentLookup.values())
                .filter(tab => 
                    tab.title?.toLowerCase().includes(searchTerm) ||
                    tab.url?.toLowerCase().includes(searchTerm)
                )
                .map(tab => ({ 
                    score: 1, 
                    tab,
                    matches: {} 
                }));
        }
    }

    highlightMatches(text, matches) {
        if (!matches || Object.keys(matches).length === 0) return text;
        
        // Create array of positions where highlighting should occur
        const positions = [];
        Object.values(matches).forEach(match => {
            Object.keys(match).forEach(field => {
                const positions = match[field].position || [];
                positions.forEach(([start, length]) => {
                    positions.push({ start, length });
                });
            });
        });

        // Sort positions and apply highlighting
        return positions
            .sort((a, b) => b.start - a.start)
            .reduce((str, pos) => {
                const before = str.slice(0, pos.start);
                const match = str.slice(pos.start, pos.start + pos.length);
                const after = str.slice(pos.start + pos.length);
                return `${before}<mark>${match}</mark>${after}`;
            }, text);
    }
}

export const tabSearch = new TabSearch();

export function initializeSearch() {
    const searchInput = document.getElementById('tabSearch');
    
    searchInput.addEventListener('keydown', (event) => {
        switch (event.key) {
            case 'Enter':
            case 'Tab':
                event.preventDefault();
                focusFirstSearchResult();
                break;
            case 'Escape':
                event.preventDefault();
                exitSearchMode();
                break;
        }
    });
}

function focusFirstSearchResult() {
    const firstResult = d3.select('.cell-search-match').node();
    if (firstResult) {
        firstResult.focus();
    }
}

function exitSearchMode() {
    const searchInput = document.getElementById('tabSearch');
    searchInput.value = '';
    searchInput.blur();
    clearSearchResults();
}

export function handleSearchResults(results) {
    // Update visual state for search results
    d3.selectAll('.cell')
        .classed('cell-search-match', d => results.some(r => r.id === d.data.id))
        .classed('cell-search-nomatch', d => !results.some(r => r.id === d.data.id))
        .style('opacity', d => results.some(r => r.id === d.data.id) ? 1 : 0.3);

    // Update tab order for keyboard navigation
    const searchOrder = results.map(r => r.id);
    d3.selectAll('.cell')
        .attr('tabindex', d => {
            const index = searchOrder.indexOf(d.data.id);
            return index >= 0 ? index : -1;
        });
}

// Add search index management
let searchIndex = new Map();

export function indexNode(id, data) {
    searchIndex.set(id, {
        id,
        title: data.title || '',
        url: data.url || '',
        isBookmark: data.isBookmark || false,
        windowId: data.windowId
    });
    console.log('Indexed:', { id, type: data.isBookmark ? 'bookmark' : 'tab' });
}

export function removeFromIndex(id) {
    searchIndex.delete(id);
    console.log('Removed from index:', id);
}

export function clearBookmarksFromIndex() {
    // Remove all bookmark entries
    for (const [id, data] of searchIndex.entries()) {
        if (data.isBookmark) {
            searchIndex.delete(id);
        }
    }
    console.log('Cleared bookmarks from index');
}

// Update search function to use index
export function searchTabs(query) {
    if (!query) return [];
    
    const normalizedQuery = query.toLowerCase();
    return Array.from(searchIndex.values())
        .filter(item => {
            return item.title.toLowerCase().includes(normalizedQuery) ||
                   item.url.toLowerCase().includes(normalizedQuery);
        })
        .sort((a, b) => {
            // Prioritize exact matches
            const aExact = a.title.toLowerCase() === normalizedQuery;
            const bExact = b.title.toLowerCase() === normalizedQuery;
            if (aExact && !bExact) return -1;
            if (!aExact && bExact) return 1;
            return 0;
        });
}