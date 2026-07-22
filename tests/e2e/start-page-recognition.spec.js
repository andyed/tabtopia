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

  test("distinguishes an extended return from after-lunch reinstatement", async ({ context, extensionId, server }) => {
    await context.addInitScript(({ offsetMs }) => {
      const NativeDate = Date;
      const shiftedNow = NativeDate.now() + offsetMs;
      function ShiftedDate(...args) {
        if (!new.target) return new NativeDate(shiftedNow).toString();
        return args.length === 0 ? new NativeDate(shiftedNow) : new NativeDate(...args);
      }
      ShiftedDate.prototype = NativeDate.prototype;
      Object.setPrototypeOf(ShiftedDate, NativeDate);
      ShiftedDate.now = () => shiftedNow;
      ShiftedDate.parse = NativeDate.parse;
      ShiftedDate.UTC = NativeDate.UTC;
      globalThis.Date = ShiftedDate;
    }, { offsetMs: 8 * 60 * 60 * 1000 });

    const newtab = await context.newPage();
    await newtab.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html`, {
      waitUntil: "domcontentloaded"
    });
    await newtab.evaluate(url => new Promise((resolve, reject) => {
      chrome.windows.create({ url, focused: false }, window => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(window?.id);
      });
    }), server + "/alpha");

    const inspector = newtab.locator("#startPageStateInspector");
    await expect(inspector).toHaveAttribute("data-state", "reorientation");
    await expect(inspector.getByText("Reorientation", { exact: true })).toBeVisible();
    await expect(inspector.getByText("8h", { exact: true })).toBeVisible();

    const debugState = await newtab.evaluate(() => window.tabtopiaStartPageRecognition?.recognition);
    expect(debugState.state).toBe("reorientation");
    expect(debugState.signals.gapMs).toBeGreaterThan(7.9 * 60 * 60 * 1000);
    expect(debugState.evidence).toContain("extended-interruption");
  });
});
