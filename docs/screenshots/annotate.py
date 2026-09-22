#!/usr/bin/env python3
"""Overlay README callouts on raw app screenshots: the shot on a soft canvas,
numbered white cards with a thin leader to a ring on the element.

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

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent

# One restrained accent for every mark, a white card for every label. The
# app itself is monochrome, so the annotation reads as a layer laid over a
# product shot, not as part of the UI.
ACCENT = (59, 91, 219)  # #3B5BDB
INK = (31, 35, 40)
CARD = (255, 255, 255)
CARD_EDGE = (0, 0, 0, 28)
CANVAS_TOP = (247, 247, 245)
CANVAS_BOTTOM = (232, 232, 229)

PAD = 96  # canvas margin around the shot
CORNER = 28
FONT_SIZE = 30
NUM_SIZE = 26
LINE_GAP = 8
PAD_X = 28
PAD_Y = 22
BADGE_R = 24
DOT_R = 9
LEAD_W = 3


def load_font(size: int, bold: bool) -> ImageFont.FreeTypeFont:
    for path, index in (
        ("/System/Library/Fonts/Helvetica.ttc", 1 if bold else 0),
        ("/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf", 0),
    ):
        try:
            return ImageFont.truetype(path, size, index=index)
        except OSError:
            continue
    return ImageFont.load_default()


FONT = load_font(FONT_SIZE, bold=False)
NUM_FONT = load_font(NUM_SIZE, bold=True)


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


def framed(shot: Image.Image) -> Image.Image:
    """The shot on a soft canvas: rounded corners, hairline edge, diffuse shadow."""
    w, h = shot.size
    W, H = w + 2 * PAD, h + 2 * PAD
    canvas = Image.new("RGB", (W, H), CANVAS_TOP)
    grad = Image.linear_gradient("L").resize((1, H))
    top, bottom = Image.new("RGB", (W, H), CANVAS_TOP), Image.new("RGB", (W, H), CANVAS_BOTTOM)
    canvas = Image.composite(bottom, top, grad.resize((W, H)))
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((PAD, PAD + 18, PAD + w, PAD + h + 18), CORNER, fill=(20, 22, 30, 70))
    shadow = shadow.filter(ImageFilter.GaussianBlur(36))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow)
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), CORNER, fill=255)
    canvas.paste(shot, (PAD, PAD), mask)
    ImageDraw.Draw(canvas).rounded_rectangle((PAD, PAD, PAD + w - 1, PAD + h - 1), CORNER, outline=(0, 0, 0, 40), width=2)
    return canvas


def card_box(draw, cx, cy, lines):
    tw = max(draw.textlength(l, font=FONT) for l in lines)
    lh = FONT_SIZE + LINE_GAP
    th = lh * len(lines) - LINE_GAP
    w = tw + 2 * PAD_X + 2 * BADGE_R + 18
    h = max(th + 2 * PAD_Y, 2 * BADGE_R + 2 * PAD_Y - 8)
    return (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2), lh


def edge_point(box, target):
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


def leader(draw, p0, p1):
    """A thin line from the card to a small dot at the element's edge; no arrowhead."""
    (x0, y0), (x1, y1) = p0, p1
    draw.line([(x0, y0), (x1, y1)], fill=(255, 255, 255, 230), width=LEAD_W + 4)
    draw.line([(x0, y0), (x1, y1)], fill=ACCENT + (255,), width=LEAD_W)
    r = DOT_R
    draw.ellipse((x1 - r - 3, y1 - r - 3, x1 + r + 3, y1 + r + 3), fill=(255, 255, 255, 240))
    draw.ellipse((x1 - r, y1 - r, x1 + r, y1 + r), fill=ACCENT + (255,))


