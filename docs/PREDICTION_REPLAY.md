# Prediction replay log

> Added 2026-10-07. Lets a next-tab ranking idea be scored against months of
> real outcomes in seconds instead of weeks of waiting for the live shadow study.

## Why

The shadow study (`src/lib/ranking-diagnostics.js`) records, per qualified
next-tab outcome, each running model's rank of the chosen tab. That scores the
twelve models that were running and nothing else. Every new idea cost an
extension edit, a reload, and enough new eligible outcomes to evaluate it.

A replay row keeps the content-free numeric features of every candidate tab at
prediction time plus which candidate the user chose. Any model expressible as a
function of those features can be scored over the whole retained history, and
the shipped models can be re-run verbatim to prove the log is faithful.

## What is stored

Key `tabtopiaRankingReplayV1` in `chrome.storage.local`, written by the same
flush that writes the detail buffer, only when diagnostics are on, and removed
by Disable and Clear. Up to 2,000 rows within 4 MiB; oldest rows drop first.
One row per **eligible** outcome (an existing open tab chosen within the
observation window with an unchanged candidate set). Censored outcomes carry no
label a model could be scored against, so they get no row; their counts remain
in the daily rollup.

A row holds: resolve time, capture time, cohort, local hour and weekday, whether
the current tab had a domain, the current tab's strip index, the candidate
count, the outcome's position, and one feature vector per candidate. Features
(`REPLAY_FEATURES` in `src/lib/ranking-replay.js`): access age, first-seen age,
time spent, domain group, window group, strip offset, pinned, audible, the ten
behavioural scores the live models consume, and two access-age lists. Every
value is a number or null, except the two lists.

Privacy contract, same as the rest of the study: no tab ids, URLs, titles,
domains, or queries. Domains and windows become per-row group numbers where 0
means "same as the current tab"; identities become positions; timestamps become
ages. Group numbers mean nothing across rows. Scores are stored to nine
significant digits.

**Access ages** (`pageAccessAges`, `domainAccessAges`, added 2026-10-08). Per
candidate, the ages in milliseconds of its newest qualified accesses at page
and at domain identity, most recent first, at most eight each, null when there
are none. They are relative to the instant the scores were computed, not to the
capture, so ACT-R activation recomputed from them at d = 0.5 reproduces
`pageHistoryScore` whenever the identity has eight or fewer accesses
(`tests/unit/decay-variants.test.mjs` holds this to 1e-6); past the cap the
recompute sees the newest eight only. They exist so the decay exponent and the
ordinal-time variant from Zemla et al. can be swept offline
(`scripts/replay-models/decay-variants.mjs`); no live model reads them. On the
synthetic 120-row dump a row costs 2.2 KB with the lists empty and 4.2 KB with
every candidate carrying eight ages at both identities, so a 2,000-row log
fits the 4 MiB budget only while most lists are short; the byte cap drops the
oldest rows first either way.

Snapshots over 120 eligible tabs keep the 119 most recently accessed plus the
outcome, in original order, and are flagged `truncated`. The evaluator excludes
them from fidelity assertions and, by default, from scoring.

## Reading it

```bash
python3 scripts/read-local-studies.py --out /tmp/tabtopia-dump
node scripts/replay-eval.mjs /tmp/tabtopia-dump --details /tmp/tabtopia-dump/tabtopiaRankingDiagnosticsV2.json
```

The first command snapshots the extension's on-disk storage (Chrome may stay
open). The second scores every live model over the replay rows and, with
`--details`, joins each row to its live detail record by timestamp and checks
that every recorded `actualRank` is reproduced. The verdict line must read
`FAITHFUL` before any other number from this tool is quoted.

