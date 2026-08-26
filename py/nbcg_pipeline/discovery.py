"""Image discovery: natural-sorted, filtered for OS artifacts and derived
preview variants that are not pages.
"""

import re
from pathlib import Path

from .sorting import natural_key

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}

# Files that are never pages: OS artifacts and derived preview variants such as
# `SP_001 (Small).jpg`, which sits beside its full-size original.
SKIP_NAMES = {"thumbs.db", "desktop.ini", ".ds_store"}
VARIANT_STEM_PATTERN = re.compile(
    r"\((?:small|medium|large|copy|preview|thumb)\)\s*$", re.IGNORECASE
)


def is_skippable(path: Path) -> bool:
    """OS artifacts and derived preview variants are not pages."""
    if path.name.lower() in SKIP_NAMES:
        return True
    return bool(VARIANT_STEM_PATTERN.search(path.stem))


def find_images(folder: Path, extensions: set[str] = IMAGE_EXTENSIONS) -> list[Path]:
    """Page-candidate images in `folder`, in natural (numeric-aware) order."""
    if not folder.is_dir():
        return []
    images = [
        p
        for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() in extensions and not is_skippable(p)
    ]
    return sorted(images, key=natural_key)
