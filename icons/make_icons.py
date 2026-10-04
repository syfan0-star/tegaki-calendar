"""Generate the app icons (PNG) without external libraries.

Draws a calendar page with a red header and a handwritten blue stroke,
supersampled 4x for anti-aliasing. Run: python3 icons/make_icons.py
"""
import math
import os
import struct
import zlib

SS = 4  # supersampling factor


def write_png(path, w, h, rgba):
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw.extend(rgba[y * w * 4:(y + 1) * w * 4])
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def hexrgb(s):
    s = s.lstrip('#')
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def render(size):
    S = size * SS
    px = [hexrgb('#eef2ff')] * (S * S)
    px = list(px)

    def u(v):  # unit (0..1) -> supersampled px
        return v * S

    def fill_round_rect(x0, y0, x1, y1, r, color, clip_top=None, clip_bottom=None):
        X0, Y0, X1, Y1, R = u(x0), u(y0), u(x1), u(y1), u(r)
        ya = int(max(0, Y0)) if clip_top is None else int(u(clip_top))
        yb = int(min(S, Y1)) if clip_bottom is None else int(u(clip_bottom))
        for y in range(max(0, int(Y0)), min(S, int(Y1))):
            if y < ya or y >= yb:
                continue
            for x in range(max(0, int(X0)), min(S, int(X1))):
                cx = min(max(x + 0.5, X0 + R), X1 - R)
                cy = min(max(y + 0.5, Y0 + R), Y1 - R)
                if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= R * R:
                    px[y * S + x] = color

    def disc(cx, cy, r, color):
        CX, CY, R = u(cx), u(cy), u(r)
        for y in range(max(0, int(CY - R)), min(S, int(CY + R) + 1)):
            for x in range(max(0, int(CX - R)), min(S, int(CX + R) + 1)):
                if (x + 0.5 - CX) ** 2 + (y + 0.5 - CY) ** 2 <= R * R:
                    px[y * S + x] = color

    # page with shadow
    fill_round_rect(0.15, 0.17, 0.87, 0.89, 0.07, hexrgb('#c7d2fe'))
    fill_round_rect(0.13, 0.14, 0.85, 0.86, 0.07, hexrgb('#ffffff'))
    # red header band (top part of the page only)
    fill_round_rect(0.13, 0.14, 0.85, 0.86, 0.07, hexrgb('#ef4444'), clip_bottom=0.30)
    # binder rings
    for x in (0.30, 0.68):
        fill_round_rect(x - 0.02, 0.09, x + 0.02, 0.20, 0.02, hexrgb('#374151'))
    # grid dots
    for row in range(4):
        for col in range(5):
            disc(0.22 + col * 0.11, 0.40 + row * 0.11, 0.012, hexrgb('#cbd5e1'))
    # handwritten stroke (a loose "check + swoosh"), variable width
    pts = []
    for i in range(120):
        t = i / 119
        x = 0.24 + 0.50 * t
        y = 0.66 - 0.10 * math.sin(t * math.pi * 1.6) + 0.05 * t
        pts.append((x, y, 0.35 + 0.65 * math.sin(t * math.pi)))
    for x, y, p in pts:
        disc(x, y, 0.012 + 0.018 * p, hexrgb('#2563eb'))

    # downsample
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            r = g = b = 0
            for sy in range(SS):
                row = (y * SS + sy) * S + x * SS
                for sx in range(SS):
                    pr, pg, pb = px[row + sx]
                    r += pr; g += pg; b += pb
            n = SS * SS
            i = (y * size + x) * 4
            out[i:i + 4] = bytes((r // n, g // n, b // n, 255))
    return out


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    for size, name in ((180, 'apple-touch-icon.png'), (192, 'icon-192.png'), (512, 'icon-512.png'), (32, 'favicon-32.png')):
        write_png(os.path.join(here, name), size, size, render(size))
        print('wrote', name)
