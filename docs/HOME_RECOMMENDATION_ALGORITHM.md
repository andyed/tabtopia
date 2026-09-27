# Home recommendations: algorithm, signals, and measurement

The [revisit research plan](REVISIT_RESEARCH_PLAN.md) documents the Mobile-folder observation boundary, separate return-prediction bootstrap, and semantic/chat-history experiments added on 2026-09-28.

This document describes the implemented `home-recs-v3` policy for the **For now → Your next destination** area. It is a bounded, explainable heuristic over local browsing evidence, bookmarks, optional selected hubs, and recent semantic context. It is not a trained next-tab model; its scores are neither probabilities nor calibrated predictions. The displayed set is at most three actions, with deliberate diversity and stability constraints, so it is not simply the three greatest scores.

There are **no default favorite hubs**. Stats, Cartographer, a GitHub profile, or any other landing page must enter through history, bookmarks, semantic retrieval, or a favorite the user explicitly saves in Options. The earlier development defaults for Stats and Cartographer were removed. The Cartographer document URL parser remains an application-specific identity rule, not a hardcoded destination or ranking bonus for that application.

## Source map and ownership

| Responsibility | Canonical implementation |
| --- | --- |
| URL identity, preferences, candidate generation, features, scoring and selection | [`home-recommendations.js`](../src/lib/home-recommendations.js) |
| Snapshot collection, bookmark tree cache, history and feedback requests | [`start-page-controller.js`](../src/newtab/start-page-controller.js) |
| Shared bounded Chrome history cache | [`history-cache.js`](../src/lib/history-cache.js) |
| Page arm assignment, slate locking, exclusions, controls and diagnostic messages | [`start-page-recognition.js`](../src/newtab/start-page-recognition.js) |
| Rendering and visibility observation | [`home-takeover.js`](../src/newtab/home-takeover.js) |
| Navigation execution | [`start-page-actions.js`](../src/newtab/start-page-actions.js) |
| Foreground-tab verification, timers, trusted message handling | [`background.js`](../src/background.js) |
| Experiment counters, feedback, pending choices and snoozes | [`home-recommendation-store.js`](../src/lib/home-recommendation-store.js) |
| Semantic endpoint cache and hidden-site preferences | [`recent-context-provider.js`](../src/lib/recent-context-provider.js) |
| Options controls and reporting | [`options.js`](../src/options/options.js), [`options.html`](../src/options/options.html) |

The controller remains the owner of data collection and refresh. The renderer reports visibility and invokes actions; it does not own a competing history collector, ranking model, or navigation implementation. Home's experiment is separate from the independent open-tab shadow prediction study and the older `home-context-v1` diagnostics. Their denominators and outcomes must not be combined.

## 1. Candidate universe and temporal meaning

The ranker merges candidates by canonical page identity, accumulating evidence across sources. Being an open tab changes **Open** to **Switch** but does not itself add a candidate or a score bonus.

| Source | Input bounds | Admission and meaning |
| --- | --- | --- |
| Selected hubs | At most 12 unique URLs | Explicit Options preference. No default URLs. Can enter without history. |
| Recent semantic context | First 12 results | Only a still-valid context response with at least one seed. |
| Chrome history | Scan at most 5,000 rows; shortlist at most 800 | Documents are sorted ahead of ordinary pages, preserving source order within each group. Non-documents need last visit within 28 days and at least two accumulated visits, unless already admitted by context/favorites or a supplied qualified-visit count is positive. Documents may have last visit within 180 days and do not need two visits. Future or invalid last-visit timestamps are rejected. |
| Chrome bookmarks | Prioritize newest Mobile-folder saves before a 10,000 URL-node scan; shortlist at most 800 | Mobile-folder bookmarks first by save recency, then documents, then original bookmark-tree traversal order. No bookmark-age cutoff. All scanned valid bookmarks contribute to density even when outside the action shortlist. |

