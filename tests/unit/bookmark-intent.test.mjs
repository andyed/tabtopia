import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { BookmarkIntentStudy, flattenBookmarkTree, BOOKMARK_INTENT_KEY } from "../../src/lib/bookmark-intent.js";

const page = { id: "4", url: "https://example.test/article", title: "Read more", dateAdded: 1000 };
const tree = [{ id: "0", children: [{ id: "3", title: "A localized name", folderType: "mobile", syncing: true,
    children: [{ title: "Research", children: [page] }] }] }];
function fixture() {
    let now = 100000, enabled = true;
    const values = {};
    const storage = { get: async () => structuredClone(values), set: async data => Object.assign(values, structuredClone(data)),
        remove: async key => { delete values[key]; } };
    const config = { digest: async value => createHmac("sha256", "secret").update(value).digest("base64"),
        isEnabled: () => enabled, now: () => now };
    const store = new BookmarkIntentStudy(storage, config);
    return { store, storage, config, values, advance: ms => { now += ms; }, disable: () => { enabled = false; },
        focus: (tabId = 1) => store.updateFocus({ url: page.url, tabId, focused: true }) };
}

test("folder type survives flattening; names and syncing alone never assert mobile origin", () => {
    const [result] = flattenBookmarkTree(tree);
    assert.equal(result.mobileFolder, true);
    assert.deepEqual(result.folderPath, ["A localized name", "Research"]);
    assert.equal(flattenBookmarkTree([{ title: "Mobile bookmarks", syncing: true, children: [page] }])[0].mobileFolder, false);
    assert.equal(flattenBookmarkTree([result])[0].mobileFolder, true);
});

test("mobile placeholders are tracked before any visit; opening is separate from deep desktop engagement", async () => {
    const f = fixture();
    await f.store.syncBookmarks(tree);
    assert.equal((await f.store.summary()).groups[0].pending, 1);
    assert.equal((await f.focus()).remainingMs, 2000);
    f.advance(2000); await f.focus();
    let summary = (await f.store.summary()).groups[0];
    assert.equal(summary.opened, 1); assert.equal(summary.engaged, 0); assert.equal(summary.pending, 1);
    f.advance(28000); await f.focus();
    summary = (await f.store.summary()).groups[0];
    assert.equal(summary.engaged, 1); assert.equal(summary.pending, 0);
    assert.ok((await f.store.evidence([page]))[page.url].desktopEngagedAt);
    for (const text of [page.url, page.title, "Research", "tabId"]) assert.equal(JSON.stringify(f.values).includes(text), false);
});

test("focus loss, switching same-URL tabs, worker restart and suspended timers do not manufacture deep reading", async () => {
    const f = fixture(); await f.store.syncBookmarks(tree);
    await f.focus(); f.advance(20000); await f.store.updateFocus(null);
    await f.focus(); f.advance(20000); await f.focus(2);
    f.advance(20000); await f.focus(2);
    assert.equal((await f.store.summary()).groups[0].engaged, 0);
    const restarted = new BookmarkIntentStudy(f.storage, f.config);
    f.advance(20000); await restarted.updateFocus({ url: page.url, tabId: 2, focused: true });
    assert.equal((await restarted.summary()).groups[0].engaged, 0);
    f.advance(3600000); await restarted.updateFocus({ url: page.url, tabId: 2, focused: true });
    assert.equal((await restarted.summary()).groups[0].engaged, 0);
});

test("resaving renews intention; deleting bookmarks removes tracked identities; disabling writes nothing", async () => {
    const f = fixture(); await f.store.syncBookmarks(tree);
    await f.focus(); f.advance(30000); await f.focus();
    const newer = structuredClone(tree); newer[0].children[0].children[0].children[0].dateAdded = 110000;
    await f.store.syncBookmarks(newer);
    assert.equal((await f.store.summary()).groups[0].pending, 1);
    await f.store.syncBookmarks([]);
    assert.deepEqual(f.values[BOOKMARK_INTENT_KEY].entries, {});
    await f.store.clear(); f.disable();
    assert.equal(await f.store.syncBookmarks(tree), false);
    assert.deepEqual(f.values, {});
});

test("clearing during an in-flight identity lookup cannot restore focus or saved observations", async () => {
    const f = fixture(); await f.store.syncBookmarks(tree);
    let release;
    const digest = f.store.digest;
    f.store.digest = value => new Promise(resolve => { release = async () => resolve(await digest(value)); });
    const observing = f.focus();
    while (!release) await Promise.resolve();
    const clearing = f.store.clear();
    await release();
    await Promise.all([observing, clearing]);
    assert.equal(f.store.focus, null);
    assert.deepEqual(f.values, {});
});
