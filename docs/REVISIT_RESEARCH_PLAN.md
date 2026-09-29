# Revisit prediction and saved intentions

Implementation and research direction, 2026-09-28. The immediate product problem is a page saved on a phone as a placeholder for deeper desktop work, then forgotten. Returning to an existing tab is only one part of that problem.

## What is implemented

| Layer | Current behavior | Evidence boundary |
| --- | --- | --- |
| Existing next-tab study | Twelve models, corrected `next-tab-matrix-v3`, up to 5,000 compact detail records within 2 MiB; 90 UTC days of aggregate results | Evaluates the next other open tab. V2 observations remain excluded. No automatic exposure when its gate passes. |
| General page-return study | `page-return-opportunities-v1`: does this page return within 10, 50 or 200 subsequent qualified page accesses? Base-rate and frequency/recency models run in shadow | Includes pages reopened after closing and same-tab navigation to another page. It does not yet predict all unvisited bookmarks or rank Home. |
| Saved bookmark observations | `bookmark-to-desktop-v1`: bookmark inventory, first observed opening, and first observed 30-second continuous foreground desktop visit | A focused dwell is a proxy, not proof of reading, understanding, usefulness or completion. |
| Home policy | `home-recs-v3` reserves one available slot for an unresolved Mobile-folder bookmark, before ordinary score filling | This is an explicit saved-intention heuristic, not a measured mobile uplift or a trained return probability. Existing locks, hide, snooze and exclusions still apply. |
| Semantic exploration | A runnable local probe retrieves browsing and Cartographer evidence separately for task, page and saved-intention facets | Discovery evidence only. It is not connected to live Home ranking or model training. |

The implementation remains in the local checkout. Browser fixtures do not establish that an already-running user extension has loaded it, or that these policies improve actual browsing.

## Mobile bookmarks: give the intention a chance to finish

The useful hypothesis is **a Mobile-folder save is often a deferred intention to use a larger desktop workspace**. Its first desktop visit may be the useful event, even when Chrome has no prior desktop history for the page. A return model trained only on previously visited desktop pages would miss this case entirely.

