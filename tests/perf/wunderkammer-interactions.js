// CPU and input measurements after image settlement. Headless presentation
// timings are diagnostic only, not the user's GPU/frame-rate experience.
const round = n => Math.round(n * 10) / 10;
async function measureInteractions(page, frame, cdp) {
  const rows = [];
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  async function measure(name, action) {
    await frame.evaluate(() => { window.__cwPerf.reset(); window.__bootLong.length = 0; });
    const before = await metrics(), start = Date.now();
    await action();
    // Include debounced search and presentation before checking final pixels.
    await page.waitForTimeout(450);
    const still = await frame.evaluate(async () => {
      try { await window.wunderkammer.whenStill({ timeout: 10000 }); return true; }
      catch { return false; }
    });
    const after = await metrics();
    const app = await frame.evaluate(() => {
      const p = window.__cwPerf.snapshot();
      return { spans: p.spans, counters: p.counters, gauges: p.gauges,
        longTasks: window.__bootLong.length, longestTaskMs: Math.max(0, ...window.__bootLong.map(e => e.ms)),
        eventCount: p.interactions.n, inputToPaintMs: p.interactions.inp,
        inputBlockMs: Math.max(0, ...p.interactions.worst.map(e => e.delayMs + e.processMs)) };
    });
    const row = { name, settled: still, scenarioMs: Date.now() - start,
      scriptMs: round((after.ScriptDuration - before.ScriptDuration) * 1000),
      layoutMs: round((after.LayoutDuration - before.LayoutDuration) * 1000),
      styleMs: round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000), ...app };
    rows.push(row);
    console.log(JSON.stringify({ interaction: name, settled: still, scriptMs: row.scriptMs, layoutMs: row.layoutMs,
      eventCount: row.eventCount, inputBlockMs: row.inputBlockMs, inputToPaintMs: row.inputToPaintMs, longestTaskMs: row.longestTaskMs }));
  }
  const box = await frame.locator('#stage').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await measure('idle 1s', () => page.waitForTimeout(1000));
  await measure('pan 30 wheel ticks', async () => {
    for (let i = 0; i < 30; i++) { await page.mouse.wheel(i < 15 ? 12 : -12, i < 15 ? 8 : -8); await page.waitForTimeout(16); }
  });
  await measure('zoom in 12 ticks', async () => {
    await page.keyboard.down('Control');
    try { for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -30); await page.waitForTimeout(16); } }
    finally { await page.keyboard.up('Control'); }
  });
  await measure('fit', () => frame.locator('#zoom-fit').click());
  await measure('search type', async () => {
    await frame.locator('#search').click();
    await page.keyboard.type('Image 1', { delay: 100 });
  });
  await measure('search clear', async () => {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
  });
  const current = await frame.locator('#group').inputValue();
  const other = await frame.locator('#group option').evaluateAll((options, current) => options.find(o => o.value !== current)?.value, current);
  if (other !== undefined) {
    await measure('regroup', () => frame.locator('#group').selectOption(other));
    await measure('restore groups', () => frame.locator('#group').selectOption(current));
  }
  const tile = frame.locator('#canvas > .tile').first();
  await measure('detail open by keyboard', async () => {
    await tile.focus(); await tile.press('Enter');
    await frame.locator('#detail.open').waitFor();
  });
  await measure('detail close', () => page.keyboard.press('Escape'));
  return rows;
}
module.exports = { measureInteractions };
