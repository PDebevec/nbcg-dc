"""Shared helpers for the py/ pipeline scripts (web.py, ocr.py, split_spreads.py,
pdf_derive.py).

Cross-platform fixes and the seam-4 CLI contract (args in -> output files +
JSON summary on stdout + exit codes), factored out once real scanner data
showed all three scripts needed the same fixes independently. See
docs/tasks/py-real-data-mismatches.md for the history.
"""

from .discovery import (
    IMAGE_EXTENSIONS,
    SKIP_NAMES,
    VARIANT_STEM_PATTERN,
    find_images,
    is_skippable,
)
from .images import (
    ARCHIVAL_DEFAULT_DPI,
    ARCHIVAL_JPEG_QUALITY,
    THUMB_WIDTH,
    WEB_DPI,
    WEB_JPEG_QUALITY,
    WEB_MAX_DIMENSION,
    build_pdf,
    build_pdf_from_images,
    build_thumbnail,
    build_thumbnail_from_image,
    get_tif_dpi,
    load_rgb,
    resize_for_web,
)
from .limits import apply_memory_cap
from .sorting import natural_key
from .streams import force_utf8_streams
from .summary import print_summary

__all__ = [
    "ARCHIVAL_DEFAULT_DPI",
    "ARCHIVAL_JPEG_QUALITY",
    "IMAGE_EXTENSIONS",
    "SKIP_NAMES",
    "THUMB_WIDTH",
    "VARIANT_STEM_PATTERN",
    "WEB_DPI",
    "WEB_JPEG_QUALITY",
    "WEB_MAX_DIMENSION",
    "apply_memory_cap",
    "build_pdf",
    "build_pdf_from_images",
    "build_thumbnail",
    "build_thumbnail_from_image",
    "find_images",
    "force_utf8_streams",
    "get_tif_dpi",
    "is_skippable",
    "load_rgb",
    "natural_key",
    "print_summary",
    "resize_for_web",
]
