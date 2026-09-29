import { readRecentContext, setContextSiteHidden } from "../lib/recent-context-provider.js";
import { FEATURE_FLAGS, readFeatureFlag, writeFeatureFlag } from "../lib/feature-flags.js";
import { readHomeRecommendationPreferences, saveHomeRecommendationPreferences } from "../lib/home-recommendations.js";

const enabledInput = document.getElementById("diagnosticsEnabled");
const homeInput = document.getElementById("homeTakeoverEnabled");
const homeStatus = document.getElementById("homeStatus");
const fisheyeInput = document.getElementById("searchFisheyeEnabled");
const fisheyeStatus = document.getElementById("fisheyeStatus");
const installBadge = document.getElementById("installBadge");
const reportStatus = document.getElementById("reportStatus");
const studySummary = document.getElementById("studySummary");
const exposureStatus = document.getElementById("exposureStatus");
const modelReport = document.getElementById("modelReport");
const segmentReport = document.getElementById("segmentReport");
const interactionSummary = document.getElementById("interactionSummary");
const refreshButton = document.getElementById("refreshReport");
const clearButton = document.getElementById("clearDiagnostics");
const recommendationForm = document.getElementById("recommendationPreferencesForm");
const recommendationHubs = document.getElementById("recommendationHubs");
const recommendationExploration = document.getElementById("recommendationExploration");
const recommendationSave = document.getElementById("saveRecommendationPreferences");
const recommendationPreferencesStatus = document.getElementById("recommendationPreferencesStatus");
let loadedRecommendationPreferences = null;

recommendationForm.addEventListener("submit", async event => {
    event.preventDefault();
    recommendationSave.disabled = true;
    try {
        const hubs = parseHubInput(recommendationHubs.value);
        const saved = await saveHomeRecommendationPreferences({
            hubs,
            exploration: recommendationExploration.checked
        }, { storage: chrome.storage.local });
        showRecommendationPreferences(saved);
        recommendationPreferencesStatus.textContent = "Saved. Applies to the next recommendation set.";
    } catch (error) {
        recommendationPreferencesStatus.textContent = error?.message || "Could not save recommendations.";
    }
    recommendationSave.disabled = false;
});

enabledInput.addEventListener("change", async () => {
    setBusy(true);
    const response = await sendMessage({
        action: "setRankingDiagnostics",
        enabled: enabledInput.checked
    });
    if (!response?.success) {
        enabledInput.checked = !enabledInput.checked;
        reportStatus.textContent = response?.error || "Could not update diagnostics.";
    }
    await refresh();
    setBusy(false);
});

homeInput.addEventListener("change", async () => {
    setBusy(true);
    try {
        homeStatus.textContent = describeHome(await writeFeatureFlag(
            chrome.storage.local,
            FEATURE_FLAGS.homeTakeover,
            homeInput.checked
        ));
    } catch {
        homeInput.checked = !homeInput.checked;
        homeStatus.textContent = "Could not update the new tab setting.";
    }
    setBusy(false);
});

fisheyeInput.addEventListener("change", async () => {
    setBusy(true);
    try {
        const enabled = await writeFeatureFlag(
            chrome.storage.local,
            FEATURE_FLAGS.searchFisheye,
            fisheyeInput.checked
        );
        fisheyeStatus.textContent = enabled
            ? "On for search lists with four or more results."
            : "Off. Search results keep their standard row heights.";
    } catch {
        fisheyeInput.checked = !fisheyeInput.checked;
        fisheyeStatus.textContent = "Could not update the search magnification setting.";
    }
    setBusy(false);
});

refreshButton.addEventListener("click", refresh);
clearButton.addEventListener("click", async () => {
    setBusy(true);
    await sendMessage({ action: "clearRankingDiagnostics" });
    await refresh();
    setBusy(false);
});

