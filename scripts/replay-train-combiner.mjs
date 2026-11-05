#!/usr/bin/env node
// Fit the learned next-tab combiners (scripts/replay-models/learned-combiner.mjs)
// on replay rows before a cutoff and write their weights for replay-eval.
//
// Usage:
//   node scripts/replay-train-combiner.mjs <dump-dir | tabtopiaRankingReplayV1.json> \
//        --before <ISO> --out <weights.json> [--include-truncated]
//
// Then score them on the rows from the same instant:
//   TABTOPIA_COMBINER_WEIGHTS=<weights.json> node scripts/replay-eval.mjs <dump-dir> \
//        --models scripts/replay-models/learned-combiner.mjs --split <same ISO>
//
// The L2 penalty is chosen per feature set on an inner temporal split: fit on
// the first 75% of the training rows (by time), keep the penalty with the best
// held-out log-likelihood on the last 25%, refit on all training rows with it.
// Nothing at or after --before is read, so the `from` table stays a holdout.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { decodeReplayRows, reconstructCandidates, REPLAY_CURRENT_TAB_ID } from "../src/lib/ranking-replay.js";
import { FEATURE_SETS, featurize, fitConditionalLogit, heldOutScore, toGroups } from "./replay-models/learned-combiner.mjs";

const L2_GRID = Object.freeze([0.01, 0.1, 1, 3, 10, 30, 100, 300, 1000]);
const INNER_TRAIN_FRACTION = 0.75;

const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const target = args.find((value, index) => !value.startsWith("--") && (index === 0 || !args[index - 1].startsWith("--")));
const beforeIso = flag("--before");
const out = flag("--out");
if (!target || !beforeIso || !out) {
    console.error("usage: replay-train-combiner.mjs <dump-dir|replay.json> --before <ISO> --out <weights.json> [--include-truncated]");
    process.exit(2);
}
const before = Date.parse(beforeIso);
if (!Number.isFinite(before)) { console.error(`--before is not a date: ${beforeIso}`); process.exit(2); }

const replayPath = fs.statSync(target).isDirectory() ? path.join(target, "tabtopiaRankingReplayV1.json") : target;
const rows = decodeReplayRows(JSON.parse(fs.readFileSync(replayPath, "utf8")))
    .filter(row => row.timestamp < before && (args.includes("--include-truncated") || !row.truncated))
    .sort((left, right) => left.timestamp - right.timestamp);
if (rows.length < 40) { console.error(`only ${rows.length} training rows before ${beforeIso}; need at least 40`); process.exit(1); }

// Eligible candidates are the reconstructed list minus the current tab, in
// matrix order, so the chosen one's index there is the row's outcomeIndex.
const featurized = rows.map(row => {
    const candidates = reconstructCandidates(row);
    const items = featurize(candidates, { currentTabId: REPLAY_CURRENT_TAB_ID });
    const actualTabId = candidates[Number(row.outcomeIndex) + 1]?.tabId;
    return { items, chosen: items.findIndex(item => item.candidate.tabId === actualTabId) };
});
const usable = featurized.filter(row => row.chosen >= 0 && row.items.length > 1);
const cut = Math.floor(usable.length * INNER_TRAIN_FRACTION);

const result = {
    format: "learned-combiner-weights-v0",
    trainedBefore: new Date(before).toISOString(),
    trainingRows: usable.length,
    firstRowAt: new Date(rows[0].timestamp).toISOString(),
    lastRowAt: new Date(rows.at(-1).timestamp).toISOString(),
    models: {}
};

console.log(`training rows: ${usable.length} (${result.firstRowAt.slice(0, 16)} → ${result.lastRowAt.slice(0, 16)}); inner split ${cut}/${usable.length - cut}`);
for (const [version, names] of Object.entries(FEATURE_SETS)) {
    const inner = toGroups(usable.slice(0, cut), names);
    const innerHoldout = toGroups(usable.slice(cut), names);
    const sweep = L2_GRID.map(l2 => ({ l2, ...heldOutScore(fitConditionalLogit(inner, names, { l2 }), innerHoldout) }));
    const best = sweep.reduce((winner, item) => (item.meanLogLikelihood > winner.meanLogLikelihood ? item : winner));
    const model = fitConditionalLogit(toGroups(usable, names), names, { l2: best.l2 });
    result.models[version] = { ...model, innerValidation: sweep };

    console.log(`\n${version}: l2 ${best.l2} (inner holdout logLik/row ${best.meanLogLikelihood.toFixed(3)}, top-1 ${(100 * best.top1).toFixed(1)}%), ${model.iterations} Newton steps`);
    const order = model.names.map((name, j) => ({ name, weight: model.weights[j] }))
        .sort((left, right) => Math.abs(right.weight) - Math.abs(left.weight));
    for (const { name, weight } of order) console.log(`  ${name.padEnd(26)} ${weight >= 0 ? "+" : ""}${weight.toFixed(3)}`);
}

fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`\nweights → ${out} (standardized-feature weights: per one SD of the feature over training candidates)`);

// --emit-module writes the frozen weights the live shadow study imports
// (src/lib/learned-combiner-weights.js). Numbers only: feature names, means,
// SDs and weights, plus when and on how many rows they were fitted.
const emitPath = flag("--emit-module");
if (emitPath) {
    const source = flag("--emit-model") || "combiner-full-v1";
    const fitted = result.models[source];
    if (!fitted) { console.error(`--emit-model ${source} is not one of ${Object.keys(result.models).join(", ")}`); process.exit(1); }
    const round = value => Number(value.toPrecision(12));
    const frozen = {
        source,
        trainedBefore: result.trainedBefore,
        trainingRows: result.trainingRows,
        // Exact activity timestamps stay in the private training report.
        l2: fitted.l2,
        names: fitted.names,
        mean: fitted.mean.map(round),
        sd: fitted.sd.map(round),
        weights: fitted.weights.map(round)
    };
    const body = `// Generated by scripts/replay-train-combiner.mjs --emit-module; do not edit by hand.
// Frozen weights for the live learned-combiner-full-v1 shadow model
// (src/lib/shadow-ranking.js). Refit and regenerate rather than tuning these;
// a refit with different weights is a new model version.
export const LEARNED_COMBINER_FULL_V1 = Object.freeze(${JSON.stringify(frozen, null, 4)});
`;
    fs.writeFileSync(emitPath, body);
    console.log(`frozen ${source} → ${emitPath}`);
}
