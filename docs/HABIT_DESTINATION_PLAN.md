# Habit destinations: History-first prediction plan

> Development plan, 2026-07-25. This is a focused M2 slice of
> [START_PAGE_ROADMAP.md](./START_PAGE_ROADMAP.md): make durable, frequently
> revisited destinations first-class start-page candidates without letting a
> coincidentally active page borrow their rank.

## Decision

Use Chrome History as the first candidate source.

The start page should rank a habitual destination by its own access history
before asking what activity or neighborhood it belongs to. Context may then
modify the destination's relevance or explain a real relationship, but one
synchronous event must not turn an unrelated neighbor into a strong
prediction.

This is intentionally a two-track model:

1. **Destination retrieval:** "LinkedIn is often needed, especially after this
   pattern of prior use."
2. **Activity resumption:** "These pages form work that may be worth
   continuing."

The first produces page/domain candidates. The second continues to produce
neighborhood candidates through `resumption-forecast.js`. They may both appear
in the ranked action list, but they do not donate scores to one another.

## Problem

The current resumption forecast ranks whole neighborhoods. Its `habit` cue is
visits per page inside the recent neighborhood, using only the snapshot that
fed the neighborhood builder. That is a useful clue about repeated work, but it
is not a durable estimate that the user commonly goes to a particular
destination.

This creates two related errors:

- A frequent destination can rank too low at day start because its long-run
  history is represented only through a recent component.
- A page that happened to be active at the same time can borrow importance from
  the frequent destination because the component, rather than the destination,
  is scored.

The desired behavior is identity-preserving. If LinkedIn is a strong habit and
was briefly active beside an unrelated page, LinkedIn may remain a strong
destination while the unrelated page receives little or no benefit from that
co-occurrence.

## Cognitive model

ACT-R separates two kinds of evidence that the current start-page model should
also keep separate.

### Base-level activation: durable need

ACT-R base-level activation estimates retrieval availability from an item's
own access history:

```text
B_i = ln(sum_j((now - access_ij) ^ -d))
```

Frequency and recency interact: repeated accesses matter, recent accesses
matter more, and old evidence decays rather than disappearing at an arbitrary
session boundary. `revisit-model.js` already implements this as
`scoreHistory()`, with the default decay `d = 0.5`.

This is the right conceptual basis for a habitual destination. Dwell can
qualify an access or contribute a separate investment cue, but it is not a
substitute for the discrete access history in the formula.

### Contextual activation: why now

Current context can disambiguate which otherwise available destination is
useful now. `scoreContext()` already estimates a transition-conditioned log
odds term, and structural browser evidence such as an opener or referrer can
support a specific relationship.

Context is not permission to merge identities. A cue that occurs with many
targets has a large "fan" and is less diagnostic of any one target. In product
terms, the useful quantity is lift above the target's base rate:

```text
association(target, cue) = log(P(target | cue) / P(target))
```

with smoothing, minimum evidence, and a bounded contribution. A target that is
common everywhere should not appear strongly related to a particular
temporally adjacent page merely because the pair occurred once.

### Product interpretation

The cognitive distinction maps to three separately inspectable terms:

```text
destination relevance
  = durable History
  + state policy
  + bounded, evidence-qualified Context
```

Topology can explain or refine an action. It must not manufacture the
destination's identity.

## Why Chrome History is the right first source

Chrome History supplies enumerable URL/title identities plus `visitCount`,
`typedCount`, and `lastVisitTime`. Those aggregate fields are useful for a
bounded shortlist, but the first slice does not treat them as its final score.
The existing background-owned `RevisitStore` already holds qualified access
timestamps and can compute ACT-R History without admitting raw reload,
redirect, or background-navigation noise.

This closes the main gap in `RevisitStore`: the persistent store can score a
URL already presented to it, but its HMAC identities deliberately cannot be
reversed to enumerate the user's strongest destinations. Chrome History can
generate that bounded candidate pool without adding a second long-lived raw
URL index.

`chrome.history.getVisits()` remains a possible capped bootstrap for habits
that predate the qualified-access store. It is deliberately a later shadow
experiment, not part of the first vertical slice: it adds an N+1 API path,
admits noisier navigation events, and would duplicate scoring ownership outside
the background worker.

The repository already has the `history` permission and a shared
`history-cache.js` path with a 180-day horizon, a 5,000-row cap, a five-minute
TTL, and `chrome.storage.session` backing. The vertical slice should reuse that
path instead of introducing another history query waterfall.

## Drawbacks and mitigations

Chrome History is a good starting point, not a complete ground truth.

