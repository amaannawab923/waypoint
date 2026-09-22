#!/usr/bin/env python3
"""Overlay README callouts (pill label + arrow) on raw app screenshots.

Usage:  python3 docs/screenshots/annotate.py            # all shots
        python3 docs/screenshots/annotate.py review     # one shot

Reads `<name>.raw.png`, writes `<name>.png` next to it. Coordinates below
are in the raw screenshot's pixel space (3456x2160 retina captures).
Only Pillow is needed.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent

ACCENT = (224, 83, 47)  # #E0532F
WHITE = (255, 255, 255)
TEXT = (255, 255, 255)

FONT_SIZE = 44
LINE_GAP = 10
PAD_X = 34
PAD_Y = 20
LINE_W = 12
OUTLINE_W = 8
HEAD_LEN = 50
HEAD_HALF = 26


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path, index in (
        ("/System/Library/Fonts/Helvetica.ttc", 1),
        ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 0),
        ("/System/Library/Fonts/Supplemental/Arial.ttf", 0),
    ):
        try:
            return ImageFont.truetype(path, size, index=index)
        except OSError:
            continue
    return ImageFont.load_default()


FONT = load_font(FONT_SIZE)


def wrap(text: str, max_w: int, draw: ImageDraw.ImageDraw) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if draw.textlength(trial, font=FONT) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def pill_box(draw, cx, cy, lines):
    tw = max(draw.textlength(l, font=FONT) for l in lines)
    lh = FONT_SIZE + LINE_GAP
    th = lh * len(lines) - LINE_GAP
    w, h = tw + 2 * PAD_X, th + 2 * PAD_Y
    return (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2), lh


def edge_point(box, target):
    """Point on the pill's boundary in the direction of `target`."""
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    dx, dy = target[0] - cx, target[1] - cy
    if dx == 0 and dy == 0:
        return cx, cy
    hw, hh = (x1 - x0) / 2, (y1 - y0) / 2
    tx = hw / abs(dx) if dx else math.inf
    ty = hh / abs(dy) if dy else math.inf
    t = min(tx, ty)
    return cx + dx * t, cy + dy * t


def arrow(draw, p0, p1):
    (x0, y0), (x1, y1) = p0, p1
    ang = math.atan2(y1 - y0, x1 - x0)
    # Shorten the shaft so it ends inside the head.
    sx, sy = x1 - HEAD_LEN * 0.7 * math.cos(ang), y1 - HEAD_LEN * 0.7 * math.sin(ang)
    head = [
        (x1, y1),
        (
            x1 - HEAD_LEN * math.cos(ang) + HEAD_HALF * math.sin(ang),
            y1 - HEAD_LEN * math.sin(ang) - HEAD_HALF * math.cos(ang),
        ),
        (
            x1 - HEAD_LEN * math.cos(ang) - HEAD_HALF * math.sin(ang),
            y1 - HEAD_LEN * math.sin(ang) + HEAD_HALF * math.cos(ang),
        ),
    ]
    # White halo first, accent on top.
    draw.line([(x0, y0), (sx, sy)], fill=WHITE, width=LINE_W + 2 * OUTLINE_W)
    draw.polygon(head, fill=WHITE, outline=WHITE, width=OUTLINE_W)
    draw.line([(x0, y0), (sx, sy)], fill=ACCENT, width=LINE_W)
    draw.polygon(head, fill=ACCENT)
    draw.ellipse(
        (x0 - LINE_W, y0 - LINE_W, x0 + LINE_W, y0 + LINE_W), fill=ACCENT, outline=WHITE, width=3
    )


