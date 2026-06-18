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
});