The dump reads this platform's default Chrome profile (`~/Library/Application
Support/Google/Chrome/Default` on macOS, `%LOCALAPPDATA%\Google\Chrome\User
Data\Default` on Windows); `--profile-dir` overrides it. Run under the profile owner. Keep profiles and cohorts separate when reporting results.

## Trying a model

Write a module that default-exports `(candidates, { currentTabId }) => models`,
the `buildShadowPredictions` contract. `candidates` are reconstructed replay
candidates with the field names `buildRecallCandidate` uses, so a model written
here can later move into `shadow-ranking.js` unchanged. Use `rankBy` from
`shadow-ranking.js` so ranking ties, abstention on non-finite scores, and
relative-softmax confidence match the shipped models. See
`scripts/replay-models/examples.mjs`; `decay-variants.mjs` beside it is the
model file that reads the access-age lists. The summariser keeps the first 48
models of a row (`MAX_MODELS`), live ones first; the evaluator warns when a
run has more.

```bash
node scripts/replay-eval.mjs /tmp/tabtopia-dump --models scripts/replay-models/examples.mjs
node scripts/replay-eval.mjs /tmp/tabtopia-dump --models my-models.mjs --split 2026-10-20T00:00:00Z
```

`--split` prints separate tables before and from an instant. Tune constants on
the earlier table, report the later one. Keep model version strings stable
across runs so results stay comparable; bump the suffix when the function
changes.

## Learned combiner

> Added 2026-11-04. Features and scoring: `src/lib/learned-combiner.js`.
> Fitter and replay models: `scripts/replay-models/learned-combiner.mjs`,
> `scripts/replay-train-combiner.mjs`. Live model: `learned-combiner-full-v1`
> in `src/lib/shadow-ranking.js`, frozen weights in
> `src/lib/learned-combiner-weights.js`. Tests:
> `tests/unit/learned-combiner.test.mjs`.

A conditional logit (the listwise form of pairwise logistic ranking) over
row-relative candidate features, fitted by Newton steps with an L2 penalty
chosen on an inner temporal split (first 75% of the training rows fit, last
25% choose). Four nested feature sets, so the lift between neighbours is one
family's contribution:

| version | features |
|---|---|
| `combiner-recency-v1` | log access age, log MRU rank, MRU-1 and MRU-2 flags |
| `combiner-structure-v1` | + same window, same domain, strip adjacency and distance, pinned, audible, log first-seen age, log time spent |
| `combiner-full-v1` | + the eight distinct behavioural scores and their missing flags |
| `combiner-behaviour-only-v1` | structure + behaviour, no recency family |

Ages are measured from the newest access or first-seen time among the row's
eligible tabs, not from the wall clock or the current tab. A replay row stores
ages and gives the reconstructed current tab the capture instant, so this is
what lets the live model replay exactly; a unit test shifts every clock and
checks the features do not move.

```bash
node scripts/replay-train-combiner.mjs /tmp/tabtopia-dump --before 2026-10-29T00:00:00Z --out /tmp/combiner-weights.json
TABTOPIA_COMBINER_WEIGHTS=/tmp/combiner-weights.json node scripts/replay-eval.mjs /tmp/tabtopia-dump \
    --models scripts/replay-models/learned-combiner.mjs --split 2026-10-29T00:00:00Z
```

Only the `from` table is a holdout. Keep weights JSON fitted for experiments
out of git with the dump. Probabilities are the fitted softmax
(`conditional-logit-v1`), not the relative softmax, so the log-loss and
calibration columns describe the model.

Private replay measurements are not distributed with this repository. Evaluate
your own held-out rows; do not treat fitted-model performance as general lift.

### Live port

`learned-combiner-full-v1` runs in the V3 shadow study beside the other models
and is the exposure gate's primary (`EXPOSURE_PRIMARY_MODEL` in
`src/lib/ranking-diagnostics.js`), replacing `bayes-domain-v1`. The frozen module retains coefficients, a training cutoff
and sample count for model provenance; exact activity timestamps are omitted.

- Rows before the training cutoff are in-sample. Use independent later data for
  evaluation, and keep cohort and capture boundaries explicit.
- The live exposure gate still requires its winning windows and calibration.
  A private replay experiment alone does not establish release readiness.
- Regenerate weights only as a new version: rerun the trainer with
  `--emit-module src/lib/learned-combiner-weights.js` and bump the version
  string in `shadow-ranking.js` (the gate picks its primary up from
  `SHADOW_MODEL_VERSIONS`), so live results from different weights never pool.

## What this does not answer

- **The candidate set.** Every row is an open-tab choice. Replay cannot say
  whether the Home page should have offered a closed page, a bookmark, or a
  search; that is the start-page measurement in the roadmap.
- **Censoring.** Outcomes outside the open-tab candidate set are censored.
  Report their denominator separately; replay scores cover only eligible rows.
- **Exposure.** The exposure gate still reads the live study. A replay win is a
  reason to promote a model into `shadow-ranking.js`, where it must then earn
  two live winning windows like any other.
- **Repeated observations from one person.** Rows are not independent; treat
  differences of a few points on a few hundred rows as noise.

## Next

1. Reload the unpacked extension (never remove it: removal clears every
   study) so `learned-combiner-full-v1` starts recording. After a day, run
   `replay-eval.mjs --details` and confirm it is `FAITHFUL` including the new
   model.
2. ~~Learned combiner~~ Done 2026-11-04; see [Learned combiner](#learned-combiner).
3. ~~Port it to `shadow-ranking.js`~~ Done 2026-11-04; it is the gate's
   primary. Read the gate after two full evaluation windows (seven days each).
4. The open-tab candidate set excludes outcomes outside open tabs. A study
   whose candidates include history pages is being designed separately.
