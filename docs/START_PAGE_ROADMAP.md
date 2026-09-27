# tabtopia start page: roadmap and technical plan

> Draft, 2026-07-19. This turns the start-page ideation into an implementation sequence. The immediate product bet is deliberately narrow: recognize the user's browsing state and make useful predictions end to end on the existing main new-tab page before unifying the alternate views.

## Product promise

The start page should help the user recover place and momentum. It should recognize whether the user is beginning, continuing, reinstating work after a short interruption, reorienting after an extended return, or handing work off from another device, then make the next useful action fast and keyboard-accessible.

Chrome's Omnibox remains the precise recall path for finding and switching to a known open tab. The start page is for orientation, contextual continuation, habitual navigation, and deliberate exploration of browsing memory.

## Sequencing decision

1. Build state recognition and prediction end to end on the existing main new-tab page.
2. Measure whether the recognized state and ranked actions are useful.
3. Replace the separate HTML destinations with one application shell that preserves URL addressability.
4. Bring List, Treemap, Graph, Sessions, and Landmarks into that shell as linked lenses over shared state.
5. Raise the visual bar with semantic zoom, connected micrographs, hero imagery, and space-filling typography once the interaction model is stable.

This order prevents an application-shell rewrite from becoming a prerequisite for learning whether the core product behavior is right.

## Jobs to support

### Routine

- Go to a frequently used destination with zero query.
- Use time, weekday, current task, previous page, and learned sequences to distinguish contextual habits from a generic most-visited grid.
- Keep the top habitual actions immediately keyboard-accessible in every recognized state.

### Begin

- Start deliberately in a clean field.
- Resume a page starred in passing: starred, low dwell, not meaningfully revisited, and not already active.
- Offer deferred intentions as possible beginnings rather than as a bookmark dashboard.

### Reinstate

- Recover the morning's work after lunch or another interruption.
- Resume a coherent task living in another window.

### Handoff

- Continue recent work synchronized from another device.
- Use `VisitItem.isLocal === false` as evidence of a foreign visit.
- Say "another device" unless a synced-session match provides a trustworthy device name; never infer "phone" from a non-local history item alone.

### Retrace

- Backtrack from a dead end to a meaningful fork and restart along a different trail.
- Recover the search result, hub, referrer, or branch through which a useful page was found.
- Recover a peripheral branch opened during otherwise coherent work.

### Reorient

- Return after an overnight or otherwise extended boundary with a compact account of active clusters, last positions, unfinished branches, and landmarks.
- Prefer a summary and choice of working context over blindly reopening the last endpoint.
- Understand what a tab-heavy window has become.
- Resume a comparison among parallel sources.
- Search by remembered meaning and see a result in its browsing context.

Cleanup, bulk organization, and automatic tab movement are later jobs. They should not complicate the first prediction and recognition loop. Explicitly closing one selected open tab remains a useful focus action in the core experience; deferring cleanup does not require removing that capability.

## State model

### Recognized environment

The classifier produces one primary environment state plus confidence and human-readable evidence.

| State | Recognition sketch | Page's primary job |
|---|---|---|
| **Launch** | Little meaningful live work here or elsewhere | Offer habitual destinations and promising new beginnings |
| **Threshold** | Current window is clean; live work exists elsewhere; no substantial interruption | Preserve a fresh center while keeping existing work nearby |
| **Reinstatement** | Current window is clean; coherent work exists elsewhere; a moderate activity gap indicates an interruption | Reconstruct and resume the interrupted working context |
| **Reorientation** | Current window is clean; substantial live work exists elsewhere; the interruption is extended or crosses a meaningful local-day boundary | Summarize the prior working landscape and let the user choose where to restart |
| **Continuation** | Meaningful sibling tabs exist in the current window | Summarize the current undertaking and expose its likely next branches |
| **Handoff** | Recent non-local visits or synced foreign sessions form a coherent trail | Continue cross-device work locally |

A new window is evidence, not intent. A clean new window after lunch and a busy morning elsewhere should produce Reinstatement; an eight-hour return to substantial existing work should produce Reorientation, not automatically Launch or a higher-confidence Reinstatement.

### Explicit interaction modes

Explicit user intent overrides inference without destroying it:

- **Search**: `/` opens a stable, list-first search workspace from the first character.
- **Lens selection**: an explicit List, Treemap, or Graph route overrides the adaptive default composition.
- **Deliberate new start**: the user can dismiss a reinstatement, reorientation, or handoff proposal and keep the clean field.

Routine is a universal fast path, not a mutually exclusive environment state. Habitual destinations may be useful during Launch, Threshold, Reinstatement, Reorientation, Continuation, or Handoff.

### Density regimes

Density controls representation; recognized environment controls editorial stance.

