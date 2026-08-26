"""ocr.py's cross-platform fix, verified without importing ocr.py itself.

ocr.py's top-level `from paddleocr import PaddleOCR` (and cv2/numpy) means the
module can't even be imported in an environment without the full OCR stack -
which is exactly the situation this fix needs to be verifiable in. So this
tests the extracted, dependency-free nbcg_pipeline.limits.apply_memory_cap
directly: that's where the actual cross-platform logic now lives, per
docs/tasks/py-real-data-mismatches.md item 5.

Anything that requires importing ocr.py itself is skipped here
(pytest.importorskip("paddleocr")) and is a residual gap: a real end-to-end
OCR run is still owed once a machine with paddleocr/paddlepaddle/pdf2image/
poppler installed is available.
"""

import sys

import pytest

from nbcg_pipeline.limits import apply_memory_cap


def test_noop_when_resource_module_absent(monkeypatch):
    """This is the actual Windows scenario: no `resource` module at all."""
    monkeypatch.setitem(sys.modules, "resource", None)
    assert apply_memory_cap(8 * 1024 * 1024 * 1024) is False


def test_applies_when_resource_available():
    pytest.importorskip("resource")
    # On a platform that does have `resource` (Linux/macOS/CI), the cap
    # should actually be applied, preserving pre-fix behavior there.
    assert apply_memory_cap(8 * 1024 * 1024 * 1024) is True


def test_returns_false_rather_than_raising_on_invalid_value():
    pytest.importorskip("resource")
    # A negative limit is rejected by setrlimit; this must degrade to False,
    # never propagate an exception up through a script's import/startup path.
    assert apply_memory_cap(-1) is False


def test_ocr_module_requires_paddleocr():
    """Documents the residual gap: importing ocr.py itself needs the full
    OCR stack, which this environment does not have. Real verification of
    ocr.py end-to-end is owed on a machine that does."""
    pytest.importorskip("paddleocr")
    import ocr  # noqa: F401 - only reached when paddleocr is installed
