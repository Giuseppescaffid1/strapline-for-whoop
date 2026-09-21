#!/usr/bin/env python3
"""Render the app icons.

No image library is assumed, so this writes PNGs directly (zlib + CRC chunks)
and antialiases by measuring each pixel's distance to the stroked path rather
than by supersampling. Re-run after changing the mark:

    python3 tools/make_icons.py
"""

from __future__ import annotations

import math
import pathlib
import struct
import zlib

OUT = pathlib.Path(__file__).resolve().parent.parent / 'docs' / 'icons'

BG = (0x0B, 0x0E, 0x13)
TEAL = (0x00, 0xE5, 0xB0)
GREEN = (0x7D, 0xDC, 0x5B)

# A pulse trace in unit coordinates, y measured downward.
PULSE = [
    (0.09, 0.520), (0.27, 0.520), (0.325, 0.432), (0.385, 0.585),
    (0.465, 0.195), (0.550, 0.800), (0.625, 0.470), (0.700, 0.520),
    (0.91, 0.520),
]


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(lerp(c1[i], c2[i], t) for i in range(3))


def seg_distance(px, py, ax, ay, bx, by):
    """Distance from a point to a segment, plus where along it the foot lands."""
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length2))
    fx, fy = ax + t * dx, ay + t * dy
    return math.hypot(px - fx, py - fy), t


def render(size: int, pad: float = 0.0) -> bytes:
    """RGBA pixels for one square icon. `pad` insets the mark for maskable use."""
    px = bytearray()
    canvas = [[list(BG) for _ in range(size)] for _ in range(size)]

    # Background: a cool vignette so the plate does not read as flat black.
    cx, cy = size * 0.5, size * 0.34
    maxd = size * 0.95
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - cx, y - cy) / maxd
            glow = max(0.0, 1.0 - d) ** 2 * 0.22
            row = canvas[y][x]
            for i in range(3):
                row[i] = lerp(BG[i], mix(BG, TEAL, 0.55)[i], glow)

    scale = size * (1 - 2 * pad)
    off = size * pad
    pts = [(off + x * scale, off + y * scale) for x, y in PULSE]
    segs = list(zip(pts, pts[1:]))

    stroke = size * 0.058
    half = stroke / 2
    falloff = size * 0.055
    # ONE distance field for the whole path. Stroking each segment separately
    # made the halo compound wherever segments met, which read as stacked blobs
    # rather than a glow; the minimum distance over all segments cannot.
    for y in range(size):
        py = y + 0.5
        for x in range(size):
            pxc = x + 0.5
            dist = min(seg_distance(pxc, py, ax, ay, bx, by)[0] for (ax, ay), (bx, by) in segs)
            if dist > half + falloff * 3:
                continue
            colour = mix(TEAL, GREEN, max(0.0, min(1.0, (x - off) / scale)))
            core = max(0.0, min(1.0, half + 0.5 - dist))
            glow = 0.0 if dist <= half else 0.33 * math.exp(-(dist - half) / falloff)
            a = core + glow * (1 - core)
            if a <= 0:
                continue
            row = canvas[y][x]
            for i in range(3):
                row[i] = lerp(row[i], colour[i], a)

    for y in range(size):
        px.append(0)  # filter type 0 for this scanline
        for x in range(size):
            r, g, b = canvas[y][x]
            px += bytes((int(r + 0.5), int(g + 0.5), int(b + 0.5), 255))
    return bytes(px)


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data))


def write_png(path: pathlib.Path, size: int, pad: float = 0.0) -> None:
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    png = (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', ihdr)
        + chunk(b'IDAT', zlib.compress(render(size, pad), 9))
        + chunk(b'IEND', b'')
    )
    path.write_bytes(png)
    print(f'{path.relative_to(path.parent.parent.parent)}  {size}x{size}  {len(png) / 1024:.1f} KB')


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    # Maskable icons are cropped to a circle by some launchers, so the mark is
    # inset into the safe zone; the Apple touch icon is masked to a squircle and
    # needs less room.
    write_png(OUT / 'icon-512.png', 512, pad=0.14)
    write_png(OUT / 'icon-192.png', 192, pad=0.14)
    write_png(OUT / 'apple-touch-icon.png', 180, pad=0.10)
    write_png(OUT / 'favicon-64.png', 64, pad=0.06)
