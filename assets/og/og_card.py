#!/usr/bin/env python3
"""tabtopia OG card — deterministic SVG generator (muriel pipeline).

The card's one idea: tabs ranked by attention, not tab order. Rendered as an
"activation skyline" — tab-shaped bars, height = engagement, descending in
rank like ACT-R base-level activation. The focused tab burns orange; the rest
recede in stepped blues (never text, so stepped fills are fine).

Render:  python3 og_card.py           -> og.svg
Capture: node capture.mjs             -> og.png (1200x630 @2x = 2400x1260)
Audit:   PYTHONPATH=~/Documents/dev/muriel python3 -m muriel.contrast og.svg

All text roles computed >= 8:1 vs BG (muriel.contrast):
  cream #eae6d8 14.8 | orange #f09a52 8.3 | blue #64b5f6 8.4 | muted #b8b0a0 8.6
"""

W, H = 1200, 630
BG = "#16130f"        # warm near-black (brand icon's dark family, not pure #000)
CREAM = "#eae6d8"     # headline
ORANGE = "#f09a52"    # accent text (8.3:1); richer #e8873f reserved for fills
ORANGE_FILL = "#e8873f"
BLUE = "#64b5f6"      # extension's own Material blue
MUTED = "#b8b0a0"     # sub/footer text (8.6:1)
LINE = "#57534b"      # decorative only (2.4:1 — never text)

SANS = "Avenir Next, Avenir, sans-serif"
MONO = "Menlo, monospace"

# Engagement skyline: rank-ordered dwell, non-round values (anti-slop).
# (height px, label, labelled?)
BARS = [
    (238, "14m 12s", True),
    (168, "6m 40s", True),
    (128, "3m 05s", True),
    (100, "1m 58s", True),
    (76, "47s", True),
    (58, "", False),
    (44, "", False),
    (33, "", False),
    (25, "", False),
]
# Stepped blue fills, rank 2..9 (decorative; darkest still >= 55/255 on a channel)
BLUES = ["#64b5f6", "#57a3dd", "#4a8fc4", "#3e7cab", "#326992", "#2a577a", "#234763", "#1d3a52"]

def tab_path(x, y_base, w, h, r=9):
    """Browser-tab silhouette: rounded top corners, square base."""
    return (f"M {x} {y_base} L {x} {y_base - h + r} "
            f"Q {x} {y_base - h} {x + r} {y_base - h} "
            f"L {x + w - r} {y_base - h} "
            f"Q {x + w} {y_base - h} {x + w} {y_base - h + r} "
            f"L {x + w} {y_base} Z")

s = []
s.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
s.append(f'<rect width="{W}" height="{H}" fill="{BG}"/>')

MX = 72  # left/right margin

# --- Headline: the moat line, two beats ---
s.append(f'<text x="{MX}" y="128" font-family="{SANS}" font-size="58" font-weight="700" fill="{CREAM}">Anything can list tabs.</text>')
s.append(f'<text x="{MX}" y="196" font-family="{SANS}" font-size="58" font-weight="700" fill="{CREAM}">tabtopia ranks them by <tspan fill="{ORANGE}">attention</tspan>.</text>')

# --- Sub ---
s.append(f'<text x="{MX}" y="248" font-family="{SANS}" font-size="25" font-weight="500" fill="{MUTED}">An MCP for your agent — it sees the tab you\'re actually reading, not just a list of URLs.</text>')

# --- Activation skyline ---
BASE = 528
bw, gap = 92, 28
total = len(BARS) * bw + (len(BARS) - 1) * gap
x0 = (W - total) / 2
for i, (h, label, labelled) in enumerate(BARS):
    x = x0 + i * (bw + gap)
    fill = ORANGE_FILL if i == 0 else BLUES[i - 1]
    s.append(f'<path d="{tab_path(x, BASE, bw, h)}" fill="{fill}"/>')
    # favicon dot near the tab top (decorative; gray stays visible on the
    # darkest fills where a BG-colored dot vanishes)
    dot = CREAM if i == 0 else LINE
    s.append(f'<circle cx="{x + 20}" cy="{BASE - h + 20}" r="7" fill="{dot}"/>')
    if labelled:
        lf = ORANGE if i == 0 else MUTED
        wt = 700 if i == 0 else 500
        s.append(f'<text x="{x + bw / 2}" y="{BASE - h - 14}" text-anchor="middle" '
                 f'font-family="{MONO}" font-size="18" font-weight="{wt}" fill="{lf}">{label}</text>')
# baseline
s.append(f'<rect x="{MX - 8}" y="{BASE}" width="{W - 2 * (MX - 8)}" height="2" fill="{LINE}"/>')

# --- Footer ---
s.append(f'<text x="{MX}" y="590" font-family="{SANS}" font-size="27" font-weight="700" fill="{CREAM}">tabtopia'
         f'<tspan font-size="21" font-weight="500" fill="{MUTED}">   live browser context for your agent</tspan></text>')
s.append(f'<text x="{W - MX}" y="590" text-anchor="end" font-family="{MONO}" font-size="19" font-weight="500" fill="{MUTED}">github.com/andyed/tabtopia</text>')

s.append('</svg>')

import pathlib
out = pathlib.Path(__file__).parent / "og.svg"
out.write_text("\n".join(s))
print(f"wrote {out} ({W}x{H})")
