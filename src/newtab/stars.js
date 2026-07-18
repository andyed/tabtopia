import {
    readSharedQuery,
    publishSharedQuery,
    decorateViewLinks,
    onSharedQueryChange
} from "./search-persistence.js";
import { formatTimeAgo } from "./timeago.js";
import { getLocalFaviconUrl, safeUrl } from "./utility.js";

const CONTEXT_WINDOW_MS = 15 * 60 * 1000;
const HISTORY_HORIZON_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_LANDMARKS = 80;
const MAX_MAP_LANDMARKS = 60;
const TERRAIN_COLORS = ["#17382f", "#1c4035", "#21483b", "#294b41", "#233b35"];

let allLandmarks = [];
let visibleLandmarks = [];
let selectedLandmarkId = null;
let currentSort = "signal";
let resizeObserver = null;
let resizeFrame = null;

document.addEventListener("DOMContentLoaded", () => {
    renderShell();
    initControls();
    initLandmarks();
});

function renderShell() {
    const container = document.getElementById("stars-container");
    container.innerHTML = `
        <section class="landmarks-overview" aria-labelledby="landmarks-title">
            <header class="landmarks-intro">
                <div>
                    <p class="landmarks-eyebrow">Saved territory</p>
                    <h1 id="landmarks-title">Landmarks</h1>
                    <p>Pages that became durable anchors in your browsing landscape.</p>
                </div>
                <label class="landmark-sort">Arrange
                    <select id="landmarkSort">
                        <option value="signal">Strongest signal</option>
                        <option value="recent">Most recent</option>
                        <option value="context">Richest context</option>
                    </select>
                </label>
            </header>
            <div class="landmark-stats" aria-live="polite">
                <span><strong id="landmarkCount">0</strong> landmarks</span>
                <span><strong id="revisitedCount">0</strong> revisited</span>
                <span><strong id="contextCount">0</strong> contextual pages</span>
            </div>
            <div id="landmarks-map-frame" class="landmarks-map-frame">
                <svg id="landmarks-map" role="list" aria-label="Saved landmarks grouped by domain"></svg>
                <div id="landmarks-loading" class="landmarks-loading">Surveying saved territory…</div>
                <div class="landmarks-legend" aria-hidden="true">
                    <span><i class="legend-size"></i>size = return signal</span>
                    <span><i class="legend-ring"></i>ring = context depth</span>
                    <span><i class="legend-point"></i>point = selected</span>
                </div>
            </div>
        </section>
        <aside id="landmark-detail" class="landmark-detail" aria-live="polite">
            <div class="landmark-detail-empty">
                <img src="../../assets/brand/tabtopia-mark.svg" alt="" width="56" height="56">
                <p>Select a landmark to inspect the trail that made it worth saving.</p>
            </div>
        </aside>`;
}

function initControls() {
    const input = document.getElementById("starsSearch");
    const sort = document.getElementById("landmarkSort");
    const initialQuery = readSharedQuery();

    input.value = initialQuery;
    decorateViewLinks(initialQuery.trim());

    let searchTimer = null;
    input.addEventListener("input", (event) => {
        const query = event.target.value.trim();
        publishSharedQuery(query);
        decorateViewLinks(query);
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => applyFilter(query), 120);
    });

    onSharedQueryChange((query) => {
        input.value = query;
        decorateViewLinks(query.trim());
        applyFilter(query);
    });

    sort.addEventListener("change", (event) => {
        currentSort = event.target.value;
        renderMap();
    });

    const frame = document.getElementById("landmarks-map-frame");
    if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
            cancelAnimationFrame(resizeFrame);
            resizeFrame = requestAnimationFrame(renderMap);
        });
        resizeObserver.observe(frame);
    }

    window.addEventListener("unload", () => {
        resizeObserver?.disconnect();
        cancelAnimationFrame(resizeFrame);
    });
}

