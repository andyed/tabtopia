const { test, expect } = require("./fixtures");

test("Mobile folder provenance reaches canonical Home, including an unseen saved page", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  const folderId = await page.evaluate(async () => {
    const folder = await chrome.bookmarks.create({ title: "Phone reading fixture" });
    await chrome.bookmarks.create({ parentId: folder.id, title: "Paper saved for desktop", url: "https://phone.test/read-later" });
    return folder.id;
  });
  // A fresh, unsigned-in Chromium profile has no synced Mobile folder. Supply
  // only that browser-owned metadata; the collector and Home renderer are real.
  await context.addInitScript(id => {
    if (!globalThis.chrome?.bookmarks) return;
    const getTree = chrome.bookmarks.getTree.bind(chrome.bookmarks);
    chrome.bookmarks.getTree = async () => {
      const tree = await getTree();
      const visit = nodes => nodes.forEach(node => {
        if (node.id === id) node.folderType = "mobile";
        if (node.children) visit(node.children);
      });
      visit(tree);
      return tree;
    };
  }, folderId);
  await page.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/home`);
  const home = page.locator("#startPageHome");
  await expect(home).toHaveAttribute("aria-busy", "false");
  await expect(home.getByText("Paper saved for desktop", { exact: true }).first()).toBeVisible();
  await expect(home.getByText(/From Mobile bookmarks/).first()).toBeVisible();
  await page.screenshot({ path: "/tmp/histospire-mobile-intention-home.png" });
});

test("real foreground bookmark visits distinguish a quick opening from thirty seconds, and clear locally", async ({ context, extensionId, server }) => {
  test.setTimeout(65000);
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await options.evaluate(async url => {
    await chrome.runtime.sendMessage({ action: "clearRankingDiagnostics" });
    await chrome.bookmarks.create({ title: "Read on desktop", url });
    await chrome.runtime.sendMessage({ action: "getRankingDiagnostics" });
  }, server + "/alpha");
  const article = await context.newPage();
  await article.goto(server + "/alpha");
  await article.bringToFront();
  const summary = () => options.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: "getRankingDiagnostics" });
    return response.bookmarkIntentStudy?.groups.find(group => group.source === "other-bookmarks");
  });
  await expect.poll(async () => (await summary())?.opened, { timeout: 10000 }).toBe(1);
  expect((await summary()).engaged).toBe(0);
  expect((await summary()).pending).toBe(1);
  await expect.poll(async () => (await summary())?.engaged, { timeout: 35000, intervals: [1000] }).toBe(1);
  expect((await summary()).pending).toBe(0);

  await options.bringToFront();
  await options.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(options.locator("#bookmarkIntentStatus")).toContainText("1 deeper visits");
  await expect(options.locator("#revisitStudyReport .model-card")).toHaveCount(3);
  await options.setViewportSize({ width: 390, height: 844 });
  await options.locator("#revisit-title").evaluate(node => node.scrollIntoView({ block: "center" }));
  expect(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await options.screenshot({ path: "/tmp/histospire-revisit-report-mobile.png" });

  const serialized = await options.evaluate(async () => JSON.stringify(await chrome.storage.local.get([
    "tabtopiaBookmarkIntentV1", "tabtopiaRevisitStudyV1"
  ])));
  expect(serialized).not.toContain(server);
  expect(serialized).not.toContain("Read on desktop");
  await options.locator("#diagnosticsEnabled").focus();
  await options.locator("#diagnosticsEnabled").press("Space");
  await expect.poll(() => options.evaluate(async () => Object.keys(await chrome.storage.local.get([
    "tabtopiaBookmarkIntentV1", "tabtopiaRevisitStudyV1"
  ])).length)).toBe(0);
});