def callout(img: Image.Image, n: int, text: str, at, to, max_w=520):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    lines = wrap(text, max_w, draw)
    box, lh = card_box(draw, at[0], at[1], lines)
    w_img, h_img = img.size
    dx = min(0, w_img - 24 - box[2]) + max(0, 24 - box[0])
    dy = min(0, h_img - 24 - box[3]) + max(0, 24 - box[1])
    box = (box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy)
    leader(draw, edge_point(box, to), to)
    # Card shadow, then the card, then the numbered badge and the text.
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((box[0], box[1] + 10, box[2], box[3] + 10), 18, fill=(20, 22, 30, 60))
    layer = Image.alpha_composite(layer, shadow.filter(ImageFilter.GaussianBlur(14)))
    draw = ImageDraw.Draw(layer)
    draw.rounded_rectangle(box, radius=18, fill=CARD + (250,), outline=CARD_EDGE, width=2)
    bx, by = box[0] + PAD_X, (box[1] + box[3]) / 2
    draw.ellipse((bx, by - BADGE_R, bx + 2 * BADGE_R, by + BADGE_R), fill=ACCENT + (255,))
    num = str(n)
    nw = draw.textlength(num, font=NUM_FONT)
    draw.text((bx + BADGE_R - nw / 2, by - NUM_SIZE / 2 - 3), num, font=NUM_FONT, fill=(255, 255, 255, 255))
    x = bx + 2 * BADGE_R + 18
    y = (box[1] + box[3]) / 2 - (lh * len(lines) - LINE_GAP) / 2 - 2
    for line in lines:
        draw.text((x, y), line, font=FONT, fill=INK + (255,))
        y += lh
    return Image.alpha_composite(img, layer)


# name -> list of (label, pill centre, arrow tip[, max text width]). Raw pixel space.
SHOTS: dict[str, list[tuple]] = {
    "hero-session": [
        ("Verdict chip: fixed", (2300, 200), (1565, 200)),
        ("The brief: what the agent was told first", (2560, 560), (2010, 403)),
        ("Every tool call, as a row", (2400, 890), (1560, 890)),
        ("It walks the repro steps and screenshots each one", (2500, 1760), (1985, 1830)),
        ("Message any run, any status. Never locked.", (2750, 1948), (1995, 1948)),
        ("Read-only or may edit files: your call", (1250, 2118), (1592, 2020)),
    ],
    "review": [
        ("Competing fixes are named; approving one supersedes the rest", (3100, 250), (2000, 242)),
        ("Comment + state change, one card", (812, 340), (1192, 339)),
        ("Every card says why it exists", (812, 470), (1192, 418)),
        ("Todo to In Review, the state your board really has", (3100, 1616), (1615, 1616)),
        ("Every Jira write waits for you", (3100, 1990), (2743, 1856)),
    ],
    "my-jira": [
        ("Core fields on top", (1600, 375), (2068, 375)),
        ("Investigate or Fix, straight from the issue", (1600, 1000), (2758, 1073)),
        ("Every session on this issue, with its status", (1600, 1300), (2128, 1187)),
        ("The session's report, posted as a PM-grade comment", (1600, 1894), (2118, 1894)),
    ],
    "copilot": [
        ("Answers from your real Jira: dashboards, JQL, issues", (1900, 1000), (2610, 1000)),
        ("Shows its work: the JQL it ran", (1900, 1950), (2612, 1950)),
    ],
    "brief-preview": [
        ("Fresh worktree from the base branch you pick", (560, 526), (1094, 526)),
        ("Plan mode reads and reports, changes nothing", (560, 690), (1094, 590)),
        ("Read and edit the brief before anything runs", (2900, 930), (2330, 930)),
        ("Nothing starts until you press this", (2900, 1246), (2332, 1246)),
    ],
    "this-machine": [
        ("Honest about what leaves your laptop", (3080, 382), (2690, 382)),
        ("Prompts go to Anthropic on your own subscription. Nothing else.", (3080, 813), (2690, 813)),
        ("Real Claude Code detection, with a real 'not found' state", (760, 1260), (1274, 1260)),
        ("No cloud backend: the engine runs here", (3080, 1586), (2690, 1586)),
    ],
    "verdicts": [
        ("Not a bug: proposes closing the issue, never Done", (2400, 200), (1662, 200), 1100),
        ("A verdict in one word", (2100, 578), (1512, 578)),
        ("Summary for the board, details stay on the run", (2200, 1017), (1382, 1017), 1100),
    ],
    "tracker": [
        ("Link a repo; sessions know where the code lives", (1950, 138), (1275, 138)),
        ("The native tracker is still here: list, board, calendar, sheet, Gantt", (2350, 238), (1290, 238), 760),
    ],
}


def render(name: str) -> Path:
    src = HERE / f"{name}.raw.png"
    out = HERE / f"{name}.png"
    img = framed(Image.open(src).convert("RGB"))
    for n, (label, at, to, *rest) in enumerate(SHOTS[name], start=1):
        shift = lambda p: (p[0] + PAD, p[1] + PAD)
        img = callout(img, n, label, shift(at), shift(to), *rest)
    img.convert("RGB").save(out, optimize=True)
    return out


if __name__ == "__main__":
    names = sys.argv[1:] or list(SHOTS)
    for n in names:
        print(render(n))
