"""Tests for OCR worker sizing (nbcg_pipeline.workers).

Recognition was using two cores of twenty-two: one item is one process, and
PaddleOCR's own threading measures *worse* the wider it gets, so the only way
to use a large machine is several narrow processes over slices of the same
document. These pin the three ceilings that "use all the cores" has to
survive - cores, memory, and whether there is enough work to be worth it.

Pure arithmetic, so none of this spawns anything.
"""

import pytest

from nbcg_pipeline import slice_pages, worker_count
from nbcg_pipeline.workers import (
    MIN_PAGES_PER_WORKER,
    RESERVED_MB,
    THREADS_PER_WORKER,
    WORKER_FOOTPRINT_MB,
)

BIG_RAM = 64_000


def test_scales_with_cores_not_beyond_what_each_worker_can_use():
    """Workers are narrow on purpose - `THREADS_PER_WORKER` each - because
    PaddleOCR got slower the more threads one process was given."""
    assert worker_count(1000, cores=22, memory_mb=BIG_RAM) == 22 // THREADS_PER_WORKER
    assert worker_count(1000, cores=8, memory_mb=BIG_RAM) == 8 // THREADS_PER_WORKER


def test_a_single_core_machine_still_gets_one_worker():
    assert worker_count(1000, cores=1, memory_mb=BIG_RAM) == 1


def test_memory_caps_the_core_count():
    """A worker holds ~500 MB. Sizing purely off cores on a memory-poor
    machine would swap, which is far worse than being slow."""
    roomy = worker_count(1000, cores=64, memory_mb=BIG_RAM)
    cramped = worker_count(1000, cores=64, memory_mb=RESERVED_MB + WORKER_FOOTPRINT_MB * 3)

    assert cramped == 3
    assert cramped < roomy


def test_memory_below_one_worker_still_yields_one():
    assert worker_count(1000, cores=64, memory_mb=RESERVED_MB) == 1


def test_a_short_item_does_not_get_a_worker_per_page():
    """Every worker loads the recognition models from scratch. Slicing a
    five-page item across eleven processes spends more on loading than on
    reading, so the page count is its own ceiling."""
    assert worker_count(5, cores=22, memory_mb=BIG_RAM) == 1
    assert worker_count(MIN_PAGES_PER_WORKER * 3, cores=22, memory_mb=BIG_RAM) == 3


def test_an_explicit_request_wins_but_is_still_held_to_the_page_floor():
    assert worker_count(1000, requested=3, cores=22, memory_mb=BIG_RAM) == 3
    # Asking for 16 on a 3-page item would spend it all loading models.
    assert worker_count(3, requested=16, cores=22, memory_mb=BIG_RAM) == 1


def test_a_zero_or_negative_request_falls_back_to_sizing():
    assert worker_count(1000, requested=0, cores=8, memory_mb=BIG_RAM) == 4
    assert worker_count(1000, requested=-2, cores=8, memory_mb=BIG_RAM) == 4


def test_no_pages_is_not_a_crash():
    assert worker_count(0, cores=22, memory_mb=BIG_RAM) == 1


# --- slicing ----------------------------------------------------------------


def test_slices_cover_every_page_exactly_once_and_in_order():
    """A book whose pages are dropped or reordered is worthless however well
    each page is recognized."""
    slices = slice_pages(50, 7)

    flat = [i for s in slices for i in s]
    assert flat == list(range(50))


def test_slices_are_contiguous_runs():
    """Contiguous, not round-robin: a worker carries its own sticky language
    decision, and neighbouring pages are the ones most likely to share a
    script. Round-robin would make that adaptation noise."""
    for run in slice_pages(50, 7):
        assert run == list(range(run[0], run[-1] + 1))


def test_slices_are_balanced_to_within_one_page():
    sizes = [len(s) for s in slice_pages(50, 7)]

    assert max(sizes) - min(sizes) <= 1


def test_more_workers_than_pages_yields_no_empty_slice():
    """An empty slice would spawn a process that loads the models and then
    does nothing at all."""
    slices = slice_pages(3, 11)

    assert all(len(s) > 0 for s in slices)
    assert sum(len(s) for s in slices) == 3


@pytest.mark.parametrize("pages", [0, -1])
def test_nothing_to_slice(pages):
    assert slice_pages(pages, 4) == []
