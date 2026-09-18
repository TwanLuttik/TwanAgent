#!/usr/bin/env python3
"""Render the TwanAgent dock icon to a 1024×1024 PNG."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
RADIUS = int(SIZE * 0.2237)
OUT = Path(__file__).resolve().parents[1] / "src-tauri" / "icons" / "app-icon-source.png"


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def background() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE))
    px = img.load()
    assert px is not None
    for y in range(SIZE):
        t = y / (SIZE - 1)
        base = (
            int(10 + t * 6),
            int(12 + t * 8),
            int(20 + t * 12),
        )
        for x in range(SIZE):
            dx = (x - SIZE * 0.48) / SIZE
            dy = (y - SIZE * 0.26) / SIZE
            glow = max(0.0, 1.0 - math.hypot(dx, dy) * 1.55)
            nebula = max(0.0, 1.0 - math.hypot((x / SIZE) - 0.72, (y / SIZE) - 0.34) * 2.4)
            r = min(255, int(base[0] + glow * 26 + nebula * 8))
            g = min(255, int(base[1] + glow * 32 + nebula * 28))
            b = min(255, int(base[2] + glow * 48 + nebula * 46))
            px[x, y] = (r, g, b, 255)
    return img


def draw_mark(img: Image.Image) -> None:
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    bar_w, bar_h = 500, 118
    stem_w, stem_h = 118, 430
    cx, cy = SIZE // 2, int(SIZE * 0.51)
    left = cx - bar_w // 2
    top = cy - (bar_h + stem_h - bar_h // 2) // 2 - 18
    bar = (left, top, left + bar_w, top + bar_h)
    stem = (cx - stem_w // 2, top + bar_h - 18, cx + stem_w // 2, top + bar_h - 18 + stem_h)
    radius = 36
    ink = (236, 240, 247, 255)
    draw.rounded_rectangle(bar, radius=radius, fill=ink)
    draw.rounded_rectangle(stem, radius=radius, fill=ink)

    spark_d = 108
    spark = (
        bar[2] - spark_d + 10,
        bar[1] - spark_d + 28,
        bar[2] + 10,
        bar[1] + 28,
    )
    draw.ellipse(spark, fill=(90, 200, 250, 255))

    img.alpha_composite(layer)


def finish(img: Image.Image) -> Image.Image:
    mask = rounded_mask(SIZE, RADIUS)
    highlight = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    hdraw = ImageDraw.Draw(highlight)
    inset = 10
    hdraw.rounded_rectangle(
        (inset, inset, SIZE - 1 - inset, SIZE - 1 - inset),
        radius=RADIUS - 8,
        outline=(255, 255, 255, 28),
        width=3,
    )
    img.alpha_composite(highlight)

    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(img, mask=mask)
    return out.filter(ImageFilter.SMOOTH)


def main() -> None:
    img = background()
    draw_mark(img)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    finish(img).save(OUT, "PNG")
    print(OUT)


if __name__ == "__main__":
    main()
