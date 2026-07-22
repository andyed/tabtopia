const { performance } = require("node:perf_hooks");

async function main() {
  const { buildRecallCandidate, rankTabs } = await import("../../src/lib/tab-recall.js");
  const { RevisitStore } = await import("../../src/lib/revisit-store.js");
  const sizes = [100, 500, 1000];
  const report = [];

  for (const size of sizes) {
    const candidates = Array.from({ length: size }, (_, index) => buildRecallCandidate({
      id: index + 1,
      windowId: (index % 4) + 1,
      title: index % 7 === 0 ? `Bayesian Tabtopia research ${index}` : `Reference page ${index}`,
      url: `https://domain-${index % 40}.example/docs/topic-${index}?q=${index}`,
      lastAccessed: Date.now() - (index * 60_000)
    }, {
      bayesianScore: Math.log1p(size - index),
      historyScore: Math.log1p((size - index) / 2),
      source: "bayesian"
    }));

    for (let index = 0; index < 20; index += 1) rankTabs("bayesian tab", candidates);
    const samples = [];
    for (let index = 0; index < 200; index += 1) {
      const start = performance.now();
      rankTabs(index % 2 ? "bayesian tab" : "domain 12", candidates);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    report.push({
      candidates: size,
      medianMs: round(samples[Math.floor(samples.length * 0.5)]),
      p95Ms: round(samples[Math.floor(samples.length * 0.95)])
    });
  }

  const storage = new MemoryStorage();
  const seedStore = await new RevisitStore(storage).init();
  const now = Date.now();
  for (let index = 0; index < 100; index += 1) {
    await seedStore.recordAccess(
      `https://domain-${index % 40}.example/docs/topic-${index}`,
      index ? `https://domain-${(index - 1) % 40}.example/docs/topic-${index - 1}` : "",
      now - ((100 - index) * 60_000)
    );
  }
  await seedStore.flush();

  const rawTabs = Array.from({ length: 500 }, (_, index) => ({
    id: index + 1,
    url: `https://domain-${index % 40}.example/docs/topic-${index}`,
  }));
  const coldSamples = [];
  for (let index = 0; index < 10; index += 1) {
    const coldStore = await new RevisitStore(storage).init();
    const start = performance.now();
    await coldStore.scoreTabs(rawTabs, rawTabs[0].url, now);
    coldSamples.push(performance.now() - start);
  }
  coldSamples.sort((a, b) => a - b);
  const behaviorColdP95Ms = round(coldSamples[Math.floor(coldSamples.length * 0.95)]);

  console.log(JSON.stringify({ benchmark: "omnibox-ranking", report, behaviorColdP95Ms }, null, 2));
  const target = report.find(entry => entry.candidates === 500);
  if (!target || target.p95Ms >= 50) {
    throw new Error(`500-tab omnibox p95 ${target?.p95Ms ?? "missing"}ms exceeds 50ms budget`);
  }
  if (behaviorColdP95Ms >= 200) {
    throw new Error(`500-tab cold behavior p95 ${behaviorColdP95Ms}ms exceeds 200ms budget`);
  }
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

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

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
