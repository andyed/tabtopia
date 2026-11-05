// Learned combiner for the next-tab replay: a conditional logit (the listwise
// form of pairwise logistic ranking) over row-relative candidate features.
//
// Question it answers (docs/PREDICTION_REPLAY.md, Next step 2): do the
// behavioural scores add anything to recency once a model is free to weight
// them, or does MRU already hold all the signal an open-tab ranker can use?
//
// Train with scripts/replay-train-combiner.mjs, which fits the feature sets
// below on rows before a cutoff and writes their weights to a JSON file. Score
// them here through replay-eval:
//
//   TABTOPIA_COMBINER_WEIGHTS=<weights.json> node scripts/replay-eval.mjs <dump> \
//       --models scripts/replay-models/learned-combiner.mjs --split <same cutoff>
//
// Only the `from` table is a holdout; the `before` table is in-sample for every
// model defined here. Weights come from one person's browsing, so keep the JSON
// out of git with the dump it was fitted on.
//
// Features and scoring live in src/lib/learned-combiner.js so the live shadow
// study and this replay module score identically; this file adds the fitter.
//
// Why a conditional logit and not per-pair logistic regression: the softmax over
// a row's candidates is what the pairwise model approximates, it needs no pair
// sampling, its probabilities are the fitted probabilities (so the calibration
// and log-loss columns mean something), and Newton's method fits it exactly in a
// few steps at this size.
import fs from "node:fs";
import process from "node:process";

import { rankBy } from "../../src/lib/shadow-ranking.js";
import {
    COMBINER_FEATURE_SETS,
    combinerFeatures,
    learnedCombinerScores,
    scoreCombinerFeatures,
    withFittedProbabilities
} from "../../src/lib/learned-combiner.js";

// Replay version names. -v1: ages are taken against the newest access or
// first-seen time in the row (src/lib/learned-combiner.js), not the capture
// instant, so the live port reproduces them exactly. -v0 used the capture.
export const FEATURE_SETS = Object.freeze({
    "combiner-recency-v1": COMBINER_FEATURE_SETS.recency,
    "combiner-structure-v1": COMBINER_FEATURE_SETS.structure,
    "combiner-full-v1": COMBINER_FEATURE_SETS.full,
    "combiner-behaviour-only-v1": COMBINER_FEATURE_SETS.behaviourOnly
});

/** Featurize a reconstructed replay candidate list (current tab included). */
export function featurize(candidates, { currentTabId = null } = {}) {
    const current = candidates.find(candidate => candidate.tabId === currentTabId) || null;
    return combinerFeatures(candidates.filter(candidate => candidate.tabId !== currentTabId), current);
}

export const scoreFeatures = scoreCombinerFeatures;

/**
 * Fit a conditional logit by damped Newton steps with an L2 penalty on the
 * standardized weights. `groups` is [{ x: number[][], chosen: index }], one per
 * outcome, x already in `names` column order. Returns { names, mean, sd,
 * weights, l2, iterations, logLikelihood }.
 */
export function fitConditionalLogit(groups, names, { l2 = 1, maxIterations = 50, tolerance = 1e-9 } = {}) {
    const k = names.length;
    const { mean, sd } = standardization(groups, k);
    const z = groups.map(group => ({
        x: group.x.map(row => row.map((value, j) => (value - mean[j]) / sd[j])),
        chosen: group.chosen
    }));

    let w = new Array(k).fill(0);
    let objective = penalizedLogLikelihood(z, w, l2);
    let iterations = 0;
    for (; iterations < maxIterations; iterations += 1) {
        const { gradient, hessian } = derivatives(z, w, l2);
        // Newton direction: solve (-H) d = g, -H is positive definite with l2 > 0.
        const step = solve(hessian.map(row => row.map(value => -value)), gradient);
        if (!step) break;
        let scale = 1;
        let next = w.map((value, j) => value + step[j]);
        let nextObjective = penalizedLogLikelihood(z, next, l2);
        while (nextObjective < objective - 1e-12 && scale > 1e-6) {
            scale /= 2;
            next = w.map((value, j) => value + scale * step[j]);
            nextObjective = penalizedLogLikelihood(z, next, l2);
        }
        const improvement = nextObjective - objective;
        w = next;
        objective = nextObjective;
        if (Math.abs(improvement) < tolerance) { iterations += 1; break; }
    }
    return { names: [...names], mean, sd, weights: w, l2, iterations, logLikelihood: logLikelihood(z, w) };
}

/** Turn featurized rows into fitter groups for one feature list. */
export function toGroups(featurizedRows, names) {
    return featurizedRows
        .filter(row => row.chosen >= 0 && row.items.length > 1)
        .map(row => ({ x: row.items.map(item => names.map(name => item.features[name])), chosen: row.chosen }));
}

/** Mean held-out log-likelihood per outcome and top-1 rate, for choosing l2. */
export function heldOutScore(model, groups) {
    let logLik = 0;
    let hits = 0;
    for (const group of groups) {
        const scores = group.x.map(row => row.reduce((sum, value, j) => sum + model.weights[j] * (value - model.mean[j]) / model.sd[j], 0));
        const top = Math.max(...scores);
        const lse = top + Math.log(scores.reduce((sum, value) => sum + Math.exp(value - top), 0));
        logLik += scores[group.chosen] - lse;
        if (scores[group.chosen] === top) hits += 1;
    }
    return { meanLogLikelihood: logLik / Math.max(1, groups.length), top1: hits / Math.max(1, groups.length) };
}

