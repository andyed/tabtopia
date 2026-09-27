import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { HomeRecommendationStore, HOME_RECOMMENDATION_KEY as KEY, HOME_RECOMMENDATION_SESSION_KEY as SESSION, HOME_RECOMMENDATION_SNOOZE_KEY as SNOOZE } from "../../src/lib/home-recommendation-store.js";

function storage() {
    const data = {}; let writes = 0;
    return { data, get writes() { return writes; }, async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in data).map(key => [key, structuredClone(data[key])]));
    }, async set(values) { writes++; Object.assign(data, structuredClone(values)); }, async remove(key) { delete data[key]; } };
}
function fixture({ enabled: initial = true } = {}) {
    const local = storage(), session = storage();
    let now = Date.parse("2026-09-27T12:00:00Z"), enabled = initial;
    const options = { now: () => now, isEnabled: () => enabled,
        digest: async value => createHmac("sha256", "private-test-key").update(value).digest("base64") };
    const store = new HomeRecommendationStore(local, session, options);
    return { local, session, store, options, advance(ms) { now += ms; }, setEnabled(value) { enabled = value; } };
}
const URL = "https://private.example/document?query=secret";
const impression = (id = "view-1", candidates = [{ url: URL, identity: URL, rank: 1 }], arm = "balanced") => ({ impressionId: id, sourceTabId: 12, candidates, arm });
const choice = () => ({ impressionId: "view-1", sourceTabId: 12, targetTabId: 42, url: URL, rank: 1 });
const focus = () => ({ url: URL, tabId: 42, focused: true });
async function clicked(f) { await f.store.recordImpression(impression()); await f.store.recordChoice(choice()); }

test("disabled diagnostics write nothing, while explicit snooze preference and Undo remain available", async () => {
    const f = fixture({ enabled: false });
    assert.equal(await f.store.recordImpression(impression()), false);
    assert.equal(await f.store.recordChoice(choice()), false);
    assert.equal(await f.store.updateFocus(focus()), false);
    await f.store.getFeedback({ identities: [URL] });
    await f.store.summary();
    assert.equal(f.local.writes + f.session.writes, 0);
    assert.equal(await f.store.snooze({ url: URL, durationMs: 60000 }), true);
    assert.ok((await f.store.getFeedback({ identities: [URL] }))[URL].snoozedUntil > 0);
    assert.equal(f.local.data[KEY], undefined);
    assert.equal(f.session.data[SESSION], undefined);
    await f.store.snooze({ url: URL, durationMs: 0 });
    assert.equal((await f.store.getFeedback({ identities: [URL] }))[URL].snoozedUntil, 0);
});

test("cumulative same-page exposures deduplicate concurrent rerenders and preserve assigned arm", async () => {
    const f = fixture();
    await Promise.all([f.store.recordImpression(impression()), f.store.recordImpression(impression())]);
    await f.store.recordImpression(impression("view-1", [{ url: URL, rank: 1 }, { url: "https://other.example/", rank: 2 }], "explore"));
    const summary = await f.store.summary();
    assert.equal(summary.arms.balanced.impressions, 1);
    assert.equal(summary.arms.balanced.exposures, 2);
    assert.equal(summary.arms.explore.exposures, 0);
    assert.equal((await f.store.getFeedback({ identities: [URL] }))[URL].impressions, 1);
});

test("HMAC feedback and whitelisted details never persist URL, identity, title, source tab or impression ID", async () => {
    const f = fixture();
    await clicked(f);
    await f.store.snooze({ url: URL, durationMs: 60000 });
    const serialized = JSON.stringify(f.local.data);
    for (const sensitive of ["private.example", "secret", "view-1", "sourceTabId", "identity", "url", "title"]) assert.equal(serialized.includes(sensitive), false);
    assert.ok(JSON.stringify(f.session.data).includes(URL));
    const feedback = await f.store.getFeedback({ identities: [URL, "https://absent.example/"] });
    assert.deepEqual(Object.keys(feedback), [URL, "https://absent.example/"]);
    assert.equal(feedback["https://absent.example/"].impressions, 0);
});

test("choice must match displayed identity and rank in the source launcher", async () => {
    const f = fixture();
    await f.store.recordImpression(impression());
    for (const invalid of [{ sourceTabId: 66 }, { rank: 2 }, { url: "https://elsewhere.example/" }]) {
        assert.equal(await f.store.recordChoice({ ...choice(), ...invalid }), false);
    }
    assert.equal(await f.store.recordChoice(choice()), true);
    assert.equal(await f.store.recordChoice(choice()), false);
    assert.equal((await f.store.summary()).arms.balanced.clicks, 1);
});

test("engagement requires ten continuous focused seconds after click and cannot duplicate", async () => {
    const f = fixture();
    await clicked(f);
    assert.equal((await f.store.updateFocus(focus())).remainingMs, 10000);
    f.advance(9999);
    assert.equal((await f.store.updateFocus(focus())).remainingMs, 1);
    assert.equal((await f.store.summary()).arms.balanced.engaged, 0);
    f.advance(1);
    assert.equal(await f.store.updateFocus(focus()), null);
    assert.equal(await f.store.updateFocus(focus()), null);
    assert.equal((await f.store.summary()).arms.balanced.engaged, 1);
    assert.equal((await f.store.getFeedback({ identities: [URL] }))[URL].engaged, 1);
});

