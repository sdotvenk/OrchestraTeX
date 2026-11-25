#!/usr/bin/env python3
"""Generate installer artwork in the Design C (Lux) palette.

Outputs (relative to apps/desktop/src-tauri/):
  dmg-background.png               macOS DMG, 660x400
  installer/nsis-sidebar.bmp       NSIS welcome/finish sidebar, 164x314
  installer/nsis-header.bmp        NSIS inner-page header, 150x57
  installer/wix-banner.bmp         MSI top banner, 493x58
  installer/wix-dialog.bmp         MSI welcome/finish background, 493x312

DMG icon slots match appPosition/applicationFolderPosition in tauri.conf.json.
Requires Pillow.
"""

import os

from PIL import Image, ImageDraw, ImageFont

SCALE = 4  # draw large, downsample for smooth edges

FRAME = (236, 231, 220)  # --bg  #ece7dc
SHEET = (252, 250, 245)  # sheet #fcfaf5
WHITE = (255, 255, 255)
RULE = (220, 212, 196)  # hairline #dcd4c4
INK = (27, 31, 51)  # ink #1b1f33
TANGERINE = (217, 84, 26)  # #d9541a

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TAURI = os.path.join(ROOT, "apps", "desktop", "src-tauri")


def s(v):
    return int(round(v * SCALE))


def font(size):
    for path in (
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
        "C:/Windows/Fonts/segoeui.ttf",
    ):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def canvas(w, h, fill):
    img = Image.new("RGB", (s(w), s(h)), fill)
    return img, ImageDraw.Draw(img)


def finish(img, w, h, path, fmt):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    out = img.resize((w, h), Image.LANCZOS)
    if fmt == "BMP":
        out.convert("RGB").save(path, "BMP")  # 24-bit, as NSIS and WiX expect
    else:
        out.save(path, "PNG", optimize=True)
    print(f"Wrote {os.path.relpath(path, ROOT)}")


def draw_mark(d, cx, cy, width):
    """The OrchestraTeX mark: four staff lines crossed by a tangerine stroke.

    Proportions follow the app icon (lines 136 wide, stroke 14 thick, on a 256 tile).
    """
    k = width / 136.0
    left, right = cx - 68 * k, cx + 68 * k
    bar = 8 * k
    for i in range(4):
        y = cy - 36 * k + i * 24 * k
        d.rounded_rectangle(
            [s(left), s(y - bar / 2), s(right), s(y + bar / 2)], radius=s(1 * k), fill=INK
        )
    x0, y0 = cx - 28 * k, cy - 51 * k
    x1, y1 = cx + 24 * k, cy + 47 * k
    stroke = 14 * k
    d.line([s(x0), s(y0), s(x1), s(y1)], fill=TANGERINE, width=s(stroke))
    for x, y in ((x0, y0), (x1, y1)):
        r = stroke / 2
        d.ellipse([s(x - r), s(y - r), s(x + r), s(y + r)], fill=TANGERINE)


def dmg_background():
    w, h = 660, 400
    app_x, app_y, folder_x, folder_y, slot = 180, 220, 480, 220, 62
    img, d = canvas(w, h, FRAME)
    inset = 16
    d.rounded_rectangle(
        [s(inset), s(inset), s(w - inset), s(h - inset)],
        radius=s(12),
        fill=SHEET,
        outline=RULE,
        width=s(1),
    )
    for cx, cy in ((app_x, app_y), (folder_x, folder_y)):
        d.ellipse([s(cx - slot), s(cy - slot), s(cx + slot), s(cy + slot)], outline=RULE, width=s(1))
    x0, x1 = app_x + slot + 26, folder_x - slot - 26
    d.line([s(x0), s(app_y), s(x1 - 9), s(app_y)], fill=TANGERINE, width=s(2.5))
    d.polygon(
        [(s(x1), s(app_y)), (s(x1 - 12), s(app_y - 7)), (s(x1 - 12), s(app_y + 7))],
        fill=TANGERINE,
    )
    label = "Drag OrchestraTeX to Applications"
    f = font(s(15))
    d.text(((s(w) - d.textlength(label, font=f)) / 2, s(82)), label, font=f, fill=INK)
    finish(img, w, h, os.path.join(TAURI, "dmg-background.png"), "PNG")


def nsis_sidebar():
    # Shown left of the welcome/finish text; the text area to its right is white.
    w, h = 164, 314
    img, d = canvas(w, h, FRAME)
    d.line([s(w - 0.5), 0, s(w - 0.5), s(h)], fill=RULE, width=s(1))
    draw_mark(d, w / 2, 112, 92)
    finish(img, w, h, os.path.join(TAURI, "installer", "nsis-sidebar.bmp"), "BMP")


def nsis_header():
    # Sits at the right of a white header strip, beside the page title.
    w, h = 150, 57
    img, d = canvas(w, h, WHITE)
    draw_mark(d, w - 34, h / 2, 40)
    finish(img, w, h, os.path.join(TAURI, "installer", "nsis-header.bmp"), "BMP")


def wix_banner():
    # Full-width strip; WiX draws the page title and description over its left side.
    w, h = 493, 58
    img, d = canvas(w, h, WHITE)
    draw_mark(d, w - 38, h / 2, 40)
    finish(img, w, h, os.path.join(TAURI, "installer", "wix-banner.bmp"), "BMP")


def wix_dialog():
    # WiX draws welcome text over the area right of x=164, so keep it plain.
    w, h = 493, 312
    img, d = canvas(w, h, WHITE)
    d.rectangle([0, 0, s(164), s(h)], fill=FRAME)
    d.line([s(164), 0, s(164), s(h)], fill=RULE, width=s(1))
    draw_mark(d, 82, 112, 92)
    finish(img, w, h, os.path.join(TAURI, "installer", "wix-dialog.bmp"), "BMP")


if __name__ == "__main__":
    dmg_background()
    nsis_sidebar()
    nsis_header()
    wix_banner()
    wix_dialog()
