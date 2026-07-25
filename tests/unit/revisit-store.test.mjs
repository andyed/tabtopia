import test from "node:test";
import assert from "node:assert/strict";

import { RevisitStore } from "../../src/lib/revisit-store.js";

class MemoryStorage {
    constructor() {
        this.values = {};
    }

    async get(keys) {
        return Object.fromEntries(keys.filter(key => key in this.values).map(key => [key, this.values[key]]));
    }

    async set(values) {
        Object.assign(this.values, structuredClone(values));
    }
}

test("revisit store persists keyed identities and scores History/Context", async () => {
    const storage = new MemoryStorage();
    const store = await new RevisitStore(storage).init();
    const now = Date.now();

    await store.recordAccess("https://alpha.example/one", "", now - 10_000);
    await store.recordAccess("https://beta.example/two", "https://alpha.example/one", now - 5_000);
    await store.recordAccess("https://beta.example/two", "https://alpha.example/one", now - 1_000);
    await store.flush();

    const serialized = JSON.stringify(storage.values);
    assert.equal(serialized.includes("alpha.example"), false);
    assert.equal(serialized.includes("beta.example"), false);

    const [score] = await store.scoreTabs(
        [{ id: 2, url: "https://beta.example/two" }],
        "https://alpha.example/one",
        now
    );
    assert.equal(score.source, "bayesian");
    assert.ok(Number.isFinite(score.score));
});

test("History-only candidate scoring preserves page/domain evidence and ignores transitions", async () => {
    const storage = new MemoryStorage();
    const store = await new RevisitStore(storage).init();
    const now = Date.now();

    await store.recordAccess("https://alpha.example/one", "", now - 30_000);
    await store.recordAccess("https://beta.example/two", "https://alpha.example/one", now - 20_000);
    await store.recordAccess("https://beta.example/three", "https://alpha.example/one", now - 10_000);
    await store.recordAccess("https://beta.example/two", "https://alpha.example/one", now - 1_000);

    const scores = await store.scoreHistoryCandidates([
        { key: "alpha", url: "https://alpha.example/one" },
        { key: "beta", url: "https://beta.example/two" },
        { key: "unknown", url: "https://unknown.example/" }
    ], now);
    const byKey = new Map(scores.map(score => [score.key, score]));

    assert.ok(byKey.get("beta").domain.activation > byKey.get("alpha").domain.activation);
    assert.equal(byKey.get("beta").domain.accessCount, 3);
    assert.equal(byKey.get("beta").page.accessCount, 2);
    assert.equal(byKey.get("unknown").domain.activation, Number.NEGATIVE_INFINITY);
    assert.equal(byKey.get("unknown").domain.accessCount, 0);

    const serialized = JSON.stringify(storage.values);
    assert.equal(serialized.includes("alpha.example"), false);
    assert.equal(serialized.includes("beta.example"), false);
    assert.equal(serialized.includes("unknown.example"), false);
    await store.flush();
});

test("clearing derived revisit History removes every scored candidate", async () => {
    const storage = new MemoryStorage();
    const store = await new RevisitStore(storage).init();
    const now = Date.now();

    await store.recordAccess("https://clear.example/", "", now - 1_000);
    assert.ok(Number.isFinite(
        (await store.scoreHistoryCandidates([{ key: "clear", url: "https://clear.example/" }], now))[0]
            .domain.activation
    ));

    await store.clear();
    const [cleared] = await store.scoreHistoryCandidates([
        { key: "clear", url: "https://clear.example/" }
    ], now);

    assert.equal(cleared.domain.activation, Number.NEGATIVE_INFINITY);
    assert.equal(cleared.domain.accessCount, 0);
});