| Meaningful items in a connected component | Default rendering |
|---|---|
| **1–2** | Direct typography and actions; do not draw a graph |
| **3–7** | Fully labeled routes and branches |
| **8–15** | Grouped micrograph with important titles readable |
| **16–30** | Cluster-level overview with semantic zoom |
| **30+** | Several component-level micrographs rather than one hairball |

Apply density per connected component, not to the undifferentiated global tab count. Forty tabs spanning four tasks should become four useful neighborhoods, not a forty-node graph.

### Neighborhood evidence and rendering

A neighborhood is a connected browsing task, not a browser window. Seed strong
edges from referrer/navigation provenance and tab-spawn/opener relationships,
then add bounded weaker edges from temporal co-activity. Window membership is
metadata only. Temporal overlap must not use a directional arrow or imply that
one page caused another.

**Nodes are pages, not tabs** (generalized 2026-07-24). A tab-only node source
made the graph structurally empty in exactly the states that need it most:
Handoff and Reorientation are *defined* by the absence of live tabs, so
"0 components" was guaranteed rather than measured. Recent history visits are
therefore nodes too, keyed by URL identity, and a visit whose page is already
open merges into that tab's node rather than duplicating it. Every item carries
`open: true|false` so no surface can imply a closed page is still live.

Chrome's `VisitItem.referringVisitId` is the load-bearing addition: it is the
only structural evidence that outlives the tab that produced it, and it turns a
post-restart pile of URLs back into a directed trail.

Two bounds keep the wider node set from degenerating:

- **Per-node temporal degree** (unchanged) caps how many overlap edges a node may take.
- **A component activity-span budget** (default 30 minutes) refuses a temporal
  merge that would stretch a component beyond it. Structural edges are exempt —
  a followed link is a real join however long ago it happened. The budget cannot
  bound a *single* page's own span; one URL revisited all afternoon is still one
  page, and that is correct.

Choose the lightest renderer that preserves the topology:

- **1 page:** space-filling HTML typography and direct actions.
- **2 pages:** a typographic pair whose connective phrase names the evidence
  (`opened from`, `followed from`, or `active together`).
- **3–5 pages:** an HTML/CSS trail, fan, or comparison with real links in DOM
  reading order.
- **6–10 pages:** a hybrid with DOM labels and minimal SVG connectors.
- **Larger components:** compact SVG micrographs or a summarized component.

Keep native HTML as the accessible interaction layer. Pretext may later replace
the text-measurement and Canvas rendering layer for richer semantic zoom, but it
must be vendored and pinned for the extension rather than loaded remotely under
Manifest V3 CSP.

Before ranked actions depend on these components, keep a development-only
topology audit available behind progressive disclosure. It must expose every
component, isolate and largest-component counts, structural versus temporal
edge totals, and the exact directional provenance for each join. Use it to
reject causal wording errors, temporal mega-components, false merges, and
obvious false splits against a mixed live session.

### Existing compact treemap

The toolbar popup already contains a tidy equal-area treemap: tabs are grouped by window, every tab receives the same area, and recency affects ordering/color rather than size. Treat this as a reusable **live-work mosaic**, distinct from the main Treemap's investment semantics.

Good adaptive uses:

- **Threshold:** preview the live windows surrounding a clean current window.
- **Reinstatement:** show the still-open working set that existed before the interruption.
- **Reorientation:** summarize active neighborhoods before asking the user to choose a restart point.
- **Continuation:** provide a compact overview when the current window is too dense for direct typography but does not yet need a full spatial lens.
- **Search:** show the open neighborhood surrounding the selected result while the exact results remain list-first.
- **30+ tabs:** render several compact mosaics by connected component instead of one global hairball.

Do not show it merely to fill space in low-density Launch. Foreign history is not live tab state; that generalization has now been made deliberately (see "Nodes are pages, not tabs" above), so Handoff may use this renderer provided each item's open/recovered status stays visible in the rendering itself.

Extract one renderer that accepts normalized neighborhoods and action callbacks; do not copy the popup's current data fetching and D3 code into the main page. The same module should continue to serve the popup so keyboard, selection, color, and activation behavior cannot drift.

## Interaction contract

The visual composition may adapt; the interaction grammar must remain stable.

- `/`: enter start-page search.
- `Up` / `Down`: move through ranked actions or search results.
- `Left` / `Right`: move through parent/child or connected neighbors in a spatial lens.
- `Enter`: activate or focus the selected destination.
- `Cmd/Ctrl+Enter`: open or continue without replacing the current context.
- `Space`: preview or expand context.
- `S`: star or unstar the selected page when focus is not in a text field.
- `Delete`: close the selected open tab when focus is not in a text field, with an immediate Undo action.
- `Escape`: close detail, then clear search, then return to the prior orientation state.
- `Tab`: traverse real controls in DOM order.

Do not override browser-standard shortcuts. Search, selection, and focus must survive lens changes. The List is the exact, accessible fallback even when a spatial rendering is primary. Visible close controls must be real keyboard-operable controls rather than hover-only SVG targets.

