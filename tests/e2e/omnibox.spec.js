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
      "tabtopiaRankingDiagnosticsV2",
    ]));
    expect(stored.tabtopiaRankingDiagnosticsEnabledV1).toBe(false);
    expect(stored.tabtopiaRankingDiagnosticsV2).toBeUndefined();
  });

  test("shadow study compares every baseline and persists content-free outcomes", async ({ context, extensionId, server }) => {
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html`, {
      waitUntil: "domcontentloaded",
    });
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10_000 });

    // Wait for the real two-second qualification rather than assuming a fixed
    // sleep also covers Chrome event delivery, hashing and storage callbacks.
    const qualify = async page => {
      const tabId = await extensionPage.evaluate(async url =>
        (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
      expect(tabId).toBeTruthy();
      await page.bringToFront();
      await expect.poll(() => extensionPage.evaluate(async () =>
        (await chrome.storage.session.get("tabtopiaRankingDiagnosticsPendingV2"))
          .tabtopiaRankingDiagnosticsPendingV2?.sourceTabId), { timeout: 10000 }).toBe(tabId);
    };

    const alpha = await context.newPage();
    await alpha.goto(server + "/alpha", { waitUntil: "load" });
    await qualify(alpha);

    const beta = await context.newPage();
    await beta.goto(server + "/beta", { waitUntil: "load" });
    await qualify(beta);

    await qualify(alpha);

    // Revisit an already-loaded tab so the current source has a qualified
    // outgoing transition when the next shadow prediction is built.
    await qualify(beta);
    await expect.poll(() => extensionPage.evaluate(async () => {
      const saved = await chrome.storage.local.get("tabtopiaRevisitModelV1");
      return Object.keys(saved.tabtopiaRevisitModelV1?.transitions?.page || {}).length;
    }), { timeout: 10000 }).toBeGreaterThan(0);
    // A qualified prediction is ready before the deferred diagnostic write.
    // Flush via the same report API as Settings before taking the baseline;
    // otherwise a delayed prior outcome looks like a same-tab navigation event.
    const report = await extensionPage.evaluate(() =>
      chrome.runtime.sendMessage({ action: "getRankingDiagnostics" }));
    expect(report.success).toBe(true);

    const diagnosticState = await extensionPage.evaluate(async () => {
      const local = await chrome.storage.local.get([
        "tabtopiaRankingDiagnosticsV2",
        "tabtopiaRevisitModelV1",
      ]);
      const session = await chrome.storage.session.get("tabtopiaRankingDiagnosticsPendingV2");
      return {
        records: (await import(chrome.runtime.getURL("src/lib/ranking-detail-codec.js"))).decodeRankingDetails(local.tabtopiaRankingDiagnosticsV2),
        revisit: local.tabtopiaRevisitModelV1 || null,
        pending: session.tabtopiaRankingDiagnosticsPendingV2 || null,
      };
    });
    const modelVersions = Object.keys(diagnosticState.pending?.models || {});
    const eligibleOutcome = diagnosticState.records.find(record =>
      record.event === "next_tab_outcome" && !record.censorReason);
    const serialized = JSON.stringify(diagnosticState.records);

    expect(modelVersions).toHaveLength(12);
    expect(modelVersions).toEqual(expect.arrayContaining([
      "mru-v1",
      "investment-v1",
      "same-domain-mru-v1",
      "strip-neighbor-v1",
      "transition-page-v1",
      "transition-domain-v1",
      "frecency-v1",
      "history-page-v1",
      "history-domain-v1",
      "bayes-page-v1",
      "bayes-domain-v1",
      "bayes-hierarchical-v1",
    ]));
    expect(Object.keys(diagnosticState.revisit?.transitions?.page || {})).not.toHaveLength(0);
    expect(diagnosticState.pending?.models?.["transition-page-v1"]?.predictedTabIds.length).toBeGreaterThan(0);
    expect(eligibleOutcome?.models).toHaveLength(12);
    expect(eligibleOutcome?.cohort).toBe("next-tab-matrix-v3");
    expect(serialized).not.toContain(server);
    expect(serialized).not.toContain("Alpha Page");
    expect(serialized).not.toContain("Beta Page");
    expect(serialized).not.toContain("predictedTabIds");
    expect(serialized).not.toContain("actualTabId");

    // Same-tab navigation qualifies History access, but is not a next-tab outcome.
    await beta.goto(server + "/gamma", { waitUntil: "load" });
    await beta.waitForTimeout(3_500);
    const afterNavigation = await extensionPage.evaluate(async () => {
      const local = await chrome.storage.local.get("tabtopiaRankingDiagnosticsV2");
      const { decodeRankingDetails } = await import(chrome.runtime.getURL("src/lib/ranking-detail-codec.js"));
      return decodeRankingDetails(local.tabtopiaRankingDiagnosticsV2);
    });
    expect(afterNavigation.length).toBe(diagnosticState.records.length);

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options/options.html`, {
      waitUntil: "domcontentloaded",
    });
    await expect(options.getByRole("heading", { name: "Bayesian · domain" })).toBeVisible();
    await expect(options.getByRole("heading", { name: "MRU baseline" })).toBeVisible();
    await expect(options.getByText(/Shadow only/)).toBeVisible();
    await expect(options.getByText("Prediction p95")).toBeVisible();
    await expect(options.getByText("Censor reasons")).toBeVisible();
    await expect(options.getByText("Next destination type")).toBeVisible();
  });
});
