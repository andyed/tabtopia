/**
 * Resolve the tab-switch origin without depending on content-script coverage.
 * The in-memory map is fastest when populated; chrome.tabs.get is the durable
 * fallback after service-worker restarts and for extension-internal pages.
 */
export async function resolveActivationOrigin(previousTabId, trackedTabs, getTab) {
    if (!Number.isFinite(Number(previousTabId))) return "";

    const trackedUrl = trackedTabs?.get?.(previousTabId)?.url;
    if (trackedUrl) return trackedUrl;
    if (typeof getTab !== "function") return "";

    try {
        const tab = await getTab(previousTabId);
        return tab?.url || "";
    } catch {
        // Closing a tab while another activates is routine, not a fault.
        return "";
    }
}
