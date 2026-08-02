import assert from "node:assert/strict";
import test from "node:test";

import {
  compactBrowserState,
  compactHeroImageRecord,
  compactHeroImageStore,
  isStorageQuotaError,
  mergeHeroImageStore,
  storageByteLength
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

test("browserState retention removes stale tabs and bounds every hot activity tail", () => {
  const hugeText = "x".repeat(20_000);
  const events = Array.from({ length: 120 }, (_, index) => ({
    type: index % 2 ? "focus" : "link_interaction",
    timestamp: 1_000 + index,
    data: {
      targetUrl: `https://example.com/${index}?payload=${hugeText}`,
      surroundingText: hugeText,
      formData: { searchQuery: hugeText, secret: hugeText }
    }
  }));
  const navigations = Array.from({ length: 120 }, (_, index) => ({
    type: "other_navigation",
    timestamp: 2_000 + index,
    url: `https://example.com/#${hugeText}${index}`
  }));
  const history = Array.from({ length: 120 }, (_, index) => ({
    timestamp: 3_000 + index,
    url: `https://example.com/history/${index}?${hugeText}`,
    title: hugeText
  }));

  const compacted = compactBrowserState({
    tabHistory: { 1: history, 999: history },
    tabRelationships: {
      1: {
        referringTabId: 999,
        referringURL: `https://example.com/${hugeText}`,
        childTabs: Array.from({ length: 40 }, (_, index) => ({
          tabId: index % 2 ? 1 : 999,
          timestamp: 4_000 + index,
          url: `https://example.com/child/${index}`
        }))
      }
    },
    tabActivityLog: {
      1: { totalTimeSpent: 42, events, navigations },
      999: { events, navigations }
    },
    tabAudioTracking: { 1: { totalAudioDuration: 12 }, 999: { totalAudioDuration: 99 } },
    lastActive: { tabId: 999, windowId: 4, timestamp: 9_000 },
    lastSaved: 10_000
  }, {
    liveTabIds: [1],
    maxBytes: 64 * 1024,
    maxHistoryEntries: 10,
    maxEvents: 10,
    maxNavigations: 10,
    maxChildren: 5
  });

  assert.deepEqual(Object.keys(compacted.tabActivityLog), ["1"]);
  assert.deepEqual(Object.keys(compacted.tabHistory), ["1"]);
  assert.equal(compacted.tabActivityLog[1].events.length <= 10, true);
  assert.equal(compacted.tabActivityLog[1].navigations.length <= 10, true);
  assert.equal(compacted.tabHistory[1].length <= 10, true);
  assert.equal(compacted.tabHistory[1][0].timestamp, 3_119);
  assert.equal(compacted.tabRelationships[1].childTabs.every(child => child.tabId === 1), true);
  assert.equal(compacted.tabActivityLog[1].events.at(-1).data.surroundingText.length <= 512, true);
  assert.equal(compacted.tabActivityLog[1].navigations.at(-1).url.length <= 2048, true);
  assert.equal(compacted.lastActive, null);
  assert.equal(storageByteLength(compacted) <= 64 * 1024, true);
});

test("browserState retention enforces a global byte budget across many live tabs", () => {
  const state = {
    tabHistory: {},
    tabRelationships: {},
    tabActivityLog: {},
    tabAudioTracking: {},
    lastSaved: 42
  };
  const liveTabIds = [];
  for (let tabId = 1; tabId <= 160; tabId += 1) {
    liveTabIds.push(tabId);
    state.tabActivityLog[tabId] = {
      lastTouch: tabId,
      events: Array.from({ length: 80 }, (_, index) => ({
        type: "link_interaction",
        timestamp: index,
        data: { surroundingText: "context".repeat(500), targetUrl: `https://example.com/${tabId}/${index}` }
      })),
      navigations: Array.from({ length: 80 }, (_, index) => ({
        type: "other_navigation",
        timestamp: index,
        url: `https://example.com/${tabId}/#${"state".repeat(500)}`
      }))
    };
  }

  const compacted = compactBrowserState(state, {
    liveTabIds,
    maxBytes: 128 * 1024,
    maxTabs: 128
  });

  assert.equal(storageByteLength(compacted) <= 128 * 1024, true);
  assert.equal(Object.keys(compacted.tabActivityLog).length <= 128, true);
  assert.equal(Object.hasOwn(compacted.tabActivityLog, "160"), true);
});
