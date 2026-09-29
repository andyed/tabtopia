import test from "node:test";
import assert from "node:assert/strict";
import { buildEmbeddingInputs, fitEmbeddingInput, fuseSemanticEvidence, RETRIEVAL_PREFIX } from "../../src/lib/semantic-evidence.js";

test("intent, page and saved-intent stay separate; assistant text cannot become an explicit user intent", () => {
    assert.deepEqual(buildEmbeddingInputs({ assistantText: "User must want this" }), []);
    const facets = buildEmbeddingInputs({ userIntent: "resume paper", constraints: "local only", title: "Study",
        excerpt: "Lots of text", bookmarkTitle: "Read later", bookmarkFolder: "Mobile bookmarks" });
    assert.deepEqual(facets.map(x => x.name), ["intent", "page", "saved-intent"]);
    assert.equal(facets[0].fields.some(f => f.text === "Lots of text"), false);
});

test("token budgeting preserves short constraints and titles when a long passage must shrink", async () => {
    const facet = buildEmbeddingInputs({ title: "Important title", excerpt: "long content ".repeat(400) })[0];
    const result = await fitEmbeddingInput(facet, async text => text.length, 150);
    assert.ok(result.tokens <= 150); assert.equal(result.truncated, true);
    assert.ok(result.text.startsWith(RETRIEVAL_PREFIX)); assert.ok(result.text.includes("Important title"));
});

test("fusion removes future evidence, bounds same-session repetition and exposes missing availability provenance", () => {
    const hits = Array.from({ length: 4 }, (_, i) => ({ id: i, score: .9 - i / 10,
        payload: { event_id: `event-${i}`, session: "same", timestamp: "2026-09-01T00:00:00Z", summary: "record" } }));
    hits.push({ id: 99, score: 1, payload: { timestamp: "2026-10-01T00:00:00Z" } });
    hits.push({ id: 100, score: 1, payload: { timestamp: "2026-09-01T00:00:00Z",
        available_at: "2026-10-01T00:00:00Z" } });
    const results = fuseSemanticEvidence([{ collection: "chat", facet: "intent", hits },
        { collection: "chat", facet: "page", hits }], { asOf: Date.parse("2026-09-28T00:00:00Z") });
    assert.equal(results.length, 2); assert.equal(results[0].matches.length, 2);
    assert.equal(results[0].temporalEvaluationEligible, false);
    assert.equal(results[0].availableAt, null);
});

test("duplicate captures cannot amplify a page's vote within one facet", () => {
    const hit = (id, url) => ({ id, score: .8, payload: { url, date_added: "2026-09-01T00:00:00Z" } });
    const results = fuseSemanticEvidence([{ collection: "pages", facet: "intent", hits: [
        hit(1, "https://first.test/"), hit(2, "https://second.test/"), hit(3, "https://second.test/")
    ] }]);
    assert.equal(results[0].url, "https://first.test/");
    assert.equal(results[1].matches.length, 1);
});