| Drawback | Consequence | First-slice mitigation |
|---|---|---|
| The `history` permission exposes sensitive URLs and titles | A bug or diagnostic dump could reveal more than the feature needs | Keep computation on-device; add no remote analytics; do not log raw candidates; reuse the session cache; persist no new raw URL/title index |
| History may be disabled, cleared, selectively deleted, expired, or unavailable in another profile | Frequency can be incomplete and should not be described as a complete personal routine | Treat missing evidence as neutral; return an empty habit source cleanly; explain scores as "often visited in available history" |
| Incognito history is absent | The model cannot learn private-mode habits | Keep incognito explicitly out of scope; do not attempt inference from gaps |
| Synced/non-local visits can mix devices and contexts | A desktop start-page habit can be distorted by another device's use | Default the first habit slice to local visits when provenance is available; retain counts for diagnostics; test an explicit later cross-device policy |
| `HistoryItem.visitCount` is aggregated and does not expose the access schedule | Plain counts cannot reproduce ACT-R decay or distinguish bursty refreshes from durable recurrence | Use item fields only for shortlisting; score with the singleton `RevisitStore`'s qualified access timestamps |
| A later `getVisits()` bootstrap would create an N+1 cold-start path | Large profiles could delay the start page and admit reload/redirect noise | Keep it out of slice one; if shadow evidence later justifies it, shortlist and cap it independently after the shell is actionable |
| URLs fragment identity through tracking parameters, fragments, redirects, locale routes, and app-specific IDs | One human destination can be split into weak pages, or unrelated pages can be collapsed too aggressively | Reuse `normalizeIdentity()` for page/domain scoring; strip fragments as it already does; keep exact URL as the action target; add only reviewed normalization rules rather than deleting query parameters globally |
| Domain frequency can swamp meaningful page specificity | A large domain may become a generic suggestion that cannot identify the intended page | Smooth sparse page evidence toward domain evidence, then use page History to select a concrete recent URL; never offer a bare domain if no trustworthy target URL exists |
| Refreshes, redirects, background loads, restores, and automation can inflate raw visits | High count is not always high intent | Prefer qualified visits where existing focus/access evidence is available; use `typedCount` and transition type only as bounded evidence; cap same-burst duplicates in a later refinement if diagnostics show inflation |
| Single-page apps and in-page navigation do not always map cleanly to Chrome History entries | Route-level habits may be under- or over-separated | Start at Chrome's recorded URL grain; compare page- and domain-level outcomes before adding application-specific canonicalization |
| History deletion and the existing persistent HMAC store can disagree | A removed destination could retain an old score if the persistent store is used as an enumerable source | Generate the displayed pool from current Chrome History; deletion removes candidacy even if an old digest remains; add deletion reconciliation before any persistent alias index |
| The API is ordered and capped, not an unbiased sample of an arbitrarily large lifetime | A recent 5,000-row pool may miss an older but frequent destination | Describe this as a bounded 180-day routine prior; measure cap saturation; consider paged/aggregate maintenance only if the slice demonstrates value |

These limitations are reasons to keep evidence visible, not reasons to delay the
vertical slice.

## Architecture

### 1. Candidate generation is independent of neighborhoods

Add a pure habit-candidate generator with no Chrome API calls. Its input is a
bounded set of history items plus History-only scores returned by the
background-owned revisit store:

```js
{
  now,
  historyItems: [],
  historyScores: [],
  openTabs: [],
  state: "launch"
}
```

It should:

1. Reject unsupported or unsafe URL schemes using the existing identity
   normalization contract.
2. Group evidence by normalized page and domain.
3. Shortlist cheaply using recency, `visitCount`, and `typedCount`.
4. Ask the singleton background `RevisitStore` for page and domain
   `scoreHistory()` values only; do not admit transition Context in this lane.
5. Rank domains by durable History, using page History to choose a concrete
   target without donating that score to neighboring pages.
6. Resolve each identity to a concrete recent URL/title.
7. Mark whether that exact URL is already open.
8. Return inspectable components, reasons, evidence count, and
   confidence.

A candidate contract should distinguish score from confidence:

```js
{
  id: "habit:<stable-runtime-identity>",
  kind: "habit-destination",
  url,
  title,
  domain,
  open: false,
  action: { verb: "open" },
  score,
  confidence,
  cues: {
    history,
    accessCount,
    visitCount,
    typedCount,
    context: 0
  },
  reasons: ["ACT-R History from qualified accesses"]
}
```

Do not include a raw URL in a persisted diagnostic identifier. A runtime-only
normalized identity is enough for the first slice. Because `HistoryItem` has no
device provenance, the first slice must not label the result local or foreign;
that requires a later, bounded `VisitItem.isLocal` enrichment.

### 2. Keep the existing activity forecast intact

`forecastResumption()` should continue to rank neighborhoods as activities.
Its `habit` cue may remain useful as "this activity was revisited in the recent
snapshot," but it must not be described or treated as the user's overall
destination frequency.

