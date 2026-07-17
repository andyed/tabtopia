// Bridge client: pushes live-status snapshots to the interests2025 WS bridge
// (ws://127.0.0.1:8891), where the MCP server's status tools read them.
//
// MV3 service-worker rules shape this design: NO reconnect timers. A backoff
// loop would keep the SW alive (battery) and fight Chrome's teardown. Instead
// each push attempt lazily (re)connects, throttled to one attempt per 30s when
// the server is down. Pushes ride the 2s-debounced state save, so the
// connection self-heals whenever the user is actually browsing — and when the
// SW is torn down, the server just serves a staler snapshot and says so.
//
// The server authenticates us by the Origin header Chrome attaches to
// SW-initiated WebSockets (chrome-extension://<id>, unforgeable from page JS);
// it must have this extension's id in its ALLOWED_EXTENSION_IDS.

const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8891";
const CONNECT_THROTTLE_MS = 30_000;

let socket = null;
let pendingSnapshot = null;
let lastConnectAttempt = 0;

// Overridable for tests / non-default setups via chrome.storage.local.bridgeUrl.
async function bridgeUrl() {
    const { bridgeUrl: override } = await chrome.storage.local.get("bridgeUrl");
    return override || DEFAULT_BRIDGE_URL;
}

export async function pushSnapshot(snapshot) {
    // Latest-wins: status is idempotent, so an unsent older snapshot is garbage.
    pendingSnapshot = snapshot;

    if (socket) {
        if (socket.readyState === WebSocket.OPEN) return flush();
        if (socket.readyState === WebSocket.CONNECTING) return; // onopen flushes
        socket = null; // CLOSING/CLOSED — fall through to reconnect
    }

    const now = Date.now();
    if (now - lastConnectAttempt < CONNECT_THROTTLE_MS) return; // server likely down
    lastConnectAttempt = now;

    try {
        socket = new WebSocket(await bridgeUrl());
    } catch (e) {
        socket = null;
        return;
    }
    socket.onopen = () => {
        try {
            // Role announcement keeps the bridge from routing scrape requests
            // here (interester remains the scraper client).
            socket.send(JSON.stringify({ type: "HELLO", role: "tabtopia-status" }));
        } catch (e) { /* close handler will clean up */ }
        flush();
    };
    socket.onclose = () => { socket = null; };
    socket.onerror = () => { /* onclose follows; next push reconnects */ };
}

function flush() {
    if (!pendingSnapshot || !socket || socket.readyState !== WebSocket.OPEN) return;
    try {
        socket.send(JSON.stringify({ type: "SNAPSHOT", data: pendingSnapshot }));
        pendingSnapshot = null;
    } catch (e) { /* keep pendingSnapshot; retry on next push */ }
}

// A bridgeUrl change applies immediately: drop the current socket (it points
// at the old URL — the URL is only read at connect time) and clear the
// connect throttle so the next push reconnects to the new target right away.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.bridgeUrl) {
        lastConnectAttempt = 0;
        if (socket) {
            try { socket.close(); } catch (e) { /* already closing */ }
            socket = null;
        }
    }
});
