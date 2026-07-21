const { test, expect } = require("./fixtures");

test.describe("development start-page recognition", () => {
  test("classifies the live window after the treemap remains usable", async ({ context, extensionId, server }) => {
    for (const slug of ["/alpha", "/beta"]) {
      const tab = await context.newPage();
      await tab.goto(server + slug, { waitUntil: "load" });
    }

    const newtab = await context.newPage();
    await newtab.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html`, {
      waitUntil: "domcontentloaded"
    });

    await expect(newtab.locator('#treemap .cell[aria-label="Alpha Page"]')).toBeVisible();
    const inspector = newtab.locator("#startPageStateInspector");
    await expect(inspector).toHaveAttribute("data-state", "continuation");
    await expect(inspector.getByText("Continuation", { exact: true })).toBeVisible();

    const debugState = await newtab.evaluate(() => ({
      state: window.tabtopiaStartPageRecognition?.recognition?.state,
      evidence: window.tabtopiaStartPageRecognition?.recognition?.evidence,
      titles: window.tabtopiaStartPageRecognition?.snapshot?.currentWindow?.tabs?.map(tab => tab.title)
    }));
    expect(debugState.state).toBe("continuation");
    expect(debugState.evidence.length).toBeGreaterThanOrEqual(2);
    expect(debugState.titles).toEqual(expect.arrayContaining(["Alpha Page", "Beta Page"]));
    expect(debugState.titles).not.toContain("tabtopia");
  });
});
