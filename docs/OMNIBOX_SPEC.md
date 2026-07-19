# Tabtopia Omnibox Recall

| Field | Value |
| --- | --- |
| Status | Proposed |
| Target | Tabtopia browser extension |
| Keyword | `tt` |
| Primary job | Recover an open tab from the browser's address bar |
| Related future work | Next-tab prediction, Landmark/history recall, cleanup and organization |

## Executive summary

Tabtopia should add an omnibox recall surface activated with `tt` + Space. It answers one narrow, frequent question: **“Where is the tab I’m thinking of?”**

The first release searches open tabs, ranks them using textual relevance plus Tabtopia frecency, and switches to the selected tab. Here, frecency combines how recently a tab was accessed, how often it has been activated, and how much time the user has invested in it. It does not replace the toolbar popup or turn the new-tab page into another search box.

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
- As a user who opens the omnibox without a query, I get a small, stable set of likely useful recent tabs rather than an empty surface.

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

An empty query returns up to five eligible tabs ordered by deterministic frecency. It must not be labeled “recommended” or “likely next”: frecency describes past use, not a validated prediction of future use.

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
- Incognito tabs unless the extension is explicitly enabled for incognito; never mix normal and incognito candidates across profiles.
- The currently active tab from query-free suggestions. It may remain eligible for a typed query, but should rank below an otherwise equivalent different tab.

Audible status is metadata and a ranking feature, not an exclusion rule.

## Search and ranking

### Principle

A query expresses remembered identity; frecency expresses accumulated relevance from past behavior. Text match should dominate once the query is specific, while frecency and contextual signals break ties and help with short or ambiguous queries.

### Candidate fields

The first release matches normalized query tokens against:

- Page title.
- Hostname and registrable domain where safely available.
- URL path, at lower weight.
- Existing Tabtopia summary text if already present in local state; never fetch or generate it on a keystroke.

Normalization should be Unicode-aware, case-insensitive, punctuation-tolerant, and order-independent. Exact prefix and token-prefix matches should receive a bonus. A small edit-distance or subsequence fallback may be added after profiling, but should not make ordering unpredictable.

### Behavioral features

The shared ranker consumes existing local metadata:

- Time since last access.
- Total invested/dwell time.
- Activation frequency.
- Current and prior session membership.
- Transition strength from the currently active tab.
- Same domain as the current tab.
- Same window as the current tab.
- Opener/referrer relationship.
- Tab age.
- Pinned and audible state.

Unavailable features are neutral, not zero-valued evidence against a candidate.

### MVP ranking

For a typed query:

```text
finalScore = 0.75 × textScore + 0.25 × behaviorScore
```

Both component scores are normalized to `[0, 1]` within the eligible candidate set. Text score includes title, domain, path, exact-match, and prefix-match weights. Behavior score begins with frecency—recency, activation frequency, and logarithmic investment—then adds contextual signals:

```text
behaviorRaw =
    α × log(1 + totalDwellSeconds)
  + β × log(1 + activationCount)
  - γ × log(1 + secondsSinceAccess)
  + δ × transitionFromCurrent
  + ε × sameSession
  + ζ × sameDomain
```

Initial coefficients should be constants with unit tests, then tuned from local replay data. The specification intentionally defines the feature shape rather than pretending the initial coefficients are learned truth.

For an empty query, rank by the frecency portion of the behavior score. The prediction study still evaluates MRU as a separate baseline; neither ordering is presented to the user as a prediction.

### Deterministic tie-breakers

Apply in order:

1. Higher final score.
2. More recent `lastAccessed`.
3. Higher `totalTimeSpent`.
4. Lower stable tab identifier.

### Ranking explanation

Expose at most one short reason and only when it helps disambiguate: `title match`, `domain match`, `recent`, or `frequently used`. Do not expose synthetic precision such as percentages until the prediction model is calibrated.

## Shared ranking architecture

