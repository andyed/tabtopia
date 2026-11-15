# Bundled Wunderkammer

Wunderkammer v0.5.0, commit `9e0071a992d1437a6670376fdc3cc5cab40c9dbd`,
from https://github.com/andyed/wunderkammer. MIT; see LICENSE.

Three.js 0.186.1, from the published `three@0.186.1` npm tarball. MIT; see
three/LICENSE. Only its module/core runtime, OrbitControls and CSS3DRenderer are
included. No remote executable code is loaded.

Integration differences:
- Bare Three.js imports (including the new `wall/video-tiles.mjs`) resolve to this local copy; inline CDN import maps removed.
- The main page loads Tabtopia's local fonts and separate Wunderkammer theme.
- Narrow windows use the overlay filter rail, including desktop windows.
- The upstream development-only spatial sync script and maintenance log are not shipped.
- Two whitespace-only defects in the runtime source are normalized.
- `wall.mjs` reuses the flat layout for equivalent continuing searches while updating scope/history UI.
- `image-loading.mjs`, the overview loader and DOM image queue use Tabtopia's bounded local preview cache (`src/lib/hero-preview-cache.js`) and eight-second image deadlines. Layout replacement cancels stale DOM work. Preserve these integration patches when updating upstream.

The viewer receives a validated collection object from its same-extension parent.
It reads images directly from their original hosts or the local preview cache, with no backend, proxy, or
collection upload. Source links remain native hyperlinks. The flat wall works
without WebGL; spatial modes depend on WebGL and the source image's CORS policy.
