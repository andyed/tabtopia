import test from "node:test";
import assert from "node:assert/strict";

import { buildArchiveEnrichment } from "../../src/lib/archive-enrichment.js";

const NOW = Date.UTC(2026, 6, 26, 16);

test("semantic rank selects related archive hits before stronger fallback recurrence", () => {
  const result = buildArchiveEnrichment({
    now: NOW,
    limit: 2,
    archiveItems: [
      archive("https://related.example/paper", ["cognition"], 1, "Related paper"),
      archive("https://frequent.example/home", ["routine"], 80, "Frequent archive")
    ],
    semanticItems: [{ url: "https://related.example/paper", rank: 1 }]
  });

  assert.equal(result.items[0].action.target.title, "Related paper");
  assert.equal(result.items[0].source, "semantic");
  assert.equal(result.items[0].interestState, "resurfacing");
  assert.equal(result.sourceCounts.semantic, 1);
});

test("context overlap uses tags from an exact archive URL match, not context-provided tags", () => {
  const result = buildArchiveEnrichment({
    now: NOW,
    archiveItems: [
      archive("https://context.example/current", ["act-r", "memory"], 2, "Current"),
      archive("https://candidate.example/model", ["act-r", "prediction"], 2, "Candidate"),
      archive("https://fake.example/nope", ["untrusted-context-tag"], 50, "Fake")
    ],
    contextItems: [{
      url: "https://context.example/current#section",
      tags: ["untrusted-context-tag"],
      isLocal: true
    }]
  });

  assert.equal(result.items[0].action.target.title, "Candidate");
  assert.equal(result.items[0].source, "context");
  assert.equal(result.items[0].interestState, "active-now");
  assert.deepEqual(result.items[0].topics, ["act-r", "prediction"]);
  assert.equal(result.items[0].reason.includes("untrusted"), false);
});

test("foreign context produces qualitative resurfacing evidence", () => {
  const result = buildArchiveEnrichment({
    now: NOW,
    archiveItems: [
      archive("https://foreign.example/current", ["webgpu"], 2, "Foreign current"),
      archive("https://archive.example/simulation", ["webgpu", "physics"], 3, "Simulation")
    ],
    contextItems: [{ url: "https://foreign.example/current", isLocal: false }]
  });

  assert.equal(result.items[0].interestState, "resurfacing");
  assert.equal(result.items[0].evidence.foreignContext, true);
  assert.match(result.items[0].reason, /another device/);
  assert.equal(JSON.stringify(result).includes("percent"), false);
});

test("durable fallback distinguishes recurring from one-off archive items", () => {
  const result = buildArchiveEnrichment({
    now: NOW,
    archiveItems: [
      archive("https://recurring.example/", ["systems"], 7, "Recurring"),
      archive("https://one-off.example/", ["misc"], 1, "One off")
    ]
  });

  assert.equal(result.items[0].action.target.title, "Recurring");
  assert.equal(result.items[0].source, "fallback");
  assert.equal(result.items[0].interestState, "recurring");
  assert.equal(result.items[1].interestState, "archive");
});

test("URL and tag dedupe respects selected, current, and open exclusions", () => {
  const result = buildArchiveEnrichment({
    now: NOW,
    archiveItems: [
      archive("https://www.example.com/article#one", ["AI", " ai ", "Research"], 2, "First"),
      archive("https://example.com/article#two", ["research", "Models"], 3, "Second"),
      { ...archive("https://open.example/", ["open"], 9, "Open"), open: true },
      { ...archive("https://current.example/", ["current"], 8, "Current"), current: true },
      archive("https://selected.example/", ["selected"], 7, "Selected")
    ],
    selectedUrls: ["https://selected.example/#chosen"]
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].action.target.title, "Second");
  assert.deepEqual(result.items[0].topics, ["ai", "models"]);
  assert.equal(result.items[0].action.verb, "open");
});

test("duplicate representative selection is deterministic under exact timestamp ties", () => {
  const duplicates = [
    archive("https://same.example/page", ["beta"], 2, "Zulu title"),
    archive("https://same.example/page", ["alpha"], 2, "Alpha title")
  ];
  const left = buildArchiveEnrichment({ now: NOW, archiveItems: duplicates });
  const right = buildArchiveEnrichment({ now: NOW, archiveItems: duplicates.slice().reverse() });

  assert.deepEqual(left, right);
  assert.equal(left.items[0].action.target.title, "Alpha title");
  assert.deepEqual(left.items[0].topics, ["alpha", "beta"]);
});

test("output defaults to four, is deterministic, and tolerates malformed data", () => {
  const valid = Array.from({ length: 8 }, (_, index) =>
    archive(`https://site-${index}.example/`, [`Tag ${index}`], 2, `Site ${index}`));
  const malformed = [null, {}, { url: "not a url", tags: 42 }, { url: "file:///tmp/private" }];
  const left = buildArchiveEnrichment({ now: NOW, archiveItems: [...valid, ...malformed] });
  const right = buildArchiveEnrichment({ now: NOW, archiveItems: [...malformed, ...valid.slice().reverse()] });

  assert.equal(left.items.length, 4);
  assert.deepEqual(left, right);
  assert.equal(left.items.every(item => item.topics.length <= 2), true);
  assert.equal(left.items.every(item => ["resurfacing", "active-now", "recurring", "archive"].includes(item.interestState)), true);
});

function archive(url, tags, visitCount, title) {
  return {
    url,
    title,
    tags,
    visitCount,
    lastVisitTime: NOW - 60_000,
    archivedAt: NOW - 10_000_000
  };
}
