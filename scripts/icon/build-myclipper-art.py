"""Draw myClipper's brand artwork: a stack of clip cards with a play button.

  engine/.venv/Scripts/python.exe scripts/icon/build-myclipper-art.py

Writes resources/myclipper-{mark,logo,logo-light,icon,icon-small}.svg, resources/myclipper-icon.png
and the app icons build/icon.png, build/icon.ico and build/icon.icns.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
NAVY, GOLD, BACK, MID = "#1d2a45", "#f4b63c", "#5e7099", "#90a4cc"

CARDS = [(220, 250, 805, 520, 56, BACK), (170, 340, 855, 610, 56, MID), (120, 430, 905, 840, 60, GOLD)]
PLAY = [(450, 560), (620, 660), (450, 760)]
STACK_BOX = (120, 250, 905, 840)

def svg_shapes(dx=0.0, dy=0.0, scale=1.0, play_fill=NAVY) -> str:
    out = []
    for x0, y0, x1, y1, r, colour in CARDS:
        out.append(f'<rect x="{(x0 + dx) * scale:.1f}" y="{(y0 + dy) * scale:.1f}" width="{(x1 - x0) * scale:.1f}" '
                   f'height="{(y1 - y0) * scale:.1f}" rx="{r * scale:.1f}" fill="{colour}"/>')
    points = " ".join(f"{(x + dx) * scale:.1f},{(y + dy) * scale:.1f}" for x, y in PLAY)
    out.append(f'<polygon points="{points}" fill="{play_fill}"/>')
    return "".join(out)

def icon_svg(size: int) -> str:
    s = size / 1024
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}" '
            f'role="img" aria-label="myClipper"><rect width="{size}" height="{size}" rx="{224 * s:.1f}" fill="{NAVY}"/>'
            f'{svg_shapes(scale=s)}</svg>')

def mark_svg(height=100.0) -> tuple[str, float]:
    x0, y0, x1, y1 = STACK_BOX
    s = height / (y1 - y0)
    width = (x1 - x0) * s
    return svg_shapes(dx=-x0, dy=-y0, scale=s, play_fill=NAVY), width

def logo_svg(text_colour: str) -> str:
    shapes, mark_w = mark_svg()
    text_x = mark_w + 22
    width = text_x + 330
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.1f} 100" role="img" aria-label="myClipper">'
            f'{shapes}<text x="{text_x:.1f}" y="74" font-family="Inter, \'Segoe UI\', system-ui, sans-serif" '
            f'font-size="68" font-weight="700" letter-spacing="-1.5" fill="{text_colour}">myClipper</text></svg>')

def icon_png(size: int) -> Image.Image:
    k = 4
    img = Image.new("RGBA", (size * k, size * k), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = size * k / 1024
    d.rounded_rectangle((0, 0, size * k - 1, size * k - 1), radius=224 * s, fill=NAVY)
    for x0, y0, x1, y1, r, colour in CARDS:
        d.rounded_rectangle((x0 * s, y0 * s, x1 * s, y1 * s), radius=r * s, fill=colour)
    d.polygon([(x * s, y * s) for x, y in PLAY], fill=NAVY)
    return img.resize((size, size), Image.LANCZOS)

def main() -> None:
    res, build = ROOT / "resources", ROOT / "build"
    shapes, mark_w = mark_svg()
    (res / "myclipper-mark.svg").write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {mark_w:.1f} 100" role="img" aria-label="myClipper">'
        f'{shapes}</svg>', encoding="utf-8")
    (res / "myclipper-logo.svg").write_text(logo_svg("#fafafa"), encoding="utf-8")
    (res / "myclipper-logo-light.svg").write_text(logo_svg("#09090b"), encoding="utf-8")
    (res / "myclipper-icon.svg").write_text(icon_svg(1024), encoding="utf-8")
    (res / "myclipper-icon-small.svg").write_text(icon_svg(128), encoding="utf-8")
    big = icon_png(1024)
    big.save(res / "myclipper-icon.png")
    big.save(build / "icon.png")
    big.save(build / "icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    big.save(build / "icon.icns")
    print("artwork written")

if __name__ == "__main__":
    main()
