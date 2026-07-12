// Playwright E2E config for the Tabtopia newtab UI.
//
// These tests load the *real, unpacked* extension into Chrome (channel: 'chrome',
// see tests/e2e/fixtures.js) and drive the treemap with genuine mouse hover/click,
// so they catch the interaction regressions that reading the code alone kept
// missing (hover preview, click-to-pin, switching the pinned cell).
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  // Each test launches its own extension-loaded Chrome (a persistent context).
  // Running them in parallel would spawn several Chromes at once and race on the
  // shared profile dir semantics — keep it serial and predictable.
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  // displayReadout() awaits chrome.bookmarks/history lookups before it paints,
  // and the treemap repaints on favicon/tab churn — give assertions room to retry.
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  retries: process.env.CI ? 1 : 0,
});
