# Tabtopia E2E tests

Playwright tests that load the **real, unpacked extension** into Chrome and drive
the newtab treemap with genuine mouse hover/click. They exist because the
treemap ↔ readout interaction bugs (hover preview, click-to-pin, switching the
pinned cell) were repeatedly mis-diagnosed from reading the code alone — these
assert the *observable* behaviour instead.

## Run

```sh
npm install                      # first time only — Playwright test runner
npx playwright install chromium  # first time only — the browser (~170MB)
npm test                         # headless
npm run test:headed              # watch it drive a visible browser window
npm run test:report              # open the HTML report after a run
```

The harness uses Playwright's **bundled Chromium**, not branded Google Chrome.
Recent Google Chrome stable locks down `--load-extension`, so the unpacked
extension never loads under `channel: 'chrome'`; bundled Chromium loads it
cleanly, even headless. (See `tests/e2e/fixtures.js`.)

## What's covered

`tests/e2e/treemap.spec.js`

- **hover previews and switches** — hovering a cell shows it in `#readout`;
  moving to another cell updates the preview (guards the "n-2 hover" / "no
  hovers" regressions).
- **click pins, the pin survives a redraw, a second cell switches it** — clicking
  a cell pins the readout (`#readout.sticky`) and highlights the cell
  (`.node-activated`); then a forced treemap redraw (navigating a tab) must
  **keep the highlight on the recreated cell** — the load-bearing assertion, since
  the old DOM-ref code orphaned the pin here ("selecting another cell doesn't
  work"); while pinned, hover no longer moves the readout; clicking a *different*
  cell switches the pin; clicking the pinned cell again unpins.

  This test is a verified regression guard: it passes on the fixed code and fails
  on the pre-fix `treemap.js` (the recreated cell comes back bare).

## How it works

`tests/e2e/fixtures.js` provides:

- `context` — a fresh extension-loaded Chrome per test (isolated profile).
- `extensionId` — read live from the MV3 service-worker URL.
- `server` — a tiny local HTTP server serving pages with known `<title>`s, so
  the treemap renders cells whose `aria-label` we can target deterministically.

The newtab boot renders one cell per **open tab** (`chrome.windows.getAll`), so
the tests just open a few fixture pages, then open
`chrome-extension://<id>/src/newtab/newtab.html`.

## Notes

- Serial by design (`workers: 1`): each test spawns its own Chrome.
- `expect` timeout is 10s because `displayReadout()` awaits
  `chrome.bookmarks`/`chrome.history` lookups before it paints.
- Set `HEADED=1` to watch the browser.