The collector requests the shared 180-day, 5,000-row history snapshot, ordered by latest visit. Its cache TTL is five minutes; Chrome history events invalidate the cache. Recommendation bookmarks come from the full Chrome bookmark tree, flattened in tree order and cached in the controller; create, remove, change and move events invalidate that cache. This is distinct from the smaller recent-bookmark list used by other Home sections.

The maximum identity list for a feedback lookup is 1,624 before deduplication: 12 hubs + 12 context results + 800 history rows + 800 bookmarks. The feedback store accepts at most 2,000 distinct requested identities. These limits bound computation; they also affect what can be recommended.

**Visit counts are Chrome's accumulated `visitCount` for the URL, not counts reconstructed inside the last 28 days.** The date gates above apply to `lastVisitTime`. “Visited 141 times” means the supplied accumulated count, not “141 recent engaged visits.” Repeated reloads can contribute to that count. The current ranker supports `qualifiedVisits`/`qualifiedVisitCount` in input rows, but the live controller passes compact Chrome history rows without those fields, so that score term is currently zero in this collection path. The separate qualified revisit model used elsewhere is not automatically joined into this ranker.

When multiple history URLs collapse to the same identity, the ranker takes maximum visit count, maximum qualified count and latest visit timestamp; it does not sum potentially overlapping counts. The latest matching history URL becomes the navigation target. This matters for document views with changing navigation parameters.

### Candidate-pool limitations

- A useful old page can be absent because it fell outside the 5,000 most recently visited URLs or the 800-row shortlist. Documents receive reserved priority through ordering, not a separate unbounded scan.
- Bookmark order is tree order, not recent relevance. Large bookmark collections can bias which pages become actions even though more bookmarks contribute density.
- The system does not invent an unvisited parent landing-page URL from children. The parent must already be a candidate.
- Missing or stale capture data removes semantic evidence, not the history/bookmark/favorite recommendation path.
- Scores can be negative; there is no minimum usefulness threshold before filling remaining slots. A small candidate universe can therefore yield weak recommendations.

## 2. Identity: page, site, document and subtree

`recommendationIdentity(url)` accepts HTTP(S), rejects embedded credentials and strings longer than 8,192 characters, removes the fragment by omission, lowercases hosts and strips leading `www.`. Page identity retains protocol, path and query. Query ordering and trailing slashes are not generally normalized away; arbitrary query parameters may identify different content.

Loopback hosts `localhost`, `127.0.0.1` and `[::1]` share the `localhost` identity spelling, while retaining port. Thus Stats on `:8765` and Cartographer on `:2527` are different sites for diversity and path evidence. HTTP and HTTPS retain different page identities, while the site key itself is hostname plus port and does not include protocol.

A document is a path ending in `.md`, `.markdown`, `.pdf`, `.txt`, `.doc` or `.docx`, case-insensitively. The special Cartographer case requires all of:

1. A recognized loopback host on port 2527.
2. The exact pathname `/memory`.
3. A decoded `file` query value ending in `.md` or `.markdown`.

For that case, identity is `protocol://localhost:2527/memory?file=<encoded file>`. Other query fields such as time filters and review navigation are ignored **for identity**, while the decoded file path supplies the document path and its parent subtree. Navigation still uses the actual source URL, updated to the newest known history variant. Generic Cartographer titles become the filename so different documents remain legible. This parser does not generalize to arbitrary applications that place documents in query parameters.

Examples:

```text
http://127.0.0.1:8765/#overview
  → page http://localhost:8765/; site localhost:8765

http://localhost:2527/memory?file=%2Frepo%2Fnotes%2Fplan.md&review=file&hours=24
  → page http://localhost:2527/memory?file=%2Frepo%2Fnotes%2Fplan.md
  → document path /repo/notes/plan.md

https://github.com/example-user
  → page https://github.com/example-user; site github.com; path /example-user
```

