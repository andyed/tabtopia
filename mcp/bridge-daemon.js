#!/usr/bin/env node
// tabtopia bridge daemon — the always-on half of the standalone MCP.
//
// Why two processes: several agent sessions run concurrently, so the stdio MCP
// server (server.js) is spawned many times over. A WS listener can only bind
// its port once. So the bridge — the thing the extension pushes to, and the
// single owner of the live snapshot — lives HERE, in one long-lived daemon, and
// every stdio MCP instance reads it over a tiny loopback HTTP API. This mirrors
// the split interests2025 used, minus every interests2025 dependency.
//
// Surfaces:
//   WS   :8892  — the tabtopia extension connects and pushes SNAPSHOT frames;
//                 GET_TAB_CONTENT round-trips ride the same socket.
//   HTTP :8893  — loopback-only read API the stdio MCP fetches:
//                   GET  /status        -> { snapshot, ageMs, stale }
//                   GET  /captures      -> [ ...named captures ]
//                   POST /capture       -> { ok, id, tabCount }
//                   POST /tab-content   -> { ok, result } | { ok:false, error }
//                   GET  /health        -> { ok, extensionConnected, ... }
//
// Security: the WS handshake is gated by an Origin allowlist. Browsers always
// send Origin on a SW-initiated WebSocket and page JS cannot forge it, so this
// blocks the drive-by-webpage vector (the audit-#1 gap of the old unauth
// bridge). Local native processes can spoof Origin — outside this threat model.
// The HTTP API binds 127.0.0.1 only (never the LAN).

const http = require('http');
const WebSocket = require('ws');
const liveStatus = require('./live-status');

const WS_PORT = Number(process.env.TABTOPIA_WS_PORT || 8892);
const HTTP_PORT = Number(process.env.TABTOPIA_HTTP_PORT || 8893);

// tabtopia's stable, key-derived extension id is canonical. The path-derived
// unpacked id is kept as a fallback so a dev load that predates the manifest
// `key` still connects. Override with TABTOPIA_EXTENSION_IDS=id1,id2.
const DEFAULT_IDS = [
    'moaofehfbphhadakgfiejlpgjdcggfho', // key-derived (manifest `key`) — canonical
    'jngpfmgdkoiamgkhfdpmdoiloncgeppj'  // path-derived unpacked fallback
];
const ALLOWED_IDS = (process.env.TABTOPIA_EXTENSION_IDS
    ? process.env.TABTOPIA_EXTENSION_IDS.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_IDS);
const ALLOWED_ORIGINS = ALLOWED_IDS.map(id => `chrome-extension://${id}`);

const TAB_CONTENT_TIMEOUT_MS = 10_000;

let statusClient = null;                 // the extension's live socket (latest wins)
const pendingRequests = new Map();       // id -> { resolve, reject, timer }

function log(msg) { process.stderr.write(`[tabtopia-bridge] ${msg}\n`); }

// ---- WS bridge -------------------------------------------------------------

const wss = new WebSocket.Server({
    port: WS_PORT,
    host: '127.0.0.1', // loopback only — never expose the bridge to the LAN
    verifyClient: ({ origin }) => {
        if (ALLOWED_ORIGINS.includes(origin)) return true;
        log(`REJECTED WS origin: ${origin || '(none)'}`);
        return false;
    }
});

wss.on('listening', () => log(`WS listening on 127.0.0.1:${WS_PORT} (allow: ${ALLOWED_IDS.join(', ')})`));
wss.on('error', (e) => { log(`WS server error: ${e.message}`); process.exit(1); });

wss.on('connection', (ws) => {
    log('extension connected');
    statusClient = ws;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.type === 'HELLO') {
            statusClient = ws; // announce; latest connection wins
        } else if (msg.type === 'SNAPSHOT') {
            statusClient = ws;
            liveStatus.setSnapshot(msg.data);
        } else if (msg.type === 'TAB_CONTENT_RESULT') {
            const pend = pendingRequests.get(msg.id);
            if (pend) {
                clearTimeout(pend.timer);
                pendingRequests.delete(msg.id);
                if (msg.success) pend.resolve(msg.content);
                else pend.reject(new Error(msg.error || 'extension reported failure'));
            }
        } else if (msg.type === 'PING') {
            // keepalive, ignore
        }
    });

    ws.on('close', () => {
        log('extension disconnected');
        if (statusClient === ws) statusClient = null;
    });
    ws.on('error', () => { /* close handler cleans up */ });
});

// Read DOM text from an already-open tab, by URL, via the extension. Rejects
// (never hangs) when the extension is gone or slow.
function getTabContent(url, view = 'text') {
    if (!statusClient || statusClient.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('extension not connected'));
    }
    return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2);
        const timer = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error('tab content request timed out (10s)'));
        }, TAB_CONTENT_TIMEOUT_MS);
        pendingRequests.set(id, { resolve, reject, timer });
        try {
            statusClient.send(JSON.stringify({ type: 'GET_TAB_CONTENT', id, url, view }));
        } catch (e) {
            clearTimeout(timer);
            pendingRequests.delete(id);
            reject(e);
        }
    });
}

// ---- HTTP read API (loopback) ----------------------------------------------

function sendJson(res, code, body) {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
    res.end(buf);
}

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
        req.on('error', () => resolve({}));
    });
}

const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);

    if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
            ok: true,
            extensionConnected: !!(statusClient && statusClient.readyState === WebSocket.OPEN),
            hasSnapshot: !!liveStatus.getSnapshot().snapshot,
            wsPort: WS_PORT, httpPort: HTTP_PORT
        });
    }

    if (req.method === 'GET' && url.pathname === '/status') {
        return sendJson(res, 200, liveStatus.getSnapshot());
    }

    if (req.method === 'GET' && url.pathname === '/captures') {
        return sendJson(res, 200, liveStatus.loadCaptures());
    }

    if (req.method === 'POST' && url.pathname === '/capture') {
        const { name, note } = await readBody(req);
        return sendJson(res, 200, liveStatus.captureContext(name, note));
    }

    if (req.method === 'POST' && url.pathname === '/tab-content') {
        const { url: tabUrl, view = 'text' } = await readBody(req);
        if (!tabUrl) return sendJson(res, 400, { ok: false, error: 'url required' });
        try {
            const result = await getTabContent(tabUrl, view);
            return sendJson(res, 200, { ok: true, result });
        } catch (e) {
            return sendJson(res, 200, { ok: false, error: e.message });
        }
    }

    sendJson(res, 404, { error: 'not found' });
});

httpServer.on('error', (e) => { log(`HTTP server error: ${e.message}`); process.exit(1); });
httpServer.listen(HTTP_PORT, '127.0.0.1', () => log(`HTTP API on 127.0.0.1:${HTTP_PORT}`));

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

log('tabtopia bridge daemon started');
