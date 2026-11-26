# Prediction exposure plan

> Draft, 2026-11-26. Moves `learned-combiner-full-v1` from the next-tab shadow
> study into UI. Phase 4 of [OMNIBOX_SPEC.md](OMNIBOX_SPEC.md#phase-4--prediction-experiment).
> This document is the "holdout or interleaving plan" the exposure gate's last
> criterion requires; the gate's computed criteria already read READY.

## Evidence at the start

All figures are for one person on one development profile, so they are not
general lift. Replay was run against the 2026-11-26 storage dump and is
`FAITHFUL` (0 rank mismatches in 17,780). Training cutoff is 2026-11-06, so
every row below is held out.

| 889 replay rows, 11-16 → 11-26 | top-1 | top-3 | MRR | cal. err |
|---|---|---|---|---|
| learned-combiner-full-v1 | 40.6% | 73.1% | 0.598 | 0.034 |
| mru-v1 | 39.4% | 68.6% | 0.571 | 0.237 |

On 1,199 matched detail rows, the combiner minus MRU gives an MRR difference of +0.033 (95% day-block bootstrap
+0.015 to +0.047, 13 days). In top-3 the combiner wins 108 rows that MRU misses, and loses 46. In top-1 the split is 106 to 78.

Confidence is usable as a threshold up to about 0.6, but overconfident above it:

| top-candidate p | share of moments | top-1 hit | top-3 hit |
|---|---|---|---|
| < 0.3 | 26% | 22% | 59% |
| 0.3–0.4 | 23% | 33% | 68% |
| 0.4–0.5 | 22% | 46% | 78% |
| 0.5–0.6 | 14% | 48% | 75% |
| 0.6–0.8 | 13% | 53% | 76% |
| ≥ 0.8 | 3% | 69% | 88% |

The prediction is limited to open tabs. 48% of next-tab outcomes are censored, mostly
`outcome-not-candidate`. The combiner says nothing about those moments.

## Findings that change the plan

1. **The spec's first surface has no traffic.** The 37-day detail buffer holds
   1,889 next-tab outcomes and zero `omnibox_selection` or
   `omnibox_abandonment` records. An experiment on the empty `tt` query would
   not collect a sample. Switching is done elsewhere, in the tab strip or with the keyboard.
2. **Home already says "Most likely next"** for a ranking that no study evaluates.
   `renderQuiet` in `home-takeover.js` labels the first `forecastResumption`
   action that way. That ranker is a hand-weighted policy over neighborhoods
   (`resumption-forecast.js`), not a gated model. START_PAGE_ROADMAP lists
   exactly this as something not to do ("Exposed 'we predict your next tab'
   product language before evaluation clears the existing gate").
3. **The prediction already exists at the moment of use.** `recordQualifiedActivationDiagnostics`
   builds `buildShadowPredictions` at every qualified activation and keeps it
   as the pending prediction. A surface can read that ranking instead of
   recomputing it, which costs no extra latency. It can also check that the candidate set has not
   changed since.

4. **Home has no open-tab rows to reorder.** The `actions` behind "Most
   likely next" and the destinations come from `buildStartPageFeed`. They are
   habit destinations and starred pages, and an open-tab resumption only
   replaces a target when it matches one of those pages. Most rows are pages
   that are not open, so the combiner, which ranks only open tabs, cannot order
   them. Home needs a design decision before it can show the combiner. See
   [Home status](#home-status).

## Surface options

| surface | moment matches the study | traffic | cost |
|---|---|---|---|
| A. Empty omnibox query (`tt`) | yes: current tab = study's current tab | none observed | smallest; spec's choice |
| B. Keyboard command: switch to likely next (`chrome.commands`, top 3 in a small popup) | yes, and it replaces the behaviour being predicted | habit Andy would have to form | new surface, popup UI |
| C. Home's open-tab rows (`renderQuiet` / `renderReturn` focal + destinations) | partly: the current tab is the new-tab page, so features must be taken from the previous tab | real (921 recommendation exposures in 26 days) | swaps the ranker under an existing label; needs the previous-tab context |

Recommendation: **C, with A at the same time**. A costs nothing to add and stays honest. C is the
only surface with a sample, and it removes the ungated "Most likely next" label.
Hold B until A or C shows that people actually pick from a prediction.

## Experiment design (any surface)

- **Arms, randomized per surface session** (one Home render or one omnibox
  session). The treatment arm, at 80%, uses the combiner's order. The control arm, at 20%, uses the order that
  surface shows today: `forecastResumption` on Home, `rankTabs` recall order in the
  omnibox. Record the arm and its propensity on every record. The
  control arm is what keeps measuring after exposure changes behaviour.
- **Label only when confident.** Show "Likely next" on the first row only when
  the top probability is at least 0.4. That covers 52% of moments, with 49% top-1 at that
  threshold. Below it, show the same order without the label. Never
  show a percentage, because confidence above 0.6 is overconfident.
- **Typed omnibox queries are unchanged.** Prediction applies only to the empty query,
  so predicted rows stay visually and verbally distinct from typed matches, as the spec requires.
- **Stale guard.** If the pending prediction's candidate set no longer matches
  the open tabs, fall back to the control order and record
  `stale-prediction`.
- **Outcome records.** Selections record arm, `modelVersion`, the displayed
  rank of the selected item, the top-probability band, and abandonment. Next-tab outcomes gain an
  `exposureRoute` field (`none` | `home-treatment` | `home-control` |
  `omnibox-treatment` | `omnibox-control`). The shadow study and its gate continue on `none`
  only, so an exposed ranking cannot validate itself.
- **Storage.** chrome.storage.local is at about 6.6 MB of its 10 MiB quota. The new fields
  are labels interned in the existing `labels` table, and no new key is added.
  Measure the bytes before merging.
- **Kill switch.** A Settings toggle "Predict likely tabs" reverts every surface to
  its control order and stops exposure records. Clearing diagnostics also
  clears them.

## Success and stop rules

Evaluate after two seven-day windows, as the shadow gate does:

- **Primary:** the mean reciprocal displayed rank of the selected open tab is higher in
  treatment than control, in both windows.
- **Guardrails:** abandonment does not rise, and the share of Home visits that end in an
  out-of-set destination does not fall. A fall would mean the prediction is crowding out what
  people opened the new tab for.
- **Shadow consistency:** on `exposureRoute = none` rows the combiner keeps its
  MRR lead over MRU, so its behaviour has not drifted.
- **Stop** if treatment loses the primary metric in either window or breaks a
  guardrail. Revert to control and keep the shadow study running.

## Order of work

1. Land or set aside the uncommitted work on `main` first. It touches
   `background.js`, the newtab pages and these docs, and exposure changes
   overlap all three.
2. Exposure plumbing: arm assignment, `exposureRoute`, the selection record fields, the
   kill switch, and unit tests that an exposed outcome never enters the gate.
3. Surface A (omnibox empty query reads the pending prediction).
4. Surface C (Home open-tab rows, previous-tab context, label threshold).
5. Reload the unpacked extension and never remove it, because removal wipes every study. Dump
   storage with `read-local-studies.py` beforehand.
6. Read the result after two windows. Add a section here with the numbers.

## Not covered

- Out-of-set destinations: the `agent/tabtopia-next-page-study` branch
  (unmerged, 17 commits) is the study for those, with candidates recalled from History.
- Home's recommendation slate ("Your next destination", `buildHomeRecommendations`)
  is a separate ranker with its own arms and is not touched here.

## Implementation status

On branch `agent/tabtopia-prediction-exposure`:

- `src/lib/prediction-exposure.js` holds `predictLikelyTabs`, which gives the
  same order and probabilities as the shadow study's combiner (a unit test
  checks this). It also holds the 80/20 arm assignment and `PredictionExposureStore`.
  The store keeps daily counts per surface and arm under
  `tabtopiaPredictionExposureV1`. It also records a choice made from a
  prediction so that the shadow study can censor that choice.
- The shadow study has a new censor reason, `prediction-exposed`. Such outcomes
  get no replay row and stay out of the gate.
- Omnibox: one arm per `tt` session. On an empty query, treatment shows the combiner's
  order and puts "Likely next" on the first row when the top probability is at least 0.4.
  Control shows today's recall order. The store counts impressions, selections
  (by displayed rank), refinements (typing replaced the list) and dismissals.
- Options: a "Predict likely tabs" switch, default on for development installs,
  with a per-arm report. Clearing or disabling diagnostics clears the counts.

## Home status

Built, using the focal-slot option (decided 2026-11-26):

- `src/newtab/likely-tab-slot.js` asks the background (`getLikelyTab`) for the
  combiner's top open tab, with the Home tab as the current tab. Each page load gets one arm.
- When the top probability is at least 0.4, treatment puts that tab in the focal slot under
  "Likely next", and today's focal action moves into "At hand". Control
  renders today's Home. Both arms count an impression on that same condition.
- The slot is decided at the first settled quiet render. A prediction that arrives
  later stays off for that page, so the focal control never moves after Home
  is visible. Other modes and the fresh-start view are untouched.
- A selection reports its displayed rank in the quiet list (focal = 1). A
  switch to an open tab is also marked as exposed, so the shadow study censors it.
- Not yet measured: how often the prediction arrives before the first settled render on
  a real profile. If most pages miss it, the slot rarely shows. Check
  the Home impression count against the number of Home visits after a day.
