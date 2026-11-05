"""Simulate a history recall set: top-K most-visited U top-K most-recent pages.

For every local top-level navigation in Chrome's History DB, ask whether the
destination page was in the candidate set built from visits *before* it.
Prints aggregate coverage only -- no URLs, titles or domains leave this script.

Usage:
  cp "$HOME/Library/Application Support/Google/Chrome/Default/History" /tmp/History-copy
  GRAIN=page MIN_DWELL_MS=2000 python3 -I scripts/simulate-history-recall.py /tmp/History-copy [warmup_days] [eval_from_unix]

GRAIN=domain scores host identity instead of page. MIN_DWELL_MS drops visits
shorter than the study's qualification dwell (2000 ms in background.js).
Copy the DB first: Chrome holds a lock on the live file. Synced visits from
other devices are excluded. Columns per K: most-visited / most-recent / union
coverage, as a percent of scored navigations; "seen" is the ceiling (page was
visited at least once before).
"""
import sqlite3, sys
from collections import defaultdict

EPOCH_DELTA_S = 11644473600  # 1601-01-01 -> 1970-01-01
CORE_MASK = 0xFF
CHAIN_END = 0x20000000
# Core transition types (ui::PageTransition)
LINK, TYPED, AUTO_BOOKMARK, AUTO_SUBFRAME, MANUAL_SUBFRAME, GENERATED, AUTO_TOPLEVEL, FORM_SUBMIT, RELOAD, KEYWORD, KEYWORD_GENERATED = range(11)
TYPE_NAMES = {LINK: "link", TYPED: "typed", AUTO_BOOKMARK: "bookmark", GENERATED: "omnibox-search",
              AUTO_TOPLEVEL: "auto-toplevel", FORM_SUBMIT: "form", KEYWORD: "keyword", KEYWORD_GENERATED: "keyword"}
KS = [20, 50, 100, 200, 500]


class Fenwick:
    def __init__(self, n):
        self.n = n; self.t = [0] * (n + 1)
    def add(self, i, v):
        i += 1
        while i <= self.n:
            self.t[i] += v; i += i & -i
    def prefix(self, i):  # sum of [0, i)
        s = 0
        while i > 0:
            s += self.t[i]; i -= i & -i
        return s


import os
from urllib.parse import urlsplit
GRAIN = os.environ.get("GRAIN", "page")          # page | domain
MIN_DWELL_US = int(os.environ.get("MIN_DWELL_MS", "0")) * 1000


def page_identity(url):
    # Mirrors revisit-model.js normalizeIdentity: drop the fragment, lowercase host, strip www.
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    host = host[4:] if host.startswith("www.") else host
    if GRAIN == "domain":
        return host
    return f"{parts.scheme}://{host}{':' + str(parts.port) if parts.port else ''}{parts.path or '/'}{'?' + parts.query if parts.query else ''}"


def main():
    db = sys.argv[1]
    warmup_days = float(sys.argv[2]) if len(sys.argv) > 2 else 14
    eval_from = float(sys.argv[3]) if len(sys.argv) > 3 else None
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    rows = c.execute("""
        select v.visit_time, u.url, v.transition, v.visit_duration
        from visits v join urls u on u.id = v.url
        left join visit_source s on s.id = v.id
        where s.id is null                -- locally browsed only (synced visits carry a visit_source row)
        order by v.visit_time, v.id""").fetchall()

    nav = []
    for t, url, tr, dur in rows:
        if MIN_DWELL_US and (dur or 0) < MIN_DWELL_US:
            continue
        core = tr & CORE_MASK
        if core in (AUTO_SUBFRAME, MANUAL_SUBFRAME, RELOAD):
            continue
        if not (tr & CHAIN_END):  # keep only the final page of a redirect chain
            continue
        if not url.startswith(("http://", "https://")):
            continue
        nav.append((t / 1e6 - EPOCH_DELTA_S, page_identity(url), core))
    if not nav:
        print("no navigations"); return

    start = nav[0][0]
    eval_start = eval_from if eval_from is not None else start + warmup_days * 86400
    n = len(nav)
    bit = Fenwick(n)
    last_idx = {}
    count = defaultdict(int)
    freq = defaultdict(int)  # count value -> number of pages with that count
    max_count = 0

    stats = defaultdict(lambda: {"n": 0, "seen": 0, **{f"mv{k}": 0 for k in KS}, **{f"mr{k}": 0 for k in KS}, **{f"u{k}": 0 for k in KS}})
    prev_page = None
    for i, (ts, page, core) in enumerate(nav):
        if ts >= eval_start and page != prev_page:  # a same-page repeat is not a destination choice
            for group in ("all", TYPE_NAMES.get(core, "other")):
                st = stats[group]
                st["n"] += 1
                if page in count:
                    st["seen"] += 1
                    c_here = count[page]
                    # pages strictly more visited than this one (tie-inclusive top-K)
                    above = sum(freq[v] for v in range(c_here + 1, max_count + 1))
                    # distinct pages visited more recently than this page's last visit
                    newer = bit.prefix(i) - bit.prefix(last_idx[page] + 1)
                    for k in KS:
                        mv = above < k; mr = newer < k
                        st[f"mv{k}"] += mv; st[f"mr{k}"] += mr; st[f"u{k}"] += (mv or mr)
        # update state with this visit
        if page in last_idx:
            bit.add(last_idx[page], -1)
            freq[count[page]] -= 1
        bit.add(i, 1)
        last_idx[page] = i
        count[page] += 1
        freq[count[page]] += 1
        max_count = max(max_count, count[page])
        prev_page = page

    import datetime as dt
    fmt = lambda s: dt.datetime.fromtimestamp(s, dt.timezone.utc).strftime("%Y-%m-%d")
    print(f"grain {GRAIN} min-dwell {MIN_DWELL_US//1000}ms; navigations {n} ({fmt(start)} -> {fmt(nav[-1][0])}), scored from {fmt(eval_start)}; distinct pages {len(count)}")
    print(f"{'group':15} {'n':>6} {'seen':>6}  " + "  ".join(f"K={k}: mv/mr/union" for k in KS))
    order = ["all", "link", "typed", "omnibox-search", "keyword", "bookmark", "form", "auto-toplevel", "other"]
    for g in order:
        if g not in stats: continue
        st = stats[g]; m = st["n"] or 1
        cells = "  ".join(f"{100*st[f'mv{k}']/m:5.1f}/{100*st[f'mr{k}']/m:5.1f}/{100*st[f'u{k}']/m:5.1f}" for k in KS)
        print(f"{g:15} {st['n']:6d} {100*st['seen']/m:5.1f}%  {cells}")


main()