/**
 * Models for replay-eval from a weights file: { models: { version: fitted } }.
 * Ranking and probabilities go through the same helpers the live model uses.
 */
export function combinerModels(weights) {
    const fitted = Object.entries(weights?.models || {});
    return function learnedCombiner(candidates, { currentTabId = null } = {}) {
        const current = candidates.find(candidate => candidate.tabId === currentTabId) || null;
        const eligible = candidates.filter(candidate => candidate.tabId !== currentTabId);
        const models = {};
        for (const [version, model] of fitted) {
            const scores = learnedCombinerScores(eligible, current, model);
            models[version] = withFittedProbabilities(
                rankBy(eligible, candidate => scores.get(candidate.tabId), { identityResolution: "tab" }), scores);
        }
        return models;
    };
}

let loaded = null;
export default function learnedCombinerFromEnv(candidates, options) {
    if (!loaded) {
        const file = process.env.TABTOPIA_COMBINER_WEIGHTS;
        if (!file) throw new Error("set TABTOPIA_COMBINER_WEIGHTS to a weights file from scripts/replay-train-combiner.mjs");
        loaded = combinerModels(JSON.parse(fs.readFileSync(file, "utf8")));
    }
    return loaded(candidates, options);
}

function standardization(groups, k) {
    const mean = new Array(k).fill(0);
    const sq = new Array(k).fill(0);
    let n = 0;
    for (const group of groups) for (const row of group.x) {
        n += 1;
        for (let j = 0; j < k; j += 1) { mean[j] += row[j]; sq[j] += row[j] * row[j]; }
    }
    for (let j = 0; j < k; j += 1) {
        mean[j] /= Math.max(1, n);
        const variance = sq[j] / Math.max(1, n) - mean[j] * mean[j];
        // A constant column gets sd 1 so it contributes nothing instead of NaN.
        sq[j] = variance > 1e-12 ? Math.sqrt(variance) : 1;
    }
    return { mean, sd: sq };
}

function softmaxRow(x, w) {
    const scores = x.map(row => row.reduce((sum, value, j) => sum + w[j] * value, 0));
    const top = Math.max(...scores);
    const exps = scores.map(value => Math.exp(value - top));
    const total = exps.reduce((sum, value) => sum + value, 0);
    return { scores, p: exps.map(value => value / total), lse: top + Math.log(total) };
}

function logLikelihood(z, w) {
    let total = 0;
    for (const group of z) {
        const { scores, lse } = softmaxRow(group.x, w);
        total += scores[group.chosen] - lse;
    }
    return total;
}

function penalizedLogLikelihood(z, w, l2) {
    return logLikelihood(z, w) - 0.5 * l2 * w.reduce((sum, value) => sum + value * value, 0);
}

function derivatives(z, w, l2) {
    const k = w.length;
    const gradient = w.map(value => -l2 * value);
    const hessian = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? -l2 : 0)));
    for (const group of z) {
        const { p } = softmaxRow(group.x, w);
        const expected = new Array(k).fill(0);
        for (let r = 0; r < group.x.length; r += 1) for (let j = 0; j < k; j += 1) expected[j] += p[r] * group.x[r][j];
        const chosen = group.x[group.chosen];
        for (let j = 0; j < k; j += 1) gradient[j] += chosen[j] - expected[j];
        // Hessian of the log-likelihood: -(E[x x^T] - E[x] E[x]^T).
        for (let r = 0; r < group.x.length; r += 1) {
            const row = group.x[r];
            for (let i = 0; i < k; i += 1) {
                const pi = p[r] * (row[i] - expected[i]);
                if (pi === 0) continue;
                for (let j = i; j < k; j += 1) hessian[i][j] -= pi * (row[j] - expected[j]);
            }
        }
    }
    for (let i = 0; i < k; i += 1) for (let j = 0; j < i; j += 1) hessian[i][j] = hessian[j][i];
    return { gradient, hessian };
}

// Gaussian elimination with partial pivoting; null when singular.
function solve(matrix, vector) {
    const n = vector.length;
    const a = matrix.map((row, i) => [...row, vector[i]]);
    for (let col = 0; col < n; col += 1) {
        let pivot = col;
        for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
        if (Math.abs(a[pivot][col]) < 1e-12) return null;
        [a[col], a[pivot]] = [a[pivot], a[col]];
        for (let row = col + 1; row < n; row += 1) {
            const factor = a[row][col] / a[col][col];
            for (let j = col; j <= n; j += 1) a[row][j] -= factor * a[col][j];
        }
    }
    const out = new Array(n).fill(0);
    for (let row = n - 1; row >= 0; row -= 1) {
        let sum = a[row][n];
        for (let j = row + 1; j < n; j += 1) sum -= a[row][j] * out[j];
        out[row] = sum / a[row][row];
    }
    return out;
}
