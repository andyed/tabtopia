import { formatRelativeAccess } from "../lib/tab-recall.js";

/**
 * Visible evidence should explain a result, not expose retrieval plumbing.
 * Self-evident title/domain/URL matches are intentionally omitted.
 */
export function buildSearchEvidence(result, now = Date.now()) {
  const evidence = [];
  const matchedTags = array(result?.matchedTags).filter(Boolean);

  if (result?.matchKind === "Related tag" && matchedTags.length > 0) {
    evidence.push({
      text: `Related via ${matchedTags.slice(0, 2).join(" + ")}`,
      kind: "related"
    });
  } else if (result?.matchKind === "Summary") {
    evidence.push(summaryMatchEvidence(result.summarySource));
  }

  if (result?.open) {
    evidence.push({ text: "Open now", kind: "open" });
  }

  if (result?.bookmarked) {
    evidence.push({
      text: result.bookmarkSavedAt > 0
        ? `Saved ${relativeAge(result.bookmarkSavedAt, now)}`
        : "Saved page",
      kind: "saved"
    });
  } else if (result?.source === "tag" && result?.matchKind !== "Related tag") {
    evidence.push({
      text: result.taggedAt > 0
        ? `Tagged ${relativeAge(result.taggedAt, now)}`
        : "Tagged page",
      kind: "related"
    });
  }

  if (result?.history && !result?.open) {
    const lastVisit = Number(result.historyLastVisitedAt || 0);
    if (Number(result.visitCount || 0) > 1) {
      const timing = lastVisit > 0 ? ` · ${relativeAge(lastVisit, now)}` : "";
      evidence.push({
        text: `Opened ${Math.floor(result.visitCount)}×${timing}`,
        kind: "history"
      });
    } else if (lastVisit > 0 && !result?.bookmarked) {
      evidence.push({
        text: `Last opened ${relativeAge(lastVisit, now)}`,
        kind: "history"
      });
    }
  }

  return evidence.slice(0, 3);
}

function summaryMatchEvidence(source) {
  if (source === "chrome-ai") {
    return { text: "Matched in Chrome AI summary", kind: "ai" };
  }
  if (source === "visit-fallback" || source === "metadata-fallback") {
    return { text: "Matched in recall summary", kind: "recall" };
  }
  return { text: "Matched in saved summary", kind: "recall" };
}

function relativeAge(timestamp, now) {
  return formatRelativeAccess(Number(timestamp), now).replace(/^accessed\s+/u, "");
}

function array(value) {
  return Array.isArray(value) ? value : [];
}