async function initLandmarks() {
    try {
        const [bookmarks, summaries] = await Promise.all([
            fetchRecentBookmarks(MAX_LANDMARKS),
            fetchCachedSummaries()
        ]);

        if (!bookmarks.length) {
            showEmptyState();
            return;
        }

        const recentHistory = await fetchRecentHistory();
        allLandmarks = bookmarks.map(bookmark => createLandmark(bookmark, recentHistory, summaries));
        applyFilter(document.getElementById("starsSearch")?.value || "");
        document.getElementById("landmarks-loading")?.remove();
    } catch (error) {
        console.error("Error initializing landmarks view:", error);
        showErrorState();
    }
}

function createLandmark(bookmark, historyItems, summaries) {
    const url = bookmark.url || "";
    const domain = domainFromUrl(url);
    const savedAt = Number(bookmark.dateAdded) || Date.now();
    const context = historyItems
        .filter(item => item.url && item.url !== url && Math.abs((item.lastVisitTime || 0) - savedAt) <= CONTEXT_WINDOW_MS)
        .sort((a, b) => (a.lastVisitTime || 0) - (b.lastVisitTime || 0));
    const historyRecord = historyItems.find(item => item.url === url);
    const landmark = {
        id: String(bookmark.id || url),
        bookmark,
        url,
        title: bookmark.title || domain || url || "Untitled landmark",
        domain,
        savedAt,
        summary: summaries[url]?.summary || "",
        visitCount: Math.max(1, Number(historyRecord?.visitCount) || 1),
        context,
        contextLoaded: false,
        contextLoading: false
    };
    updateLandmarkMetrics(landmark);
    return landmark;
}

function updateLandmarkMetrics(landmark) {
    const domains = new Set(landmark.context.map(item => domainFromUrl(item.url)).filter(Boolean));
    landmark.contextCount = landmark.context.length;
    landmark.domainCount = domains.size;
    landmark.revisitCount = Math.max(0, landmark.visitCount - 1);
    landmark.ageDays = Math.max(0, (Date.now() - landmark.savedAt) / 86400000);

    const returnSignal = Math.log2(landmark.visitCount + 1) * 4;
    const contextSignal = Math.log2(landmark.contextCount + 1) * 2.5;
    const diversitySignal = Math.min(4, landmark.domainCount);
    const freshnessSignal = 3 / Math.sqrt(landmark.ageDays + 1);
    landmark.signal = Math.max(1, returnSignal + contextSignal + diversitySignal + freshnessSignal);
}

function applyFilter(rawQuery) {
    const query = String(rawQuery || "").trim().toLowerCase();
    visibleLandmarks = allLandmarks.filter(landmark => {
        if (!query) return true;
        return `${landmark.title} ${landmark.url} ${landmark.domain} ${landmark.summary}`.toLowerCase().includes(query);
    });

    if (!visibleLandmarks.some(item => item.id === selectedLandmarkId)) {
        selectedLandmarkId = visibleLandmarks[0]?.id || null;
    }

    updateStats();
    renderMap();
    renderSelectedDetail();
}

function updateStats() {
    const revisited = visibleLandmarks.filter(item => item.revisitCount > 0).length;
    const contextPages = visibleLandmarks.reduce((sum, item) => sum + item.contextCount, 0);
    document.getElementById("landmarkCount").textContent = visibleLandmarks.length;
    document.getElementById("revisitedCount").textContent = revisited;
    document.getElementById("contextCount").textContent = contextPages;
}

