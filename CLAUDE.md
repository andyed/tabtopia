# histospire

> **Naming**: the directory and repo are `histospire`; `manifest.json` still ships
> `"name": "tabtopia"`, and branches are named `agent/tabtopia-*`. Both names refer
> to this project. Verified inconsistency, not a bug to "fix" casually — the
> manifest name is user-visible and the extension key is pinned.

> **This is the live extension.** `~/Documents/dev/dev_backburner/tabtopia-extension`
> is an abandoned v0.1.0 prototype that still carries its own CLAUDE.md with a
> "Known Bugs" list. Those bugs are the prototype's and were fixed here long ago.
> It has already misdirected one session. Ignore it.

## Codebase Overview

Manifest V3 Chrome extension that captures browsing telemetry (link/form/SPA
navigation intent, referrer and opener chains, per-tab dwell, audio playback,
hero images) into a background service worker, persists it under
`chrome.storage.local`, and exposes it through several standalone views.

**Stack**: MV3, vanilla ES modules, no bundler. D3 v7 and Lunr are vendored in
`src/lib/` and loaded via `<script>` tags. `package.json` exists **only** for the
dev-time test harness — the extension itself ships unbundled.

**Structure**
- `src/background.js` — ~4.3k-line service worker, single source of truth
- `src/content/content.js` + `src/content-scripts/` — content scripts on `<all_urls>`
- `src/newtab/` — six view shells: `newtab`, `graph`, `sessions`, `stars`, `popup`, `debug`
- `src/lib/` — 28 feature modules (providers, ranking, recall, state)
- `src/options/` — options page
- `mcp/` — standalone MCP bridge daemon + server (Node, not shipped)

**Entry points** (`manifest.json`): newtab override → `src/newtab/newtab.html`;
toolbar popup → `src/newtab/popup.html`; options → `src/options/options.html`;
omnibox keyword `tt`.

## Local Integration

- **`ws://127.0.0.1:8892`** — tabtopia's own MCP bridge daemon. The extension is
  the client. Authenticated by the `Origin` header Chrome attaches to
  SW-initiated WebSockets (`chrome-extension://<id>`, unforgeable from page JS);
  the daemon needs this extension's id in its allowlist. Bidirectional — the
  daemon can request tab content via `GET_TAB_CONTENT`.
- **`:8893`** — MCP health endpoint (`curl -s localhost:8893/health`).
- **`:8889`** — interests2025 REST, consumed by `src/lib/archive-provider.js` and
  `src/lib/github-stars-provider.js`.

Bridge design constraint: **no reconnect timers.** A backoff loop would keep the
MV3 service worker alive and fight Chrome's teardown. Each push lazily
reconnects, throttled to one attempt per 30s. See the header comment in
`src/bridge-client.js` before touching any of this.

`:8891` appears only in a historical comment — the old interests2025 bridge
dependency is gone; tabtopia owns its bridge end-to-end.

## Chrome Built-in AI (Gemini Nano)

Live, and defensively written for good reason — the API is flaky. Owned by
`src/newtab/readout.js`; the `"ai"` manifest permission exists for it.

- **Producer**: `readout.js` gates on `window.Summarizer.availability()` (raced
  against a 5s timeout) before `window.Summarizer.create()`, then persists to the
  `nanoSummaries` storage key.
- **Consumers**: `src/newtab/recall-search-sources.js` (recall/search) and
  `src/newtab/debug.js` (inspect/clear).
- **Input cap**: `MAX_CONTENT_LENGTH = 12000` (`readout.js:1086`). Chrome's
  Summarizer has a hard input limit around 12KB and throws above it — this cap
  exists because that was hit in production.
- **Queue**: bounded at `MAX_QUEUE_SIZE: 50`, drops oldest on overflow.
- **Kill switch**: `globalSummarizerDisabled` in `src/newtab/crash-suppression.js`.
  The Summarizer genuinely crashes; that module intercepts the crash messages and
  pre-emptively disables the feature rather than letting it spam or wedge boot.

Treat the availability gate, the 12KB cap, and the kill switch as load-bearing.
Each was added in response to a real failure, not speculatively.

## Persistence (`chrome.storage.local`)

`browserState` · `historyEntries` · `activeTabs` · `lastActiveTab` ·
`lastStateSave` · `heroImages` · `nanoSummaries` · `graphPersistentData`

## Testing

- **Unit**: `npm run test:unit` — plain `node --test` over `tests/unit/*.test.mjs`
  (28 files). No vitest, no jest.
- **E2E**: `npm run test:e2e` — Playwright, loads the unpacked extension into real
  Chrome (12 specs). `npm run test:headed` to watch.
- **Benchmarks**: `npm run benchmark:{omnibox,treemap,boot,profile}`.

## Lint

Flat config in `eslint.config.js`. `no-undef` is **on and clean**; `src/` is
error-free. Two things to preserve:

- `src/lib/**` is in `ignores`. A repo-wide `eslint --fix` once rewrote
  `d3.min.js`/`lunr.min.js` across 280KB of minified code. Never `--fix` the repo.
- Node-side tooling (`mcp/`, `tests/`, `playwright.config.js`, `assets/`) has its
  own config block with Node globals. It is not browser code.

`mcp/` and `tests/` still carry ~320 pre-existing `quotes` errors. Left
deliberately — fixing them means rewriting files other branches actively edit.

## Verified Dead Code

Confirmed defined-but-never-called / never-imported as of 2026-08-05. Safe to
delete; listed so nobody re-derives them:

- `src/background.js` — `createRefreshIndicator` (:4208), `extractContentFromPage`
  (:4219), `updateAudioBasedDwellTime` (:4268). The first two use DOM APIs that
  don't exist in an MV3 service worker anyway.
- `src/newtab/newtab.js` — `createTreemapData` (:14)
- `src/newtab/sessions_view_toggle.js` — 71 lines, never imported
- `src/content-scripts/content.js` — 11-line stub, not referenced by the manifest
- `src/background-hero-images.js` — 115 lines, never imported

## Already Fixed — Do Not Re-Report

A June 2026 draft of this file (on the stale `bridge-mcp` branch) listed these as
live. All were verified fixed on 2026-08-05:

- Duplicate `chrome.tabs.*` listeners in `background.js` — now exactly one each.
- Newtab double-paint from two `DOMContentLoaded` handlers — removed; see the
  note at `src/newtab/newtab.js:765`.
- Stars search being a stub — `#starsSearch` is wired with real handlers.
- Unauthenticated WS bridge — replaced by the Origin-authenticated `:8892` daemon.
- "Latent ReferenceErrors" in `newtab.js`/`keyboardNav.js` — misreadings. The real
  symbols are `updateTimelineWithNavigation`, `updateGraphWithNewEdge`, and an
  `activateNode` properly imported from `treemap.js`. `no-undef` now guards this.

## Conventions

- Conventional commits (`type(scope): message`).
- Window colors live in `src/newtab/utility.js`. `getWindowColor` and
  `getWindowColorPalette` keep **separate** caches on purpose — they store
  different types under the same window id, and sharing one Map silently paints
  `hsl([object Object], …)`. Covered by `tests/unit/window-colors.test.mjs`.
- The newtab treemap does its own per-window color scale in `treemap.js`; it does
  not go through `getWindowColor`. The popup does.

---
*Verified against HEAD on 2026-08-05.*
