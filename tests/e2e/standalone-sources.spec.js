const { test, expect } = require("./fixtures");

test("Home and recall make no requests to the removed supplemental service", async ({ context, extensionId }) => {
  const requests = [];
  await context.route("http://127.0.0.1:8889/**", route => {
    requests.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/home`);
  await expect(page.locator("#startPageHome")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async () => {
    await window.tabtopiaStartPageRecognition.refresh();
    const { loadRecallSearchSources } = await import("./recall-search-sources.js");
    await loadRecallSearchSources();
    const { refreshArchive } = await import("../lib/archive-provider.js");
    const { refreshGithubStars } = await import("../lib/github-stars-provider.js");
    const { refreshRecentContext } = await import("../lib/recent-context-provider.js");
    await Promise.all([refreshArchive({ query: "Private browsing title", force: true }),
      refreshGithubStars({ force: true }), refreshRecentContext()]);
  });
  expect(requests).toEqual([]);
  await expect(page.getByRole("button", { name: "All tabs", exact: true })).toBeVisible();
});
