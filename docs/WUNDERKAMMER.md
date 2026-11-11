# Wunderkammer

The image-gallery navigation link appears once the local `heroImages` cache has
**more than 20 distinct eligible image URLs**. It opens a bundled Wunderkammer
viewer with Tabtopia's palette and local fonts. Images link back to their source
pages through native hyperlinks, preserving modified clicks and browser menus.

The threshold counts metadata, not verified successful downloads. It deduplicates
full normalized image URLs, requires HTTP(S) source-page and image URLs without
embedded credentials, and excludes images with a known dimension below 100 px.
Unknown dimensions remain eligible because page metadata often omits them. The
100 px cutoff excludes obvious icons without discarding small editorial images.
Expired or blocked images show an unavailable placeholder; they do not silently
change the inventory count. This first threshold is a product heuristic, not a
claim about collection coverage for all users.

Eligibility reads local storage without requesting any image. Navigation reserves
space before that read completes. Storage changes update the link automatically.
An open gallery keeps its layout, filters and selection stable when images change;
a quiet Refresh images glyph loads the pending collection. Falling below the
threshold immediately replaces the gallery with its current count, including an
empty cache. Refresh remains reachable in narrow windows.

Hero extraction and retention are unchanged: the cache retains up to 160 pages
with up to three images each. Collection size depends on browsing, extraction
engagement thresholds and existing site-access permissions. This feature requests
no additional permission and does not widen the extension CSP.

## Local integration and network behavior

The collection is derived in memory from local storage and passed to a
same-extension iframe. No collection, browsing inventory or page titles are sent
to a service. No Interests companion is involved. Images are requested directly
from their original hosts when the gallery is opened; this necessarily reveals
those image requests to those hosts. The viewer sends no referrer. Native source
links navigate normally. There is no image proxy or guarantee that retained URLs
will remain available.

The flat wall works without WebGL. Spatial views need WebGL; textured rendering
also depends on the image host's CORS policy. A flat-wall image loading does not
establish that its host permits use as a WebGL texture.

The bundled runtime is pinned to Wunderkammer v0.3.0 and Three.js 0.186.1. See
`src/vendor/wunderkammer/VENDOR.md` and the bundled MIT licenses for provenance
and the small integration patches. To update it, replace only runtime files from
the selected release, retain the local Three imports and Tabtopia stylesheet
links, and rerun the synthetic collection and browser tests. Do not copy upstream
sample collections, generated exports, machine notes or user inventory.

## Checks

`tests/unit/hero-collection.test.mjs` covers strict 20/21 gating, deduplication,
unsafe URLs, known-small images, missing dimensions, invalid timestamps and
untrusted text against the bundled collection validator. Run it on BIGFU.

`tests/e2e/wunderkammer.spec.js` loads the actual extension in local Chromium with
synthetic images and page URLs. It checks storage updates, stable navigation,
native links, literal hostile titles, local script loading, empty and failed-image
states, narrow rendering, settled successful covers and spatial-view startup.

### Startup performance

`tests/perf/wunderkammer-boot.js` measures the shipped host page and embedded
viewer with a read-only `chrome.storage` shim. It uses Playwright's default
headless shell, so it can run on BIGFU without launching full Chrome:

```sh
bigfu-run --timeout 180 --fetch test-results/wunderkammer-boot.json -- \
  node tests/perf/wunderkammer-boot.js --runs 3 --count 198 --groups 53
```

The default fixture uses synthetic URLs and small locally served SVGs. Add
`--image-delay-ms 150` to test sensitivity to image latency. That control serves
all images from one HTTP/1.1 origin; its six-connection queue is deliberately
different from a real collection spread across image hosts. It is a sensitivity
experiment, not a reproduction of an individual user's loading time.

The report separates host readiness, first visible image, 95% visible images,
and `window.wunderkammer.whenStill()` completion. Image milestones are relative
to iframe navigation; host readiness and total elapsed time are relative to host
navigation. It also records network totals, CPU/layout counters, named viewer
spans and 100 ms visual-coverage samples. CDP image request counts include cache
hits and retries; they are not counts of full transfers. No frame-rate or GPU
performance claim follows from these headless measurements. Normal browser
caching is preserved; every run uses a fresh browser context.

For an explicitly authorized private evaluation, `--inventory-url` accepts a
loopback JSON endpoint returning the `heroImages` store shape. The inventory
stays in memory. Remove page titles, source-page URLs and identifying group
labels before serving it; original image URLs are still private and require
authorization before transfer to another machine. Never put a private inventory
in the repository, a BIGFU snapshot, trace or screenshot. Output contains
aggregate measurements and source-file hashes, not image URLs or titles.

This HTTP harness isolates the viewer and image-loading path. It does not
measure extension service-worker contention, a user's existing browser cache,
signed-in image access or the full browser on their device. Existing local
extension tests remain the integration check.
