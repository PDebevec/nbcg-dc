"""Image loading, downscaling, PDF assembly and thumbnail generation.

Lifted out of `web.py` unchanged when `pdf_derive.py` turned out to need the
identical rules: a PDF derived from a supplied PDF must be downscaled to the
same size and quality as one assembled from JPGs, or the same item would get a
different web preview depending on which branch produced it. A second copy of
these constants is exactly how that drifts.
"""

from pathlib import Path

from PIL import Image

# Longest side, in pixels, for the web PDF. Everything at or below this is
# passed through untouched.
WEB_MAX_DIMENSION = 1600
WEB_JPEG_QUALITY = 70
WEB_DPI = 150

ARCHIVAL_JPEG_QUALITY = 95        # used when a TIF page has no usable raw form
ARCHIVAL_DEFAULT_DPI = 300        # fallback if TIF has no DPI info

THUMB_WIDTH = 500


def get_tif_dpi(img: Image.Image) -> tuple[float, float]:
    dpi = img.info.get("dpi")
    if dpi and dpi[0] and dpi[1]:
        return dpi
    return (ARCHIVAL_DEFAULT_DPI, ARCHIVAL_DEFAULT_DPI)


def load_rgb(path: Path) -> Image.Image:
    img = Image.open(path)
    if img.mode != "RGB":
        img = img.convert("RGB")
    return img


def resize_for_web(img: Image.Image) -> Image.Image:
    w, h = img.size
    longest = max(w, h)
    if longest <= WEB_MAX_DIMENSION:
        return img
    scale = WEB_MAX_DIMENSION / longest
    new_size = (max(1, round(w * scale)), max(1, round(h * scale)))
    return img.resize(new_size, Image.LANCZOS)


def build_pdf(
    image_paths: list[Path],
    out_path: Path,
    *,
    downscale: bool,
    quality: int,
    dpi: tuple[float, float],
    log=None,
) -> None:
    """Build a multi-page PDF from `image_paths`, in the given order.

    `downscale` applies `resize_for_web` to each page (the web PDF) and
    enables re-encoding optimization; the archival PDF passes every source
    image through at full resolution and prefers the first page's own DPI
    over the caller-supplied default.
    """
    if log:
        log.info("  Building PDF (%d page(s)) -> %s", len(image_paths), out_path.name)
    images = []
    resolution = dpi
    for i, path in enumerate(image_paths):
        img = load_rgb(path)
        if not downscale and i == 0:
            resolution = get_tif_dpi(img)
        if downscale:
            img = resize_for_web(img)
        images.append(img)

    first, rest = images[0], images[1:]
    first.save(
        out_path,
        save_all=True,
        append_images=rest,
        resolution=resolution[0],
        quality=quality,
        optimize=downscale,
    )
    for img in images:
        img.close()


def build_pdf_from_images(
    images: list[Image.Image],
    out_path: Path,
    *,
    quality: int = WEB_JPEG_QUALITY,
    dpi: tuple[float, float] = (WEB_DPI, WEB_DPI),
) -> None:
    """Assemble already-in-memory pages (a rendered PDF's rasters) into a web
    PDF. The on-disk variant above cannot be reused for that: PDF pages have no
    file to open, and writing them out only to read them straight back would
    double the I/O of a 300-page book for nothing.

    Callers own the images and close them; nothing here mutates them beyond the
    downscale, which returns a new image when it applies.
    """
    pages = [resize_for_web(img) for img in images]
    first, rest = pages[0], pages[1:]
    first.save(
        out_path,
        save_all=True,
        append_images=rest,
        resolution=dpi[0],
        quality=quality,
        optimize=True,
    )


def build_thumbnail(first_image_path: Path, out_path: Path, log=None) -> None:
    if log:
        log.info("  Building thumbnail from first page -> %s", out_path.name)
    img = load_rgb(first_image_path)
    _write_thumbnail(img, out_path)
    img.close()


def build_thumbnail_from_image(img: Image.Image, out_path: Path) -> None:
    """As above, for a page already in memory (see `build_pdf_from_images`)."""
    _write_thumbnail(img if img.mode == "RGB" else img.convert("RGB"), out_path)


def _write_thumbnail(img: Image.Image, out_path: Path) -> None:
    w, h = img.size
    new_h = max(1, round(h * (THUMB_WIDTH / w)))
    thumb = img.resize((THUMB_WIDTH, new_h), Image.LANCZOS)
    thumb.save(out_path, format="PNG", optimize=True)
    thumb.close()
