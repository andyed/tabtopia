#!/usr/bin/env node
// tabtopia MCP server — stdio half of the standalone MCP.
//
// Exposes the user's LIVE browser state to Claude: open tabs ranked by real
// engagement (time actually read × recency), the focused tab, what's playing
// audio, the recent navigation flow, plus named context captures. Read-only
// except capture_context, which persists an observation and never drives the
// browser.
//
// This process is stateless and safe to spawn per Claude session: it holds no
// socket and no snapshot. It reads everything over loopback HTTP from the
// always-on bridge daemon (bridge-daemon.js). Start the daemon first.
//
// Deliberately dependency-free (no MCP SDK, no dotenv, no config import): the
// JSON-RPC framing is hand-rolled, so nothing can print a banner onto stdout
// and corrupt the protocol channel — the exact bug the interests2025-hosted
// version carried.
//
// Register with Claude Code:
//   claude mcp add tabtopia -- node /ABS/PATH/histospire/mcp/server.js

const HTTP_PORT = Number(process.env.TABTOPIA_HTTP_PORT || 8893);
const API = `http://127.0.0.1:${HTTP_PORT}`;

const MAX_CONTENT_CHARS = 12_000; // cap get_tab_content payloads

function log(msg) { process.stderr.write(`[tabtopia-mcp] ${msg}\n`); }

// ---- daemon access ---------------------------------------------------------

async function daemon(path, opts) {
    try {
        const res = await fetch(`${API}${path}`, opts);
        if (!res.ok) return { _err: `bridge returned ${res.status}` };
        return await res.json();
    } catch (err) {
        const down = err.cause?.code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED';
        return { _err: down ? `bridge daemon not running (start: node mcp/bridge-daemon.js, port ${HTTP_PORT})` : err.message };
    }
}

