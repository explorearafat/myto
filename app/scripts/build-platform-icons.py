#!/usr/bin/env python3
"""Generate the macOS (.icns) and Linux (PNG icon set) app icons.

electron-builder.yml points `mac.icon` at resources/icon.icns and `linux.icon`
at the resources/icons directory. Neither existed, so a macOS or Linux CI build
would have aborted before packaging. Windows already had its own pipeline
(scripts/build-icon.py -> resources/icon.ico), so this fills the other two.

Source of truth is resources/icon-1024.png (1024x1024 RGBA). Everything is
downscaled from it with a high-quality Lanczos filter, so the outputs are
byte-stable and committed to the repo -- CI never needs Pillow installed.

Usage:
    python scripts/build-platform-icons.py
"""

from __future__ import annotations

import struct
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parent.parent
RES = REPO / "resources"
SRC = RES / "icon-1024.png"

# Linux desktop environments vary in which size they ask for, and electron-builder
# picks the closest available when building an AppImage/deb. Supplying the whole
# standard ladder means no scaler ever has to invent pixels at runtime.
LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

# ICNS chunk type -> (pixel size, is_2x). The @2x entries are what make a Retina
# Dock/Finder icon crisp; without them macOS upscales the 1x bitmap and it looks
# soft on every modern Mac. 'icp4'/'icp5' are the legacy PNG-capable 16/32 slots
# still read by older macOS releases; ic07..ic14 are the Big Sur+ set.
ICNS_CHUNKS: list[tuple[bytes, int]] = [
    (b"icp4", 16),
    (b"icp5", 32),
    (b"ic11", 32),   # 16pt @2x
    (b"ic12", 64),   # 32pt @2x
    (b"ic07", 128),
    (b"ic13", 256),  # 128pt @2x
    (b"ic08", 256),
    (b"ic14", 512),  # 256pt @2x
    (b"ic09", 512),
    (b"ic10", 1024),  # 512pt @2x
]


def render(img: Image.Image, size: int) -> bytes:
    """Return `size`x`size` PNG bytes downscaled from the 1024px master."""
    out = img if img.width == size else img.resize((size, size), Image.LANCZOS)
    if out.mode != "RGBA":
        out = out.convert("RGBA")
    from io import BytesIO

    buf = BytesIO()
    out.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def build_icns(img: Image.Image) -> bytes:
    """Assemble a valid .icns container from the PNG chunk ladder above."""
    body = b""
    for chunk_type, size in ICNS_CHUNKS:
        data = render(img, size)
        # Each chunk: 4-byte OSType, 4-byte total chunk length (header included),
        # then the payload. The file length in the outer header counts everything.
        body += chunk_type + struct.pack(">I", len(data) + 8) + data
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"missing master icon: {SRC}")

    img = Image.open(SRC).convert("RGBA")

    icns = build_icns(img)
    icns_path = RES / "icon.icns"
    icns_path.write_bytes(icns)

    icons_dir = RES / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)
    for size in LINUX_SIZES:
        (icons_dir / f"{size}x{size}.png").write_bytes(render(img, size))

    print(f"{icns_path.relative_to(REPO)}  {len(icns):>9,} bytes  ({len(ICNS_CHUNKS)} chunks)")
    for size in LINUX_SIZES:
        p = icons_dir / f"{size}x{size}.png"
        print(f"{p.relative_to(REPO)}  {p.stat().st_size:>9,} bytes")


if __name__ == "__main__":
    main()