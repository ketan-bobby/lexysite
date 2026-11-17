"""Generate the website-palette wordmark without changing its silhouette."""
from pathlib import Path

from PIL import Image

public = Path(__file__).resolve().parents[1] / "public"
image = Image.open(public / "lexy-ai-logo.png").convert("RGBA")
navy = (8, 16, 43)
blue = (0, 85, 255)
pixels = []
for r, g, b, alpha in image.getdata():
    luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    blend = max(0, min(1, (luminance - 30) / 90))
    color = tuple(round(start + (end - start) * blend) for start, end in zip(navy, blue))
    pixels.append((*color, alpha))
image.putdata(pixels)
image.save(public / "lexy-ai-logo-navy-blue.png", optimize=True)