## Ranking and recognition architecture

### 1. Browsing snapshot

Create a single normalized snapshot consumed by both the classifier and candidate generators. It should contain:

- Current window and meaningful sibling tabs, excluding the tabtopia page.
- Other open windows and their tabs.
- Last-focused window and tab when available.
- Qualified access timestamps, dwell, and transitions.
- History visits with `isLocal` retained.
- Bookmarks with `dateAdded` and nearby access/dwell evidence.
- Interruption gap, current local-time offset, and whether a substantial interruption crossed the local day boundary.
- Connected components or provisional task clusters.
- Existing Bayesian History/Context scores and baseline frecency/MRU scores.

The first version should use transparent deterministic rules. It should return its evidence rather than hiding the decision behind an opaque classifier.

```js
{
  state: "reinstatement",
  confidence: 0.82,
  evidence: ["clean-current-window", "47-minute-gap", "12-related-tabs-in-window-4"],
  neighborhoods: [],
  generatedAt: 0
}
```

The Reinstatement interruption boundary may adapt from the local qualified-access
corpus. Fit a two-component mixture to log inter-access gaps and use the point
where a within-burst return and a later return are equally likely. Report the
25%-to-75% posterior transition as the uncertainty window. The estimate stays
on-device, consumes timestamps rather than URLs, requires enough samples and a
clearly separated bimodal fit, and must remain within the reviewed 10-to-60
minute product range. Sparse, unstable, unimodal, or out-of-range fits retain
the established 30-minute boundary. Reorientation remains a separate extended-
return decision and is not learned from this session-scale estimate.

### 2. Candidate generators

Generate candidates by job before ranking them together:

- **Habit candidates** from page/domain access histories and recurring transitions.
- **Deferred-intention candidates** from low-dwell, unrevisited stars.
- **Continuation candidates** from the current component and its active endpoints.
- **Reinstatement candidates** from coherent external components active before an interruption.
- **Reorientation candidates** from active clusters, their last meaningful endpoints, and durable landmarks after an extended return.
- **Handoff candidates** from recent non-local visits and, later, synced-device sessions.
- **Retrace candidates** from referrers, hubs, branch points, and peripheral endpoints.

Each candidate should carry its source, supporting evidence, available actions, and a stable page/session/component identity.

### 3. Bayesian temporal extension

Retain the current History and current-page Context terms, then test temporal likelihood cues independently:

```text
score(i) = History(i) + PageContext(i) + TimeOfDay(i) + WeekdayClass(i)
```

- Use a circular time kernel rather than hard morning/afternoon buckets.
- Begin with workday/weekend to avoid seven-way sparsity.
- Smooth page evidence toward domain evidence, then toward the user's global baseline.
- Treat insufficient evidence as neutral.
- Bound each experimental term and require measured lift before promotion.
- Preserve local-time offset at capture time for new events.
- Add timestamped transitions if time-conditioned routines prove useful.

Recency and time of day are distinct: recency measures elapsed time; temporal compatibility measures periodic habit.

### 4. State-aware ranking

Do not force every job through one unexplained weighted score. Use the recognized environment to select candidate sources and an interpretable ranking policy:

- Launch emphasizes habits and deferred intentions.
- Threshold emphasizes habits while keeping external neighborhoods available.
- Reinstatement emphasizes pre-interruption components and their last meaningful endpoints.
- Reorientation emphasizes a compact working-landscape summary and high-confidence restart points rather than immediate endpoint activation.
- Continuation emphasizes the current component, its likely next pages, and branch recovery.
- Handoff emphasizes recent coherent foreign activity.

Unavailable evidence is neutral. The UI must not make predictive claims stronger than the evidence or evaluation supports.

#### Resumption forecast (implemented)

`resumption-forecast.js` ranks whole neighborhoods — activities, not pages — by
how likely the user is to resume them. Seven bounded cues, each reported as
evidence rather than folded into an opaque number:

| Cue | Reads |
|---|---|
| `recency` | 2-hour half-life decay on last activity |
| `explorationDepth` | task progression and branching; neutral when no typed task projection is available |
| `investment` | pages plus repeat visits, log-scaled |
| `structure` | share of edges that are followed links rather than coincidence |
| `unfinished` | share of arrivals that came by following something — a trail cut part-way |
| `habit` | visits per page above one; repeated returns predict another |
| `provenance` | local versus another device |

Each recognized state supplies its own weight row plus an `open` policy
(`prefer` / `neutral` / `damp`) and an entry policy. Reorientation targets the
component's **entry point** — the hub the trail started from — because
restarting there recovers the abandoned branch that an endpoint cannot;
Reinstatement targets the endpoint instead. Already-open work is damped and
labelled a switch, not a resume.

