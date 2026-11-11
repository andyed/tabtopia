# Bundled Wunderkammer

Wunderkammer v0.3.0, commit `6da1144f28f7fa840e0b0b59a4bc24fe1e193a5c`,
from https://github.com/andyed/wunderkammer. MIT; see LICENSE.

Three.js 0.186.1, from the published `three@0.186.1` npm tarball. MIT; see
three/LICENSE. Only its module/core runtime, OrbitControls and CSS3DRenderer are
included. No remote executable code is loaded.

Integration differences:
- Bare Three.js imports resolve to this local copy; inline CDN import maps removed.
- The main page loads Tabtopia's local fonts and separate Wunderkammer theme.
- Narrow windows use the overlay filter rail, including desktop windows.
- The upstream development-only spatial sync script and maintenance log are not shipped.
- Two whitespace-only defects in the runtime source are normalized.

The viewer receives a validated collection object from its same-extension parent.
It reads images directly from their original hosts, with no backend, proxy, or
collection upload. Source links remain native hyperlinks. The flat wall works
without WebGL; spatial modes depend on WebGL and the source image's CORS policy.
