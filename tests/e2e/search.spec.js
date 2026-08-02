const fs = require("fs");
const os = require("os");
const path = require("path");
const { test, expect, launchExtensionContext } = require("./fixtures");

const CELL = (title) => `#treemap .cell[aria-label="${title}"]`;

async function openApp(context, server) {
  const tabs = [];
  for (const slug of ["/alpha", "/beta", "/gamma"]) {
    const tab = await context.newPage();
    await tab.goto(server + slug, { waitUntil: "load" });
    tabs.push(tab);
  }

  const nt = await context.newPage();
  await nt.goto("chrome://newtab/", { waitUntil: "domcontentloaded" });

  await expect(nt.locator(CELL("Alpha Page"))).toHaveCount(1);
  await expect(nt.locator(CELL("Beta Page"))).toHaveCount(1);
  await expect(nt.locator(CELL("Gamma Page"))).toHaveCount(1);
  return { nt, tabs };
}

test.describe("fuzzy search", () => {
  test("opens a dedicated SERP and supports keyboard navigation", async ({ context, server }) => {
    const { nt } = await openApp(context, server);

    const searchInput = nt.locator("#tabSearch");
    const alpha = nt.locator(CELL("Alpha Page"));
    const beta = nt.locator(CELL("Beta Page"));

    // Type into search
    await searchInput.fill("Alpha");

    const serp = nt.locator("#startPageSearch");
    await expect(serp).toBeVisible();
    await expect(nt.locator(".visualization-container")).toBeHidden();
    await expect(serp.locator(".search-serp__result-link")).toHaveCount(1);
    await expect(serp.locator(".search-serp__result-link")).toHaveAttribute("href", server + "/alpha");

    // Wait for the debounce and transition (200ms debounce + some rendering time)
    await expect(alpha).toHaveClass(/cell-search-match/);
    await expect(beta).toHaveClass(/cell-search-nomatch/);
    
    // Check opacity
    await expect(alpha).toHaveCSS("opacity", "1");
    await expect(beta).toHaveCSS("opacity", "0.3");

    // Press ArrowDown to move from the query into the first native result.
    await searchInput.press("ArrowDown");
    await expect(serp.locator(".search-serp__result-link")).toBeFocused();

    // Press Escape to clear
    await searchInput.press("Escape");
    await expect(searchInput).toHaveValue("");
    await expect(serp).toBeHidden();
    
    // Classes should be cleared
    await expect(alpha).not.toHaveClass(/cell-search-match/);
    await expect(beta).not.toHaveClass(/cell-search-nomatch/);
    await expect(alpha).toHaveCSS("opacity", "1");
    await expect(beta).toHaveCSS("opacity", "1");
  });

  test("keeps result-list arrow navigation out of the hidden treemap", async ({ context, server }) => {
    const { nt } = await openApp(context, server);
    const input = nt.locator("#tabSearch");
    await input.fill("Page");

    const results = nt.locator("#startPageSearch .search-serp__result-link");
    await expect(results).toHaveCount(3);
    await input.press("ArrowDown");
    await expect(results.nth(0)).toBeFocused();

    await results.nth(0).press("ArrowDown");
    await expect(results.nth(1)).toBeFocused();
    await results.nth(1).press("ArrowUp");
    await expect(results.nth(0)).toBeFocused();

    await input.focus();
    await input.press("ArrowUp");
    await expect(results.nth(2)).toBeFocused();
    await results.nth(2).press("ArrowDown");
    await expect(results.nth(0)).toBeFocused();
    await results.nth(0).press("ArrowUp");
    await expect(results.nth(2)).toBeFocused();

    await results.nth(2).press("Escape");
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await expect(nt.locator("#startPageSearch")).toBeHidden();
  });

  test("refinds a recently closed page through Chrome History", async ({ context, server }) => {
    const recent = await context.newPage();
    await recent.goto(server + "/recent-only", { waitUntil: "load" });
    await recent.close();

    const nt = await context.newPage();
    await nt.goto("chrome://newtab/", { waitUntil: "domcontentloaded" });
    const input = nt.locator("#tabSearch");
    await input.fill("flight review");

    const serp = nt.locator("#startPageSearch");
    const result = serp.locator(".search-serp__result-link").filter({
      hasText: "Recently Closed Flight Review"
    });
    await expect(serp).toBeVisible();
    await expect(result).toHaveCount(1);
    await expect(result).toHaveAttribute("href", server + "/recent-only");
    await expect(result.locator(".search-serp__token--history")).toContainText("Last opened");
    await expect(result).not.toContainText("Title");

    await nt.setViewportSize({ width: 390, height: 780 });
    const narrow = await serp.evaluate(root => ({
      viewport: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      rootWidth: root.scrollWidth,
      rootClientWidth: root.clientWidth
    }));
    expect(narrow.documentWidth).toBeLessThanOrEqual(narrow.viewport);
    expect(narrow.rootWidth).toBeLessThanOrEqual(narrow.rootClientWidth);

    if (process.env.TABTOPIA_VISUAL_DIR) {
      await nt.screenshot({
        path: path.join(process.env.TABTOPIA_VISUAL_DIR, "search-serp-history-390x780.png"),
        animations: "disabled",
        fullPage: true
      });
      await nt.setViewportSize({ width: 1440, height: 1000 });
      await nt.screenshot({
        path: path.join(process.env.TABTOPIA_VISUAL_DIR, "search-serp-history-1440x1000.png"),
        animations: "disabled",
        fullPage: true
      });
    } else {
      await nt.setViewportSize({ width: 1440, height: 1000 });
    }

    const [opened] = await Promise.all([
      context.waitForEvent("page"),
      result.click({ modifiers: ["ControlOrMeta"] })
    ]);
    await opened.waitForURL(server + "/recent-only");
    await opened.close();
    await nt.bringToFront();
    await expect(nt).toHaveURL(/newtab\.html/u);

    await input.press("Enter");
    await nt.waitForURL(server + "/recent-only");
  });

  test("searches every bookmark by saved summary and shows its URL-matched hero", async ({ context, server }) => {
    const { nt } = await openApp(context, server);
    const bookmarkUrl = server + "/buried-keepsake";
    const hero = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%2323483b'/%3E%3C/svg%3E";

    await nt.evaluate(async ({ bookmarkUrl, hero }) => {
      await chrome.bookmarks.create({ title: "Buried Keepsake", url: bookmarkUrl });
      await chrome.storage.local.set({
        nanoSummaries: {
          [bookmarkUrl]: {
            summary: "A quasar notebook for spectral camera experiments",
            source: "chrome-ai",
            timestamp: Date.now()
          }
        },
        heroImages: {
          [bookmarkUrl]: {
            title: "Buried Keepsake",
            images: [{ src: hero, alt: "Green spectral field", score: 91 }]
          }
        }
      });
    }, { bookmarkUrl, hero });
    await nt.reload({ waitUntil: "domcontentloaded" });

    await nt.locator("#tabSearch").fill("quasar notebook");
    const result = nt.locator("#startPageSearch .search-serp__result-link").filter({ hasText: "Buried Keepsake" });
    await expect(result).toHaveCount(1);
    await expect(result.locator(".search-serp__token--saved")).toContainText("Saved");
    await expect(result.locator(".search-serp__token--ai")).toHaveText("Matched in Chrome AI summary");
    await expect(result.locator(".search-serp__hero")).toHaveAttribute("src", hero);

    if (process.env.TABTOPIA_VISUAL_DIR) {
      await nt.screenshot({
        path: path.join(process.env.TABTOPIA_VISUAL_DIR, "search-serp-summary-hero-1600x1000.png"),
        animations: "disabled",
        fullPage: true
      });
      await nt.setViewportSize({ width: 390, height: 780 });
      await nt.screenshot({
        path: path.join(process.env.TABTOPIA_VISUAL_DIR, "search-serp-summary-hero-390x780.png"),
        animations: "disabled",
        fullPage: true
      });
    }
  });

  test("ignores a slow stale History response after the query changes", async ({ context, server }) => {
    await context.addInitScript(() => {
      const originalSearch = chrome.history.search.bind(chrome.history);
      Object.defineProperty(chrome.history, "search", {
        configurable: true,
        value(options, callback) {
          const delay = options?.text === "Alpha" ? 500 : options?.text === "Beta" ? 10 : 0;
          if (typeof callback === "function") {
            setTimeout(() => originalSearch(options, callback), delay);
            return undefined;
          }
          return new Promise((resolve, reject) => {
            setTimeout(() => Promise.resolve(originalSearch(options)).then(resolve, reject), delay);
          });
        }
      });
    });
    const { nt } = await openApp(context, server);
    const input = nt.locator("#tabSearch");
    await input.fill("Alpha");
    await nt.waitForTimeout(240);
    await input.fill("Beta");

    const serp = nt.locator("#startPageSearch");
    await expect(serp.locator(".search-serp__query")).toHaveText("“Beta”");
    await expect(serp.locator(".search-serp__result-link")).toHaveCount(1);
    await expect(serp.locator(".search-serp__result-link")).toContainText("Beta Page");
    await nt.waitForTimeout(600);
    await expect(serp.locator(".search-serp__query")).toHaveText("“Beta”");
    await expect(serp.locator(".search-serp__result-link")).not.toContainText("Alpha Page");
  });

  test("filter survives switching to another tab and back", async ({ context, server }) => {
    const { nt, tabs } = await openApp(context, server);

    const searchInput = nt.locator("#tabSearch");
    const alpha = nt.locator(CELL("Alpha Page"));
    const beta = nt.locator(CELL("Beta Page"));

    await searchInput.fill("Alpha");
    await expect(alpha).toHaveClass(/cell-search-match/);

    // Activate another tab, then come back. Each switch fires
    // chrome.tabs.onActivated -> refreshTreemapState -> full drawTreemap,
    // which used to recreate every cell without the search classes.
    await tabs[1].bringToFront();
    await nt.bringToFront();

    await expect(searchInput).toHaveValue("Alpha");
    await expect(alpha).toHaveClass(/cell-search-match/);
    await expect(beta).toHaveClass(/cell-search-nomatch/);
    await expect(beta).toHaveCSS("opacity", "0.3");
  });

  test("query persists into a newly opened newtab", async ({ context, server }) => {
    const { nt } = await openApp(context, server);

    await nt.locator("#tabSearch").fill("Alpha");
    await expect(nt.locator(CELL("Alpha Page"))).toHaveClass(/cell-search-match/);

    // A second newtab is a fresh document — the query is restored from
    // localStorage and the filter applied after the first treemap paint.
    const nt2 = await context.newPage();
    await nt2.goto("chrome://newtab/", { waitUntil: "domcontentloaded" });

    const searchInput2 = nt2.locator("#tabSearch");
    await expect(searchInput2).toHaveValue("Alpha");
    await expect(nt2.locator(CELL("Alpha Page"))).toHaveClass(/cell-search-match/);
    await expect(nt2.locator(CELL("Beta Page"))).toHaveClass(/cell-search-nomatch/);

    // Escape in the second newtab clears the persisted query, and the storage
    // event live-syncs the first newtab's box too.
    await searchInput2.press("Escape");
    await expect(searchInput2).toHaveValue("");
    await expect(nt.locator("#tabSearch")).toHaveValue("");
    await expect(nt.locator(CELL("Beta Page"))).not.toHaveClass(/cell-search-nomatch/);
  });

  test("query carries across header view switches via URL", async ({ context, server }) => {
    const { nt } = await openApp(context, server);

    await nt.locator("#tabSearch").fill("Alpha");
    await expect(nt.locator(CELL("Alpha Page"))).toHaveClass(/cell-search-match/);

    // Every keystroke re-decorates the header view links with ?q=.
    const starsLink = nt.locator(".view-toggle a[href^='stars.html']");
    await expect(starsLink).toHaveAttribute("href", "stars.html?q=Alpha");

    // Ride the link into the stars view — its box seeds from the URL param.
    await starsLink.click();
    await expect(nt).toHaveURL(/stars\.html\?q=Alpha/);
    await expect(nt.locator("#starsSearch")).toHaveValue("Alpha");

    // And back to the treemap: box seeded, filter applied to the fresh document.
    await nt.locator(".view-toggle a[href^='newtab.html']").click();
    await expect(nt).toHaveURL(/newtab\.html\?q=Alpha/);
    await expect(nt.locator("#tabSearch")).toHaveValue("Alpha");
    await expect(nt.locator(CELL("Alpha Page"))).toHaveClass(/cell-search-match/);
    await expect(nt.locator(CELL("Beta Page"))).toHaveClass(/cell-search-nomatch/);

    // Editing the query on a ?q= URL rewrites the param in place (reload-safe).
    await nt.locator("#tabSearch").fill("Beta");
    await expect(nt).toHaveURL(/newtab\.html\?q=Beta/);
  });

  test("Enter activates the first matching tab", async ({ context, server }) => {
    const { nt, tabs } = await openApp(context, server);

    const searchInput = nt.locator("#tabSearch");
    await searchInput.fill("Beta");
    await expect(nt.locator(CELL("Beta Page"))).toHaveClass(/cell-search-match/);

    // Enter routes through focusFirstSearchResult -> chrome.tabs.update
    // ({active: true}) on the matched cell's tab — the Beta fixture tab
    // becomes the visible foreground tab.
    await searchInput.press("Enter");
    await expect
      .poll(() => tabs[1].evaluate(() => document.visibilityState), { timeout: 10_000 })
      .toBe("visible");
  });

  test("remote clear also scrubs a stale ?q= URL (no resurrection on reload)", async ({ context, server }) => {
    const { nt } = await openApp(context, server);

    // Ride a decorated header link so this document's URL carries ?q=.
    await nt.locator("#tabSearch").fill("Alpha");
    await nt.locator(".view-toggle a[href^='stars.html']").click();
    await expect(nt).toHaveURL(/stars\.html\?q=Alpha/);

    // Clear the query from ANOTHER document (a fresh newtab).
    const nt2 = await context.newPage();
    await nt2.goto("chrome://newtab/", { waitUntil: "domcontentloaded" });
    await expect(nt2.locator("#tabSearch")).toHaveValue("Alpha");
    await nt2.locator("#tabSearch").press("Escape");

    // The stars document must sync its box AND drop the dead ?q= from its own
    // URL — otherwise reloading it re-seeds the cleared query into session
    // storage and re-imposes it on every open view.
    await expect(nt.locator("#starsSearch")).toHaveValue("");
    await expect(nt).not.toHaveURL(/q=Alpha/);

    await nt.reload({ waitUntil: "domcontentloaded" });
    await expect(nt.locator("#starsSearch")).toHaveValue("");
    await expect(nt2.locator("#tabSearch")).toHaveValue("");
  });

  test("query does NOT survive a browser restart", async ({ server }) => {
    // The spec: a search query is a within-session intent. It carries across
    // tabs and views while the browser is up, but a fresh browser session
    // starts with a clean box. This test relaunches Chrome on the SAME
    // profile dir — the Playwright analog of quit + reopen.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tabtopia-restart-"));

    // Session 1: type a query, verify it took, close the browser.
    const first = await launchExtensionContext(userDataDir);
    try {
      const page = await first.newPage();
      await page.goto(server + "/alpha", { waitUntil: "load" });
      const nt = await first.newPage();
      await nt.goto("chrome://newtab/", { waitUntil: "domcontentloaded" });
      await expect(nt.locator('#treemap .cell[aria-label="Alpha Page"]')).toHaveCount(1);

      await nt.locator("#tabSearch").fill("Alpha");
      // Prove the carrier picked it up before we restart: a second newtab in
      // the SAME session must still inherit the query.
      const nt2 = await first.newPage();
      await nt2.goto("chrome://newtab/", { waitUntil: "domcontentloaded" });
      await expect(nt2.locator("#tabSearch")).toHaveValue("Alpha");
    } finally {
      await first.close();
    }

    // Session 2: same profile, fresh browser — the box must be empty.
    const second = await launchExtensionContext(userDataDir);
    try {
      const page = await second.newPage();
      await page.goto(server + "/alpha", { waitUntil: "load" });
      const nt = await second.newPage();
      await nt.goto("chrome://newtab/", { waitUntil: "domcontentloaded" });
      await expect(nt.locator('#treemap .cell[aria-label="Alpha Page"]')).toHaveCount(1);

      await expect(nt.locator("#tabSearch")).toHaveValue("");
      // And the treemap is unfiltered — no cell carries a stale nomatch class.
      await expect(nt.locator("#treemap .cell.cell-search-nomatch")).toHaveCount(0);
    } finally {
      await second.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
