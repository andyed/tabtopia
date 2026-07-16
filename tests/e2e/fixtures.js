// Shared Playwright fixtures for the Tabtopia E2E suite.
//
// What these give a test:
//   - `context`     a fresh browser with the unpacked extension loaded, one
//                   isolated profile per test.
//   - `extensionId` the runtime id, read live from the MV3 service worker URL
//                   (with a path-derived fallback). Unused by the current specs,
//                   which reach the newtab via chrome://newtab/, but it's the
//                   handle you need to test popup.html / debug.html directly.
//   - `server`      base origin of a tiny local HTTP server that serves a few
//                   pages with KNOWN <title>s, so the treemap renders cells whose
//                   aria-label we can target deterministically.
//
// Browser: Playwright's bundled Chromium (run `npx playwright install chromium`
// once). Branded Google Chrome stable (channel: 'chrome') is NOT used — recent
// Chrome locks down `--load-extension`, so the unpacked extension never loads
// there. Bundled Chromium loads it cleanly, even in (new) headless. Set HEADED=1
// to watch the run.

const path = require("path");
const http = require("http");
const crypto = require("crypto");
const base = require("@playwright/test");
const { chromium } = require("@playwright/test");

// Chrome derives an unpacked extension's id from the SHA-256 of its absolute
// path: take the first 16 bytes and map each nibble 0..15 -> 'a'..'p'. This lets
// us know the id even when the MV3 service worker hasn't been observed yet (the
// new headless mode doesn't always surface it). The newtab view's first paint
// and the hover/click path call chrome.windows/bookmarks/history directly — no
// worker round-trip — so a worker-independent id is enough to drive the UI.
function extensionIdFromPath(absPath) {
  const hash = crypto.createHash("sha256").update(absPath).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return id;
}

// Repo root IS the extension (manifest.json lives at the top level). Chrome only
// reads files the manifest references, so loading the whole repo is fine.
const EXTENSION_PATH = path.resolve(__dirname, "..", "..");

// Injection probe used by the /hostile fixture page. Deliberately contains no
// quotes so it stays usable inside a CSS [aria-label="..."] selector.
const HOSTILE_TITLE = "<img src=x>Pwned";

// pathname -> document.title. The title becomes the tab title, which the treemap
// copies onto each cell's aria-label (treemap.js: .attr('aria-label', d.data.title)).
const PAGES = {
  "/alpha": "Alpha Page",
  "/beta": "Beta Page",
  "/gamma": "Gamma Page",
  // Used by the pin test to navigate an existing tab and force a treemap redraw.
  "/delta": "Delta Page",
  // Any site controls its own <title>, and that title flows into innerHTML sinks
  // on the privileged newtab page. <title> is RCDATA, so this payload does NOT
  // parse as a tag here — document.title becomes the literal string, which is
  // precisely the attacker-controlled value the extension must escape. No event
  // handler on purpose: the assertion is "did an element materialize", so the
  // payload needs no side effect to prove the point.
  "/hostile": HOSTILE_TITLE,
};

// Launch an extension-loaded Chrome. `userDataDir` of "" gives a throwaway
// temp profile (the default per-test context). Pass a real directory — and
// reuse it across two launches — to simulate a browser RESTART on the same
// profile (used by the search-persistence session-scoping test).
async function launchExtensionContext(userDataDir) {
  const headless = process.env.HEADED !== "1";
  const args = [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  // Playwright's headless:true historically used the *old* headless, which does
  // NOT load extensions. The new headless mode does — request it explicitly and
  // leave headless:false so Playwright doesn't override us with the old flag.
  if (headless) args.push("--headless=new");

  return chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1600, height: 1000 },
    args,
  });
}

const test = base.test.extend({
  // ---- worker-scoped local fixture server -------------------------------------
  server: [
    async ({}, use) => {
      const httpServer = http.createServer((req, res) => {
        const pathname = (req.url || "/").split("?")[0];
        const title = PAGES[pathname];
        if (!title) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
          `<title>${title}</title></head><body><h1>${title}</h1>` +
          `<p>${title} — fixture content for the Tabtopia e2e suite.</p></body></html>`
        );
      });
      await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
      const { port } = httpServer.address();
      await use(`http://127.0.0.1:${port}`);
      await new Promise((resolve) => httpServer.close(resolve));
    },
    { scope: "worker" },
  ],

  // ---- test-scoped extension-loaded Chrome ------------------------------------
  context: async ({}, use) => {
    const context = await launchExtensionContext("");
    await use(context);
    await context.close();
  },

  // ---- extension id -----------------------------------------------------------
  // Prefer the live service-worker URL (authoritative); fall back to the
  // path-derived id when the worker isn't surfaced (new headless mode).
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) {
      sw = await context
        .waitForEvent("serviceworker", { timeout: 5_000 })
        .catch(() => null);
    }
    const extensionId = sw
      ? sw.url().split("/")[2]
      : extensionIdFromPath(EXTENSION_PATH);
    await use(extensionId);
  },
});

module.exports = { test, expect: base.expect, launchExtensionContext, HOSTILE_TITLE };
