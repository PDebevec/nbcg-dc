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

# Resident set of one warmed-up worker. Used to keep a big core count from
# promising more workers than the machine has memory for.
#
# This was 500 MB, measured before oneDNN. It is now higher for two reasons
# that compound, and 500 was low enough to let the machine thrash:
#
#   - oneDNN roughly doubles a worker's resident set (342 MB -> ~660 MB
#     measured on the same page). The OMP_NUM_THREADS pin in `ocr.py` holds
#     that down; without it, budget more again.
#   - the PDF path is heavier than the page-image path. Each worker opens its
#     own pdfium handle and rasterises pages into it, so a long book read
#     straight from a large PDF sits well above a worker fed page images.
#
# Measured in the app, 11 workers on a 522-page 61 MB PDF: mean 643 MB, peak
# 745 MB. At the old 500 MB the ceiling below never bound, 11 workers were
# started, and the machine went to 0.7 GB free and ~1400 hard page faults per
# second - paging cost far more than the extra workers bought. Budget the
# peak, not the mean: the ceiling exists to stop exactly that.
WORKER_FOOTPRINT_MB = 800

# Leave this much for the OS, the app itself, and the parent process.
#
# Was 2048, which is not what this app actually leaves behind. Measured while
# OCR was running: 3.8 GB held by everything that is not a worker - the Tauri
# app, its WebView, the operator's browser, the parent python. Reserving less
# than that guarantees the shortfall comes out of the pagefile, which is what
# happened. This is a desktop tool someone is using while it runs, not a
# batch box, so the reservation has to cover the desktop.
RESERVED_MB = 4096

# Below this many pages a worker cannot pay for itself: each one loads the
# recognition models from scratch (a second or two), so slicing a five-page
# item eight ways spends more on model loading than on reading the pages.
MIN_PAGES_PER_WORKER = 8


def _available_memory_mb() -> int | None:
    """Memory this run can actually claim, or `None` when it cannot be
    determined - in which case the caller does not apply the memory ceiling.

    Deliberately `available`, not `total`. Sizing from total assumes the
    machine is otherwise idle, and it never is: the app, a WebView and a
    browser were holding 3.8 GB when this was measured, so a "15 GB" machine
    had about 11 GB to give. Total-based sizing put 11 workers on it, went to
    0.7 GB free, and spent the difference in the pagefile. `available` is what
    the operating system says can be handed out without paging, which is the
    question actually being asked here.
    """
    try:
        import psutil
    except Exception:
        return None
    try:
        return int(psutil.virtual_memory().available / (1024 * 1024))
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
    limit), so this is a ceiling rather than a promise.

    The memory ceiling is not a formality. Overshooting cores costs a little
    throughput; overshooting memory costs everything, because the machine
    starts paging and the workers spend their time waiting on disk instead of
    reading pages. That is not hypothetical - it is what eleven of these
    workers did to a 15 GB laptop once oneDNN raised the per-worker footprint.
    So when the two disagree, memory wins.
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
