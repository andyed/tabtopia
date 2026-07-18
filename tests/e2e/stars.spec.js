const { test, expect } = require("./fixtures");

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
  });
});
