import test from "node:test";
import assert from "node:assert/strict";

import { resolveActivationOrigin } from "../../src/lib/activation-origin.js";

test("activation origin falls back to the live Chrome tab when tracked state has no URL", async () => {
    const trackedTabs = new Map();
    const getTab = async tabId => ({ id: tabId, url: "https://origin.example/path" });

    const origin = await resolveActivationOrigin(42, trackedTabs, getTab);

    assert.equal(origin, "https://origin.example/path");
});

test("activation origin prefers the synchronous tracked URL", async () => {
    const trackedTabs = new Map([[42, { url: "https://tracked.example/" }]]);
    let queried = false;

    const origin = await resolveActivationOrigin(42, trackedTabs, async () => {
        queried = true;
        return { url: "https://live.example/" };
    });

    assert.equal(origin, "https://tracked.example/");
    assert.equal(queried, false);
});

test("activation origin degrades to empty when the previous tab disappeared", async () => {
    const origin = await resolveActivationOrigin(42, new Map(), async () => {
        throw new Error("No tab with id: 42");
    });

    assert.equal(origin, "");
});
