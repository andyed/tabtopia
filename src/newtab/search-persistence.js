// Shared search-query hand-off between the app's views — newtab/treemap,
// graph, sessions, stars are SEPARATE HTML documents, each with its own search
// box, so the query must be explicitly carried between them.
//
// Scope: a query is a WITHIN-SESSION intent. It carries across tabs, views and
// windows while the browser is up, and dies with the browser — a fresh session
// starts with a clean box (tests/e2e/search.spec.js "query does NOT survive a
// browser restart").
//
// Two carriers, both needed:
//   - URL ?q=  — the header view-switch links get the query appended, so
//     clicking between views hands it to the next document synchronously.
//     Also makes a filtered view deep-linkable/reload-safe.
//   - chrome.storage.session — covers fresh newtabs (Cmd+T), where Chrome
//     renders the override page and there is no URL we can put a param on.
//     Per-browser-session by definition (cleared on exit), shared across all
//     extension pages, and its onChanged event live-syncs views that are open
//     simultaneously. (Replaces localStorage, which retained the query across
//     browser restarts.)
//
// When both are present the URL wins: it's the more specific intent ("I
// navigated here with this query").
//
// The storage read is async, so readSharedQuery() only answers the URL case
// synchronously; the stored query for a fresh Cmd+T newtab is delivered
// through the onSharedQueryChange() callback moments later — the same path a
// remote edit takes, so views need no extra wiring.

const SEARCH_QUERY_STORAGE_KEY = "tabtopia.searchQuery";

function sessionArea() {
    try {
        return (typeof chrome !== "undefined" && chrome.storage && chrome.storage.session) || null;
    } catch (e) {
        return null;
    }
}

// chrome.storage.onChanged — unlike the window `storage` event — ALSO fires in
// the document that did the write. Writes are queued here so the writer can
// recognize and swallow its own echoes; entries expire so a stale no-op write
// (set to the value already stored fires no event) can't swallow a genuine
// remote edit later.
const pendingWrites = [];
const PENDING_WRITE_TTL_MS = 2000;

function writeStorage(query) {
    const area = sessionArea();
    if (!area) return; // no session storage — search still works, the query just isn't carried
    pendingWrites.push({ value: query || "", t: Date.now() });
    try {
        if (query) {
            area.set({ [SEARCH_QUERY_STORAGE_KEY]: query });
        } else {
            area.remove(SEARCH_QUERY_STORAGE_KEY);
        }
    } catch (e) { /* storage unavailable — same degradation as above */ }
}

// True once the user has edited the query in THIS document — after that the
// async initial restore must not clobber what they typed.
let publishedLocally = false;

// One-time cleanup of the retired carrier: profiles that ran the localStorage
// version may still hold a years-old query; make sure it can never resurface.
try { localStorage.removeItem(SEARCH_QUERY_STORAGE_KEY); } catch (e) { /* fine */ }

// Query to seed this document's search box with, at load time. Synchronous:
// answers from the URL ?q= only. A session-stored query (fresh Cmd+T newtab)
// arrives via onSharedQueryChange() instead.
export function readSharedQuery() {
    let fromUrl = null;
    try {
        fromUrl = new URLSearchParams(window.location.search).get("q");
    } catch (e) { /* no URL access — storage restore still applies */ }
    if (fromUrl !== null) {
        // Keep the carriers agreeing, so a fresh Cmd+T newtab opened after a
        // view switch also picks the query up.
        writeStorage(fromUrl);
        return fromUrl;
    }
    return "";
}

// Only REWRITE a ?q= the URL already carries (edits after a view switch must
// not leave a stale param to win over storage on reload). Never ADD ?q= to a
// clean URL — on the new-tab page that would surface the raw
// chrome-extension:// URL in the omnibox. Runs for BOTH local edits and
// remote-synced ones: a document left at ?q=Alpha after another view cleared
// the query would otherwise re-seed the dead query on reload/back-forward.
function syncUrlParam(query) {
    try {
        if (new URLSearchParams(window.location.search).has("q")) {
            const url = new URL(window.location.href);
            if (query) {
                url.searchParams.set("q", query);
            } else {
                url.searchParams.delete("q");
            }
            history.replaceState(null, "", url);
        }
    } catch (e) { /* URL not writable — links + storage still carry the query */ }
}

// Call on every query edit. Persists, refreshes an existing ?q= in the address
// bar, and re-decorates the header links.
export function publishSharedQuery(query) {
    publishedLocally = true;
    writeStorage(query);
    syncUrlParam(query);
    decorateViewLinks(query);
}

// Append ?q= to the header view-switch links so clicking one carries the query
// into the next view's document.
export function decorateViewLinks(query) {
    document.querySelectorAll(".view-toggle a[href]").forEach(link => {
        const raw = link.getAttribute("href");
        if (!raw || !raw.includes(".html")) return;
        const path = raw.split("?")[0];
        link.setAttribute("href", query ? `${path}?q=${encodeURIComponent(query)}` : path);
    });
}

// Subscribe to query changes made in OTHER open documents, and receive the
// initial async restore for a fresh document that had no ?q= to seed from.
// Own writes are swallowed via pendingWrites, preserving the old `storage`
// event contract that handlers can't echo.
export function onSharedQueryChange(callback) {
    const area = sessionArea();
    if (!area) return;

    try {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== "session") return;
            if (!(SEARCH_QUERY_STORAGE_KEY in changes)) return;
            const newValue = changes[SEARCH_QUERY_STORAGE_KEY].newValue || "";

            const now = Date.now();
            while (pendingWrites.length && now - pendingWrites[0].t > PENDING_WRITE_TTL_MS) {
                pendingWrites.shift();
            }
            const echoIndex = pendingWrites.findIndex(w => w.value === newValue);
            if (echoIndex !== -1) {
                // Our own write coming back — consume it (and anything queued
                // before it: events deliver in order) and stay silent.
                pendingWrites.splice(0, echoIndex + 1);
                return;
            }
            syncUrlParam(newValue);
            callback(newValue);
        });
    } catch (e) {
        return; // no live sync — the URL carrier still works
    }

    // Async restore (the Cmd+T case): if this document loaded without ?q= and
    // the user hasn't typed yet, deliver the session-stored query through the
    // same callback a remote edit would take.
    let hasUrlQuery = false;
    try {
        hasUrlQuery = new URLSearchParams(window.location.search).get("q") !== null;
    } catch (e) { /* treat as no URL query */ }
    if (hasUrlQuery) return;

    try {
        area.get(SEARCH_QUERY_STORAGE_KEY, (items) => {
            if (chrome.runtime && chrome.runtime.lastError) return;
            const stored = (items && items[SEARCH_QUERY_STORAGE_KEY]) || "";
            if (stored && !publishedLocally) callback(stored);
        });
    } catch (e) { /* no restore — box starts empty */ }
}
