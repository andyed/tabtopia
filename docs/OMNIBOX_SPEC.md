# Tabtopia Omnibox Recall

| Field | Value |
| --- | --- |
| Status | MVP implemented; local shadow study collecting |
| Target | Tabtopia browser extension |
| Keyword | `tt` |
| Primary job | Recover an open tab from the browser's address bar |
| Related future work | Next-tab prediction, Landmark/history recall, cleanup and organization |

## Executive summary

Tabtopia should add an omnibox recall surface activated with `tt` + Space. It answers one narrow, frequent question: **“Where is the tab I’m thinking of?”**

The first release searches open tabs, ranks them using textual relevance plus a Bayesian History/Context score, and switches to the selected tab. The behavioral score follows Zemla, Tossell, Kortum, and Byrne's power-law model of revisitation: temporally discounted access history supplies the prior, and transitions from the current browsing context supply additional evidence. Ordinary frecency remains a comparison baseline. The omnibox does not replace the toolbar popup or turn the new-tab page into another search box.

This establishes a clear product contract:

| Surface | Job | User question |
| --- | --- | --- |
| Omnibox | Recall | “Where is that tab?” |
| Toolbar popup | Glance | “What is immediately in my working set?” |
| New-tab page | Reorient | “What am I doing, where did I come from, and what next?” |
| Future organize mode | Maintain | “What should I close, group, or clean up?” |

The ranking system should also become the foundation for a local next-tab prediction study. Prediction runs in shadow mode before it changes the UI, so Tabtopia can measure genuine behavior without teaching users to follow its predictions.

## Product thesis

Tabtopia helps users recover their place in browsing, not merely recover a page.

The omnibox recovers the page. The new-tab page can then pursue the higher-order job of recovering place: session structure, context, momentum, and likely next actions. Cleanup and organization remain valuable, but they are not part of this feature's first release.

## Problem

Users with many tabs often remember some combination of a page title, domain, topic, or recent interaction, but not its window or physical position. Browser tab strips and spatial maps are poor tools for this particular moment because the user already has a verbal clue and wants an immediate keyboard path.

The toolbar popup can switch tabs, but making it the primary recall surface would consume a scarce glanceable surface and blur its role. The new-tab page can offer broader orientation, but requiring navigation to a page adds friction to a frequent retrieval action.

The browser address bar is already the habitual place for expressing “take me to this page.” An extension keyword lets Tabtopia participate there without impersonating Chrome’s generic URL suggestions.

## Goals

1. Let a user switch to an open tab in a few keystrokes without leaving the keyboard.
2. Rank results using what the user remembers and what Tabtopia knows about browsing activity.
3. Preserve distinct roles for the popup and new-tab page.
4. Keep matching and ranking local, fast, deterministic, and explainable.
5. Create one reusable recall/ranking core for the omnibox, popup, treemap, and MCP views.
6. Measure next-tab predictability before exposing predictive UI.

## Non-goals

- Closing, grouping, moving, or bulk-organizing tabs.
- Replacing Chrome's ordinary unscoped address-bar suggestions.
- A query language with filters or operators in the first release.
- Searching page bodies or reading live DOM content on each keystroke.
- Navigating an open tab to a different URL.
- Cloud synchronization, remote inference, or server-side telemetry.
- Showing next-tab recommendations before shadow-mode evaluation is credible.

## User stories

- As a user who remembers part of a title, I can type `tt` + Space and a few words, then press Enter to return to the open tab.
- As a user who remembers only a site, I can search by domain and distinguish duplicate results by title, recency, and window context.
- As a user with several windows, selecting a result focuses the correct window and tab.
- As a user who makes a typo or enters words in a different order, I still get useful approximate results.
- As a privacy-conscious user, my queries and browsing model stay on my device.
- As a user who opens the omnibox without a query, I get a small, stable set of historically and contextually relevant tabs rather than an empty surface.

## Chrome interaction constraint

Chrome extensions cannot insert arbitrary results into the ordinary omnibox before the extension keyword is activated. The explicit entry sequence is therefore:

1. Focus the address bar with the platform shortcut.
2. Type `tt`.
3. Press Space or Tab to enter Tabtopia mode.
4. Type a query.
5. Move through suggestions and press Enter.

The manifest adds:

```json
"omnibox": {
  "keyword": "tt"
}
```