async function refresh() {
    const [response, homeTakeoverEnabled, fisheyeEnabled, contextResponse, recommendationResponse] = await Promise.all([
        sendMessage({ action: "getRankingDiagnostics" }),
        readFeatureFlag(chrome.storage.local, FEATURE_FLAGS.homeTakeover),
        readFeatureFlag(chrome.storage.local, FEATURE_FLAGS.searchFisheye),
        sendMessage({ action: "getHomeContextDiagnostics" }),
        sendMessage({ action: "getHomeRecommendationDiagnostics" })
    ]);
    renderRecommendationReport(recommendationResponse);
    const contextReport = document.getElementById("homeContextReport");
    const context = contextResponse?.summary;
    if (contextReport) contextReport.textContent = !contextResponse?.success
        ? "Featured diagnostics are unavailable until the extension is reloaded."
        : !context?.enabled ? "Diagnostics are off."
        : `${context.impressions} displays · ${context.clicks} clicks · ${context.qualifiedOnList} qualified visits · ${context.dismissals} dismissals · ${context.offList} off-list departures. ${context.retainedRecords} retained events.`;
    homeInput.checked = homeTakeoverEnabled;
    homeStatus.textContent = describeHome(homeTakeoverEnabled);
    fisheyeInput.checked = fisheyeEnabled;
    fisheyeStatus.textContent = fisheyeEnabled
        ? "On for search lists with four or more results."
        : "Off. Search results keep their standard row heights.";
    if (!response?.success) {
        reportStatus.textContent = response?.error || "Diagnostics are unavailable.";
        return;
    }

    enabledInput.checked = response.enabled;
    installBadge.textContent = response.installType === "development"
        ? "Internal install · default on"
        : "Standard install · default off";
    renderSummary(response.summary, response.enabled);
    renderRevisitStudy(response.revisitStudy, response.enabled);
    document.getElementById("bookmarkIntentStatus").textContent = !response.enabled ? "Diagnostics are off."
        : response.bookmarkIntentStudy?.groups?.map(group => `${group.source === "mobile-folder" ? "Mobile folder" : "Other bookmarks"}: ${group.tracked} tracked · ${group.opened} opened · ${group.engaged} deeper visits · ${group.pending} pending (${group.overdue7d} saved over a week ago)`).join(". ")
            || "Bookmark observations are unavailable until the extension is reloaded.";
    await renderHiddenContextSites(response.installType === "development");
    if (!loadedRecommendationPreferences) {
        try {
            showRecommendationPreferences(await readHomeRecommendationPreferences({
                storage: chrome.storage.local,
                development: response.installType === "development"
            }));
            recommendationPreferencesStatus.textContent = "Saved on this device.";
        } catch {
            recommendationPreferencesStatus.textContent = "Could not load recommendation preferences.";
        }
    }
}

function parseHubInput(value) {
    const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length > 12) throw new Error("Choose up to 12 favorite hubs.");
    const hubs = [];
    const seen = new Set();
    for (const line of lines) {
        let url;
        try { url = new URL(line); } catch { throw new Error("Use a full http or https address on each line."); }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
            throw new Error("Hub addresses must use http or https without a username or password.");
        }
        url.hash = "";
        const address = url.href;
        if (seen.has(address)) continue;
        seen.add(address);
        const saved = loadedRecommendationPreferences?.hubs?.find(hub => hub.url === address);
        hubs.push({ url: address, title: saved?.title || url.host });
    }
    return hubs;
}

function showRecommendationPreferences(preferences) {
    loadedRecommendationPreferences = preferences;
    recommendationHubs.value = (preferences?.hubs || []).map(hub => hub.url).join("\n");
    recommendationExploration.checked = preferences?.exploration !== false;
}