Ancestor counting uses complete path segments. `/example-user` does not own `/example-user-other`; a profile does not receive every bookmark on `github.com`. Canonical bookmark page identities are deduplicated before counting. Query variants remain distinct bookmark pages unless the special document rule collapses them; revisited branch evidence, by contrast, counts distinct child **paths**, so several query variants of the same path do not masquerade as several child pages.

## 3. Hub inference

Hub inference is generic, independent of hostname or a known port. A candidate is eligible only when it is not a document, its canonical page URL has no query, and it has admitted history evidence. Let:

- `v` = accumulated visits on that candidate;
- `b` = number of distinct strict descendant paths with at least two accumulated visits and a last visit within 28 days;
- `a` = candidate's age since last visit, measured in days.

The candidate becomes an inferred hub when `v ≥ 12`, or when `v ≥ 3` and `b ≥ 2`. Descendant evidence is built from the first 5,000 history rows before the 800-candidate shortlist. It uses same-origin ancestry, so a child from another protocol or port does not support the parent. A sibling or a query variant of the parent's own path is not a child.

The inferred hub bonus is:

```text
H = [0.9 × min(1, ln(1 + v/8))
   + 0.6 × min(1, ln(1 + b) / ln(8))] × exp(-a/28)
```

An explicit selected hub instead receives `2.2`; the selected and inferred bonuses are not added together. A selected hub can also satisfy the inference rule, and output features retain that fact. The common repeat-count portion saturates quickly, limiting the advantage of extremely high visit counts.

This infers a **frequently revisited landing page**, not proven task centrality. Twelve reloads of a root can pass. The branch alternative gives stronger structural evidence, but still uses accumulated counts and latest timestamps rather than distinct engaged days or observed navigation transitions. There is no learned task graph behind the label “Hub for N revisited pages.”

## 4. Bookmark density and document priority

Bookmarks are Chrome bookmarks, not GitHub stars and not bookmark-folder names. “Area” means a URL path subtree, or a decoded document-file subtree for the Cartographer rule.

For each candidate:

1. Determine its path without one trailing slash.
2. Use its **own subtree** if it is an inferred hub, or if it is a non-document with bookmarked children beneath that path.
3. Otherwise use the parent path. This lets an ordinary document benefit from saved documents beside it.
4. Exclude the candidate's own bookmark from both support and the site total, because the self-bookmark has a separate bonus.

Let `p` be distinct other bookmarked pages in that subtree and `s` be distinct other bookmarked pages on the same site. Density is zero when `p = 0`; otherwise:

```text
D = (p + 0.5) / (s + 2)
bookmark path bonus = min(1, D × ln(1 + p) × 0.5)
```

The pseudocounts prevent one saved neighbor from producing a perfect density of 1. The logarithm rewards evidence volume with diminishing returns. This is a smoothed share of the site's bookmarks, **not** a bookmark-to-visit ratio or an empirical probability that the candidate is useful.

A self-bookmark adds `0.35` independently. A recognized document adds `0.7`, and also gets the longer history eligibility horizon and preferred shortlist position. The document boost is categorical, not inferred from text contents, markdown link structure or actual reading completion.

## 5. Exact score, repetition costs and explanations

All logarithms below are natural. Let `q` be supplied qualified visits, `c` be cosine similarity clamped to `[0,1]`, `I` and `E` be retained per-destination exposures and engaged outcomes, `t` minutes since last exposure, and `u` minutes since last engagement. Missing feedback timestamps behave as no recent exposure or engagement.

