"""Génère les icônes PNG de la PWA (192 et 512 px) à partir du même dessin que web/icon.svg.

Usage : docker run --rm -v "$PWD/web:/web" -v "$PWD/scripts:/s" python:3.12-slim \
          sh -c "pip install -q pillow && python /s/make_icons.py"
"""
from PIL import Image, ImageDraw

BLUE, WHITE = (42, 71, 201, 255), (255, 255, 255, 255)


def draw(size: int) -> Image.Image:
    s = size / 512
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=112 * s, fill=BLUE)
    d.ellipse([106 * s, 106 * s, 406 * s, 406 * s], outline=(255, 255, 255, 90), width=round(28 * s))
    d.polygon([(256 * s, 128 * s), (352 * s, 384 * s), (304 * s, 384 * s), (284 * s, 328 * s),
               (228 * s, 328 * s), (208 * s, 384 * s), (160 * s, 384 * s)], fill=WHITE)
    d.polygon([(242 * s, 288 * s), (270 * s, 288 * s), (256 * s, 246 * s)], fill=BLUE)
    d.ellipse([354 * s, 124 * s, 406 * s, 176 * s], fill=WHITE)
    return img


for n in (192, 512):
    draw(n).save(f"/web/icon-{n}.png")
    print(f"icon-{n}.png")
