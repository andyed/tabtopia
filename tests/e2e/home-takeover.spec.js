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

async function renderArchiveFixture(page, extensionId, {
  archiveItems = [],
  actions = [],
  interests = [],
  githubStarItems = [],
  techmemeItems = []
} = {}) {
  await page.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/home`, {
    waitUntil: "domcontentloaded"
  });
  const canonicalHome = page.locator("#startPageHome");
  if (await canonicalHome.count()) {
    await canonicalHome.waitFor({ state: "visible" });
    await expect(canonicalHome).toHaveAttribute("aria-busy", "false");
  }
  await page.evaluate(async ({
    archiveItems: items,
    actions: destinations,
    interests: interestThreads,
    githubStarItems: repositoryItems,
    techmemeItems: newsItems
  }) => {
    const { renderHomeTakeover } = await import(chrome.runtime.getURL("src/newtab/home-takeover.js"));
    const previousFixture = document.getElementById("archiveFixture");
    previousFixture?.__tabtopiaTitlePeekCleanup?.();
    previousFixture?.remove();
    const canonical = document.getElementById("startPageHome");
    canonical?.__tabtopiaTitlePeekCleanup?.();
    canonical?.remove();
    const root = document.createElement("main");
    root.id = "archiveFixture";
    document.body.append(root);
    document.querySelectorAll("body > :not(script)").forEach(node => {
      node.hidden = node !== root;
      node.inert = node !== root;
    });
    window.__archiveAction = null;
    renderHomeTakeover(root, {
      mode: "quiet",
      state: "launch",
      stateLabel: "Launch",
      actions: destinations,
      archiveItems: items,
      interests: interestThreads,
      githubStarItems: repositoryItems,
      techmemeItems: newsItems
    }, {
      onAction(action) {
        window.__archiveAction = action;
      }
    });
  }, { archiveItems, actions, interests, githubStarItems, techmemeItems });
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
    const cachedLink = secondHome.locator("a[data-action-id]").first();
    await expect(cachedLink).toHaveAttribute("href", "https://example.com/immediate-paint");
    await expect(cachedLink).toBeEnabled();

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

  test("adds filtered Techmeme after first paint without blocking Home", async ({ context, extensionId }) => {
    let releaseFeed;
    let feedRequests = 0;
    const feedGate = new Promise(resolve => { releaseFeed = resolve; });
    await context.route("https://www.techmeme.com/feed.xml", async route => {
      feedRequests += 1;
      await feedGate;
      await route.fulfill({
        status: 200,
        contentType: "application/rss+xml",
        body: `<?xml version="1.0"?><rss version="2.0"><channel>
          <item>
            <title>AI systems bring working memory to browser agents</title>
            <link>https://www.techmeme.com/260726/p31#a260726p31</link>
            <description><![CDATA[<p>Ignored feed HTML</p>]]></description>
            <pubDate>Sun, 26 Jul 2026 15:35:00 -0400</pubDate>
          </item>
          <item>
            <title>Unrelated retail earnings</title>
            <link>https://www.techmeme.com/260726/p32#a260726p32</link>
            <pubDate>Sun, 26 Jul 2026 15:30:00 -0400</pubDate>
          </item>
        </channel></rss>`
      });
    });

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/options/options.html`, {
      waitUntil: "domcontentloaded"
    });
    await page.evaluate(() => chrome.bookmarks.create({
      title: "AI browser research",
      url: "https://research.example/ai-browser"
    }));
    await page.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/home`, {
      waitUntil: "domcontentloaded"
    });

    const home = page.locator("#startPageHome");
    await expect(home).toHaveAttribute("aria-busy", "false");
    await expect(home.locator(".home-takeover__techmeme")).toHaveCount(0);
    await expect.poll(() => feedRequests).toBe(1);

    releaseFeed();
    const panel = home.locator(".home-takeover__techmeme");
    await expect(panel.getByRole("link", {
      name: "Open: AI systems bring working memory to browser agents"
    })).toBeVisible();
    await expect(panel.getByText("Unrelated retail earnings", { exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(async () => {
      const snapshot = (await chrome.storage.local.get("tabtopiaTechmemeProviderV1"))
        .tabtopiaTechmemeProviderV1;
      return snapshot?.items?.length || 0;
    })).toBe(2);
  });

  test("adds relevant GitHub stars after first paint and caches the complete source", async ({ context, extensionId }) => {
    let releaseStars;
    let starRequests = 0;
    const starsGate = new Promise(resolve => { releaseStars = resolve; });
    await context.route("http://127.0.0.1:8889/api/github/stars", async route => {
      starRequests += 1;
      await starsGate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          updatedAt: Date.now(),
          items: [{
            title: "cognition/act-r-tools",
            url: "https://github.com/cognition/act-r-tools",
            description: "Working-memory utilities for cognitive architectures",
            topics: ["cognitive-architecture", "working-memory"],
            stars: 82,
            date_added: "2026-07-24T12:00:00Z",
            source: "GitHub",
            type: "star"
          }, {
            title: "newest/unrelated",
            url: "https://github.com/newest/unrelated",
            description: "An unrelated but explicitly saved repository",
            topics: ["utilities"],
            stars: 20,
            date_added: "2026-07-25T12:00:00Z",
            source: "GitHub",
            type: "star"
          }]
        })
      });
    });

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/options/options.html`, {
      waitUntil: "domcontentloaded"
    });
    await page.evaluate(() => chrome.bookmarks.create({
      title: "Working memory research",
      url: "https://research.example/working-memory"
    }));
    await page.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/home`, {
      waitUntil: "domcontentloaded"
    });

    const home = page.locator("#startPageHome");
    await expect(home).toHaveAttribute("aria-busy", "false");
    await expect(home.locator(".home-takeover__github-stars")).toHaveCount(0);
    await expect.poll(() => starRequests).toBe(1);

    releaseStars();
    const panel = home.locator(".home-takeover__github-stars");
    await expect(panel.getByRole("link", { name: "Open: cognition/act-r-tools" })).toBeVisible();
    await expect(panel.locator(".home-takeover__github-stars-item").first())
      .toContainText("cognition/act-r-tools");
    await expect(panel.locator(".home-takeover__github-stars-item").nth(1))
      .toContainText("newest/unrelated");
    await expect.poll(() => page.evaluate(async () => {
      const snapshot = (await chrome.storage.local.get("tabtopiaGithubStarsProviderV1"))
        .tabtopiaGithubStarsProviderV1;
      return snapshot?.items?.length || 0;
    })).toBe(2);
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
    const archiveItems = Array.from({ length: 7 }, (_, index) => ({
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
    const home = await renderArchiveFixture(page, extensionId, {
      archiveItems,
      interests: [
        { topic: "Cognitive science", interestState: "resurfacing", itemCount: 3 },
        { topic: "Memory", interestState: "recurring", itemCount: 2 }
      ]
    });
    const archive = home.locator(".home-takeover__archive");

    await expect(home.getByRole("heading", { name: "Beyond this trail" })).toBeVisible();
    await expect(archive.getByRole("heading", { name: "From your archive" })).toBeVisible();
    await expect(archive.locator(".home-takeover__archive-item")).toHaveCount(6);
    await expect(archive.getByText("Archive item 6", { exact: true })).toBeVisible();
    await expect(archive.getByText("Archive item 7", { exact: true })).toHaveCount(0);
    await expect(archive.getByText("ACT-R reference", { exact: true })).toBeVisible();
    await expect(archive.getByText("archive.example", { exact: true }).first()).toBeVisible();
    await expect(archive.getByText("Cognitive science · Memory", { exact: true })).toBeVisible();
    await expect(archive.getByText("Frequently revisited — A familiar morning destination", { exact: true })).toBeVisible();
    await expect(home.getByText("Interest threads", { exact: true })).toBeVisible();
    await expect(home.getByText("Cognitive science", { exact: true })).toBeVisible();

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

  test("shortens long titles and reveals the full title on hover or keyboard focus", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1024, height: 768 });
    const fullTitle = "How working memory supports browsing predictions across several devices | Cognitive Science Review";
    const home = await renderArchiveFixture(page, extensionId, {
      archiveItems: [{
        id: "long-title",
        topics: ["memory"],
        interestState: "resurfacing",
        reason: "Semantically related.",
        action: {
          verb: "open",
          target: { title: fullTitle, url: "https://archive.example/long-title" }
        }
      }]
    });
    const action = home.locator(".home-takeover__archive-action");
    const visibleTitle = action.locator(".home-takeover__action-title");
    const peeks = page.locator("body > .home-takeover__title-peek");

    await expect(visibleTitle).toHaveText("How working memory supports browsing…");
    await expect(action).toHaveAttribute("aria-label", `Open: ${fullTitle}`);
    await expect(action).toHaveAttribute("data-title-peek-ready", "true");

    const initialHeight = (await action.boundingBox()).height;
    await action.hover();
    const peek = peeks.filter({ hasText: fullTitle });
    await expect(peek).toHaveCount(1);
    await expect(peek).toBeVisible();
    await expect(peek).toHaveText(fullTitle);
    expect((await action.boundingBox()).height).toBe(initialHeight);
    await action.hover();
    let bounds = await peek.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return {
        hidden: node.hidden,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      };
    });
    expect(bounds.hidden).toBe(false);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(1024);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(768);

    await page.mouse.move(0, 0);
    await expect(peek).toBeHidden();
    await action.focus();
    await expect(peek).toBeVisible();
    await action.press("Escape");
    await expect(peek).toBeHidden();
    await expect(action).toBeFocused();

    await page.setViewportSize({ width: 360, height: 740 });
    await action.evaluate(button => button.blur());
    await action.focus();
    await expect(peek).toBeVisible();
    bounds = await peek.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return {
        hidden: node.hidden,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      };
    });
    expect(bounds.hidden).toBe(false);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(360);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(740);

    if (process.env.TABTOPIA_VISUAL_DIR) {
      await page.screenshot({
        path: path.join(process.env.TABTOPIA_VISUAL_DIR, "home-title-peek-360x740.png"),
        animations: "disabled"
      });
    }
  });

  test("renders filtered Techmeme as a bounded bottom panel and executes its canonical action", async ({ context, extensionId }) => {
    const page = await context.newPage();
    const techmemeItems = Array.from({ length: 10 }, (_, index) => ({
      id: `techmeme-${index + 1}`,
      title: index === 0
        ? "Browser agents bring working memory to local AI systems"
        : `Relevant AI headline ${index + 1}`,
      matchedTopics: index === 0 ? ["working memory", "browser agents"] : ["AI"],
      publishedAt: Date.now() - (index * 60_000),
      action: {
        verb: "open",
        target: {
          title: index === 0
            ? "Browser agents bring working memory to local AI systems"
            : `Relevant AI headline ${index + 1}`,
          url: `https://www.techmeme.com/260726/p${index + 1}#a260726p${index + 1}`
        }
      }
    }));
    const home = await renderArchiveFixture(page, extensionId, {
      actions: [{
        id: "route",
        title: "Current route",
        verb: "open",
        target: { url: "https://route.example/" },
        sources: ["habit"]
      }],
      techmemeItems
    });
    const panel = home.locator(".home-takeover__techmeme");

    await expect(panel.getByText("Techmeme · filtered", { exact: true })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Around your interests" })).toBeVisible();
    await expect(panel.locator(".home-takeover__techmeme-item")).toHaveCount(8);
    await expect(panel.getByText("Relevant AI headline 10", { exact: true })).toHaveCount(0);
    await expect(panel.getByText("working memory · browser agents", { exact: true })).toBeVisible();
    const positions = await home.locator(".home-takeover__quiet, .home-takeover__techmeme")
      .evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
    expect(positions[1]).toBeGreaterThan(positions[0]);

    if (process.env.TABTOPIA_VISUAL_DIR) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({
        path: path.join(process.env.TABTOPIA_VISUAL_DIR, "home-techmeme-density-1440x1000.png"),
        animations: "disabled",
        fullPage: true
      });
    }

    const firstAction = panel.locator(".home-takeover__techmeme-action").first();
    await page.setViewportSize({ width: 360, height: 740 });
    await firstAction.scrollIntoViewIfNeeded();
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

    await firstAction.click();
    await expect.poll(() => page.evaluate(() => window.__archiveAction)).toEqual(techmemeItems[0].action);
  });

  test("renders GitHub stars as a bounded compact panel with provenance and canonical actions", async ({ context, extensionId }) => {
    const page = await context.newPage();
    const githubStarItems = Array.from({ length: 10 }, (_, index) => ({
      id: `github-star-${index + 1}`,
      title: index === 0
        ? "cognition/act-r-working-memory-tools-with-a-title-that-needs-a-hover-peek"
        : `owner/repository-${index + 1}`,
      topics: index === 0 ? ["cognitive-architecture", "working-memory", "lisp"] : ["tools"],
      matchedTopics: index === 0 ? ["working memory"] : [],
      starredAt: Date.UTC(2026, 6, 25 - index, 12, 0, 0),
      matchKind: index === 0 ? "related" : "recent",
      action: {
        verb: "open",
        target: {
          title: index === 0
            ? "cognition/act-r-working-memory-tools-with-a-title-that-needs-a-hover-peek"
            : `owner/repository-${index + 1}`,
          url: `https://github.com/owner/repository-${index + 1}`
        }
      }
    }));
    const home = await renderArchiveFixture(page, extensionId, {
      actions: [{
        id: "route",
        title: "Current route",
        verb: "open",
        target: { url: "https://route.example/" },
        sources: ["habit"]
      }],
      githubStarItems
    });
    const panel = home.locator(".home-takeover__github-stars");

    await expect(panel.getByText("GitHub stars", { exact: true })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Saved repositories" })).toBeVisible();
    await expect(panel.locator(".home-takeover__github-stars-item")).toHaveCount(8);
    await expect(panel.getByText("owner/repository-10", { exact: true })).toHaveCount(0);
    await expect(panel.getByText("working memory", { exact: true })).toBeVisible();
    await expect(panel.getByText(/starred Jul 25/)).toBeVisible();
    const fullTitle = panel.locator("[data-home-title]").first();
    await expect(fullTitle).toHaveAttribute("data-title-shortened", "true");

    if (process.env.TABTOPIA_VISUAL_DIR) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(process.env.TABTOPIA_VISUAL_DIR, "home-github-stars-1440x1000.png"),
        animations: "disabled",
        fullPage: true
      });
    }

    const firstAction = panel.locator(".home-takeover__github-star-action").first();
    await page.setViewportSize({ width: 360, height: 740 });
    await firstAction.scrollIntoViewIfNeeded();
    const bounds = await firstAction.evaluate(button => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: document.documentElement.clientWidth, height: rect.height };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.width);
    expect(bounds.height).toBeGreaterThanOrEqual(44);

    if (process.env.TABTOPIA_VISUAL_DIR) {
      await page.screenshot({
        path: path.join(process.env.TABTOPIA_VISUAL_DIR, "home-github-stars-360x740.png"),
        animations: "disabled"
      });
    }

    await firstAction.click();
    await expect.poll(() => page.evaluate(() => window.__archiveAction)).toEqual(githubStarItems[0].action);
  });

  test("uses native hyperlinks with modifier navigation and complete keyboard traversal", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const actions = [{
      id: "primary-link",
      title: "Primary native destination",
      verb: "open",
      target: { url: "https://example.com/primary-native" },
      sources: ["habit"]
    }, {
      id: "secondary-link",
      title: "Secondary native destination",
      verb: "open",
      target: { url: "https://example.com/secondary-native" },
      sources: ["star"]
    }];
    const archiveItems = [{
      id: "archive-native",
      title: "Archive native destination",
      topics: ["native links"],
      action: {
        verb: "open",
        target: { title: "Archive native destination", url: "https://example.com/archive-native" }
      }
    }];
    const githubStarItems = [{
      id: "github-native",
      title: "owner/native-repository",
      topics: ["keyboard"],
      starredAt: Date.UTC(2026, 6, 25),
      action: {
        verb: "open",
        target: { title: "owner/native-repository", url: "https://github.com/owner/native-repository" }
      }
    }];
    const techmemeItems = [{
      id: "techmeme-native",
      title: "Native links reach the start page",
      matchedTopics: ["native links"],
      action: {
        verb: "open",
        target: {
          title: "Native links reach the start page",
          url: "https://www.techmeme.com/260726/p40#a260726p40"
        }
      }
    }];
    const home = await renderArchiveFixture(page, extensionId, {
      actions,
      archiveItems,
      githubStarItems,
      techmemeItems
    });
    const links = home.locator("a[data-action-id]");

    await expect(links).toHaveCount(5);
    const semantics = await links.evaluateAll(nodes => nodes.map(node => ({
      tagName: node.tagName,
      href: node.getAttribute("href"),
      tabIndex: node.tabIndex
    })));
    expect(semantics.every(item => item.tagName === "A")).toBe(true);
    expect(semantics.every(item => /^https:\/\//u.test(item.href))).toBe(true);
    expect(semantics.every(item => item.tabIndex === 0)).toBe(true);
    await expect(home.locator(".home-takeover__action-arrow")).toHaveCount(0);
    const density = await home.evaluate(root => ({
      focalFont: Number.parseFloat(getComputedStyle(root.querySelector(".home-takeover__focal-action .home-takeover__action-title")).fontSize),
      repositoryFont: Number.parseFloat(getComputedStyle(root.querySelector(".home-takeover__github-star-action .home-takeover__action-title")).fontSize),
      repositoryColumns: getComputedStyle(root.querySelector(".home-takeover__github-stars-list"))
        .gridTemplateColumns.split(" ").filter(Boolean).length,
      rootWidth: root.getBoundingClientRect().width,
      focalWidth: root.querySelector(".home-takeover__focal-action").getBoundingClientRect().width
    }));
    expect(density.focalFont).toBeGreaterThanOrEqual(52);
    expect(density.repositoryFont).toBeGreaterThanOrEqual(28);
    expect(density.repositoryColumns).toBe(3);
    expect(density.focalWidth / density.rootWidth).toBeGreaterThan(0.55);

    const primary = home.locator("a[data-action-id='primary-link']");
    const [opened] = await Promise.all([
      context.waitForEvent("page"),
      primary.click({ modifiers: ["ControlOrMeta"] })
    ]);
    await opened.waitForURL("https://example.com/primary-native");
    expect(await page.evaluate(() => window.__archiveAction)).toBeNull();
    await opened.close();

    await page.bringToFront();
    await page.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
    });
    await page.keyboard.press("Tab");
    await expect(primary).toBeFocused();
    const focusStyle = await primary.evaluate(node => ({
      outlineStyle: getComputedStyle(node).outlineStyle,
      outlineWidth: getComputedStyle(node).outlineWidth
    }));
    expect(focusStyle.outlineStyle).not.toBe("none");
    expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(3);

    if (process.env.TABTOPIA_VISUAL_DIR) {
      await page.screenshot({
        path: path.join(process.env.TABTOPIA_VISUAL_DIR, "home-native-links-focus-1440x1000.png"),
        animations: "disabled",
        fullPage: true
      });
    }

    await page.keyboard.press("Tab");
    await expect(home.locator("a[data-action-id='secondary-link']")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(primary).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => window.__archiveAction)).toEqual(actions[0]);
  });

  test("keeps discovery useful without archive data and escapes archive metadata", async ({ context, extensionId }) => {
    const page = await context.newPage();
    const ordinaryActions = Array.from({ length: 7 }, (_, index) => ({
      id: `ordinary-${index + 1}`,
      title: `Ordinary ${index + 1}`,
      verb: "open",
      target: { url: `https://ordinary.example/${index + 1}` },
      sources: ["habit"]
    }));
    let home = await renderArchiveFixture(page, extensionId, { actions: ordinaryActions });
    await expect(home.locator(".home-takeover__archive")).toHaveCount(0);
    await expect(home.locator(".home-takeover__discovery-action")).toHaveCount(1);
    await expect(home.getByText("Ordinary 7", { exact: true })).toBeVisible();

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
