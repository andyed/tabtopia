import test from "node:test";
import assert from "node:assert/strict";

import {
    buildRecallCandidate,
    escapeOmniboxText,
    normalizeQuery,
    rankTabs,
    rankTabsByFrecency,
    scoreText
} from "../../src/lib/tab-recall.js";

const tab = (id, title, url, behavior = {}) => buildRecallCandidate({
    id,
    windowId: 1,
    title,
    url,
    lastAccessed: behavior.lastAccessed || 0
}, behavior);

test("query normalization is Unicode-aware and punctuation tolerant", () => {
    assert.deepEqual(normalizeQuery("  Café—Bayes / Tabs "), ["café", "bayes", "tabs"]);
});

test("title matches outrank domain and path matches", () => {
    const query = normalizeQuery("bayes");
    const titleMatch = scoreText(query, tab(1, "Bayesian tabs", "https://example.com/a"));
    const domainMatch = scoreText(query, tab(2, "Notes", "https://bayes.example.com/a"));
    assert.ok(titleMatch.score > domainMatch.score);
});

test("every query token must match the candidate", () => {
    const candidate = tab(1, "Bayesian revisitation", "https://rice.edu/paper");
    assert.ok(scoreText("bayesian rice", candidate).score > 0);
    assert.equal(scoreText("bayesian missing", candidate).score, 0);
});

test("typed recall prioritizes text while Bayesian score breaks ambiguity", () => {
    const candidates = [
        tab(1, "Tabtopia spec", "https://example.com/spec", { bayesianScore: 1, lastAccessed: 10 }),
        tab(2, "Tabtopia spec", "https://example.com/other", { bayesianScore: 4, lastAccessed: 5 })
    ];
    assert.deepEqual(rankTabs("tabtopia", candidates).map(item => item.tabId), [2, 1]);
});

test("empty query excludes the current tab and falls back to recency", () => {
    const candidates = [
        tab(1, "Current", "https://example.com/current", { lastAccessed: 30 }),
        tab(2, "Older", "https://example.com/older", { lastAccessed: 10 }),
        tab(3, "Newer", "https://example.com/newer", { lastAccessed: 20 })
    ];
    assert.deepEqual(rankTabs("", candidates, { currentTabId: 1 }).map(item => item.tabId), [3, 2]);
});

test("frecency shadow baseline is independently rankable", () => {
    const candidates = [
        tab(1, "Current", "https://example.com/current", { frecencyScore: 99 }),
        tab(2, "Bayesian favorite", "https://example.com/bayes", {
            bayesianScore: 10,
            frecencyScore: 1,
            lastAccessed: 20
        }),
        tab(3, "Frequent favorite", "https://example.com/frequent", {
            bayesianScore: 1,
            frecencyScore: 10,
            lastAccessed: 10
        })
    ];
    assert.deepEqual(
        rankTabsByFrecency(candidates, { currentTabId: 1 }).map(item => item.tabId),
        [3, 2]
    );
});

test("typed query demotes the current tab below an otherwise equal result", () => {
    const candidates = [
        tab(1, "Same title", "https://example.com/one", { bayesianScore: 2, lastAccessed: 10 }),
        tab(2, "Same title", "https://example.com/two", { bayesianScore: 2, lastAccessed: 10 })
    ];
    assert.deepEqual(
        rankTabs("same", candidates, { currentTabId: 1 }).map(item => item.tabId),
        [2, 1]
    );
});

test("omnibox markup escapes all predefined XML entities", () => {
    assert.equal(
        escapeOmniboxText(`<tag a="b">Tom & 'Ada'</tag>`),
        "&lt;tag a=&quot;b&quot;&gt;Tom &amp; &apos;Ada&apos;&lt;/tag&gt;"
    );
});
