const { test, expect } = require("./fixtures");

const CELL = (title) => `#treemap .cell[aria-label="${title}"]`;

async function openApp(context, server) {
  const tabs = [];
  for (const slug of ["/alpha", "/beta", "/gamma"]) {
    const tab = await context.newPage();
    await tab.goto(server + slug, { waitUntil: "load" });
    tabs.push(tab);
  }

  const nt = await context.newPage();
  await nt.goto("chrome://newtab/", { waitUntil: "domcontentloaded" });

  await expect(nt.locator(CELL("Alpha Page"))).toHaveCount(1);
  await expect(nt.locator(CELL("Beta Page"))).toHaveCount(1);
  await expect(nt.locator(CELL("Gamma Page"))).toHaveCount(1);
  return { nt, tabs };
}

test.describe("fuzzy search", () => {
  test("filters treemap cells and supports keyboard navigation", async ({ context, server }) => {
    const { nt } = await openApp(context, server);

    const searchInput = nt.locator("#tabSearch");
    const alpha = nt.locator(CELL("Alpha Page"));
    const beta = nt.locator(CELL("Beta Page"));

    // Type into search
    await searchInput.fill("Alpha");

    // Wait for the debounce and transition (200ms debounce + some rendering time)
    await expect(alpha).toHaveClass(/cell-search-match/);
    await expect(beta).toHaveClass(/cell-search-nomatch/);
    
    // Check opacity
    await expect(alpha).toHaveCSS("opacity", "1");
    await expect(beta).toHaveCSS("opacity", "0.3");

    // Press ArrowDown to select the first match
    await searchInput.press("ArrowDown");
    await expect(alpha).toHaveClass(/cell-selected/);

    // Press Escape to clear
    await searchInput.press("Escape");
    await expect(searchInput).toHaveValue("");
    
    // Classes should be cleared
    await expect(alpha).not.toHaveClass(/cell-search-match/);
    await expect(beta).not.toHaveClass(/cell-search-nomatch/);
    await expect(alpha).toHaveCSS("opacity", "1");
    await expect(beta).toHaveCSS("opacity", "1");
  });
});
