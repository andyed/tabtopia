const { test, expect } = require("./fixtures");

async function prepare(context, extensionId, urls) {
  await context.route('http://127.0.0.1:8889/**', route => route.fulfill({ json: { items: [], results: [], status: 'empty' } }));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await page.evaluate(async urls => chrome.storage.local.set({ tabtopiaFrequentPreferencesV1: { pins: urls.map(url => ({ url })) } }), urls);
  await page.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/home`);
  await expect(page.locator('#startPageHome')).toHaveAttribute('aria-busy', 'false');
  return page;
}
const tile = page => page.locator('.frequent-bank__tile').first();
const panel = page => page.locator('.frequent-bank__panel');

test('zero tabs opens the exact preferred URL in place; one tab switches without duplication', async ({ context, extensionId, server }) => {
  const page = await prepare(context, extensionId, [server + '/alpha#inbox']);
  await expect(tile(page)).toHaveAttribute('aria-label', /0 open tabs, open destination/);
  const initial = context.pages().length;
  await tile(page).click();
  await expect(page).toHaveURL(server + '/alpha#inbox');
  expect(context.pages().length).toBe(initial);
  const home = await context.newPage();
  await home.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/home`);
  await expect(tile(home)).toHaveAttribute('aria-label', /1 open tab, switch/);
  await tile(home).click();
  await expect.poll(() => home.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].url)).toBe(server + '/alpha#inbox');
  expect(context.pages().length).toBe(initial + 1);
});

test('multiple instances support keyboard selection, live closure and focus recovery', async ({ context, extensionId, server }) => {
  const alpha = await context.newPage(); await alpha.goto(server + '/alpha');
  const beta = await context.newPage(); await beta.goto(server + '/beta');
  const page = await prepare(context, extensionId, [server + '/alpha']);
  await expect(tile(page)).toHaveAttribute('aria-label', /2 open tabs, choose tab/);
  await tile(page).focus(); await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
  const row = panel(page).getByRole('button', { name: 'Beta Page', exact: true });
  await row.focus();
  await page.evaluate(() => window.tabtopiaStartPageRecognition.refresh());
  await expect(row).toBeFocused();
  await beta.close();
  await expect(tile(page)).toHaveAttribute('aria-label', /1 open tab/);
  await expect(panel(page).getByRole('button', { name: 'Alpha Page', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel(page)).not.toBeVisible();
  await expect(tile(page)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('button', { name: 'Alpha Page', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].url)).toBe(server + '/alpha');
});

test('management saves a preferred URL, hides and restores destinations', async ({ context, extensionId, server }) => {
  const page = await prepare(context, extensionId, [server + '/alpha']);
  await page.getByRole('button', { name: 'Edit frequent destinations', exact: true }).click();
  await panel(page).getByRole('button', { name: `Edit ${new URL(server).host}`, exact: true }).click();
  await panel(page).getByLabel('Opening URL').fill('https://different.example.test/');
  await panel(page).getByRole('button', { name: 'Save URL' }).click();
  await expect(panel(page)).toContainText('must belong');
  await panel(page).getByLabel('Opening URL').fill(server + '/beta#saved');
  await panel(page).getByRole('button', { name: 'Save URL' }).click();
  await expect.poll(() => page.evaluate(async () => (await chrome.storage.local.get('tabtopiaFrequentPreferencesV1')).tabtopiaFrequentPreferencesV1.urls)).toEqual({ [new URL(server).host]: server + '/beta#saved' });
  await panel(page).getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(page.locator('.frequent-bank__tile')).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: /Restore / })).toBeVisible();
  await panel(page).getByRole('button', { name: /Restore / }).click();
  await expect(page.locator('.frequent-bank__tile')).toHaveCount(1);
});

test('eight destinations, fallback icons and flyout fit a narrow viewport', async ({ context, extensionId, server }) => {
  const urls = [server + '/alpha', ...Array.from({ length: 7 }, (_, i) => `https://site${i}.example.test/`)];
  const page = await prepare(context, extensionId, urls);
  await page.setViewportSize({ width: 390, height: 844 });
  await tile(page).focus(); await page.keyboard.press('ArrowDown');
  await expect(panel(page)).toBeVisible();
  await page.locator('.frequent-bank__favicon').evaluateAll(images => images.forEach(image => image.dispatchEvent(new Event('error'))));
  expect(await page.locator('.frequent-bank__favicon').evaluateAll(images => images.every(image => image.src.startsWith('data:image/svg+xml')))).toBe(true);
  const geometry = await panel(page).evaluate(node => {
    const r = node.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollWidth };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.top).toBeGreaterThanOrEqual(0); expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
  await page.screenshot({ path: '/tmp/tabtopia-frequent-mobile.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: '/tmp/tabtopia-frequent-desktop.png', fullPage: true });
});

test('duplicate URLs in separate windows stay distinct and switching focuses the chosen window', async ({ context, extensionId, server }) => {
  const alpha = await context.newPage(); await alpha.goto(server + '/alpha');
  const page = await prepare(context, extensionId, [server + '/alpha']);
  const other = await page.evaluate(async url => {
    const window = await chrome.windows.create({ url, focused: false });
    return { id: window.id, tabId: window.tabs[0].id };
  }, server + '/alpha');
  try {
    await expect(tile(page)).toHaveAttribute('aria-label', /2 open tabs/);
    await tile(page).click();
    await expect(panel(page).getByText('This window', { exact: true })).toBeVisible();
    await expect(panel(page).getByText(`Window ${other.id}`, { exact: true })).toBeVisible();
    await expect(panel(page).locator('[data-tab-row]')).toHaveCount(2);
    await page.screenshot({ path: '/tmp/tabtopia-frequent-tabs.png' });
    await panel(page).locator(`[data-frequent-focus="tab:${other.tabId}"]`).click();
    await expect.poll(() => page.evaluate(async () => (await chrome.windows.getLastFocused()).id)).toBe(other.id);
  } finally { await page.evaluate(id => chrome.windows.remove(id), other.id); }
});

test('outside dismissal stays dismissed after refresh; an open panel repositions on resize', async ({ context, extensionId, server }) => {
  const page = await prepare(context, extensionId, [server + '/alpha']);
  await page.getByRole('button', { name: 'Edit frequent destinations', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 600 });
  await expect.poll(() => panel(page).evaluate(node => node.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await page.locator('.frequent-bank__label').click();
  await expect(panel(page)).not.toBeVisible();
  await page.evaluate(() => window.tabtopiaStartPageRecognition.refresh());
  await expect(panel(page)).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Edit frequent destinations", exact: true })).toHaveAttribute("aria-expanded", "false");
});
