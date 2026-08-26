"""Post-refactor regression check: split_spreads.py now imports natural_key /
find_images / force_utf8_streams / print_summary from nbcg_pipeline instead
of keeping its own copies. This pins that its behavior is unchanged."""

import json
import subprocess
import sys
from pathlib import Path

from PIL import Image

SCRIPT = Path(__file__).resolve().parent.parent / "split_spreads.py"


def _run(folder: Path, *extra_args: str) -> tuple[int, dict]:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(folder), *extra_args],
        capture_output=True,
        encoding="utf-8",
    )
    return result.returncode, json.loads(result.stdout)


def test_splits_landscape_spread_and_copies_portrait_single(tmp_path):
    folder = tmp_path / "book"
    folder.mkdir()
    # landscape spread (aspect >= 1.15) with a dark gutter band at the centre
    spread = Image.new("RGB", (200, 100), "white")
    for x in range(95, 105):
        for y in range(100):
            spread.putpixel((x, y), (0, 0, 0))
    spread.save(folder / "1.jpg")
    # portrait single page
    Image.new("RGB", (100, 150), "white").save(folder / "2.jpg")

    exit_code, summary = _run(folder)

    assert exit_code == 0
    assert summary["images_found"] == 2
    assert summary["spreads_split"] == 1
    assert summary["singles_copied"] == 1
    assert summary["pages_written"] == 3  # 2 split halves + 1 single
    assert summary["gutter_detected"] == 1

    out_dir = folder / "split"
    assert (out_dir / "1_1.jpg").exists()
    assert (out_dir / "1_2.jpg").exists()
    assert (out_dir / "2.jpg").exists()


def test_originals_never_modified(tmp_path):
    folder = tmp_path / "book"
    folder.mkdir()
    Image.new("RGB", (100, 150), "white").save(folder / "1.jpg")
    original_bytes = (folder / "1.jpg").read_bytes()

    _run(folder)

    assert (folder / "1.jpg").read_bytes() == original_bytes


def test_cyrillic_folder_name_produces_valid_json(cyrillic_padded_flat_folder):
    exit_code, summary = _run(cyrillic_padded_flat_folder)

    assert exit_code == 0
    assert summary["images_found"] == 2


def test_pages_is_used_verbatim_instead_of_rediscovering_the_folder(tmp_path):
    """The caller's order wins, even when it contradicts the natural sort -
    otherwise the page order would be decided in two places and could disagree."""
    folder = tmp_path / "book"
    folder.mkdir()
    for name in ("1.jpg", "2.jpg", "3.jpg"):
        Image.new("RGB", (100, 150), "white").save(folder / name)

    # Reversed, and one page deliberately left out.
    exit_code, summary = _run(folder, "--pages", "3.jpg", "1.jpg")

    assert exit_code == 0
    assert summary["images_found"] == 2
    assert summary["pages"] == ["3.jpg", "1.jpg"]
    assert not (folder / "split" / "2.jpg").exists()


def test_pages_entry_that_does_not_exist_is_reported_not_crashed_on(tmp_path):
    folder = tmp_path / "book"
    folder.mkdir()
    Image.new("RGB", (100, 150), "white").save(folder / "1.jpg")

    exit_code, summary = _run(folder, "--pages", "1.jpg", "nope.jpg")

    assert exit_code == 1
    assert any("nope.jpg" in e for e in summary["errors"])
    # The page that does exist is still processed.
    assert summary["pages"] == ["1.jpg"]


def test_no_images_found_exits_2(tmp_path):
    folder = tmp_path / "empty"
    folder.mkdir()

    exit_code, summary = _run(folder)

    assert exit_code == 2
    assert summary["images_found"] == 0
