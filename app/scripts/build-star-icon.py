import io
import math
import struct
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
RES = REPO / "resources"

ICO_SIZES = [16, 32, 48, 64, 128, 256]
SS = 8

TILE_TOP = (253, 251, 248)
TILE_BOT = (241, 233, 220)
BORDER = (233, 221, 202)
STAR = (207, 85, 53)

LONG = [(12, 1.4), (12.85, 6), (12.85, 8.4), (12, 11), (12, 11), (11.15, 8.4), (11.15, 6), (12, 1.4)]
SHORT = [(12, 4.8), (12.6, 7.4), (12.6, 8.9), (12, 11), (12, 11), (11.4, 8.9), (11.4, 7.4), (12, 4.8)]


def cubic(p0, p1, p2, p3, n=24):
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


def render(size):
    s = size * SS
    radius = int(s * 0.20)

    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)
    column = Image.new("RGB", (1, s))
    for y in range(s):
        t = y / (s - 1)
        column.putpixel((0, y), tuple(round(TILE_TOP[k] + (TILE_BOT[k] - TILE_TOP[k]) * t) for k in range(3)))
    tile = column.resize((s, s), Image.BILINEAR).convert("RGBA")
    tile.putalpha(mask)

    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    img = Image.alpha_composite(img, tile)

    border = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle(
        [0, 0, s - 1, s - 1], radius=radius, outline=BORDER + (255,), width=max(1, int(SS * 1.3))
    )
    img = Image.alpha_composite(img, border)

    rays = star_rays()
    r0 = max(math.hypot(x - 12, y - 12) for r in rays for (x, y) in r)
    scale = (0.66 / 2 * s) / r0
    overlay = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for r in rays:
        draw.polygon([(s / 2 + (x - 12) * scale, s / 2 + (y - 12) * scale) for (x, y) in r], fill=STAR + (255,))
    img = Image.alpha_composite(img, overlay)

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
