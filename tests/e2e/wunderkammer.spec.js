const { test, expect } = require('./fixtures');
function fixture(server, count) {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`${server}/alpha#image-${i}`, {
    timestamp: 1700000000000 + i, title: i === 0 ? '<img src=x onerror=alert(1)> Fixture' : `Hero ${i}`,
    images: [{ src: `${server}/hero-${i}.svg`, width: 600, height: 400 }]
  }]));
}
async function seed(context, extensionId, server, count) {
  await context.route('**/hero-*.svg', route => route.fulfill({ contentType: 'image/svg+xml', headers: { 'Access-Control-Allow-Origin': '*' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#46685b"/><circle cx="300" cy="200" r="130" fill="#9ff7d2"/></svg>' }));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await page.evaluate(store => chrome.storage.local.set({ heroImages: store }), fixture(server, count));
  return page;
}
const nav = page => page.locator('.hero-navigation');
const wall = page => page.frameLocator('#hero-viewer iframe');
async function settled(page) {
  const frame = page.frames().find(frame => frame.url().includes('/vendor/wunderkammer/index.html'));
  await frame.evaluate(() => window.wunderkammer.whenStill());
  const covers = await frame.evaluate(() => [...document.querySelectorAll('.tile > img')].filter(img => {
    const r = img.getBoundingClientRect();
    return r.width && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight && getComputedStyle(img.parentElement).visibility !== 'hidden' && !img.parentElement.classList.contains('broken');
  }).map(img => img.complete && img.naturalWidth > 0));
  expect(covers.length).toBeGreaterThan(0);
  expect(covers.every(Boolean)).toBe(true);
}

test('navigation follows 20/21 distinct eligible images and never fetches covers on Home', async ({ context, extensionId, server }) => {
  const page = await seed(context, extensionId, server, 20);
  const requests = [];
  page.on('request', request => { if (/hero-\d+\.svg/.test(request.url())) requests.push(request.url()); });
  await page.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/home`);
  await expect(page.locator('#startPageHome')).toHaveAttribute('aria-busy', 'false');
  await expect(nav(page)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const before = await page.locator('#tabSearch').boundingBox();
  await page.evaluate(store => chrome.storage.local.set({ heroImages: store }), fixture(server, 21));
  await expect(nav(page)).toBeVisible();
  await expect(nav(page)).toHaveAttribute('href', 'wunderkammer.html');
  expect(requests).toEqual([]);
  expect(await page.locator('#tabSearch').boundingBox()).toEqual(before);
  const navBox = await nav(page).boundingBox();
  expect(navBox.x + navBox.width).toBeLessThanOrEqual(390);
  expect(before.width).toBeGreaterThanOrEqual(100);
  const duplicates = fixture(server, 20);
  duplicates[server + '/beta'] = { images: [{ src: server + '/hero-0.svg', width: 600, height: 400 }] };
  await page.evaluate(store => chrome.storage.local.set({ heroImages: store }), duplicates);
  await expect(nav(page)).toHaveCount(0);
});

test('bundled viewer shows local collection, escapes titles, and uses native source links', async ({ context, extensionId, server }) => {
  const page = await seed(context, extensionId, server, 21);
  const scripts = [], errors = [];
  page.on('request', request => { if (request.resourceType() === 'script') scripts.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/src/newtab/wunderkammer.html`);
  await expect(page.locator('#hero-main')).toHaveAttribute('aria-busy', 'false');
  await expect(wall(page).locator('body')).toHaveAttribute('data-view-ready', 'true');
  await expect(wall(page).locator('#count')).toContainText('21');
  const tile = wall(page).getByRole('button', { name: '<img src=x onerror=alert(1)> Fixture', exact: true }).first();
  await tile.focus(); await tile.press('Enter');
  await expect(wall(page).locator('#detail')).toContainText('<img src=x onerror=alert(1)> Fixture');
  expect(await wall(page).locator('#detail img[onerror]').count()).toBe(0);
  const link = wall(page).locator('#detail a').filter({ hasText: new URL(server).hostname }).first();
  await expect(link).toHaveAttribute('href', server + '/alpha#image-0');
  const opened = context.waitForEvent('page');
  await link.click({ button: 'middle' });
  const destination = await opened; await expect(destination).toHaveURL(server + '/alpha#image-0'); await destination.close();
  expect(scripts.every(url => url.startsWith(`chrome-extension://${extensionId}/`))).toBe(true);
  expect(errors).toEqual([]);
  await settled(page);
  await page.screenshot({ path: '/tmp/tabtopia-wunderkammer-desktop.png', animations: 'disabled' });
});

test('open gallery falls below threshold cleanly; additions wait for explicit refresh', async ({ context, extensionId, server }) => {
  const page = await seed(context, extensionId, server, 21);
  await page.goto(`chrome-extension://${extensionId}/src/newtab/wunderkammer.html`);
  await expect(wall(page).locator('body')).toHaveAttribute('data-view-ready', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(store => chrome.storage.local.set({ heroImages: store }), fixture(server, 22));
  await expect(page.getByRole('button', { name: 'Refresh images' })).toBeVisible();
  await expect(wall(page).locator('#count')).toContainText('21');
  await page.getByRole('button', { name: 'Refresh images' }).click();
  await expect(wall(page).locator('#count')).toContainText('22');
  await page.evaluate(store => chrome.storage.local.set({ heroImages: store }), fixture(server, 20));
  await expect(page.locator('#hero-viewer')).toBeHidden();
  await expect(page.locator('#hero-status')).toContainText('You have 20');
  await expect(nav(page)).toHaveCount(0);
  await page.evaluate(() => chrome.storage.local.remove('heroImages'));
  await expect(page.locator('#hero-status')).toContainText('You have 0');
});

test('narrow viewport, failed image and spatial view remain usable without remote scripts', async ({ context, extensionId, server }) => {
  const page = await seed(context, extensionId, server, 21);
  await context.route('**/hero-0.svg', route => route.fulfill({ status: 404, body: 'missing' }));
  await page.goto(`chrome-extension://${extensionId}/src/newtab/wunderkammer.html`);
  await expect(wall(page).locator('body')).toHaveAttribute('data-view-ready', 'true');
  const broken = wall(page).getByRole('button', { name: '<img src=x onerror=alert(1)> Fixture', exact: true }).first();
  await broken.focus();
  await expect(broken).toHaveClass(/broken/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(nav(page)).toBeVisible();
  const frame = page.frames().find(frame => frame.url().includes('/vendor/wunderkammer/index.html'));
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await settled(page);
  await page.screenshot({ path: '/tmp/tabtopia-wunderkammer-mobile.png', animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await wall(page).locator('#view-3d').click();
  await expect(wall(page).locator('body')).toHaveAttribute('data-view-mode', 'float');
  await expect(wall(page).locator('#float-host canvas')).toBeVisible();
});