Habit and resumption candidates meet only in a later merge step. Deduplicate
actions by normalized page identity:

- If the same page is open, the action is **Switch**, not Reopen.
- If a destination is also the chosen endpoint of a neighborhood, keep one
  action with two separately named evidence groups.
- Do not transfer a destination's History score to every node or to the whole
  neighborhood.
- Do not let neighborhood size multiply a destination score.

### 3. Add a state-aware merge policy

State selects candidate sources and presentation slots; it should not mutate
the raw evidence.

| State | Habit policy |
|---|---|
| **Launch** | Habit History is the primary source. Reserve the leading slots for independent destinations before deferred intentions. |
| **Threshold** | Keep habitual destinations prominent while showing that live work exists elsewhere. |
| **Reinstatement** | Lead with the interrupted activity when its evidence is strong, but retain at least one independent habit fast path. |
| **Reorientation** | Lead with the working-landscape choice; retain habits as explicit alternatives rather than absorbing them into a prior component. |
| **Continuation** | Current-context actions may lead, but habits remain universal fast paths and context must clear the coupling gate below. |
| **Handoff** | Lead with coherent foreign activity; do not silently reinterpret non-local visits as a local routine. |

The first implementation should use explicit slots or bounded source weights,
not normalize incomparable raw scores into one opaque number.

### 4. Base-rate-corrected coupling gate

Temporal co-activity remains admissible as weak topology evidence, but it
should affect destination ranking only after it demonstrates information above
base frequency.

Apply these rules:

- **Structural evidence first:** opener and referrer evidence can contribute
  immediately because it names a relationship, though repeated evidence still
  improves confidence.
- **One temporal overlap is descriptive only:** it may render "active
  together" but contributes zero destination-rank lift.
- **Require recurrence across distinct episodes:** temporal association is not
  promoted until the pair recurs across bounded sessions or local-day
  partitions.
- **Correct for base rate and fan:** compare `P(target | cue)` with
  `P(target)`, smooth sparse counts, and dilute cues associated with many
  targets.
- **Bound context:** a contextual term may reorder candidates with comparable
  History; it must not make a weak-history destination outrank a strong habit
  on one coincidental event.
- **Report both terms:** diagnostics must show History, Context, sample counts,
  and whether Context cleared the promotion threshold.

Frequency is therefore not a veto against coupling. A habitual site can
participate in a real activity; the relationship simply has to explain more
than the site's already-high base rate.

## Development-only vertical slice

The first slice should be reviewable without changing the ordinary start page:

1. Reuse `getRecentHistory()` to request the bounded 180-day candidate pool.
2. Create a pure `habit-destinations` module that shortlists page identities
   using a union of high `visitCount` and recent `lastVisitTime`.
3. Add a development-gated background RPC that asks the existing singleton
   `RevisitStore` for History-only page/domain activation and evidence counts.
4. Run the scorer inside the existing development-only start-page recognition path,
   after the page shell is usable.
5. Add a "Habit destinations" section to the development inspector showing
   rank, action verb, History score, evidence count, evidence source, and the
   fact that Context was excluded. `HistoryItem` alone cannot establish device
   provenance.
6. Show habit and resumption lists side by side in diagnostics before adding a
   production merge policy.
7. Add shadow comparisons for:
   - current neighborhood forecast;
   - MRU;
   - Chrome `visitCount`/typed frecency;
   - ACT-R History only;
   - ACT-R History plus admitted Context.

Suggested boundaries:

```text
src/lib/revisit-store.js            background-owned History-only scoring API
src/lib/habit-destinations.js       pure candidate preparation and ranking
src/background.js                   capped, development-only scoring RPC
src/lib/habit-context.js            later association lift and promotion gate
src/newtab/start-page-recognition.js Chrome adapter and development inspector
tests/unit/habit-destinations.test.mjs
tests/perf/habit-destinations-benchmark.mjs
```

The pure modules must remain replayable without Chrome globals.

The first RevisitStore-backed result will be sparse for destinations not
qualified since the model was installed. That is acceptable in a development
inspector. A capped `getVisits()` bootstrap must earn inclusion separately
against this cleaner qualified-access baseline.

## Tests

### Unit fixtures

- A frequent, recently used destination outranks a one-off recent destination
  at Launch.
- Several distributed accesses outrank the same count compressed into one
  refresh burst once access qualification is enabled.
- A strong habitual destination remains a standalone candidate when it appears
  synchronously with an unrelated page.
- The unrelated page receives no rank lift from a single temporal overlap.
- Repeated, selective transitions can add bounded Context after clearing the
  evidence threshold.
- A frequent target paired with many unrelated cues receives little
  pair-specific lift.
