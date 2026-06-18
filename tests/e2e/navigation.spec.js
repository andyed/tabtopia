const { test, expect } = require("./fixtures");

async function openApp(context, server) {
  const tabs = [];
  for (const slug of ["/alpha", "/beta", "/gamma"]) {
    const tab = await context.newPage();
    await tab.goto(server + slug, { waitUntil: "load" });
    tabs.push(tab);
  }

  const nt = await context.newPage();
  await nt.goto("chrome://newtab/", { waitUntil: "domcontentloaded" });
  return { nt, tabs };
}

test.describe("navigation routing", () => {
  test("header icons correctly switch views", async ({ context, server }) => {
    const { nt } = await openApp(context, server);

    // Initial view should be treemap (newtab.html)
    await expect(nt.locator(".view-toggle a.active")).toHaveAttribute("href", "newtab.html");

    // Click Graph view
    await nt.locator("a[href='graph.html']").click();
    await expect(nt).toHaveURL(/.*graph\.html/);

    // Click Sessions view
    await nt.locator("a[href='sessions.html']").click();
    await expect(nt).toHaveURL(/.*sessions\.html/);

    // Click Stars view
    await nt.locator("a[href='stars.html']").click();
    await expect(nt).toHaveURL(/.*stars\.html/);

    // Go back to Treemap view
    await nt.locator("a[href='newtab.html']").click();
    await expect(nt).toHaveURL(/.*newtab\.html/);
    await expect(nt.locator(".view-toggle a.active")).toHaveAttribute("href", "newtab.html");
  });
});
