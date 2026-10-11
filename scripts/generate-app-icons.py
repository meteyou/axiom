#!/usr/bin/env python3
"""Regenerate the home-screen PNG icons from the logo SVGs.

Requires `rsvg-convert` (librsvg) and Pillow. Run from the repository root:

    python3 scripts/generate-app-icons.py
"""

import math
import re
import subprocess
from io import BytesIO
from pathlib import Path

from PIL import Image

PUBLIC_DIR = Path(__file__).resolve().parent.parent / "packages" / "web-frontend" / "public"
LOGOS_DIR = PUBLIC_DIR / "logos"
ICONS_DIR = PUBLIC_DIR / "icons"

TILE_COLORS = {
    "prism": "#0C8D62",
    "raccoon": "#141826",
    "robot": "#0C8D62",
}

# Maskable icons may be cropped to a circle with 40% radius, so the mark must
# stay inside it; the extra margin keeps it off the very edge of the mask.
MASKABLE_MARK_RADIUS = 0.38
MASKABLE_SIZE = 512


def render_svg(svg: str, size: int) -> Image.Image:
    png = subprocess.run(
        ["rsvg-convert", "--width", str(size), "--height", str(size)],
        input=svg.encode(),
        capture_output=True,
        check=True,
    ).stdout
    return Image.open(BytesIO(png)).convert("RGBA")


def without_rounded_corners(svg: str) -> str:
    return re.sub(r'\srx="[^"]+"', "", svg, count=1)


def hex_to_rgb(color: str) -> tuple[int, int, int]:
    return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))


def mark_radius_ratio(tile: Image.Image, tile_rgb: tuple[int, int, int]) -> float:
    """Distance of the farthest non-tile pixel from the centre, relative to the tile size."""
    width, height = tile.size
    pixels = tile.convert("RGB").load()
    farthest = 0.0
    for y in range(height):
        for x in range(width):
            if max(abs(channel - tile_channel) for channel, tile_channel in zip(pixels[x, y], tile_rgb)) > 24:
                farthest = max(farthest, math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2))
    return farthest / width


def render_maskable(square_svg: str, tile_rgb: tuple[int, int, int]) -> Image.Image:
    scale = MASKABLE_MARK_RADIUS / mark_radius_ratio(render_svg(square_svg, 256), tile_rgb)
    mark_size = round(MASKABLE_SIZE * scale / 2) * 2
    offset = (MASKABLE_SIZE - mark_size) // 2
    canvas = Image.new("RGB", (MASKABLE_SIZE, MASKABLE_SIZE), tile_rgb)
    canvas.paste(render_svg(square_svg, mark_size).convert("RGB"), (offset, offset))
    return canvas


def save_optimized(image: Image.Image, path: Path) -> None:
    palette_image = image.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    palette_image.save(path, optimize=True)
    print(f"{path.relative_to(PUBLIC_DIR)}: {path.stat().st_size} bytes")


def main() -> None:
    ICONS_DIR.mkdir(exist_ok=True)
    for logo, tile_color in TILE_COLORS.items():
        svg = (LOGOS_DIR / f"{logo}.svg").read_text()
        square_svg = without_rounded_corners(svg)
        tile_rgb = hex_to_rgb(tile_color)

        # iOS fills transparent pixels with black and applies its own mask.
        save_optimized(render_svg(square_svg, 180).convert("RGB"), ICONS_DIR / f"{logo}-180.png")
        for size in (192, 512):
            save_optimized(render_svg(svg, size), ICONS_DIR / f"{logo}-{size}.png")
        save_optimized(render_maskable(square_svg, tile_rgb), ICONS_DIR / f"{logo}-maskable-512.png")


if __name__ == "__main__":
    main()
