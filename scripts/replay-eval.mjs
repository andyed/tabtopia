#!/usr/bin/env node
// Score next-tab models offline against the replay log.
//
// Usage:
//   node scripts/replay-eval.mjs <dump-dir | tabtopiaRankingReplayV1.json>
//        [--models <module.mjs>] [--details <tabtopiaRankingDiagnosticsV2.json>]
//        [--since <ISO>] [--before <ISO>] [--split <ISO>] [--include-truncated] [--json]
//
// <dump-dir> is the output of scripts/read-local-studies.py. Rows are scored
// with the live buildShadowPredictions plus any models exported by --models
// (see scripts/replay-models/examples.mjs), then summarised by the extension's
// own summarizeRankingDiagnostics so the table is the one Settings would show.
//
// --details runs the fidelity check: for every replay row with a live detail
// record at the same timestamp, each live model's recorded actualRank must
// equal the replayed one. A mismatch means the replay log is not faithful and
// nothing scored on it should be trusted until the cause is found.
//
// --split <ISO> prints two tables, before and from that instant, which is the
// temporal holdout to use when a model has tunable constants.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildShadowPredictions } from "../src/lib/shadow-ranking.js";
import { decodeRankingDetails } from "../src/lib/ranking-detail-codec.js";
import { MAX_MODELS, summarizeRankingDiagnostics } from "../src/lib/ranking-diagnostics.js";
import { decodeReplayRows, replayOutcome } from "../src/lib/ranking-replay.js";

const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const has = name => args.includes(name);
const target = args.find((value, index) => !value.startsWith("--") && (index === 0 || !args[index - 1].startsWith("--")));
if (!target) {
    console.error("usage: replay-eval.mjs <dump-dir|replay.json> [--models m.mjs] [--details d.json] [--since ISO] [--before ISO] [--split ISO] [--include-truncated] [--json]");
    process.exit(2);
}

const replayPath = fs.statSync(target).isDirectory() ? path.join(target, "tabtopiaRankingReplayV1.json") : target;
const allRows = decodeReplayRows(JSON.parse(fs.readFileSync(replayPath, "utf8")));
const since = flag("--since") ? Date.parse(flag("--since")) : -Infinity;
const before = flag("--before") ? Date.parse(flag("--before")) : Infinity;
const includeTruncated = has("--include-truncated");
const rows = allRows.filter(row => row.timestamp >= since && row.timestamp < before && (includeTruncated || !row.truncated));
const truncatedCount = allRows.filter(row => row.truncated).length;

let build = buildShadowPredictions;
if (flag("--models")) {
    // A file URL, because import() reads a Windows drive letter as a URL scheme.
    const extra = (await import(pathToFileURL(path.resolve(flag("--models"))).href)).default;
    if (typeof extra !== "function") throw new Error("--models module must default-export (candidates, { currentTabId }) => models");
    build = (candidates, options) => {
        const live = buildShadowPredictions(candidates, options);
        return { ...live, models: { ...live.models, ...extra(candidates, options) } };
    };
}

const fidelity = flag("--details") ? checkFidelity(rows, flag("--details")) : null;

const output = { replayPath, rows: rows.length, totalRows: allRows.length, truncatedRows: truncatedCount, fidelity };
if (flag("--split")) {
    const splitAt = Date.parse(flag("--split"));
    output.before = evaluate(rows.filter(row => row.timestamp < splitAt), build);
    output.from = evaluate(rows.filter(row => row.timestamp >= splitAt), build);
} else {
    output.all = evaluate(rows, build);
}

if (has("--json")) {
    console.log(JSON.stringify(output, null, 2));
} else {
    console.log(`replay rows: ${rows.length} scored (${allRows.length} stored, ${truncatedCount} truncated${includeTruncated ? ", included" : ", excluded"})`);
    if (fidelity) printFidelity(fidelity);
    for (const [label, result] of Object.entries(output)) {
        if (!result || typeof result !== "object" || !result.models) continue;
        console.log(`\n== ${label}: ${result.study.eligibleOutcomes} eligible outcomes, ${result.study.firstOutcomeAt ? new Date(result.study.firstOutcomeAt).toISOString().slice(0, 16) : "-"} → ${result.study.lastOutcomeAt ? new Date(result.study.lastOutcomeAt).toISOString().slice(0, 16) : "-"}`);
        if (result.models.length === 0) { console.log("(no rows in this range)"); continue; }
        printTable(result);
    }
}

