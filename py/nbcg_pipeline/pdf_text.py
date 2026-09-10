"""Embed OCR-recognized text into a PDF as an invisible, searchable layer.

Kept independent of paddleocr/pdf2image (see `limits.py` and
`py/tests/test_ocr_platform.py`'s own docstring for why that separation
exists in this package) - this module only needs already-computed
recognition results (text + a detection box per line) plus pypdf/reportlab,
so it is fully unit-testable without the heavy OCR stack `ocr.py` itself
requires at import time.

Idempotency: `embed_text_layer` marks every PDF it embeds into via a custom
Info-dict key (`OCR_EMBED_MARKER_KEY`) and returns `None` instead of
re-embedding when that marker is already present. `ocr.py` can be re-run
against an already-embedded PDF (an explicit Reprocess of the `ocr` stage
alone, without rebuilding `pdf` first) - without this guard, a second run
would silently stack a second invisible text layer on top of the first.
"""
from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

OCR_EMBED_MARKER_KEY = "/NBCGOcrEmbedded"
# A version string, not a bare flag, so a future change to the embed format
# can bump this to force re-embedding of PDFs marked by an older version.
OCR_EMBED_MARKER_VALUE = "1"

_FONT_NAME = "NBCGOcrText"
_FONT_PATH = Path(__file__).parent / "assets" / "DejaVuSans.ttf"
_font_registered = False


@dataclass(frozen=True)
class RecognizedLine:
    """One OCR-recognized line of text.

    `poly` is its detection box - pixel-space corners `(x, y)`, in the same
    raster OCR actually ran against (any polygon, not assumed to be exactly
    4 points). `text` is the recognized string.
    """
    poly: tuple[tuple[float, float], ...]
    text: str


def _ensure_font_registered() -> str | None:
    """Register the vendored Latin+Cyrillic font once, lazily - same
    lazy-cache shape as `ocr.py`'s own `_get_engine`. Returns the registered
    font name, or `None` if registration failed: a missing/corrupt font
    asset must degrade the caller to "skip embedding," never crash the
    whole OCR run over it."""
    global _font_registered
    if _font_registered:
        return _FONT_NAME
    try:
        pdfmetrics.registerFont(TTFont(_FONT_NAME, str(_FONT_PATH)))
        _font_registered = True
        return _FONT_NAME
    except Exception:
        return None


def already_embedded(reader: PdfReader) -> bool:
    """True if `reader`'s PDF already carries our OCR text-layer marker."""
    metadata = reader.metadata
    if not metadata:
        return False
    return metadata.get(OCR_EMBED_MARKER_KEY) == OCR_EMBED_MARKER_VALUE


def _pixel_to_pdf_point(
    x_px: float,
    y_px: float,
    img_w_px: float,
    img_h_px: float,
    page_w_pt: float,
    page_h_pt: float,
    page_left_pt: float = 0.0,
    page_bottom_pt: float = 0.0,
) -> tuple[float, float]:
    """Map one pixel-space point (origin top-left, y grows down - the
    OCR-time raster's own coordinate system) to PDF point-space (origin
    bottom-left, y grows up).

    Scaled by the ratio of the page's actual point size to the image's
    actual pixel size - never an assumed DPI - so this is correct
    regardless of which image OCR actually ran against (a rasterized PDF
    page, or an original source photo at a different resolution).
    """
    scale_x = page_w_pt / img_w_px if img_w_px else 0.0
    scale_y = page_h_pt / img_h_px if img_h_px else 0.0
    x_pt = page_left_pt + x_px * scale_x
    y_pt = page_bottom_pt + page_h_pt - (y_px * scale_y)
    return x_pt, y_pt


def _make_overlay_page(
    lines: list[RecognizedLine],
    img_size: tuple[float, float],
    page_size: tuple[float, float],
    page_origin: tuple[float, float],
    font_name: str,
) -> PdfReader:
    """A one-page PDF holding an invisible text run per recognized line,
    positioned and horizontally scaled to its detection box."""
    img_w_px, img_h_px = img_size
    page_w_pt, page_h_pt = page_size
    page_left_pt, page_bottom_pt = page_origin

    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=(page_w_pt, page_h_pt))

    for line in lines:
        if not line.text.strip() or not line.poly:
            continue
        xs = [p[0] for p in line.poly]
        ys = [p[1] for p in line.poly]
        box_w_px = max(xs) - min(xs)
        box_h_px = max(ys) - min(ys)
        if box_w_px <= 0 or box_h_px <= 0:
            continue  # degenerate box - skip rather than divide by zero

        x0_pt, y0_pt = _pixel_to_pdf_point(
            min(xs), max(ys), img_w_px, img_h_px, page_w_pt, page_h_pt,
            page_left_pt, page_bottom_pt,
        )
        box_w_pt = box_w_px * (page_w_pt / img_w_px)
        box_h_pt = box_h_px * (page_h_pt / img_h_px)

        font_size = max(box_h_pt, 1.0)
        text_width = c.stringWidth(line.text, font_name, font_size)
        h_scale = 100.0 * (box_w_pt / text_width) if text_width > 0 else 100.0
        h_scale = max(1.0, min(h_scale, 1000.0))  # guard pathological ratios

        text_obj = c.beginText(x0_pt, y0_pt)
        text_obj.setFont(font_name, font_size)
        text_obj.setTextRenderMode(3)  # invisible
        text_obj.setHorizScale(h_scale)
        text_obj.textOut(line.text)
        c.drawText(text_obj)

    c.showPage()
    c.save()
    buf.seek(0)
    return PdfReader(buf)


def embed_text_layer(
    pdf_bytes: bytes,
    pages_lines: list[list[RecognizedLine]],
    pages_pixel_size: list[tuple[float, float]],
) -> bytes | None:
    """Return new PDF bytes with an invisible, searchable text layer merged
    onto each page - or `None` if `pdf_bytes` already carries the marker
    (the caller should then skip writing a new PDF).

    Merges onto the existing page content; never rebuilds it, so the page's
    existing image and quality are untouched.

    Raises `ValueError` if `pages_lines`/`pages_pixel_size` don't each carry
    exactly one entry per page of `pdf_bytes`.
    """
    reader = PdfReader(BytesIO(pdf_bytes))
    if already_embedded(reader):
        return None

    page_count = len(reader.pages)
    if len(pages_lines) != page_count or len(pages_pixel_size) != page_count:
        raise ValueError(
            f"page count mismatch: PDF has {page_count} page(s), got "
            f"{len(pages_lines)} pages_lines and {len(pages_pixel_size)} "
            f"pages_pixel_size"
        )
    if page_count == 0:
        return None

    font_name = _ensure_font_registered()
    if font_name is None:
        raise RuntimeError("could not register the OCR text-layer font")

    writer = PdfWriter(clone_from=BytesIO(pdf_bytes))

    for i, page in enumerate(writer.pages):
        mediabox = page.mediabox
        page_size = (float(mediabox.width), float(mediabox.height))
        page_origin = (float(mediabox.left), float(mediabox.bottom))
        overlay = _make_overlay_page(
            pages_lines[i], pages_pixel_size[i], page_size, page_origin, font_name,
        )
        page.merge_page(overlay.pages[0])

    merged_metadata = dict(reader.metadata or {})
    merged_metadata[OCR_EMBED_MARKER_KEY] = OCR_EMBED_MARKER_VALUE
    writer.add_metadata(merged_metadata)

    out = BytesIO()
    writer.write(out)
    return out.getvalue()