test("blur or navigation cancels dwell and records one bounce, never background engagement", async () => {
    for (const departure of [null, { url: "https://other.example/", tabId: 42, focused: true }, { ...focus(), focused: false }]) {
        const f = fixture(); await clicked(f); await f.store.updateFocus(focus()); f.advance(9000);
        await f.store.updateFocus(departure); f.advance(60000); await f.store.updateFocus(focus());
        const summary = await f.store.summary();
        assert.equal(summary.arms.balanced.bounces, 1); assert.equal(summary.arms.balanced.engaged, 0);
    }
});

test("before the chosen destination arrives, source newtab does not become a bounce", async () => {
    const f = fixture(); await clicked(f);
    await f.store.updateFocus({ tabId: 12, url: "chrome-extension://id/newtab.html", focused: true });
    assert.equal((await f.store.summary()).arms.balanced.bounces, 0);
    assert.equal((await f.store.updateFocus(focus())).remainingMs, 10000);
});

test("worker restart cannot claim suspended time as continuous focus", async () => {
    const f = fixture(); await clicked(f); await f.store.updateFocus(focus()); f.advance(11000);
    const restarted = new HomeRecommendationStore(f.local, f.session, f.options);
    assert.equal((await restarted.updateFocus(focus())).remainingMs, 10000);
    assert.equal((await restarted.summary()).arms.balanced.engaged, 0);
});

test("daily retention expires old cohorts; detail buffer stays bounded", async () => {
    const f = fixture();
    for (let i = 0; i < 270; i++) await f.store.recordImpression(impression(`view-${i}`));
    assert.equal(f.local.data[KEY].details.length, 500);
    assert.equal((await f.store.summary()).arms.balanced.exposures, 270);
    f.advance(28 * 86400000);
    await f.store.recordImpression(impression("new-day", undefined, "explore"));
    const summary = await f.store.summary();
    assert.equal(summary.retainedDays, 1); assert.equal(summary.arms.balanced.exposures, 0); assert.equal(summary.arms.explore.exposures, 1);
});

test("clear serializes against queued writes and preserves only explicit snoozes", async () => {
    const f = fixture(); await clicked(f); await f.store.snooze({ url: URL, durationMs: 60000 });
    const oldWrite = f.store.recordImpression(impression("queued"));
    const clearing = f.store.clear();
    await Promise.all([oldWrite, clearing]);
    assert.equal(f.local.data[KEY], undefined); assert.equal(f.session.data[SESSION], undefined); assert.ok(f.local.data[SNOOZE]);
    const clearAgain = f.store.clear();
    const newWrite = f.store.recordImpression(impression("after-clear"));
    await Promise.all([clearAgain, newWrite]);
    assert.equal((await f.store.summary()).arms.balanced.impressions, 1);
});


test("another tab with the same URL cannot satisfy a selected destination", async () => {
    const f = fixture(); await clicked(f);
    assert.equal(await f.store.updateFocus({ ...focus(), tabId: 99 }), null);
    f.advance(15000);
    assert.equal(await f.store.updateFocus({ ...focus(), tabId: 99 }), null);
    assert.equal((await f.store.summary()).arms.balanced.engaged, 0);
    assert.equal((await f.store.updateFocus(focus())).remainingMs, 10000);
});

test("feedback exposure counts roll off even when a destination remains active", async () => {
    const f = fixture();
    await f.store.recordImpression(impression("old"));
    f.advance(27 * 86400000);
    await f.store.recordImpression(impression("recent"));
    assert.equal((await f.store.getFeedback({ identities: [URL] }))[URL].impressions, 2);
    f.advance(86400000);
    assert.equal((await f.store.getFeedback({ identities: [URL] }))[URL].impressions, 1);
});

test("off feedback with no snoozes does not invoke the HMAC provider", async () => {
    const f = fixture({ enabled: false });
    f.store.digest = () => { throw new Error("should not initialize key material"); };
    assert.equal((await f.store.getFeedback({ identities: [URL] }))[URL].impressions, 0);
});


test("failed navigation cancels only its own pending choice; natural arrival cannot engage and retry can rearm", async () => {
    const f = fixture(); await clicked(f);
    assert.equal(await f.store.cancelChoice({ ...choice(), sourceTabId: 99 }), false);
    assert.equal(await f.store.cancelChoice({ ...choice(), rank: 2 }), false);
    assert.equal(await f.store.cancelChoice({ ...choice(), impressionId: "other-page" }), false);
    assert.equal(await f.store.cancelChoice(choice()), true);
    assert.equal(await f.store.updateFocus(focus()), null);
    f.advance(11000);
    assert.equal(await f.store.updateFocus(focus()), null);
    assert.equal((await f.store.summary()).arms.balanced.engaged, 0);
    assert.equal((await f.store.summary()).arms.balanced.clicks, 1);
    assert.equal(await f.store.recordChoice(choice()), true);
    await f.store.updateFocus(focus()); f.advance(10000); await f.store.updateFocus(focus());
    assert.equal((await f.store.summary()).arms.balanced.engaged, 1);
    assert.equal((await f.store.summary()).arms.balanced.clicks, 2);
});
