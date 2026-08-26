"""Shared fixtures: synthetic folders reproducing the real corpus's
documented shapes (docs/05-real-scan-data.md), since no real scan corpus is
available in every environment this repo runs in.
"""

import sys
from pathlib import Path

import pytest
from PIL import Image

# Put py/ on sys.path so `import web`, `import split_spreads`,
# `import nbcg_pipeline` resolve the same way they do under script-path
# invocation (python py/web.py ...), without needing an installable package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _make_jpg(path: Path, size=(80, 120), color="white") -> None:
    Image.new("RGB", size, color).save(path)


@pytest.fixture
def unpadded_flat_folder(tmp_path: Path) -> Path:
    """CERNAGORA-shape: unpadded numbering incl. a two-digit page, plus a
    Windows Explorer artifact that must not be treated as a page."""
    folder = tmp_path / "CERNAGORA"
    folder.mkdir()
    for n in (1, 2, 10):
        _make_jpg(folder / f"{n}.jpg")
    (folder / "Thumbs.db").write_bytes(b"not an image")
    return folder


@pytest.fixture
def cyrillic_padded_flat_folder(tmp_path: Path) -> Path:
    """ОКТОИХ-shape: zero-padded numbering under a Cyrillic folder name -
    exactly the scenario that once crashed split_spreads.py on Windows."""
    folder = tmp_path / "ОКТОИХ петогласник 2"
    folder.mkdir()
    for n in (0, 1):
        _make_jpg(folder / f"{n:03d}.jpg", size=(200, 100))
    return folder


@pytest.fixture
def variant_flat_folder(tmp_path: Path) -> Path:
    """Pisma iz Liona-shape: prefixed+padded pages, a derived preview
    variant sitting beside a real page, and a stray pre-existing PDF."""
    folder = tmp_path / "Pisma iz Liona"
    folder.mkdir()
    for n in (1, 2):
        _make_jpg(folder / f"SP_{n:03d}.jpg")
    _make_jpg(folder / "SP_001 (Small).jpg", size=(10, 10))
    (folder / "existing.pdf").write_bytes(b"%PDF-1.4 not a real pdf")
    return folder


@pytest.fixture
def paired_folder(tmp_path: Path) -> Path:
    """A legacy jpg/+tif/ paired folder."""
    folder = tmp_path / "PairedItem"
    folder.mkdir()
    (folder / "jpg").mkdir()
    (folder / "tif").mkdir()
    for n in (1, 2):
        _make_jpg(folder / "jpg" / f"{n}.jpg")
        _make_jpg(folder / "tif" / f"{n}.tif")
    return folder
