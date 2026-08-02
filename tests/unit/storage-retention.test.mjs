import assert from "node:assert/strict";
import test from "node:test";

import {
  compactHeroImageRecord,
  compactHeroImageStore,
  isStorageQuotaError,
  mergeHeroImageStore
} from "../../src/lib/storage-retention.js";

test("hero retention keeps only recent, displayable, bounded records", () => {
  const store = compactHeroImageStore({
    "https://example.com/old": {
      timestamp: 10,
      images: [{ src: "https://images.example.com/old.jpg", score: 20 }]
    },
    "https://example.com/new": {
      timestamp: 30,
      images: [
        { src: "data:image/png;base64,oversized", score: 100 },
        { src: "https://images.example.com/b.jpg", score: 40 },
        { src: "https://images.example.com/a.jpg", score: 50 },
        { src: "https://images.example.com/c.jpg", score: 30 },
        { src: "https://images.example.com/d.jpg", score: 20 }
      ]
    },
    "chrome://settings": {
      timestamp: 40,
      images: [{ src: "https://images.example.com/internal.jpg", score: 80 }]
    }
  }, { maxEntries: 1 });

  assert.deepEqual(Object.keys(store), ["https://example.com/new"]);
  assert.deepEqual(store["https://example.com/new"].images.map(image => image.src), [
    "https://images.example.com/a.jpg",
    "https://images.example.com/b.jpg",
    "https://images.example.com/c.jpg"
  ]);
});

test("merging a hero record deduplicates images and preserves the newest page", () => {
  const merged = mergeHeroImageStore({
    "https://example.com/existing": {
      timestamp: 20,
      images: [{ src: "https://images.example.com/existing.jpg", score: 10 }]
    }
  }, "https://example.com/new", {
    timestamp: 30,
    title: "A".repeat(500),
    images: [
      { src: "https://images.example.com/new.jpg", score: 10, alt: "Hero" },
      { src: "https://images.example.com/new.jpg", score: 5 }
    ]
  }, { maxEntries: 1 });

  assert.deepEqual(Object.keys(merged), ["https://example.com/new"]);
  assert.equal(merged["https://example.com/new"].images.length, 1);
  assert.equal(merged["https://example.com/new"].title.length, 320);
});

test("record compaction keeps the session-card metrics used by consumers", () => {
  const record = compactHeroImageRecord({
    timestamp: 42,
    metrics: { dwellTime: 1234, scrollDepth: 567 },
    images: [{
      src: "https://images.example.com/hero.jpg",
      width: 1200,
      height: 630,
      score: 100,
      isMetaImage: true
    }]
  });

  assert.equal(record.dwellTime, 1234);
  assert.equal(record.scrollDepth, 567);
  assert.equal(record.images[0].isMetaImage, true);
});

test("recognizes Chrome quota failures", () => {
  assert.equal(isStorageQuotaError(new Error("Resource::kQuotaBytes quota exceeded")), true);
  assert.equal(isStorageQuotaError(new Error("network failed")), false);
});
