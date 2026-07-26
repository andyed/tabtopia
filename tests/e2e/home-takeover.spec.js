const { test, expect } = require("./fixtures");
const path = require("path");

const ARCHIVE_STORAGE_KEY = "tabtopiaArchiveProviderV1";

async function seedArchiveProvider(page, extensionId, { fetchedAt, rows }) {
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`, {
    waitUntil: "domcontentloaded"
  });
  await page.evaluate(async ({ key, snapshot }) => {
    await chrome.storage.local.set({ [key]: snapshot });
  }, {
    key: ARCHIVE_STORAGE_KEY,
    snapshot: {
      version: 1,
      updatedAt: fetchedAt,
      archive: { fetchedAt, rows },
      queries: {},
      lastQuery: ""
    }
  });
}

async function renderArchiveFixture(page, extensionId, { archiveItems = [], actions = [] } = {}) {
  await page.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/home`, {
    waitUntil: "domcontentloaded"
  });
  const canonicalHome = page.locator("#startPageHome");
  await canonicalHome.waitFor({ state: "visible" });
  await expect(canonicalHome).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async ({ archiveItems: items, actions: destinations }) => {
    const { renderHomeTakeover } = await import(chrome.runtime.getURL("src/newtab/home-takeover.js"));
    const root = document.createElement("main");
    root.id = "archiveFixture";
    document.body.append(root);
    document.querySelectorAll("body > :not(script)").forEach(node => {
      node.hidden = node !== root;
    });
    window.__archiveAction = null;
    renderHomeTakeover(root, {
      mode: "quiet",
      state: "launch",
      stateLabel: "Launch",
      actions: destinations,
      archiveItems: items
    }, {
      onAction(action) {
        window.__archiveAction = action;
      }
    });
  }, { archiveItems, actions });
  return page.locator("#archiveFixture");
}

