import test from "node:test";
import assert from "node:assert/strict";

import {
    REVISIT_MODEL_DEFAULTS,
    normalizeIdentity,
    scoreBayesian,
    scoreContext,
    scoreHierarchical,
    scoreHistory
} from "../../src/lib/revisit-model.js";

test("MVP defaults to the paper-validated domain resolution", () => {
    assert.equal(REVISIT_MODEL_DEFAULTS.resolution, "domain");
});

test("normalizeIdentity removes fragments and separates page from domain", () => {
    assert.deepEqual(
        normalizeIdentity("https://www.Example.com:8443/docs/page?q=one#section"),
        {
            page: "https://example.com:8443/docs/page?q=one",
            domain: "example.com"
        }
    );
    assert.equal(normalizeIdentity("chrome://settings"), null);
});

test("History uses power-law decay and accumulates repeated accesses", () => {
    const now = 1_000_000;
    const recent = scoreHistory([now - 1_000], now, 0.5);
    const old = scoreHistory([now - 100_000], now, 0.5);
    const repeated = scoreHistory([now - 1_000, now - 100_000], now, 0.5);

    assert.ok(recent > old);
    assert.ok(repeated > recent);
    assert.equal(scoreHistory([], now), Number.NEGATIVE_INFINITY);
});

test("Context is neutral without evidence and favors observed transitions", () => {
    const transitions = {
        current: { likely: 8, unlikely: 2 }
    };

    assert.equal(scoreContext("likely", "missing", transitions), 0);
    assert.ok(scoreContext("likely", "current", transitions, 0.01) > 0);
    assert.ok(scoreContext("unknown", "current", transitions, 0.01) < 0);
});

test("Bayesian score adds History and Context in log-odds space", () => {
    const now = 1_000_000;
    const result = scoreBayesian({
        accessTimestamps: [now - 1_000, now - 4_000],
        candidateIdentity: "candidate",
        currentIdentity: "current",
        transitions: { current: { candidate: 4, other: 1 } },
        now
    });

    assert.ok(Number.isFinite(result.history));
    assert.ok(result.context > 0);
    assert.equal(result.score, result.history + result.context);
});

test("hierarchical score uses domain evidence and page History", () => {
    assert.equal(
        scoreHierarchical({ domain: { score: 2 }, page: { history: 1.5 } }),
        3.5
    );
    assert.equal(
        scoreHierarchical({ domain: { score: 2 }, page: { history: Number.NEGATIVE_INFINITY } }),
        2
    );
});