- Referrer/opener evidence is distinguished from temporal overlap.
- Page evidence smooths toward domain evidence without replacing the concrete
  target URL.
- Tracking fragments normalize to one page; meaningful query parameters remain
  distinct under the current normalization rule.
- An already-open destination produces **Switch**.
- A destination recovered only from history produces **Open** or **Return**,
  never **Switch** or a claim that it is live.
- Non-local-only evidence is not silently labeled a desktop habit.
- Empty, denied, or cleared history produces no fabricated candidate.
- Invalid schemes and the Tabtopia new-tab URL are excluded.
- Candidate ordering is deterministic under tied scores.

### Coupling skepticism fixtures

Maintain a fixture containing a high-frequency destination and several
unrelated synchronous neighbors. Then permute the temporal neighbors while
preserving every destination's access history.

Required invariant:

> The habitual destination keeps effectively the same History rank; the
> permuted neighbors lose any borrowed importance.

Add a positive control with repeated referrer or transition evidence so the
test does not achieve skepticism by disabling Context entirely.

### Integration and performance

- Reuse one history snapshot per refresh; assert that the inspector does not
  issue an unbounded second `history.search`.
- Assert that slice one issues no additional `getVisits()` calls for habit
  scoring; any later bootstrap gets its own explicit cap test.
- Test cold worker, warm cache, empty profile, history clear, browser restart,
  and a saturated 5,000-row cache.
- Measure candidate-generation time separately from API time.
- Keep shell usability and keyboard search ahead of enrichment completion.
- Verify no raw URLs or titles are emitted to console or persisted in the
  ranking diagnostic buffer.

## Metrics

Keep evaluation local and development-only during the slice.

### Offline/replay quality

- Top-1, top-3, and mean reciprocal rank for the next activated destination.
- Lift over MRU and Chrome count/typed baselines.
- Results segmented by Launch, Threshold, Reinstatement, Reorientation,
  Continuation, and Handoff.
- Results segmented by source: standalone habit, neighborhood endpoint,
  deferred intention, and handoff.
- Context lift above History-only, with sample size and promotion rate.

### Coupling quality

- False promotion rate after a single temporal overlap.
- Rank stability under the temporal-neighbor permutation test.
- Precision of admitted temporal associations versus structural
  opener/referrer associations.
- Fan distribution: how many targets each admitted cue predicts.

### Runtime and privacy

- Warm and cold history-query latency.
- Candidate scoring and enrichment latency.
- Number of history rows read and `getVisits()` calls.
- Cache hit rate and cap saturation.
- Count of raw URL/title fields persisted by the new slice: must remain zero.

Activation is a behavioral proxy, not proof of intent. Dismissal and immediate
close should be recorded as ambiguous outcomes rather than direct negative
training labels.

## Exit gates

The development slice is ready to inform M2 when all of the following hold:

1. The tests demonstrate independent destination identity and the coupling
   permutation invariant.
2. Chrome History can enumerate candidates that ACT-R History usefully ranks,
   and the result beats
   or meaningfully complements MRU/frecency in replay fixtures.
3. A single temporal overlap cannot promote its neighbor; a repeated selective
   or structural relationship can add a visible, bounded Context term.
4. The implementation reuses the shared history snapshot, caps per-URL
   enrichment, and records measured warm/cold latency on a large-profile
   fixture.
5. History-unavailable and history-cleared states fail quietly with no invented
   prediction.
6. No new permission, remote data flow, persistent raw URL index, or raw
   content-bearing diagnostic is introduced.
7. The ordinary installed UI is unchanged; results remain visible only in the
   development inspector until the shadow comparison justifies a merge policy.

Promotion to the ordinary ranked action list requires a separately reviewed
state-aware merge and copy pass. It is not automatic when the engineering
slice passes.

## Explicit non-goals

- Replacing the neighborhood/resumption forecast.
- Treating the most-visited list as the entire start page.
- Claiming that Chrome History is a complete record of intent.
- Inferring private/incognito behavior.
- Naming a foreign device without synced-session evidence.
- Adding the `sessions` permission.
- Persisting a reversible raw URL/title habit index.
- Sending history, diagnostics, or ranking outcomes off-device.
- Learning opaque per-user weights in the first slice.
- Shipping time-of-day or weekday ranking before History-only is measured.
- Globally stripping query parameters or inventing app-specific URL
  canonicalizers without evidence.
- Letting a high-frequency page validate every neighborhood it happens to
  touch.
- Rewriting the Treemap, Graph, Sessions, Landmarks, or application shell.
- Exposing "we predict your next tab" language before the roadmap's evaluation
  gate is met.

## Working principle

**Frequency predicts retrieval need; context disambiguates it; topology
explains activity without manufacturing identity.**
