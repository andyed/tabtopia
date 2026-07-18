// Render og.svg -> og.png at 2x (2400x1260) via the repo's own Playwright.
// Browser rendering gives faithful Avenir Next / Menlo text (rsvg's fontconfig
// path is unreliable for macOS system fonts).
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 2,
});
await page.goto('file://' + join(dir, 'og.svg'));
await page.screenshot({ path: join(dir, 'og.png') });
await browser.close();
console.log('wrote og.png (2400x1260)');