function evaluate(subset, builder) {
    const records = subset.map(row => replayOutcome(row, builder));
    // The summariser keeps the first MAX_MODELS models of a record and says
    // nothing about the rest, so a --models file that pushes the total past
    // the cap would lose its last models without any sign in the table.
    const widest = Math.max(0, ...records.map(record => record.models.length));
    if (widest > MAX_MODELS) {
        console.error(`warning: ${widest} models per row but the summariser keeps ${MAX_MODELS}; the last ${widest - MAX_MODELS} are not scored`);
    }
    const summary = summarizeRankingDiagnostics(records);
    const mru = summary.models.find(model => model.modelVersion === "mru-v1");
    for (const model of summary.models) {
        model.liftOverMruHit1 = mru ? model.hit1 - mru.hit1 : null;
    }
    summary.models.sort((left, right) => right.hit1 - left.hit1 || right.mrr - left.mrr);
    return summary;
}

function printTable(summary) {
    const pct = value => Number.isFinite(value) ? `${(100 * value).toFixed(1).padStart(5)}%` : "    --";
    const num = value => Number.isFinite(value) ? value.toFixed(3) : "   --";
    const signed = value => Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${(100 * value).toFixed(1)}`.padStart(6) : "    --";
    console.log(`${"model".padEnd(28)} ${"cover".padStart(6)} ${"top1".padStart(6)} ${"top3".padStart(6)} ${"mrr".padStart(5)} ${"logL".padStart(6)} ${"calErr".padStart(6)} ${"Δmru1".padStart(6)}`);
    for (const model of summary.models) {
        console.log(`${model.modelVersion.padEnd(28)} ${pct(model.coverage)} ${pct(model.hit1)} ${pct(model.hit3)} ${num(model.mrr)} ${num(model.logLoss).padStart(6)} ${num(model.calibrationError).padStart(6)} ${signed(model.liftOverMruHit1)}`);
    }
}

function checkFidelity(subset, detailsPath) {
    const details = decodeRankingDetails(JSON.parse(fs.readFileSync(detailsPath, "utf8")))
        .filter(record => record.event === "next_tab_outcome" && !record.censorReason);
    const byKey = new Map(details.map(record => [`${record.cohort}:${record.timestamp}`, record]));
    const result = { joined: 0, unjoined: 0, comparedModels: 0, mismatches: [] };
    for (const row of subset) {
        const live = byKey.get(`${row.cohort}:${row.timestamp}`);
        if (!live) { result.unjoined += 1; continue; }
        result.joined += 1;
        const replayed = replayOutcome(row, buildShadowPredictions);
        for (const model of live.models) {
            const twin = replayed.models.find(item => item.modelVersion === model.modelVersion);
            if (!twin) continue;
            result.comparedModels += 1;
            if (twin.actualRank !== model.actualRank || twin.predictedCount !== model.predictedCount) {
                result.mismatches.push({
                    timestamp: row.timestamp, model: model.modelVersion,
                    live: { actualRank: model.actualRank, predictedCount: model.predictedCount },
                    replay: { actualRank: twin.actualRank, predictedCount: twin.predictedCount }
                });
            }
        }
    }
    return result;
}

function printFidelity(fidelity) {
    const verdict = fidelity.mismatches.length === 0 ? "FAITHFUL" : "MISMATCH";
    console.log(`fidelity: ${verdict} — ${fidelity.joined} rows joined to live details (${fidelity.unjoined} without a twin), ${fidelity.comparedModels} model ranks compared, ${fidelity.mismatches.length} mismatches`);
    for (const mismatch of fidelity.mismatches.slice(0, 5)) {
        console.log(`  ${new Date(mismatch.timestamp).toISOString()} ${mismatch.model}: live rank ${mismatch.live.actualRank}/${mismatch.live.predictedCount}, replay ${mismatch.replay.actualRank}/${mismatch.replay.predictedCount}`);
    }
}
