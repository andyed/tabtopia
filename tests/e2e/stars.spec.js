const fs = require("fs");
const os = require("os");
const path = require("path");
const { test, expect, launchExtensionContext } = require("./fixtures");

test.describe("landmarks view", () => {
  test("maps bookmarks and reveals the selected context trail", async ({ context, extensionId, server }) => {
    const fixturePages = [];
    for (const slug of ["/alpha", "/beta", "/gamma"]) {
      const page = await context.newPage();
      await page.goto(server + slug, { waitUntil: "load" });
      fixturePages.push(page);
    }

    const stars = await context.newPage();
    await stars.goto(`chrome-extension://${extensionId}/src/newtab/stars.html`, { waitUntil: "domcontentloaded" });

    await stars.evaluate(async (urls) => {
      for (const [index, url] of urls.entries()) {
        await chrome.bookmarks.create({ title: ["Alpha Page", "Beta Page", "Gamma Page"][index], url });
      }
    }, fixturePages.map(page => page.url()));

    await stars.reload({ waitUntil: "domcontentloaded" });
    await expect(stars.locator(".landmark-node")).toHaveCount(3);
    await expect(stars.locator("#landmark-detail h2")).toContainText(/Alpha|Beta|Gamma/);
    await expect(stars.locator(".context-trail")).toBeVisible();

    await stars.locator("#starsSearch").fill("Alpha");
    await expect(stars.locator(".landmark-node")).toHaveCount(1);
    await expect(stars.locator("#landmark-detail h2")).toContainText("Alpha");

    await stars.locator("#starsSearch").fill("");
    await expect(stars.locator(".landmark-node")).toHaveCount(3);
    for (let step = 0; step < 6; step += 1) {
      await stars.getByRole("button", { name: "Zoom in" }).click();
    }
    await expect(stars.locator("#landmarks-zoom-scale")).toHaveText("1200%");
    await expect(stars.locator(".landmark-label:not(.is-visible)")).toHaveCount(0);

    const keyboardLandmark = stars.locator(".landmark-node").nth(1);
    await keyboardLandmark.focus();
    await keyboardLandmark.press("Enter");
    await expect(stars.locator(".open-landmark")).toBeFocused();
    await expect(stars.locator(".context-trail .trail-node")).toHaveCount(3);
    await expect(stars.locator(".open-landmark")).toBeFocused();
  });

  test("searches every bookmark, expands through tags, then falls back to History", async ({ context, extensionId, server }) => {
    const runtimeErrors = [];
    const historyOnly = await context.newPage();
    await historyOnly.goto(server + "/recent-only", { waitUntil: "load" });
    await historyOnly.close();

    const stars = await context.newPage();
    stars.on("pageerror", error => runtimeErrors.push(error.message));
    await stars.goto(`chrome-extension://${extensionId}/src/newtab/stars.html`, { waitUntil: "domcontentloaded" });

    await stars.evaluate(async ({ baseUrl, now }) => {
      await chrome.bookmarks.create({
        title: "Buried Keepsake",
        url: `${baseUrl}/buried-keepsake`
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      for (let index = 0; index < 85; index += 1) {
        await chrome.bookmarks.create({
          title: `Newer landmark ${String(index).padStart(2, "0")}`,
          url: `${baseUrl}/bookmark-${index}`
        });
      }

      await chrome.storage.local.set({
        tabtopiaArchiveProviderV1: {
          version: 1,
          updatedAt: now,
          archive: {
            fetchedAt: now,
            rows: [
              {
                title: "WebGL shader guide",
                url: `${baseUrl}/webgl-guide`,
                tags: ["creative coding", "graphics"],
                archivedAt: now - 1000
              },
              {
                title: "Depthfield camera effects",
                url: `${baseUrl}/depthfield-camera`,
                tags: ["graphics", "photography"],
                archivedAt: now - 2000
              }
            ]
          },
          queries: {},
          lastQuery: ""
        }
      });
    }, { baseUrl: server, now: Date.now() });

    await stars.reload({ waitUntil: "domcontentloaded" });
    await expect(stars.locator(".landmark-node")).toHaveCount(60);
    await expect(stars.locator('.landmark-node[aria-label^="Buried Keepsake,"]')).toHaveCount(0);

    const input = stars.locator("#starsSearch");
    const results = stars.locator("#startPageSearch .search-serp__result-link");

    await input.fill("buried keepsake");
    await expect(results.filter({ hasText: "Buried Keepsake" })).toHaveCount(1);
    await expect(results.filter({ hasText: "Buried Keepsake" }).locator(".search-serp__token--saved")).toContainText("Saved");
    if (process.env.TABTOPIA_VISUAL_DIR) {
      await stars.screenshot({
        path: path.join(process.env.TABTOPIA_VISUAL_DIR, "stars-saved-evidence-1600x1000.png"),
        animations: "disabled",
        fullPage: true
      });
      await stars.setViewportSize({ width: 390, height: 780 });
      await stars.screenshot({
        path: path.join(process.env.TABTOPIA_VISUAL_DIR, "stars-saved-evidence-390x780.png"),
        animations: "disabled",
        fullPage: true
      });
      await stars.setViewportSize({ width: 1600, height: 1000 });
    }

    await input.fill("webgl");
    await expect(results.filter({ hasText: "Depthfield camera effects" })).toHaveCount(1);
    await expect(results.filter({ hasText: "Depthfield camera effects" }).locator(".search-serp__token--related"))
      .toHaveText("Related via graphics");
    await expect(results).toHaveCount(2);
    await input.press("ArrowDown");
    await expect(results.nth(0)).toBeFocused();
    await results.nth(0).press("ArrowDown");
    await expect(results.nth(1)).toBeFocused();
    await input.focus();
    await input.press("ArrowUp");
    await expect(results.nth(1)).toBeFocused();
    await results.nth(1).press("ArrowDown");
    await expect(results.nth(0)).toBeFocused();
    if (process.env.TABTOPIA_VISUAL_DIR) {
      await stars.screenshot({
        path: path.join(process.env.TABTOPIA_VISUAL_DIR, "stars-tagged-recall-1600x1000.png"),
        fullPage: true
      });
    }

    await input.fill("flight review");
    await expect(results.filter({ hasText: "Recently Closed Flight Review" })).toHaveCount(1);
    await expect(results.filter({ hasText: "Recently Closed Flight Review" }).locator(".search-serp__token--history"))
      .toContainText("Last opened");

    await input.press("Escape");
    await expect(input).toHaveValue("");
    await expect(stars.locator("#startPageSearch")).toBeHidden();
    await expect(stars.locator("#stars-container")).toBeVisible();
    expect(runtimeErrors).toEqual([]);
  });

  test("honors a carried search term while recall sources are loading", async ({ context, extensionId, server }) => {
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${extensionId}/src/newtab/stars.html`, { waitUntil: "domcontentloaded" });
    await setup.evaluate(async ({ baseUrl, now }) => {
      await chrome.storage.local.set({
        tabtopiaArchiveProviderV1: {
          version: 1,
          updatedAt: now,
          archive: {
            fetchedAt: now,
            rows: [{
              title: "WebGL shader guide",
              url: `${baseUrl}/webgl-guide`,
              tags: ["creative coding", "graphics"],
              archivedAt: now - 1000
            }]
          },
          queries: {},
          lastQuery: ""
        }
      });
    }, { baseUrl: server, now: Date.now() });

    await setup.goto(
      `chrome-extension://${extensionId}/src/newtab/stars.html?q=webgl`,
      { waitUntil: "domcontentloaded" }
    );

    await expect(setup.locator("#starsSearch")).toHaveValue("webgl");
    await expect(setup.locator("#startPageSearch")).toBeVisible();
    await expect(setup.locator("#stars-container")).toBeHidden();
    await expect(setup.locator(".search-serp__result-link").filter({ hasText: "WebGL shader guide" })).toHaveCount(1);
  });

  test("repairs a legacy quota-heavy profile before Stars recall loads", async ({ server }) => {
    test.setTimeout(45_000);
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tabtopia-storage-repair-"));
    let first;
    let second;

    try {
      first = await launchExtensionContext(userDataDir);
      const seedPage = first.pages()[0] || await first.newPage();
      await seedPage.goto("chrome://newtab/", { waitUntil: "domcontentloaded" });
      await seedPage.evaluate(async ({ baseUrl, now }) => {
        const legacyHeroes = {};
        for (let index = 0; index < 180; index += 1) {
          const url = `https://legacy.example.com/page-${index}`;
          legacyHeroes[url] = {
            timestamp: now - index,
            images: [
              { src: `data:image/png;base64,${"x".repeat(10_000)}`, score: 100 },
              { src: `https://images.example.com/${index}.jpg`, score: 50 }
            ]
          };
        }

        await chrome.storage.local.set({
          historyEntries: Array.from({ length: 100 }, (_, index) => ({
            url: `https://history.example.com/${index}`,
            title: `History ${index}`
          })),
          heroImages: legacyHeroes,
          browserState: {
            tabHistory: {},
            tabRelationships: {},
            tabActivityLog: {},
            tabAudioTracking: {},
            heroImages: legacyHeroes,
            lastSaved: now
          },
          tabtopiaArchiveProviderV1: {
            version: 1,
            updatedAt: now,
            archive: {
              fetchedAt: now,
              rows: [{
                title: "WebGL shader guide",
                url: `${baseUrl}/webgl-guide`,
                tags: ["creative coding", "graphics"],
                archivedAt: now
              }]
            },
            queries: {},
            lastQuery: ""
          }
        });
      }, { baseUrl: server, now: Date.now() });
      await first.close();
      first = null;

      second = await launchExtensionContext(userDataDir);
      const stars = second.pages()[0] || await second.newPage();
      await stars.goto("chrome://newtab/", { waitUntil: "domcontentloaded" });
      const extensionId = await stars.evaluate(() => chrome.runtime.id);

      await expect.poll(async () => stars.evaluate(async () => {
        const stored = await chrome.storage.local.get(["historyEntries", "heroImages", "browserState"]);
        return {
          hasHistoryEntries: stored.historyEntries !== undefined,
          hasDuplicatedHeroes: Object.prototype.hasOwnProperty.call(stored.browserState || {}, "heroImages"),
          heroCount: Object.keys(stored.heroImages || {}).length,
          hasDataImage: Object.values(stored.heroImages || {}).some(record =>
            (record.images || []).some(image => String(image.src || "").startsWith("data:")))
        };
      })).toEqual({
        hasHistoryEntries: false,
        hasDuplicatedHeroes: false,
        heroCount: 160,
        hasDataImage: false
      });

      await stars.goto(
        `chrome-extension://${extensionId}/src/newtab/stars.html?q=webgl`,
        { waitUntil: "domcontentloaded" }
      );
      await expect(stars.locator(".search-serp__result-link").filter({ hasText: "WebGL shader guide" })).toHaveCount(1);
    } finally {
      await first?.close();
      await second?.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
