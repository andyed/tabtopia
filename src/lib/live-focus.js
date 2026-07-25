/**
 * Resolve the tab that best represents the user's current Chrome context.
 *
 * Chrome clears window.focused when another macOS app is frontmost, but each
 * Chrome window keeps an active tab. Preserve the explicitly focused tab when
 * available, then use Tabtopia's last active tab to disambiguate multiple
 * background windows. A single Chrome window needs no historical hint.
 */
export function selectLiveFocusedTab(tabs, windows, lastActiveTabId = null) {
    const focusedWindowIds = new Set(
        (windows || []).filter(window => window.focused).map(window => window.windowId)
    );
    const activeTabs = (tabs || []).filter(tab => tab.active);

    const explicitlyFocused = activeTabs.find(tab => focusedWindowIds.has(tab.windowId));
    if (explicitlyFocused) return explicitlyFocused;

    const lastActive = activeTabs.find(tab => tab.tabId === lastActiveTabId);
    if (lastActive) return lastActive;

    return activeTabs.length === 1 ? activeTabs[0] : null;
}
