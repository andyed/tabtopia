const enabledInput = document.getElementById("diagnosticsEnabled");
const installBadge = document.getElementById("installBadge");
const reportStatus = document.getElementById("reportStatus");
const modelReport = document.getElementById("modelReport");
const interactionSummary = document.getElementById("interactionSummary");
const refreshButton = document.getElementById("refreshReport");
const clearButton = document.getElementById("clearDiagnostics");

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

refreshButton.addEventListener("click", refresh);
clearButton.addEventListener("click", async () => {
    setBusy(true);
    await sendMessage({ action: "clearRankingDiagnostics" });
    await refresh();
    setBusy(false);
});

async function refresh() {
    const response = await sendMessage({ action: "getRankingDiagnostics" });
    if (!response?.success) {
        reportStatus.textContent = response?.error || "Diagnostics are unavailable.";
        return;
    }

    enabledInput.checked = response.enabled;
    installBadge.textContent = response.installType === "development"
        ? "Internal install · default on"
        : "Standard install · default off";
    renderSummary(response.summary, response.enabled);
}

function renderSummary(summary, enabled) {
    const models = Array.isArray(summary?.models) ? summary.models : [];
    modelReport.replaceChildren();
    if (!enabled) {
        reportStatus.textContent = "Diagnostics are off. No ranking evaluation is running.";
    } else if (models.length === 0) {
        reportStatus.textContent = "Diagnostics are on. Switch between tabs to begin the shadow comparison.";
    } else {
        const observations = Math.max(...models.map(model => model.observations));
        reportStatus.textContent = `${observations} qualified next-tab outcomes compared locally.`;
    }

    for (const model of models) {
        const card = document.createElement("article");
        card.className = "model-card";
        card.append(
            textElement("h3", friendlyModelName(model.modelVersion)),
            metricGrid(model)
        );
        modelReport.append(card);
    }

    interactionSummary.textContent = summary?.selections || summary?.abandonments
        ? `${summary.selections} Tabtopia selections · ${summary.abandonments} cancelled or native-result exits`
        : "No omnibox interactions recorded.";
    clearButton.disabled = !summary?.records;
}

function metricGrid(model) {
    const grid = document.createElement("dl");
    grid.className = "metric-grid";
    for (const [label, value] of [
        ["Top 1", model.hit1],
        ["Top 3", model.hit3],
        ["MRR", model.mrr]
    ]) {
        const item = document.createElement("div");
        const term = textElement("dt", label);
        const metric = textElement("dd", formatMetric(value));
        item.append(term, metric);
        grid.append(item);
    }
    return grid;
}

function friendlyModelName(version) {
    if (version === "bayes-history-context-v1") return "Bayesian History + Context";
    if (version === "frecency-v1") return "Frecency baseline";
    return version;
}

function formatMetric(value) {
    return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
}

function textElement(tag, text) {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
}

function setBusy(busy) {
    enabledInput.disabled = busy;
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