The current new-tab search is bound to Lunr and page globals, while background state and the MCP server have separate ranking logic. Omnibox work should establish a pure, service-worker-safe core rather than add a fourth implementation.

Proposed modules:

```text
src/lib/tab-recall.js
  normalizeQuery(query)
  buildCandidate(tab, activity, context)
  scoreText(query, candidate)
  scoreBehavior(candidate, context)
  rankTabs(query, candidates, context, options)

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
| `src/background.js` | Own input sessions, live tab snapshots, Chrome event listeners, and tab/window activation. |
| `src/lib/tab-recall.js` | Provide pure normalization, candidate building, scoring, and ranking. |
| `tests/unit/tab-recall.test.mjs` | Exercise ranking, determinism, malformed data, and privacy helpers with Node. |
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

The feature must work after background suspension. Existing persisted state may enrich results, but live `tabs.query()` data is sufficient to provide a degraded title/domain/recency experience. Missing activity history must not block omnibox suggestions.

## Performance budgets

- Warm query-to-suggestions p95: **under 50 ms** for 500 open tabs.
- Cold first suggestion p95: **under 200 ms**, including service-worker wakeup and tab snapshot.
- No network request, content-script request, page-body read, or summary generation in the input path.
- Candidate snapshot memory: bounded to current open tabs and compact activity features.
- Maximum suggestions returned per input: five.

Performance should be tested with realistic Unicode titles, long URLs, duplicate domains, and multiple windows—not only synthetic short strings.

## Privacy and trust boundary

All matching, ranking, prediction, and evaluation data remain local by default. No omnibox query or browsing feature is sent to Tabtopia, a model provider, or an analytics service.

Raw queries are particularly sensitive and must not be persisted. Local evaluation may store:

- Query length and token count.
- Anonymous local model/version identifier.
- Candidate tab identifiers valid only within the local browser session.
- Returned ranks and selected rank.
- Latency and outcome.

Do not store the raw query, full URL, title, or page text in omnibox telemetry. Existing Tabtopia state may already contain titles/URLs for product operation; the evaluation log should not duplicate them.

The trust copy also needs a precise distinction:

- **Tabtopia MCP remains observational and does not focus, close, open, or navigate tabs.**
- **Tabtopia's user-facing omnibox may focus an existing tab only after an explicit user selection.**

Any current copy that says Tabtopia as a whole never focuses a tab should be qualified when this feature ships.

## Next-tab prediction study

### Research question

Given the current browsing context and the set of other open tabs, how accurately can Tabtopia predict the next tab the user intentionally accesses?

### Why shadow mode comes first

Showing predictions changes the behavior being predicted. The first study therefore logs predictions before activation events without displaying or using them in ranking. This produces an unbiased baseline and prevents a self-fulfilling “accuracy” result.

### Observation unit

On every qualified tab activation:

1. The newly focused tab becomes the current state.
2. Build the candidate set from all other eligible open tabs.
3. Run every baseline and candidate model immediately; persist their ranked identifiers and model versions.
4. Observe the next qualified activation as the outcome.

An activation is qualified when the tab remains active for at least two seconds. This filters accidental passes during rapid keyboard traversal. The dwell threshold should be configurable and reported with evaluation results.

Close, window-close, browser shutdown, and long inactivity may censor an observation rather than count as a wrong tab prediction. The evaluation code must report the censoring rule and rate.

### Baselines

Evaluate at least:

1. Most recently used other tab.
2. Highest total investment.
3. Most recent same-domain tab.
4. Browser strip neighbor/order.
5. First-order transition frequency from the current tab.
6. ACT-R-style activation combining recency and frequency.

The candidate feature model adds session, relationship, window, time-of-day, tab age, pinned, and audible signals. Start with an interpretable weighted model; do not require remote or opaque machine learning.

### Metrics

- Top-1 accuracy.
- Top-3 accuracy.
- Mean reciprocal rank.
- Log loss after probabilities are calibrated.
- Coverage and censoring rate.
- Accuracy by open-tab-count band and session age.

Report lift over MRU, not just absolute accuracy. Segment results without storing raw domains in the evaluation output.

### Exposure gate

Do not label or present a `Likely next` result until all of the following hold on a meaningful local sample:

- The candidate model beats MRU on top-1 and MRR.
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
  "modelVersion": "recall-v1",
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
  "timestamp": 0,
  "contextId": "local-ephemeral-id",
  "modelVersion": "next-tab-v1",
  "candidateCount": 0,
  "predictedTabIds": [0, 0, 0],
  "actualTabId": 0,
  "qualifiedDwellMs": 0,
  "censored": false
}
```

