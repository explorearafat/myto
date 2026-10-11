import math
from pathlib import Path

from PIL import Image, ImageDraw

MOBILE = Path(__file__).resolve().parent.parent
OUT = MOBILE / "assets" / "icon"

SIZE = 1024
SS = 4
MARK = (240, 240, 236)  # #F0F0EC
BG = (24, 24, 24)       # #181818

ROT = 12.0
CX = CY = 256.0
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


def rotate(p):
    r = math.radians(ROT)
    c, s = math.cos(r), math.sin(r)
    x, y = p[0] - CX, p[1] - CY
    return (CX + x * c - y * s, CY + x * s + y * c)


def cubic_points(p0, c1, c2, p3, n=64):
    out = []
    for i in range(n + 1):
        t = i / n
        m = 1 - t
        x = m * m * m * p0[0] + 3 * m * m * t * c1[0] + 3 * m * t * t * c2[0] + t * t * t * p3[0]
        y = m * m * m * p0[1] + 3 * m * m * t * c1[1] + 3 * m * t * t * c2[1] + t * t * t * p3[1]
        out.append((x, y))
    return out


def contour_points(path):
    start, segs, _ = path
    pts, p0 = [start], start
    for c1, c2, p3 in segs:
        pts.extend(cubic_points(p0, c1, c2, p3)[1:])
        p0 = p3
    return pts


def mark_strokes():
    """Rotated (points, stroke) for the outer + inner membranes and the four cristae."""
    out = [([rotate(p) for p in contour_points(OUTER)], OUTER[2]),
           ([rotate(p) for p in contour_points(INNER)], INNER[2])]
    out += [([rotate(p) for p in cubic_points(a, b, c, d)], w) for (a, b, c, d, w) in CRISTAE]
    return out


def draw_mark(img, diameter_frac):
    """Composite the near-white mitochondria mark onto `img`, centred, at `diameter_frac` wide.

    The double membrane and cristae are round-capped outline strokes drawn as a union of
    overlapping disks stamped along each sampled curve — smooth, uniform width, no seams."""
    s = img.width
    strokes = mark_strokes()

    xs, ys = [], []
    for pts, w in strokes:
        for (x, y) in pts:
            xs += [x - w / 2, x + w / 2]
            ys += [y - w / 2, y + w / 2]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    scale = (diameter_frac * s) / max(maxx - minx, maxy - miny)
    bx, by = (minx + maxx) / 2, (miny + maxy) / 2

    def to_px(p):
        return (s / 2 + (p[0] - bx) * scale, s / 2 + (p[1] - by) * scale)

    overlay = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    def stroke(pts, w):
        r = w * scale / 2
        for q in pts:
            px, py = to_px(q)
            draw.ellipse([px - r, py - r, px + r, py + r], fill=MARK + (255,))

    for pts, w in strokes:
        stroke(pts, w)

    return Image.alpha_composite(img, overlay)


def render_full():
    s = SIZE * SS
    img = Image.new("RGBA", (s, s), BG + (255,))
    img = draw_mark(img, 0.56)
    return img.resize((SIZE, SIZE), Image.LANCZOS)


def render_foreground():
    s = SIZE * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    img = draw_mark(img, 0.60)
    return img.resize((SIZE, SIZE), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    render_full().save(OUT / "myto_icon.png", format="PNG")
    render_foreground().save(OUT / "myto_icon_foreground.png", format="PNG")
    print(f"myto_icon.png            {(OUT / 'myto_icon.png').stat().st_size:>8} bytes ({SIZE}x{SIZE})")
    print(f"myto_icon_foreground.png {(OUT / 'myto_icon_foreground.png').stat().st_size:>8} bytes ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