| Component | Contribution |
| --- | --- |
| Hub | `2.2` if selected; otherwise inferred `H`, or zero |
| Fresh semantic match | `0.7 + c` |
| Document | `0.7` |
| Self-bookmark | `0.35` |
| Visit volume | `min(1.5, 0.3 × ln(1 + v))` |
| Qualified visit volume | `min(0.8, 0.35 × ln(1 + q))`; currently zero in live Chrome-history collection |
| Recency | `0.35 × exp(-a/7)` when history is present |
| Bookmark path | `min(1, 0.5 × D × ln(1 + p))` |
| Accumulated exposure fatigue | subtract `min(2.5, 0.45 × ln(1 + max(0, I - E)))` |
| Very recent exposure | subtract `1.2 × (1 - t/10)` for `0 ≤ t < 10`; otherwise zero |
| Recent engagement | subtract `1.8 × (1 - u/30)` for `0 ≤ u < 30`; otherwise zero |

The exposure count called `impressions` in per-destination feedback is an individual item's exposure count, not the aggregate slate-impression count. Counts use retained UTC daily buckets; the accumulated fatigue term does not smoothly decay within those buckets, but old days eventually leave retention. A successful engaged recommendation partially offsets accumulated non-engagement fatigue while temporarily reducing immediate repetition. Engagement is not an additional positive affinity score.

These weights are hand-set. The sum mixes several kinds of evidence with overlapping information: visits and hub inference, for example, are intentionally correlated. It should be inspected and evaluated as a heuristic, not interpreted as an independently calibrated likelihood model.

Returned features include selected/inferred hub flags, hub strength, branch count, document flag, bookmark subtree/support/density, context flag, similarity, visit counts, fatigue, engagement penalty and total score. `sources` retain provenance. Explanations are emitted in a fixed order: selected/inferred hub, semantic context, document, visit count, bookmark support or self-bookmark. The UI displays the first two reasons, so these are useful concise provenance labels, not a full attribution of the final score.

### Reproducible worked example

The following is a **synthetic fixture**, not a reconstruction of the user's live profile. Set all three latest visits to one day ago, use no favorites or semantic results, and add exactly three bookmarks: `github.com/example-user/a`, `github.com/example-user/b`, `github.com/other/c`. There are no revisited child-history rows. Executing the actual `buildHomeRecommendations` function produces:

| Candidate | Visits | Inferred hub bonus | Bookmark path bonus | Total, no feedback |
| --- | ---: | ---: | ---: | ---: |
| `github.com/example-user` | 77 | 0.868424 | 0.274653 | 2.753497 |
| `localhost:8765/` | 141 | 0.868424 | 0 | 2.658580 |
| `localhost:2527/` | 29 | 0.868424 | 0 | 2.192191 |

For the GitHub profile, `p = 2`, `s = 3`, so `D = 2.5/5 = 0.5`. All three qualify as inferred hubs through repeat count without an explicit URL rule. If Stats has three recorded exposures, no engagement and was last shown five minutes ago, its fatigue becomes `0.45 × ln(4) + 0.6 = 1.223832`, reducing its score to `1.434747`. In a newly built balanced slate, Cartographer moves ahead of Stats. A currently visible locked slate deliberately does not reorder itself as that feedback arrives.

## 6. Selection, exploration and stable interaction

Each new Home document chooses `balanced` or `explore` from the parity of a cryptographically generated 32-bit integer: a 50/50 page-level assignment. Disabling exploration forces `balanced`. The assignment is fixed for that document; this is not a persistent user-level split. The per-page UUID and alternatives round form the exploration seed.

Selection proceeds as follows:

1. Remove invalid, hidden, snoozed and explicitly excluded identities during candidate generation.
2. Score descending, breaking equal-score ties by canonical identity.
3. Preserve still-eligible locked identities in their prior order, subject to diversity.
4. If a slot is available and no selected action is an unresolved mobile intention, reserve one for a closed Mobile-folder bookmark without an observed thirty-second desktop visit after its save. Choose by lower fatigue, newer save, then heuristic score; honor diversity and explicit exclusions.
5. Fill the balanced slots: three for balanced, or two for explore, less anything already locked or reserved.
6. For explore, choose one candidate from the first 12 score-ranked diverse candidates that are explorable. Sort that small pool by identity, then choose `FNV-style hash(seed) mod pool.length`.
7. Fill any remaining slots by score while retaining diversity, even if that leaves fewer than three items.