Confidence is computed separately from score and capped at 0.9. A component
joined only by temporal coincidence loses confidence rather than score, so the
surface can decline to make a strong claim instead of silently dropping
candidates. Unavailable cues resolve to 0.5, never 0.

The weights are hand-set policy, not learned. They are the interpretable
baseline any later calibrated model has to beat.

#### Cross-device continuation refinement (active)

Cross-device work must compete inside Continuation rather than requiring a
mutually exclusive Handoff state or a permanent source rail. Provenance explains
a prediction after ranking; it does not own a section of the page.

Rough delivery sequence:

1. **Task projection — implemented vertical slice.** Recognize an exact Google
   query with at least two structurally followed result branches. Project Maps
   URLs into search, place, comparison, and directions stages while ignoring
   viewport and zoom churn. Preserve the exact recorded URL as the action target.
2. **Blended continuation — implemented as a bounded probe.** Keep one focal
   activity. During Continuation, admit at most one non-primary activity into
   visible side routes when recent foreign evidence is strong, or when a typed
   search/Maps task has sufficient depth and recency. Directions retain a short
   eligibility horizon.
3. **Source completeness and downstream summaries — next.** Audit which Chrome
   synced-history records reach the local archive, preserve trustworthy remote
   provenance without guessing a device, and define the export contract used by
   the optional local archive companion. Once that boundary is verified, make
   remote exploration eligible for its interest summaries as evidence, not as
   an automatic claim of durable interest.
4. **Calibration — next.** Replay recent local fixtures and record only
   content-free outcomes: surfaced, opened, ignored, dismissed, and time-to-open.
   Tune promotion thresholds and depth bands only if they beat the current
   deterministic policy. Do not silently learn production weights.
5. **Broader task grammar — later.** Consider explicitly linked query
   reformulations, richer Maps place comparison, and named synced devices. Do
   not merge semantically similar queries or infer phone origin without new
   evidence and review.

Required fixtures cover: zero/one/multiple search-result clicks; a deeper branch
after a result; Maps pan/zoom variants; place comparison; place-to-directions;
recent versus stale foreign singletons; and mixed live-desktop plus recovered
foreign activity. The visible proof keeps exactly one focal activity and makes
the qualified runner-up keyboard reachable.

## Learning and feedback

The first system is adaptive, but it is not a conventional supervised-ML layer:

- The Bayesian revisit model learns online from qualified accesses and transitions.
- Temporal-context variants learn compact per-page and per-domain rhythms.
- State recognition begins as deterministic, explainable rules.
- Ranking diagnostics compare candidate models but do not silently train production behavior.

An explicit suggestion dismissal is relatively clean negative feedback about that suggestion. Closing a tab is useful evidence but semantically ambiguous: it may mean completed, irrelevant, duplicated, accidentally opened, or merely moved out of the way. Record the surrounding action sequence for evaluation rather than directly decrementing a page's rank:

- Close immediately after a suggested page is opened: possible strong negative outcome.
- Close without activating: possible clutter or duplicate signal.
- Close after meaningful dwell: possible completion signal, not disinterest.
- Several closes in quick succession: cleanup-mode evidence, not a series of independent content judgments.
- Undo: invalidate the close as negative feedback.

These events should enter bounded local diagnostics first. After M3 produces enough evidence, a later calibrated policy may learn per-user cue weights or state thresholds on-device. That is optional and must outperform the interpretable Bayesian/rule baseline; no opaque learning layer is a prerequisite for the roadmap.

## Milestones

### M0 — Baseline and contracts

**Goal:** Establish fixtures, schemas, and performance baselines before changing the main page.

- Define `BrowsingSnapshot`, `RecognizedState`, `Neighborhood`, and `ActionCandidate` contracts.
- Add deterministic fixtures for Launch, Threshold, after-lunch Reinstatement, extended-return Reorientation, Continuation, and foreign-device Handoff.
- Record `VisitItem.isLocal` in normalized history data.
- Confirm the existing history snapshot/cache can supply the main page without another cold-start waterfall.
- Add unit tests for URL identity, interruption boundaries, component density, and state evidence.

**Exit gate:** Every fixture produces a deterministic state and explainable evidence; no UI change is required.

### M1 — State recognition on the main tab

**Goal:** Make the existing new-tab page recognize its environment end to end.

- Build the deterministic state recognizer.
- Add a development-only inspector showing state, confidence, evidence, density, and candidate-source counts.
- Make recognition asynchronous and non-blocking: the page shell and search path render immediately.
- Test browser restart, service-worker restart, empty profile, large history, and multiple-window cases.

**Exit gate:** All six primary states are reproducible in tests and inspectable in the development build without destabilizing the current Treemap.

### M2 — Ranked actions vertical slice

**Goal:** Deliver useful predictions on the existing main tab without waiting for the application-shell rewrite.

