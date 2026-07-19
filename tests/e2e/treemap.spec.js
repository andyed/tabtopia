// Treemap <-> readout interaction tests.
//
// These reproduce the exact behaviours that broke (and were hard to diagnose by
// reading the code): the hover preview, click-to-pin, and — the one Andy reported
// last — "after selecting a cell, selecting another one doesn't work".
//
// Data path under test: the newtab boot reads OPEN TABS live via
// chrome.windows.getAll() and renders one cell per tab (newtab.js categorizeData).
// So we just open a few known pages, then open the newtab view.

const { test, expect } = require("./fixtures");

const CELL = (title) => `#treemap .cell[aria-label="${title}"]`;

/**
 * Open the three fixture tabs, then the newtab view, and wait for the treemap to
 * paint the content cells. Returns { nt, tabs } — the newtab Page and the content
 * tab Pages (alpha, beta, gamma), in that order.
 */
async function openApp(context, server) {
  const tabs = [];
  for (const slug of ["/alpha", "/beta", "/gamma"]) {
    const tab = await context.newPage();
    await tab.goto(server + slug, { waitUntil: "load" });
    tabs.push(tab);
  }

  // newtab.html is registered as chrome_url_overrides.newtab. Chrome BLOCKS direct
  // navigation to a New Tab Page override via its chrome-extension:// URL
  // (net::ERR_BLOCKED_BY_CLIENT) — it's only reachable through the new-tab action.
  // Navigating to chrome://newtab/ makes Chrome render the override page for us.
  const nt = await context.newPage();
  nt.on("console", msg => { if (msg.type() === "error") console.log("BROWSER ERROR:", msg.text()); });
  nt.on("pageerror", err => console.log("PAGE ERROR:", err.message));
  await nt.goto("chrome://newtab/", { waitUntil: "domcontentloaded" });

  // Treemap is painted from the live tab list; wait for our known cells to exist.
  await expect(nt.locator(CELL("Alpha Page"))).toHaveCount(1);
  await expect(nt.locator(CELL("Beta Page"))).toHaveCount(1);
  await expect(nt.locator(CELL("Gamma Page"))).toHaveCount(1);
  return { nt, tabs };
}

