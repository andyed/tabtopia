import test from "node:test";
import assert from "node:assert/strict";

import { LIKELY_TAB_FOCAL_LABEL, applyLikelyTab, createLikelyTabSlot } from "../../src/newtab/likely-tab-slot.js";

const LIKELY = { tabId: 42, windowId: 7, url: "https://example.test/doc", title: "Doc", domain: "example.test", labeled: true };

function quietModel(actions = [
    { id: "habit:a", verb: "open", target: { url: "https://a.test/" } },
    { id: "habit:doc", verb: "switch", target: { tabId: 42, windowId: 7, url: "https://example.test/doc", open: true } },
    { id: "star:b", verb: "open", target: { url: "https://b.test/" } }
]) {
    return { mode: "quiet", loading: false, actions };
}

async function readySlot(response) {
    const sent = [];
    const slot = createLikelyTabSlot({
        send: async message => {
            sent.push(message);
            return message.action === "getLikelyTab" ? response : { success: true };
        }
    });
    await slot.ready;
    sent.length = 0;
    return { slot, sent };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test("treatment puts the likely tab in the focal slot and moves today's focal into the list", async () => {
    const { slot, sent } = await readySlot({ success: true, arm: "treatment", likely: LIKELY });
    const shown = applyLikelyTab(slot, quietModel());

    assert.equal(shown.focalLabel, LIKELY_TAB_FOCAL_LABEL);
    assert.deepEqual(shown.actions.map(action => action.id), ["likely-tab:42", "habit:a", "star:b"],
        "the duplicate switch to the same tab is dropped");
    assert.deepEqual(shown.actions[0].target, { tabId: 42, windowId: 7, url: LIKELY.url, title: "Doc", open: true });
    await flush();
    assert.deepEqual(sent, [{ action: "recordPredictionExposure", arm: "treatment", labeled: true, kind: "impression" }]);
});

test("control leaves Home unchanged but counts the same moment", async () => {
    const { slot, sent } = await readySlot({ success: true, arm: "control", likely: LIKELY });
    const model = quietModel();
    assert.equal(applyLikelyTab(slot, model), model);
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].arm, "control");
});

test("a low-confidence or missing prediction changes nothing and counts nothing", async () => {
    for (const response of [
        { success: true, arm: "treatment", likely: { ...LIKELY, labeled: false } },
        { success: true, arm: null, likely: LIKELY },
        { success: false }
    ]) {
        const { slot, sent } = await readySlot(response);
        const model = quietModel();
        assert.equal(applyLikelyTab(slot, model), model);
        await flush();
        assert.equal(sent.length, 0);
    }
});

test("the slot is decided at the first settled quiet render and never moves afterwards", async () => {
    let resolve;
    const slot = createLikelyTabSlot({
        send: message => message.action === "getLikelyTab"
            ? new Promise(done => { resolve = done; })
            : Promise.resolve({ success: true })
    });
    await flush();
    assert.equal(applyLikelyTab(slot, { ...quietModel(), loading: true }).focalLabel, undefined, "loading renders do not decide");
    const first = applyLikelyTab(slot, quietModel());
    assert.equal(first.focalLabel, undefined);
    resolve({ success: true, arm: "treatment", likely: LIKELY });
    await slot.ready;
    assert.equal(applyLikelyTab(slot, quietModel()).focalLabel, undefined, "a late prediction stays off for this page");
});

test("re-renders keep the same likely tab and count one impression", async () => {
    const { slot, sent } = await readySlot({ success: true, arm: "treatment", likely: LIKELY });
    applyLikelyTab(slot, quietModel());
    const again = applyLikelyTab(slot, quietModel([{ id: "habit:z", verb: "open", target: { url: "https://z.test/" } }]));
    assert.deepEqual(again.actions.map(action => action.id), ["likely-tab:42", "habit:z"]);
    await flush();
    assert.equal(sent.filter(message => message.kind === "impression").length, 1);
});

test("a selection reports its displayed rank once, with the tab id only for a switch", async () => {
    const { slot, sent } = await readySlot({ success: true, arm: "treatment", likely: LIKELY });
    const shown = applyLikelyTab(slot, quietModel());
    await flush();
    sent.length = 0;

    assert.equal(slot.recordSelection({ id: "not-shown" }), false);
    assert.equal(slot.recordSelection(shown.actions[0]), true);
    assert.equal(slot.recordSelection(shown.actions[1]), false, "one selection per page");
    await flush();
    assert.deepEqual(sent, [{
        action: "recordPredictionExposure", arm: "treatment", labeled: true,
        kind: "selection", displayedRank: 1, tabId: 42
    }]);
});

test("other modes and the fresh-start view are never touched", async () => {
    const { slot } = await readySlot({ success: true, arm: "treatment", likely: LIKELY });
    for (const model of [{ ...quietModel(), mode: "engaged" }, { ...quietModel(), freshOverride: true }, { ...quietModel(), stale: true }]) {
        assert.equal(applyLikelyTab(slot, model), model);
    }
});