- Add habitual destination candidates.
- Add deferred-intention star candidates.
- Add current-window continuation plus external-window reinstatement and reorientation candidates.
- Add recent non-local handoff candidates labeled conservatively.
- Render one keyboard-first ranked action list with a state-specific hero summary.
- Extract the popup's equal-area treemap as a reusable live-work mosaic and use it for dense Threshold, Reinstatement, Reorientation, and Continuation previews.
- Preserve explicit single-tab close as a secondary action, make it keyboard-operable, and provide Undo; do not introduce bulk cleanup controls.
- Preserve the current Treemap below or behind this vertical slice rather than rewriting it.

**Exit gate:** From page load to activation, every primary action can be completed with the keyboard; dismissing an inferred state exposes a deliberate clean start.

### M3 — Search and evaluation

**Goal:** Validate recognition and ranking before broadening the visual system.

- Make `/` enter a stable, list-first search state from any recognized environment.
- Keep Omnibox `tt` responsible for direct open-tab recall; start-page search spans sessions, stars, history, and connected context.
- Preserve query and selection when returning from previews or changing the temporary lens.
- The local shadow study now compares MRU, investment, same-domain, strip-neighbor,
  transition, frecency, History-only, and page/domain/hierarchical Bayesian variants.
- Keep diagnostics opt-in and default off for ordinary installs, on for unpacked development installs.
- The Settings report now includes top-1, top-3, top-4, MRR, coverage,
  censoring, calibration, open-tab bands, session-age bands, and latency. Adding
  activation/dismissal segmentation by recognized start-page state remains open.

**Exit gate:** The state-aware model demonstrates useful lift or reveals which candidate sources should be removed. Search remains responsive even while recognition and history enrichment are incomplete.

### M4 — One application shell with permalinks

**Goal:** Remove cross-page context loss without changing every visualization at once.

- Introduce one `newtab.html` application shell and a shared selection/search/state store.
- Use extension-safe hash routes such as `#/list`, `#/treemap`, `#/graph`, `#/sessions/:id`, and `#/search?q=...`.
- Keep bare `newtab.html` adaptive; explicit routes request an explicit lens.
- Put semantic state in the URL: lens, scope, stable focus identity, query, filters, grouping, sorting, and meaningful zoom level.
- Keep hover, transient focus, animation, and ordinary pixel pan out of canonical links.
- Use `pushState` for meaningful context changes and `replaceState` for lightweight selection.
- Preserve existing page URLs through compatibility redirects or shims.

**Exit gate:** Back/Forward, reload, and copied links restore meaningful context; query and selection no longer reset when changing lenses.

### M5 — Migrate and link the existing lenses

**Goal:** Bring existing capabilities into the shared shell without erasing their distinct jobs.

- **List:** exact titles, recency, scanning, keyboard actions, and accessible fallback.
- **Treemap:** investment, relative importance, domain grouping, and cleanup pressure.
- **Graph:** connectedness, paths, branches, and provenance.
- **Sessions:** interruption-scale routes and task reconstruction.
- **Landmarks:** saved anchors and deferred intentions.
- Synchronize selection, search, scope, and focus across lenses.
- Apply the density regimes to choose the adaptive default composition while retaining explicit lens controls.

**Exit gate:** The separate destinations are no longer required for normal use, and changing lenses never makes the user rebuild query or context.

### M6 — Connected micrographs and signature typography

**Goal:** Raise the aesthetic and information-design bar after the behavioral spine is proven.

- Group tabs and history by inferred connectedness rather than window or domain alone.
- Render several small, high-utility browsing graphs instead of global hairballs.
- Use hero graphics as evidence-bearing orientation, not decoration.
- Use Pretext or an equivalent substrate for space-filling, semantic-zoom typography.
- Give negative space semantic meaning, especially in Launch and Threshold.
- Preserve readable contrast and keyboard focus at every zoom level.
- Prototype braided route rendering for Sessions and focused context aperture inside Graph.

**Exit gate:** Each density regime remains readable and actionable with real profiles, and the visual system improves task performance rather than merely making the page novel.

## Home density and enrichment execution note — 2026-07-26

The current Home takeover expands content without weakening source boundaries:

- Habit and star generators admit up to 10 candidates each; the composed feed
  admits up to 18 actions through the existing alternating source slots. Habit,
  star, and activity scores remain incomparable and are never summed.
- The first tier keeps one focal route plus up to five nearby routes. Engaged
  Side routes stay capped at four so they cannot consume the lower Discovery
  panel. Discovery may render up to 10 otherwise unrepresented actions.
- Archive enrichment rises from four to six items and exposes up to eight
  aggregate tag-derived Interest threads as a separate compact panel.
- GitHub stars are a separate explicit-interest source, not the Chrome-bookmark
  Star lane. The Interests service exposes the daily star export through a
  read-only local endpoint; Home reads its last good six-hour cache for first
  paint and refreshes in the background. Archive topics and visible Home titles
  rank related repositories first, then recent stars fill the bounded eight-item
  panel. Repository topics and starred dates retain provenance, while enrichment
  relevance never enters habit, bookmark, activity, or session evidence.
