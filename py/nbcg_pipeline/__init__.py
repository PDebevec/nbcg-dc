"""Shared helpers for the py/ pipeline scripts (web.py, ocr.py, split_spreads.py,
pdf_derive.py).

Cross-platform fixes and the seam-4 CLI contract (args in -> output files +
JSON summary on stdout + exit codes), factored out once real scanner data
showed all three scripts needed the same fixes independently. See
docs/tasks/py-real-data-mismatches.md for the history.

`pdf_text` (reportlab/pypdf, OCR's embedded-text-layer helpers) is
deliberately *not* re-exported here, unlike every other submodule - only
`ocr.py` needs it (`from nbcg_pipeline.pdf_text import ...`, a direct
submodule import), and re-exporting it here would make every script that
imports anything from this package (web.py/split_spreads.py/pdf_derive.py
included) transitively require reportlab/pypdf just to run, even though
none of them touch PDF text embedding. Confirmed the hard way: `web.py`
failed with `ModuleNotFoundError: No module named 'pypdf'` under a
minimal interpreter that only had Pillow.
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
from .ocr_lang import (
    MIN_LETTERS_PER_LINE,
    LANG_SAMPLE_PAGES,
    LANG_SWITCH_AFTER,
    LanguageStrategy,
    read_quality,
    sample_indices,
)
from .pages import OCR_MAX_DIMENSION, ImageFilePages, PdfPages
from .sorting import natural_key
from .workers import slice_pages, worker_count
from .streams import force_utf8_streams
from .summary import print_summary

__all__ = [
    "ARCHIVAL_DEFAULT_DPI",
    "ARCHIVAL_JPEG_QUALITY",
    "IMAGE_EXTENSIONS",
    "ImageFilePages",
    "LANG_SAMPLE_PAGES",
    "LANG_SWITCH_AFTER",
    "LanguageStrategy",
    "MIN_LETTERS_PER_LINE",
    "OCR_MAX_DIMENSION",
    "PdfPages",
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
    "read_quality",
    "resize_for_web",
    "sample_indices",
    "slice_pages",
    "worker_count",
]
