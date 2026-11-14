"""Filme annonce.html image par image (render(t)) puis assemble la vidéo avec ffmpeg.

    python filmer.py /annonce /sortie [--fps 30] [--images 0.5,4,6.9]   # --images : quelques images de contrôle seulement
"""
import argparse
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("source")
ap.add_argument("sortie")
ap.add_argument("--fps", type=int, default=30)
ap.add_argument("--images", default="")
a = ap.parse_args()
out = Path(a.sortie)
(out / "images").mkdir(parents=True, exist_ok=True)

with sync_playwright() as pw:
    b = pw.chromium.launch()
    page = b.new_page(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
    page.goto(f"file://{a.source}/annonce.html")
    page.wait_for_load_state("networkidle")
    page.evaluate("document.fonts.ready")
    if a.images:
        for t in a.images.split(","):
            page.evaluate(f"render({t})")
            page.screenshot(path=str(out / f"controle-{float(t):05.2f}.png"))
    else:
        duree = page.evaluate("DUREE")
        n = int(duree * a.fps)
        for i in range(n):
            page.evaluate(f"render({i / a.fps})")
            page.screenshot(path=str(out / "images" / f"{i:05d}.png"))
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(a.fps), "-i", str(out / "images" / "%05d.png"),
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "slow", "-movflags", "+faststart",
                        str(out / "noah-agent-annonce.mp4")], check=True)
    b.close()