- Techmeme is an enrichment-only bottom panel. Home reads a 20-minute local
  cache for first paint, refreshes `https://www.techmeme.com/feed.xml` in the
  background, retains only plain titles and validated Techmeme permalinks, and
  filters locally against archive topics and visible Home-title vocabulary.
  Techmeme relevance never enters prediction evidence.
- Titles use placement-specific, Unicode-safe grapheme budgets with publication
  suffix removal and word-boundary ellipses. A single viewport-aware overlay
  reveals the full title on fine-pointer hover or keyboard focus without
  reflow; Escape dismisses it while preserving focus.
- Every URL destination is a native anchor with a validated HTTP(S) `href`.
  Ordinary activation still uses the canonical switch/open executor, while
  modifier-click, middle-click, context-menu opening, copying, and browser link
  previews remain native. View-changing commands remain buttons. Decorative
  outbound arrows are omitted; large linked typography, hover underlines, and
  a three-pixel focus outline carry the affordance.
- The Home canvas expands to 1680 px, destination type scales rise across every
  tier, and repository/news enrichment uses three columns on wide screens. This
  fills the available field with more legible content rather than whitespace or
  repeated icon chrome; narrow layouts retain one-column sequential reading.

The proof gate is deterministic unit coverage for cache behavior, source
validation, relevance-plus-recency ranking, RSS filtering, title shortening,
and source bounds, plus extension-loaded browser coverage for non-blocking first
paint, panel ordering, action execution, keyboard/hover dismissal, narrow-screen
containment, modifier-click new-tab behavior, sequential Tab/Shift+Tab order,
Enter activation, visible focus, and escaping.

## Home activity-graph prototype — 2026-07-30

Engaged Home may default its Current activity panel to a compact graph when the
canonical neighborhood contains enough reproducible structure. This is an
explanatory lens over the activity, never new ranking evidence:

- The graph requires 3–10 display roles and at least two evidenced referral or
  tab-spawn joins. A weak temporal-only component stays in the existing link
  view. Structural arrows come only from evidence records that name both ends;
  temporal overlap is undirected and dashed.
- The display projection groups query variants by origin and pathname into a
  labeled page role, retains its record count, and links to a real recorded
  representative. The adjacent **Links** toggle preserves the exact recorded
  pages and their original DOM order, so grouping never removes access to an
  individual visit.
- Labels describe observable structure only: earliest, latest, seen order, and
  repetition. The renderer does not infer goal, detour, upsell, escape, or
  recovery semantics from one trace.
- Favicons come only from Chrome's local cache. They appear at recorded domain
  run boundaries, not on every card; an OAuth parameter cannot manufacture a
  Google node, while an actual `accounts.google.com` page can.
- Four or more roles use a two-row serpentine layout with DOM anchors above
  minimal SVG connectors. At narrow widths the SVG disappears and the same
  anchors become a contained sequential list. Graph and Links are real buttons
  with pressed state, arrow-key switching, visible focus, and preference
  persistence across Home re-renders.

The prototype gate is deterministic projection coverage plus an
extension-loaded browser proof of the default graph, real hyperlinks, favicon
boundaries, repeated transitions, keyboard reversal, retained Links view,
re-render persistence, and 390-pixel containment.

## Query-owned retrieval SERP — 2026-08-01

A non-empty header query now overrides the adaptive Home composition with a
dedicated, list-first retrieval surface. The previous path only indexed open
tabs and dimmed treemap cells; because Home hides the treemap, it gave no useful
visible response and could never refind a closed recent page.

- Open tabs and the 180-day Chrome History horizon are searched together and
  merged by stable page identity. An open match becomes a Switch action without
  duplicating its History row; a closed match opens in the launcher tab.
- Every query token must match title, site, or URL. Text match is the admission
  gate; recency and repeat visits order only already-matching pages, so a fresh
  unrelated visit cannot enter the result set.
- Open and controller-cached matches paint immediately. A bounded direct Chrome
  History query completes the set; request identity prevents a slow old query
  from overwriting a newer one.
- Results are real HTTP(S) anchors. Ordinary activation uses the canonical
  switch/open executor, while modifier-click, middle-click, copy-link, and the
  browser context menu remain native.
- Arrow keys move through result anchors, Enter activates the first result from
  the query box, Tab enters the result list, and Escape clears the shared query
  and reveals the prior Home/treemap state. The within-session query carrier and
  no-restart persistence boundary remain unchanged.

The proof gate includes a visited-then-closed History fixture, open/History URL
deduplication, native modifier navigation, Enter activation, stale-response
rejection, query carry/clear/restart behavior, and 390-pixel containment.

## Measurement plan

### Ranking quality

