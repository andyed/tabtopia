const { test, expect } = require("./fixtures");

async function openGraphApp(context, server) {
  const tabs = [];
  for (const slug of ["/alpha", "/beta", "/gamma"]) {
    const tab = await context.newPage();
    await tab.goto(server + slug, { waitUntil: "load" });
    tabs.push(tab);
  }

  const nt = await context.newPage();
  await nt.goto("chrome://newtab/", { waitUntil: "domcontentloaded" });
  
  // Click the graph icon
  await nt.locator("a[href='graph.html']").click();
  await expect(nt).toHaveURL(/.*graph\.html/);

  return { nt, tabs };
}

test.describe("graph rendering", () => {
  test("renders graph nodes for open tabs", async ({ context, server }) => {
    const { nt } = await openGraphApp(context, server);

    // Wait for D3 graph nodes to render
    // Depending on the DOM structure, we look for SVG circle/g elements with class "node"
    const nodes = nt.locator(".node");
    
    // We expect 4 tabs (alpha, beta, gamma, and the graph tab itself)
    await expect(nodes).toHaveCount(4);
    
    // Hover over a node (Alpha)
    const alphaNode = nodes.nth(0);
    await alphaNode.hover();
    
    // We can verify that hovering works (no crashes) and potentially check for a tooltip
    // For now just basic assertions that the graph renders without throwing
    await expect(alphaNode).toBeVisible();
  });

  test("uses the global recall SERP and Escape returns to the graph", async ({ context, server }) => {
    const { nt } = await openGraphApp(context, server);
    await nt.evaluate(async baseUrl => {
      await chrome.bookmarks.create({ title: "Graph saved atlas one", url: `${baseUrl}/graph-atlas-one` });
      await chrome.bookmarks.create({ title: "Graph saved atlas two", url: `${baseUrl}/graph-atlas-two` });
    }, server);
    await nt.reload({ waitUntil: "domcontentloaded" });

    const input = nt.locator("#tabSearch");
    await input.fill("saved atlas");
    const results = nt.locator("#startPageSearch .search-serp__result-link");
    await expect(results).toHaveCount(2);
    await expect(nt.locator("#graph")).toBeHidden();

    await input.press("ArrowDown");
    await expect(results.nth(0)).toBeFocused();
    await results.nth(0).press("ArrowDown");
    await expect(results.nth(1)).toBeFocused();
    await input.focus();
    await input.press("ArrowUp");
    await expect(results.nth(1)).toBeFocused();
    await results.nth(1).press("ArrowDown");
    await expect(results.nth(0)).toBeFocused();

    await results.nth(0).press("Escape");
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await expect(nt.locator("#startPageSearch")).toBeHidden();
    await expect(nt.locator("#graph")).toBeVisible();
  });
});
