#!/usr/bin/env node
// BIGFU-safe: default Playwright headless shell, never full Chrome.
// Runs the shipped host page + iframe over loopback with a read-only storage shim.
// An optional loopback inventory endpoint stays in memory; output excludes URLs,
// titles, screenshots, raw errors and CPU profiles. Do not save private fixtures.
const { chromium } = require('@playwright/test');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const args = process.argv.slice(2);
const arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const runs = Number(arg('--runs', 3)), timeout = Number(arg('--timeout-ms', 45000));
const count = Number(arg('--count', 214)), groups = Number(arg('--groups', 54));
const imageDelayMs = Number(arg('--image-delay-ms', 0));
const out = arg('--out', 'test-results/wunderkammer-boot.json');
const root = path.resolve(__dirname, '../..');
const round = n => Math.round(n * 10) / 10;

function fixture(count) {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`https://site-${i % groups}.invalid/page-${i}`, {
    title: `Image ${i}`, timestamp: 1794340000000 - i * 1000,
    images: [{ src: `https://images.invalid/image-${i}.jpg`, width: 1200, height: 800 }]
  }]));
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' };
async function main() {
  const endpoint = arg('--inventory-url', null);
  if (endpoint && !['127.0.0.1', '[::1]', 'localhost'].includes(new URL(endpoint).hostname)) throw new Error('Inventory endpoint must be loopback');
  const response = endpoint ? await fetch(endpoint) : null;
  if (response && !response.ok) throw new Error('Inventory endpoint failed');
  const store = response ? await response.json() : fixture(count);
  const sourceURLs = new Set(Object.values(store).flatMap(r => (r.images || []).map(i => i.src)));
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/__perf__/')) {
      if (imageDelayMs) await new Promise(resolve => setTimeout(resolve, imageDelayMs));
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#46685b"/></svg>');
    }
    const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    try { res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); res.end(await fs.readFile(file)); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const report = { capturedAt: new Date().toISOString(), platform: os.platform(), cpus: os.cpus().length,
    browser: browser.version(), source: {}, input: { kind: endpoint ? 'private-in-memory' : 'synthetic',
      records: Object.keys(store).length, distinctImageURLs: sourceURLs.size, controlImageDelayMs: imageDelayMs },
    method: 'Shipped host and iframe over HTTP; read-only chrome.storage shim; fresh contexts; 1440x900 DPR2; CPU/network only, no GPU claims. Real-host runs use empty cache/cookies. Instant control substitutes small SVGs, preserving layout and image count.', runs: [] };
  report.sourceHashEncoding = 'UTF-8, CRLF normalized to LF';
  for (const name of ['src/newtab/wunderkammer.js', 'src/lib/hero-collection.js', 'src/vendor/wunderkammer/wall/wall.mjs', 'src/vendor/wunderkammer/wall/overview-surface.mjs']) {
    report.source[name] = crypto.createHash('sha256').update((await fs.readFile(path.join(root, name), 'utf8')).replace(/\r\n/g, '\n')).digest('hex');
  }
  try {
    const controlMode = imageDelayMs ? 'delayed-control' : 'instant-control';
    for (const mode of endpoint ? [controlMode, 'original'] : [controlMode]) {
      for (let run = 1; run <= runs; run++) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
        // Route interception disables Chromium's HTTP cache, which distorts
        // duplicate-image costs. Serve the control normally instead.
        const controlURLs = new Map([...sourceURLs].map((u, i) => [u, `${origin}/__perf__/image-${i}.svg`]));
        const runStore = mode === 'original' ? store : Object.fromEntries(Object.entries(store).map(([key, record]) =>
          [key, { ...record, images: record.images.map(image => ({ ...image, src: controlURLs.get(image.src) })) }]));
        await context.addInitScript(({ store }) => {
          window.__cwPerfEnable = true;
          window.chrome = { ...window.chrome, storage: { local: { get: async () => ({ heroImages: store }) },
            onChanged: { addListener() {}, removeListener() {} } } };
          const samples = window.__bootSamples = [], long = window.__bootLong = [];
          new PerformanceObserver(list => long.push(...list.getEntries().map(e => ({ start: e.startTime, ms: e.duration })))).observe({ type: 'longtask' });
          if (!location.pathname.includes('/vendor/wunderkammer/index.html')) return;
          const tick = () => {
            const stage = document.querySelector('#stage')?.getBoundingClientRect();
            if (!stage) return;
            const visible = [...document.querySelectorAll('#canvas .tile')].filter(tile => {
              const r = tile.getBoundingClientRect();
              return getComputedStyle(tile).visibility !== 'hidden' && r.width > 0 && r.right > stage.left && r.left < stage.right && r.bottom > stage.top && r.top < stage.bottom;
            });
            const shown = visible.filter(tile => tile.classList.contains('overview-painted') || [...tile.querySelectorAll(':scope > img')].some(i => i.complete && i.naturalWidth > 0));
            samples.push({ ms: performance.now(), ready: document.body.dataset.viewReady === 'true',
              visible: visible.length, shown: shown.length, broken: visible.filter(t => t.classList.contains('broken')).length });
          };
          window.__bootTimer = setInterval(tick, 100);
          window.__bootTick = tick;
        }, { store: runStore });
        const page = await context.newPage(), cdp = await context.newCDPSession(page);
        await cdp.send('Performance.enable'); await cdp.send('Network.enable');
        const requests = new Map(); let errors = 0;
        page.on('pageerror', () => errors++);
        cdp.on('Network.requestWillBeSent', e => {
          if (e.type === 'Image' && (!e.request.url.startsWith(origin + '/') || e.request.url.includes('/__perf__/'))) {
            requests.set(e.requestId, { key: e.request.url, start: e.timestamp, bytes: 0 });
          }
        });
        cdp.on('Network.responseReceived', e => { const r = requests.get(e.requestId); if (r) { r.status = e.response.status; r.ttfbMs = round((e.timestamp - r.start) * 1000); } });
        cdp.on('Network.loadingFinished', e => { const r = requests.get(e.requestId); if (r) { r.bytes = e.encodedDataLength; r.ms = round((e.timestamp - r.start) * 1000); } });
        cdp.on('Network.loadingFailed', e => { const r = requests.get(e.requestId); if (r) { r.failed = true; r.ms = round((e.timestamp - r.start) * 1000); } });
        const start = Date.now();
        await page.goto(origin + '/src/newtab/wunderkammer.html', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelector('#hero-main').getAttribute('aria-busy') === 'false');
        const readyMs = Date.now() - start;
        const frame = page.frames().find(f => f.url().includes('/vendor/wunderkammer/index.html'));
        if (!frame) throw new Error('Viewer frame not found');
        const settlement = await frame.evaluate(async timeout => {
          try { return { ok: true, ...await window.wunderkammer.whenStill({ timeout }) }; }
          catch (error) { return { ok: false, reason: error.message.replace(/https?:\S+/g, '[redacted]') }; }
        }, timeout);
        const elapsedMs = Date.now() - start;
        const app = await frame.evaluate(() => {
          clearInterval(window.__bootTimer); window.__bootTick();
          const p = window.__cwPerf.snapshot();
          return { samples: window.__bootSamples, longTasks: window.__bootLong,
            spans: p.spans, counters: p.counters, gauges: p.gauges };
        });
        const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
        const rows = [...requests.values()], durations = rows.filter(r => Number.isFinite(r.ms)).map(r => r.ms).sort((a, b) => a - b);
        const last = app.samples.at(-1), first = app.samples.find(s => s.shown > 0);
        const p95 = app.samples.find(s => s.ready && s.visible > 0 && s.shown / s.visible >= .95);
        const row = { mode, run, readyMs, elapsedMs, settlement,
          // Samples are iframe navigation-relative, not host navigation-relative.
          firstImageFrameMs: first ? round(first.ms) : null, images95FrameMs: p95 ? round(p95.ms) : null,
          final: last, imageNetwork: { requests: rows.length, distinctURLs: new Set(rows.map(r => r.key)).size,
            transferredMB: round(rows.reduce((n, r) => n + r.bytes, 0) / 1048576),
            pending: rows.filter(r => r.ms == null).length, failed: rows.filter(r => r.failed).length,
            httpErrors: rows.filter(r => r.status >= 400).length,
            statuses: rows.reduce((o, r) => { const k = r.status || 'no-response'; o[k] = (o[k] || 0) + 1; return o; }, {}),
            p50Ms: durations[Math.floor(durations.length * .5)] ?? null, p95Ms: durations[Math.floor(durations.length * .95)] ?? null,
            maxMs: durations.at(-1) ?? null },
          cpu: { scriptMs: round(metrics.ScriptDuration * 1000), layoutMs: round(metrics.LayoutDuration * 1000),
            styleMs: round(metrics.RecalcStyleDuration * 1000), taskMs: round(metrics.TaskDuration * 1000), heapMB: round(metrics.JSHeapUsedSize / 1048576) },
          pageErrors: errors, app };
        report.runs.push(row);
        console.log(JSON.stringify({ mode, run, readyMs, elapsedMs, settled: settlement.ok, firstImageFrameMs: row.firstImageFrameMs, images95FrameMs: row.images95FrameMs, final: last, network: row.imageNetwork, cpu: row.cpu }));
        await fs.mkdir(path.dirname(out), { recursive: true });
        await fs.writeFile(out, JSON.stringify(report, null, 2));
        await context.close();
      }
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(() => { console.error('Wunderkammer benchmark failed; raw errors suppressed to protect private URLs.'); process.exitCode = 1; });
