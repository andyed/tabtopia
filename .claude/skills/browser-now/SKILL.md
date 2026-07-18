---
name: browser-now
description: "Read the user's LIVE browser state — the tabs open right now, which one is focused, what's playing audio, the recent navigation flow, and DOM text from an open (possibly logged-in) tab. Use whenever the request is grounded in the present: \"this page\", \"what I'm looking at\", \"the tab about X\", \"my current research\", \"do I have Y open\", \"save my research state\", or before WebFetch when the user points at something they already have open. Powered by the tabtopia extension + its standalone MCP (tools get_context, search, capture_context, get_tab_content). Not for closed history — that's a separate browsing-history tool."
user-invocable: true
---

# browser-now — live browser state

tabtopia (a Chrome extension) pushes a live snapshot of the browser to a small
standalone MCP server. That snapshot is the ground truth for **what the user is
doing right now**: open tabs, which is focused, what's playing audio, and the
recent navigation flow. Every tab carries **real engagement** — seconds
actually spent reading — so ranking surfaces the tab they were working in over
the six they opened and abandoned.

This is a separate, standalone server that ships in this repo (`mcp/`). It has
**no** external dependencies beyond `ws` — no embeddings, no history corpus. For
*closed* history ("that article last week") use a browsing-history tool instead.

## The four tools

| Tool | Use when | Notes |
|---|---|---|
| `get_context` | Start of a conversation, or any "based on what I'm doing / this / my current research". | Returns focused tab, engagement-ranked open tabs, audio, recent flow. Always states snapshot age. |
| `search` | "which tab is about X", "do I have Y open", "where was I reading about Z". | `scope`: `tabs` (default) · `activity` (recent nav) · `snapshots` (saved captures). Empty query = enumerate the scope. Tabs ranked by dwell × recency. |
| `capture_context` | "save my research state", "bookmark what I'm doing" — before a context switch. | The only write. Persists a **named** snapshot server-side; find it later via `search(scope:'snapshots')`. Never drives the browser. |
| `get_tab_content` | Read an **open** page a plain fetch can't see (logged-in LinkedIn/GitHub/an app), after a tab is surfaced. | Reads what's on screen — no navigate/reload. Fails gracefully if the tab isn't open. |

## How to use it well

- **Reach for `get_context` early** when the request is deictic — "this",
  "here", "what I'm looking at". Don't ask for a URL they already have open.
- **Prefer `get_tab_content` over WebFetch** for a page they currently have open,
  especially anything behind auth. WebFetch gets the logged-out version.
- **Trust the ranking.** The top tab in `get_context` / `search(tabs)` is the
  one they actually engaged with. Lead with it.
- **Every response states snapshot age.** If it says "4m ago / stale", say so —
  Chrome may be closed or the service worker torn down. Treat stale data as
  approximate, don't pretend it's live.
- **Degrade, don't flail.** If a tool returns `unavailable` / `no_data`, the
  bridge daemon or extension isn't running (see Setup). Say so plainly rather
  than retrying in a loop.
- **`get_tab_content` is read-only.** None of these tools open, close, focus, or
  navigate tabs — that's deliberately out of scope. Don't promise browser-driving.

## Setup (once)

Two processes, both from this repo's `mcp/` directory (`npm install` first):

1. **Bridge daemon** (always-on; the extension pushes to it, holds the snapshot):
   ```
   node mcp/bridge-daemon.js
   ```
   WS on `127.0.0.1:8892` (Origin-allowlisted to the tabtopia extension id),
   read API on `127.0.0.1:8893`. Best run under launchd (plist ships at
   `mcp/com.andyed.tabtopia-mcp.plist`) so it survives reboots.

2. **MCP server** (stateless, spawned per Claude session — register once):
   ```
   claude mcp add tabtopia -- node "$(pwd)/mcp/server.js"
   ```

The tabtopia extension must be loaded in Chrome — it's what pushes the snapshot.
If tools report "no live snapshot", check Chrome is open with the extension
enabled and the daemon is running (`curl -s localhost:8893/health`). Full
details in [`mcp/README.md`](../../../mcp/README.md).
