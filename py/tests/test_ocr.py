"""Integration tests for ocr.py, run via subprocess against the real seam-4
CLI contract — mirrors test_pdf_derive.py's pattern.

Gated on paddleocr being importable: ocr.py's top-level `from paddleocr
import PaddleOCR` means the script can't even start without it, regardless
of which code path a given test actually exercises (see
test_ocr_platform.py's own docstring for the same reasoning).
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

pytest.importorskip("paddleocr")

SCRIPT = Path(__file__).resolve().parent.parent / "ocr.py"


def _run(input_path: Path, *extra_args: str) -> tuple[int, dict]:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(input_path), *extra_args],
        capture_output=True,
        encoding="utf-8",
    )
    assert result.stdout, f"no stdout; stderr was:\n{result.stderr}"
    return result.returncode, json.loads(result.stdout)


def test_corrupt_pdf_is_a_clean_error_not_a_traceback(tmp_path):
    """Task 1's regression test: any unexpected exception during OCR (not
    just a missing input path) must still produce a parseable JSON summary
    on stdout, never an uncaught traceback with nothing on stdout - the
    exact failure mode the real poppler-missing crash hit before this fix,
    now reproduced with an unparseable PDF instead (poppler is no longer a
    dependency at all after the pypdfium2 swap, so that specific exception
    is no longer reachable - this covers the general contract instead)."""
    bad_pdf = tmp_path / "not-really.pdf"
    bad_pdf.write_text("this is not a PDF", encoding="utf-8")

    returncode, summary = _run(bad_pdf)

    assert returncode == 1
    assert summary["errors"], "an unparseable PDF must be reported in the summary, not crash uncaught"


def test_pages_flag_ocrs_source_images_directly(tmp_path):
    """--pages bypasses PDF rasterization entirely - the runner uses this so
    OCR reads the original scans instead of round-tripping through the web
    PDF (and needs no poppler/pypdfium2 at all for this path). `input` must
    still be a real PDF: it's still the naming base and the embed target.

    Needs a working recognition *engine*, not just the paddleocr wrapper
    package - the PyPI package `paddlepaddle` imports as `paddle`, and has
    no published wheel for this machine's Python version at the time of
    writing, so this specific test is the one genuinely still owed "once on
    a machine with the full stack" (py/README.md's own standing caveat) -
    skip rather than fail when that backend isn't actually available."""
    pytest.importorskip("paddle")

    page1 = tmp_path / "page1.jpg"
    page2 = tmp_path / "page2.jpg"
    Image.new("RGB", (400, 600), (255, 255, 255)).save(page1)
    Image.new("RGB", (400, 600), (255, 255, 255)).save(page2)

    pdf_path = tmp_path / "book.pdf"
    pdf_pages = [Image.new("RGB", (400, 600), (255, 255, 255)) for _ in range(2)]
    pdf_pages[0].save(pdf_path, save_all=True, append_images=pdf_pages[1:])

    out = tmp_path / "out"
    returncode, summary = _run(
        pdf_path, "--pages", str(page1), str(page2), "--out-dir", str(out),
    )

    assert returncode == 0
    assert summary["pages"] == 2
    assert (out / "book.txt").exists()


def test_pages_file_carries_a_list_too_long_for_a_command_line(tmp_path):
    """Windows caps a whole command line at 32767 characters. One page path
    runs about 100, so a 522-page book comes to roughly 52000 and the spawn
    fails outright — on exactly the long books that most need OCR. The runner
    therefore passes the list out of band, and this proves a list far past
    that limit survives the trip, Cyrillic paths included.

    Deliberately paired with a missing input so it fails fast: the page list
    is resolved before any recognition starts, so the log line proves the file
    was read without paying for a real OCR run.
    """
    pages = [tmp_path / f"страница-{i:04d}.jpg" for i in range(500)]
    listing = tmp_path / "pages.txt"
    listing.write_text("\n".join(str(p) for p in pages), encoding="utf-8")
    assert sum(len(str(p)) + 3 for p in pages) > 32767, "fixture must exceed the limit"

    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(tmp_path / "missing.pdf"),
         "--pages-file", str(listing)],
        capture_output=True,
        encoding="utf-8",
    )

    assert "Read 500 page path(s)" in result.stderr
    assert json.loads(result.stdout)["errors"], "a missing input is still reported"


def test_pages_file_ignores_blank_lines(tmp_path):
    page = tmp_path / "1.jpg"
    page.write_bytes(b"")
    listing = tmp_path / "pages.txt"
    listing.write_text(f"\n{page}\n\n", encoding="utf-8")

    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(tmp_path / "missing.pdf"),
         "--pages-file", str(listing)],
        capture_output=True,
        encoding="utf-8",
    )

    assert "Read 1 page path(s)" in result.stderr