An explorable candidate must be a selected hub, a semantic match, a document, or have at least two visits; its recent-engagement penalty must be zero and total fatigue must be below `2.5`. A bookmark-only candidate can fill by score but is not eligible solely on bookmark status for the special exploration slot. There is no displayed “exploration probability,” logged candidate propensity, adaptive bandit, or training update.

Diversity normally permits one action per site, with ports preserved. A hub and one document may share a site if their identities and paths differ. Both inferred and selected hubs qualify for this exception. It is not topic-vector diversification, and it does not guarantee unrelated subjects. A document plus another ordinary document on the same site is still limited to one.

Once at least one recommendation is visibly exposed, the full displayed slate is locked. Late context arrivals and feedback writes do not reshuffle a set while someone is choosing. Candidates can still disappear if no longer eligible, expired, hidden, snoozed or excluded. Preference changes clear the lock. Cached Home paint intentionally omits recommendations until current preferences and feedback have been read.

**Show alternatives** excludes the immediately previous slate, clears the lock and increments the exploration round. It does not maintain an all-session exclusion history; a later request can return an older slate. If no alternative is eligible, exclusions are cleared and the current pool is restored with an explanation. This control plus fatigue reduces repetition but does not promise never-repeated recommendations.

**Snooze** removes an identity for one day; Undo removes that preference and gives the restored item first claim on the visible lock. **Hide site** stores a persistent site exclusion, with Undo. For loopback apps the exclusion retains port; normal remote-site hiding also covers subdomains. Selected hubs do not override hide or snooze. Neither development nor packaged installs have default site exclusions. Only explicitly saved preferences apply.

## 7. Supplemental context is disconnected

The public build does not fetch semantic context, archive search, or GitHub stars
from a service. Compatibility readers can display previously stored local data;
context expires after its recorded deadline. Home still ranks local history,
bookmarks and selected hubs when no supplemental context exists.

The provider modules retain their call contracts so a separately maintained
local overlay can supply data without forking the controller or ranking code.
No local overlay, service endpoint, credential path or corpus configuration is
included in the release.

## 8. Measurement lifecycle and interpretation

Measurement is local and follows the existing ranking-diagnostics setting, enabled by default for a development install unless explicitly changed. Normal installs default off. Recommendation selection still operates when measurement is off, but learned exposure/engagement fatigue does not accumulate. Explicit preferences remain usable.

### Exposure

The renderer observes recommendation links with `IntersectionObserver` and visibility changes. A visible document, mounted non-hidden Home root, positive link dimensions and at least half the link's **vertical height** inside the viewport are required. The implementation checks vertical geometry, not full visible area or occlusion. There is no minimum exposure duration, gaze measurement or proof the text was read.

A slate impression is counted when the first eligible candidate becomes visible. Each newly visible candidate in that slate adds one exposure and one destination-feedback impression; scrolling lower candidates into view extends that same impression. The page deduplicates exposed identities for the slate signature, and the background deduplicates candidate identities/ranks for its impression ID and source tab. A changed signature can create another impression. A fire-and-forget diagnostic failure may lose data; this is not guaranteed-delivery analytics.

### Choice and engagement

A normal primary-link action records a choice before invoking the canonical action executor. It must match a previously exposed candidate by impression, source tab, rank and canonical identity. Open actions bind the pending choice to the new-tab page's tab; Switch actions bind to the existing destination tab ID. Matching a URL in another unrelated tab is insufficient.

The background queries the active tab in the last-focused window, verifies actual window focus and excludes incognito tabs. When the chosen identity reaches the expected tab, continuous dwell starts. One bounded timeout rechecks it after the remaining part of ten seconds, with a small scheduling margin. Tab activation, navigation, window-focus and removal handlers feed the same observer; no separate polling loop owns focus.

