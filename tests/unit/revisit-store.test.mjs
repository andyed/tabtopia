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
