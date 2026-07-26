import test from "node:test";
import assert from "node:assert/strict";

import {
  parseTechmemeRss,
  readCachedTechmeme,
  refreshTechmeme
} from "../../src/lib/techmeme-provider.js";

const STORAGE_KEY = "tabtopiaTechmemeProviderV1";
const NOW = Date.UTC(2026, 6, 26, 20, 0, 0);
const MINUTE = 60 * 1000;

test("parses bounded Techmeme permalinks and decodes titles without retaining description HTML", () => {
  const items = parseTechmemeRss(rss([
    item({
      title: "OpenAI &amp; memory &#x1F9E0; (Example)",
      url: "https://www.techmeme.com/260726/p1#a260726p1",
      description: "<script>not retained</script>"
    }),
    item({ title: "Reject foreign URL", url: "https://example.com/story" }),
    item({ title: "Duplicate", url: "https://www.techmeme.com/260726/p1#a260726p1" })
  ]));

  assert.equal(items.length, 1);
  assert.equal(items[0].title, "OpenAI & memory 🧠 (Example)");
  assert.equal(items[0].url, "https://www.techmeme.com/260726/p1#a260726p1");
  assert.equal("description" in items[0], false);
});

test("cached Techmeme is first-paint data and never fetches", async () => {
  const storage = new MemoryStorage({
    [STORAGE_KEY]: storedSnapshot({
      fetchedAt: NOW - MINUTE,
      items: [{
        title: "Cached AI headline",
        url: "https://www.techmeme.com/260726/p2#a260726p2",
        publishedAt: NOW - MINUTE
      }]
    })
  });

  const result = await readCachedTechmeme({ storage, now: NOW });

  assert.equal(result.status, "cached");
  assert.equal(result.freshness, "fresh");
  assert.equal(result.items[0].title, "Cached AI headline");
  assert.equal(storage.getCount, 1);
});

test("background refresh stores plain validated items and reports content changes once", async () => {
  const storage = new MemoryStorage();
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(url, "https://www.techmeme.com/feed.xml");
    assert.match(options.headers.Accept, /rss/);
    return response(rss([item({
      title: "AI systems update",
      url: "https://www.techmeme.com/260726/p3#a260726p3"
    })]));
  };

  const first = await refreshTechmeme({ storage, fetchImpl, now: NOW });
  const cached = await refreshTechmeme({ storage, fetchImpl, now: NOW + MINUTE });
  const forced = await refreshTechmeme({ storage, fetchImpl, now: NOW + (2 * MINUTE), force: true });

  assert.equal(first.status, "live");
  assert.equal(first.changed, true);
  assert.equal(cached.status, "cached");
  assert.equal(forced.status, "live");
  assert.equal(forced.changed, false);
  assert.equal(calls, 2);
});

test("offline refresh preserves stale cached headlines and never throws", async () => {
  const storage = new MemoryStorage({
    [STORAGE_KEY]: storedSnapshot({
      fetchedAt: NOW - (21 * MINUTE),
      items: [{
        title: "Still useful",
        url: "https://www.techmeme.com/260726/p4#a260726p4",
        publishedAt: NOW - (22 * MINUTE)
      }]
    })
  });

  const result = await refreshTechmeme({
    storage,
    fetchImpl: async () => { throw new Error("offline"); },
    now: NOW
  });

  assert.equal(result.status, "offline");
  assert.equal(result.freshness, "stale");
  assert.equal(result.items[0].title, "Still useful");
});

function rss(items) {
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items.join("")}</channel></rss>`;
}

function item({ title, url, description = "<p>ignored</p>" }) {
  return `<item><title>${title}</title><link>${url}</link><description><![CDATA[${description}]]></description><pubDate>Sun, 26 Jul 2026 15:35:00 -0400</pubDate></item>`;
}

function response(xml) {
  return { ok: true, text: async () => xml };
}

function storedSnapshot({ fetchedAt, items }) {
  return { version: 1, fetchedAt, items };
}

class MemoryStorage {
  constructor(initial = {}) {
    this.values = structuredClone(initial);
    this.getCount = 0;
  }

  async get(key) {
    this.getCount += 1;
    return { [key]: structuredClone(this.values[key]) };
  }

  async set(values) {
    Object.assign(this.values, structuredClone(values));
  }
}
