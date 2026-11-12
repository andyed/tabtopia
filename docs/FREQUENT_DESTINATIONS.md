# Frequent destinations

Implemented Home fast path. The destination bank uses local qualified-return
history and explicit preferences. It has no dependency on supplemental services,
semantic context, GitHub-star imports or the predictive recommendation experiment.

## Interaction

Up to eight compact favicon controls sit in Home's header, alongside its counts.
The badge counts open tab instances across normal windows in the current
profile; duplicate URLs count separately. Zero open tabs has a dotted border;
open destinations have a solid border. Counts appear only for two or more tabs;
zero and one have no badge. Exact counts remain in tooltips and accessible labels.
One tab switches to that window and tab; zero opens the preferred URL in the Home
tab; multiple tabs open a chooser. Arrow Down opens the chooser/settings for any tile. A
pencil glyph reveals settings on hover or keyboard focus (always shown on touch
devices). Names appear on hover/focus and in accessible labels. Favicon failures
use the existing local letter fallback.

The chooser groups tabs by window, puts this window first and orders each
window's tabs by last access. Enter selects, arrows navigate tab rows, Escape
closes and returns focus. Outside click dismisses. Counts and lists follow the
existing controller's debounced browser listeners. A disappearing focused row
transfers focus to the nearest remaining row. The destination name is a native
hyperlink to the saved URL, preserving the browser’s normal modifier-click,
middle-click and context-menu navigation. The tab chooser keeps pinning, hiding
and URL settings behind its pencil glyph. Titles and URLs are inserted as text
or validated values.

Edit offers pin/unpin, hide/restore, and a preferred opening URL constrained to
the same destination. URLs retain path, query and fragment. Nothing invents an
inbox or landing route. Pin a website accepts an explicit HTTP(S) URL, up to eight
pins. Hide retains preferences so Restore can recover them.

## Selection and identity

The existing habit ranker supplies at most ten candidates from its bounded
128-page shortlist. Admission requires at least three qualified domain accesses;
ranking uses its History activation, never open-tab count or raw Chrome visits.
This initial threshold is a product heuristic, not a validated effectiveness claim.
There is no extra minimum-active-days gate. Sparse evidence leaves fewer icons.

Hostnames retain subdomains (Gmail and Docs remain separate), normalize leading
www consistently with the revisit model, and retain non-default ports. Since the
existing domain evidence merges ports, loopback/non-default-port destinations
require a pin. Service display labels do not seed candidates or influence rank.

Pinned destinations come first in pin order. The existing order of other eligible
destinations survives score changes for the local calendar day. Newly eligible
items fill gaps; removed/hidden candidates disappear. The next day ranks again.
The session order survives Home reloads, not browser restarts. Cross-page settings
changes refresh through the canonical storage listener.

## Integration and retention

- `src/lib/frequent-destinations.js`: pure selection, identity, preference validation.
- `src/newtab/start-page-controller.js`: joins habit evidence, live windows and preferences.
- `src/newtab/start-page-recognition.js`: carries the model and settings mutations.
- `src/newtab/frequent-bank.js`: rendering, disclosure, focus and feedback.
- `src/newtab/start-page-actions.js`: existing canonical switch/in-place-open executor.

Preferences use `chrome.storage.local.tabtopiaFrequentPreferencesV1`: at most
eight pinned URLs, 100 hidden keys and 100 preferred URLs. Session order uses
`chrome.storage.session.tabtopiaFrequentOrderV1`: date and up to eight keys.
No new browsing-event log or telemetry is added. Incognito tabs are excluded.
The initial cached Home paint omits the bank until live counts/preferences arrive;
Start fresh hides it. Preference storage failure reports an error, while optional
order persistence failure does not prevent Home from rendering.

## Verification

Unit fixtures cover qualified admission, ranking independent of multiplicity,
stable daily order, hostname/port identity, duplicate instances, incognito
exclusion, preferences, bounds and credential/scheme rejection. Chromium tests
cover zero/one/many tabs, real window focus, duplicate URLs, keyboard and live
closure recovery, preference persistence, narrow layout, favicon fallback,
resize and outside dismissal. No human performance benefit has been measured.

## Backlog

- Clearer tab identification: disambiguate duplicate tab titles with a short URL
  path, and show audio and pinned indicators when relevant. Keep native destination
  hyperlinks and the compact chooser; this work is not implemented yet.