- Top-1 and top-3 activation rate.
- Mean reciprocal rank.
- Lift over MRU and frecency.
- Lift from time-of-day and weekday terms independently.
- Accuracy segmented by recognized state and candidate source.

### State quality

- Immediate acceptance of the primary action.
- Dismissal or deliberate-new-start rate.
- Close outcomes segmented into unactivated close, post-dwell completion, rapid cleanup burst, and Undo.
- State overrides.
- Time to first meaningful action.
- Reinstatement success: focus/open within the proposed pre-interruption component.
- Reorientation success: choose an active cluster or deliberate new start after inspecting the working-landscape summary.
- Handoff success: local opening of a proposed recent foreign visit.

These are behavioral proxies, not proof of intent. Development tooling should make it easy to inspect incorrect classifications and their evidence.

### Performance budgets

- The shell, keyboard focus, and search affordance must become usable before history enrichment completes.
- Warm prediction should feel immediate and must reuse the shared history snapshot.
- Cold prediction may progressively enrich, but must not block the first actionable list.
- Large-profile tests must cover the real failure mode: hundreds of thousands of history rows and several open windows.

Record concrete latency budgets after measuring the current warm and cold paths rather than inventing thresholds without a baseline.

## Privacy and permissions

- All recognition and ranking remain on-device.
- Ranking diagnostics remain bounded, local, opt-in, and content-free; turning them off deletes their buffer and pending prediction.
- `history` already exposes `VisitItem.isLocal`; capturing local versus foreign visits requires no new permission.
- Named synced-device sessions require the `sessions` permission. Treat that as a later, separately reviewed enhancement; non-local History alone is sufficient for the first conservative Handoff state.
- Never present foreign activity as mobile activity without trustworthy device evidence.

## Suggested module boundaries

These are boundaries, not mandatory filenames:

```text
src/lib/browsing-snapshot.js     normalized input assembly
src/lib/start-state.js           deterministic recognition + evidence
src/lib/start-candidates.js      job-specific candidate generation
src/lib/temporal-context.js      circular time/day likelihoods
src/lib/cross-device.js          non-local visit and synced-session logic
src/lib/start-ranking.js         state-aware ranking policies
src/lib/ranking-diagnostics.js   bounded local evaluation

src/newtab/start-controller.js   main-page orchestration during M1–M3
src/newtab/compact-treemap.js    shared popup/main live-work mosaic
src/newtab/app-router.js         single-shell routes introduced in M4
src/newtab/app-state.js          shared query, selection, scope, and lens state
```

Keep pure scoring and recognition modules free of Chrome APIs so they remain fast to replay and easy to test. Chrome-specific data access belongs in the snapshot adapter.

## Explicitly deferred from the first vertical slice

- Rewriting the Treemap, Graph, Sessions, or Landmarks renderers.
- A framework migration or build-system change.
- Automatic or bulk tab cleanup, grouping, or movement. Explicit single-tab close remains supported.
- Exposed "we predict your next tab" product language before evaluation clears the existing gate.
- Remote analytics or opaque machine learning.
- Exact mobile-device attribution without synced-session evidence.

## Immediate implementation slice

The next build should be small enough to review and test independently:

1. Preserve `isLocal` when normalizing `chrome.history.getVisits()` results.
2. Add pure state-recognition contracts and fixtures.
3. Recognize Launch, Threshold, Reinstatement, Reorientation, Continuation, and conservative Handoff.
4. Expose the result in a development inspector on the existing main page.
5. Add a keyboard-first ranked action region fed initially by existing Bayesian, frecency, open-window, bookmark, and foreign-visit signals.
6. Extend diagnostics by state before adding temporal or connectedness complexity.

That produces the shortest path from the current codebase to a falsifiable product behavior.


## Predictivity investment — 2026-09-22

The first slice repairs the evidence needed to choose a better ranker:

- Next-tab study V3 excludes qualified accesses that remain on the source tab.
  The shared access timer runs after URL changes and load completion as well as
  activation, so those events previously inflated out-of-candidate censoring.
  An active tab in an unfocused window cannot qualify an access.
- A fresh cohort separates this change in observation semantics from V2. No
  historical accuracy claim is transferred to the corrected cohort.
- A 90-day daily aggregate store survives the detail buffer (up to 5,000 compact
  records within 2 MiB, expanded on 2026-09-28) and
  service-worker restarts. It retains the existing weekly comparison,
  calibration, coverage, censoring, and segment metrics without browsing
  content or identifiers. Settings displays the cohort, days with observations,
  and a conservative latency bound. Disable and Clear remove both stores.

This does not establish improved Home prediction accuracy. The next-tab study
compares choices among open tabs; Home additionally offers habitual closed
pages, deferred bookmarks, and activity continuations. Its alternating source
slots do not represent a single comparable probability scale. Before changing
that composition, measure the actual displayed destinations and qualified
outcomes by recognized start-page state, including off-list destinations and
search departures. Evaluate open-tab returns and closed-page reopening as
separate tasks, with MRU as the open-tab baseline. Preserve source provenance
and the existing canonical action executor. Do not infer Home ranking quality
from all-day next-tab accuracy or merge incomparable lane scores.