function renderRecommendationReport(response) {
    const status = document.getElementById("homeRecommendationReport");
    const policies = document.getElementById("homeRecommendationPolicies");
    policies.replaceChildren();
    const summary = response?.summary;
    if (!response?.success) {
        status.textContent = "Recommendation diagnostics are unavailable until the extension is reloaded.";
        return;
    }
    if (!summary?.enabled) {
        status.textContent = "Diagnostics are off. No recommendation outcomes are recorded.";
        return;
    }
    const arms = summary.arms || {};
    const displays = Object.values(arms).reduce((total, arm) => total + Number(arm?.impressions || 0), 0);
    status.textContent = displays
        ? `${displays.toLocaleString()} recommendation sets observed across ${Number(summary.retainedDays || 0)} of the last ${Number(summary.retentionDays || 28)} days.`
        : "Diagnostics are on. Open Home and use recommendations to begin collecting observations.";
    for (const [key, title] of [["balanced", "Balanced mix"], ["explore", "More exploration"]]) {
        const arm = arms[key] || {};
        const card = document.createElement("article");
        card.className = "model-card";
        card.append(textElement("h3", title));
        const metrics = document.createElement("dl");
        metrics.className = "metric-grid";
        for (const [label, field] of [["Sets", "impressions"], ["Items seen", "exposures"], ["Clicks", "clicks"], ["Engaged 10s+", "engaged"], ["Early departures", "bounces"], ["Snoozed", "snoozes"]]) {
            const item = document.createElement("div");
            item.append(textElement("dt", label), textElement("dd", Number(arm[field] || 0).toLocaleString()));
            metrics.append(item);
        }
        card.append(metrics);
        policies.append(card);
    }
}

async function renderHiddenContextSites(development) {
    const root = document.getElementById("hiddenContextSites");
    if (!root) return;
    const { hiddenHosts } = await readRecentContext({ development });
    root.replaceChildren();
    if (!hiddenHosts.length) {
        root.textContent = "No sites hidden from featured context.";
        return;
    }
    for (const host of hiddenHosts) {
        const row = document.createElement("p");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary-button";
        button.textContent = `Restore ${host}`;
        button.addEventListener("click", async () => {
            button.disabled = true;
            try {
                await setContextSiteHidden(host, false, { development });
                await renderHiddenContextSites(development);
            } catch { button.disabled = false; }
        });
        row.append(button);
        root.append(row);
    }
}

function describeHome(enabled) {
    return enabled
        ? "On. New tabs open the ranked Home view."
        : "Off. New tabs open the tab landscape.";
}

function renderSummary(summary, enabled) {
    const models = Array.isArray(summary?.models) ? summary.models : [];
    modelReport.replaceChildren();
    studySummary.replaceChildren();
    segmentReport.replaceChildren();
    if (!enabled) {
        reportStatus.textContent = "Diagnostics are off. No ranking evaluation is running.";
    } else if (models.length === 0) {
        reportStatus.textContent = "Diagnostics are on. Switch between tabs to begin the shadow comparison.";
    } else {
        const observations = Math.max(...models.map(model => model.observations));
        reportStatus.textContent = `${observations} qualified next-tab outcomes compared locally (${summary.study?.cohort || "unknown cohort"}).`;
    }

    renderStudySummary(summary?.study);
    renderExposureGate(summary?.exposureGate, enabled);

    for (const model of sortModels(models)) {
        const card = document.createElement("article");
        card.className = "model-card";
        card.append(
            textElement("h3", friendlyModelName(model.modelVersion)),
            metricGrid(model)
        );
        const lift = liftSummary(model);
        if (lift) card.append(textElement("p", "model-lift", lift));
        modelReport.append(card);
    }
    renderSegments(summary?.segments, summary?.exposureGate?.primaryModel);

    interactionSummary.textContent = summary?.selections || summary?.abandonments
        ? `${summary.selections} Tabtopia selections · ${summary.abandonments} cancelled or native-result exits`
        : "No omnibox interactions recorded.";
    clearButton.disabled = !enabled;
}