- Ten continuous focused seconds records one `engaged` outcome and clears the pending choice.
- Leaving the identity/tab or losing focus after dwell has started records one `bounce` and clears the choice. Returning later does not complete the old attempt.
- An unrelated focus event before the destination is first reached does not immediately label the click a bounce; it can still be in navigation.
- If browser navigation fails, cancellation removes the pending choice but retains the attempted click count. A retry may create a new attempt.
- Worker suspension/restart cannot prove continuity; the worker-session token resets dwell evidence rather than crediting elapsed background time.
- Only one choice is pending globally. A later choice can replace it; an already-focused replaced choice is counted as a bounce.

Modified clicks and non-primary native navigation bypass the action callback to preserve browser behavior. Their clicks/engagement are not captured by this path. Failed message delivery, a destination never reached, closing or suspending before observation, and pending-choice expiry can leave clicks without engaged/bounce outcomes. Pending records age out after 30 minutes on access. The store does not currently emit a complete censoring/failure taxonomy; the presence of an `expired` detail whitelist is not evidence that all expirations are logged.

The Options report sums **slate impressions, candidate exposures, attempted clicks, engaged choices, bounces and snoozes** separately per arm. Engaged/exposure and click/exposure can be useful descriptive ratios, but exposure is not a randomized independent person and engagement is only the ten-second proxy. Unengaged is not synonymous with rejected; bouncing is not necessarily failure for a quick useful task. Hide-site actions have their own preferences but no dedicated v3 aggregate counter.

### Why the current arm comparison is descriptive

The page-level assignment is randomized, but this is not a clean independent A/B outcome estimate:

- Both arms share per-destination feedback, so one arm's exposures alter the other's future rankings.
- The same person contributes repeated correlated pages and choices.
- Locking, manual alternatives, exclusions, snoozes and live candidate availability affect what each assigned arm actually displays.
- The explore arm may have no eligible exploration candidate or may retain a fully locked slate.
- No full candidate set, seed, arm-assignment probability, item-selection propensity or stable slate linkage is preserved in durable detail rows.
- Small samples, changing tasks and missing/censored outcomes can dominate apparent differences.

Do not call an arm a winner from a handful of events, interpret heuristic scores as confidence, or use the open-tab shadow study's performance as evidence of this Home policy's usefulness.

## 9. Persistence and privacy boundaries

| Store/key | Data and lifetime |
| --- | --- |
| Local `tabtopiaHomeRecommendationPrefsV1` | Explicit hub URLs/titles and exploration setting; at most 12 hubs. User preferences persist until changed. |
| Local `tabtopiaContextHiddenSitesV1` | Explicit hidden-site strings, bounded to 100; persists until changed. |
| Local `tabtopiaHomeRecommendationSnoozesV2` | HMAC-keyed identity → expiry; bounded to 2,000, ordinary UI duration one day, API maximum 28 days. |
| Local `tabtopiaHomeRecommendationStudyV3` | Up to 28 UTC day buckets per arm; up to 2,000 destination-feedback identities; last 500 whitelisted detail rows within 28 days. |
| Session `tabtopiaHomeRecommendationPendingV3` | Raw candidate identities/URLs, source/target tab binding, impression IDs and pending dwell; up to 64 recent impressions, aged out after 30 minutes on access, one pending choice. |
| Session `tabtopiaRecentContextV1` and history/Home caches | Raw browsing-derived data needed by the local UI, bounded and freshness-checked by their owners. |

The V3 measurement cohort starts fresh so the mobile reservation policy is not pooled with V2. Explicit snooze preferences retain their existing V2 key and HMAC namespace.

Destination feedback uses HMAC-SHA-256 through the existing revisit store's local secret, with namespace `home-recommendation-feedback-v2:`. This gives stable per-install opaque keys rather than plaintext URLs in durable study feedback. It is not anonymization against someone who controls that install and its secret. Durable detail rows contain cohort, timestamp, arm, event, rank and count; they do not contain URL, title or a recoverable candidate list.

