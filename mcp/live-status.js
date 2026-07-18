// Live browser-status store for the tabtopia MCP.
//
// Two responsibilities:
//   1. Hold the LATEST snapshot pushed over the WS bridge by the tabtopia
//      extension, in memory. This is ephemeral "what's happening now" — never
//      persisted; the extension re-pushes on every state change.
//   2. Persist NAMED captures (capture_context) to disk so search can find
//      them across sessions. This is the one write the MCP surface allows —
//      it stores observations, never drives the browser.
//
// The status tools read from here; ranking (dwell × recency) lives in the MCP
// server where the tools are defined, so this module stays a pure store.
//
// Ported verbatim in spirit from interests2025/src/live_status.js — the point
// of "remove interests2025" is that this now stands alone with no imports from
// that project.

const fs = require('fs');
const path = require('path');

const CAPTURES_FILE =
    process.env.TABTOPIA_CAPTURES_FILE ||
    path.join(__dirname, 'data', 'context_captures.json');

// A snapshot older than this is "stale" — the extension pushes on a ~2s save
// debounce whenever the user is active, so silence past this means Chrome is
// likely closed or the SW is torn down. Reported, never fatal.
const STALE_MS = 60_000;

let latestSnapshot = null; // { ts, focused, windows, tabs, recentActivity }

function setSnapshot(snapshot) {
    // Trust but bound: a malformed push must not poison reads.
    if (!snapshot || typeof snapshot.ts !== 'number') return;
    latestSnapshot = snapshot;
}

// Returns { snapshot, ageMs, stale } — callers report age so the agent knows
// how fresh "now" is. snapshot is null if nothing has ever been pushed.
function getSnapshot() {
    if (!latestSnapshot) return { snapshot: null, ageMs: null, stale: true };
    const ageMs = Date.now() - latestSnapshot.ts;
    return { snapshot: latestSnapshot, ageMs, stale: ageMs > STALE_MS };
}

function loadCaptures() {
    try {
        return JSON.parse(fs.readFileSync(CAPTURES_FILE, 'utf8'));
    } catch (e) {
        return []; // missing/corrupt → empty, not a crash
    }
}

function saveCaptures(list) {
    fs.mkdirSync(path.dirname(CAPTURES_FILE), { recursive: true });
    // Atomic write: temp + rename, so a crash mid-write can't truncate the file.
    const tmp = `${CAPTURES_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, CAPTURES_FILE);
}

// Persist the current live snapshot under a name. Name collisions overwrite
// (last-write-wins) so re-capturing a working state is idempotent.
function captureContext(name, note) {
    const { snapshot, ageMs } = getSnapshot();
    if (!snapshot) return { ok: false, error: 'no live snapshot to capture (extension not connected?)' };

    const captures = loadCaptures();
    const id = name || `capture-${snapshot.ts}`;
    const record = {
        id,
        note: note || '',
        capturedAt: Date.now(),
        snapshotAgeMs: ageMs,
        snapshot
    };
    const idx = captures.findIndex(c => c.id === id);
    if (idx >= 0) captures[idx] = record; else captures.push(record);
    saveCaptures(captures);
    return { ok: true, id, tabCount: snapshot.tabs?.length || 0 };
}

module.exports = { setSnapshot, getSnapshot, loadCaptures, captureContext, STALE_MS, CAPTURES_FILE };