## Featured destinations and recommendation measurement — 2026-09-27

Home now features up to three `home-recs-v3` actions from inferred or explicitly
selected hubs, revisited history, documents, Chrome bookmarks, bookmark support
within URL paths, and optional fresh 30-minute semantic context. Existing primary
routes move into “Your other routes” when recommendations are available. Without
eligible recommendations the existing Home composition returns; Start fresh
continues to hide suggestions. Open destinations use the canonical Switch action,
and closed destinations use canonical in-place navigation.

The 2026-09-28 policy reserves one available slot for an unresolved Mobile-folder
bookmark, including pages never visited on this desktop. A brief opening does
not discharge that cue; a separate thirty-second foreground-visit proxy does.
V3 uses new study/pending keys and preserves explicit snooze preferences. See
the [revisit research plan](REVISIT_RESEARCH_PLAN.md) for the implemented general
return bootstrap, bookmark observation limits, embedding input design, and
Cartographer use cases. No predictive or causal lift has yet been established.

The complete [algorithm and signals reference](HOME_RECOMMENDATION_ALGORITHM.md)
records candidate bounds, identity rules, every scoring weight, hub thresholds,
bookmark smoothing, a reproducible worked example, selection and locking,
semantic freshness, measurement lifecycle, privacy, and proposed extensions.
It is the implementation reference for this policy; scores are heuristics, not
probabilities or calibrated next-tab accuracy.

### Evidence, not seeded destinations

No install has default personal hubs. The initial Stats/Cartographer development
seeds were removed after the user requested genuine discovery. Explicit favorites
saved in Options remain a separate preference, limited to twelve URLs.
A recently visited non-document URL with no query becomes an inferred hub with
at least twelve accumulated visits, or three visits and two distinct revisited
descendant paths. Capped logarithmic repeat/breadth support decays with age. Only
observed destinations are candidates; ancestor URLs are never invented.

Chrome visit counts are cumulative, not counts of recent independent sessions.
Last visit must be within 28 days for ordinary history and inferred hubs, while
documents receive a 180-day horizon and preferred shortlist position. Qualified
visit fields are supported by the ranker but are not yet supplied by the live
Chrome-history collector. Local app ports distinguish identities and sites.
Cartographer memory documents group by their decoded file paths, preserving the
actual navigation URL and filters. Other queries continue to distinguish pages.

Bookmark density means distinct Chrome-bookmarked pages under URL path segments,
not GitHub stars. A hub receives its own subtree's support; a GitHub profile does
not inherit every bookmark on github.com. Ordinary documents can receive sibling
support. Pseudocount smoothing, capped bonuses, and bounded source scans limit the
influence and cost of this signal.

### Recent context and preferences

The public build has no supplemental context service connection. Previously
stored context can be read locally until it expires; history, documents and
bookmarks work independently of supplemental sources.

Hide site and one-day Snooze each provide immediate Undo; Options can restore
hidden sites. No install has a default personal site exclusion.

### Diversity, stability and learning what works

Each Home document assigns balanced or explore with equal probability when
exploration is enabled. Explore offers one supported alternative from a bounded
pool. Diversity usually permits one action per site, with an allowance for a hub
and a distinct document. A visible slate stays stable through feedback and late
context arrivals. Show alternatives excludes the immediately previous slate;
small pools may return fewer than three actions or cycle back to older slates.
Local exposure fatigue and recent engagement reduce repetition on later pages.

The existing diagnostics switch controls local measurement and feedback. The
V2 report separates visible slates, individual exposures, attempted standard
clicks, ten uninterrupted focused seconds, early departures after arrival, and
snoozes by policy. Engagement validates destination identity and tab ID. Native
modifier clicks are not attributed; worker restarts and missing outcomes can
undercount engagement. Visibility has no minimum duration or gaze requirement.

Durable storage retains 28 UTC days of policy totals and HMAC destination
feedback, plus at most 500 content-free details. Raw pending identities remain
in bounded session storage. Clear/disable removes measurement and feedback;
explicit favorite, hidden-site and snooze preferences persist. Normal installs
default measurement off; development installs default on unless changed.

This report is separate from the older observational `home-context-v1` cohort
and the independent open-tab shadow study. Shared feedback across arms, repeated
observations from one person, manual alternatives, censoring and small samples
make arm comparisons descriptive rather than clean causal lift estimates.
Tests establish implementation contracts, not recommendation utility. The next
step is natural-use evidence, followed by instrumented experiments on qualified
revisit days, transition-derived hubs, temporal routines, multiple semantic
clusters and topic/path diversity as described in the algorithm reference.