Disabling or clearing diagnostics removes current V3 and legacy V2 study and pending state, using generation checks to prevent queued operations from repopulating cleared measurement. It intentionally does not delete explicit favorite, hide or snooze preferences. Runtime messages are accepted only from non-incognito extension pages, and the background derives source tab ID from the sender rather than trusting the payload.

These are boundaries for this recommendation feature, not a claim that the extension or companion has no other browsing-history storage. Raw history, application state and indexed page content exist in their respective existing systems. No recommendation-experiment upload is added by this store.

## 10. Validation and next experiments

Implementation contracts are covered by [`home-recommendations.test.mjs`](../tests/unit/home-recommendations.test.mjs), [`home-recommendation-store.test.mjs`](../tests/unit/home-recommendation-store.test.mjs), [`recent-context-provider.test.mjs`](../tests/unit/recent-context-provider.test.mjs), [`recent-context.spec.js`](../tests/e2e/recent-context.spec.js) and [`home-recommendation-options.spec.js`](../tests/e2e/home-recommendation-options.spec.js). Private adapters need their own retrieval tests. Fixtures can prove identity, scoring, rotation, timing, persistence and navigation behavior; they cannot establish recommendation utility for actual browsing.

The following are **proposed extensions, not implemented signals or guarantees**:

| Extension | Reason to explore | Evidence/metrics needed before adoption |
| --- | --- | --- |
| Qualified revisit days and sessions | Resist refresh loops and accumulated-count bias; distinguish a regular hub from a one-time burst | Distinct engaged days, return sessions, hub false-positive review, incremental engaged/exposure lift |
| Transition-derived hub centrality | Learn landing pages used to reach useful descendants instead of inferring solely from URL hierarchy | Qualified parent→child transitions, return-to-hub counts, task-conditioned coverage |
| Time-of-day and day-of-week routine | Surface recurring tools when they are usually needed | Adequate per-period support, temporal holdout, drift handling and explicit cold-start fallback |
| Better document adapters | Extend query-based document identity without collapsing meaningful application state | Adapter-specific collision tests, document reopen success, title quality; no blanket query stripping |
| Multiple recent semantic clusters | Avoid a centroid between unrelated concurrent tasks | Seed coverage, cluster cohesion, recommendation diversity and human utility versus single-centroid baseline |
| Engagement-derived positive affinity | Distinguish productive returns from merely reducing repetition | Time-to-useful-action, manually rated utility, short-task treatment, false dwell positives |
| Topic and path diversity | Avoid three different hosts about the same subject, or one overrepresented project | Slate coverage/novelty, repeat rate over 10/30/60 minutes, engaged/exposure without increased snoozes |
| Minimum usefulness threshold | Avoid filling with low-evidence leftovers | Empty-slate rate, manual search fallback, useful-choice rate and user preference for fewer suggestions |
| Better experiment instrumentation | Make comparison auditable and reduce censoring ambiguity | Durable anonymous slate IDs, eligible count, intended/effective policy, assignment probability, item propensity, success/failure/censored categories |
| Adaptive bandit after instrumentation | Allocate exploration according to learned reward under explicit constraints | Correct selection propensities, delayed reward model, uncertainty bounds, replay/holdout checks, policy-version isolation |

A useful first readout should show retained sample sizes and opportunity coverage alongside rates: visible slates, exposed actions, clicks, ten-second engaged choices, explicit snoozes, and the fraction of requests with enough eligible candidates to explore. Repetition metrics should distinguish a deliberately locked open page from the same destination repeatedly offered on new visits. Measure quick useful actions separately before increasing the dwell threshold. Record such additions under a new policy/instrumentation version where semantics change, rather than silently mixing them into `home-recs-v3`.
