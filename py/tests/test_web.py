"""Integration smoke tests for web.py's flat and paired branches, run via
subprocess (exercising the real seam-4 CLI contract, not just internal
functions).

Where it matters most - page ordering - these go further than counting pages
and actually decode the built PDF's page images (via pypdf, a test-only
dependency; the scripts themselves don't need it) to confirm the pages landed
in the right order, not just that the right number of them exist.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

pypdf = pytest.importorskip("pypdf")

SCRIPT = Path(__file__).resolve().parent.parent / "web.py"


def _run(folder: Path, *extra_args: str) -> tuple[int, dict]:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(folder), *extra_args],
        capture_output=True,
        encoding="utf-8",
    )
    assert result.stdout, f"no stdout; stderr was:\n{result.stderr}"
    return result.returncode, json.loads(result.stdout)


def _pdf_page_red_channels(pdf_path: Path) -> list[int]:
    reader = pypdf.PdfReader(str(pdf_path))
    values = []
    for page in reader.pages:
        images = list(page.images)
        assert images, f"page has no embedded image in {pdf_path}"
        pil_img = images[0].image.convert("RGB")
        values.append(pil_img.getpixel((0, 0))[0])
    return values


def test_flat_folder_natural_page_order(tmp_path):
    """The exact bug this whole fix chain exists for: lexicographic sort
    would order these as 1, 10, 2 - a shuffled book."""
    folder = tmp_path / "CERNAGORA"
    folder.mkdir()
    # distinct solid colors per page, named so lexicographic != natural order
    Image.new("RGB", (80, 120), (10, 0, 0)).save(folder / "1.jpg")
    Image.new("RGB", (80, 120), (20, 0, 0)).save(folder / "2.jpg")
    Image.new("RGB", (80, 120), (100, 0, 0)).save(folder / "10.jpg")

    exit_code, summary = _run(folder)

    assert exit_code == 0
    target = summary["targets"][0]
    assert target["mode"] == "flat"
    assert target["pages"] == 3

    reds = _pdf_page_red_channels(folder / "CERNAGORA.pdf")
    assert reds == pytest.approx([10, 20, 100], abs=8)


def test_flat_folder_outputs_no_archival_pdf(unpadded_flat_folder):
    exit_code, summary = _run(unpadded_flat_folder)

    assert exit_code == 0
    names = sorted(p.name for p in unpadded_flat_folder.iterdir())
    assert "CERNAGORA.pdf" in names
    assert "CERNAGORA_thumb.png" in names
    assert not any(n.endswith("_archive.pdf") for n in names)

    thumb = Image.open(unpadded_flat_folder / "CERNAGORA_thumb.png")
    assert thumb.format == "PNG"


def test_flat_folder_excludes_variants_and_stray_pdf(variant_flat_folder):
    exit_code, summary = _run(variant_flat_folder)

    assert exit_code == 0
    target = summary["targets"][0]
    assert target["pages"] == 2  # SP_001.jpg, SP_002.jpg only


def test_cyrillic_folder_produces_valid_json_and_correct_names(
    cyrillic_padded_flat_folder,
):
    exit_code, summary = _run(cyrillic_padded_flat_folder)

    assert exit_code == 0
    names = sorted(p.name for p in cyrillic_padded_flat_folder.iterdir())
    assert "ОКТОИХ петогласник 2.pdf" in names
    assert "ОКТОИХ петогласник 2_thumb.png" in names


def test_paired_folder_produces_all_three_correctly_named(paired_folder):
    exit_code, summary = _run(paired_folder)

    assert exit_code == 0
    target = summary["targets"][0]
    assert target["mode"] == "paired"

    names = sorted(p.name for p in paired_folder.iterdir() if p.is_file())
    assert "PairedItem_archive.pdf" in names
    assert "PairedItem.pdf" in names
    assert "PairedItem_thumb.png" in names

    thumb = Image.open(paired_folder / "PairedItem_thumb.png")
    assert thumb.format == "PNG"


def test_recursive_does_not_double_process_paired_subfolders(paired_folder):
    """A paired folder's own jpg/tif subfolders must not also be picked up
    as separate flat targets during a recursive walk."""
    root = paired_folder.parent
    exit_code, summary = _run(root, "--recursive")

    assert exit_code == 0
    assert len(summary["targets"]) == 1
    assert summary["targets"][0]["folder"] == str(paired_folder)


def test_no_matching_folder_exits_2(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()

    exit_code, summary = _run(empty)

    assert exit_code == 2
    assert summary["targets"] == []


def test_mode_flat_forces_the_shape_instead_of_auto_detecting(unpadded_flat_folder):
    exit_code, summary = _run(unpadded_flat_folder, "--mode", "flat")

    assert exit_code == 0
    assert summary["targets"][0]["mode"] == "flat"
    assert (unpadded_flat_folder / "CERNAGORA.pdf").exists()


def test_mode_paired_forces_the_shape_instead_of_auto_detecting(paired_folder):
    exit_code, summary = _run(paired_folder, "--mode", "paired")

    assert exit_code == 0
    assert summary["targets"][0]["mode"] == "paired"
    assert (paired_folder / "PairedItem_archive.pdf").exists()


def test_mode_flat_forced_on_an_empty_folder_errors_clearly_not_a_crash(tmp_path):
    empty = tmp_path / "EMPTY"
    empty.mkdir()

    exit_code, summary = _run(empty, "--mode", "flat")

    # Forced mode always yields exactly one target - the folder is real, the
    # caller was just wrong about its shape, so this is a per-target failure
    # (exit 1), not "nothing found" (exit 2).
    assert exit_code == 1
    target = summary["targets"][0]
    assert target["mode"] == "flat"
    assert any("no JPG images" in e for e in target["errors"])


def test_mode_paired_forced_without_jpg_tif_subfolders_errors_clearly_not_a_crash(
    unpadded_flat_folder,
):
    exit_code, summary = _run(unpadded_flat_folder, "--mode", "paired")

    assert exit_code == 1
    target = summary["targets"][0]
    assert target["mode"] == "paired"
    assert any("no jpg/tif subfolders" in e for e in target["errors"])


def test_mode_rejects_recursive(tmp_path):
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(tmp_path), "--recursive", "--mode", "flat"],
        capture_output=True,
        encoding="utf-8",
    )
    assert result.returncode != 0
    assert "--mode" in result.stderr


def test_out_dir_writes_outputs_there_and_leaves_source_untouched(unpadded_flat_folder):
    staging = unpadded_flat_folder.parent / "staging"
    exit_code, summary = _run(unpadded_flat_folder, "--out-dir", str(staging))

    assert exit_code == 0
    assert (staging / "CERNAGORA.pdf").exists()
    assert (staging / "CERNAGORA_thumb.png").exists()
    source_names = {p.name for p in unpadded_flat_folder.iterdir()}
    assert "CERNAGORA.pdf" not in source_names
    assert "CERNAGORA_thumb.png" not in source_names


def test_out_dir_with_recursive_is_rejected(tmp_path):
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(tmp_path), "--recursive", "--out-dir", str(tmp_path / "out")],
        capture_output=True,
        encoding="utf-8",
    )
    assert result.returncode != 0
    assert "--out-dir" in result.stderr


def test_pages_flag_overrides_folder_scan_order(tmp_path):
    """The whole point of --pages: the caller's order wins, even if it
    disagrees with what a natural-sort re-scan of the folder would produce."""
    folder = tmp_path / "BOOK"
    folder.mkdir()
    Image.new("RGB", (80, 120), (10, 0, 0)).save(folder / "1.jpg")
    Image.new("RGB", (80, 120), (20, 0, 0)).save(folder / "2.jpg")

    # Deliberately reversed relative to natural order.
    exit_code, summary = _run(folder, "--pages", "2.jpg", "1.jpg")

    assert exit_code == 0
    assert summary["targets"][0]["pages"] == 2
    reds = _pdf_page_red_channels(folder / "BOOK.pdf")
    assert reds == pytest.approx([20, 10], abs=8)


def test_pages_flag_reports_missing_entries(tmp_path):
    folder = tmp_path / "BOOK"
    folder.mkdir()
    Image.new("RGB", (80, 120), "white").save(folder / "1.jpg")

    exit_code, summary = _run(folder, "--pages", "1.jpg", "missing.jpg")

    assert exit_code == 1, "a missing --pages entry is a real error"
    target = summary["targets"][0]
    assert target["pages"] == 1
    assert any("missing.jpg" in e for e in target["errors"])


def test_thumbnail_only_skips_pdf_assembly(unpadded_flat_folder):
    exit_code, summary = _run(unpadded_flat_folder, "--thumbnail-only")

    assert exit_code == 0
    names = {p.name for p in unpadded_flat_folder.iterdir()}
    assert "CERNAGORA_thumb.png" in names
    assert "CERNAGORA.pdf" not in names
    assert summary["targets"][0]["outputs"] == ["CERNAGORA_thumb.png"]


def test_thumbnail_source_overrides_the_natural_first_image(tmp_path):
    folder = tmp_path / "BOOK"
    folder.mkdir()
    Image.new("RGB", (80, 120), (10, 0, 0)).save(folder / "1.jpg")
    Image.new("RGB", (80, 120), (20, 0, 0)).save(folder / "thumbnail.jpg")

    exit_code, summary = _run(folder, "--thumbnail-source", "thumbnail.jpg")

    assert exit_code == 0
    thumb = Image.open(folder / "BOOK_thumb.png").convert("RGB")
    assert thumb.getpixel((0, 0))[0] == pytest.approx(20, abs=8)
    # The PDF is unaffected - still built from the natural page order.
    reds = _pdf_page_red_channels(folder / "BOOK.pdf")
    assert reds[0] == pytest.approx(10, abs=8)


def test_thumbnail_source_falls_back_when_the_named_file_is_missing(unpadded_flat_folder):
    exit_code, summary = _run(unpadded_flat_folder, "--thumbnail-source", "does-not-exist.jpg")

    assert exit_code == 1, "a missing --thumbnail-source is a real error"
    target = summary["targets"][0]
    assert any("does-not-exist.jpg" in e for e in target["errors"])
    # Degrades gracefully rather than failing the whole folder.
    assert (unpadded_flat_folder / "CERNAGORA_thumb.png").exists()


def test_thumbnail_source_accepts_an_absolute_path_outside_the_processed_folder(tmp_path):
    """How the runner keeps a chosen thumbnail unsplit: the pages being
    assembled live in a staging folder, the thumbnail comes from the original."""
    pages = tmp_path / "staged-pages"
    pages.mkdir()
    Image.new("RGB", (80, 120), (10, 0, 0)).save(pages / "1.jpg")
    original = tmp_path / "source"
    original.mkdir()
    cover = original / "cover.jpg"
    Image.new("RGB", (80, 120), (200, 0, 0)).save(cover)

    exit_code, summary = _run(pages, "--thumbnail-source", str(cover))

    assert exit_code == 0
    assert not summary["targets"][0]["errors"]
    thumb = Image.open(pages / "staged-pages_thumb.png").convert("RGB")
    assert thumb.getpixel((0, 0))[0] == pytest.approx(200, abs=8)


def test_name_overrides_the_folder_derived_output_base(tmp_path):
    """The .ts lane decides the naming base (ItemRunRequest.folderName); this
    is what stops web.py re-deriving a second answer from the folder path - and
    what lets the runner assemble from a staging folder without the outputs
    being named after it."""
    pages = tmp_path / "staged-pages"
    pages.mkdir()
    Image.new("RGB", (80, 120), (10, 0, 0)).save(pages / "1.jpg")

    exit_code, summary = _run(pages, "--name", "ОКТОИХ петогласник 2")

    assert exit_code == 0
    assert (pages / "ОКТОИХ петогласник 2.pdf").exists()
    assert (pages / "ОКТОИХ петогласник 2_thumb.png").exists()
    assert not (pages / "staged-pages.pdf").exists()
    assert set(summary["targets"][0]["outputs"]) == {
        "ОКТОИХ петогласник 2.pdf",
        "ОКТОИХ петогласник 2_thumb.png",
    }


def test_name_rejects_recursive(tmp_path):
    """Every folder in the tree would write identically-named outputs, each
    overwriting the last."""
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(tmp_path), "--recursive", "--name", "X"],
        capture_output=True,
        encoding="utf-8",
    )

    assert result.returncode != 0
    assert "--name" in result.stderr


def test_thumbnail_only_on_paired_folder_skips_both_pdfs(paired_folder):
    exit_code, summary = _run(paired_folder, "--thumbnail-only")

    assert exit_code == 0
    names = {p.name for p in paired_folder.iterdir() if p.is_file()}
    assert "PairedItem_thumb.png" in names
    assert "PairedItem.pdf" not in names
    assert "PairedItem_archive.pdf" not in names
