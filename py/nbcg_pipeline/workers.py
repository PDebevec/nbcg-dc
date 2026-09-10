"""How many OCR worker processes to run, and how to slice pages between them.

Recognition is the pipeline's long pole and it was using two cores of
twenty-two: one item is one `ocr.py` process, and PaddleOCR's own threading
measured *worse* the more threads it was given (20.0 s/page at 1 thread,
27.6 s at 16 - see `ocr.py`). So the machine only gets used by running
several recognition processes at once, and until now that only happened
across *items*. A batch containing one 522-page book got one process.

Pure arithmetic, no multiprocessing here, so the sizing rules are testable
without spawning anything.
"""
from __future__ import annotations

import os

# Threads each worker's engine gets. Measured flat between 1 and 2 and worse
# above, so workers are deliberately narrow and numerous rather than few and
# wide - see `ocr.py`'s DEFAULT_CPU_THREADS.
THREADS_PER_WORKER = 2

# Resident set of one warmed-up worker, measured at roughly 400-500 MB across
# the benchmark runs. Used to keep a big core count from promising more
# workers than the machine has memory for.
WORKER_FOOTPRINT_MB = 500

# Leave this much for the OS, the app itself, and the parent process.
RESERVED_MB = 2048

# Below this many pages a worker cannot pay for itself: each one loads the
# recognition models from scratch (a second or two), so slicing a five-page
# item eight ways spends more on model loading than on reading the pages.
MIN_PAGES_PER_WORKER = 8


def _available_memory_mb() -> int | None:
    """Total system memory, or `None` when it cannot be determined - in which
    case the caller simply does not apply the memory ceiling."""
    try:
        import psutil
    except Exception:
        return None
    try:
        return int(psutil.virtual_memory().total / (1024 * 1024))
    except Exception:
        return None


def worker_count(
    page_count: int,
    requested: int | None = None,
    cores: int | None = None,
    memory_mb: int | None = None,
) -> int:
    """How many worker processes to use for `page_count` pages.

    `requested` (the `--workers` flag) wins, except that it is still held to
    the page-count floor - asking for sixteen workers on a three-page item
    would spend all of it loading models.

    With no request, use as much of the machine as the *measured* curve
    supports: one worker per `THREADS_PER_WORKER` cores. Throughput does
    flatten well before the core count (memory bandwidth, not cores, is the
    limit), so this is a ceiling rather than a promise - but leaving cores
    idle guarantees the slow case, and the flattening only wastes a little.
    """
    if page_count <= 0:
        return 1

    cores = cores or os.cpu_count() or 2
    by_cores = max(1, cores // THREADS_PER_WORKER)

    memory_mb = memory_mb if memory_mb is not None else _available_memory_mb()
    if memory_mb:
        by_memory = max(1, (memory_mb - RESERVED_MB) // WORKER_FOOTPRINT_MB)
        by_cores = min(by_cores, by_memory)

    wanted = requested if requested and requested > 0 else by_cores

    # Never more workers than there is work to keep them busy.
    by_pages = max(1, page_count // MIN_PAGES_PER_WORKER)
    return max(1, min(wanted, by_pages))


def slice_pages(page_count: int, workers: int) -> list[list[int]]:
    """Split page indices into one contiguous run per worker.

    Contiguous rather than round-robin on purpose: a worker keeps its own
    language decision as it goes (`LanguageStrategy`'s sticky primary), and
    neighbouring pages of a book are the ones most likely to share a script,
    so consecutive slices make that adaptation useful instead of noise.
    """
    if page_count <= 0:
        return []
    workers = max(1, min(workers, page_count))
    base, extra = divmod(page_count, workers)
    out: list[list[int]] = []
    start = 0
    for i in range(workers):
        size = base + (1 if i < extra else 0)
        out.append(list(range(start, start + size)))
        start += size
    return out