def callout(draw, text, at, to, max_w=560):
    lines = wrap(text, max_w, draw)
    box, lh = pill_box(draw, at[0], at[1], lines)
    # Keep the pill inside the frame (margins are narrow on retina shots).
    w_img, h_img = draw.im.size
    dx = min(0, w_img - 24 - box[2]) + max(0, 24 - box[0])
    dy = min(0, h_img - 24 - box[3]) + max(0, 24 - box[1])
    box = (box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy)
    start = edge_point(box, to)
    arrow(draw, start, to)
    r = (box[3] - box[1]) / 2
    draw.rounded_rectangle(box, radius=r, fill=ACCENT, outline=WHITE, width=OUTLINE_W)
    y = box[1] + PAD_Y
    for line in lines:
        tw = draw.textlength(line, font=FONT)
        x = (box[0] + box[2]) / 2 - tw / 2
        draw.text((x, y), line, font=FONT, fill=TEXT)
        y += lh


# name -> list of (label, pill centre, arrow tip[, max text width]). Raw pixel space.
SHOTS: dict[str, list[tuple]] = {
    "hero-session": [
        ("The brief: what the agent was told first", (2500, 600), (1400, 410)),
        ("Verdict chip: fixed", (2450, 200), (1560, 200)),
        ("Every tool call, as a row", (2450, 890), (1560, 890)),
        ("It walks the repro steps and screenshots each one", (2500, 1780), (1985, 1830)),
        ("Message any run, any status. Never locked.", (2750, 1948), (1995, 1948)),
        ("Read-only or may edit files: your call", (2450, 2118), (1560, 2050)),
    ],
    "review": [
        ("Comment + state change, one card", (800, 290), (1200, 290)),
        ("Every card says why it exists", (800, 520), (1200, 370)),
        ("Competing fixes are named; approving one supersedes the rest", (3140, 340), (2835, 195)),
        ("Todo to In Review, the state your board really has", (3140, 1560), (1620, 1568)),
        ("Every Jira write waits for you", (3140, 1900), (2810, 1780)),
    ],
    "my-jira": [
        ("Core fields on top", (2850, 640), (2950, 432)),
        ("Investigate or Fix, straight from the issue", (1500, 985), (2760, 1082)),
        ("Every session on this issue, with its status", (1500, 1280), (2130, 1280)),
        ("The session's report, posted as a PM-grade comment", (1420, 1900), (2120, 1900)),
    ],
    "copilot": [
        ("Answers from your real Jira: dashboards, JQL, issues", (2120, 840), (2590, 745)),
        ("Shows its work: the JQL it ran", (1900, 1730), (2620, 1900)),
    ],
    "brief-preview": [
        ("Read and edit the brief before anything runs", (2850, 810), (2325, 865)),
        ("Fresh worktree from the base branch you pick", (600, 480), (1125, 525)),
        ("Plan mode reads and reports, changes nothing", (600, 760), (1125, 592)),
        ("Nothing starts until you press this", (2850, 1385), (2325, 1248)),
    ],
    "this-machine": [
        ("Honest about what leaves your laptop", (3080, 380), (2690, 415)),
        ("Prompts go to Anthropic on your own subscription. Nothing else.", (3080, 860), (2650, 812)),
        ("Real Claude Code detection, with a real 'not found' state", (900, 1180), (1310, 1260)),
        ("No cloud backend: the engine runs here", (3080, 1560), (2690, 1586)),
    ],
    "verdicts": [
        ("Not a bug: proposes closing the issue, never Done", (2380, 145), (1665, 200), 1100),
        ("A verdict in one word", (2330, 463), (1520, 463)),
        ("Summary for the board, details stay on the run", (2200, 897), (1385, 897), 1100),
    ],
    "tracker": [
        ("Link a repo; sessions know where the code lives", (1900, 138), (1275, 138)),
        ("The native tracker is still here: list, board, calendar, sheet, Gantt", (1660, 335), (1275, 242), 760),
    ],
}


def render(name: str) -> Path:
    src = HERE / f"{name}.raw.png"
    out = HERE / f"{name}.png"
    img = Image.open(src).convert("RGB")
    draw = ImageDraw.Draw(img)
    for label, at, to, *rest in SHOTS[name]:
        callout(draw, label, at, to, *rest)
    img.save(out, optimize=True)
    return out


if __name__ == "__main__":
    names = sys.argv[1:] or list(SHOTS)
    for n in names:
        print(render(n))
