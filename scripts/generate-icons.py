#!/usr/bin/env python3
"""Reproduce Jerrivell PDF's original J/page mark with Python's standard library.

SPDX-License-Identifier: MIT OR Apache-2.0
No external images, font programs, SVG libraries, or network access are used.
SVG and raster assets use the same manually authored geometry.
Run with --check to verify every output byte without modifying any file.
"""
from __future__ import annotations

import argparse
import hashlib
import math
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src-tauri" / "icons"
SIZES = (16, 24, 32, 48, 64, 128, 256, 512)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
NAVY = (20, 44, 63, 255)
PAPER = (248, 246, 238, 255)
COPPER = (224, 163, 100, 255)

# Custom J-shaped page edge. A geometric path, not a font glyph.
J_PATH = (
    ("M", 77, 57), ("L", 179, 57), ("L", 179, 146),
    ("C", 179, 182, 157, 204, 122, 204),
    ("C", 89, 204, 67, 185, 64, 155),
    ("L", 92, 155),
    ("C", 94, 170, 104, 178, 122, 178),
    ("C", 140, 178, 151, 166, 151, 146),
    ("L", 151, 84), ("L", 77, 84), ("Z",),
)


def round_rect(x: float, y: float, w: float, h: float, r: float):
    k = .5522847498307936
    return (
        ("M", x + r, y), ("L", x + w - r, y),
        ("C", x + w - r + k*r, y, x + w, y + r - k*r, x + w, y + r),
        ("L", x + w, y + h - r),
        ("C", x + w, y + h - r + k*r, x + w - r + k*r, y + h, x + w - r, y + h),
        ("L", x + r, y + h),
        ("C", x + r - k*r, y + h, x, y + h - r + k*r, x, y + h - r),
        ("L", x, y + r),
        ("C", x, y + r - k*r, x + r - k*r, y, x + r, y), ("Z",),
    )


SHAPES = (
    (NAVY, round_rect(12, 12, 232, 232, 53)),
    (PAPER, J_PATH),
    (COPPER, round_rect(77, 104, 48, 12, 6)),
    (COPPER, round_rect(77, 128, 31, 12, 6)),
)


def svg() -> bytes:
    def number(value):
        return f"{value:.9f}".rstrip("0").rstrip(".")
    paths = []
    for color, commands in SHAPES:
        d = " ".join(command[0] + (" " + " ".join(number(v) for v in command[1:]) if len(command) > 1 else "") for command in commands)
        fill = "#" + "".join(f"{v:02x}" for v in color[:3])
        paths.append(f'  <path fill="{fill}" d="{d}"/>')
    return ("\n".join([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!-- SPDX-License-Identifier: MIT OR Apache-2.0; original Jerrivell PDF geometry. -->',
        '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-labelledby="title desc">',
        '  <title id="title">Jerrivell PDF</title>',
        '  <desc id="desc">An ivory J-shaped page edge and two copper page lines on a rounded ink-blue tile.</desc>',
        *paths, '</svg>', '',
    ])).encode("utf-8")


def flatten(commands):
    """Evaluate the authored curves, not arbitrary SVG input."""
    points = []
    current = (0., 0.)
    for command in commands:
        kind, *values = command
        if kind in {"M", "L"}:
            current = (values[0], values[1])
            points.append(current)
        elif kind == "C":
            x0, y0 = current
            x1, y1, x2, y2, x3, y3 = values
            for i in range(1, 49):
                t = i / 48
                s = 1-t
                points.append((s*s*s*x0 + 3*s*s*t*x1 + 3*s*t*t*x2 + t*t*t*x3,
                               s*s*s*y0 + 3*s*s*t*y1 + 3*s*t*t*y2 + t*t*t*y3))
            current = (x3, y3)
        elif kind == "Z":
            current = points[0]
    return points


def fill_polygon(buffer: bytearray, size: int, polygon, color):
    """Fill pixel-center spans using a half-open scanline convention."""
    edges = list(zip(polygon, polygon[1:] + polygon[:1]))
    first = max(0, math.ceil(min(p[1] for p in polygon) - .5))
    last = min(size, math.ceil(max(p[1] for p in polygon) - .5))
    pixel = bytes(color)
    stride = size * 4
    for y in range(first, last):
        scan = y + .5
        intersections = sorted(x1 + (scan-y1) * (x2-x1) / (y2-y1)
                               for ((x1, y1), (x2, y2)) in edges
                               if min(y1, y2) <= scan < max(y1, y2))
        for start, end in zip(intersections[::2], intersections[1::2]):
            left = max(0, math.ceil(start - .5))
            right = min(size, math.ceil(end - .5))
            if right > left:
                offset = y * stride + left * 4
                buffer[offset:offset + (right-left)*4] = pixel * (right-left)