function renderMap() {
    const svgElement = document.getElementById("landmarks-map");
    const frame = document.getElementById("landmarks-map-frame");
    if (!svgElement || !frame || typeof d3 === "undefined") return;

    const width = Math.max(520, Math.floor(frame.clientWidth));
    const height = Math.max(480, Math.floor(frame.clientHeight));
    const svg = d3.select(svgElement).attr("viewBox", `0 0 ${width} ${height}`);
    svg.selectAll("*").remove();

    if (!visibleLandmarks.length) {
        svg.append("text")
            .attr("class", "map-empty-label")
            .attr("x", width / 2)
            .attr("y", height / 2)
            .attr("text-anchor", "middle")
            .text(allLandmarks.length ? "No landmark matches this search." : "No saved landmarks yet.");
        return;
    }

    const ordered = [...visibleLandmarks]
        .sort((a, b) => metricValue(b) - metricValue(a))
        .slice(0, MAX_MAP_LANDMARKS);
    const byDomain = d3.group(ordered, landmark => landmark.domain || "other");
    const hierarchy = {
        children: Array.from(byDomain, ([domain, landmarks]) => ({
            domain,
            children: landmarks.map(landmark => ({ landmark }))
        }))
    };

    const root = d3.hierarchy(hierarchy)
        .sum(node => node.landmark ? metricValue(node.landmark) : 0)
        .sort((a, b) => b.value - a.value);
    d3.pack().size([width - 32, height - 58]).padding(9)(root);

    const map = svg.append("g").attr("transform", "translate(16,16)");

    map.selectAll("circle.domain-contour")
        .data(root.children || [])
        .join("circle")
        .attr("class", "domain-contour")
        .attr("cx", d => d.x)
        .attr("cy", d => d.y)
        .attr("r", d => d.r);

    map.selectAll("text.domain-label")
        .data((root.children || []).filter(d => d.r > 62))
        .join("text")
        .attr("class", "domain-label")
        .attr("x", d => d.x)
        .attr("y", d => d.y - d.r + 17)
        .attr("text-anchor", "middle")
        .text(d => d.data.domain);

    const nodes = map.selectAll("g.landmark-node")
        .data(root.leaves(), d => d.data.landmark.id)
        .join("g")
        .attr("class", d => `landmark-node${d.data.landmark.id === selectedLandmarkId ? " selected" : ""}`)
        .attr("transform", d => `translate(${d.x},${d.y})`)
        .attr("role", "listitem")
        .attr("tabindex", 0)
        .attr("aria-label", d => `${d.data.landmark.title}, ${d.data.landmark.visitCount} visits, ${d.data.landmark.contextCount} contextual pages`)
        .on("click", (_event, d) => selectLandmark(d.data.landmark.id))
        .on("keydown", (event, d) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                selectLandmark(d.data.landmark.id);
            }
        });

    nodes.append("circle")
        .attr("class", "landmark-halo")
        .attr("r", d => Math.max(0, d.r - 2))
        .style("stroke-width", d => Math.min(7, 1.5 + d.data.landmark.contextCount * 0.35));

    nodes.append("circle")
        .attr("class", "landmark-peak")
        .attr("r", d => Math.max(8, d.r - 8))
        .attr("fill", d => terrainColor(d.data.landmark.domain));

    nodes.filter(d => d.data.landmark.id === selectedLandmarkId)
        .append("circle")
        .attr("class", "landmark-waypoint")
        .attr("cx", d => Math.max(4, d.r * 0.54))
        .attr("cy", d => -Math.max(4, d.r * 0.54))
        .attr("r", d => Math.max(5, Math.min(9, d.r * 0.12)));

    nodes.each(function addLabel(d) {
        if (d.r < 30) return;
        const landmark = d.data.landmark;
        const lines = splitLabel(landmark.title, d.r > 58 ? 22 : 15);
        const text = d3.select(this).append("text")
            .attr("class", "landmark-label")
            .attr("text-anchor", "middle")
            .attr("y", lines.length === 1 ? 4 : -3);
        lines.forEach((line, index) => {
            text.append("tspan").attr("x", 0).attr("dy", index === 0 ? 0 : 15).text(line);
        });
        if (d.r > 48) {
            d3.select(this).append("text")
                .attr("class", "landmark-signal-label")
                .attr("text-anchor", "middle")
                .attr("y", Math.min(d.r - 14, 34))
                .text(`${landmark.visitCount} visits · ${landmark.contextCount} nearby`);
        }
    });

    nodes.append("title").text(d => `${d.data.landmark.title}\n${d.data.landmark.domain}`);
}

function metricValue(landmark) {
    if (currentSort === "recent") return 18 / Math.sqrt(landmark.ageDays + 1) + 1;
    if (currentSort === "context") return landmark.contextCount + landmark.domainCount * 1.5 + 1;
    return landmark.signal;
}

