// Where does new tab boot time actually go?
//
// The blocking-bytes theory did not survive measurement (see
// vendor-eval-benchmark.js: d3 evaluates in 0.3 ms), so this profiles the real
// timeline instead — long tasks, and the wall-clock until the treemap has
// actually drawn something the user can read.
//
//   node tests/perf/newtab-profile.js

const path = require('path');
const { launchExtensionContext } = require('../e2e/fixtures');

const RUNS = 5;

(async () => {
  const context = await launchExtensionContext('');
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);
  const extensionId = sw ? sw.url().split('/')[2] : null;
  if (!extensionId) { console.error('no extension id'); await context.close(); process.exit(1); }

  // Give the extension real tabs to map — an empty browser makes the treemap
  // trivial and hides whatever scales with tab count. Tabtopia exists for heavy
  // tab users, so the interesting question is how this curve behaves, not how it
  // reads at a dozen.
  const TAB_COUNT = Number(process.env.TABS || 12);
  for (let i = 0; i < TAB_COUNT; i++) {
    const t = await context.newPage();
    await t.goto('data:text/html,<title>Fixture ' + i + '</title><h1>' + i + '</h1>')
      .catch(() => {});
  }

  const url = `chrome-extension://${extensionId}/src/newtab/newtab.html`;
  const runs = [];

  for (let run = 0; run < RUNS; run++) {
    const page = await context.newPage();

    // Collect long tasks from the very first frame.
    await page.addInitScript(() => {
      window.__longTasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__longTasks.push({ start: +e.startTime.toFixed(1), dur: +e.duration.toFixed(1) });
          }
        }).observe({ entryTypes: ['longtask'] });
      } catch { /* longtask unsupported */ }
    });

    await page.goto(url, { waitUntil: 'load' });

    // Wall clock until the treemap has painted readable cells.
    let treemapMs = null;
    try {
      treemapMs = await page.evaluate(async () => {
        const start = performance.now();
        const deadline = start + 10_000;
        while (performance.now() < deadline) {
          const cells = document.querySelectorAll(
            '#treemap [aria-label], #treemap .cell, #treemap g.node, svg .cell, [data-tab-id]'
          );
          // Wait for a plausible map, not the first stray element — a single
          // matching node would time the shell, not the treemap.
          if (cells.length >= 3) return +performance.now().toFixed(1);
          await new Promise(r => requestAnimationFrame(r));
        }
        return null;
      });
    } catch { /* view may not expose those hooks */ }

    const m = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const cellCount = document.querySelectorAll(
        '#treemap [aria-label], #treemap .cell, #treemap g.node, svg .cell, [data-tab-id]'
      ).length;
      const paints = {};
      for (const p of performance.getEntriesByType('paint')) paints[p.name] = +p.startTime.toFixed(1);
      const lt = window.__longTasks || [];
      return {
        cellCount,
        domContentLoaded: +(nav.domContentLoadedEventEnd || 0).toFixed(1),
        load: +(nav.loadEventEnd || 0).toFixed(1),
        firstPaint: paints['first-paint'] ?? null,
        firstContentfulPaint: paints['first-contentful-paint'] ?? null,
        longTaskCount: lt.length,
        longTaskTotalMs: +lt.reduce((n, t) => n + t.dur, 0).toFixed(1),
        longestTaskMs: lt.length ? +Math.max(...lt.map(t => t.dur)).toFixed(1) : 0,
        longTasks: lt.slice(0, 8),
      };
    });

    runs.push({ ...m, treemapMs });
    await page.close();
  }

  const med = (key) => {
    const vals = runs.map(r => r[key]).filter(v => typeof v === 'number').sort((a, b) => a - b);
    return vals.length ? vals[Math.floor(vals.length / 2)] : null;
  };

  console.log(`--- newtab boot profile (median of ${RUNS} runs, ${TAB_COUNT} open tabs) ---\n`);
  console.log(`  treemap cells drawn     ${med('cellCount')}`);
  console.log(`  first paint             ${med('firstPaint')} ms`);
  console.log(`  first contentful paint  ${med('firstContentfulPaint')} ms`);
  console.log(`  DOMContentLoaded        ${med('domContentLoaded')} ms`);
  console.log(`  load                    ${med('load')} ms`);
  console.log(`  treemap cells visible   ${med('treemapMs')} ms`);
  console.log(`\n  long tasks              ${med('longTaskCount')} blocking the main thread`);
  console.log(`  time in long tasks      ${med('longTaskTotalMs')} ms`);
  console.log(`  longest single task     ${med('longestTaskMs')} ms`);
  console.log('\n  longest run\'s tasks:');
  const worst = runs.reduce((a, b) => (b.longTaskTotalMs > a.longTaskTotalMs ? b : a), runs[0]);
  for (const t of worst.longTasks) console.log(`    at ${String(t.start).padStart(8)}ms  for ${t.dur} ms`);

  await context.close();
})();
