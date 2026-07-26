const { test, expect } = require("./fixtures");

test.describe("development start-page recognition", () => {
  test("classifies the live window after the treemap remains usable", async ({ context, extensionId, server }) => {
    for (const slug of ["/alpha", "/beta"]) {
      const tab = await context.newPage();
      await tab.goto(server + slug, { waitUntil: "load" });
      await tab.bringToFront();
      // RevisitStore intentionally ignores navigations that do not retain
      // focus. Let each fixture page cross the same two-second qualification
      // boundary used in production.
      await tab.waitForTimeout(2200);
    }

    const newtab = await context.newPage();
    await newtab.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/treemap`, {
      waitUntil: "domcontentloaded"
    });

    await expect(newtab.locator('#treemap .cell[aria-label="Alpha Page"]')).toBeVisible();
    const inspector = newtab.locator("#startPageStateInspector");
    await expect(inspector).toHaveAttribute("data-state", "continuation");
    await expect(inspector.getByText("Continuation", { exact: true })).toBeVisible();
    await expect(inspector.getByRole("heading", { name: "Connected work" })).toBeVisible();
    await expect(inspector.locator(".neighborhood-preview__item").first()).toBeVisible();

    const audit = inspector.locator(".neighborhood-audit");
    await audit.locator(":scope > summary").click();
    await expect(audit.getByText("Components", { exact: true })).toBeVisible();
    await expect(audit.getByText("Isolates", { exact: true })).toBeVisible();
    await expect(audit.getByText("Largest", { exact: true })).toBeVisible();
    const connectedComponent = audit.locator(".neighborhood-audit__component:has(.neighborhood-audit__reasons)").first();
    await connectedComponent.locator(":scope > summary").click();
    await expect(connectedComponent
      .getByText("Beta Page opened from Alpha Page", { exact: true })
      .first()).toBeVisible();

    const debugState = await newtab.evaluate(() => ({
      state: window.tabtopiaStartPageRecognition?.recognition?.state,
      evidence: window.tabtopiaStartPageRecognition?.recognition?.evidence,
      titles: window.tabtopiaStartPageRecognition?.snapshot?.currentWindow?.tabs?.map(tab => tab.title),
      neighborhoods: window.tabtopiaStartPageRecognition?.snapshot?.neighborhoods
    }));
    expect(debugState.state).toBe("continuation");
    expect(debugState.evidence.length).toBeGreaterThanOrEqual(2);
    expect(debugState.titles).toEqual(expect.arrayContaining(["Alpha Page", "Beta Page"]));
    expect(debugState.titles).not.toContain("tabtopia");
    expect(debugState.neighborhoods.length).toBeGreaterThan(0);
    expect(debugState.neighborhoods.every(item => item.kind === "connected-component")).toBe(true);
    expect(debugState.neighborhoods
      .flatMap(item => item.edges)
      .flatMap(edge => edge.evidence)
      .every(item => item.sourceKey && item.targetKey && item.origin)).toBe(true);

    await expect(inspector.getByRole("heading", { name: "Habit destinations" })).toBeVisible();
    const habitDestinations = await newtab.evaluate(() =>
      window.tabtopiaStartPageRecognition?.habitDestinations);
    expect(habitDestinations.source).toBe("qualified-history");
    expect(habitDestinations.candidates.length).toBeGreaterThan(0);
    expect(habitDestinations.candidates.every(candidate => candidate.cues.context === 0)).toBe(true);
    expect(habitDestinations.candidates.every(candidate =>
      candidate.reasons.includes("session coupling excluded from this score"))).toBe(true);

    await expect(inspector.getByRole("heading", { name: "Likely to resume" })).toBeVisible();
    const forecast = await newtab.evaluate(() =>
      (window.tabtopiaStartPageRecognition?.forecast?.candidates || []).map(candidate => ({
        verb: candidate.action.verb,
        title: candidate.action.target?.title,
        score: candidate.score,
        confidence: candidate.confidence,
        reasons: candidate.reasons.length
      })));
    expect(forecast.length).toBeGreaterThan(0);
    expect(forecast.every(candidate => candidate.score >= 0 && candidate.score <= 1)).toBe(true);
    expect(forecast.every(candidate => candidate.confidence <= 0.9)).toBe(true);
    expect(forecast.every(candidate => candidate.reasons > 0)).toBe(true);
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
    await newtab.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/treemap`, {
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
    expect(debugState.evidence).toEqual(expect.arrayContaining([
      expect.stringMatching(/extended-interruption|crossed-local-day-boundary/)
    ]));
  });
});
