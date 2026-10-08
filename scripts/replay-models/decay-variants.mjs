// Decay and ordinal-time variants of the Zemla et al. (2015) History term,
// recomputed offline from the per-candidate access ages the replay row has
// carried since 2026-10-08 (pageAccessAges / domainAccessAges in
// src/lib/ranking-replay.js). See docs/research/zemla2015-review.md.
//
// Run: node scripts/replay-eval.mjs <dump-dir> --models scripts/replay-models/decay-variants.mjs --split <ISO>
//
// Why ages and not the stored score: ln(sum(t^-d)) cannot be re-decayed once
// summed, so the live pageHistoryScore fixes d = 0.5 for ever. The ages are
// the inputs, so any d can be tried. The paper found d robust on a site task
// over a year of history; this sweep asks the same question of tab switching.
//
// Two caveats on reading the table:
//   - Ages are capped at eight per candidate. For an identity with more
//     accesses than that, every variant here sees a truncated history, so
//     compare the d values with each other, and compare `-d0.5-` with the
//     live history-page-v1 to see how much the cap costs on its own.
//   - The ordinal variant pools ages across the row's candidates only. The
//     paper counted every visit; a replay row cannot see visits to pages that
//     are not open tabs, so it is "switch rank among open tabs", not "visits
//     since".
// The ordinal variant runs at d = 0.5 only, the paper's setting; sweep d
// there too once the clock-time sweep has said anything.
// Version strings end in -v0: hypotheses to run, not proposals.
import { rankBy } from "../../src/lib/shadow-ranking.js";
import { scoreHistory } from "../../src/lib/revisit-model.js";

export const DECAYS = Object.freeze([0.25, 0.5, 1, 2]);

/**
 * History at decay d from a list of ages (ms before the score's instant).
 * Feeding scoreHistory ages as negative timestamps against now = 0 makes its
 * arithmetic ((now - timestamp) / 1000) identical to the live call, which is
 * what lets d = 0.5 reproduce pageHistoryScore to floating-point precision.
 * Returns NaN with no ages so rankBy drops the candidate, as it does for a
 * live -Infinity.
 */
export function historyFromAges(ages, decay) {
    if (!Array.isArray(ages) || ages.length === 0) return Number.NaN;
    const activation = scoreHistory(ages.map(age => -age), 0, decay);
    return Number.isFinite(activation) ? activation : Number.NaN;
}

/**
 * Ordinal time: each access's age is replaced by its rank among every access
 * in the pooled list, most recent = 1, ties sharing the lower rank. The rank
 * is then treated as elapsed seconds so scoreHistory's floor of one second
 * coincides with rank one.
 */
export function ordinalRanks(ages, pooled) {
    const sorted = [...pooled].sort((left, right) => left - right);
    return ages.map(age => {
        let younger = 0;
        while (younger < sorted.length && sorted[younger] < age) younger += 1;
        return younger + 1;
    });
}

export function ordinalHistory(ages, pooled, decay) {
    if (!Array.isArray(ages) || ages.length === 0) return Number.NaN;
    return historyFromAges(ordinalRanks(ages, pooled).map(rank => rank * 1000), decay);
}

export default function decayVariants(candidates, { currentTabId = null } = {}) {
    const eligible = candidates.filter(candidate => candidate.tabId !== currentTabId);
    const pooled = eligible.flatMap(candidate => Array.isArray(candidate.pageAccessAges) ? candidate.pageAccessAges : []);
    const models = {};

    for (const decay of DECAYS) {
        models[`history-page-d${decay}-v0`] = rankBy(eligible,
            candidate => historyFromAges(candidate.pageAccessAges, decay),
            { identityResolution: "page" });
    }
    models["history-page-ordinal-d0.5-v0"] = rankBy(eligible,
        candidate => ordinalHistory(candidate.pageAccessAges, pooled, 0.5),
        { identityResolution: "page" });

    return models;
}