function metricGrid(model) {
    const grid = document.createElement("dl");
    grid.className = "metric-grid";
    for (const [label, value] of [
        ["Top 1", model.hit1],
        ["Top 3", model.hit3],
        ["Top 4", model.hit4],
        ["MRR", model.mrr],
        ["Coverage", model.coverage],
        ["Calibration error", model.calibrationError],
        ["Log loss", model.logLoss, "number"]
    ]) {
        const item = document.createElement("div");
        const term = textElement("dt", label);
        const metric = textElement("dd", argumentsForMetric(label, value));
        item.append(term, metric);
        grid.append(item);
    }
    return grid;
}

function friendlyModelName(version) {
    return ({
        "mru-v1": "MRU baseline",
        "investment-v1": "Investment baseline",
        "same-domain-mru-v1": "Same-domain MRU",
        "strip-neighbor-v1": "Tab-strip neighbor",
        "transition-page-v1": "Page transition",
        "transition-domain-v1": "Domain transition",
        "frecency-v1": "Frecency baseline",
        "history-page-v1": "History only · page",
        "history-domain-v1": "History only · domain",
        "bayes-page-v1": "Bayesian · page",
        "bayes-domain-v1": "Bayesian · domain",
        "bayes-hierarchical-v1": "Bayesian · hierarchical",
        "bayes-history-context-v1": "Bayesian History + Context"
    })[version] || version;
}

function formatMetric(value) {
    return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
}

function formatNumber(value) {
    return Number.isFinite(value) ? value.toFixed(2) : "—";
}

function argumentsForMetric(label, value) {
    return label === "Log loss" ? formatNumber(value) : formatMetric(value);
}

function renderStudySummary(study) {
    for (const [label, value] of [
        ["Outcomes", Number(study?.outcomes || 0).toLocaleString()],
        ["Eligible", formatMetric(study?.eligibilityCoverage)],
        ["Censored", formatMetric(study?.censoringRate)],
        ["Censor reasons", formatCensorReasons(study?.censorReasons)],
        ["Weekly windows", Number(study?.evaluationWindows || 0).toLocaleString()],
        ["Retained days", `${Number(study?.retainedDays || 0)} / ${Number(study?.retentionDays || 90)}`],
        ["Retained details", `${Number(study?.retainedDetails || 0).toLocaleString()} / ${Number(study?.detailLimit || 5000).toLocaleString()} (2 MiB limit)`],
        ["Prediction p95 upper bound", Number.isFinite(study?.predictionP95Ms)
            ? `${study.predictionP95Ms.toFixed(1)} ms`
            : "—"]
    ]) {
        const item = document.createElement("div");
        item.className = "study-stat";
        item.append(textElement("span", "study-stat__label", label), textElement("strong", value));
        studySummary.append(item);
    }
}

function renderRevisitStudy(study, enabled) {
    const status = document.getElementById("revisitStudyStatus");
    const report = document.getElementById("revisitStudyReport");
    report.replaceChildren();
    status.textContent = !enabled ? "Diagnostics are off."
        : !study ? "Revisit diagnostics are unavailable until the extension is reloaded."
        : `${Number(study.qualifiedAccesses).toLocaleString()} qualified page accesses · ${study.pendingAnchors} pending anchors · ${study.censoredLabels} expired horizon observations · up to ${study.retentionDays} days retained.`;
    for (const horizon of study?.horizons || []) {
        const card = document.createElement("article");
        card.className = "model-card";
        card.append(textElement("h3", `Within ${horizon.horizon} accesses`));
        card.append(textElement("p", `${horizon.resolved} resolved · ${horizon.returned} returned · ${horizon.noObservedReturn} without observed return · ${horizon.pending} pending`));
        for (const model of horizon.models) {
            const name = model.model === "base-rate-v1" ? "Base rate" : "History buckets";
            card.append(textElement("p", `${name}: Brier ${formatNumber(model.brier)} · calibration error ${formatMetric(model.calibrationError)}`));
        }
        report.append(card);
    }
}

