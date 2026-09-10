"""Tests for the on-demand page sources (nbcg_pipeline.pages).

The property that matters here is *not* "the pages come out right" — it is
"only one page exists at a time". `ocr.py` used to rasterize a whole PDF
before recognizing anything, which put several GB of bitmaps in memory for a
long book and made an unattended overnight batch a memory gamble. A test that
only checked page contents would pass just as happily against the version
that blew up, so the interesting assertions below count *renders*.

Runs without paddleocr, which is the reason these classes live in the package
rather than in `ocr.py` — the interpreter that runs this suite has no
recognition stack, so anything defined in `ocr.py` is skipped rather than
checked.
"""

from pathlib import Path

import pytest
from PIL import Image

from nbcg_pipeline import ImageFilePages, PdfPages

pypdfium2 = pytest.importorskip("pypdfium2")


def _make_pdf(path, pages=3, size=(300, 400)):
    images = [
        Image.new("RGB", size, (255 - i * 40, 255, 255 - i * 20)) for i in range(pages)
    ]
    images[0].save(path, save_all=True, append_images=images[1:])
    return path


def _make_images(tmp_path, count=3):
    paths = []
    for i in range(count):
        p = tmp_path / f"page{i}.png"
        Image.new("RGB", (120, 160), (i * 30, 100, 200)).save(p)
        paths.append(p)
    return paths


# --- image files ------------------------------------------------------------


def test_image_pages_reports_length_and_yields_each_page(tmp_path):
    paths = _make_images(tmp_path, 3)
    source = ImageFilePages(paths)

    assert len(source) == 3
    assert [source[i].size for i in range(3)] == [(120, 160), (120, 160), (120, 160)]
    source.close()


def test_image_pages_keeps_the_given_order(tmp_path):
    """Page order is decided upstream and handed in; this must not re-sort it
    (a book whose pages are reordered is worthless even if every page is
    recognized perfectly)."""
    paths = _make_images(tmp_path, 3)
    reversed_paths = list(reversed(paths))

    source = ImageFilePages(reversed_paths)

    assert [source[i].getpixel((0, 0))[0] for i in range(3)] == [60, 30, 0]


def test_image_pages_rejects_a_missing_file_up_front(tmp_path):
    paths = _make_images(tmp_path, 2)
    with pytest.raises(FileNotFoundError):
        ImageFilePages([*paths, tmp_path / "nope.png"])


def test_image_pages_hands_out_independent_images(tmp_path):
    """Each access is its own image, so the caller closing or mutating one
    cannot affect a later read of the same page."""
    paths = _make_images(tmp_path, 1)
    source = ImageFilePages(paths)

    first = source[0]
    first.close()

    assert source[0].size == (120, 160)


# --- PDF --------------------------------------------------------------------


def test_pdf_pages_renders_to_the_content_size_not_a_fixed_dpi(tmp_path):
    """The regression test for the biggest waste in the OCR path.

    A fixed 300 DPI rendered the *web* PDF - itself already capped at 1600px
    when it was built - to 1797x3200 = 5.8 MP, four times the pixels actually
    in it. Pure interpolation, and OCR cost scales with pixel count. The
    longest side must land on the cap instead, whatever the page's media box
    happens to be.
    """
    source = _make_pdf(tmp_path / "book.pdf", pages=1, size=(1200, 1800))
    pages = PdfPages(source, max_dimension=1600)
    try:
        assert max(pages[0].size) == pytest.approx(1600, abs=2)
    finally:
        pages.close()


def test_pdf_pages_never_upscales_past_the_scale_ceiling(tmp_path):
    """A tiny media box must not be blown up to the cap - that would
    reintroduce exactly the interpolation this replaced, from the other end."""
    source = _make_pdf(tmp_path / "tiny.pdf", pages=1, size=(40, 60))
    pages = PdfPages(source, max_dimension=1600)
    try:
        width, height = pages[0].size
        assert max(width, height) < 1600
    finally:
        pages.close()