function ageLabel(ms) {
    if (ms == null) return 'never (no snapshot received)';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s ago`;
    return `${Math.round(s / 60)}m ago`;
}

// Engagement rank: time actually spent reading, tie-broken by recency. This is
// the differentiator over a plain tab list — abandoned tabs sink.
function rankTabs(tabs) {
    return [...(tabs || [])].sort((a, b) =>
        (b.timeSpent || 0) - (a.timeSpent || 0) ||
        (b.lastAccessed || 0) - (a.lastAccessed || 0));
}

function tabView(t) {
    return {
        tabId: t.tabId, title: t.title, url: t.url, windowId: t.windowId,
        active: t.active,
        engagement_seconds: Math.round((t.timeSpent || 0) / 1000),
        audio_playing: !!t.isCurrentlyAudible
    };
}

// ---- tool implementations --------------------------------------------------

async function getLiveContext({ minutes = 30, limit = 12 } = {}) {
    const { snapshot, ageMs, stale, _err } = await daemon('/status');
    if (_err) return { status: 'unavailable', reason: _err };
    if (!snapshot) return { status: 'no_data', reason: 'No live snapshot yet — is Chrome running with tabtopia enabled?' };

    const cutoff = Date.now() - minutes * 60_000;
    const recent = (snapshot.recentActivity || []).filter(a => a.timestamp >= cutoff);
    const ranked = rankTabs(snapshot.tabs);

    return {
        snapshot_age: ageLabel(ageMs),
        stale, // true → Chrome may be closed; treat as approximate
        focused_tab: snapshot.focused ? { title: snapshot.focused.title, url: snapshot.focused.url } : null,
        audio_playing: ranked.filter(t => t.isCurrentlyAudible).map(t => ({ title: t.title, url: t.url })),
        open_tabs: ranked.slice(0, limit).map(tabView),
        total_open_tabs: snapshot.tabs?.length || 0,
        window_count: snapshot.windows?.length || 0,
        recent_activity: recent.slice(0, 20).map(a => ({ type: a.type, url: a.url, secondsAgo: Math.round((Date.now() - a.timestamp) / 1000) }))
    };
}

async function captureLiveContext({ name, note } = {}) {
    const result = await daemon('/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, note })
    });
    if (result._err) return { status: 'unavailable', reason: result._err };
    if (!result.ok) return { status: 'failed', reason: result.error };
    return { status: 'saved', id: result.id, tabs_captured: result.tabCount };
}

async function searchLiveState({ query = '', scope = 'tabs', limit = 10 } = {}) {
    const q = query.trim().toLowerCase();
    const match = (...fields) => !q || fields.some(f => (f || '').toLowerCase().includes(q));

    if (scope === 'snapshots') {
        const captures = await daemon('/captures');
        if (captures._err) return { status: 'unavailable', reason: captures._err };
        const hits = (Array.isArray(captures) ? captures : [])
            .filter(c => match(c.id, c.note) || (c.snapshot?.tabs || []).some(t => match(t.title, t.url)))
            .slice(0, limit)
            .map(c => ({ id: c.id, note: c.note, capturedAt: c.capturedAt, tabCount: c.snapshot?.tabs?.length || 0 }));
        return { scope, query, results: hits };
    }

    const { snapshot, ageMs, _err } = await daemon('/status');
    if (_err) return { status: 'unavailable', reason: _err };
    if (!snapshot) return { status: 'no_data', reason: 'No live snapshot yet — is Chrome running with tabtopia enabled?' };

    if (scope === 'activity') {
        const hits = (snapshot.recentActivity || [])
            .filter(a => match(a.url))
            .slice(0, limit)
            .map(a => ({ type: a.type, url: a.url, secondsAgo: Math.round((Date.now() - a.timestamp) / 1000) }));
        return { scope, query, snapshot_age: ageLabel(ageMs), results: hits };
    }

    // scope === 'tabs' (default): match then engagement-rank.
    const hits = rankTabs((snapshot.tabs || []).filter(t => match(t.title, t.url)))
        .slice(0, limit)
        .map(tabView);
    return { scope, query, snapshot_age: ageLabel(ageMs), results: hits };
}

async function getTabContent({ url } = {}) {
    if (!url || typeof url !== 'string') return { error: 'url (string) is required' };
    const result = await daemon('/tab-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
    });
    if (result._err) return { error: result._err };
    if (!result.ok) return { error: result.error || 'failed to read tab' };
    const r = result.result || {};
    const full = (r.content || '');
    const truncated = full.length > MAX_CONTENT_CHARS;
    return {
        url: r.url || url,
        title: r.title,
        content: truncated ? full.slice(0, MAX_CONTENT_CHARS) : full,
        content_truncated: truncated,
        content_length: full.length,
        extraction_method: r.method
    };
}

// ---- tool registry ---------------------------------------------------------

const TOOLS = [
    {
        name: 'get_context',
        description:
            "Get a briefing on what the user is doing in their browser RIGHT NOW: the focused tab, " +
            "other open tabs (ranked by how much they've actually been read, not just opened), what's " +
            "playing audio, and the recent navigation flow. Use at the start of a conversation, or " +
            "whenever the user says \"this\", \"what I'm looking at\", \"my current research\" — anything " +
            "grounded in their present activity. Reads a live snapshot pushed by the tabtopia extension; " +
            "states how many seconds old it is so you know how current it is. Degrades gracefully (says so) " +
            "if Chrome is closed or the extension isn't connected.",
        inputSchema: {
            type: 'object',
            properties: {
                minutes: { type: 'number', description: 'Recent-activity window to summarize, in minutes (default: 30)' },
                limit: { type: 'number', description: 'Max tabs to list, highest-engagement first (default: 12)' }
            }
        }
    },
    {
        name: 'search',
        description:
            "Search the user's LIVE browser state — open tabs, recent activity, and saved context snapshots. " +
            "This is the fastest way to answer \"which tab is about X\", \"do I have Y open\", \"find where I was " +
            "reading about Z\". Tabs are ranked by real engagement (time actually spent reading × recency), so the " +
            "tab the user was truly working in wins over ones opened and abandoned. An empty query lists everything " +
            "in the chosen scope. This is live/open state only; it does not search closed history.",
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'What to look for (matches title/URL/domain). Empty string = list everything in scope.' },
                scope: {
                    type: 'string',
                    enum: ['tabs', 'activity', 'snapshots'],
                    description: "Where to search: 'tabs' (currently open, default), 'activity' (recent navigation flow), 'snapshots' (saved context captures)."
                },
                limit: { type: 'number', description: 'Max results (default: 10)' }
            }
        }
    },
    {
        name: 'capture_context',
        description:
            "Save a named snapshot of the user's CURRENT browser working state (open tabs, focus, recent " +
            "activity) so it can be recalled later with search(scope:'snapshots'). Use when the user is about " +
            "to context-switch and wants to resume later — \"save my research state\", \"bookmark what I'm doing\". " +
            "This only records what's already on screen; it does not open, close, or change any tab. Re-capturing " +
            "the same name overwrites it.",
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'A short label to find this by later (e.g. "webgl-debugging"). Optional; a timestamp is used if omitted.' },
                note: { type: 'string', description: 'Optional free-text note about why this state was saved.' }
            }
        }
    },
    {
        name: 'get_tab_content',
        description:
            'Read the DOM text content from a tab the user CURRENTLY has open, by URL. Use this to read ' +
            'authenticated or dynamic pages (LinkedIn, GitHub, an app the user is logged into) that a plain web ' +
            'fetch cannot see — after get_context or search has surfaced the tab. Reads what is already on screen; ' +
            'it does not navigate, reload, or change the tab. Fails gracefully if the tab is not open or the ' +
            'extension is not connected.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The URL of the tab to read (must be currently open in Chrome).' }
            },
            required: ['url']
        }
    }
];

async function handleToolCall(name, args) {
    switch (name) {
        case 'get_context': return await getLiveContext(args);
        case 'search': return await searchLiveState(args);
        case 'capture_context': return await captureLiveContext(args);
        case 'get_tab_content': return await getTabContent(args);
        default: return { error: `Unknown tool: ${name}` };
    }
}

// ---- MCP JSON-RPC over stdio ----------------------------------------------

function sendResponse(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function sendError(id, code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handleRequest(request) {
    const { id, method, params } = request;
    switch (method) {
        case 'initialize':
            sendResponse(id, {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'tabtopia', version: '0.1.0' }
            });
            break;
        case 'initialized':
            break; // notification
        case 'tools/list':
            sendResponse(id, { tools: TOOLS });
            break;
        case 'tools/call':
            try {
                const { name, arguments: args } = params;
                const result = await handleToolCall(name, args || {});
                sendResponse(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
            } catch (err) {
                log(`tool error: ${err.message}`);
                sendError(id, -32000, err.message);
            }
            break;
        case 'ping':
            sendResponse(id, {});
            break;
        default:
            if (id !== undefined) sendError(id, -32601, `Method not found: ${method}`);
    }
}

let buffer = '';
if (!process.env.MCP_TEST_EXPORT) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.trim()) {
                try {
                    handleRequest(JSON.parse(line)).catch((err) => log(`handler error: ${err.message}`));
                } catch (err) {
                    log(`JSON parse error: ${err.message}`);
                }
            }
        }
    });
    process.stdin.on('end', () => process.exit(0));
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

log(`MCP server started (bridge API ${API})`);

if (process.env.MCP_TEST_EXPORT) {
    module.exports = { handleToolCall, getLiveContext, captureLiveContext, searchLiveState, getTabContent };
}