The collector preserves the browser's `folderType`, folder path, save timestamp and account-storage metadata. Only the browser's `folderType: "mobile"` supplies the mobile-folder cue. A folder title, `syncing: true`, or `dateLastUsed` does not prove where a bookmark was created or whether it received a deeper desktop visit. Chrome permits multiple folders of a type, and folder membership can change. See the [Chrome bookmarks API](https://developer.chrome.com/docs/extensions/reference/api/bookmarks).

For the first version:

- Track the newest 800 distinct Mobile-folder pages and 200 other bookmark pages as a descriptive comparison group. Mobile saves are selected before the general candidate scan bound, even when that folder follows thousands of desktop bookmarks. This is a bounded inventory, not an unbiased randomized sample.
- Count a focused desktop opening at two seconds. Count a deeper-visit proxy at thirty uninterrupted seconds in the same tab. Switching, blur, a worker restart or a substantially delayed timer interrupts the interval.
- Prefer one closed, unresolved mobile bookmark when Home has a free slot. A quick opening does not erase the cue. Prioritize lower recommendation fatigue, then newer saves. A locked visible slate stays stable.
- Use “From Mobile bookmarks” and “No deep desktop visit recorded” as receipts. Do not say “never read”: activity before instrumentation and on other devices is unknown.
- A newer save renews the intention. Removing a bookmark removes its tracked entry on synchronization. Hide and snooze remain explicit user controls. Turning diagnostics off stops and clears the observations; folder membership can still supply the heuristic, with prior reading unknown.

The mobile and other groups report tracked, opened, deeper-visited and pending counts, including saves older than a week. These totals cannot establish that mobile saves are more likely to be revisited: the groups have different selection, ages and observation windows. A proper comparison needs new-save cohorts, matched maturity and prospective follow-up. Older imported bookmarks have `firstObservedAt` distinct from `savedAt` so they need not masquerade as newly observed saves.

The current focus signal comes from this desktop Chrome profile. It cannot observe a native PDF reader, Safari, another computer or a phone. A later explicit “Done” action or a separately authorized native-app observer could close that gap. Neither is implemented here.

## The bootstrap target

After each distinct qualified page access at time t, freeze three predictions:

> Will this same page be accessed again within the next N qualified page accesses, for N = 10, 50, 200?

An access needs two seconds in a focused, non-incognito tab. Consecutive accesses to the same normalized page count once; fragments are ignored and meaningful queries are retained. Reopening a closed page can be a return. Reloads and immediate refocus are not additional opportunities.

An anchor is positive if a later access to the page occurs before its horizon. Both positive and negative labels mature at the horizon, so fast positives cannot train earlier than negatives. Inactivity is not a negative. An anchor still waiting after ninety days is censored, with unresolved horizon counts reported. “No observed return within N accesses” is not “irrelevant” or “will never return.”

The base model uses a Beta(1,1) smoothed return rate from matured observations. The history model conditions on prior visit-frequency and access-recency buckets, backing off with twenty pseudo-observations at the base rate. Features and predictions are frozen before future accesses. The ninety-day training window adapts without retaining raw page content. This simple comparison provides a useful bootstrap before semantic features enter the model.

Reports show denominators, pending and censored labels, return rate, Brier score, log loss, calibration error, precision, recall and balanced accuracy. The Options cards surface sample counts, Brier and calibration. Ordinary accuracy alone would reward predicting the majority class. “Seen before” is relative to the bounded tracked history, not the user's lifetime history.

This is a **page-access anchored target**. Two additional targets should stay separate:

1. **Next destination is familiar versus new:** an opportunity-level model that could decide whether Home should emphasize return or exploration. The current seen-before count is descriptive; it is not this predictive model.
2. **Saved intention gets a useful desktop visit:** a save-anchored model over unseen bookmarks, followed by candidate ranking. The bookmark observer begins the data collection, but no bookmark classifier has been trained.

Combining these targets too early would hide distinct denominators and failure modes.

## Optional retrieval research

Cross-source retrieval is a research direction, not a dependency of Tabtopia.
A separately maintained experiment can compare task intent, page excerpts and
saved intentions while retaining source receipts and availability timestamps.
Similarity alone is not a revisit probability. Evaluate its incremental value
against the local history and bookmark baselines, without leaking future data.

The private deployment probe and corpus inventory are not shipped with the
public project. No service, vector database or credential file is discovered by
Tabtopia. The pure query and evidence-fusion helpers remain independently testable.

## Bonus outcomes from Cartographer chat history

| User need | Useful connection | Evidence and success signal |
| --- | --- | --- |
| “Why did I save this?” | Page/bookmark → the earlier user request or decision that supplied its purpose | Quote or link the source turn; user confirms the recovered intention |
| “Resume this project” | Current explicit task → previous decisions, relevant pages and concrete artifacts | Time to a useful action; fewer manual searches; no stale decision presented as current |
| “I forgot the phone save” | Unresolved mobile intention → a relevant desktop task window | Subsequent deeper visit or explicit completion, with snooze burden measured |
| “We already solved this” | Current problem → prior confirmed diagnosis, fix and validation | Source-backed reuse; distinguish abandoned hypotheses from verified outcomes |
| “What did this resource lead to?” | Page → chat → code, paper, plan or document produced later | A navigable provenance trail; outcomes help explanations but cannot leak into earlier predictions |
| “What is still unfinished?” | Explicit commitments and deferred tasks → latest observed resolution evidence | Correct open/closed status; missing evidence stays unknown |
| “These projects connect” | Separate project clusters linked by a shared method, source or decision | Human-rated usefulness and cross-project discovery, with project scope visible |
| “Make my archive navigable” | Better titles, entity links, duplicate families and topic neighborhoods | Retrieval success and correction rate, even if revisit prediction never improves |
| “Remind me at the right moment” | Saved intention + current task context + explicit reminder preference | Useful reminder rate and interruption cost; requires a separate notification feature |

This provides value even if embeddings add little to return accuracy. It also makes capture defects visible: missing URLs in chat events, prefix truncation, tool-output dominance, stale summaries and broken source links.

## Evaluation and next investment

### Discover signals proactively

Use `scripts/audit-revisit-signals.py` against a read-only history snapshot with
explicit date bounds and timezone. Keep results private: aggregate counts and
timing patterns can still describe an individual's browsing. Exploratory proxy
gains do not establish qualified-return or Home ranking quality.

The user should not have to supply the feature list. Time-of-day and weekday were already in the start-page roadmap, yet the first return bootstrap only used frequency and recency. Listing a possible signal in a roadmap is not the same as inspecting the available evidence, testing it, or explaining why it was deferred. Signal discovery is now an explicit research stage before selecting another production feature.

The target is a useful next action conditioned on task, circumstances, capability and unfinished commitments. A frequent return is one useful label; a missed intention, a short successful lookup, a completed document and an unnecessary interruption are distinct outcomes.

| Signal family | Hypotheses to generate without waiting for user suggestions | Available evidence and next observation gap |
| --- | --- | --- |
| Rhythms and recurrence | Circular hour, individual weekday, weekday × hour, typical return interval, first access of a day, routine after an absence | History provides timestamps; capture timezone offsets prospectively. Shrink sparse page rhythms toward domain/task rhythms. Weekend/workday is a fallback, not an assumption about this person's schedule. |
| Sequences and transitions | What follows email, search, a project dashboard, a meeting or a documentation page; return-to-hub patterns | Existing transitions, referrers/openers and previous destination. Separate within-task transitions, task changes and session starts. Calendar events are not currently observed. |
| Intent and unresolved work | Mobile save awaiting desktop use, a reopened unfinished document, an explicit chat commitment with no observed completion | Bookmark provenance and Cartographer user turns. An assistant proposal is not a user commitment; absence of a completion receipt leaves status unknown. |
| Device and opportunity | First desktop opportunity after a phone save; content better suited to reading, editing, listening or a native application | Mobile-folder cue and local/remote history provenance. Remote sync is not proof of phone origin; native application completion is currently unobserved. |
| Task and project context | Active project, work phase, recurring method, several concurrent task clusters, task-specific weekday routines | Pages plus role-separated chat intentions/decisions and source-linked artifacts. Legacy embeddings lack reliable recipe and availability provenance. |
| Interaction and investment | Focused dwell, distinct return days, meaningful scroll/selection, edits, search reformulation, repeated brief checks | Some focus/visit observations exist. Tab-open duration is not attention; scrolling and interaction coverage need auditing before use. |
| Choice and negative feedback | Explicit hide/snooze, observed alternatives, repeated exposures, deliberate novelty, successful short visits | Home feedback exists. Exposure propensities and sufficient evidence to interpret an ignored card are missing. |
| Change and exceptions | New project bursts, routines that shift, travel/timezone changes, different behavior at a deadline, stale standing intentions | Timestamps and project histories permit hypotheses. Do not infer travel, meetings, deadlines or latent personal circumstances without evidence. |

For every candidate signal, record the mechanism, exact target, source, grain, availability time, expected direction, missingness, feature recipe and model version, overlap with existing predictors, acquisition cost and failure modes. Give it an explicit status: observed association, historical proxy test, prospective shadow test, rejected, or useful enough for a controlled product experiment. Missing evidence and a tested null result are different statuses.

Run a fixed first-pass battery across those families, then compare incremental value against frequency, recency/MRU and existing transitions. Evaluate interaction terms and task-specific groups with shrinkage, support counts and chronological holdouts. Keep a genuinely untouched future interval for confirmation after exploratory model selection. A weekday-only failure does not falsify task-specific weekly routines, and inspecting many features does not make the best observed association trustworthy by itself.

Audit the observation process too. Agent tool events, generated summaries, reloads, sync backfills and high-volume local application traffic can produce convincing patterns without representing intentional browsing. Stratify these sources. Loopback applications can also be valuable user destinations, so do not globally discard them or label them automation merely because they are local. Check stability across weeks and measure distinct opportunities as well as raw event totals.

Keep clock, sequence, provenance, support and exposure features structured. Do not expect adding “Tuesday morning” to an embedding string to learn a reliable periodic prior. Use embeddings to connect intent, subject matter, project phase and prior outcomes to candidate resources; use the structured observation model to estimate whether this is a useful opportunity to offer them. Preserve multiple concurrent task contexts and a source-linked explanation for each suggestion.

The existing implementation creates a measurement foundation and one explicit mobile-intention policy. The next experiments are:

1. **Observe cohort health:** verify loaded extension version, eligible access volume, pending maturity, bookmark tracking coverage, focus interruptions and storage usage. Collect outcomes from genuinely new saves separately from the imported backlog.
2. **Run the signal-discovery audit and behavioral baselines:** compare smoothed base rate and frequency/recency by horizon, then test temporal, sequential and intent signals with their correct labels and availability. Compare Mobile and other saves with equal follow-up and age strata.
3. **Improve semantic inputs:** split explicit user intentions, decisions, outcomes and tool records. Add model/recipe and available-at provenance before building historical training rows. Review source receipts for a fixed set of real tasks, including failures, to measure retrieval usefulness.
4. **Run prospective ablations:** behavior only; + bookmark cues; + page semantic evidence; + explicit chat intentions; + verified prior outcomes. Log predictions before outcomes, freeze feature timestamps, report coverage and latency, and keep missing embeddings explicit.
5. **Evaluate utility on Home:** useful choices, completed saved intentions, repeated ignored suggestions, snoozes, off-list departures, manual-search time and interruption cost. The existing ten-second Home engagement proxy remains distinct from the thirty-second bookmark proxy.
6. **Randomize exposure only with an auditable design:** record eligible candidates, assignment and item propensities, intended/effective policy and delayed/censored outcomes. Current balanced/explore totals are descriptive, not causal lift. Keep this new mobile policy's measurements separate in V3.

Use chronological walk-forward evaluation. Purge training anchors whose observation horizons overlap the evaluation interval; cluster uncertainty by browsing session/day instead of treating overlapping anchors as independent people. Report Brier/log-loss/calibration against base rate, discrimination where sample support permits, and per-group sample sizes. Neither semantic similarity nor offline next-tab gains prove Home utility.

For service investment, prioritize token-aware extraction, source receipts, consistent versioned caching and query-time filtering before a larger model. Cache by content digest and recipe/model, embed on content change, batch backfills with resumable checkpoints, and reuse the warm local service. Do not put embedding calls on every keystroke or require the companion service for core navigation. A later hybrid lexical/vector retriever can preserve exact URLs, API names and project identifiers that dense similarity misses.

## Retention, storage and controls

Chrome's normal `storage.local` quota is 10 MB; increasing a JSON ring tenfold without measuring it is unsafe. The new detail codec preserves numeric precision, supports legacy arrays on read and writes a compact dictionary/tuple envelope on the next flush. The detail budget is **up to** 5,000 records and 2 MiB, whichever fills first. Ninety-day aggregates retain all accepted study outcomes even when detail rows roll off. See the [Chrome storage API](https://developer.chrome.com/docs/extensions/reference/api/storage?hl=en).

A synthetic run with ninety days, 120 outcomes/day and twelve models retained 2,966 precision-heavy detail records in 2,096,793 bytes and aggregates in 2,350,621 bytes. A separate 2,700-access return-study fixture used 580,475 bytes. Combined measured data was 5,027,893 bytes, with a 54 ms aggregate report calculation in Node. These are synthetic storage/CPU measurements, not browser performance or a guarantee of quota headroom in an existing profile. Other extension stores also consume space.

The return study keeps at most 200 pending anchors, 2,000 recent page identities and 1,000 detail labels, with ninety-day aggregates. Bookmark observations keep the bounded current inventory and its first deeper-visit receipt until resave/removal/clear. Page identities use purpose-separated, installation-local HMACs; reports omit identities, URLs, titles, queries, vectors and chat text. This is not anonymity against someone with the local secret. Existing browsing archives retain their own separate data.

The shared diagnostics switch and Clear action remove the new study state. Normal installs default off; unpacked installs default on unless an explicit saved choice says otherwise. Favorite, hide and snooze preferences remain user preferences. No remote upload, new notification schedule or automatic corpus rebuild is introduced.

## Verification

`npm run test:unit` passed 280 tests in an export of the scoped staged source.
Eighteen distinct focused browser checks passed across `omnibox.spec.js`,
`home-recommendation-options.spec.js`, `recent-context.spec.js` and
`revisit-intentions.spec.js` against that staged source, in isolated temporary
Chromium profiles. Unrelated checkout changes therefore cannot supply missing
dependencies. Verification also caught and covered message ownership in the
new-tab/treemap listeners and keyboard focus across recommendation refreshes.
These checks
cover legacy detail migration, horizon maturity and censoring, future-evidence
filtering, canonical Home rendering, existing recommendation navigation and
engagement, thirty-second bookmark focus, and diagnostic clearing. The
Mobile-folder render fixture supplies browser-owned folder metadata because an
unsigned-in test profile has no synced Mobile folder; the bookmark focus test
uses real bookmarks, tabs and elapsed foreground time. Desktop Home and the
390-pixel Options report were also visually inspected. The historical audit CLI
passed a separate read-only synthetic-database check. These checks do not
measure prediction lift or cross-device sync reliability.

## Reading the live studies

The three shadow studies (next-tab, revisit, Home recommendations) live in `chrome.storage.local`, which Chrome keeps as LevelDB under `~/Library/Application Support/Google/Chrome/Default/Local Extension Settings/<extension id>/`. To avoid requiring plyvel or snappy, `scripts/read-local-studies.py` reads the `.log` and `.ldb` files with the stdlib. It copies the directory first and parses only the copy, so it never writes to, or locks, the live profile.

```bash
python3 scripts/read-local-studies.py                      # prints the dump dir; --profile-dir / --extension-id override the defaults
node scripts/summarize-local-studies.mjs <dump-dir>        # add --json for the raw summaries
```

The summarizer runs the extension's own `RankingDiagnostics.getSummary()` and `summarizeRevisitStudy()` against the dump through a fake storage object, plus the Home arm sums, so the next-tab numbers match the Settings page. The `tabtopiaRevisitSecretV1` HMAC key is not dumped unless `--include-secrets` is passed.

Privacy: the dumps are content-free aggregates plus HMAC identities, but anyone holding the secret can test known URLs against them. They default to a temp dir outside the repo; keep any `--out` choice out of git too.
