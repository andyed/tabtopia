import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { RevisitStudy, REVISIT_STUDY_KEY } from "../../src/lib/revisit-study.js";

function fixture() {
    const values = {};
    let now = 1800000000000, enabled = true;
    const storage = {
        get: async keys => Object.fromEntries(keys.map(key => [key, structuredClone(values[key])])),
        set: async data => Object.assign(values, structuredClone(data)),
        remove: async key => { delete values[key]; }
    };
    const config = { digest: async text => createHmac("sha256", "test-local-secret").update(text).digest("base64"),
        isEnabled: () => enabled, now: () => now };
    const store = new RevisitStudy(storage, config);
    const access = async (page, extra = {}, target = store) => {
        now += 3000;
        return target.recordAccess({ url: `https://example.test/${page}`, focused: true, qualifiedDwellMs: 2000, ...extra });
    };
    return { values, storage, config, store, access, advance: ms => { now += ms; }, disable: () => { enabled = false; } };
}

test("returns and nonreturns resolve only at the observed opportunity horizon", async () => {
    const f = fixture();
    await f.access("a");
    await f.access("b");
    await f.access("a");
    let summary = await f.store.getSummary();
    assert.equal(summary.horizons[0].resolved, 0); // no early positive training
    for (let i = 0; i < 8; i++) await f.access(`new-${i}`);
    summary = await f.store.getSummary();
    assert.equal(summary.qualifiedAccesses, 11);
    assert.equal(summary.horizons[0].resolved, 1);
    assert.equal(summary.horizons[0].returned, 1);
    assert.equal(summary.horizons[1].resolved, 0);
    await f.access("other");
    summary = await f.store.getSummary();
    assert.equal(summary.horizons[0].noObservedReturn, 1);
    assert.equal(summary.horizons[0].models[0].brier, 0.25);
    assert.equal(summary.horizons[0].models[0].balancedAccuracy, 0.5);
});

test("a return at the horizon boundary is positive and a later return cannot relabel a negative", async () => {
    const f = fixture();
    await f.access("a");
    for (let i = 0; i < 9; i++) await f.access(`b-${i}`);
    await f.access("a");
    assert.equal((await f.store.getSummary()).horizons[0].returned, 1);
    for (let i = 0; i < 39; i++) await f.access(`c-${i}`);
    await f.access("b-0");
    const summary = await f.store.getSummary();
    assert.equal(summary.horizons[0].returned, 1);
    assert.equal(summary.horizons[1].returned, 1);
});

test("duplicate load/refocus/fragment events do not create accesses, and tab ids are not the identity", async () => {
    const f = fixture();
    await f.access("a", { tabId: 1 });
    assert.equal(await f.access("a#section", { tabId: 2 }), false);
    assert.equal(await f.access("a"), false);
    await f.access("b");
    await f.access("a", { tabId: 900 }); // can be a closed page reopened elsewhere
    assert.equal((await f.store.getSummary()).qualifiedAccesses, 3);
    const stored = JSON.stringify(f.values);
    for (const text of ["example.test", "tabId", "https:"]) assert.equal(stored.includes(text), false);
});

test("foreground, dwell, incognito and enabled boundaries gate both capture and writes", async () => {
    const f = fixture();
    for (const extra of [{ focused: false }, { incognito: true }, { qualifiedDwellMs: 1999 }, { url: "chrome://newtab/" }]) {
        assert.equal(await f.access("a", extra), false);
    }
    assert.deepEqual(f.values, {});
    f.disable();
    assert.equal(await f.access("a"), false);
    assert.equal(await f.store.getSummary(), false);
    assert.deepEqual(f.values, {});
});

test("a worker restart preserves frozen predictions and an idle pause produces no negative labels", async () => {
    const f = fixture();
    await f.access("a");
    const predictions = structuredClone(f.values[REVISIT_STUDY_KEY].pending[0].predictions);
    f.advance(7 * 86400000);
    const restarted = new RevisitStudy(f.storage, f.config);
    assert.equal((await restarted.getSummary()).horizons[0].resolved, 0);
    assert.deepEqual(f.values[REVISIT_STUDY_KEY].pending[0].predictions, predictions);
    await f.access("b", {}, restarted);
    await f.access("a", {}, restarted);
    assert.equal((await restarted.getSummary()).seenBefore, 1);
});

test("expiry censors unfinished labels exactly once and clear removes all derived state", async () => {
    const f = fixture();
    await f.access("a");
    f.advance(91 * 86400000);
    let summary = await f.store.getSummary();
    assert.equal(summary.censoredLabels, 3);
    assert.equal(summary.pendingAnchors, 0);
    assert.equal(summary.horizons[0].resolved, 0);
    assert.equal((await f.store.getSummary()).censoredLabels, 3);
    await f.store.clear();
    assert.equal(f.values[REVISIT_STUDY_KEY], undefined);
});

test("serialization prevents lost accesses and failed writes retry without phantom outcomes", async () => {
    const f = fixture();
    await Promise.all([f.access("a"), f.access("b"), f.access("a")]);
    assert.equal((await f.store.getSummary()).qualifiedAccesses, 3);
    const set = f.storage.set;
    f.storage.set = async () => { throw new Error("quota"); };
    await assert.rejects(f.access("c"), /quota/);
    f.storage.set = set;
    await f.access("c");
    assert.equal((await f.store.getSummary()).qualifiedAccesses, 4);
});

test("clear invalidates queued access and cannot resurrect private state", async () => {
    const f = fixture();
    const pending = f.access("a");
    await f.store.clear();
    await pending;
    assert.equal(f.values[REVISIT_STUDY_KEY], undefined);
});

test("all horizons mature and report only bounded, identity-free metrics", async () => {
    const f = fixture();
    for (let i = 0; i < 230; i++) await f.access(i % 3 ? `new-${i}` : "returning");
    const summary = await f.store.getSummary();
    assert.deepEqual(summary.horizons.map(h => h.resolved), [220, 180, 30]);
    assert.equal(summary.pendingAnchors, 200);
    assert.equal(JSON.stringify(summary).includes("key"), false);
    assert.ok(summary.horizons[0].models[1].brier < summary.horizons[0].models[0].brier);
    assert.ok(JSON.stringify(f.values).length < 250000);
});