def rgba(size: int) -> bytes:
    samples = 4
    high = size * samples
    buffer = bytearray(high * high * 4)
    for color, commands in SHAPES:
        points = [(x * high / 256, y * high / 256) for x, y in flatten(commands)]
        fill_polygon(buffer, high, points, color)
    output = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for yy in range(y*samples, (y+1)*samples):
                base = (yy * high + x*samples) * 4
                for xx in range(samples):
                    i = base + xx * 4
                    r += buffer[i]; g += buffer[i+1]; b += buffer[i+2]; a += buffer[i+3]
            offset = (y * size + x) * 4
            if a:
                count = a // 255
                output[offset:offset+4] = bytes(((r + count//2)//count, (g + count//2)//count,
                                                (b + count//2)//count, (a + 8)//16))
    return bytes(output)


def encode_png(width: int, height: int, data: bytes) -> bytes:
    def chunk(kind, contents):
        return struct.pack(">I", len(contents)) + kind + contents + struct.pack(">I", zlib.crc32(kind + contents) & 0xffffffff)
    rows = b"".join(b"\0" + data[y*width*4:(y+1)*width*4] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def png(size: int) -> bytes:
    """Compatibility entry point for existing icon-provenance checks."""
    return encode_png(size, size, rgba(size))


def ico(images: dict[int, bytes]) -> bytes:
    offset = 6 + 16 * len(ICO_SIZES)
    entries, payloads = [], []
    for size in ICO_SIZES:
        data = images[size]
        entries.append(struct.pack("<BBBBHHII", 0 if size == 256 else size,
                                   0 if size == 256 else size, 0, 0, 1, 32, len(data), offset))
        payloads.append(data)
        offset += len(data)
    return struct.pack("<HHH", 0, 1, len(entries)) + b"".join(entries + payloads)


def preview(pixels: dict[int, bytes]) -> bytes:
    width, height = 720, 400
    canvas = bytearray(bytes((247, 248, 249, 255)) * width * height)

    def blit(size, left, top):
        data = pixels[size]
        for y in range(size):
            for x in range(size):
                src = (y * size + x) * 4
                dst = ((top+y) * width + left+x) * 4
                alpha = data[src+3]
                for channel in range(3):
                    canvas[dst+channel] = (data[src+channel] * alpha + canvas[dst+channel] * (255-alpha) + 127) // 255

    blit(256, 52, 72)
    blit(128, 376, 72)
    blit(64, 544, 84)
    blit(48, 628, 92)
    blit(32, 400, 248)
    blit(24, 464, 252)
    blit(16, 520, 256)
    return encode_png(width, height, bytes(canvas))


def outputs() -> dict[Path, bytes]:
    pixels = {size: rgba(size) for size in SIZES}
    images = {size: encode_png(size, size, pixels[size]) for size in SIZES}
    result = {OUT / f"{size}x{size}.png": data for size, data in images.items()}
    result[OUT / "icon.ico"] = ico(images)
    result[OUT / "icon.svg"] = svg()
    result[ROOT / "src/brand/jerrivell-icon.svg"] = svg()
    result[ROOT / "docs/branding/jerrivell-icon-preview.png"] = preview(pixels)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Compare every generated byte; do not modify any file.")
    arguments = parser.parse_args()
    generated = outputs()
    mismatches = []
    for path, data in generated.items():
        if arguments.check:
            if not path.is_file() or path.read_bytes() != data:
                mismatches.append(str(path.relative_to(ROOT)))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    if mismatches:
        raise SystemExit("Icon provenance check failed: " + ", ".join(mismatches))
    mode = "verified without writes" if arguments.check else "generated"
    print(f"Jerrivell PDF: {len(generated)} original SVG/PNG/ICO outputs {mode}.")
    print("Master SVG SHA-256: " + hashlib.sha256(svg()).hexdigest())


if __name__ == "__main__":
    main()