No new omnibox permission is required. The current `tabs` permission and background service worker are sufficient for the MVP.

Reference: [Chrome omnibox API](https://developer.chrome.com/docs/extensions/reference/api/omnibox). Chrome sends each post-activation keystroke to the extension, accepts an array of suggestion objects, returns the selected suggestion's `content` through `onInputEntered`, and reserves the first row for the content-less default suggestion.

## Interaction design

### Activation

The default suggestion should immediately establish the mode and action:

> Search open tabs with Tabtopia

An empty query returns up to five eligible tabs ordered by the deterministic Bayesian History/Context score. It must not be labeled “recommended” or “likely next” until the model passes the shadow-mode exposure gate.

### Query results

Each suggestion represents one open tab.

- **Content:** a stable internal tab reference encoded for selection, not the URL as an action target.
- **Primary text:** `Switch · <page title>`
- **Description:** `<domain> · accessed <relative time> · <optional ranking reason>`

Examples:

```text
Switch · Chrome Extensions: omnibox API
developer.chrome.com · accessed 8m ago · title match

Switch · Tabtopia landscape
github.com · accessed yesterday · recent and frequently used
```

Descriptions should be concise and exact. Avoid decorative symbols beyond separators, low-contrast secondary information, and information conveyed only by color. Chrome owns the visual rendering, so Tabtopia should use the supported omnibox markup sparingly.

### Selection

On Enter:

1. Resolve the encoded tab identifier against live browser state.
2. Focus its window.
3. Activate the tab.
4. If the tab disappeared, recompute candidates and show a non-destructive fallback rather than navigating to its stale URL.

The MVP always switches the current browser focus to the selected existing tab. Alternative dispositions such as opening a duplicate in a new tab are deferred until there is evidence they are needed.

### No results

Use the default suggestion to say:

> No matching open tab — keep typing to refine

Do not silently fall through to a web search or navigate to the query. A later Landmark/history release may offer an explicitly labeled `Return` action.

### Duplicate tabs

Duplicate titles and URLs remain separate results because they may belong to different tasks or windows. Disambiguate with domain, recency, and—when necessary—a compact window label. Do not deduplicate across tab identifiers in the MVP.

### Keyboard contract

The omnibox is keyboard-native. Tabtopia adds no custom key event layer; it relies on Chrome's standard Up, Down, Enter, and Escape behavior. The result order must therefore be stable while a user is navigating it. Late activity updates must not reorder an already displayed list unless the query changes.

## Eligibility

MVP candidates are all open tabs that Chrome exposes to the extension, whether loaded or discarded, including tabs in other normal windows. Include pinned tabs. Exclude:

- DevTools and other tab records without a usable URL/title.
- Incognito tabs. The MVP excludes them entirely so no private access history enters persistent model state; a future incognito implementation requires a separate ephemeral store.
- The currently active tab from query-free suggestions. It may remain eligible for a typed query, but should rank below an otherwise equivalent different tab.

Audible status is metadata and a ranking feature, not an exclusion rule.

## Search and ranking

### Principle

A query expresses remembered identity. The Bayesian History/Context model expresses relative posterior odds of revisitation given accumulated access history and the current browsing context. Text match should dominate once the query is specific, while the Bayesian score breaks ties and helps with short, ambiguous, or empty queries.

### Candidate fields

The first release matches normalized query tokens against:

- Page title.
- Hostname and registrable domain where safely available.
- URL path, at lower weight.
- Existing Tabtopia summary text if already present in local state; never fetch or generate it on a keystroke.

Normalization should be Unicode-aware, case-insensitive, punctuation-tolerant, and order-independent. Exact prefix and token-prefix matches should receive a bonus. A small edit-distance or subsequence fallback may be added after profiling, but should not make ordering unpredictable.

### Behavioral evidence

The primary model requires:

- The timestamp of each qualified prior access to a candidate.
- The stable page and domain identity of the candidate.
- The stable page and domain identity of the currently active tab.
- Counts of transitions from the current identity to the candidate identity and to other identities.

The current `tabActivityLog.events` focus timestamps are sufficient for an open-tab prototype. They are not sufficient for a durable model because activity is keyed by ephemeral tab ID and deleted when a tab closes. Phase 0 must add bounded, local aggregates keyed by normalized page and domain identity so history and transition evidence survive tab churn without retaining an unbounded clickstream.

Additional signals—dwell time, session membership, window, opener/referrer, time of day, tab age, pinned, and audible state—are experimental likelihood cues. They must earn inclusion through replay or shadow-mode lift rather than enter the primary equation as arbitrary weights. Unavailable evidence is neutral, not evidence against a candidate.

### Bayesian History/Context model

For candidate identity `i`, let `Δtᵢⱼ` be the elapsed time since its `j`th qualified access. The History term is the ACT-R/Anderson–Schooler base-level activation used by Zemla et al.:

```text
historyᵢ = ln Σⱼ (Δtᵢⱼ ^ -d)
```

Start with `d = 0.5`, matching the paper's initial model. Treat it as a versioned parameter and test sensitivity locally; the published model remained comparatively robust across a range of decay values.

The Context term is the smoothed log likelihood ratio for arriving at candidate `i` from current context `c`:

```text
contextᵢ = ln P(c | i, historyᵢ) / P(c | not-i, historyᵢ)
```

Operationally, Tabtopia estimates this from the transition table between normalized identities and applies the paper's initial `.01` correction whenever an observed count is zero. Treat smoothing as a versioned parameter. The combined behavioral score is:

```text
bayesianScoreᵢ = historyᵢ + contextᵢ
```

This is a naïve-Bayes combination: history and context contribute equally in log-odds space. Any learned weighting becomes a separately versioned experimental model.

### Identity resolution

The published result predicts the next site/domain, whereas the omnibox must select an exact open tab. Tabtopia must therefore evaluate three resolutions:

1. **Tab/page:** use normalized URL identity directly.
2. **Domain:** assign the domain posterior to every open tab on that domain, then disambiguate by page history and recency.
3. **Hierarchical:** rank domains with History/Context, then rank open tabs within each domain using page-level history and text relevance.

The MVP defaults to the domain form because it is closest to the published, validated task. Typed lexical relevance and exact-tab recency disambiguate multiple open pages on the same domain. The hierarchical form is the leading experimental candidate because domain transitions are less sparse while the second stage still returns the precise tab; it is not declared the winner until replay or shadow data confirms it.

### Combining behavior with a typed query

Typed-query recall and query-free prediction are related but different tasks. Do not force lexical relevance into the Bayesian revisitation equation as if it were a calibrated probability.

For typed queries:

1. Filter to candidates with a minimum lexical match.
2. Rank primarily by normalized text score.
3. Use normalized `bayesianScore` as the behavioral reranker for ambiguous candidates.

The initial deterministic combination is:

```text
finalScore = 0.75 × textScore + 0.25 × normalize(bayesianScore)
```

The `0.75/0.25` split is a product ranking constant, not part of Byrne's model. Test it separately from the behavioral-model comparison. For an empty query, rank directly by `bayesianScore`. Until durable history is available, fall back in order to open-tab History, frecency, then MRU.

### Deterministic tie-breakers

Apply in order:

1. Higher final score.
2. Higher `bayesianScore`.
3. More recent `lastAccessed`.
4. Lower stable tab identifier.

### Ranking explanation

Expose at most one short reason and only when it helps disambiguate: `title match`, `domain match`, `often revisited`, or `often follows this site`. Do not expose synthetic precision such as percentages until the prediction model is calibrated.

## Shared ranking architecture

The current new-tab search is bound to Lunr and page globals, while background state and the MCP server have separate ranking logic. Omnibox work should establish a pure, service-worker-safe core rather than add a fourth implementation.

Proposed modules:

```text
src/lib/tab-recall.js
  normalizeQuery(query)
  buildCandidate(tab, activity, context)
  scoreText(query, candidate)
  rankTabs(query, candidates, context, options)

src/lib/revisit-model.js
  normalizeIdentity(url, resolution)
  scoreHistory(accessTimestamps, now, decay)
  scoreContext(candidateIdentity, currentIdentity, transitions, smoothing)
  scoreBayesian(candidate, context, modelConfig)

src/lib/tab-prediction.js
  extractPredictionFeatures(...)
  scoreNextTab(...)
  evaluatePrediction(...)
```

Requirements:

- Pure functions; no DOM, Chrome API, storage, or global Lunr dependency.
- Explicit input schemas and deterministic output.
- Usable in the background service worker and Node tests.
- Version the scoring configuration so replayed metrics identify the model used.
- Keep query matching distinct from next-tab prediction even when they share features.

The background worker owns Chrome API calls and adapts `browserState`, live tabs, and the current context into these pure functions. The popup, treemap, and MCP can migrate to the shared ranking core in later phases after equivalence tests.

### Repository change map

| Path | Phase 1 responsibility |
| --- | --- |
| `manifest.json` | Declare the `tt` omnibox keyword. |
| `src/background.js` | Own input sessions, live tab snapshots, qualified-access logging, transition aggregation, Chrome event listeners, and tab/window activation. |
| `src/lib/tab-recall.js` | Provide pure lexical normalization, candidate building, and query/behavior combination. |
| `src/lib/revisit-model.js` | Provide pure identity normalization and History/Context scoring. |
| `tests/unit/tab-recall.test.mjs` | Exercise lexical ranking, deterministic combination, malformed data, and privacy helpers with Node. |
| `tests/unit/revisit-model.test.mjs` | Reproduce paper-style model fixtures, smoothing, decay, and identity-resolution comparisons. |
| `tests/perf/omnibox-benchmark.js` | Enforce warm ranking budgets across realistic candidate counts. |
| `README.md` | Qualify the read-only promise as an MCP/agent boundary once user-driven switching ships. |

Phase 3 adds `src/lib/tab-prediction.js` and its unit/performance fixtures. It should reuse feature extraction where appropriate, but it must not become a hidden dependency of typed-query recall.

## Background service-worker design

Register these listeners during normal background initialization:

- `chrome.omnibox.onInputStarted`
- `chrome.omnibox.onInputChanged`
- `chrome.omnibox.onInputEntered`
- `chrome.omnibox.onInputCancelled`

### Input lifecycle

1. On input start, snapshot live tabs and current context, enriched from `browserState.tabActivityLog` and `browserState.tabRelationships`.
2. On change, normalize the query and synchronously rank the in-memory snapshot.
3. Return at most five suggestions.
4. Discard stale asynchronous results using a monotonically increasing input-session token.
5. Refresh the snapshot only when materially stale or when Chrome reports a tab/window change; avoid `tabs.query()` on every character.

### Enter lifecycle

The suggestion content encodes a tab identifier and input-session nonce, not an arbitrary URL. Validate it before acting. Then call window focus and tab activation in that order, tolerating the window already being focused.

If a default suggestion is entered without a selected tab, activate the top result from the current stable result set. If no candidate exists, do nothing.

### Service-worker restart

The feature must work after background suspension. Existing persisted aggregates may enrich results, but live `tabs.query()` data is sufficient to provide a degraded title/domain/MRU experience. Missing History/Context data must not block omnibox suggestions.

## Performance budgets

- Warm query-to-suggestions p95: **under 50 ms** for 500 open tabs.
- Cold first suggestion p95: **under 200 ms**, including service-worker wakeup and tab snapshot.
- No network request, content-script request, page-body read, or summary generation in the input path.
- Candidate snapshot memory: bounded to current open tabs and compact activity features.
- Maximum suggestions returned per input: five.

Performance should be tested with realistic Unicode titles, long URLs, duplicate domains, and multiple windows—not only synthetic short strings.

## Privacy and trust boundary

All matching, ranking, prediction, and evaluation data remain local by default. No omnibox query or browsing feature is sent to Tabtopia, a model provider, or an analytics service.

Ranking evaluation is opt-in. A standard packaged install persists diagnostics as disabled on first run and performs no shadow-ranking calculations or diagnostic writes while disabled. An unpacked development install, detected with permission-free chrome.management.getSelf(), defaults diagnostics on so Tabtopia's own working installs continuously exercise the study. A persisted user choice always overrides that install-type default.

The settings surface must:

- Name the feature **Ranking diagnostics**, not generic analytics.
- Explain that records remain on the device.
- Show whether the install is internal/development or standard.
- Delete the bounded outcome log and any pending session prediction immediately when disabled.
- Keep any future network upload behind a separate, explicit consent decision.

Raw queries are particularly sensitive and must not be persisted. Local evaluation may store:

- Query length and token count.
- Anonymous local model/version identifier.
- Candidate tab identifiers valid only within the local browser session.
- Returned ranks and selected rank.
- Latency and outcome.

Do not store the raw query, full URL, title, or page text in omnibox telemetry. Existing Tabtopia state may already contain titles/URLs for product operation; the evaluation log should not duplicate them.

Durable History/Context aggregates introduce a separate privacy obligation. Key page/domain aggregates with an installation-local HMAC digest rather than storing another plaintext URL history. The MVP retains at most 64 qualified accesses per identity for 180 days, 1,000 identities, 500 transition sources, and 32 targets per source. Incognito activity is excluded. These are versioned initial bounds, not empirically settled values. Delete the aggregates when local browsing state is cleared. A plain unsalted domain hash is not sufficient because it is easily enumerable.

The trust copy also needs a precise distinction:

- **Tabtopia MCP remains observational and does not focus, close, open, or navigate tabs.**
- **Tabtopia's user-facing omnibox may focus an existing tab only after an explicit user selection.**

Any current copy that says Tabtopia as a whole never focuses a tab should be qualified when this feature ships.

## Research basis

The primary behavioral model comes from:

> Jeffrey C. Zemla, Chad C. Tossell, Philip Kortum, and Michael D. Byrne. “A Bayesian approach to predicting website revisitation on mobile phones.” *International Journal of Human-Computer Studies* 83 (2015), 43–50. [Rice-hosted paper](https://chil.rice.edu/jzemla/ijhcs2015.pdf) · [DOI record](https://doi.org/10.1016/j.ijhcs.2015.06.002)

The study evaluated one year of naturalistic Safari logs from 24 iPhone users. Its principal metric counted a transition as correct when the next site appeared in the model's top four predictions.

| Published model | Mean top-four accuracy |
| --- | ---: |
| Context-only transition model | 19.9% |
| Recency | 38.2% |
| Frequency | 39.6% |
| Simplified Firefox Frecency | 42.1% |
| New Frecency | 42.4% |
| Power-law History | 44.4% |
| Bayesian History/Context | **48.9%** |

The History model outperformed the simplified Firefox Frecency model for 22 of 24 participants. Adding current-site context significantly improved History alone. The paper also found that performance was comparatively stable around its initial `d = 0.5` decay setting.

These results establish a strong candidate, not a transferable Tabtopia accuracy claim:

- The paper predicts site/domain revisitation, not exact pages or open tabs.
- The candidate universe is browsing history rather than the current open-tab set.
- The data came from mobile Safari and a small student sample.
- Its Firefox comparison omits access-method bonuses because the source logs did not record typed, bookmark, or link entry.
- The user interface can alter the behavior being predicted, which is why Tabtopia must re-evaluate after exposure.

Tabtopia should first reproduce the model on synthetic fixtures, then compare domain, page, and hierarchical adaptations on local shadow data. Do not describe the model as outperforming frecency in Tabtopia until that comparison succeeds.

## Next-tab prediction study

### Research question

Given the current browsing context and the set of other open tabs, how accurately can Tabtopia predict the next tab the user intentionally accesses?

### Why shadow mode comes first

Showing predictions changes the behavior being predicted. The first study therefore logs predictions before activation events without displaying or using them in ranking. This produces an unbiased baseline and prevents a self-fulfilling “accuracy” result.

### Implemented shadow matrix

The local study now runs twelve deterministic models from the same open-tab
snapshot: MRU, total investment, same-domain MRU, tab-strip neighbor, page and
domain transition, frecency, page and domain History-only, and page, domain,
and hierarchical Bayesian History/Context. Evidence-dependent models abstain
when their evidence is absent so coverage remains visible instead of being
silently replaced by another ranker.

Candidate tab identifiers and relative-softmax probabilities live only in the
short-lived `chrome.storage.session` pending prediction. The durable bounded
buffer stores one content-free outcome per qualified activation: model version,
rank, probability, coverage, latency, censor reason, destination class, open-tab
band, and browser-session-age band. It contains no tab identifiers, URLs,
titles, domains, or queries. The current `next-tab-matrix-v3` cohort excludes
same-tab navigation, reload completion, and refocus from next-tab outcomes;
qualified access also requires a focused window. V2 outcomes and pending
predictions cannot enter the corrected study or exposure gate.

Up to 5,000 compact detail records within a 2 MiB byte budget remain under
`tabtopiaRankingDiagnosticsV2` for inspection. Legacy arrays are read transparently
and encoded on the next flush. Settings reads `tabtopiaRankingStudyDaysV3`: 90 UTC calendar days
of content-free sufficient statistics, independent of detail-buffer rollover.
Daily aggregates preserve model hits, reciprocal ranks, log loss, calibration
bins, seven-day evaluation windows, and tab/session/destination segments.
Latency uses a fixed histogram whose p95 is a conservative upper bound, with
an exact 50 ms boundary for the existing exposure gate. The report identifies
its cohort and retained-day count. Disabling or clearing diagnostics removes
both stores and pending session data. Old detail records are not backfilled
because their observation semantics differ.

The current conservative evaluation gate uses seven-day windows and remains
report-only. It requires at least 100 eligible outcomes, two windows with at
least 25 outcomes where domain Bayesian beats both MRU and frecency on top-one
and MRR, at least 80% primary-model coverage, expected calibration error at or
below 0.10, and prediction p95 at or below 50 ms. Passing this calculation does
not enable prediction UI automatically.

The separate [revisit and saved-intention program](REVISIT_RESEARCH_PLAN.md)
adds page-return prediction over 10/50/200 qualified-access horizons, Mobile-folder
bookmark observations, and a read-only local browsing/chat retrieval probe.
These have distinct labels and cohorts; none establishes next-tab or Home lift.

### Observation unit

On every qualified tab activation:

1. The newly focused tab becomes the current state.
2. Build the candidate set from all other eligible open tabs.
3. Run every baseline and candidate model immediately; persist their ranked identifiers and model versions.
4. Observe the next qualified activation as the outcome.

An activation is qualified when the tab remains active for at least two seconds. This filters accidental passes during rapid keyboard traversal. The dwell threshold should be configurable and reported with evaluation results. Transition origins resolve from Chrome's live tab object when legacy in-memory tab state is absent, which preserves context evidence across service-worker restarts and extension-internal pages.

Close, window-close, browser shutdown, and long inactivity may censor an observation rather than count as a wrong tab prediction. The evaluation code must report the censoring rule and rate.

### Baselines

Evaluate at least:

1. Most recently used other tab.
2. Highest total investment.
3. Most recent same-domain tab.
4. Browser strip neighbor/order.
5. First-order transition frequency from the current tab.
6. Firefox-style frecency.
7. Power-law History without context.
8. Bayesian History/Context at page, domain, and hierarchical resolutions.

The Bayesian History/Context adaptation is the primary candidate model. Experimental variants may add dwell, session, relationship, window, time-of-day, tab age, pinned, and audible likelihood cues one at a time. Each variant must report incremental lift and remain interpretable; no remote or opaque machine learning is required.

### Metrics

- Top-1 accuracy.
- Top-3 accuracy.
- Mean reciprocal rank.
- Log loss after probabilities are calibrated.
- Coverage and censoring rate.
- Accuracy by open-tab-count band and session age.
- Counts split by existing-tab and out-of-set destinations.

Report lift over MRU, Firefox-style frecency, and power-law History—not just absolute accuracy. Segment results without storing raw domains in the evaluation output. Include top-four accuracy as a paper-comparison metric, while treating top-one, top-three, and MRR as the primary Tabtopia product metrics.

### Exposure gate

Do not label or present a `Likely next` result until all of the following hold on a meaningful local sample:

- The Bayesian model beats both MRU and Firefox-style frecency on top-3 and MRR. (Top-3, not top-1, since 2026-10-07: Home shows three featured destinations, and Zemla et al. report a four-slot springboard. `exposureHitMetric` in `RANKING_STUDY_DEFAULTS` names the metric.)
- The gain persists across more than one evaluation window.
- Latency remains within the omnibox budget.
- Calibration is good enough that a confidence threshold has semantic meaning.
- A holdout or interleaving plan exists to continue measuring behavior after UI exposure.

Once gated, an empty omnibox query is the first candidate surface for predictions. Predictive results must remain visually and verbally distinct from typed-query matches.

## Telemetry schemas

Use bounded, append-style local records or a bounded ring buffer in `chrome.storage.local`. Writes should be batched so activation handling remains lightweight.

### Omnibox interaction record

```json
{
  "event": "omnibox_selection",
  "timestamp": 0,
  "modelVersion": "recall-bayes-v1",
  "queryLength": 0,
  "queryTokenCount": 0,
  "candidateCount": 0,
  "selectedRank": 0,
  "latencyMs": 0
}
```

### Shadow prediction record

```json
{
  "event": "next_tab_outcome",
  "cohort": "next-tab-matrix-v3",
  "timestamp": 0,
  "destinationClass": "existing-tab",
  "candidateCount": 0,
  "qualifiedDwellMs": 0,
  "observationAgeMs": 0,
  "predictionLatencyMs": 0,
  "openTabBand": "6-10",
  "sessionAgeBand": "15-60m",
  "censorReason": "",
  "models": [
    {
      "modelVersion": "bayes-domain-v1",
      "identityResolution": "domain",
      "confidenceMethod": "relative-softmax-v1",
      "predictedCount": 0,
      "actualRank": 0,
      "actualProbability": 0,
      "top1Probability": 0
    }
  ]
}
```

Tab identifiers are limited to the session-scoped pending prediction and are
consumed when this record is produced. They are never copied into the durable
outcome buffer.

## Accessibility and visual quality

Chrome renders the omnibox, so Tabtopia controls information architecture rather than pixels. Follow these constraints:

- Do not depend on color to distinguish actions or rank.
- Keep labels unambiguous and scannable.
- Escape user and page text before applying supported omnibox markup.
- Preserve at least an 8:1 contrast ratio in any Tabtopia-owned companion UI or settings added for this feature.
- Use at least 40 × 40 px targets for any companion controls.
- Maintain one focal action per state: switch to the selected tab.
- Avoid low-opacity text as a styling technique.

## Failure handling

| Failure | Behavior |
| --- | --- |
| Background activity state unavailable | Search live tab title/domain with neutral behavioral scores. |
| Selected tab closed before Enter | Do nothing destructive; refresh candidates. |
| Window cannot be focused | Attempt tab activation, report only to local diagnostic logging. |
| Restricted or malformed URL | Match title when available; omit unsafe domain/path fields. |
| Duplicate tab IDs in stale state | Trust the current Chrome tab snapshot. |
| Incognito boundary | Never return candidates from a different profile context. |
| Missing durable history | Fall back from open-tab History to frecency, then MRU. |
| Ranking exception | Fall back to MRU ordering. |
| Local telemetry write failure | Continue the user action; evaluation is never on the critical path. |

## Rollout plan

### Phase 0 — contracts and fixtures

- Define candidate, context, score, suggestion, and telemetry schemas.
- Define stable page/domain identities, bounded access-history aggregates, and transition tables that survive tab closure.
- Reproduce the paper's History and History/Context equations on synthetic fixtures.
- Add pure unit tests for power-law decay, Laplace smoothing, identity resolution, tie-breaking, and privacy constraints.
- Record current popup, treemap, and MCP ranking behavior before refactoring.

**Exit:** Scoring inputs and outputs are stable, deterministic, replayable, and capable of reproducing known paper-style examples.

### Phase 1 — open-tab omnibox MVP

- Add the `tt` manifest keyword.
- Add background omnibox listeners.
- Implement live candidate snapshots, lexical recall, and the power-law History score from existing focus events.
- Add explicit frecency and MRU fallbacks for sparse or missing history.
- Return top-five results and focus the selected existing tab/window.
- Add no-result, stale-tab, multi-window, and service-worker restart handling.
- Update product copy to distinguish MCP observation from explicit user tab switching.

**Exit:** A user can reliably retrieve an open tab by title or domain within performance budgets.

### Phase 2 — behavioral ranking and shared core

- Persist bounded page/domain history and transition aggregates.
- Add the Bayesian Context term and page, domain, and hierarchical identity strategies.
- Add single-reason explanations without exposing uncalibrated probability claims.
- Compare the shared core against current popup, treemap, and MCP behavior.
- Migrate other surfaces only when equivalence or intentional differences are documented.

**Exit:** Omnibox ranking uses Tabtopia context without producing unstable or surprising ordering.

### Phase 3 — shadow next-tab study

- Implemented: qualified-activation observation and explicit censoring lifecycle.
- Implemented: MRU, investment, same-domain, strip-neighbor, transition,
  frecency, History, and every Bayesian identity-resolution candidate.
- Implemented: top-one, top-three, top-four, MRR, log loss, calibration,
  coverage, censoring, open-tab bands, session-age bands, and weekly lift.
- Implemented: bounded local retention and an aggregate Settings report.
- Verified by contract tests: durable evaluation records contain no raw query,
  page metadata, or tab identifier.
- Gated behind Ranking diagnostics: default off for standard installs, default
  on for unpacked development installs.

**Exit:** Pending a meaningful local sample that clears the two-window exposure gate.

### Phase 4 — prediction experiment

- Proceed only if the exposure gate passes.
- Add confidence-gated likely-next suggestions to the empty-query state.
- Preserve a randomized holdout or interleaving evaluation.
- Provide an easy local setting to disable prediction records and recommendations.

**Exit:** Predictive UI demonstrates retrieval benefit without degrading trust or typed-query relevance.

### Phase 5 — Landmark/history return

- Add explicitly labeled `Return` results when no strong open-tab match exists.
- Keep open tabs and historical pages visibly distinct.
- Define whether selection opens a new tab or reuses an existing matching tab.
- Revisit retention, restricted URLs, and history permissions before implementation.

**Exit:** The omnibox can recover both the current working set and meaningful past places without action ambiguity.

## Test plan

### Unit tests

- Unicode, punctuation, case, token order, prefix, and hostname normalization.
- Title/domain/path weighting.
- Missing activity fields and malformed URLs.
- Power-law History from exact access timestamps with `d = 0.5`.
- Context log-likelihood with zero counts and Laplace correction.
- Page, domain, and hierarchical identity scoring.
- Frecency and MRU fallback order.
- Deterministic ties.
- Current-tab demotion.
- Incognito/profile separation.
- Ranking fallback after an injected exception.
- Telemetry serialization contains no raw query, title, or URL.

### Integration tests

- `onInputChanged` returns stable top-five suggestions.
- Enter focuses a tab in the current and another window.
- A tab closes between suggestion and selection.
- Background worker suspends and restarts.
- Pinned, discarded, audible, and duplicate tabs remain selectable.
- Empty query excludes the current tab and orders by deterministic History/Context score when evidence is available.
- Rapid input never renders an older query's results.

### Performance tests

- 10, 100, 500, and 1,000 open-tab fixtures.
- Warm input changes and cold worker wakeup.
- Long titles/URLs and multiple windows.
- Activity-state enrichment with missing and stale records.

### Manual acceptance

- Use only the keyboard from address-bar focus through tab activation.
- Confirm Chrome's visual truncation remains understandable.
- Confirm the toolbar popup and new-tab page retain their current roles.
- Confirm no network traffic occurs during querying or prediction.
- Inspect local telemetry after real use for sensitive-field leakage.

## MVP acceptance criteria

The MVP is ready when:

- `tt` + Space activates Tabtopia recall.
- Title and domain queries retrieve correct open tabs across windows.
- Selecting a result focuses the existing tab and never navigates it elsewhere.
- Empty input returns Bayesian-ranked tabs without predictive claims, with tested frecency/MRU fallback.
- Ordering is deterministic for an unchanged input snapshot.
- Warm p95 is below 50 ms at 500 tabs and cold p95 is below 200 ms.
- The feature works with missing persisted activity state.
- No raw query is persisted or transmitted.
- MCP trust copy remains accurate after user-facing switching is introduced.
- Cleanup, grouping, and history fallback have not leaked into MVP scope.

## Open decisions

These questions need evidence or a deliberate product choice, but do not block Phase 0:

1. Should an empty query show Bayesian-ranked tabs immediately, or only the instructional default until the first character?
2. Is `tt` the final keyword after testing discoverability and collision with existing search engines?
3. What minimum query length should enable approximate matching?
4. How should user-defined window names be represented when duplicates require disambiguation?
5. Does page, domain, or hierarchical identity perform best for open-tab prediction?
6. Do the initial 64-access, 180-day, 1,000-identity bounds preserve useful power-law evidence without accumulating excessive local state?
7. Should the published `d = 0.5` and `.01` smoothing constants remain global, or be adapted locally after sufficient evidence?
8. What lift over both MRU and frecency is large enough to justify predictive UI?
9. Should prediction controls live in extension settings or a future local diagnostics view?

## Later connection to treemap controls

The omnibox does not solve cleanup, grouping, or visual comparison. The treemap should separately gain compact controls for grouping and ordering, including domain and current investment, plus an explicit last-accessed ordering even though recency is already encoded in color.

Both features should consume the same normalized tab/activity model. They should not share a single forced ordering: recall ranks by query relevance and context, while the treemap supports deliberate comparison by user-selected dimensions.
