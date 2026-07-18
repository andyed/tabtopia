// End-to-end smoke test for the standalone tabtopia MCP.
// Starts the daemon, simulates the extension over WS (allowed + rejected
// origins), drives the stdio MCP server, checks all 4 tools.
//
//   cd mcp && node test.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { WebSocket } from 'ws';

const MCP_DIR = dirname(fileURLToPath(import.meta.url));
const WS_PORT = Number(process.env.TABTOPIA_WS_PORT || 8892);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };

const daemon = spawn('node', ['bridge-daemon.js'], { cwd: MCP_DIR, stdio: ['ignore', 'ignore', 'inherit'] });
await wait(600);

// 1. Origin rejection
let rejected = false;
await new Promise((res) => {
  const bad = new WebSocket(`ws://127.0.0.1:${WS_PORT}`, { origin: 'chrome-extension://evilbadidxxxxxxxxxxxxxxxxxxxxxxx' });
  bad.on('open', () => { bad.close(); res(); });
  bad.on('error', () => { rejected = true; res(); });
});
ok(rejected, 'WS rejects a non-allowlisted extension origin');

// 2. Allowed extension connects + pushes a snapshot
const ext = new WebSocket(`ws://127.0.0.1:${WS_PORT}`, { origin: 'chrome-extension://moaofehfbphhadakgfiejlpgjdcggfho' });
let extOpen = false;
await new Promise((res, rej) => { ext.on('open', () => { extOpen = true; res(); }); ext.on('error', rej); });
ok(extOpen, 'WS accepts the canonical tabtopia extension origin');

const now = Date.now();
const snapshot = {
  ts: now,
  focused: { tabId: 5, title: 'WebGL shaders — MDN', url: 'https://developer.mozilla.org/webgl' },
  windows: [{ windowId: 1, focused: true, tabCount: 3 }],
  tabs: [
    { tabId: 5, windowId: 1, title: 'WebGL shaders — MDN', url: 'https://developer.mozilla.org/webgl', active: true, isCurrentlyAudible: false, timeSpent: 120000, lastAccessed: now },
    { tabId: 6, windowId: 1, title: 'Lofi beats', url: 'https://youtube.com/watch?v=lofi', active: false, isCurrentlyAudible: true, timeSpent: 5000, lastAccessed: now - 60000 },
    { tabId: 7, windowId: 1, title: 'abandoned tab', url: 'https://example.com/abandoned', active: false, isCurrentlyAudible: false, timeSpent: 0, lastAccessed: now - 200000 },
  ],
  recentActivity: [
    { tabId: 5, type: 'navigation', url: 'https://developer.mozilla.org/webgl', timestamp: now - 10000 },
    { tabId: 6, type: 'navigation', url: 'https://youtube.com/watch?v=lofi', timestamp: now - 30000 },
  ],
};
// The extension answers GET_TAB_CONTENT round-trips with the wrapped shape
// bridge-client.js sends: content is an object, not a bare string.
ext.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'GET_TAB_CONTENT') {
    ext.send(JSON.stringify({
      type: 'TAB_CONTENT_RESULT', id: msg.id, success: true,
      content: { url: msg.url, title: 'MDN', content: `DOM text of ${msg.url}`.repeat(3), method: 'background-worker' },
    }));
  }
});
ext.send(JSON.stringify({ type: 'HELLO', role: 'tabtopia-status' }));
ext.send(JSON.stringify({ type: 'SNAPSHOT', data: snapshot }));
await wait(300);

// 3. Drive the stdio MCP server
const mcp = spawn('node', ['server.js'], { cwd: MCP_DIR, stdio: ['pipe', 'pipe', 'inherit'] });
const responses = new Map();
let buf = '';
mcp.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (line.trim()) { const m = JSON.parse(line); if (m.id != null) responses.set(m.id, m); }
  }
});
const rpc = (id, method, params) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
const call = async (id, name, args) => {
  rpc(id, 'tools/call', { name, arguments: args });
  for (let i = 0; i < 50 && !responses.has(id); i++) await wait(50);
  const r = responses.get(id);
  return r ? JSON.parse(r.result.content[0].text) : null;
};

rpc(1, 'initialize', {});
await wait(200);
ok(responses.get(1)?.result?.serverInfo?.name === 'tabtopia', 'initialize returns serverInfo name=tabtopia');

rpc(2, 'tools/list', {});
await wait(200);
const toolNames = (responses.get(2)?.result?.tools || []).map((t) => t.name).sort();
ok(JSON.stringify(toolNames) === JSON.stringify(['capture_context', 'get_context', 'get_tab_content', 'search']),
  `tools/list = ${toolNames.join(',')}`);

const ctx = await call(3, 'get_context', {});
ok(ctx?.focused_tab?.title === 'WebGL shaders — MDN', 'get_context focused tab correct');
ok(ctx?.open_tabs?.[0]?.tabId === 5, 'get_context ranks highest-engagement tab first');
ok(ctx?.open_tabs?.[ctx.open_tabs.length - 1]?.tabId === 7, 'get_context sinks the abandoned (0s) tab last');
ok(ctx?.audio_playing?.[0]?.title === 'Lofi beats', 'get_context surfaces the audio tab');
ok(/\d+s ago/.test(ctx?.snapshot_age || ''), `get_context reports snapshot age (${ctx?.snapshot_age})`);

const srch = await call(4, 'search', { query: 'webgl', scope: 'tabs' });
ok(srch?.results?.length === 1 && srch.results[0].tabId === 5, 'search(tabs, "webgl") finds the MDN tab');

const empty = await call(5, 'search', { query: '', scope: 'tabs' });
ok(empty?.results?.length === 3, 'search empty query enumerates all tabs');

const cap = await call(6, 'capture_context', { name: 'test-webgl', note: 'smoke' });
ok(cap?.status === 'saved' && cap.tabs_captured === 3, 'capture_context saves the snapshot');

const snaps = await call(7, 'search', { query: 'webgl', scope: 'snapshots' });
ok(snaps?.results?.some((s) => s.id === 'test-webgl'), 'search(snapshots) finds the named capture');

const tc = await call(8, 'get_tab_content', { url: 'https://developer.mozilla.org/webgl' });
ok(tc?.content?.includes('DOM text of'), 'get_tab_content round-trips through the extension');

const tcMiss = await call(9, 'get_tab_content', {});
ok(tcMiss?.error?.includes('url'), 'get_tab_content without url returns a clean error');

mcp.kill(); ext.close(); daemon.kill();
await wait(200);
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