function terrainColor(domain) {
    let hash = 0;
    for (const character of String(domain || "")) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
    return TERRAIN_COLORS[Math.abs(hash) % TERRAIN_COLORS.length];
}

function splitLabel(title, maxCharacters) {
    const words = String(title || "Untitled").trim().split(/\s+/);
    const lines = [""];
    for (const word of words) {
        const candidate = `${lines[lines.length - 1]} ${word}`.trim();
        if (candidate.length <= maxCharacters || !lines[lines.length - 1]) {
            lines[lines.length - 1] = candidate;
        } else if (lines.length === 1) {
            lines.push(word);
        } else {
            lines[1] = `${lines[1]}…`;
            break;
        }
    }
    return lines.map(line => line.length > maxCharacters + 4 ? `${line.slice(0, maxCharacters)}…` : line);
}

function selectLandmark(id) {
    selectedLandmarkId = id;
    renderMap();
    renderSelectedDetail();
}

function renderSelectedDetail() {
    const detail = document.getElementById("landmark-detail");
    const landmark = visibleLandmarks.find(item => item.id === selectedLandmarkId);
    if (!detail) return;

    detail.replaceChildren();
    if (!landmark) {
        const empty = document.createElement("div");
        empty.className = "landmark-detail-empty";
        const text = document.createElement("p");
        text.textContent = "Select a landmark to inspect its browsing trail.";
        empty.appendChild(text);
        detail.appendChild(empty);
        return;
    }

    const header = document.createElement("header");
    header.className = "detail-header";
    const eyebrow = document.createElement("p");
    eyebrow.className = "detail-eyebrow";
    eyebrow.textContent = landmark.domain;
    const title = document.createElement("h2");
    title.textContent = landmark.title;
    const saved = document.createElement("p");
    saved.className = "detail-saved";
    saved.textContent = `Saved ${formatTimeAgo(landmark.savedAt)}`;
    header.append(eyebrow, title, saved);

    const summary = document.createElement("p");
    summary.className = "detail-summary";
    summary.textContent = landmark.summary || fallbackSummary(landmark);

    const metrics = document.createElement("div");
    metrics.className = "detail-metrics";
    metrics.append(
        createMetric(landmark.visitCount, "visits"),
        createMetric(landmark.contextCount, "nearby pages"),
        createMetric(landmark.domainCount, "domains")
    );

    const action = document.createElement("a");
    action.className = "open-landmark";
    action.href = safeUrl(landmark.url);
    action.target = "_blank";
    action.rel = "noopener noreferrer";
    action.textContent = "Open landmark ↗";

    const trailSection = document.createElement("section");
    trailSection.className = "trail-section";
    const trailHeading = document.createElement("div");
    trailHeading.className = "trail-heading";
    const heading = document.createElement("h3");
    heading.textContent = "Context transect";
    const note = document.createElement("span");
    note.textContent = "±15 min from save";
    trailHeading.append(heading, note);
    trailSection.append(trailHeading, createContextTrail(landmark));

    detail.append(header, summary, metrics, action, trailSection);

    if (!landmark.contextLoaded && !landmark.contextLoading) {
        enrichSelectedLandmark(landmark);
    }
}

function createMetric(value, label) {
    const metric = document.createElement("div");
    const number = document.createElement("strong");
    number.textContent = String(value);
    const caption = document.createElement("span");
    caption.textContent = label;
    metric.append(number, caption);
    return metric;
}

