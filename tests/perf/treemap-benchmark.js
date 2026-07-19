// Reproducible treemap cost probe. Launches the real unpacked extension with a
// 40-page local workload, then reports first paint, hover latency, synchronous
// SVG measurement, and the cost of one ordinary tab navigation.

const http = require("http");
const { launchExtensionContext } = require("../e2e/fixtures.js");

const TAB_COUNT = 40;

async function metrics(cdp) {
  const result = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(result.metrics.map(metric => [metric.name, metric.value]));
}

async function main() {
  const server = http.createServer((request, response) => {
    const id = (request.url || "/0").slice(1);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Perf Page ${id}</title><h1>Perf Page ${id}</h1>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

  const port = server.address().port;
  const context = await launchExtensionContext("");

  try {
    const workloadPages = [];
    for (let index = 0; index < TAB_COUNT; index += 1) {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/${index}`, { waitUntil: "domcontentloaded" });
      workloadPages.push(page);
    }

    const newtab = await context.newPage();
    await newtab.addInitScript(() => {
      window.__treemapPerfProbe = { getBBox: 0, timeout500: 0, directSvgAdds: 0 };
      window.__startupMarks = {};

      const markFirstMatch = (name, selector) => {
        if (window.__startupMarks[name] != null || !document.querySelector(selector)) return;
        window.__startupMarks[name] = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          window.__startupMarks[`${name}PaintOpportunity`] = performance.now();
        }));
      };
      const startupObserver = new MutationObserver(() => {
        markFirstMatch("shell", ".app-header");
        markFirstMatch("sidebar", "#readout .readout-intro");
        markFirstMatch("treemap", "#treemap svg");
        if (window.__startupMarks.treemap != null) startupObserver.disconnect();
      });
      startupObserver.observe(document, { childList: true, subtree: true });

      const nativeTimeout = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => {
        if (delay === 500) window.__treemapPerfProbe.timeout500 += 1;
        return nativeTimeout(callback, delay, ...args);
      };

      const nativeGetBBox = SVGGraphicsElement.prototype.getBBox;
      SVGGraphicsElement.prototype.getBBox = function (...args) {
        window.__treemapPerfProbe.getBBox += 1;
        return nativeGetBBox.apply(this, args);
      };
    });

    const cdp = await context.newCDPSession(newtab);
    await cdp.send("Performance.enable");

    const paintStarted = performance.now();
    await newtab.goto("chrome://newtab/", { waitUntil: "domcontentloaded" });
    await newtab.waitForFunction(
      count => document.querySelectorAll("#treemap .cell").length >= count,
      TAB_COUNT,
      { timeout: 15000 }
    );
    const firstPaintMs = performance.now() - paintStarted;
    const initialMetrics = await metrics(cdp);
    const initialProbe = await newtab.evaluate(() => window.__treemapPerfProbe);
    const startup = await newtab.evaluate(() => ({
      ...window.__startupMarks,
      browserPaints: performance.getEntriesByType("paint").map(entry => ({
        name: entry.name,
        startTime: +entry.startTime.toFixed(1),
      })),
    }));

    const hoverStarted = performance.now();
    await newtab.locator("#treemap .cell").first().hover();
    await newtab.locator("#readout .readout-title").waitFor({ state: "visible" });
    const hoverReadoutMs = performance.now() - hoverStarted;

    await newtab.evaluate(() => {
      const treemap = document.getElementById("treemap");
      const observer = new MutationObserver(records => {
        for (const record of records) {
          if (record.target !== treemap) continue;
          for (const node of record.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && node.matches?.("svg")) {
              window.__treemapPerfProbe.directSvgAdds += 1;
            }
          }
        }
      });
      observer.observe(treemap, { childList: true });
      window.__treemapPerfObserver = observer;
    });

    const beforeNavigationMetrics = await metrics(cdp);
    const beforeNavigationProbe = await newtab.evaluate(() => ({ ...window.__treemapPerfProbe }));
    await workloadPages[0].goto(`http://127.0.0.1:${port}/navigated`, { waitUntil: "load" });
    await newtab.waitForTimeout(1200);
    const afterNavigationMetrics = await metrics(cdp);
    const afterNavigationProbe = await newtab.evaluate(() => {
      window.__treemapPerfObserver?.disconnect();
      return { ...window.__treemapPerfProbe };
    });

    const report = {
      renderedCells: await newtab.locator("#treemap .cell").count(),
      firstPaintMs: +firstPaintMs.toFixed(1),
      hoverReadoutMs: +hoverReadoutMs.toFixed(1),
      startup: Object.fromEntries(Object.entries(startup).map(([key, value]) => [
        key,
        typeof value === "number" ? +value.toFixed(1) : value,
      ])),
      initial: {
        heapMB: +(initialMetrics.JSHeapUsedSize / 1048576).toFixed(2),
        domNodes: initialMetrics.Nodes,
        layoutCount: initialMetrics.LayoutCount,
        styleRecalcCount: initialMetrics.RecalcStyleCount,
        getBBoxCalls: initialProbe.getBBox,
        timeout500Calls: initialProbe.timeout500,
      },
      oneNavigation: {
        directSvgAdds: afterNavigationProbe.directSvgAdds - beforeNavigationProbe.directSvgAdds,
        layoutDelta: afterNavigationMetrics.LayoutCount - beforeNavigationMetrics.LayoutCount,
        styleRecalcDelta: afterNavigationMetrics.RecalcStyleCount - beforeNavigationMetrics.RecalcStyleCount,
        getBBoxDelta: afterNavigationProbe.getBBox - beforeNavigationProbe.getBBox,
        timeout500Delta: afterNavigationProbe.timeout500 - beforeNavigationProbe.timeout500,
        scriptMs: +((afterNavigationMetrics.ScriptDuration - beforeNavigationMetrics.ScriptDuration) * 1000).toFixed(1),
        taskMs: +((afterNavigationMetrics.TaskDuration - beforeNavigationMetrics.TaskDuration) * 1000).toFixed(1),
      },
    };

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await cdp.detach();
  } finally {
    await context.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
