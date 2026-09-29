const { test, expect } = require("./fixtures");

const PREFS_KEY = "tabtopiaHomeRecommendationPrefsV1";

async function openOptions(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await expect(page.locator("#recommendationPreferencesStatus")).toHaveText("Saved on this device.");
  return page;
}

test("recommendation preferences validate hub addresses and persist without exploration", async ({ context, extensionId }) => {
  const page = await openOptions(context, extensionId);
  const hubs = page.locator("#recommendationHubs");
  await expect(hubs).toHaveValue("");
  const save = page.getByRole("button", { name: "Save recommendations", exact: true });
  const status = page.locator("#recommendationPreferencesStatus");
  const initial = await page.evaluate(async key => (await chrome.storage.local.get(key))[key] || null, PREFS_KEY);

  for (const invalid of ["javascript:alert(1)", "https://user:secret@example.test/", "not an address"]) {
    await hubs.fill(invalid);
    await save.click();
    await expect(status).toContainText(/http or https/);
    expect(await page.evaluate(async key => (await chrome.storage.local.get(key))[key] || null, PREFS_KEY)).toEqual(initial);
  }
  await hubs.fill(Array.from({ length: 13 }, (_, index) => `https://hub${index}.test/`).join("\n"));
  await save.click();
  await expect(status).toHaveText("Choose up to 12 favorite hubs.");

  await hubs.fill("http://localhost:8765/\nhttp://localhost:2527/\nhttps://example.test/docs/");
  await page.locator("#recommendationExploration").uncheck();
  await save.click();
  await expect(status).toHaveText("Saved. Applies to the next recommendation set.");
  await page.reload();
  await expect(status).toHaveText("Saved on this device.");
  await expect(hubs).toHaveValue("http://localhost:8765/\nhttp://localhost:2527/\nhttps://example.test/docs/");
  await expect(page.locator("#recommendationExploration")).not.toBeChecked();
  const saved = await page.evaluate(async key => (await chrome.storage.local.get(key))[key], PREFS_KEY);
  expect(saved.exploration).toBe(false);
  expect(saved.hubs.map(hub => hub.url)).toEqual([
    "http://localhost:8765/", "http://localhost:2527/", "https://example.test/docs/"
  ]);
  expect(saved.hubs.slice(0, 2).map(hub => hub.title)).toEqual(["localhost:8765", "localhost:2527"]);

  // An explicitly empty list must survive a reload rather than restoring development defaults.
  await hubs.fill("");
  await save.click();
  await expect(status).toHaveText("Saved. Applies to the next recommendation set.");
  await page.reload();
  await expect(status).toHaveText("Saved on this device.");
  await expect(hubs).toHaveValue("");
  await expect(page.locator("#recommendationExploration")).not.toBeChecked();
});

test("recommendation report reads both policies from the real background and fits mobile", async ({ context, extensionId }) => {
  const page = await openOptions(context, extensionId);
  const results = await page.evaluate(async () => {
    const send = message => chrome.runtime.sendMessage(message);
    await send({ action: "setRankingDiagnostics", enabled: true });
    await send({ action: "clearRankingDiagnostics" });
    const outcomes = [];
    for (const [arm, candidates] of [
      ["balanced", [{ url: "https://balanced.test/a", rank: 1 }, { url: "https://balanced.test/b", rank: 2 }]],
      ["explore", [{ url: "https://explore.test/a", rank: 1 }]]
    ]) {
      const impressionId = `options-test-${arm}`;
      outcomes.push(await send({ action: "recordHomeRecommendationImpression", impressionId, arm, candidates }));
      outcomes.push(await send({ action: "recordHomeRecommendationChoice", impressionId, ...candidates[0] }));
    }
    return { outcomes, response: await send({ action: "getHomeRecommendationDiagnostics" }) };
  });
  expect(results.outcomes.every(result => result.success && result.recorded)).toBe(true);
  expect(results.response.success).toBe(true);
  expect(results.response.summary.cohort).toBe("home-recs-v3");
  expect(results.response.summary.arms.balanced).toMatchObject({ impressions: 1, exposures: 2, clicks: 1, engaged: 0, bounces: 0 });
  expect(results.response.summary.arms.explore).toMatchObject({ impressions: 1, exposures: 1, clicks: 1, engaged: 0, bounces: 0 });

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#homeRecommendationReport")).toHaveText("2 recommendation sets observed across 1 of the last 28 days.");
  const policies = page.locator("#homeRecommendationPolicies .model-card");
  await expect(policies).toHaveCount(2);
  await expect(policies.nth(0).locator("dd")).toHaveText(["1", "2", "1", "0", "0", "0"]);
  await expect(policies.nth(1).locator("dd")).toHaveText(["1", "1", "1", "0", "0", "0"]);
  await expect(page.locator("#homeContextReport")).toContainText("0 displays");

  await page.setViewportSize({ width: 390, height: 844 });
  const geometry = await page.evaluate(() => {
    const help = document.querySelector(".recommendation-report .field-hint");
    const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
      value /= 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const foreground = luminance(getComputedStyle(help).color);
    const background = luminance(getComputedStyle(help.closest(".report-panel")).backgroundColor);
    return {
      scroll: document.documentElement.scrollWidth, viewport: innerWidth,
      saveHeight: document.getElementById("saveRecommendationPreferences").getBoundingClientRect().height,
      checkboxTargetHeight: document.querySelector(".recommendation-checkbox").getBoundingClientRect().height,
      fontSize: parseFloat(getComputedStyle(help).fontSize),
      contrast: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05)
    };
  });
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.saveHeight).toBeGreaterThanOrEqual(44);
  expect(geometry.checkboxTargetHeight).toBeGreaterThanOrEqual(44);
  expect(geometry.fontSize).toBeGreaterThanOrEqual(16);
  expect(geometry.contrast).toBeGreaterThanOrEqual(8);
  await page.locator("#home-recommendation-title").evaluate(node => node.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: "/tmp/histospire-recommendation-report-mobile.png" });

  await expect(page.locator("#diagnosticsEnabled")).toBeChecked();
  await page.locator("#diagnosticsEnabled").focus();
  await page.locator("#diagnosticsEnabled").press("Space");
  await expect(page.locator("#homeRecommendationReport")).toHaveText("Diagnostics are off. No recommendation outcomes are recorded.");
  await expect(policies).toHaveCount(0);
  const disabled = await page.evaluate(async () => chrome.runtime.sendMessage({ action: "getHomeRecommendationDiagnostics" }));
  expect(disabled.summary.enabled).toBe(false);
  expect(disabled.summary.arms.balanced.exposures).toBe(0);
  expect(disabled.summary.arms.explore.exposures).toBe(0);
});