test.describe("treemap ↔ readout", () => {
  test("parser paints the sidebar shell before treemap layout", async ({ context, server }) => {
    await context.addInitScript(() => {
      window.__startupOrder = [];
      const observer = new MutationObserver(() => {
        if (!window.__startupOrder.includes("sidebar") && document.querySelector("#readout .readout-intro")) {
          window.__startupOrder.push("sidebar");
        }
        if (!window.__startupOrder.includes("treemap") && document.querySelector("#treemap svg")) {
          window.__startupOrder.push("treemap");
        }
      });
      observer.observe(document, { childList: true, subtree: true });
    });

    const { nt } = await openApp(context, server);
    await expect(nt.locator("#readout .readout-intro")).toBeVisible();
    expect(await nt.evaluate(() => window.__startupOrder.slice(0, 2))).toEqual(["sidebar", "treemap"]);
  });

  test("bounds synchronous text measurement and drag setup per render", async ({ context, server }) => {
    await context.addInitScript(() => {
      window.__treemapPerfProbe = { getBBox: 0, timeout500: 0 };

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

    const { nt } = await openApp(context, server);
    const cellCount = await nt.locator("#treemap .cell").count();
    const probe = await nt.evaluate(() => window.__treemapPerfProbe);

    // Binary search needs at most six getBBox calls per title. Leave a small
    // allowance for non-cell SVG measurements elsewhere in the page.
    expect(probe.getBBox).toBeLessThanOrEqual(cellCount * 7);
    // One delayed focus-restoration check remains; drag binding itself is now
    // synchronous and must never schedule one timer per cell.
    expect(probe.timeout500).toBeLessThanOrEqual(2);
  });

  test("hover previews a cell and switches between cells", async ({ context, server }) => {
    const { nt } = await openApp(context, server);
    const title = nt.locator("#readout .readout-title");

    await nt.locator(CELL("Alpha Page")).hover();
    await expect(title).toHaveText("Alpha Page");

    // Not pinned yet, so moving to another cell must update the preview.
    await nt.locator(CELL("Beta Page")).hover();
    await expect(title).toHaveText("Beta Page");

    await nt.locator(CELL("Gamma Page")).hover();
    await expect(title).toHaveText("Gamma Page");

    // ...and back, to prove it isn't a one-way latch (the "n-2 hover" bug).
    await nt.locator(CELL("Alpha Page")).hover();
    await expect(title).toHaveText("Alpha Page");
  });

  test("hover keeps domain stars visible, including while the pointer rests", async ({ context, server }) => {
    const { nt } = await openApp(context, server);

    await nt.evaluate(async (baseUrl) => {
      await chrome.bookmarks.create({
        title: "Saved Alpha context",
        url: `${baseUrl}/saved-alpha`,
      });
    }, server);

    await nt.locator(CELL("Alpha Page")).hover();
    const domainStars = nt.locator("#readout .bookmarks-section");
    await expect(domainStars.getByRole("heading")).toContainText("Stars from 127.0.0.1");
    await expect(domainStars).toContainText("Saved Alpha context");

    // The idle panel used to replace the domain readout after five seconds,
    // even though the pointer was still resting on the cell.
    await nt.waitForTimeout(5500);
    await expect(domainStars).toContainText("Saved Alpha context");
    await expect(nt.locator("#readout .recent-stars")).toHaveCount(0);
  });

  test("click pins, the pin survives a redraw, a second cell switches it, re-click unpins", async ({
    context,
    server,
  }) => {
    const { nt, tabs } = await openApp(context, server);
    const title = nt.locator("#readout .readout-title");
    const readout = nt.locator("#readout");
    const alpha = nt.locator(CELL("Alpha Page"));
    const beta = nt.locator(CELL("Beta Page"));

    // Pin Alpha. The pinned cell carries the .node-activated highlight class.
    await alpha.click();
    await expect(readout).toHaveClass(/sticky/);
    await expect(title).toHaveText("Alpha Page");
    await expect(alpha).toHaveClass(/node-activated/);

    // Force a treemap redraw — the condition under which the selection bug bit.
    // Navigating the gamma tab fires chrome.tabs.onUpdated('complete'), which
    // recreates every cell <g>. The old code tracked the pin by DOM ref, so the
    // redraw orphaned it: the freshly-created Alpha cell lost its highlight and
    // the selection state went stale. Wait for the new Delta cell to confirm the
    // redraw actually ran.
    await tabs[2].goto(server + "/delta", { waitUntil: "load" });
    await expect(nt.locator(CELL("Delta Page"))).toHaveCount(1);

    // The pin must SURVIVE the redraw. The highlight on the *recreated* Alpha cell
    // is the load-bearing assertion: only the re-pin-by-id fix restores it (the
    // DOM-ref code leaves it on the orphaned old node, so the new cell is bare).
    await expect(alpha).toHaveClass(/node-activated/);
    await expect(readout).toHaveClass(/sticky/);
    await expect(title).toHaveText("Alpha Page");

    // While pinned, hovering elsewhere must NOT move the readout.
    await beta.hover();
    await expect(title).toHaveText("Alpha Page");

    // The reported regression: clicking a different cell must switch the pin.
    await beta.click();
    await expect(title).toHaveText("Beta Page");
    await expect(readout).toHaveClass(/sticky/);

    // Clicking the pinned cell again unpins it.
    await beta.click();
    await expect(readout).not.toHaveClass(/sticky/);
  });

  test("default readout shows recent stars", async ({ context, server }) => {
    const { nt } = await openApp(context, server);

    // The fresh profile has no bookmarks — the panel should say so.
    await expect(nt.locator("#readout .recent-stars h3")).toHaveText(/Recent stars/);
    await expect(nt.locator("#readout .star-empty")).toHaveCount(1);

    // Create a bookmark from the extension page (it has the bookmarks
    // permission), then reload — the default panel must list it, newest first.
    await nt.evaluate(() =>
      chrome.bookmarks.create({ title: "Starred Fixture", url: "https://example.com/star" })
    );
    await nt.reload({ waitUntil: "domcontentloaded" });

    const star = nt.locator("#readout .star-item", { hasText: "Starred Fixture" });
    await expect(star).toHaveCount(1);
    await expect(star.locator("a")).toHaveAttribute("href", "https://example.com/star");
    await expect(star.locator(".star-meta")).toContainText("example.com");
  });
});
