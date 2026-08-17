// What a new tab pays to boot: script inventory, and what the blocking vendor
// bundles actually cost to evaluate.
//
//   node tests/perf/newtab-boot-benchmark.js
//
// WHY BOTH HALVES. newtab.html loads d3.min.js and lunr.min.js as classic
// scripts at the end of <body>. Classic scripts run in order and block any
// module script that follows, so newtab.js — the module that renders the view —
// waits behind ~302 KB of vendor code. That reads like an obvious thing to
// defer.
//
// It is not. Measured 2026-08-05: d3 compiles and evaluates in **0.3 ms**, lunr
// in under 0.1 ms. V8 lazily compiles function bodies, so the top-level eval of
// a minified UMD bundle barely touches the clock, and these come off local disk
// with no network in the path. Deferring them would buy roughly a third of a
// millisecond against a ~68 ms first contentful paint.
//
// The byte count is therefore NOT the signal. Run the second half before acting
// on the first — this benchmark exists mainly to stop that theory being
// relitigated from the file sizes alone. See newtab-profile.js for where boot
// time really goes (short version: nowhere alarming).
//
// Uses launchExtensionContext() from the e2e fixtures rather than launching its
// own Chrome: extensions only load under `--headless=new`, and the manifest pins
// the extension id with a `key`, so both details have to match the suite exactly.

const fs = require('fs');
const path = require('path');
const { launchExtensionContext } = require('../e2e/fixtures');

const EXT_ROOT = path.resolve(__dirname, '..', '..');
const EVAL_RUNS = 7;

(async () => {
  const context = await launchExtensionContext('');

  let [sw] = context.serviceWorkers();
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);
  }
  if (!sw) {
    console.error('Could not resolve the extension service worker — is the manifest loading?');
    await context.close();
    process.exit(1);
  }
  const extensionId = sw.url().split('/')[2];

  const page = await context.newPage();

  // The Resource Timing API does not surface chrome-extension:// resources, so
  // script fetches are captured at the network layer instead. Sizes come from
  // disk, since the response body of an extension resource is not always
  // reported with a content-length.
  const fetched = [];
  const t0 = Date.now();
  page.on('request', (req) => {
    if (!req.url().endsWith('.js')) return;
    const rel = req.url().replace(`chrome-extension://${extensionId}/`, '');
    let kb = 0;
    try { kb = +(fs.statSync(path.join(EXT_ROOT, rel)).size / 1024).toFixed(1); } catch { /* generated or inline */ }
    fetched.push({ rel, kb, atMs: Date.now() - t0 });
  });

  await page.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html`,
    { waitUntil: 'load' });

  // Let deferred module work settle so late-loaded chunks show up too.
  await page.waitForTimeout(2500);

  const report = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};

    return {
      domContentLoadedMs: +(nav.domContentLoadedEventEnd || 0).toFixed(1),
      loadMs: +(nav.loadEventEnd || 0).toFixed(1),
      // Globals the vendor bundles define, so we can see what actually got
      // evaluated by the time the view is up.
      d3Loaded: typeof window.d3 !== 'undefined',
      lunrLoaded: typeof window.lunr !== 'undefined',
    };
  });

  // A classic <script> blocks every module script that follows it, so anything
  // requested before newtab.js is on the critical path to the view rendering.
  const entryIdx = fetched.findIndex(f => f.rel.endsWith('newtab/newtab.js'));
  const blocking = entryIdx > 0 ? fetched.slice(0, entryIdx) : [];
  const blockingKB = +blocking.reduce((n, f) => n + f.kb, 0).toFixed(1);
  const totalKB = +fetched.reduce((n, f) => n + f.kb, 0).toFixed(1);

  console.log('--- newtab boot ---');
  console.log(`DOMContentLoaded   ${report.domContentLoadedMs} ms`);
  console.log(`load               ${report.loadMs} ms`);
  console.log(`scripts fetched    ${fetched.length} (${totalKB} KB total)`);
  console.log(`d3 evaluated       ${report.d3Loaded}`);
  console.log(`lunr evaluated     ${report.lunrLoaded}`);
  console.log(`\nParsed BEFORE newtab.js may run: ${blockingKB} KB`);
  for (const f of blocking) console.log(`  ${f.rel} — ${f.kb} KB`);
  console.log('\n--- every script fetch, in order ---');
  for (const f of fetched) {
    console.log(`  ${String(f.atMs).padStart(6)}ms ${String(f.kb).padStart(8)}KB  ${f.rel}`);
  }

  // --- what those blocking bytes actually cost -------------------------------
  console.log(`\n--- compile + evaluate, median of ${EVAL_RUNS} runs (local disk, no network) ---`);
  for (const rel of ['src/lib/d3.min.js', 'src/lib/lunr.min.js']) {
    let src;
    try { src = fs.readFileSync(path.join(EXT_ROOT, rel), 'utf8'); } catch { continue; }

    const samples = await page.evaluate(({ src, runs }) => {
      const times = [];
      for (let i = 0; i < runs; i++) {
        // A fresh <script> per run, with a unique tail so V8's compilation cache
        // cannot serve the previous run. Appending executes it, which is the same
        // work the browser does at boot.
        const el = document.createElement('script');
        el.textContent = `${src}\n//${i}`;
        const t0 = performance.now();
        document.head.appendChild(el);
        const t1 = performance.now();
        el.remove();
        times.push(t1 - t0);
      }
      return times;
    }, { src, runs: EVAL_RUNS });

    samples.sort((a, b) => a - b);
    console.log(
      `  ${rel.split('/').pop().padEnd(14)} ${(Buffer.byteLength(src) / 1024).toFixed(1).padStart(7)} KB   ` +
      `median ${samples[Math.floor(samples.length / 2)].toFixed(1)} ms   ` +
      `(min ${samples[0].toFixed(1)}, max ${samples[samples.length - 1].toFixed(1)})`
    );
  }
  console.log('\n  Sub-millisecond evaluation is the expected result. If you came here to');
  console.log('  defer these bundles, the bytes are not what is costing you.');

  await context.close();
})();