function createContextTrail(landmark) {
    const trail = document.createElement("div");
    trail.className = "context-trail";
    const before = landmark.context.filter(item => (item.lastVisitTime || 0) <= landmark.savedAt).slice(-3);
    const after = landmark.context.filter(item => (item.lastVisitTime || 0) > landmark.savedAt).slice(0, 3);

    if (!before.length && !after.length) {
        const empty = document.createElement("p");
        empty.className = "trail-empty";
        empty.textContent = landmark.contextLoading ? "Reading the surrounding trail…" : "No nearby browsing trail was recorded.";
        trail.appendChild(empty);
        return trail;
    }

    before.forEach(item => trail.appendChild(createTrailNode(item, "before")));
    const anchor = document.createElement("a");
    anchor.className = "trail-node trail-anchor";
    anchor.href = safeUrl(landmark.url);
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.title = landmark.title;
    const icon = document.createElement("img");
    icon.src = getLocalFaviconUrl(landmark.url, 32);
    icon.alt = "";
    const label = document.createElement("span");
    label.textContent = "saved";
    anchor.append(icon, label);
    trail.appendChild(anchor);
    after.forEach(item => trail.appendChild(createTrailNode(item, "after")));
    return trail;
}

function createTrailNode(item, position) {
    const link = document.createElement("a");
    link.className = `trail-node trail-${position}`;
    link.href = safeUrl(item.url);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = item.title || item.url;
    const icon = document.createElement("img");
    icon.src = getLocalFaviconUrl(item.url, 32);
    icon.alt = "";
    const label = document.createElement("span");
    label.textContent = domainFromUrl(item.url);
    link.append(icon, label);
    return link;
}

async function enrichSelectedLandmark(landmark) {
    landmark.contextLoading = true;
    renderSelectedDetail();
    try {
        landmark.context = await fetchContext(landmark.savedAt, landmark.url);
        const landmarkHistory = await fetchUrlHistory(landmark.url);
        landmark.visitCount = Math.max(landmark.visitCount, Number(landmarkHistory?.visitCount) || 1);
        landmark.contextLoaded = true;
        updateLandmarkMetrics(landmark);
        updateStats();
        renderMap();
    } catch (error) {
        console.error("Error enriching landmark context:", error);
    } finally {
        landmark.contextLoading = false;
        if (selectedLandmarkId === landmark.id) renderSelectedDetail();
    }
}

function fallbackSummary(landmark) {
    if (landmark.contextCount) {
        return `A saved page surrounded by ${landmark.contextCount} nearby pages across ${landmark.domainCount || 1} domains.`;
    }
    return "A saved point in your browsing landscape. Its surrounding trail has not been recovered yet.";
}

function domainFromUrl(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch (_error) {
        return "unknown domain";
    }
}

async function fetchCachedSummaries() {
    const result = await chrome.storage.local.get(["nanoSummaries"]);
    return result.nanoSummaries || {};
}

async function fetchRecentHistory() {
    const items = await chrome.history.search({
        text: "",
        startTime: Date.now() - HISTORY_HORIZON_MS,
        maxResults: 5000
    });
    return items.filter(item => isPublicWebUrl(item.url));
}

async function fetchContext(savedAt, bookmarkUrl) {
    const items = await chrome.history.search({
        text: "",
        startTime: savedAt - CONTEXT_WINDOW_MS,
        endTime: savedAt + CONTEXT_WINDOW_MS,
        maxResults: 100
    });
    return items
        .filter(item => item.url !== bookmarkUrl && isPublicWebUrl(item.url))
        .sort((a, b) => (a.lastVisitTime || 0) - (b.lastVisitTime || 0));
}

async function fetchUrlHistory(url) {
    const items = await chrome.history.search({ text: url, maxResults: 20 });
    return items.find(item => item.url === url) || items[0] || null;
}

function fetchRecentBookmarks(count) {
    return chrome.bookmarks.getRecent(count);
}

function isPublicWebUrl(url) {
    try {
        const protocol = new URL(url).protocol;
        return protocol === "http:" || protocol === "https:";
    } catch (_error) {
        return false;
    }
}

function showEmptyState() {
    document.getElementById("landmarks-loading")?.remove();
    const detail = document.getElementById("landmark-detail");
    detail.innerHTML = '<div class="landmark-detail-empty"><p>No saved landmarks yet. Bookmark a page and its surrounding trail will appear here.</p></div>';
    renderMap();
}

function showErrorState() {
    const loading = document.getElementById("landmarks-loading");
    if (loading) loading.textContent = "The saved landscape could not be read.";
}
