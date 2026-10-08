#!/usr/bin/env node
// Summarize the three local Tabtopia studies from a dump made by
// scripts/read-local-studies.py. Usage: node scripts/summarize-local-studies.mjs <dump-dir> [--json]
//
// The numbers come from the extension's own summarizers, fed through a fake
// {get,set,remove} storage, so they match what the Settings page shows -- no
// second implementation of the metrics to drift. Nothing is written back.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const dir = args.find(a => !a.startsWith("--"));
if (!dir) { console.error("usage: summarize-local-studies.mjs <dump-dir> [--json]"); process.exit(2); }
const lib = name => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", name);

const load = key => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), "utf8")); } catch { return undefined; }
};

class FakeStorage {
    constructor(values = {}) { this.values = values; }
    async get(keys) {
        const out = {};
        for (const k of [].concat(keys ?? Object.keys(this.values))) if (this.values[k] !== undefined) out[k] = this.values[k];
        return out;
    }
    async set(obj) { Object.assign(this.values, obj); }
    async remove(keys) { for (const k of [].concat(keys)) delete this.values[k]; }
}

// Modules touch chrome.* at import/call time; give them inert stand-ins.
globalThis.chrome ??= { storage: { local: new FakeStorage(), session: new FakeStorage() }, runtime: { id: "dump", getManifest: () => ({ version: "dump" }) } };

const pct = v => Number.isFinite(v) ? (100 * v).toFixed(1).padStart(5) + "%" : "    --";
const num = v => Number.isFinite(v) ? v.toFixed(3) : "--";
const report = {};

// --- Next-tab study -------------------------------------------------------
const rankingKeys = ["tabtopiaRankingDiagnosticsEnabledV1", "tabtopiaRankingDiagnosticsV2", "tabtopiaRankingStudyDaysV3"];
if (rankingKeys.some(k => load(k) !== undefined)) {
    const { RankingDiagnostics } = await import(lib("ranking-diagnostics.js"));
    const local = new FakeStorage(Object.fromEntries(rankingKeys.map(k => [k, load(k)]).filter(([, v]) => v !== undefined)));
    const diag = await new RankingDiagnostics(local, new FakeStorage(), { flushDelayMs: 1 }).init({ installType: "development" });
    report.ranking = await diag.getSummary();
}

// --- Revisit study --------------------------------------------------------
const revisitState = load("tabtopiaRevisitStudyV1");
if (revisitState) {
    const { summarizeRevisitStudy } = await import(lib("revisit-study.js"));
    report.revisit = summarizeRevisitStudy(revisitState);
}

// --- Home recommendation study (mirrors HomeRecommendationStore.summary) ---
const home = load("tabtopiaHomeRecommendationStudyV3");
if (home && Array.isArray(home.days)) {
    const { HOME_RECOMMENDATION_COHORT } = await import(lib("home-recommendation-store.js"));
    const arms = {};
    for (const day of home.days) for (const [arm, counts] of Object.entries(day.arms ?? {})) {
        arms[arm] ??= {};
        for (const [k, v] of Object.entries(counts ?? {})) arms[arm][k] = (arms[arm][k] ?? 0) + (Number.isFinite(v) ? v : 0);
    }
    report.home = { cohort: HOME_RECOMMENDATION_COHORT, arms, retainedDays: home.days.length,
        detailCount: home.details?.length ?? 0, from: home.days[0]?.day ?? null, to: home.days.at(-1)?.day ?? null };
}

if (asJson) { console.log(JSON.stringify(report, null, 1)); process.exit(0); }

const r = report.ranking;
console.log("== Next-tab study ==");
if (!r) console.log("  (no ranking keys in dump)");
else {
    const s = r.study ?? {};
    console.log(`  cohort ${s.cohort}  outcomes ${s.outcomes}  eligible ${s.eligibleOutcomes}  censored ${s.censoredOutcomes}  (eligibility ${pct(s.eligibilityCoverage).trim()})`);
    console.log(`  retained days ${s.retainedDays}  windows ${s.evaluationWindows}  p95 predict ${s.predictionP95Ms}ms`);
    console.log("  " + "model".padEnd(22) + "n".padStart(5) + "top-1".padStart(8) + "top-3".padStart(8) + "MRR".padStart(8) + "coverage".padStart(10) + "calib.err".padStart(10));
    for (const m of r.models ?? []) {
        console.log("  " + String(m.modelVersion).padEnd(22) + String(m.observations).padStart(5) + pct(m.hit1).padStart(8)
            + pct(m.hit3).padStart(8) + num(m.mrr).padStart(8) + pct(m.coverage).padStart(10) + num(m.calibrationError).padStart(10));
    }
    const g = r.exposureGate;
    if (g) {
        console.log(`  exposure gate: ${g.ready ? "READY" : "not ready"} (primary ${g.primaryModel}; winning windows ${g.winningWindows}/${g.requiredWinningWindows}, min ${g.minimumWindowObservations} obs/window)`);
        for (const reason of g.reasons ?? []) console.log(`    - ${reason}`);
    }
    console.log("  censoring reasons:");
    for (const c of s.censorReasons ?? []) console.log(`    ${String(c.count).padStart(5)}  ${pct(c.rate)}  ${c.reason}`);
}

const v = report.revisit;
console.log("\n== Revisit study ==");
if (!v) console.log("  (no tabtopiaRevisitStudyV1 in dump)");
else {
    console.log(`  cohort ${v.cohort}  shadow-only ${v.shadowOnly}  days ${v.retainedDays}  accesses ${v.qualifiedAccesses}  seen-before ${v.seenBefore}  pending anchors ${v.pendingAnchors}`);
    for (const h of v.horizons ?? []) {
        console.log(`  horizon ${String(h.horizon).padStart(3)}: resolved ${h.resolved}  returned ${h.returned}  rate ${pct(h.returnRate).trim()}  pending ${h.pending}`);
        for (const m of h.models ?? []) console.log(`      ${String(m.model).padEnd(20)} brier ${num(m.brier)}  logloss ${num(m.logLoss)}  calib.err ${num(m.calibrationError)}  bal.acc ${num(m.balancedAccuracy)}`);
    }
}

const h = report.home;
console.log("\n== Home recommendation study ==");
if (!h) console.log("  (no tabtopiaHomeRecommendationStudyV3 in dump)");
else {
    console.log(`  cohort ${h.cohort}  days ${h.retainedDays} (${h.from ?? "-"} -> ${h.to ?? "-"})  details ${h.detailCount}`);
    for (const [arm, c] of Object.entries(h.arms)) console.log(`  ${arm.padEnd(10)} ` + Object.entries(c).map(([k, n]) => `${k} ${n}`).join("  "));
}
