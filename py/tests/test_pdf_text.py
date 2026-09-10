"""Unit tests for nbcg_pipeline.pdf_text — the invisible, searchable OCR
text-layer embedding. Needs only pypdf/reportlab, not paddleocr: this
module is deliberately independent of the OCR stack itself (see its own
module docstring), so these tests exercise it directly with synthetic
recognition results rather than a real OCR pass.
"""
from io import BytesIO

import pytest
from PIL import Image

pypdf = pytest.importorskip("pypdf")
pytest.importorskip("reportlab")

from nbcg_pipeline.pdf_text import (
    OCR_EMBED_MARKER_KEY,
    OCR_EMBED_MARKER_VALUE,
    RecognizedLine,
    _pixel_to_pdf_point,
    already_embedded,
    embed_text_layer,
)


def _make_pdf_bytes(colors: list[tuple[int, int, int]], size=(1200, 1800)) -> bytes:
    """A PDF with one page per colour, at a realistic scan resolution —
    mirrors test_pdf_derive.py's _make_pdf."""
    pages = [Image.new("RGB", size, c) for c in colors]
    buf = BytesIO()
    pages[0].save(buf, format="PDF", save_all=True, append_images=pages[1:], resolution=300)
    for p in pages:
        p.close()
    return buf.getvalue()


def _line(text: str, box=(100, 100, 400, 160)) -> RecognizedLine:
    x0, y0, x1, y1 = box
    return RecognizedLine(poly=((x0, y0), (x1, y0), (x1, y1), (x0, y1)), text=text)


def test_embedded_text_is_extractable_by_pypdf():
    pdf_bytes = _make_pdf_bytes([(220, 20, 20)])

    out = embed_text_layer(pdf_bytes, [[_line("Hello world")]], [(1200, 1800)])

    assert out is not None
    reader = pypdf.PdfReader(BytesIO(out))
    assert "Hello world" in reader.pages[0].extract_text()


def test_cyrillic_text_round_trips():
    """reportlab's built-in fonts have no Cyrillic glyphs — this is the
    regression test for the vendored DejaVu Sans font/registration."""
    pdf_bytes = _make_pdf_bytes([(220, 20, 20)])

    out = embed_text_layer(pdf_bytes, [[_line("Пример текста")]], [(1200, 1800)])

    reader = pypdf.PdfReader(BytesIO(out))
    assert "Пример текста" in reader.pages[0].extract_text()


def test_second_embed_is_skipped():
    pdf_bytes = _make_pdf_bytes([(220, 20, 20)])
    lines = [[_line("Once")]]

    once = embed_text_layer(pdf_bytes, lines, [(1200, 1800)])
    assert once is not None

    twice = embed_text_layer(once, lines, [(1200, 1800)])
    assert twice is None


def test_already_embedded_is_detected():
    pdf_bytes = _make_pdf_bytes([(220, 20, 20)])
    assert already_embedded(pypdf.PdfReader(BytesIO(pdf_bytes))) is False

    embedded = embed_text_layer(pdf_bytes, [[_line("x")]], [(1200, 1800)])
    reader = pypdf.PdfReader(BytesIO(embedded))
    assert already_embedded(reader) is True
    assert reader.metadata[OCR_EMBED_MARKER_KEY] == OCR_EMBED_MARKER_VALUE


def test_page_count_mismatch_raises():
    pdf_bytes = _make_pdf_bytes([(220, 20, 20), (20, 220, 20)])  # 2 pages

    with pytest.raises(ValueError):
        embed_text_layer(pdf_bytes, [[_line("only one page worth of lines")]], [(1200, 1800)])


def test_pixel_to_pdf_point_flips_y_and_scales():
    # A 1200x1800px image mapped onto a 600x900pt page (exact half-scale).
    # Top-left pixel (0, 0) -> the page's top-left corner: x=0, y=page height.
    assert _pixel_to_pdf_point(0, 0, 1200, 1800, 600, 900) == pytest.approx((0, 900))

    # Bottom-right pixel -> the page's bottom-right corner: x=page width, y=0.
    assert _pixel_to_pdf_point(1200, 1800, 1200, 1800, 600, 900) == pytest.approx((600, 0))

    # Center pixel -> the page center.
    assert _pixel_to_pdf_point(600, 900, 1200, 1800, 600, 900) == pytest.approx((300, 450))


def test_overlay_does_not_alter_existing_page_image_bytes():
    pdf_bytes = _make_pdf_bytes([(220, 20, 20)])
    before = list(pypdf.PdfReader(BytesIO(pdf_bytes)).pages[0].images)[0].image.convert("RGB")

    out = embed_text_layer(pdf_bytes, [[_line("Hello")]], [(1200, 1800)])

    after = list(pypdf.PdfReader(BytesIO(out)).pages[0].images)[0].image.convert("RGB")
    assert before.size == after.size
    assert before.tobytes() == after.tobytes()
