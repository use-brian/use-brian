#!/usr/bin/env python3
"""Regenerate the macOS packaging artwork in this directory.

Produces, from `icon.original.png` (the flat 512px brand mark):

  icon.png            1024px rounded-squircle app icon (+ subtle cyan rim light)
  background.png      660x420  install-window backdrop (1x)
  background@2x.png   1320x840 install-window backdrop (2x)
  background.tiff     HiDPI bundle of the two, used by electron-builder

The DMG window layout (size + icon positions) is configured in
`../electron-builder.yml` under `dmg:` and must stay in sync with the backdrop:
the brand glow / arrow are drawn around icon centres (175,240) and (485,240) in a
660x420 window.

Requires: Pillow, numpy, and macOS `tiffutil` (for the HiDPI .tiff).
Run:      python3 build/make-dmg-art.py [--preview]
          --preview also writes /tmp/dmg_preview.png (a faux install window).
"""
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.abspath(__file__))

NAVY_T = (10, 17, 32)   # backdrop gradient: top
NAVY_B = (4, 7, 14)     # backdrop gradient: bottom
CYAN = (0, 229, 255)    # brand accent (sampled from the mark)
WORD = (234, 248, 253)  # wordmark
MUTE = (146, 174, 196)  # tagline
FOOT = (84, 106, 128)   # footer

SFR = "/System/Library/Fonts/SFNSRounded.ttf"
ARB = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
ART = "/System/Library/Fonts/Supplemental/Arial.ttf"
# (path, ttc-index, variation-name). Apple's variable SF fonts report a bbox even
# when they rasterise blank, so pick_font() verifies real ink and falls back.
BOLD_CANDS = [(SFR, 0, "Bold"), (ARB,), (SFR, 0, "Semibold")]
SEMI_CANDS = [(SFR, 0, "Semibold"), (ARB,)]
REG_CANDS = [(SFR, 0, "Regular"), (ART,)]


def _ink(font):
    im = Image.new("L", (380, 96), 0)
    ImageDraw.Draw(im).text((4, 4), "Sidanclaw", font=font, fill=255)
    return int(np.asarray(im).astype(bool).sum())


def pick_font(cands, size):
    for spec in cands:
        path = spec[0]
        idx = spec[1] if len(spec) > 1 else 0
        var = spec[2] if len(spec) > 2 else None
        if not os.path.exists(path):
            continue
        try:
            font = ImageFont.truetype(path, size, index=idx)
        except Exception:
            continue
        if var:
            try:
                font.set_variation_by_name(var)
            except Exception:
                pass
        if _ink(font) > 200:
            return font
    return ImageFont.load_default()


def vgrad(w, h, top, bot):
    t = np.linspace(0, 1, h)[:, None]
    arr = np.zeros((h, w, 3), np.float32)
    for i in range(3):
        arr[..., i] = top[i] * (1 - t) + bot[i] * t
    a = np.empty((h, w, 4), np.uint8)
    a[..., :3] = arr.astype(np.uint8)
    a[..., 3] = 255
    return Image.fromarray(a, "RGBA")


def radial(w, h, cx, cy, radius, color, max_alpha, power=2.0):
    yy, xx = np.ogrid[0:h, 0:w]
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / radius
    a = np.clip(1 - dist, 0, 1) ** power
    layer = np.zeros((h, w, 4), np.uint8)
    layer[..., 0], layer[..., 1], layer[..., 2] = color
    layer[..., 3] = (a * max_alpha).astype(np.uint8)
    return Image.fromarray(layer, "RGBA")


def build_icon():
    src = Image.open(os.path.join(ROOT, "icon.original.png")).convert("RGBA")
    size = 1024
    base = src.resize((size, size), Image.NEAREST)  # crisp pixel upscale
    radius = round(0.2237 * size)                   # macOS squircle proportion
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    rim = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(rim).rounded_rectangle(
        [2, 2, size - 3, size - 3], radius=radius - 2, outline=(*CYAN, 38), width=3)
    out.alpha_composite(rim)
    out.save(os.path.join(ROOT, "icon.png"))
    print("icon.png  (1024, rounded squircle + rim light)")


