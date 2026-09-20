import math
from pathlib import Path

from PIL import Image, ImageDraw

MOBILE = Path(__file__).resolve().parent.parent
OUT = MOBILE / "assets" / "icon"

SIZE = 1024
SS = 4
TILE_TOP = (253, 251, 248)
TILE_BOT = (241, 233, 220)
STAR = (207, 85, 53)

LONG = [(12, 1.4), (12.85, 6), (12.85, 8.4), (12, 11), (12, 11), (11.15, 8.4), (11.15, 6), (12, 1.4)]
SHORT = [(12, 4.8), (12.6, 7.4), (12.6, 8.9), (12, 11), (12, 11), (11.4, 8.9), (11.4, 7.4), (12, 4.8)]


def cubic(p0, p1, p2, p3, n=48):
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0]
        y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
        pts.append((x, y))
    return pts


def ray_polygon(ctrl):
    return cubic(*ctrl[0:4]) + cubic(*ctrl[4:8])


def rotate(p, deg, cx=12.0, cy=12.0):
    r = math.radians(deg)
    c, s = math.cos(r), math.sin(r)
    x, y = p[0] - cx, p[1] - cy
    return (cx + x * c - y * s, cy + x * s + y * c)


def star_rays():
    rays = []
    for i in range(12):
        base = LONG if i % 2 == 0 else SHORT
        rays.append([rotate(p, i * 30) for p in ray_polygon(base)])
    return rays


def draw_star(img, diameter_frac):
    """Composite the terracotta star onto `img`, centred, at `diameter_frac` of the canvas."""
    s = img.width
    rays = star_rays()
    r0 = max(math.hypot(x - 12, y - 12) for r in rays for (x, y) in r)
    scale = (diameter_frac / 2 * s) / r0
    overlay = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for r in rays:
        draw.polygon([(s / 2 + (x - 12) * scale, s / 2 + (y - 12) * scale) for (x, y) in r], fill=STAR + (255,))
    return Image.alpha_composite(img, overlay)


def warm_tile(s):
    """A full-bleed square filled with the subtle vertical warm-paper gradient."""
    column = Image.new("RGB", (1, s))
    for y in range(s):
        t = y / (s - 1)
        column.putpixel((0, y), tuple(round(TILE_TOP[k] + (TILE_BOT[k] - TILE_TOP[k]) * t) for k in range(3)))
    return column.resize((s, s), Image.BILINEAR).convert("RGBA")


def render_full():
    s = SIZE * SS
    img = warm_tile(s)
    img = draw_star(img, 0.56)
    return img.resize((SIZE, SIZE), Image.LANCZOS)


def render_foreground():
    s = SIZE * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    img = draw_star(img, 0.50)
    return img.resize((SIZE, SIZE), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    full = render_full()
    fg = render_foreground()
    full.save(OUT / "sylor_icon.png", format="PNG")
    fg.save(OUT / "sylor_icon_foreground.png", format="PNG")
    print(f"sylor_icon.png            {(OUT / 'sylor_icon.png').stat().st_size:>8} bytes ({SIZE}x{SIZE})")
    print(f"sylor_icon_foreground.png {(OUT / 'sylor_icon_foreground.png').stat().st_size:>8} bytes ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
