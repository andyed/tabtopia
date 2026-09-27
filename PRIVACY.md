# Tabtopia Privacy Policy

**Working draft — not a published store policy.** Original 1.3.0 review:
2026-08-17. Network, image access, and agent-boundary clarifications: 2026-11-10.
The remaining TODOs and older retention figures still need a complete release audit.

Items marked **TODO** need a decision before this can be submitted to the Chrome
Web Store, which requires a publicly hosted privacy policy URL for any extension
that handles browsing activity.

---

## The short version

Tabtopia records how you browse so it can show you where you have been and where
you are likely to go next. That record lives in `chrome.storage.local` on the
machine that made it. There is no Tabtopia account or hosted browsing-data
service. Optional ranking studies keep local evaluation records.

Network requests include the public Techmeme feed and images loaded from their
original websites or CDNs. Optional companion services run separately. The MCP
bridge defaults to loopback, but an agent client can pass its results to a remote
model provider; local transport is not a promise that agent use stays on-device.

## What Tabtopia records

All of this is written to `chrome.storage.local`, which is per-profile, per-device
storage. Tabtopia does not use `chrome.storage.sync`, so none of it is uploaded to
your Google account or shared between your devices.

**Browsing activity**
- Page URLs, titles, and favicons for tabs you open
- Per-tab dwell time, focus and activity events, and audio-playback state
- Navigation intent: the link text and target you clicked, referrer chains, and
  which tab opened which
- Window and tab arrangement, so the tab landscape can be drawn

**Page metadata from the pages you visit**
Content scripts are declared for all URLs and run where Chrome grants site
access. They report:
- The page title and path
- The text and destination of links you click
- Candidate hero images, stored as image URLs and metadata such as alt text.
  Displaying them can load image files from the original website or CDN.

Hero-image collection needs access to page metadata and images. Broad site
access enables automatic collection across sites; restricting access limits
where content scripts can run. The same access supports other navigation and
page-context features. The extension does not store screenshots of your browser
as hero images.

**Form submissions**
When you submit a form, Tabtopia records the form's action URL, method, field
count, and the page it was on. Field *values* are replaced with the literal
placeholder `[FIELD_VALUE]`, and password fields are skipped entirely.

**One exception, stated plainly:** the value of the first search-like input in the
form *is* recorded verbatim, so that searches you ran show up in recall. "Search
-like" means `input[type=search]`, or an input whose `name` contains `search`, or
whose placeholder contains `search`. That last rule matches on a substring, so on
an unusual site it could capture a field you would not think of as a search box.
**TODO:** tighten this selector, or make search-query capture an explicit opt-in.

**Your Chrome history and bookmarks**
Tabtopia reads both through the `history` and `bookmarks` APIs to rank and group
what it shows. User-facing controls can also create bookmarks when you select
that action. The optional MCP's read-only contract is separate from these
interactive extension controls.

**On-device AI summaries**
If Chrome's built-in Summarizer (Gemini Nano) is available, Tabtopia may summarize
page content and store the result under `nanoSummaries`. This model runs entirely
inside Chrome on your machine. Page content sent to it does not leave the device.

## What Tabtopia never records

- Passwords, or the contents of password fields
- Values of ordinary form fields (redacted to `[FIELD_VALUE]` before storage)
- Full page bodies as a browsing archive; extracted text can be passed to the
  on-device summarizer or returned through an explicit MCP page-content request
- Anything at all from a page while the extension is disabled or uninstalled

## Network connections

The public extension has no archive, semantic-context or GitHub-star service
connection. Those sources are available only in separately maintained local
customizations, whose data handling must be reviewed independently.

| Destination | Purpose | Required? |
|---|---|---|
| `https://www.techmeme.com/feed.xml` | Public tech-news RSS feed shown on the Home view | Sent on its own; carries no browsing data |
| `ws://127.0.0.1:8892` | The optional local MCP bridge daemon | Optional |
| Original image websites and CDNs | Load hero images when rendering session cards and mosaics | Depends on the displayed imagery |

The Techmeme request is an ordinary feed fetch. It sends no browsing data, no
identifier, and no query — Techmeme learns only that some browser asked for its
public feed.

## The optional MCP bridge

The bridge is not installed or started by Chrome and is not required for
extension-only use. It binds to loopback on your machine.

**The MCP bridge daemon (`:8892`)** lets local agent tooling read Tabtopia's live
status, and — this part matters — request the text of a page you have open. The
daemon accepts connections only from an allowlisted `chrome-extension://` origin,
which a web page cannot forge. A different local process running as your user
could spoof that origin; that is outside the threat model, and it is why the
daemon binds loopback only. If you do not run the daemon, MCP page requests are
unavailable. Once results reach an agent client, that client's model and provider
settings determine whether browsing context and extracted page text leave the
machine. Named MCP context captures are stored separately from Chrome extension
storage; uninstalling the extension does not delete those files.

## Retention and deletion

Tabtopia bounds what it keeps, both to stay useful and to stay inside Chrome's
storage quota: hero-image metadata is capped at 160 pages, persistent browser
state at roughly 2 MB and 128 tabs, cached semantic queries at 12, archive rows at
96, and GitHub stars at 2000. Older entries are dropped first. Compatibility
readers retain previously saved supplemental data locally; these provider paths
do not refresh it or send page titles to a service. Removing a connection
does not erase its existing cached data.

To delete data:
- **Everything:** remove Tabtopia from `chrome://extensions`. Uninstalling clears
  the extension's entire `chrome.storage.local` for that profile.
- **Selectively:** the debug page (`src/newtab/debug.html`, reachable with Alt+D
  from any Tabtopia view) has controls to clear stored history, activity, graph
  data, AI summaries, and all storage at once.
- **Ranking diagnostics:** turn "Help improve tab ranking" off in Settings, which
  also removes every recorded outcome.

**TODO:** the only "clear my data" control lives on a hidden debug page. Before
release, surface at least a clear-all button in Settings — a privacy policy should
not point users at a keyboard shortcut.

## Permissions, and why each one exists

| Permission | Why |
|---|---|
| `history` | Read visit history to rank destinations and reconstruct trails |
| `bookmarks` | Read saved bookmarks as landmarks on the map |
| `tabs`, `windows` | See which tabs and windows are open, to draw them |
| `storage` | Persist everything above, locally |
| `activeTab`, `scripting` | Extract page text on demand for summaries and recall |
| `webNavigation`, `webRequest` | Follow redirect and referrer chains so navigation intent is attributable |
| `favicon` | Render site icons |
| `ai` | Chrome's built-in on-device Summarizer |
| `<all_urls>` | The content scripts above must run everywhere, because you browse everywhere |

`<all_urls>` is the broadest permission here and deserves the plainest
explanation: Tabtopia maps *your whole browsing*, so it cannot be restricted to a
list of sites without becoming a different product.

## Changes to this policy

Material changes will be noted in `CHANGELOG.md` and reflected in the date at the
top of this file.

## Contact

**TODO:** add a contact address and the public URL where this policy will be
hosted. The Web Store listing requires both.