def build_bg(scale):
    w, h = 660 * scale, 420 * scale
    img = vgrad(w, h, NAVY_T, NAVY_B)
    img.alpha_composite(radial(w, h, 175 * scale, 250 * scale, 250 * scale, CYAN, 48))
    img.alpha_composite(radial(w, h, 330 * scale, 64 * scale, 320 * scale, CYAN, 18))
    img.alpha_composite(radial(w, h, 485 * scale, 250 * scale, 150 * scale, (90, 150, 200), 20))

    grid = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    step = 22 * scale
    for x in range(0, w, step):
        gd.line([(x, 0), (x, h)], fill=(*CYAN, 5), width=1)
    for y in range(0, h, step):
        gd.line([(0, y), (w, y)], fill=(*CYAN, 5), width=1)
    img.alpha_composite(grid)

    # Legibility plates behind the two Finder-drawn icon labels ("sidanclaw" /
    # "Applications"). Finder owns the label color — it follows the *viewer's*
    # Light/Dark appearance, so a DMG can't force white — but each plate's
    # luminance is tuned so BOTH near-black (Light mode) and white (Dark mode)
    # labels keep >=3:1 contrast. Centres track the icon centres in
    # electron-builder.yml (175,240)/(485,240). The plate y (320) sits under where
    # real Finder draws the label below the icon (bottom 300) — a touch lower than
    # a naive icon-bottom guess, leaving a small gap so the plate hugs the text.
    lf = pick_font(REG_CANDS, 13 * scale)
    plate = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    pd = ImageDraw.Draw(plate)
    for cxu, label in ((175, "sidanclaw"), (485, "Applications")):
        tw = pd.textlength(label, font=lf)
        pw, ph = tw + 30 * scale, 25 * scale
        px, py = cxu * scale, 320 * scale
        pbox = [px - pw / 2, py - ph / 2, px + pw / 2, py + ph / 2]
        pd.rounded_rectangle(pbox, radius=ph / 2, fill=(126, 144, 162, 236),
                             outline=(196, 212, 226, 64), width=max(1, scale))
    img.alpha_composite(plate)

    cx, cy = 330 * scale, 232 * scale
    cell, gap = 11 * scale, 2 * scale
    # Right-pointing arrow. The shaft runs solid across the centre line (c=-3..3,
    # r=0) — including the (2, 0) cell that closes the gap in front of the tip —
    # and the diamond head fans out at c=1/2.
    cells = [(-3, 0), (-2, 0), (-1, 0), (0, 0), (1, 0), (2, 0), (3, 0),
             (1, -2), (1, -1), (1, 1), (1, 2), (2, -1), (2, 1)]

    def draw_cells(dr, col):
        # Square pixels (sharp corners) so the arrow matches the app mark's
        # pixel-art style — the mark itself is a NEAREST upscale of crisp pixels.
        for c, r in cells:
            x0 = cx + c * (cell + gap) - cell / 2
            y0 = cy + r * (cell + gap) - cell / 2
            dr.rectangle([x0, y0, x0 + cell, y0 + cell], fill=col)

    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw_cells(ImageDraw.Draw(glow), (*CYAN, 150))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(7 * scale)))

    d = ImageDraw.Draw(img)  # NB: create the draw handle AFTER all alpha_composite
    draw_cells(d, (*CYAN, 255))

    wf = pick_font(BOLD_CANDS, 42 * scale)
    text, tracking = "sidanclaw", 2 * scale
    widths = [d.textlength(ch, font=wf) for ch in text]
    tw = sum(widths) + tracking * (len(text) - 1)
    mark_h = int(42 * scale * 1.16)
    mark = Image.open(os.path.join(ROOT, "icon.png")).resize((mark_h, mark_h), Image.LANCZOS)
    gapm = 14 * scale
    gx = (w - (mark_h + gapm + tw)) / 2
    cyt = 62 * scale
    img.alpha_composite(mark, (int(gx), int(cyt - mark_h / 2)))
    x = gx + mark_h + gapm
    for ch, wd in zip(text, widths):
        d.text((x, cyt), ch, font=wf, fill=WORD, anchor="lm")
        x += wd + tracking

    tf = pick_font(REG_CANDS, 15 * scale)
    d.text((w / 2, 104 * scale), "Drag the app into your Applications folder",
           font=tf, fill=MUTE, anchor="mm")
    ff = pick_font(REG_CANDS, 11 * scale)
    d.text((w - 16 * scale, h - 14 * scale), "sidan.ai", font=ff, fill=FOOT, anchor="rm")
    return img.convert("RGB")


def build_backgrounds():
    build_bg(1).save(os.path.join(ROOT, "background.png"))
    build_bg(2).save(os.path.join(ROOT, "background@2x.png"))
    subprocess.run(
        ["tiffutil", "-cathidpicheck",
         os.path.join(ROOT, "background.png"),
         os.path.join(ROOT, "background@2x.png"),
         "-out", os.path.join(ROOT, "background.tiff")],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("background.png + background@2x.png + background.tiff (HiDPI)")


def build_preview():
    s = 2
    bg = build_bg(s)
    w, h = bg.size
    bar = 52 * s
    canvas = Image.new("RGBA", (w, h + bar), (0, 0, 0, 0))
    canvas.paste(vgrad(w, bar, (242, 242, 242), (224, 224, 224)).convert("RGBA"), (0, 0))
    cd = ImageDraw.Draw(canvas)
    for i, col in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        x, y = (20 + i * 20) * s, bar // 2
        cd.ellipse([x - 6 * s, y - 6 * s, x + 6 * s, y + 6 * s], fill=col)
    tbf = pick_font(SEMI_CANDS, 14 * s)
    mark = Image.open(os.path.join(ROOT, "icon.png")).resize((20 * s, 20 * s), Image.LANCZOS)
    title = "Install sidanclaw"
    tw = cd.textbbox((0, 0), title, font=tbf)[2]
    gx = (w - (mark.width + 8 * s + tw)) // 2
    canvas.alpha_composite(mark, (gx, bar // 2 - mark.height // 2))
    cd.text((gx + mark.width + 8 * s, bar // 2), title, font=tbf, fill=(55, 55, 55), anchor="lm")
    canvas.paste(bg, (0, bar))
    apps_path = "/tmp/appsfolder.png"

    def place(icon, cxu, label):
        cx, cy = cxu * s, 240 * s + bar
        ic = icon.resize((120 * s, 120 * s), Image.LANCZOS)
        canvas.alpha_composite(ic, (cx - ic.width // 2, cy - ic.height // 2))
        lf = pick_font(REG_CANDS, 14 * s)
        cd.text((cx + 1, cy + 80 * s + 1), label, font=lf, fill=(0, 0, 0), anchor="mm")
        cd.text((cx, cy + 80 * s), label, font=lf, fill=(236, 240, 245), anchor="mm")

    app = Image.open(os.path.join(ROOT, "icon.png"))
    apps = Image.open(apps_path).convert("RGBA") if os.path.exists(apps_path) else app
    place(app, 175, "sidanclaw")
    place(apps, 485, "Applications")
    canvas.save("/tmp/dmg_preview.png")
    print("/tmp/dmg_preview.png")


if __name__ == "__main__":
    build_icon()
    build_backgrounds()
    if "--preview" in sys.argv:
        build_preview()
    print("DONE")
