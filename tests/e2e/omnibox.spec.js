const { test, expect } = require("./fixtures");

test.describe("omnibox recall foundation", () => {
  test("registers tt and persists only keyed revisit identities", async ({ context, extensionId, server }) => {
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html`, {
      waitUntil: "domcontentloaded",
    });

    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10_000 });

    const registration = await worker.evaluate(() => ({
      keyword: chrome.runtime.getManifest().omnibox?.keyword,
      hasOmniboxApi: Boolean(chrome.omnibox),
    }));
    expect(registration).toEqual({ keyword: "tt", hasOmniboxApi: true });

    const alpha = await context.newPage();
    await alpha.goto(server + "/alpha", { waitUntil: "load" });
    await alpha.bringToFront();
    await alpha.waitForTimeout(2_200);

    const beta = await context.newPage();
    await beta.goto(server + "/beta", { waitUntil: "load" });
    await beta.bringToFront();
    await beta.waitForTimeout(4_500);

    const persisted = await worker.evaluate(async () => {
      return chrome.storage.local.get(["tabtopiaRevisitModelV1", "tabtopiaRevisitSecretV1"]);
    });
    expect(persisted.tabtopiaRevisitSecretV1).toBeTruthy();
    expect(Object.keys(persisted.tabtopiaRevisitModelV1?.histories?.page || {}).length).toBeGreaterThan(0);

    const serialized = JSON.stringify(persisted.tabtopiaRevisitModelV1);
    expect(serialized).not.toContain("127.0.0.1");
    expect(serialized).not.toContain("Alpha Page");
    expect(serialized).not.toContain("Beta Page");
  });

  test("ranking diagnostics default on only for unpacked installs and can be disabled", async ({ context, extensionId }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options/options.html`, {
      waitUntil: "domcontentloaded",
    });

    const toggle = options.getByRole("switch", { name: "Help improve tab ranking" });
    await expect(toggle).toBeChecked();
    await expect(options.getByText("Internal install · default on")).toBeVisible();

    await toggle.press("Space");
    await expect(toggle).not.toBeChecked();

    const stored = await options.evaluate(async () => chrome.storage.local.get([
      "tabtopiaRankingDiagnosticsEnabledV1",
      "tabtopiaRankingDiagnosticsV1",
    ]));
    expect(stored.tabtopiaRankingDiagnosticsEnabledV1).toBe(false);
    expect(stored.tabtopiaRankingDiagnosticsV1).toBeUndefined();
  });
});