function formatCensorReasons(reasons) {
    if (!Array.isArray(reasons) || reasons.length === 0) return "None";
    const labels = {
        inactivity: "inactivity",
        "outcome-not-candidate": "outside set",
        "candidate-set-changed": "set changed",
        unspecified: "unspecified"
    };
    return reasons
        .map(item => `${labels[item.reason] || item.reason} ${Number(item.count || 0).toLocaleString()}`)
        .join(" · ");
}

function renderExposureGate(gate, enabled) {
    if (!enabled) {
        exposureStatus.textContent = "Exposure gate paused while diagnostics are off.";
        exposureStatus.dataset.state = "paused";
        return;
    }
    if (gate?.ready) {
        exposureStatus.textContent = "Study gate passed. Results still remain shadow-only; no prediction UI is enabled automatically.";
        exposureStatus.dataset.state = "ready";
        return;
    }
    const reason = Array.isArray(gate?.reasons) && gate.reasons.length > 0
        ? gate.reasons[0]
        : "Collecting the first qualified outcomes.";
    exposureStatus.textContent = `Shadow only · ${reason}`;
    exposureStatus.dataset.state = "collecting";
}

function renderSegments(segments, primaryModel) {
    const sections = [
        ["Accuracy by open-tab count", segments?.openTabBands],
        ["Accuracy by browser-session age", segments?.sessionAgeBands],
        ["Next destination type", segments?.destinationClasses]
    ];
    for (const [title, values] of sections) {
        if (!Array.isArray(values) || values.length === 0) continue;
        const group = document.createElement("section");
        group.className = "segment-group";
        group.append(textElement("h3", title));
        const list = document.createElement("ul");
        list.className = "segment-list";
        for (const segment of values) {
            const primary = segment.models?.find(model => model.modelVersion === primaryModel);
            const item = document.createElement("li");
            item.append(
                textElement("strong", segment.band),
                textElement("span", `${segment.eligibleOutcomes} eligible · Top 1 ${formatMetric(primary?.hit1)} · MRR ${formatMetric(primary?.mrr)}`)
            );
            list.append(item);
        }
        group.append(list);
        segmentReport.append(group);
    }
}

function liftSummary(model) {
    const mru = model?.lift?.["mru-v1"];
    const frecency = model?.lift?.["frecency-v1"];
    if (!mru || !frecency) return "";
    return `Top-1 lift · MRU ${formatSignedMetric(mru.hit1)} · Frecency ${formatSignedMetric(frecency.hit1)}`;
}

function formatSignedMetric(value) {
    if (!Number.isFinite(value)) return "—";
    const percentage = Math.round(value * 100);
    return `${percentage > 0 ? "+" : ""}${percentage} pp`;
}

function sortModels(models) {
    const order = [
        "bayes-domain-v1",
        "mru-v1",
        "frecency-v1",
        "bayes-page-v1",
        "bayes-hierarchical-v1",
        "history-page-v1",
        "history-domain-v1",
        "transition-page-v1",
        "transition-domain-v1",
        "investment-v1",
        "same-domain-mru-v1",
        "strip-neighbor-v1"
    ];
    return models.slice().sort((left, right) => {
        const leftIndex = order.indexOf(left.modelVersion);
        const rightIndex = order.indexOf(right.modelVersion);
        return (leftIndex < 0 ? order.length : leftIndex)
            - (rightIndex < 0 ? order.length : rightIndex)
            || left.modelVersion.localeCompare(right.modelVersion);
    });
}

function textElement(tag, classNameOrText, text) {
    const element = document.createElement(tag);
    if (text === undefined) {
        element.textContent = classNameOrText;
    } else {
        element.className = classNameOrText;
        element.textContent = text;
    }
    return element;
}

function setBusy(busy) {
    enabledInput.disabled = busy;
    homeInput.disabled = busy;
    fisheyeInput.disabled = busy;
    refreshButton.disabled = busy;
    clearButton.disabled = busy;
}

function sendMessage(message) {
    return chrome.runtime.sendMessage(message).catch(error => ({
        success: false,
        error: String(error?.message || error)
    }));
}

refresh();
