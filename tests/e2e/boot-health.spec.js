// Boot-health canary: every view must come up with ZERO uncaught page errors.
//
// This is the cheapest possible net for the "one bad datum aborts the whole
// render" class of bug — e.g. the titleless restored-tab entry that threw in
// formatTitle inside drawTreemap and left the newtab blank. Views are loaded
// directly via their chrome-extension:// URLs (the extensionId fixture), with
// a couple of real fixture tabs open so render paths actually execute.
const { test, expect } = require("./fixtures");

const VIEWS = [
  "src/newtab/newtab.html",
  "src/newtab/graph.html",
  "src/newtab/sessions.html",
  "src/newtab/stars.html",
  "src/newtab/popup.html",
];

test.describe("boot health", () => {
  test("every view boots with zero uncaught page errors", async ({ context, extensionId, server }) => {
    // Open real tabs first so treemap/graph/sessions have data to render.
    for (const slug of ["/alpha", "/beta"]) {
      const tab = await context.newPage();
      await tab.goto(server + slug, { waitUntil: "load" });
    }

    const failures = [];
    for (const view of VIEWS) {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (err) => errors.push(String(err && err.message || err)));
      await page.goto(`chrome-extension://${extensionId}/${view}`, { waitUntil: "domcontentloaded" });
      // Give async init (storage reads, history queries, first paint) time to
      // run — the interesting crashes all happen after DOMContentLoaded.
      await page.waitForTimeout(2500);
      if (errors.length) {
        failures.push(`${view}:\n  ${errors.join("\n  ")}`);
      }
      await page.close();
    }

    expect(failures, failures.join("\n\n")).toEqual([]);
  });
});