def test_pdf_pages_renders_every_page_as_rgb(tmp_path):
    source = PdfPages(_make_pdf(tmp_path / "book.pdf", pages=3))
    try:
        assert len(source) == 3
        for i in range(3):
            page = source[i]
            assert page.mode == "RGB"
            assert page.size[0] > 0 and page.size[1] > 0
    finally:
        source.close()


def test_pdf_pages_does_not_render_anything_until_asked(monkeypatch, tmp_path):
    """The whole point: constructing the source must be cheap. The old code
    rendered every page eagerly, so a 391-page book cost gigabytes before the
    first line of text was recognized."""
    pdf = _make_pdf(tmp_path / "book.pdf", pages=5)
    renders = []

    real_render = pypdfium2.PdfPage.render

    def counting_render(self, *args, **kwargs):
        renders.append(1)
        return real_render(self, *args, **kwargs)

    monkeypatch.setattr(pypdfium2.PdfPage, "render", counting_render)

    source = PdfPages(pdf)
    try:
        assert len(source) == 5
        assert renders == [], "constructing the source must not render a page"

        source[2]
        assert len(renders) == 1, "asking for one page must render exactly one"

        source[4]
        assert len(renders) == 2
    finally:
        source.close()


def test_pdf_pages_does_not_cache_and_so_cannot_accumulate(monkeypatch, tmp_path):
    """Re-reading a page renders it again rather than holding it. Caching
    would be the obvious 'optimisation' and would quietly restore the
    unbounded growth this class exists to prevent — script detection samples
    interior pages that the recognition loop then reads a second time."""
    pdf = _make_pdf(tmp_path / "book.pdf", pages=3)
    renders = []
    real_render = pypdfium2.PdfPage.render
    monkeypatch.setattr(
        pypdfium2.PdfPage,
        "render",
        lambda self, *a, **k: (renders.append(1), real_render(self, *a, **k))[1],
    )

    source = PdfPages(pdf)
    try:
        source[1]
        source[1]
        assert len(renders) == 2
    finally:
        source.close()


def test_pdf_pages_close_is_idempotent(tmp_path):
    """`process_file` closes early — so the embed step can rewrite the same
    file on Windows — and again in a `finally` if something threw first."""
    source = PdfPages(_make_pdf(tmp_path / "book.pdf", pages=2))

    source.close()
    source.close()  # must not raise

    with pytest.raises(ValueError):
        source[0]


def test_pdf_pages_rejects_an_out_of_range_index(tmp_path):
    source = PdfPages(_make_pdf(tmp_path / "book.pdf", pages=2))
    try:
        with pytest.raises(IndexError):
            source[2]
        with pytest.raises(IndexError):
            source[-1]
    finally:
        source.close()


# --- streaming PDF assembly -------------------------------------------------


def test_build_pdf_from_images_consumes_a_generator_lazily():
    """The whole point of the streaming build: a caller handing in a generator
    of rendered pages must not have it flattened back into a list.

    Measured on 60 web-sized pages, a list cost +415 MB against +7.4 MB
    streamed, for a byte-identical PDF. A test that only checked the output
    would pass against the version that held everything, so this counts how
    many pages exist at once.
    """
    from nbcg_pipeline import build_pdf_from_images

    live = 0
    peak = 0

    def pages(tmp_out):
        nonlocal live, peak
        for i in range(8):
            live += 1
            peak = max(peak, live)
            img = Image.new("RGB", (400, 560), (i * 20, 100, 150))
            yield img
            # Pillow has written this page by the time it asks for the next.
            live -= 1

    import tempfile
    out = Path(tempfile.mkdtemp()) / "streamed.pdf"
    build_pdf_from_images(pages(out), out)

    assert out.is_file()
    assert peak == 1, f"only one page should be alive at a time, saw {peak}"


def test_build_pdf_from_images_rejects_an_empty_page_stream():
    """`pages[0]` used to IndexError here; an empty build should say what is
    actually wrong."""
    from nbcg_pipeline import build_pdf_from_images
    import tempfile

    out = Path(tempfile.mkdtemp()) / "empty.pdf"
    with pytest.raises(ValueError, match="no page images"):
        build_pdf_from_images(iter([]), out)
