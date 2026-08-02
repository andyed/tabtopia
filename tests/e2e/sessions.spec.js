const { test, expect } = require("./fixtures");

async function openSessionsApp(context, server) {
  const tabs = [];
  for (const slug of ["/alpha", "/beta", "/gamma"]) {
    const tab = await context.newPage();
    await tab.goto(server + slug, { waitUntil: "load" });
    tabs.push(tab);
  }

  const nt = await context.newPage();
  await nt.goto("chrome://newtab/", { waitUntil: "domcontentloaded" });
  
  // Click the sessions icon
  await nt.locator("a[href='sessions.html']").click();
  await expect(nt).toHaveURL(/.*sessions\.html/);

  return { nt, tabs };
}

test.describe("sessions view", () => {
  test("renders timeline and session cards", async ({ context, server }) => {
    const { nt } = await openSessionsApp(context, server);

    // Wait for the milestones and cards to render
    const milestones = nt.locator(".date-milestone");
    const cardsRow = nt.locator(".sessions-cards-row");
    
    // There should be at least "Today" or one date milestone
    await expect(milestones).not.toHaveCount(0);
    await expect(cardsRow).not.toHaveCount(0);

    // Check that there is at least one session card inside the row
    const firstCardRow = cardsRow.first();
    const sessionCards = firstCardRow.locator(".session-card");
    
    // We expect our session to be tracked
    await expect(sessionCards).not.toHaveCount(0);
  });

  test("uses the global recall SERP instead of limiting search to recent sessions", async ({ context, server }) => {
    const { nt } = await openSessionsApp(context, server);
    await nt.evaluate(async baseUrl => {
      await chrome.bookmarks.create({ title: "Sessions external field guide one", url: `${baseUrl}/field-guide-one` });
      await chrome.bookmarks.create({ title: "Sessions external field guide two", url: `${baseUrl}/field-guide-two` });
    }, server);
    await nt.reload({ waitUntil: "domcontentloaded" });

    const input = nt.locator("#sessionSearch");
    await input.fill("external field guide");
    const results = nt.locator("#startPageSearch .search-serp__result-link");
    await expect(results).toHaveCount(2);
    await expect(results.nth(0).locator(".search-serp__token--saved")).toContainText("Saved");
    await expect(nt.locator("#sessions-container")).toBeHidden();

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
    await expect(input).toBeFocused();
    await expect(nt.locator("#startPageSearch")).toBeHidden();
    await expect(nt.locator("#sessions-container")).toBeVisible();
  });
});
