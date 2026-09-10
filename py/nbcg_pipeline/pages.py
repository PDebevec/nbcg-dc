"""Page images produced one at a time, instead of all at once.

`ocr.py` used to rasterize an entire PDF up front - `[render(i) for i in
range(len(document))]` - before recognizing a single page. At OCR-quality DPI
one A5 page is roughly 13 MB as RGB, so a 391-page book needed several GB
resident before any work started. That is fine on a developer's machine with
one small test file and catastrophic for the thing this app is actually for:
an unattended overnight batch, where nobody is watching it fail.

Both sources here expose the same tiny protocol - `len()`, `[i]`, `close()` -
so the caller does not care whether pages come from image files or from a
PDF. Neither caches: `[i]` really does produce the page each time it is
asked. That is deliberate. Script detection samples a handful of interior
pages and the recognition loop then asks for them again, and re-rendering
five pages costs far less than recognizing them - whereas a cache would
quietly reintroduce exactly the growth this module exists to remove.

Kept out of `ocr.py` so it is testable: `ocr.py` cannot be imported without
paddleocr, which is not installed under the interpreter that runs the test
suite, so anything living there is skipped rather than checked. pypdfium2 is
imported lazily inside `PdfPages`, so importing this module (and therefore
the package) still costs nothing but Pillow - `web.py` and `split_spreads.py`
must not be made to require a PDF library they never use. See
`nbcg_pipeline/__init__.py` for the same trap hit the hard way with
`pdf_text`.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image

# Longest side, in pixels, that a PDF page is rasterized to for OCR.
#
# This replaces a fixed 300 DPI, which was quietly the single biggest waste in
# the whole OCR path. The PDF that gets OCR'd is the *web* PDF, already
# downscaled to `images.WEB_MAX_DIMENSION` (1600px) when it was built. A
# 432x768pt page rendered at 300 DPI comes out 1797x3200 = 5.8 MP - four times
# the pixels of the 1.4 MP image actually embedded in it, and 2.5x the
# original 2.3 MP scan. Every one of those extra pixels is interpolation:
# no more information, but OCR cost scales with pixel count.
#
# Rendering to the page's real content size instead is strictly better -
# nothing is lost, because the detail was never there to begin with.
# Deliberately equal to WEB_MAX_DIMENSION: the web PDF is built at that cap,
# so this renders it at exactly 1:1.
OCR_MAX_DIMENSION = 1600

# Guard rails on the derived scale, mirroring pdf_derive.py's. A page whose
# media box is tiny (or absurd) must not produce a scale that either upsamples
# wildly or collapses the page to nothing.
MIN_RENDER_SCALE = 0.1
MAX_RENDER_SCALE = 4.0


class ImageFilePages:
    """Pages read straight from image files, in the order given."""

    def __init__(self, paths):
        self._paths: list[Path] = []
        for p in paths:
            p = Path(p)
            if not p.is_file():
                raise FileNotFoundError(f"page image not found: {p}")
            self._paths.append(p)

    def __len__(self) -> int:
        return len(self._paths)

    def __getitem__(self, index: int) -> Image.Image:
        return Image.open(self._paths[index])

    def close(self) -> None:
        """Nothing to release - `__getitem__` hands out an independent
        image each time and the caller owns it."""


class PdfPages:
    """Pages rasterized from a PDF, on demand.

    The pdfium document stays open for the life of this object - that is a
    file handle and a parsed page tree, not bitmaps - so `close()` matters,
    and callers should close it as soon as the last page is read rather than
    only at the end. On Windows a PDF that is still open cannot be rewritten
    in place, which is exactly what OCR's text-layer embedding does when no
    separate output directory was given.
    """

    def __init__(self, pdf_path, max_dimension: int = OCR_MAX_DIMENSION):
        # Lazy, so importing this module doesn't drag pypdfium2 into scripts
        # that never touch a PDF (see the module docstring).
        import pypdfium2 as pdfium

        self._max_dimension = max_dimension
        self._document = pdfium.PdfDocument(str(pdf_path))

    def _scale_for(self, page) -> float:
        """The scale putting this page's longest side at `max_dimension`.

        Per page rather than once for the document: a PDF can mix page sizes
        (a plate, a fold-out), and a single scale derived from the first page
        would then over- or under-render the rest.
        """
        width_pt, height_pt = page.get_size()
        longest = max(width_pt, height_pt)
        if longest <= 0:
            return 1.0
        return max(
            MIN_RENDER_SCALE, min(MAX_RENDER_SCALE, self._max_dimension / longest)
        )

    def __len__(self) -> int:
        return len(self._document)

    def __getitem__(self, index: int) -> Image.Image:
        if self._document is None:
            raise ValueError("this PdfPages has been closed")
        if not 0 <= index < len(self._document):
            raise IndexError(index)
        page = self._document[index]
        image = page.render(scale=self._scale_for(page)).to_pil()
        return image if image.mode == "RGB" else image.convert("RGB")

    def close(self) -> None:
        """Idempotent - callers close early *and* in a `finally`."""
        if self._document is not None:
            self._document.close()
            self._document = None
