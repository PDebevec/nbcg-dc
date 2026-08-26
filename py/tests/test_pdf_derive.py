"""Integration tests for pdf_derive.py — the supplied-PDF / multiple-PDFs
branch — run via subprocess, exercising the real seam-4 CLI contract.

Source PDFs are built in-test with Pillow rather than checked in as fixtures:
the properties under test (page count, page order, page size) all need to be
varied per test, and a binary fixture would hide them.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

pypdf = pytest.importorskip("pypdf")

SCRIPT = Path(__file__).resolve().parent.parent / "pdf_derive.py"

# Mirrors nbcg_pipeline.images.WEB_MAX_DIMENSION. Restated rather than imported
# so a change to the shared constant has to be made deliberately in both places,
# the same way py/tests already treats the naming convention.
WEB_MAX_DIMENSION = 1600


def _make_pdf(path: Path, colors: list[tuple[int, int, int]], size=(2400, 3600)) -> None:
    """A PDF with one page per colour, at a realistic scan resolution."""
    pages = [Image.new("RGB", size, c) for c in colors]
    pages[0].save(path, save_all=True, append_images=pages[1:], resolution=300)
    for p in pages:
        p.close()


def _run(source: Path, *extra_args: str) -> tuple[int, dict]:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(source), *extra_args],
        capture_output=True,
        encoding="utf-8",
    )
    assert result.stdout, f"no stdout; stderr was:\n{result.stderr}"
    return result.returncode, json.loads(result.stdout)


def _pdf_page_sizes(pdf_path: Path) -> list[tuple[int, int]]:
    reader = pypdf.PdfReader(str(pdf_path))
    sizes = []
    for page in reader.pages:
        images = list(page.images)
        assert images, f"page has no embedded image in {pdf_path}"
        sizes.append(images[0].image.size)
    return sizes


def _pdf_page_red_channels(pdf_path: Path) -> list[int]:
    reader = pypdf.PdfReader(str(pdf_path))
    values = []
    for page in reader.pages:
        images = list(page.images)
        assert images, f"page has no embedded image in {pdf_path}"
        values.append(images[0].image.convert("RGB").getpixel((10, 10))[0])
    return values


def test_derives_a_downscaled_web_pdf_keeping_every_page(tmp_path):
    source = tmp_path / "Писма из Лиона_(310).pdf"
    _make_pdf(source, [(220, 20, 20), (20, 220, 20), (20, 20, 220)])
    out = tmp_path / "out"

    exit_code, summary = _run(source, "--name", "Pisma iz Liona", "--out-dir", str(out))

    assert exit_code == 0
    assert not summary["errors"]
    assert summary["pages"] == 3

    # Named after --name, never after the source file.
    web_pdf = out / "Pisma iz Liona.pdf"
    assert web_pdf.exists()
    assert set(summary["outputs"]) == {"Pisma iz Liona.pdf", "Pisma iz Liona_thumb.png"}

    sizes = _pdf_page_sizes(web_pdf)
    assert len(sizes) == 3, "every page must survive the derive"
    for w, h in sizes:
        assert max(w, h) == WEB_MAX_DIMENSION, (
            f"page {w}x{h} was not downscaled to the web preview size"
        )


def test_page_order_is_preserved(tmp_path):
    source = tmp_path / "src.pdf"
    _make_pdf(source, [(220, 20, 20), (20, 220, 20), (20, 20, 220)])
    out = tmp_path / "out"

    _run(source, "--name", "BOOK", "--out-dir", str(out))

    reds = _pdf_page_red_channels(out / "BOOK.pdf")
    assert reds == pytest.approx([220, 20, 20], abs=12)


def test_thumbnail_comes_from_page_one(tmp_path):
    source = tmp_path / "src.pdf"
    # Page 1 red, page 2 blue — the thumbnail must be red.
    _make_pdf(source, [(220, 20, 20), (20, 20, 220)])
    out = tmp_path / "out"

    _run(source, "--name", "BOOK", "--out-dir", str(out))

    thumb = Image.open(out / "BOOK_thumb.png").convert("RGB")
    assert thumb.width == 500
    assert thumb.getpixel((250, 10))[0] == pytest.approx(220, abs=12)


def test_thumbnail_only_builds_no_pdf(tmp_path):
    source = tmp_path / "src.pdf"
    _make_pdf(source, [(220, 20, 20), (20, 20, 220)])
    out = tmp_path / "out"

    exit_code, summary = _run(
        source, "--name", "vol1", "--out-dir", str(out), "--thumbnail-only"
    )

    assert exit_code == 0
    assert summary["outputs"] == ["vol1_thumb.png"]
    assert (out / "vol1_thumb.png").exists()
    assert not (out / "vol1.pdf").exists()


def test_original_is_never_modified(tmp_path):
    source = tmp_path / "src.pdf"
    _make_pdf(source, [(220, 20, 20)])
    original_bytes = source.read_bytes()

    _run(source, "--name", "BOOK", "--out-dir", str(tmp_path / "out"))

    assert source.read_bytes() == original_bytes


def test_missing_source_is_a_clean_error_not_a_traceback(tmp_path):
    exit_code, summary = _run(tmp_path / "nope.pdf", "--name", "BOOK")

    assert exit_code == 1
    assert any("not found" in e for e in summary["errors"])


def test_unreadable_source_is_a_clean_error_not_a_traceback(tmp_path):
    source = tmp_path / "notreally.pdf"
    source.write_text("this is not a PDF", encoding="utf-8")

    exit_code, summary = _run(source, "--name", "BOOK")

    assert exit_code == 1
    assert summary["errors"], "a corrupt PDF must be reported in the summary"


def test_name_is_required(tmp_path):
    source = tmp_path / "src.pdf"
    _make_pdf(source, [(220, 20, 20)])

    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(source)],
        capture_output=True,
        encoding="utf-8",
    )

    assert result.returncode != 0
    assert "--name" in result.stderr


def test_cyrillic_source_and_name_produce_parseable_json(tmp_path):
    """Windows stdout defaults to a code page that cannot encode Cyrillic, and
    the summary carries both paths — the crash split_spreads.py hit for real."""
    source = tmp_path / "Писма из Лиона_(310).pdf"
    _make_pdf(source, [(220, 20, 20)])
    out = tmp_path / "out"

    exit_code, summary = _run(source, "--name", "ОКТОИХ петогласник 2", "--out-dir", str(out))

    assert exit_code == 0
    assert summary["name"] == "ОКТОИХ петогласник 2"
    assert (out / "ОКТОИХ петогласник 2.pdf").exists()
