export class TabSearch {
    constructor() {
        this.searchIndex = null;
        this.documentLookup = new Map();
    }

    buildIndex(state) {
        console.log('Building search index:', {
            hasState: !!state,
            windows: state?.activeWindows?.length,
            firstWindow: state?.activeWindows?.[0]
        });

        const documents = [];

        // Index tabs from each window
        state?.activeWindows?.forEach(window => {
            window.tabs?.forEach(tab => {
                const doc = {
                    id: `tab${tab.id}`,
                    title: tab.title || 'Untitled',
                    url: tab.url || '',
                    windowId: window.id,
                    isBookmark: false,
                    data: tab
                };
                documents.push(doc);
                this.documentLookup.set(doc.id, doc);
                /*console.log('Indexed tab:', {
                    id: doc.id,
                    title: doc.title,
                    url: doc.url
                });*/
            });
        });

        // Create Lunr index
        this.searchIndex = lunr(function() {
            this.field('title', { boost: 10 });
            this.field('url', { boost: 5 });
            this.ref('id');

            documents.forEach(doc => this.add(doc));
        });

        console.log('Search index built:', {
            documentsIndexed: documents.length,
            hasSearchIndex: !!this.searchIndex
        });
    }

    search(query) {
        if (!query?.trim()) return [];
        if (!this.searchIndex) {
            console.warn('No search index available');
            return [];
        }

        console.log('Searching for:', query);

        try {
            const searchQuery = `*${query.trim()}*`;
            const results = this.searchIndex.search(searchQuery);
            
            console.log('Search results:', {
                query: searchQuery,
                resultCount: results.length,
                firstResult: results[0]
            });

            return results.map(result => {
                const doc = this.documentLookup.get(result.ref);
                return {
                    score: result.score,
                    id: doc.id,
                    title: doc.title,
                    url: doc.url,
                    windowId: doc.windowId,
                    isBookmark: doc.isBookmark,
                    data: doc.data
                };
            });
        } catch (e) {
            console.warn('Search error:', e);
            // Fallback to basic search
            return Array.from(this.documentLookup.values())
                .filter(doc => 
                    doc.title.toLowerCase().includes(query.toLowerCase()) ||
                    doc.url.toLowerCase().includes(query.toLowerCase())
                );
        }
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

export function exitSearchMode() {
    const searchInput = document.getElementById('tabSearch');
    searchInput.value = '';
    searchInput.blur();
    clearSearchResults();
}

export function handleSearchResults(results) {
    console.log('Processing search results:', results.length);

    d3.selectAll('.cell')
        .classed('cell-search-match', d => {
            const isMatch = results.some(r => r.id === d.data.id);
            if (isMatch) {
                d.searchData = results.find(r => r.id === d.data.id);
            }
            return isMatch;
        })
        .classed('cell-search-nomatch', d => !results.some(r => r.id === d.data.id))
        .style('opacity', d => results.some(r => r.id === d.data.id) ? 1 : 0.3);

    // Update keyboard navigation order
    updateSearchTabOrder(results);
}

function updateSearchTabOrder(results) {
    const searchOrder = results.map(r => r.id);
    d3.selectAll('.cell')
        .attr('tabindex', d => {
            const index = searchOrder.indexOf(d.data.id);
            return index >= 0 ? 0 : -1;
        });
}

// Add search index management
let searchIndex = new Map();

export function indexNode(id, data) {
    // Validate input data
    if (!data) {
        console.warn('No data provided for indexing');
        return;
    }

    // Extract tab ID from either the id parameter or data.id
    let tabId;
    if (typeof id === 'string' && id.startsWith('tab')) {
        tabId = id.replace('tab', '');
    } else if (data.id) {
        tabId = data.id;
    } else {
        console.warn('Invalid or missing tab ID:', { id, data });
        return;
    }

    // Ensure we have a valid numeric ID
    if (isNaN(parseInt(tabId))) {
        console.warn('Non-numeric tab ID:', { tabId, originalId: id, data });
        return;
    }

    const indexData = {
        id: `tab${tabId}`,
        title: data.title || 'Untitled',
        url: data.url || '',
        isBookmark: !!data.isBookmark,
        windowId: data.windowId
    };

    console.log('Indexing node with validated ID:', {
        id: indexData.id,
        title: indexData.title,
        url: indexData.url
    });

    searchIndex.set(indexData.id, indexData);
}

// Add helper function to validate tab data
function isValidTabData(data) {
    return data && 
           typeof data.id !== 'undefined' && 
           data.id !== null &&
           !isNaN(parseInt(data.id));
}

// Update the search index management
export function updateSearchIndex(tabs) {
    console.log('Updating search index with tabs:', tabs.length);
    
    // Clear existing index
    searchIndex.clear();
    
    // Index only valid tabs
    tabs.forEach(tab => {
        if (isValidTabData(tab)) {
            indexNode(`tab${tab.id}`, tab);
        } else {
            console.warn('Skipping invalid tab data:', tab);
        }
    });
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

export function clearSearchResults() {
    d3.selectAll('.cell')
        .style('opacity', 1)
        .classed('cell-search-match', false)
        .classed('cell-search-nomatch', false)
        .classed('cell-selected', false)
        .style('transition', 'opacity 0.2s ease-in-out');
}