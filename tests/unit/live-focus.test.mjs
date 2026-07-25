import test from "node:test";
import assert from "node:assert/strict";

import { selectLiveFocusedTab } from "../../src/lib/live-focus.js";

const tab = (tabId, windowId, active = true) => ({ tabId, windowId, active });
const window = (windowId, focused = false) => ({ windowId, focused });

test("uses the active tab in Chrome's focused window", () => {
    const tabs = [tab(10, 1), tab(20, 2)];
    assert.equal(selectLiveFocusedTab(tabs, [window(1), window(2, true)], 10), tabs[1]);
});

test("keeps a single active Chrome tab when another app is frontmost", () => {
    const tabs = [tab(10, 1)];
    assert.equal(selectLiveFocusedTab(tabs, [window(1)], null), tabs[0]);
});

test("uses the last active tab to disambiguate background Chrome windows", () => {
    const tabs = [tab(10, 1), tab(20, 2)];
    assert.equal(selectLiveFocusedTab(tabs, [window(1), window(2)], 20), tabs[1]);
});

test("does not invent focus when multiple background windows are ambiguous", () => {
    const tabs = [tab(10, 1), tab(20, 2)];
    assert.equal(selectLiveFocusedTab(tabs, [window(1), window(2)], null), null);
});

test("ignores a stale last-active tab that is no longer active", () => {
    const tabs = [tab(10, 1, false), tab(20, 2), tab(30, 3)];
    assert.equal(selectLiveFocusedTab(tabs, [window(1), window(2), window(3)], 10), null);
});
