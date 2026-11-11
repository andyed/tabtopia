# Developing and troubleshooting Tabtopia

The extension is Manifest V3 with vanilla JavaScript modules, vendored D3 and
Lunr, and no extension bundling step. `package.json` supplies development tools;
Node is not required to use the extension. The optional MCP companion has its
own package in `mcp/`.

## Source map

- `manifest.json`: permissions, content scripts, new-tab override and entry points.
- `src/background.js`: canonical browsing state, navigation tracking and persistence.
- `src/newtab/`: Home, treemap, Trails, Sessions, Stars and their shared readout.
- `src/content-scripts/hero-images.js`: image candidate extraction on visited pages.
- `src/newtab/hero_images_display.js`: session imagery and mosaics.
- `src/newtab/readout.js`: page extraction, summarization queue and fallback descriptions.
- `src/lib/revisit-model.js`: history and transition scoring.
- `src/lib/shadow-ranking.js`: next-tab models evaluated alongside observed choices.
- `src/lib/learned-combiner.js`: scoring with the versioned fitted weights.
- `src/lib/ranking-diagnostics.js`: local outcome records and evaluation criteria.
- `mcp/`: optional live-browser bridge and MCP tools.

See [Home's recommendation policy](HOME_RECOMMENDATION_ALGORITHM.md) for the
separate heuristic that selects Home destinations, and
[prediction replay](PREDICTION_REPLAY.md) for model evaluation and reproduction.
Do not treat Home recommendations, next-tab experiments, and MCP engagement
ordering as one ranking algorithm.

## Run and verify

Load the repository folder as an unpacked extension. Reload it in
`chrome://extensions/` after editing the background worker or manifest; reload
visited pages when testing changed content scripts.

```sh
npm install
npm --prefix mcp install
npx playwright install chromium
npm run test:unit
npm run test:e2e
```

The MCP dependency is needed for its tools and the bridge regression test.
The browser fixtures use an isolated profile with the real unpacked extension.
See the [test guide](../tests/README.md) for setup and interaction coverage.

A focused URL-matching regression can be run with:

```sh
npx playwright test tests/e2e/tab-content-url.spec.js
```

## Troubleshooting

### No hero images

Check Tabtopia's site-access setting for the visited page, then reload that page.
Automatic extraction requires both time and scrolling; opening a page briefly
is not enough. Pages can lack suitable images, forbid content-script access, or
serve image URLs that expire or cannot be loaded later. Image metadata in local
storage is not an offline copy of the image file.

### No AI summary

Check [Chrome's current requirements](https://developer.chrome.com/docs/ai/summarizer-api).
The presence of a permission in the manifest does not establish that a model is
available. Tabtopia checks availability, bounds input, and can disable the
summarizer after failures. Metadata fallbacks should remain usable.

On a Tabtopia page that loads the readout module, its DevTools console exposes:

```js
getSummarizerStatus()
getQueueStats()
```

For deliberate recovery, `clearSummaryQueue()` removes pending work and
`flushSummaryCache()` clears cached summaries. `resetSummarizerCrashCounter()`
resets crash handling; it does not install a model or fix an underlying browser
failure. These functions are page-context helpers, not universal Chrome console
commands. The debug page also contains diagnostic helpers, some of which are
stubs; do not mistake their output for the readout's live runtime state.

### Empty or stale views

Reload the extension and reopen the affected view. Inspect the service-worker
console from `chrome://extensions/` for background errors, and the view's own
DevTools for rendering errors. Capture the precise view and steps that fail
before clearing data; clearing storage destroys useful diagnostic evidence.

### MCP unavailable or unable to read a page

Use the [MCP health check and setup guide](../mcp/README.md). The extension,
bridge daemon, and client registration are all needed. Snapshot age matters.
The content tool requires a currently open tab with the requested complete URL;
a different fragment is a different target. Browser-protected pages may not
permit extraction. Reload the extension to activate a background-worker fix.

## Diagnostic logging

Production logging defaults to off. In an extension DevTools context:

```js
await TabtopiaLogger.setLevel("debug", { persist: true })
// Reproduce the problem, then turn logging off again:
await TabtopiaLogger.clearLevel({ persist: true })
```

Diagnostic output can contain titles, URLs and browsing context. Review it before
sharing. The local prediction study is a separate facility controlled by
**Options → Help improve tab ranking**; disabling it clears its study records.

## Contribution conventions

Use the canonical state and routing paths. Keep model variants versioned and
reproduce recorded outcomes before reporting replay results. Preserve bounded
storage, extraction limits, and summarizer availability/error handling.

Use external scripts, avoid inline event handlers and dynamic code execution,
and keep extension code compatible with the manifest's CSP. Follow the existing
logging gate. Avoid automatic formatting of vendored libraries in `src/lib/`.

When changing visible behavior, inspect the actual rendered view and exercise
keyboard navigation, selection, and page/tab activation. For a release, follow
`scripts/build-release.sh`: packaging, publishing, and verification are separate
steps. A successful local build is not evidence of a published release.

## Documentation screenshots

The README's Home and Trails screenshots show the development renderer with
synthetic data, not a user's browser history. Home's example destinations are
presentation fixtures, not measured prediction outcomes. Refresh these images
when the interface changes and preserve that distinction in their captions.

## Private supplemental-source overlays

The public archive, GitHub-star and recent-context providers have no network
refresh implementation. Their cache readers and exported interfaces remain for
compatibility. Core Home ranking uses Chrome history, bookmarks and selected hubs.

Maintain any personal provider implementation outside this repository. Apply it
only to a separate unpacked-extension directory, checking the provider base hashes
before replacement. Do not patch the release checkout: release archives come
from tracked source. Test private adapters with synthetic responses and review
what titles or other data they send before using them with real browsing.

The E2E fixture accepts `TABTOPIA_EXTENSION_PATH` for testing such a separate
extension directory. The default tests always use this repository's public build.