test.describe("development home takeover", () => {
  test("an explicit home route wakes an already-loaded normal-install page", async ({ context, extensionId }) => {
    await context.addInitScript(() => {
      Object.defineProperty(chrome.management, "getSelf", {
        configurable: true,
        value: callback => callback({ installType: "normal" })
      });
    });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html`, {
      waitUntil: "domcontentloaded"
    });

    const home = page.locator("#startPageHome");
    await expect(home).toBeHidden();
    await page.waitForTimeout(100);
    await page.locator("a[href='newtab.html#/home']").click();

    await expect(page).toHaveURL(/newtab\.html#\/home$/);
    await expect(home).toBeVisible();
    await expect(home).toHaveAttribute("aria-busy", "false");
  });

  test("reloads canonical data when home is revisited", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html`, {
      waitUntil: "domcontentloaded"
    });
    await page.evaluate(() => chrome.bookmarks.create({
      title: "Revisit proof",
      url: "https://example.com/revisit-proof"
    }));

    const home = page.locator("#startPageHome");
    await expect(home.getByText("Revisit proof", { exact: true })).toBeVisible();

    await home.getByRole("button", { name: "All tabs" }).click();
    await expect(home).toBeHidden();
    await page.evaluate(() => chrome.bookmarks.create({
      title: "Hash revisit proof",
      url: "https://example.com/hash-revisit-proof"
    }));
    await page.locator("a[href='newtab.html#/home']").click();
    await expect(page).toHaveURL(/newtab\.html#\/home$/);
    await expect(home).toBeVisible();
    await expect(home.getByText("Hash revisit proof", { exact: true })).toBeVisible();

    await page.locator("a[href='graph.html']").click();
    await expect(page).toHaveURL(/graph\.html$/);
    await page.waitForLoadState("domcontentloaded");
    await page.locator("#tabSearch").fill("mbp");
    const graphHomeLink = page.locator(".view-toggle a[href^='newtab.html']");
    await expect(graphHomeLink).toHaveAttribute("href", "newtab.html?q=mbp#/home");
    await page.evaluate(() => chrome.bookmarks.create({
      title: "Document revisit proof",
      url: "https://example.com/document-revisit-proof"
    }));
    await graphHomeLink.click();
    await expect(page).toHaveURL(/newtab\.html\?q=mbp#\/home$/);
    await expect(home).toBeVisible();
    await expect(home.getByText("Document revisit proof", { exact: true })).toBeVisible();
  });

  test("paints the last canonical model while a new tab refreshes", async ({ context, extensionId }) => {
    const first = await context.newPage();
    await first.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/home`, {
      waitUntil: "domcontentloaded"
    });
    await first.evaluate(() => chrome.bookmarks.create({
      title: "Immediate paint",
      url: "https://example.com/immediate-paint"
    }));
    const firstHome = first.locator("#startPageHome");
    await expect(firstHome.getByText("Immediate paint", { exact: true })).toBeVisible();
    await expect.poll(() => first.evaluate(async () => Boolean(
      (await chrome.storage.session.get("tabtopiaHomeModelV1")).tabtopiaHomeModelV1
    ))).toBe(true);
    await first.close();

    await context.addInitScript(() => {
      const nativeGetRecent = chrome.bookmarks.getRecent.bind(chrome.bookmarks);
      Object.defineProperty(chrome.bookmarks, "getRecent", {
        configurable: true,
        value: limit => new Promise(resolve => {
          setTimeout(() => nativeGetRecent(limit).then(resolve), 900);
        })
      });
    });

    const second = await context.newPage();
    await second.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/home`, {
      waitUntil: "domcontentloaded"
    });
    const secondHome = second.locator("#startPageHome");
    await expect(secondHome.getByText("Immediate paint", { exact: true })).toBeVisible();
    await expect(secondHome.getByText("Last view · updating", { exact: true })).toBeVisible();
    await expect(secondHome).toHaveAttribute("aria-busy", "true");
    await expect(secondHome.locator("[data-action-id]").first()).toBeDisabled();

    if (process.env.TABTOPIA_VISUAL_DIR) {
      await second.setViewportSize({ width: 1024, height: 768 });
      await second.screenshot({
        path: path.join(process.env.TABTOPIA_VISUAL_DIR, "home-takeover-cached-1024x768.png"),
        animations: "disabled"
      });
    }

    await expect(secondHome).toHaveAttribute("aria-busy", "false", { timeout: 5_000 });
    await expect(secondHome.getByText("Last view · updating", { exact: true })).toHaveCount(0);
  });

  test("paints cached archive content immediately and preserves it while the provider is offline", async ({ context, extensionId }) => {
    let offlineRequests = 0;
    await context.route("http://127.0.0.1:8889/**", async route => {
      offlineRequests += 1;
      await route.abort("connectionrefused");
    });

    const seed = await context.newPage();
    const now = Date.now();
    await seedArchiveProvider(seed, extensionId, {
      fetchedAt: now - (25 * 60 * 60 * 1000),
      rows: [{
        title: "ACT-R archive proof",
        url: "https://archive.example/act-r-proof",
        tags: ["cognitive science", "memory"],
        timestamp: now - (30 * 24 * 60 * 60 * 1000),
        archivedAt: now - (30 * 24 * 60 * 60 * 1000),
        visitCount: 9,
        lastVisitTime: now - (2 * 24 * 60 * 60 * 1000),
        type: "article",
        layer: "cold_landmark"
      }]
    });
    await seed.close();

    const first = await context.newPage();
    await first.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/home`, {
      waitUntil: "domcontentloaded"
    });
    const firstHome = first.locator("#startPageHome");
    await expect(firstHome.getByRole("heading", { name: "From your archive" })).toBeVisible();
    await expect(firstHome.getByText("ACT-R archive proof", { exact: true })).toBeVisible();
    await expect(firstHome.getByText("recurring — Repeatedly useful.", { exact: true })).toBeVisible();
    await expect.poll(() => offlineRequests).toBeGreaterThan(0);
    await expect(firstHome).toHaveAttribute("aria-busy", "false");
    await expect(firstHome.getByText("ACT-R archive proof", { exact: true })).toBeVisible();
    await expect.poll(() => first.evaluate(async () => Boolean(
      (await chrome.storage.session.get("tabtopiaHomeModelV1")).tabtopiaHomeModelV1
    ))).toBe(true);
    await first.close();

    await context.addInitScript(() => {
      const nativeGetRecent = chrome.bookmarks.getRecent.bind(chrome.bookmarks);
      Object.defineProperty(chrome.bookmarks, "getRecent", {
        configurable: true,
        value: limit => new Promise(resolve => {
          setTimeout(() => nativeGetRecent(limit).then(resolve), 900);
        })
      });
    });

    const second = await context.newPage();
    await second.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/home`, {
      waitUntil: "domcontentloaded"
    });
    const secondHome = second.locator("#startPageHome");
    await expect(secondHome.getByText("ACT-R archive proof", { exact: true })).toBeVisible();
    await expect(secondHome.getByText("Last view · updating", { exact: true })).toBeVisible();
    await expect(secondHome).toHaveAttribute("aria-busy", "true");

    if (process.env.TABTOPIA_VISUAL_DIR) {
      await second.setViewportSize({ width: 1024, height: 768 });
      await secondHome.locator(".home-takeover__archive-action").first().scrollIntoViewIfNeeded();
      await second.screenshot({
        path: path.join(process.env.TABTOPIA_VISUAL_DIR, "home-takeover-archive-offline-1024x768.png"),
        animations: "disabled"
      });
    }

    await expect(secondHome).toHaveAttribute("aria-busy", "false", { timeout: 5_000 });
    await expect(secondHome.getByText("ACT-R archive proof", { exact: true })).toBeVisible();
  });

  test("renders quiet launch and extended-return compositions", async ({ context, extensionId, server }) => {
    const launch = await context.newPage();
    await launch.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html`, {
      waitUntil: "domcontentloaded"
    });
    const launchHome = launch.locator("#startPageHome");
    await expect(launchHome).toHaveAttribute("data-mode", "quiet");
    await expect(launchHome.getByRole("heading", { name: "Where next?" })).toBeVisible();
    await launch.close();

    await context.addInitScript(({ offsetMs }) => {
      const NativeDate = Date;
      const shiftedNow = NativeDate.now() + offsetMs;
      function ShiftedDate(...args) {
        if (!new.target) return new NativeDate(shiftedNow).toString();
        return args.length === 0 ? new NativeDate(shiftedNow) : new NativeDate(...args);
      }
      ShiftedDate.prototype = NativeDate.prototype;
      Object.setPrototypeOf(ShiftedDate, NativeDate);
      ShiftedDate.now = () => shiftedNow;
      ShiftedDate.parse = NativeDate.parse;
      ShiftedDate.UTC = NativeDate.UTC;
      globalThis.Date = ShiftedDate;
    }, { offsetMs: 8 * 60 * 60 * 1000 });

    const returned = await context.newPage();
    await returned.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html`, {
      waitUntil: "domcontentloaded"
    });
    await returned.evaluate(url => new Promise((resolve, reject) => {
      chrome.windows.create({ url, focused: false }, created => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(created?.id);
      });
    }), server + "/alpha");

    const returnHome = returned.locator("#startPageHome");
    await expect(returnHome).toHaveAttribute("data-state", "reorientation");
    await expect(returnHome).toHaveAttribute("data-mode", "return");
    await expect(returnHome.getByRole("heading", { name: "Find your way back" })).toBeVisible();
    await expect(returnHome.locator(".home-takeover__landscape-action").first()).toBeVisible();
  });

  test("becomes the default surface while keeping the treemap one action away", async ({ context, extensionId, server }) => {
    for (const slug of ["/alpha", "/beta"]) {
      const tab = await context.newPage();
      await tab.goto(server + slug, { waitUntil: "load" });
      await tab.bringToFront();
      await tab.waitForTimeout(2200);
    }

    const newtab = await context.newPage();
    await newtab.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html`, {
      waitUntil: "domcontentloaded"
    });

    const home = newtab.locator("#startPageHome");
    await expect(home).toBeVisible();
    await expect(home).toHaveAttribute("data-mode", "engaged");
    await newtab.evaluate(() => Promise.all([
      ["Reading queue", "reading"],
      ["Design notes", "design-notes"],
      ["Research shelf", "research-shelf"],
      ["Later today", "later-today"],
      ["Long read", "long-read"],
      ["Reference desk", "reference-desk"]
    ].map(([title, slug]) => chrome.bookmarks.create({
      title,
      url: `https://example.com/${slug}`
    }))));
    await expect(home.getByRole("heading", { name: "Continuation" })).toBeVisible();
    await expect(home.getByRole("heading", { name: "Side routes" })).toBeVisible();
    await expect(home.getByText("Keep the thread moving", { exact: true })).toHaveCount(0);
    await expect(home.getByText("Current activity, familiar alternatives nearby.", { exact: true })).toHaveCount(0);
    await expect(home.getByText("Fast path", { exact: true })).toHaveCount(0);
    await expect(home.getByText("Familiar side routes", { exact: true })).toHaveCount(0);
    await expect(home.getByRole("heading", { name: "Beyond this trail" })).toBeVisible();
    await expect.poll(() => home.locator(".home-takeover__discovery-action").count())
      .toBeGreaterThanOrEqual(2);
    await expect(newtab.locator(".visualization-container")).toBeHidden();

    await newtab.setViewportSize({ width: 1024, height: 768 });
    const scrollMetrics = await newtab.evaluate(() => ({
      viewportHeight: window.innerHeight,
      pageHeight: document.scrollingElement.scrollHeight
    }));
    expect(scrollMetrics.pageHeight).toBeGreaterThan(scrollMetrics.viewportHeight);
    const aboveFoldActions = await home.locator("[data-action-id]").evaluateAll((buttons) =>
      buttons.filter(button => {
        const bounds = button.getBoundingClientRect();
        return bounds.top < window.innerHeight && bounds.bottom > 0;
      }).length
    );
    expect(aboveFoldActions).toBeGreaterThanOrEqual(4);
    await home.getByRole("heading", { name: "Beyond this trail" }).scrollIntoViewIfNeeded();
    await expect(home.locator(".home-takeover__discovery-action").first()).toBeVisible();
    await newtab.evaluate(() => window.scrollTo({ top: document.scrollingElement.scrollHeight }));
    await expect.poll(() => newtab.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await newtab.evaluate(() => window.scrollTo({ top: 0 }));
    await newtab.setViewportSize({ width: 1600, height: 1000 });

    if (process.env.TABTOPIA_VISUAL_DIR) {
      await newtab.screenshot({
        path: path.join(process.env.TABTOPIA_VISUAL_DIR, "home-takeover-engaged-1600x1000.png"),
        animations: "disabled"
      });
      await home.getByRole("heading", { name: "Beyond this trail" }).scrollIntoViewIfNeeded();
      await newtab.screenshot({
        path: path.join(process.env.TABTOPIA_VISUAL_DIR, "home-takeover-discovery-1600x1000.png"),
        animations: "disabled"
      });
      await newtab.evaluate(() => window.scrollTo({ top: 0 }));
      await newtab.setViewportSize({ width: 1024, height: 768 });
      await newtab.screenshot({
        path: path.join(process.env.TABTOPIA_VISUAL_DIR, "home-takeover-engaged-1024x768.png"),
        animations: "disabled"
      });
      await newtab.setViewportSize({ width: 1600, height: 1000 });
    }

    await home.getByRole("button", { name: "Start fresh" }).click();
    await expect(home).toHaveClass(/home-takeover--fresh/);
    await expect(home.getByRole("heading", { name: "A quiet place to begin" })).toBeVisible();
    await newtab.evaluate(() => window.tabtopiaStartPageRecognition.refresh());
    await expect(home).toHaveClass(/home-takeover--fresh/);
    await home.getByRole("button", { name: "Show suggested" }).click();
    await expect(home).toHaveAttribute("data-mode", "engaged");

    await home.getByRole("button", { name: "All tabs" }).click();
    await expect(newtab).toHaveURL(/#\/treemap$/);
    await expect(home).toBeHidden();
    await expect(newtab.locator('#treemap .cell[aria-label="Alpha Page"]')).toBeVisible();
  });

  test("merges star and habit evidence into one executable destination", async ({ context, extensionId, server }) => {
    const alpha = await context.newPage();
    await alpha.goto(server + "/alpha", { waitUntil: "load" });
    await alpha.bringToFront();
    // Production qualifies an access after two focused seconds. Leave enough
    // room for the extension lifecycle event to reach the service worker before
    // asserting that the habit lane is present.
    await alpha.waitForTimeout(3000);

    const newtab = await context.newPage();
    await newtab.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html`, {
      waitUntil: "domcontentloaded"
    });
    await newtab.evaluate(url => chrome.bookmarks.create({ title: "Alpha saved", url }), server + "/alpha");

    const home = newtab.locator("#startPageHome");
    await expect(home.locator('[data-action-id^="page:"]')).toHaveCount(1);
    const destination = home.locator('[data-action-id^="page:"]').first();
    await expect(destination.getByText("Habit", { exact: true })).toBeVisible();
    await expect(destination.getByText("Star", { exact: true })).toBeVisible();
    await expect(destination).toHaveAttribute("data-verb", "switch");

    await destination.click();
    await expect.poll(async () => newtab.evaluate(() => new Promise(resolve => {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => resolve(tabs[0]?.title || ""));
    }))).toBe("Alpha Page");
  });

  test("renders a bounded archive lane and executes its canonical nested action", async ({ context, extensionId }) => {
    const page = await context.newPage();
    const archiveItems = Array.from({ length: 5 }, (_, index) => ({
      id: `archive-${index + 1}`,
      topics: index === 0 ? ["Cognitive science", "Memory"] : ["Reference"],
      interestState: index === 0 ? "Frequently revisited" : "Previously useful",
      reason: index === 0 ? "A familiar morning destination" : "Seen across earlier visits",
      action: {
        verb: "open",
        target: {
          title: index === 0 ? "ACT-R reference" : `Archive item ${index + 1}`,
          url: `https://archive.example/item-${index + 1}`
        }
      }
    }));
    const home = await renderArchiveFixture(page, extensionId, { archiveItems });
    const archive = home.locator(".home-takeover__archive");

    await expect(home.getByRole("heading", { name: "Beyond this trail" })).toBeVisible();
    await expect(archive.getByRole("heading", { name: "From your archive" })).toBeVisible();
    await expect(archive.locator(".home-takeover__archive-item")).toHaveCount(4);
    await expect(archive.getByText("Archive item 5", { exact: true })).toHaveCount(0);
    await expect(archive.getByText("ACT-R reference", { exact: true })).toBeVisible();
    await expect(archive.getByText("archive.example", { exact: true }).first()).toBeVisible();
    await expect(archive.getByText("Cognitive science · Memory", { exact: true })).toBeVisible();
    await expect(archive.getByText("Frequently revisited — A familiar morning destination", { exact: true })).toBeVisible();

    const firstAction = archive.locator(".home-takeover__archive-action").first();
    await firstAction.focus();
    await expect(firstAction).toBeFocused();
    expect((await firstAction.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await firstAction.click();
    await expect.poll(() => page.evaluate(() => window.__archiveAction)).toEqual(archiveItems[0].action);

    await page.setViewportSize({ width: 360, height: 740 });
    const narrowMetrics = await firstAction.evaluate(button => {
      const bounds = button.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        viewportWidth: document.documentElement.clientWidth,
        height: bounds.height
      };
    });
    expect(narrowMetrics.left).toBeGreaterThanOrEqual(0);
    expect(narrowMetrics.right).toBeLessThanOrEqual(narrowMetrics.viewportWidth);
    expect(narrowMetrics.height).toBeGreaterThanOrEqual(44);
  });

  test("keeps discovery useful without archive data and escapes archive metadata", async ({ context, extensionId }) => {
    const page = await context.newPage();
    const ordinaryActions = Array.from({ length: 5 }, (_, index) => ({
      id: `ordinary-${index + 1}`,
      title: `Ordinary ${index + 1}`,
      verb: "open",
      target: { url: `https://ordinary.example/${index + 1}` },
      sources: ["habit"]
    }));
    let home = await renderArchiveFixture(page, extensionId, { actions: ordinaryActions });
    await expect(home.locator(".home-takeover__archive")).toHaveCount(0);
    await expect(home.locator(".home-takeover__discovery-action")).toHaveCount(1);
    await expect(home.getByText("Ordinary 5", { exact: true })).toBeVisible();

    home = await renderArchiveFixture(page, extensionId, {
      archiveItems: [{
        id: "escaped",
        topics: ["<script>topic()</script>"],
        interestState: "Saved <b>state</b>",
        reason: "Because <svg>reason</svg>",
        action: {
          verb: "open",
          target: { title: "<img src=x> literal title", url: "https://safe.example/archive" }
        }
      }]
    });
    const archive = home.locator(".home-takeover__archive");
    await expect(archive.getByText("<img src=x> literal title", { exact: true })).toBeVisible();
    await expect(archive.getByText("<script>topic()</script>", { exact: true })).toBeVisible();
    await expect(archive.locator("img, script, svg, b")).toHaveCount(0);
  });
});
