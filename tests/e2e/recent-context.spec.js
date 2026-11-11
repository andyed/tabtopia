const { test, expect } = require("./fixtures");

async function prepare(context, extensionId, server, { state = "live", enabled = true } = {}) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await page.evaluate(async value => {
    await chrome.storage.local.set({ tabtopiaHomeRecommendationPrefsV1: { hubs: [], exploration: false } });
    await chrome.runtime.sendMessage({ action: "setRankingDiagnostics", enabled: value });
    await chrome.runtime.sendMessage({ action: "clearRankingDiagnostics" });
  }, enabled);
  await page.evaluate(async ({ state, server }) => {
    await chrome.storage.local.set({ tabtopiaContextHiddenSitesV1: ["excluded.example.test"] });
    await chrome.storage.session.set({ tabtopiaRecentContextV1: {
      version: 1, status: state, generatedAt: Date.now() - 1000,
      expiresAt: state === "live" ? Date.now() + 25 * 60000 : 0,
      fetchedAt: Date.now(), context: { seedCount: state === "live" ? 2 : 0 },
      results: state === "live" ? [
        { title: "Techmeme", url: "https://techmeme.com", score: 0.78 },
        { title: "Excluded example", url: "https://excluded.example.test", score: 0.77 },
        { title: "Alpha Page", url: `${server}/alpha`, score: 0.76 },
        { title: "Another archive destination", url: "https://example.org/reading", score: 0.75 },
        { title: "Fourth suggestion", url: "https://example.net/reading", score: 0.74 }
      ] : []
    } });
  }, { state, server });
  await page.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/home`);
  await expect(page.locator("#startPageHome")).toBeVisible();
  await expect(page.locator("#startPageHome")).toHaveAttribute("aria-busy", "false");
  return page;
}
const featured = page => page.locator(".home-takeover__featured");
const summary = page => page.evaluate(async () => (await chrome.runtime.sendMessage({ action: "getHomeRecommendationDiagnostics" })).summary);

async function checkLayout(page, file) {
  await page.screenshot({ path: file, fullPage: true });
  const geometry = await page.evaluate(() => {
    const feature = document.querySelector(".home-takeover__featured");
    const controls = [...feature.querySelectorAll("a,button")].map(node => {
      const rect = node.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    const luminance = rgb => rgb.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, index) => sum + v * [.2126, .7152, .0722][index], 0);
    const parse = color => color.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 0];
    const contrasts = [...feature.querySelectorAll("h2,.home-takeover__action-title,.home-takeover__domain,button")].map(node => {
      let ancestor = node;
      let background = [255, 255, 255];
      while (ancestor) {
        const color = parse(getComputedStyle(ancestor).backgroundColor);
        if (color.length === 3 || color[3] === 1) { background = color; break; }
        ancestor = ancestor.parentElement;
      }
      const a = luminance(parse(getComputedStyle(node).color)), b = luminance(background);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    });
    return { width: document.documentElement.scrollWidth, viewport: innerWidth,
      top: feature.getBoundingClientRect().top, bottom: feature.getBoundingClientRect().bottom,
      height: innerHeight, controls, contrasts };
  });
  expect(geometry.width, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
  for (const control of geometry.controls) {
    expect(control.height).toBeGreaterThanOrEqual(44);
    expect(control.width).toBeGreaterThanOrEqual(44);
  }
  for (const contrast of geometry.contrasts) expect(contrast).toBeGreaterThanOrEqual(8);
}

test("featured context leads Home, respects exclusions, and fits desktop and narrow layouts", async ({ context, extensionId, server }) => {
  const page = await prepare(context, extensionId, server);
  await expect(featured(page)).toBeVisible();
  await expect(featured(page).locator("a")).toHaveCount(3);
  await expect(featured(page)).toContainText("Techmeme");
  await expect(featured(page)).not.toContainText("Excluded example");
  const sections = await page.locator("#startPageHome > section").evaluateAll(nodes => nodes.map(n => n.className));
  expect(sections[0]).toContain("featured");
  await expect(page.locator(".home-takeover__header > .frequent-bank")).toBeVisible();
  await expect(page.getByText("For now", { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await summary(page)).arms.balanced.impressions).toBeGreaterThan(0);
  await checkLayout(page, "/tmp/histospire-context-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await checkLayout(page, "/tmp/histospire-context-mobile.png");
});

test("hide persists, Undo restores, and fresh mode removes featured suggestions", async ({ context, extensionId, server }) => {
  const page = await prepare(context, extensionId, server);
  const hide = featured(page).getByRole("button", { name: "Hide techmeme.com from contextual suggestions" });
  await hide.focus();
  await hide.press("Enter");
  await expect(featured(page)).not.toContainText("Techmeme");
  expect(await page.evaluate(async () => (await chrome.storage.local.get("tabtopiaContextHiddenSitesV1")).tabtopiaContextHiddenSitesV1)).toContain("techmeme.com");
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeFocused();
  // Keep a snapshot containing the hidden-site preference in flight while
  // Undo saves the opposite preference. Neither that invalidation nor the
  // explicit restore may be overwritten by the older snapshot's completion.
  await page.evaluate(() => {
    const original = chrome.bookmarks.getRecent.bind(chrome.bookmarks);
    chrome.bookmarks.getRecent = async limit => {
      chrome.bookmarks.getRecent = original;
      window.__delayedBookmarkRead = true;
      const rows = await original(limit);
      await new Promise(resolve => setTimeout(resolve, 900));
      return rows;
    };
    void window.tabtopiaStartPageRecognition.refresh();
  });
  await expect.poll(() => page.evaluate(() => Boolean(window.__delayedBookmarkRead))).toBe(true);
  await undo.press("Enter");
  await expect(featured(page)).toContainText("Techmeme");
  expect(await page.evaluate(async () => (await chrome.storage.local.get("tabtopiaContextHiddenSitesV1")).tabtopiaContextHiddenSitesV1)).not.toContain("techmeme.com");
  await page.getByRole("button", { name: "Start fresh", exact: true }).click();
  await expect(featured(page)).toHaveCount(0);
});

test("featured click follows canonical same-tab navigation and records qualified visit separately", async ({ context, extensionId, server }) => {
  const page = await prepare(context, extensionId, server);
  await expect(featured(page)).toBeVisible();
  const pagesBefore = context.pages().length;
  await featured(page).getByRole("link", { name: /Alpha Page/ }).click();
  await expect(page).toHaveURL(`${server}/alpha`);
  expect(context.pages()).toHaveLength(pagesBefore);
  await expect.poll(async () => {
    const worker = context.serviceWorkers()[0];
    return worker.evaluate(async () => {
      const study = (await chrome.storage.local.get("tabtopiaHomeRecommendationStudyV3")).tabtopiaHomeRecommendationStudyV3;
      return (study?.details || []).filter(r => r.event === "engaged").length;
    });
  }, { timeout: 16000 }).toBe(1);
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await expect(page.locator("#homeRecommendationPolicies")).toContainText("Engaged 10s+");
  const result = await summary(page);
  expect(result.arms.balanced.clicks).toBe(1);
  expect(result.arms.balanced.engaged).toBe(1);
  expect(result.cohort).toBe("home-recs-v3");
});

for (const state of ["empty", "offline"]) test(`${state} context falls back to usable Home`, async ({ context, extensionId, server }) => {
  const page = await prepare(context, extensionId, server, { state, enabled: false });
  await expect(featured(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "All tabs", exact: true })).toBeVisible();
  expect((await summary(page)).detailCount).toBe(0);
});


test("visible featured context creates no records while diagnostics are disabled", async ({ context, extensionId, server }) => {
  const page = await prepare(context, extensionId, server, { enabled: false });
  await expect(featured(page)).toBeVisible();
  await featured(page).getByRole("button", { name: "Hide techmeme.com from contextual suggestions" }).click();
  await expect(featured(page)).not.toContainText("Techmeme");
  expect((await summary(page)).enabled).toBe(false);
  const saved = await page.evaluate(async () => ({
    local: await chrome.storage.local.get("tabtopiaHomeRecommendationStudyV3"),
    session: await chrome.storage.session.get("tabtopiaHomeRecommendationPendingV3")
  }));
  expect(saved).toEqual({ local: {}, session: {} });
});

test("visible recommendations stay stable on refresh and deliberately rotate to alternatives", async ({ context, extensionId, server }) => {
  const page = await prepare(context, extensionId, server);
  await expect(featured(page).locator("a")).toHaveCount(3);
  const first = await featured(page).locator("a").evaluateAll(nodes => nodes.map(n => n.href));
  await expect.poll(async () => (await summary(page)).arms.balanced.exposures).toBe(3);
  await page.evaluate(() => window.tabtopiaStartPageRecognition.refresh());
  expect(await featured(page).locator("a").evaluateAll(nodes => nodes.map(n => n.href))).toEqual(first);
  expect((await summary(page)).arms.balanced.exposures).toBe(3);
  await featured(page).getByRole("button", { name: "Show alternatives" }).click();
  await expect(featured(page).locator("a")).toHaveCount(1);
  const next = await featured(page).locator("a").evaluateAll(nodes => nodes.map(n => n.href));
  expect(next.every(url => !first.includes(url))).toBe(true);
  await expect(page.getByRole("button", { name: "Show alternatives" })).toBeFocused();
  await page.evaluate(() => window.tabtopiaStartPageRecognition.refresh());
  await expect(page.getByRole("button", { name: "Show alternatives" })).toBeFocused();
});

test("hub, document and bookmark-path signals work offline; snooze is reversible with diagnostics off", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({ action: "setRankingDiagnostics", enabled: false });
    await chrome.storage.local.set({ tabtopiaHomeRecommendationPrefsV1: { hubs: [
      { url: "http://localhost:8765/", title: "Stats" },
      { url: "http://localhost:2527/", title: "Cartographer" }
    ], exploration: false } });
    for (const name of ["ROADMAP", "DESIGN", "PLAN"]) await chrome.bookmarks.create({
      title: "Session Cartographer", url: `http://localhost:2527/memory?file=%2Fproject%2F${name}.md&review=file&from=2026-09-27`
    });
  });
  await page.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/home`);
  await expect(featured(page)).toBeVisible();
  await expect(featured(page).locator("a")).toHaveCount(3);
  await expect(featured(page)).toContainText("Stats");
  await expect(featured(page)).toContainText("Your selected hub");
  const model = await page.evaluate(() => window.tabtopiaStartPageHome.model.featuredItems);
  const doc = model.find(item => item.features.document);
  expect(doc).toBeTruthy();
  expect(doc.features.bookmarkSupport).toBe(2);
  expect(doc.features.bookmarkDensity).toBeGreaterThan(0);
  expect(doc.url).toContain("review=file");
  await featured(page).getByRole("button", { name: `Snooze ${doc.title} for one day` }).click();
  await expect(featured(page).getByRole("link", { name: `Open: ${doc.title}`, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo snooze" })).toBeFocused();
  await page.getByRole("button", { name: "Undo snooze" }).press("Enter");
  await expect(featured(page).getByRole("link", { name: `Open: ${doc.title}`, exact: true })).toBeVisible();
  await featured(page).getByRole("button", { name: "Hide localhost:8765 from contextual suggestions" }).click();
  await expect(featured(page)).not.toContainText("Stats");
  await expect(featured(page)).toContainText("Cartographer");
  const saved = await page.evaluate(() => chrome.storage.local.get(["tabtopiaHomeRecommendationStudyV3", "tabtopiaHomeRecommendationSnoozesV2"]));
  expect(saved.tabtopiaHomeRecommendationStudyV3).toBeUndefined();
  expect(JSON.stringify(saved)).not.toContain("/project/");
});

test("leaving a recommended destination early records departure without engagement", async ({ context, extensionId, server }) => {
  const page = await prepare(context, extensionId, server);
  await featured(page).getByRole("link", { name: /Alpha Page/ }).click();
  await expect(page).toHaveURL(`${server}/alpha`);
  await expect.poll(() => context.serviceWorkers()[0].evaluate(async () => {
    return Boolean((await chrome.storage.session.get("tabtopiaHomeRecommendationPendingV3")).tabtopiaHomeRecommendationPendingV3?.choice?.focus);
  })).toBe(true);
  await page.goto(`${server}/beta`);
  await expect.poll(() => context.serviceWorkers()[0].evaluate(async () => {
    const study = (await chrome.storage.local.get("tabtopiaHomeRecommendationStudyV3")).tabtopiaHomeRecommendationStudyV3;
    return study?.days?.[0]?.arms?.balanced?.bounces || 0;
  })).toBe(1);
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  expect((await summary(page)).arms.balanced.engaged).toBe(0);
});

test("failed recommendation navigation cancels attribution and can be retried", async ({ context, extensionId, server }) => {
  const page = await prepare(context, extensionId, server);
  await expect(featured(page)).toBeVisible();
  await page.evaluate(() => {
    window.__originalTabUpdate = chrome.tabs.update;
    chrome.tabs.update = async () => { throw new Error("Navigation blocked for fixture"); };
  });
  await featured(page).getByRole("link", { name: /Alpha Page/ }).click();
  await expect(page).toHaveURL(/newtab.html#\/home$/);
  await expect.poll(() => page.evaluate(async () => {
    const pending = (await chrome.storage.session.get("tabtopiaHomeRecommendationPendingV3")).tabtopiaHomeRecommendationPendingV3;
    return pending?.choice === null;
  })).toBe(true);
  expect((await summary(page)).arms.balanced.clicks).toBe(1);
  await page.evaluate(() => { chrome.tabs.update = window.__originalTabUpdate; });
  await featured(page).getByRole("link", { name: /Alpha Page/ }).click();
  await expect(page).toHaveURL(`${server}/alpha`);
  await expect.poll(() => context.serviceWorkers()[0].evaluate(async () => {
    const pending = (await chrome.storage.session.get("tabtopiaHomeRecommendationPendingV3")).tabtopiaHomeRecommendationPendingV3;
    return Boolean(pending?.choice?.focus);
  })).toBe(true);
});

test("unconfigured Home discovers hubs from actual browser history", async ({ context, extensionId, server }) => {
  const page = await context.newPage();
  await page.goto(`${server}/alpha`);
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await expect(page.locator("#recommendationHubs")).toHaveValue("");
  await page.evaluate(async origin => {
    // No saved hubs and no server context: only Chrome's own history is seeded.
    for (let index = 0; index < 16; index++) {
      await chrome.history.addUrl({ url: `${origin}/alpha` });
      await chrome.history.addUrl({ url: "https://another-hub.test/" });
    }
  }, server);
  await page.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/home`);
  await expect(featured(page).locator("a")).toHaveCount(2);
  const items = await page.evaluate(() => window.tabtopiaStartPageHome.model.featuredItems);
  expect(items.every(item => item.features.inferredHub && !item.features.selectedHub)).toBe(true);
  expect(new Set(items.map(item => item.url))).toEqual(new Set([`${server}/alpha`, "https://another-hub.test/"]));
  await expect(featured(page)).toContainText("Frequently revisited");
  await expect(featured(page)).not.toContainText("Your selected hub");
});
