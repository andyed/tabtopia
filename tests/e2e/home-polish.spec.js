const { test, expect } = require('./fixtures');

async function prepare(context, extensionId, server) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/newtab/newtab.html#/treemap`);
  await page.addStyleTag({ content: '#startPageStateInspector { display: none !important; }' });
  await page.evaluate(async server => {
    const { renderHomeTakeover } = await import('./home-takeover.js');
    const root = document.createElement('main'); root.id = 'polish';
    root.style.cssText = 'position:fixed;inset:50px 0 0;overflow:auto;z-index:2000';
    document.body.append(root);
    window.polishModel = {
      mode: 'quiet', state: 'launch', loading: false,
      featuredItems: [{ id: 'alpha', identity: server + '/alpha', url: server + '/alpha', title: 'Alpha Page', domain: 'example.test',
        target: { url: server + '/alpha' }, rank: 1, sources: ['habit', 'bookmark'],
        reasons: ['Frequently revisited', 'Visited 47 times', 'Hub for 6 revisited pages'], expiresAt: Date.now() + 600000 }],
      frequentDestinations: { items: [] }, actions: []
    };
    const handlers = {
      onShowAlternatives: () => window.paintPolish({ featuredItems: window.polishModel.featuredItems.map(item => ({ ...item, title: 'Alternative Page' })) }),
      onHideContextSite: () => window.paintPolish({ featuredItems: [] }),
      onSnoozeRecommendation: () => {},
      onStartFresh: () => window.paintPolish({ freshOverride: true }),
      onShowSuggested: () => window.paintPolish({ freshOverride: false }),
    };
    window.paintPolish = changes => { Object.assign(window.polishModel, changes); renderHomeTakeover(root, window.polishModel, handlers); };
    window.paintPolish({});
  }, server);
  return page;
}

test('one specific cue, native destinations and quiet glyph controls', async ({ context, extensionId, server }) => {
  const page = await prepare(context, extensionId, server);
  const home = page.locator('#polish');
  await expect(home.locator('.home-takeover__reason')).toHaveText('Hub for 6 revisited pages');
  await expect(home).not.toContainText('Visited 47 times');
  await expect(home.locator('.home-takeover__sources')).toHaveCount(0);
  await expect(home.getByRole('link', { name: 'All tabs', exact: true })).toHaveAttribute('href', '#/treemap');
  const hide = home.getByRole('button', { name: 'Hide example.test from contextual suggestions' });
  await expect(hide.locator('svg')).toHaveCount(1);
  await expect(hide).toHaveText('');
  await home.locator('.home-takeover__featured-row').hover();
  await expect(hide).toHaveCSS('opacity', '1');
  await page.mouse.move(0, 0);
  await hide.focus();
  await expect(hide).toHaveCSS('opacity', '1');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.querySelector('#polish').scrollWidth <= 390)).toBe(true);
  await page.screenshot({ path: '/tmp/tabtopia-polish-mobile.png' });
});

test('passive updates preserve hovered and focused controls; explicit actions update immediately', async ({ context, extensionId, server }) => {
  const page = await prepare(context, extensionId, server);
  const link = page.locator('#polish .home-takeover__featured-link');
  await link.hover();
  const before = await link.boundingBox();
  await link.evaluate(node => { window.originalPolishLink = node; });
  await page.evaluate(() => window.paintPolish({ featuredItems: window.polishModel.featuredItems.map(item => ({ ...item, title: 'Updated Page' })) }));
  await expect(link).toContainText('Alpha Page');
  expect(await link.boundingBox()).toEqual(before);
  expect(await link.evaluate(node => node === window.originalPolishLink)).toBe(true);
  await page.mouse.move(0, 0);
  await expect(link).toContainText('Updated Page');
  await link.focus();
  await page.evaluate(() => window.paintPolish({ featuredItems: window.polishModel.featuredItems.map(item => ({ ...item, title: 'Newest Page' })) }));
  await expect(link).toBeFocused(); await expect(link).toContainText('Updated Page');
  await page.locator('#tabSearch').focus();
  await expect(link).toContainText('Newest Page');
  const alternatives = page.locator('#polish').getByRole('button', { name: 'Show alternatives' });
  await alternatives.click();
  await expect(link).toContainText('Alternative Page');
  await expect(alternatives).toBeFocused();
});

test('cached header reserves the same space as live counts and favicon slots', async ({ context, extensionId, server }) => {
  const page = await prepare(context, extensionId, server);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.paintPolish({ loading: true, stale: true, frequentDestinations: null, actions: [], archiveItems: [], githubStarItems: [], techmemeItems: [] }));
    const before = await page.locator('#polish .home-takeover__header').boundingBox();
    await page.evaluate(server => window.paintPolish({ loading: false, stale: false,
      actions: Array.from({length: 18}, (_, i) => ({id: `action-${i}`, title: `Page ${i}`, url: server + '/alpha'})),
      archiveItems: Array.from({length: 6}, (_, i) => ({id: `archive-${i}`, title: `Archive ${i}`, url: `https://archive${i}.example.test/`})),
      githubStarItems: [{ title: 'owner/repo', url: 'https://github.com/owner/repo', action: {target: {url: 'https://github.com/owner/repo'}} }],
      techmemeItems: [{title: 'Techmeme', url: 'https://techmeme.com/1', action: {target: {url: 'https://techmeme.com/1'}}}],
      frequentDestinations: { items: Array.from({ length: 8 }, (_, i) => ({
      key: `site${i}.test`, name: `site${i}.test`, url: server + '/alpha', tabs: [], pinned: true
    })) } }), server);
    const header = page.locator('#polish .home-takeover__header');
    expect(await header.boundingBox()).toEqual(before);
    const beforeIcons = await header.boundingBox();
    await page.locator('#polish .frequent-bank__favicon').evaluateAll(nodes => nodes.forEach(node => node.dispatchEvent(new Event('error'))));
    expect(await header.boundingBox()).toEqual(beforeIcons);
    if (width === 1440) await page.screenshot({ path: '/tmp/tabtopia-polish-desktop.png' });
  }
});
