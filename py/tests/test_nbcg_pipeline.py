"""Unit tests for the shared nbcg_pipeline helpers - fast, no image I/O
beyond what the fixtures already write, and no heavy OCR dependencies."""

import sys
from pathlib import Path

from nbcg_pipeline import apply_memory_cap, find_images, force_utf8_streams, is_skippable


def test_find_images_natural_sort(unpadded_flat_folder):
    names = [p.name for p in find_images(unpadded_flat_folder, {".jpg"})]
    assert names == ["1.jpg", "2.jpg", "10.jpg"]


def test_find_images_excludes_os_artifacts(unpadded_flat_folder):
    names = [p.name for p in find_images(unpadded_flat_folder, {".jpg"})]
    assert "Thumbs.db" not in names


def test_find_images_excludes_variant_and_non_image(variant_flat_folder):
    names = [p.name for p in find_images(variant_flat_folder, {".jpg"})]
    assert names == ["SP_001.jpg", "SP_002.jpg"]
    assert "SP_001 (Small).jpg" not in names
    assert "existing.pdf" not in names


def test_find_images_natural_sort_zero_padded(cyrillic_padded_flat_folder):
    names = [p.name for p in find_images(cyrillic_padded_flat_folder, {".jpg"})]
    assert names == ["000.jpg", "001.jpg"]


def test_find_images_on_missing_folder(tmp_path):
    assert find_images(tmp_path / "does-not-exist") == []


def test_is_skippable_thumbs_db(tmp_path):
    assert is_skippable(tmp_path / "Thumbs.db")
    assert is_skippable(tmp_path / "thumbs.DB")


def test_is_skippable_variant_suffix(tmp_path):
    assert is_skippable(tmp_path / "SP_001 (Small).jpg")
    assert is_skippable(tmp_path / "page (Preview).png")
    assert not is_skippable(tmp_path / "SP_001.jpg")


def test_apply_memory_cap_noop_when_resource_missing(monkeypatch):
    monkeypatch.setitem(sys.modules, "resource", None)
    assert apply_memory_cap(1024) is False


def test_force_utf8_streams_does_not_raise():
    # Real regression: this used to be missing entirely, and a Cyrillic
    # summary would crash the process on a legacy Windows code page.
    force_utf8_streams()
