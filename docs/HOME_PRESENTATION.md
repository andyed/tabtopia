# Home presentation

Home shows one explanatory cue per destination. A specific relationship or
provenance takes priority over a visit tally; when no reason is displayed, one
source label remains (cross-device provenance takes priority). Ranking evidence
and diagnostics retain their full data. The activity action does not repeat its
header's domain or summary. Dates on GitHub-star rows remain useful provenance.

Destination navigation uses anchors. All tabs is a native route link; ordinary
Home destination activation retains the canonical action/attribution path while
modifier-click and middle-click remain native. Snooze, Hide, Show alternatives,
and Start fresh use the shared glyph set with accessible names and tooltips.
Per-row secondary controls reveal on hover or keyboard focus; touch shows them.
Undo remains a text command, and Show suggested retains an emphasized button.

The header reserves favicon and metric space before live data arrives. Cache
status occupies that reserved area; loaded/fallback icons have fixed dimensions.
On narrow screens, the favicon bank and metric row scroll horizontally rather
than changing height as their contents arrive.

Passive whole-page redraws wait while a control is hovered or focused, retaining
only the newest queued model. Leaving the control applies that model. Explicit
commands update immediately; delayed Undo uses its existing restoration marker
to bypass the hold. Frequent tab counts and closures remain live through the
bank's own focus recovery. Open disclosures and keyed controls keep their state
across an explicit redraw.

Verification: Chromium fixtures exercise metadata reduction, native links,
hover/focus stability, command bypass, delayed Undo, fallback images, and header
geometry at 1440, 1024 and 390px. They do not establish user performance benefits.
