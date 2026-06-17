/**
 * URL and navigation utility functions for Tabtopia
 */

/**
 * Extract search query from a URL if it's from a known search engine
 * @param {string} url - URL to extract search query from
 * @returns {string|null} - Extracted search query or null
 */
export function extractSearchQuery(url) {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) return null;
    try {
        const urlObj = new URL(url);
        let query = null;

        // Google search
        if (urlObj.hostname.includes('google.') && urlObj.pathname.includes('/search')) {
            query = urlObj.searchParams.get('q');
        }
        // Bing search
        else if (urlObj.hostname.includes('bing.com') && urlObj.pathname.includes('/search')) {
            query = urlObj.searchParams.get('q');
        }
        // DuckDuckGo
        else if (urlObj.hostname.includes('duckduckgo.com')) {
            query = urlObj.searchParams.get('q');
        }
        // Yahoo search
        else if (urlObj.hostname.includes('search.yahoo.com')) {
            query = urlObj.searchParams.get('p');
        }
        // Baidu
        else if (urlObj.hostname.includes('baidu.com') && urlObj.pathname.includes('/s')) {
            query = urlObj.searchParams.get('wd');
        }
        // Yandex
        else if (urlObj.hostname.includes('yandex') && urlObj.pathname.includes('/search')) {
            query = urlObj.searchParams.get('text');
        }
        // Brave Search
        else if (urlObj.hostname.includes('search.brave.com')) {
            query = urlObj.searchParams.get('q');
        }
        // Ecosia
        else if (urlObj.hostname.includes('ecosia.org') && urlObj.pathname.includes('/search')) {
            query = urlObj.searchParams.get('q');
        }
        // StartPage
        else if (urlObj.hostname.includes('startpage.com')) {
            query = urlObj.searchParams.get('query');
        }
        // Qwant
        else if (urlObj.hostname.includes('qwant.com')) {
            query = urlObj.searchParams.get('q');
        }

        return query;
    } catch (e) {
        console.warn('Error extracting search query:', e);
        return null;
    }
}

/**
 * Detects whether a URL is likely an automatic redirect
 * @param {string} previousUrl - Previous URL in the navigation chain
 * @param {string} currentUrl - Current URL being navigated to
 * @returns {boolean} - True if the navigation appears to be an automatic redirect
 */
export function isLikelyRedirect(previousUrl, currentUrl) {
    if (!previousUrl || !currentUrl) return false;

    try {
        const prevUrl = new URL(previousUrl);
        const currUrl = new URL(currentUrl);

        // Same domain redirects are common
        if (prevUrl.hostname === currUrl.hostname) {
            // Login redirects often include auth, token, etc.
            if (currUrl.pathname.includes('/auth') ||
                currUrl.pathname.includes('/login') ||
                currUrl.search.includes('token=') ||
                currUrl.search.includes('redirect=')) {
                return true;
            }

            // Redirect chaining typically happens quickly
            if (currUrl.search.includes('redirect_uri=') ||
                currUrl.search.includes('return_to=') ||
                currUrl.search.includes('next=')) {
                return true;
            }
        }

        // Common redirect patterns between domains
        if (prevUrl.searchParams.has('url') &&
            decodeURIComponent(prevUrl.searchParams.get('url')).includes(currUrl.hostname)) {
            return true;
        }

        return false;
    } catch (e) {
        console.warn('Error detecting redirect:', e);
        return false;
    }
}
