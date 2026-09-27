import test from "node:test";
import assert from "node:assert/strict";
import { HomeContextDiagnostics, HOME_CONTEXT_BUFFER_KEY, HOME_CONTEXT_SESSION_KEY } from "../../src/lib/home-context-diagnostics.js";

function storage() {
    const data = {};
    let writes = 0;
    return { data, get writes() { return writes; }, async get(keys) {
        return Object.fromEntries(keys.filter(key => key in data).map(key => [key, structuredClone(data[key])]));
    }, async set(values) { writes++; Object.assign(data, structuredClone(values)); }, async remove(key) { delete data[key]; } };
}
function fixture(options = {}) {
    const local = storage(), session = storage();
    let now = 100000000, enabled = options.enabled ?? true;
    const diagnostics = new HomeContextDiagnostics(local, session, { now: () => now, isEnabled: () => enabled, ...options });
    return { local, session, diagnostics, advance(ms) { now += ms; }, disable() { enabled = false; } };
}
const impression = (id = "view-1") => ({ impressionId: id, state: "ready", candidates: [
    { url: "https://techmeme.com/", rank: 1 }, { url: "https://other.example/private?q=secret", rank: 2 }
] });

test("off diagnostics produce no session or durable writes", async () => {
    const f = fixture({ enabled: false });
    assert.equal(await f.diagnostics.recordImpression(impression(), 12), false);
    await f.diagnostics.recordChoice({ impressionId: "view-1", rank: 1, url: "https://techmeme.com/" }, 12);
    await f.diagnostics.recordQualifiedAccess({ url: "https://techmeme.com/", tabId: 12, qualifiedDwellMs: 2000 });
    assert.equal((await f.diagnostics.getSummary()).impressions, 0);
    assert.equal(f.local.writes + f.session.writes, 0);
});

test("rerender and concurrent duplicate impressions count once and retain no durable content", async () => {
    const f = fixture();
    await Promise.all([f.diagnostics.recordImpression(impression(), 12), f.diagnostics.recordImpression(impression(), 12)]);
    assert.equal((await f.diagnostics.getSummary()).impressions, 1);
    assert.equal(f.session.data[HOME_CONTEXT_SESSION_KEY].pending.candidates.length, 2);
    const serialized = JSON.stringify(f.local.data);
    for (const value of ["techmeme", "secret", "view-1", "sourceTabId", "url", "title"]) assert.equal(serialized.includes(value), false);
});

test("click is separate from qualified dwell, tied to launcher and offered URL/rank", async () => {
    const f = fixture();
    await f.diagnostics.recordImpression(impression(), 12);
    const click = { impressionId: "view-1", url: "https://techmeme.com/", rank: 1 };
    assert.equal(await f.diagnostics.recordChoice(click, 44), false);
    assert.equal(await f.diagnostics.recordChoice({ ...click, rank: 2 }, 12), false);
    assert.equal(await f.diagnostics.recordChoice(click, 12), true);
    assert.equal(await f.diagnostics.recordChoice(click, 12), false);
    assert.equal((await f.diagnostics.getSummary()).qualifiedOnList, 0);
    assert.equal(await f.diagnostics.recordQualifiedAccess({ url: click.url, tabId: 33, qualifiedDwellMs: 1999 }), false);
    assert.equal(await f.diagnostics.recordQualifiedAccess({ url: `${click.url}#fragment`, tabId: 33, qualifiedDwellMs: 2000 }), true);
    assert.equal(await f.diagnostics.recordQualifiedAccess({ url: click.url, tabId: 33, qualifiedDwellMs: 2000 }), false);
    const summary = await f.diagnostics.getSummary();
    assert.equal(summary.clicks, 1);
    assert.equal(summary.qualifiedClicks, 1);
});

test("unrelated tab switching and launcher page dwell are excluded; source navigation counts off-list once", async () => {
    const f = fixture();
    await f.diagnostics.recordImpression(impression(), 12);
    for (const access of [{ url: "chrome-extension://id/newtab", tabId: 12 }, { url: "https://unrelated.example/", tabId: 8 }]) {
        assert.equal(await f.diagnostics.recordQualifiedAccess({ ...access, qualifiedDwellMs: 2000 }), false);
    }
    assert.equal(await f.diagnostics.recordQualifiedAccess({ url: "https://unrelated.example/", tabId: 12, qualifiedDwellMs: 2000 }), true);
    assert.equal((await f.diagnostics.getSummary()).offList, 1);
});

test("natural same-tab on-list navigation remains distinct from explicit recommendation click", async () => {
    const f = fixture();
    await f.diagnostics.recordImpression(impression(), 12);
    await f.diagnostics.recordQualifiedAccess({ url: "https://techmeme.com/", tabId: 12, qualifiedDwellMs: 2000 });
    const summary = await f.diagnostics.getSummary();
    assert.equal(summary.qualifiedOnList, 1);
    assert.equal(summary.qualifiedClicks, 0);
});

test("expiry clears session URLs and refuses stale context; dismissals deduplicate", async () => {
    const f = fixture();
    await f.diagnostics.recordImpression(impression(), 12);
    const dismissal = { impressionId: "view-1", rank: 2 };
    assert.equal(await f.diagnostics.recordDismissal(dismissal, 12), true);
    assert.equal(await f.diagnostics.recordDismissal(dismissal, 12), false);
    f.advance(30 * 60 * 1000);
    const summary = await f.diagnostics.getSummary();
    assert.equal(summary.dismissals, 1);
    assert.equal(summary.expired, 1);
    assert.equal(f.session.data[HOME_CONTEXT_SESSION_KEY].pending, null);
    assert.equal(await f.diagnostics.recordImpression({ ...impression("stale"), contextGeneratedAt: 100000000 }, 12), false);
});

test("most recent exposure supersedes previous and durable events are bounded", async () => {
    const f = fixture({ maxRecords: 5 });
    for (let i = 0; i < 10; i++) await f.diagnostics.recordImpression(impression(`view-${i}`), 12);
    assert.equal(f.local.data[HOME_CONTEXT_BUFFER_KEY].length, 5);
    assert.equal(f.session.data[HOME_CONTEXT_SESSION_KEY].pending.id, "view-9");
    assert.equal(await f.diagnostics.recordChoice({ impressionId: "view-1", rank: 1, url: "https://techmeme.com/" }, 12), false);
});

test("clear removes durable and session data and cancels queued writes", async () => {
    const f = fixture();
    await f.diagnostics.recordImpression(impression(), 12);
    const queued = f.diagnostics.recordImpression(impression("queued"), 12);
    await f.diagnostics.clear();
    await queued;
    assert.deepEqual(f.local.data, {});
    assert.deepEqual(f.session.data, {});
    await f.diagnostics.recordImpression(impression("again"), 12);
    f.disable();
    await f.diagnostics.clear();
    assert.deepEqual(f.local.data, {});
    assert.deepEqual(f.session.data, {});
});


test("clear is a barrier before subsequent enabled impressions and retains canonical recognition state", async () => {
    const f = fixture();
    await f.diagnostics.recordImpression(impression("old"), 12);
    const clearing = f.diagnostics.clear();
    const next = f.diagnostics.recordImpression({ ...impression("new"), state: "reorientation" }, 12);
    await Promise.all([clearing, next]);
    assert.equal((await f.diagnostics.getSummary()).impressions, 1);
    assert.equal(f.session.data[HOME_CONTEXT_SESSION_KEY].pending.id, "new");
    assert.equal(f.local.data[HOME_CONTEXT_BUFFER_KEY][0].state, "reorientation");
});
