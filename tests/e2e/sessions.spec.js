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
});
