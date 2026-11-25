#!/usr/bin/env python3
"""Generate the macOS DMG background in the Design C (Lux) palette.

Writes apps/desktop/src-tauri/dmg-background.png. Icon slots match the
appPosition/applicationFolderPosition values in tauri.conf.json.
"""

import os

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 660, 400
SCALE = 4  # draw large, downsample for smooth edges

FRAME = (236, 231, 220)  # --bg  #ece7dc
SHEET = (252, 250, 245)  # sheet #fcfaf5
RULE = (220, 212, 196)  # hairline #dcd4c4
INK = (27, 31, 51)  # ink #1b1f33
MUTED = (110, 106, 98)
TANGERINE = (217, 84, 26)  # #d9541a

APP_X, APP_Y = 180, 220
FOLDER_X, FOLDER_Y = 480, 220
SLOT_RADIUS = 62


def font(size):
    for path in (
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def s(v):
    return int(round(v * SCALE))


def generate(output_path):
    img = Image.new("RGB", (s(WIDTH), s(HEIGHT)), FRAME)
    d = ImageDraw.Draw(img)

    # Inset sheet with a hairline rule.
    inset = 16
    d.rounded_rectangle(
        [s(inset), s(inset), s(WIDTH - inset), s(HEIGHT - inset)],
        radius=s(12),
        fill=SHEET,
        outline=RULE,
        width=s(1),
    )

    # Soft icon slots.
    for cx, cy in ((APP_X, APP_Y), (FOLDER_X, FOLDER_Y)):
        d.ellipse(
            [s(cx - SLOT_RADIUS), s(cy - SLOT_RADIUS), s(cx + SLOT_RADIUS), s(cy + SLOT_RADIUS)],
            outline=RULE,
            width=s(1),
        )

    # Arrow between the slots.
    y = APP_Y
    x0, x1 = APP_X + SLOT_RADIUS + 26, FOLDER_X - SLOT_RADIUS - 26
    d.line([s(x0), s(y), s(x1 - 9), s(y)], fill=TANGERINE, width=s(2.5))
    d.polygon(
        [(s(x1), s(y)), (s(x1 - 12), s(y - 7)), (s(x1 - 12), s(y + 7))],
        fill=TANGERINE,
    )

    # Instruction.
    label = "Drag OrchestraTeX to Applications"
    f = font(s(15))
    w = d.textlength(label, font=f)
    d.text(((s(WIDTH) - w) / 2, s(82)), label, font=f, fill=INK)

    out = img.resize((WIDTH, HEIGHT), Image.LANCZOS)
    out.save(output_path, "PNG", optimize=True)
    print(f"Wrote {output_path}")


if __name__ == "__main__":
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    generate(os.path.join(root, "apps", "desktop", "src-tauri", "dmg-background.png"))
