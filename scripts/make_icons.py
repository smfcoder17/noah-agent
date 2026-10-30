"""Génère les icônes PNG de la PWA (192 et 512 px) : Noah, le même dessin que frontend/public/assets/icon.svg.

Usage : python scripts/make_icons.py   (Pillow requis ; écrit dans frontend/public/assets)
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "frontend" / "public" / "assets"
CORAL, LIGHT, DARK = (255, 122, 89), (255, 178, 159), (184, 88, 64)
EYE, MOUTH = (43, 22, 17), (107, 29, 29)


def bezier(p0, p1, p2, p3, n=40):
    return [
        tuple((1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d for a, b, c, d in zip(p0, p1, p2, p3))
        for t in (i / n for i in range(n + 1))
    ]


# Corps de Noah, repère 64x64 (même tracé que l'icône SVG).
BODY = (
    [(13, 55)]
    + bezier((13, 55), (7.2, 55), (6, 48.5), (7.6, 39.5))
    + bezier((7.6, 39.5), (10, 21), (18.5, 10), (32, 10))
    + bezier((32, 10), (45.5, 10), (54, 21), (56.4, 39.5))
    + bezier((56.4, 39.5), (58, 48.5), (56.8, 55), (51, 55))
)


def shaded(size, mask, light, base, dark, center):
    """Remplit `mask` d'un dégradé radial clair -> base -> sombre centré sur `center`."""
    grad = Image.new("RGB", (size, size))
    px = grad.load()
    cx, cy = center
    r = size * 0.55
    for y in range(size):
        for x in range(size):
            t = min(1.0, ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 / r)
            a, b, k = (light, base, t / 0.45) if t < 0.45 else (base, dark, (t - 0.45) / 0.55)
            px[x, y] = tuple(round(a[i] + (b[i] - a[i]) * k) for i in range(3))
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    layer.paste(grad, (0, 0), mask)
    return layer


def draw(size: int) -> Image.Image:
    big = size * 4  # suréchantillonnage pour des bords nets
    s = big / 512
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    tile = Image.new("L", (big, big), 0)
    ImageDraw.Draw(tile).rounded_rectangle([0, 0, big - 1, big - 1], radius=128 * s, fill=255)
    bg = Image.new("RGBA", (big, big), (255, 240, 235, 255))
    img.paste(bg, (0, 0), tile)

    def p(x, y):  # repère 64 -> pixels (translate 46,62 ; échelle 6.56)
        return ((46 + x * 6.56) * s, (62 + y * 6.56) * s)

    def circle(cx, cy, r):
        (x, y), k = p(cx, cy), r * 6.56 * s
        return [x - k, y - k, x + k, y + k]

    shadow = Image.new("L", (big, big), 0)
    (sx, sy), rx, ry = p(32, 57), 20 * 6.56 * s, 2.6 * 6.56 * s
    ImageDraw.Draw(shadow).ellipse([sx - rx, sy - ry, sx + rx, sy + ry], fill=36)
    img.paste((0, 0, 0, 255), (0, 0), shadow)

    body = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(body)
    d.ellipse(circle(8.6, 41.5, 6.4), fill=255)
    d.ellipse(circle(56, 35.5, 6), fill=255)
    d.polygon([p(x, y) for x, y in BODY], fill=255)
    img.alpha_composite(shaded(big, body, LIGHT, CORAL, DARK, p(26, 20)))

    gloss = Image.new("L", (big, big), 0)
    (gx, gy) = p(24, 18.5)
    ImageDraw.Draw(gloss).ellipse([gx - 7 * 6.56 * s, gy - 3.6 * 6.56 * s, gx + 7 * 6.56 * s, gy + 3.6 * 6.56 * s], fill=70)
    gloss = gloss.rotate(24, center=(gx, gy)).filter(ImageFilter.GaussianBlur(big / 200))
    img.paste((255, 255, 255, 255), (0, 0), ImageChops.multiply(gloss, body))

    face = ImageDraw.Draw(img)
    for ex in (24.6, 39.4):
        (x, y) = p(ex, 32)
        face.ellipse([x - 3.9 * 6.56 * s, y - 5.1 * 6.56 * s, x + 3.9 * 6.56 * s, y + 5.1 * 6.56 * s], fill=EYE)
        face.ellipse(circle(ex + 1.4, 29.8, 1.35), fill=(255, 255, 255))
    mouth = bezier((28.2, 40), (30.7, 42.8), (33.3, 42.8), (35.8, 40), 20) + bezier((35.8, 40), (33.3, 41), (30.7, 41), (28.2, 40), 20)
    face.polygon([p(x, y) for x, y in mouth], fill=MOUTH)
    face.line([p(x, y) for x, y in mouth], fill=MOUTH, width=round(1.4 * 6.56 * s), joint="curve")
    return img.resize((size, size), Image.LANCZOS)


for n in (192, 512):
    draw(n).save(OUT / f"icon-{n}.png")
    print(f"icon-{n}.png")