Identifiers should be sufficient for short-lived local evaluation and cleaned with the retention window. They are not cross-device user identifiers.

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
| Ranking exception | Fall back to recency ordering. |
| Local telemetry write failure | Continue the user action; evaluation is never on the critical path. |

## Rollout plan

### Phase 0 — contracts and fixtures

- Define candidate, context, score, suggestion, and telemetry schemas.
- Extract representative tab/activity fixtures from synthetic data.
- Add pure unit tests for normalization, scoring, tie-breaking, and privacy constraints.
- Record current popup, treemap, and MCP ranking behavior before refactoring.

**Exit:** Scoring inputs and outputs are stable, deterministic, and replayable.

### Phase 1 — open-tab omnibox MVP

- Add the `tt` manifest keyword.
- Add background omnibox listeners.
- Implement live candidate snapshot and pure recall ranker with base frecency.
- Return top-five results and focus the selected existing tab/window.
- Add no-result, stale-tab, multi-window, and service-worker restart handling.
- Update product copy to distinguish MCP observation from explicit user tab switching.

**Exit:** A user can reliably retrieve an open tab by title or domain within performance budgets.

### Phase 2 — behavioral ranking and shared core

- Enrich candidates from activity and relationship state.
- Add full frecency and transition/context scoring with single-reason explanations.
- Compare the shared core against current popup, treemap, and MCP behavior.
- Migrate other surfaces only when equivalence or intentional differences are documented.

**Exit:** Omnibox ranking uses Tabtopia context without producing unstable or surprising ordering.

### Phase 3 — shadow next-tab study

- Add qualified-activation observation lifecycle.
- Run all baselines and the interpretable candidate model.
- Add bounded local retention and an exportable aggregate report.
- Verify that raw queries and raw page metadata are absent from evaluation records.

**Exit:** A local report shows baseline-relative accuracy, MRR, calibration, coverage, censoring, and performance.

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
- Empty query excludes the current tab and orders by deterministic frecency.
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
- Empty input returns frecent tabs without predictive claims.
- Ordering is deterministic for an unchanged input snapshot.
- Warm p95 is below 50 ms at 500 tabs and cold p95 is below 200 ms.
- The feature works with missing persisted activity state.
- No raw query is persisted or transmitted.
- MCP trust copy remains accurate after user-facing switching is introduced.
- Cleanup, grouping, and history fallback have not leaked into MVP scope.

## Open decisions

These questions need evidence or a deliberate product choice, but do not block Phase 0:

1. Should an empty query show frecent tabs immediately, or only the instructional default until the first character?
2. Is `tt` the final keyword after testing discoverability and collision with existing search engines?
3. What minimum query length should enable approximate matching?
4. How should user-defined window names be represented when duplicates require disambiguation?
5. What retention window is sufficient for local prediction evaluation?
6. What lift over MRU is large enough to justify predictive UI?
7. Should prediction controls live in extension settings or a future local diagnostics view?

## Later connection to treemap controls

The omnibox does not solve cleanup, grouping, or visual comparison. The treemap should separately gain compact controls for grouping and ordering, including domain and current investment, plus an explicit last-accessed ordering even though recency is already encoded in color.

Both features should consume the same normalized tab/activity model. They should not share a single forced ordering: recall ranks by query relevance and context, while the treemap supports deliberate comparison by user-selected dimensions.
