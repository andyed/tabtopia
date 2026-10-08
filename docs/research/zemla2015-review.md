# Zemla et al. (2015) re-read against the V3 shadow study

> 2026-10-07. Jeffrey C. Zemla, Chad C. Tossell, Philip Kortum, Michael D. Byrne.
> "A Bayesian approach to predicting website revisitation on mobile phones."
> *Int. J. Human-Computer Studies* 83 (2015) 43–50. doi:10.1016/j.ijhcs.2015.06.002.
> This is the paper `src/lib/revisit-model.js` implements. Read from the
> author-hosted copy; the local PDF was not found by filename or Spotlight.

## What the paper did

| | Zemla et al. | Tabtopia V3 study |
|---|---|---|
| Users, span | 24 iPhone users, one year | one user, 12 days so far |
| Unit predicted | next **site** (domain or sub-domain) at a site transition | next **open tab** at a qualified tab switch |
| Candidate set | every site in the user's history | tabs open at prediction time |
| Excluded | intra-site navigation; the current site | same-source-tab accesses; the current tab; unfocused windows |
| Metric | top-4 hit rate, averaged per user | top-1, top-3, top-4, MRR, log loss, calibration |
| Transitions scored | 26,345 inter-site | 241 eligible of 574 outcomes |
| Time | clock time; ordinal (visits since) tested as a variant | clock time |

Models and their top-4 accuracy in the paper:

| model | top-4 |
|---|---|
| Context only (last site → this site, Laplace .01) | 19.9% |
| Recency (MRU) | 38.2% |
| Frequency | 39.6% |
| Frecency (Firefox bins, constant bonus) | 42.1% |
| New Frecency (30-day exponential half-life) | 42.4% |
| History (ACT-R base-level, d = 0.5) | 44.4% |
| History/Context, equal weight | 48.9% |

History beat recency for all 24 users; History/Context beat everything for 22
of 24. Decay d made little difference (their Fig. 4). Ordinal time cost about
1.5 to 2 points. Two parameters total: decay and the Laplace correction. The
authors name a context weight and per-user fitting as the next step.

## Where V3 agrees

- **Excluding the current item and intra-item moves is load-bearing.** The
  paper designs around it; V2 did not, and its 77 to 91 percent top-1 was the
  contamination the paper avoids. The September 22 fix brought the study into
  line with the paper's protocol.
- **Context is real signal.** Their context-only model was weak (19.9% top-4),
  but adding it to History was their largest gain (+4.5 points). On V3,
  context alone (`transition-domain-v1`) is the strongest behavioural model at
  37.3% top-1 when it has evidence (83% coverage).
- **Frecency is a credible baseline.** It sat between recency and History for
  them; on V3 it sits between the Bayesian models and MRU (34.0% top-1, best
  calibration of any model at 0.039).

## Where V3 disagrees, and why that is expected

1. **Recency wins here.** MRU is their weakest historical cue and our strongest
   model (43.2% top-1, 76.8% top-4 against 67.6% for `bayes-domain-v1`). The
   task differs: open tabs are already a recency-selected set, and tab
   switching is dominated by alternation (A → B → A), which MRU captures and a
   year-long activation sum dilutes.
2. **Equal-weight History/Context loses to context alone.** 33.6% against
   37.3% top-1. The paper's naive-Bayes weighting assumed both terms carry
   comparable information; on a switch task the long-horizon History term
   swamps the short-horizon context term. This is the parameter the authors
   themselves flagged.
3. **Page identity beats site identity.** `bayes-page-v1` 37.8% against
   `bayes-domain-v1` 33.6% and `bayes-hierarchical-v1` 32.4%. The paper argues
   for sites because mobile page URLs are ephemeral, then concedes the
   technical-manual case where pages matter. An open tab *is* a specific page.
4. **Decay robustness does not transfer.** Their flat Fig. 4 is for a site
   task over a year of history. Nothing in V3 tests d; the live models use
   0.5 by inheritance.

## What is now running, and what replay adds

Seven paper-derived variants joined the live shadow matrix on 2026-10-07
(`shadow-ranking.js`, 19 models in all), so they accumulate live evidence
alongside the originals and replay faithfully from the same rows:

- **Context weight.** History + w·Context for w in {2, 4}, at page and domain
  identity. Expectation from the V3 numbers: w well above 1.
- **Rank fusion with MRU.** Reciprocal-rank fusion of MRU with `bayes-page`
  and with `context-domain`. The question is not "can behaviour beat recency"
  but "does behaviour add anything once recency is in the mix".
- **Recency with history tie-break.** MRU order, same-minute ties broken by
  page history. Isolates the narrow case where recency is uninformative.

The replay log (`docs/PREDICTION_REPLAY.md`) stores final scores per
candidate, so `scripts/replay-models/zemla-variants.mjs` fills in the rest of
the sweep offline (w in {0.25, 0.5, 8}; fusion with `bayes-domain` and
`frecency`) once rows exist, without adding more live models.

The exposure gate now judges top-3 plus MRR against MRU and frecency, not
top-1 (`exposureHitMetric` in `RANKING_STUDY_DEFAULTS`), matching the three
destinations Home shows and the paper's springboard framing.

Testable since 2026-10-08, when the replay row gained the per-candidate ages
of the newest eight qualified accesses at each identity (`pageAccessAges`,
`domainAccessAges`; see `docs/PREDICTION_REPLAY.md`):

- **Decay d.** `scripts/replay-models/decay-variants.mjs` recomputes page
  History from the ages at d in {0.25, 0.5, 1, 2}. The d = 0.5 recompute
  reproduces the live `history-page-v1` score for any identity with eight or
  fewer accesses, which is the fidelity proof for the columns; past the cap
  every variant sees the same truncated history, so compare them with each
  other and read `-d0.5-` against `history-page-v1` for the cost of the cap.
- **Ordinal time.** Same file, `history-page-ordinal-d0.5-v0`: each access's
  age replaced by its rank among the accesses pooled across the row's
  candidates, most recent first. Narrower than the paper's "visits since",
  which counted every visit; a replay row sees only open tabs.

Not testable on the current replay row, and worth a feature-list bump:

- **Top-k as the product metric.** The paper frames prediction as a four-slot
  springboard and reports top-4. Home shows three featured destinations, so
  the exposure gate's top-1 lift criterion is stricter than the surface it
  guards. Consider gating on top-3 with MRU as the baseline.

## What the paper cannot settle for us

Their candidate set is the whole history; ours is open tabs. The
censoring in V3 (mostly "destination not an open tab") is exactly the part of
the problem the paper's model was built for and ours never sees. The
page-return bootstrap (`page-return-opportunities-v1`), where History already
beats the base rate at every horizon, is the closer analogue to their task.
