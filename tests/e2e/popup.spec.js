const { test, expect } = require("./fixtures");

test.describe("popup search", () => {
  test("uses Up and Down to traverse filtered tabs in result order", async ({ context, extensionId, server }) => {
    for (const slug of ["/alpha", "/beta"]) {
      const tab = await context.newPage();
      await tab.goto(server + slug, { waitUntil: "load" });
    }

    const popup = await context.newPage();
    await popup.goto(
      `chrome-extension://${extensionId}/src/newtab/popup.html`,
      { waitUntil: "domcontentloaded" }
    );

    const input = popup.locator("#popupSearch");
    await expect.poll(() => popup.evaluate(() =>
      [...document.querySelectorAll(".cell")].filter(cell =>
        window.d3.select(cell).datum()?.data?.title?.endsWith(" Page")
      ).length
    )).toBe(2);
    await input.fill("Page");

    await input.press("ArrowDown");
    const firstTitle = await focusedTabTitle(popup);
    expect(firstTitle).toMatch(/^(Alpha|Beta) Page$/);

    await popup.locator(".cell:focus").press("ArrowDown");
    const lastTitle = await focusedTabTitle(popup);
    expect(lastTitle).toMatch(/^(Alpha|Beta) Page$/);
    expect(lastTitle).not.toBe(firstTitle);

    await popup.locator(".cell:focus").press("ArrowDown");
    await expect.poll(() => focusedTabTitle(popup)).toBe(firstTitle);
    await popup.locator(".cell:focus").press("ArrowUp");
    await expect.poll(() => focusedTabTitle(popup)).toBe(lastTitle);

    await input.focus();
    await input.press("ArrowUp");
    await expect.poll(() => focusedTabTitle(popup)).toBe(lastTitle);
  });
});

function focusedTabTitle(page) {
  return page.evaluate(() => {
    const datum = window.d3?.select(document.activeElement).datum();
    return datum?.data?.title || "";
  });
}
