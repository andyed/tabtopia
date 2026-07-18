# tabtopia MCP

Standalone [Model Context Protocol](https://modelcontextprotocol.io) server that
exposes the **live state of your browser** to your agent — Claude Code, Codex
CLI, Gemini CLI, or any MCP client — the tabs open right now,
which one is focused, what's playing audio, the recent navigation flow, and the
DOM text of a tab you already have open (including logged-in pages a plain fetch
can't see).

Tabs are ranked by **real engagement** — seconds actually spent reading, tied by
recency — so "the tab you were working in" beats the six you opened and
abandoned. That ranking is the point; anything can list tabs.

The ranking has a lineage. In ACT-R's rational analysis of memory (Anderson &
Schooler 1991), a memory chunk's base-level activation — how retrievable it is —
estimates the probability it will be needed *now*, from how recently and how
much it has been used. Engagement-seconds × recency is the same estimate applied
to tabs: open tabs are declarative chunks in your extended working memory, the
focused tab is the goal buffer, and `get_context` hands your agent the
activation landscape instead of the tab order.

No embeddings, no history corpus, no external services. One runtime dependency
(`ws`). This is deliberately **not** a browsing-history search — for closed
history use a separate corpus tool.

## Architecture — two processes

```
 tabtopia extension            bridge-daemon.js               server.js (per agent session)
 ┌──────────────┐   WS :8892   ┌────────────────────┐  HTTP   ┌──────────────────┐   stdio   ┌────────┐
 │ browserState │ ───────────► │ latest snapshot     │ :8893  │ MCP tools read   │ ◄───────► │ agent  │
 │ (2s debounce)│  push +      │ (in memory) +       │ ◄────► │ the daemon; no   │           └────────┘
 │              │  GET_TAB_    │ named captures on   │        │ socket, no state │
 └──────────────┘  CONTENT     │ disk (data/)        │        └──────────────────┘
                   round-trip  └────────────────────┘
```

Why split: several agent sessions run at once, so the stdio server is spawned
many times. A WS listener binds its port once — so the socket, and the single
owner of the live snapshot, live in **one** long-lived daemon. Each stdio server
is stateless and reads the daemon over loopback HTTP.

**Security.** The WS handshake is gated by an Origin allowlist — browsers always
send `Origin` on a service-worker WebSocket and page JS can't forge it, so a
drive-by web page can't connect. Both the WS and HTTP surfaces bind `127.0.0.1`
only. Local native processes can spoof Origin; that's outside the threat model.

## Tools

| Tool | What it does |
|---|---|
| `get_context` | Briefing on what you're doing now: focused tab, engagement-ranked open tabs, audio, recent flow. States snapshot age. |
| `search` | Search live state. `scope`: `tabs` (default, engagement-ranked) · `activity` · `snapshots`. Empty query enumerates. |
| `capture_context` | Persist a **named** snapshot of the current working state to `data/`. The only write; never drives the browser. |
| `get_tab_content` | Read DOM text from an open tab by URL, via the extension. Read-only — no navigate/reload. |

## Setup

```sh
cd mcp
npm install                      # pulls ws

# 1. Start the always-on daemon (best under launchd — see below)
node bridge-daemon.js            # WS 127.0.0.1:8892, HTTP 127.0.0.1:8893

# 2. Register the stdio server with your MCP client (once)
claude mcp add tabtopia -- node "$(pwd)/server.js"     # Claude Code
codex mcp add tabtopia -- node "$(pwd)/server.js"      # Codex CLI
gemini mcp add tabtopia node "$(pwd)/server.js"        # Gemini CLI
```

Anything else (Cursor, Windsurf, Cline, …) takes the generic form in its MCP
config:

```json
{ "mcpServers": { "tabtopia": { "command": "node", "args": ["/ABS/PATH/tabtopia/mcp/server.js"] } } }
```

Claude Code users get tool-routing guidance automatically via the
[`browser-now` skill](../.claude/skills/browser-now/SKILL.md) that ships in
this repo. Everyone else: paste [`USAGE-FOR-AGENTS.md`](USAGE-FOR-AGENTS.md)
into whatever context file your agent reads (`AGENTS.md`, `GEMINI.md`, …) —
the tools work without it, but the judgment about *when* to reach for them is
what makes the experience feel ambient.

The **tabtopia extension** must be loaded in Chrome (it pushes the snapshot).
Health check: `curl -s localhost:8893/health`.

### Run the daemon under launchd (macOS)

Copy `com.andyed.tabtopia-mcp.plist` to `~/Library/LaunchAgents/` (edit the
`/Users/YOU` paths and node path first — launchd can't expand `~`), then:

```sh
launchctl load ~/Library/LaunchAgents/com.andyed.tabtopia-mcp.plist
launchctl kickstart -k gui/$(id -u)/com.andyed.tabtopia-mcp
```

On Linux, anything that keeps `node bridge-daemon.js` alive works — a systemd
user unit or a tmux pane. The daemon is a single process with no privileges
beyond binding two loopback ports.

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `TABTOPIA_WS_PORT` | `8892` | Extension → daemon WebSocket. |
| `TABTOPIA_HTTP_PORT` | `8893` | Daemon read API (also read by `server.js`). |
| `TABTOPIA_EXTENSION_IDS` | key-derived id + unpacked fallback | Comma-separated allowlist of extension ids permitted to connect. |
| `TABTOPIA_CAPTURES_FILE` | `mcp/data/context_captures.json` | Where named captures persist. |

## Tests

```sh
node test.mjs      # spins up the daemon, simulates the extension, drives all 4 tools
```
