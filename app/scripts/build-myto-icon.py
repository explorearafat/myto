"""Myto app icon (mitochondria mark, white on a charcoal rounded tile) → icon.ico + icon.png.

Pure PIL, no ImageMagick/sharp. The mark geometry is kept identical to MytoMark.tsx /
public/myto-mark.svg (a tilted organic bean with a double membrane and four rounded
finger-like cristae) — the 512x512 frame, rotated 12 about (256,256)."""
import io
import math
import struct
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
RES = REPO / "resources"

ICO_SIZES = [16, 32, 48, 64, 128, 256]
SS = 8
TILT = 12
CX = CY = 256.0
FRAC = 0.70                # mark bounding box as a fraction of the tile

TILE = (24, 24, 24)        # App Icon (Dark) charcoal (#181818)
MARK = (240, 240, 236)     # near-white membranes + cristae (#F0F0EC)

# Each membrane is (start, [(c1, c2, end), ...]) closed back to start; cristae are single
# cubics (start, c1, c2, end, width). Widths: outer 17, inner 13, cristae 14/15/14/13.
OUTER = ((100, 260), [
    ((100, 212), (134, 178), (182, 170)),
    ((214, 165), (234, 187), (258, 193)),
    ((284, 199), (302, 170), (342, 168)),
    ((394, 166), (436, 202), (434, 254)),
    ((432, 306), (398, 348), (344, 356)),
    ((302, 362), (282, 368), (252, 368)),
    ((194, 368), (132, 354), (110, 320)),
    ((97, 300), (98, 282), (100, 260)),
], 17)
INNER = ((142, 258), [
    ((142, 224), (168, 204), (202, 199)),
    ((228, 195), (244, 209), (266, 214)),
    ((288, 219), (302, 200), (330, 200)),
    ((366, 200), (394, 222), (392, 256)),
    ((390, 292), (366, 320), (328, 326)),
    ((300, 330), (284, 334), (258, 334)),
    ((214, 334), (174, 324), (156, 302)),
    ((143, 288), (142, 274), (142, 258)),
], 13)
CRISTAE = [
    ((184, 300), (172, 274), (176, 244), (192, 224), 14),
    ((216, 312), (206, 282), (210, 242), (226, 216), 15),
    ((250, 312), (244, 284), (254, 248), (272, 226), 14),
    ((286, 302), (282, 282), (292, 262), (310, 248), 13),
]


def rot(pts):
    r = math.radians(TILT)
    c, s = math.cos(r), math.sin(r)
    return [(CX + (x - CX) * c - (y - CY) * s, CY + (x - CX) * s + (y - CY) * c) for (x, y) in pts]


def cubic(p0, c1, c2, p3, n=64):
    out = []
    for i in range(n + 1):
        t = i / n
        m = 1 - t
        out.append((
            m * m * m * p0[0] + 3 * m * m * t * c1[0] + 3 * m * t * t * c2[0] + t * t * t * p3[0],
            m * m * m * p0[1] + 3 * m * m * t * c1[1] + 3 * m * t * t * c2[1] + t * t * t * p3[1],
        ))
    return out


def contour_pts(path):
    start, segs, _ = path
    pts, p0 = [start], start
    for c1, c2, p3 in segs:
        pts.extend(cubic(p0, c1, c2, p3)[1:])
        p0 = p3
    return pts


def mark_strokes():
    """Rotated (points, width) for the outer + inner membranes and the four cristae."""
    out = [(rot(contour_pts(OUTER)), OUTER[2]), (rot(contour_pts(INNER)), INNER[2])]
    out += [(rot(cubic(a, b, c, d)), w) for (a, b, c, d, w) in CRISTAE]
    return out


def render(size):
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=TILE + (255,))

    strokes = mark_strokes()
    xs, ys = [], []
    for pts, w in strokes:
        for (x, y) in pts:
            xs += [x - w / 2, x + w / 2]
            ys += [y - w / 2, y + w / 2]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    scale = FRAC * s / max(maxx - minx, maxy - miny)
    bx, by = (minx + maxx) / 2, (miny + maxy) / 2

    def to_px(p):
        return (s / 2 + (p[0] - bx) * scale, s / 2 + (p[1] - by) * scale)

    layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)

    # Round-capped strokes as a union of overlapping disks stamped along each sampled curve —
    # smooth, uniform width, no segment seams.
    def stroke(pts, w):
        r = w * scale / 2
        for q in pts:
            px, py = to_px(q)
            ld.ellipse([px - r, py - r, px + r, py + r], fill=MARK + (255,))

    for pts, w in strokes:
        stroke(pts, w)

    img = Image.alpha_composite(img, layer)
    return img.resize((size, size), Image.LANCZOS)


def to_png(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def build_ico(pngs):
    entries = [(s, pngs[s]) for s in ICO_SIZES]
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + len(entries) * 16
    directory = b""
    payload = b""
    for size, data in entries:
        dim = 0 if size >= 256 else size
        directory += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        payload += data
        offset += len(data)
    return header + directory + payload


def main():
    RES.mkdir(parents=True, exist_ok=True)
    pngs = {s: to_png(render(s)) for s in ICO_SIZES}
    ico = build_ico(pngs)
    (RES / "icon.ico").write_bytes(ico)
    (RES / "icon.png").write_bytes(pngs[256])
    print(f"icon.ico  {len(ico):>8} bytes  ({', '.join(map(str, ICO_SIZES))})")
    print(f"icon.png  {len(pngs[256]):>8} bytes  (256x256)")


if __name__ == "__main__":
    main()
