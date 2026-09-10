#!/usr/bin/env python3
"""
OCR script for Montenegrin / Balkan-language documents (Latin or Cyrillic script).
Works on a single image, an explicit list of page images, or a PDF (all pages).

Usage:
    python3 ocr.py image.jpg
    python3 ocr.py document.pdf
    python3 ocr.py document.pdf --pages page1.jpg page2.jpg ...

Output:
    Saves a readable .txt file next to the input (same name, .txt extension),
    with one recognized line per line of text, and page separators for
    multi-page input. When the input is a PDF, also embeds the recognized
    text into it as an invisible, searchable layer (same filename,
    overwritten in place) - unless that PDF already carries one, in which
    case the embed step is skipped (idempotent re-runs).

Contract (seam 4 - Native <-> Python): arguments in -> the .txt output file
(+, for a PDF input, the same PDF rewritten with an embedded text layer) +
a JSON summary on stdout; human-readable logs go to stderr. Exit codes:

    0  success
    1  bad input path, or an unexpected failure during OCR
    2  input converted to zero OCR-able pages (e.g. an empty PDF)

Requirements:
    pip install paddleocr paddlepaddle pypdfium2 pypdf reportlab
    No system dependency - see py/requirements.txt.
"""
import argparse
import logging
import time
from dataclasses import dataclass, field

import sys
from pathlib import Path

import numpy as np
import cv2
from PIL import Image
from paddleocr import PaddleOCR

from nbcg_pipeline import (
    LANG_SAMPLE_PAGES,
    ImageFilePages,
    worker_count,
    LanguageStrategy,
    PdfPages,
    apply_memory_cap,
    force_utf8_streams,
    print_summary,
    sample_indices,
)
# Direct submodule import, not re-exported from nbcg_pipeline's own __init__:
# pdf_text needs reportlab/pypdf, which none of the other scripts sharing
# this package (web.py/split_spreads.py/pdf_derive.py) should be forced to
# require just to import nbcg_pipeline at all. See nbcg_pipeline/__init__.py.
from nbcg_pipeline import device
from nbcg_pipeline.pdf_text import RecognizedLine, embed_text_layer

# Maximum virtual memory: 8 GB. Best-effort - see nbcg_pipeline.limits for
# why this is a no-op on Windows (this app's target OS has no POSIX rlimits;
# the job runner's own concurrency cap is the real memory control).
MAX_MEMORY = 8 * 1024 * 1024 * 1024


logger = logging.getLogger("ocr")


def log(msg):
    logger.info(msg)


# PaddleOCR models for the two scripts Montenegrin can use.
# rs_latin covers Latin-script Serbian/Montenegrin/Croatian/Bosnian.
# cyrillic covers Cyrillic-script Serbian/Montenegrin/Russian/Bulgarian/Ukrainian.
#
# EVERY model is named here, deliberately, including the ones PaddleOCR would
# pick on its own. Leaving one to the library's default cost a ~10x slowdown
# that took a full investigation to find: `ocr.py` pinned the detector and the
# cyrillic recognizer but not the Latin one, and when paddleocr 3.7.0 added
# PP-OCRv6 it re-routed every Latin-script language to the much heavier
# `PP-OCRv6_medium_rec` (see `_PPOCRV6_LANGS` in paddleocr/_pipelines/ocr.py).
# Nothing in this repo changed - `git log --follow py/ocr.py` shows this
# function was byte-identical to the initial commit - but a fresh
# `pip install` silently swapped the model underneath it.
#
# So: naming a model here is not redundancy, it is the guarantee. The version
# pins in py/requirements.txt are the second line of defence, not the first.
# Re-measure with py/tools/bench_ocr.py before changing any of these.
DET_MODEL = "PP-OCRv5_mobile_det"
REC_MODELS = {
    "rs_latin": "latin_PP-OCRv5_mobile_rec",
    "rs_cyrillic": "cyrillic_PP-OCRv5_mobile_rec",
}
PADDLE_LANGS = {"rs_latin": "rs_latin", "rs_cyrillic": "cyrillic"}

# Inference threads per OCR process. Measured, on 22 cores, one process per
# configuration, three real pages each:
#
#     threads   1      2      4      6      10     16
#     s/page    20.00  20.20  22.37  23.99  25.25  27.57
#
# Monotonically *worse* with more threads. These are small mobile models and
# the per-op parallelism never pays for the contention it creates, so the
# original value of 2 was right - the machine is used by running more items at
# once, not by giving one item more threads. Overridable with --cpu-threads,
# but re-measure with py/tools/bench_ocr.py before believing a bigger number
# will help.
DEFAULT_CPU_THREADS = 2

# Recognition batch size. `None` means "whatever PaddleOCR picks", which
# measured fastest: batching the detected lines more aggressively was slower,
# not faster (20.20 s/page at the library default, 21.88 at 16, 24.74 at 32).
DEFAULT_REC_BATCH_SIZE = None

_OCR_ENGINES = {}
_ENGINE_OPTIONS = {
    "cpu_threads": None,        # None = take it from the detected device
    "rec_batch_size": DEFAULT_REC_BATCH_SIZE,
    "textline_orientation": True,
    "prefer_gpu": True,
    # None = size it from the machine (nbcg_pipeline.workers).
    "workers": None,
}
# The device decision, made once on first use and then reused. Also flipped to
# a CPU choice permanently if a GPU engine turns out not to work, so a
# failure is paid once rather than per language.
_DEVICE: device.DeviceChoice | None = None


def configure_engines(*, cpu_threads=None, rec_batch_size=None,
                      textline_orientation=None, prefer_gpu=None,
                      workers=None):
    """Set the engine options used by every later `_get_engine`. Called once
    from `main` before any recognition starts; engines are cached, so changing
    these afterwards would not affect an engine already built."""
    if cpu_threads is not None:
        _ENGINE_OPTIONS["cpu_threads"] = cpu_threads
    if rec_batch_size is not None:
        _ENGINE_OPTIONS["rec_batch_size"] = rec_batch_size
    if textline_orientation is not None:
        _ENGINE_OPTIONS["textline_orientation"] = textline_orientation
    if prefer_gpu is not None:
        _ENGINE_OPTIONS["prefer_gpu"] = prefer_gpu
    if workers is not None:
        _ENGINE_OPTIONS["workers"] = workers


def _current_device() -> device.DeviceChoice:
    """The device to build engines on, probed once and logged once."""
    global _DEVICE
    if _DEVICE is None:
        _DEVICE = device.detect(prefer_gpu=_ENGINE_OPTIONS["prefer_gpu"])
        log(f"OCR device: {_DEVICE.describe()}")
    return _DEVICE


def _build_engine(lang, choice: device.DeviceChoice):
    # Only passed when set: PaddleOCR's own default measured fastest, and
    # passing None explicitly is not the same as leaving it alone.
    batch_size = _ENGINE_OPTIONS["rec_batch_size"]
    extra = {} if batch_size is None else {"text_recognition_batch_size": batch_size}
    threads = _ENGINE_OPTIONS["cpu_threads"] or choice.cpu_threads

    return PaddleOCR(
        lang=PADDLE_LANGS[lang],
        device=choice.device,
        text_detection_model_name=DET_MODEL,
        text_recognition_model_name=REC_MODELS[lang],
        **extra,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        # Corrects sideways text lines. Kept on by default: on upright book
        # scans it changed nothing measurable, but it is what saves a page
        # that was fed to the scanner rotated, and an unattended overnight
        # batch is exactly where nobody notices that happening.
        # --no-textline-orientation turns it off when the source is known to
        # be upright and the time matters more.
        use_textline_orientation=_ENGINE_OPTIONS["textline_orientation"],
        # Left off deliberately. It is PaddleOCR's own default and the obvious
        # speed lever, but on paddlepaddle 3.3.1 it raises
        # `NotImplementedError: (Unimplemented) ConvertPirAttribute2Run`
        # during inference - measured, and almost certainly why this was
        # switched off here in the first place. Re-test after any paddlepaddle
        # upgrade.
        enable_mkldnn=False,
        cpu_threads=threads,
    )


def _get_engine(lang):
    if lang not in _OCR_ENGINES:
        if lang not in REC_MODELS:
            raise ValueError(
                f"unknown OCR language {lang!r}; expected one of "
                f"{', '.join(sorted(REC_MODELS))}"
            )
        start = time.perf_counter()
        choice = _current_device()

        log(f"Loading OCR model ({lang}) on {choice.device}...")
        try:
            _OCR_ENGINES[lang] = _build_engine(lang, choice)
        except Exception as exc:
            # The rollback. A GPU can be advertised and still fail here - a
            # driver mismatch, no free VRAM, a CUDA runtime the wheel wasn't
            # built against. None of that should end an overnight batch when
            # the CPU path works, so take the loss once, remember it, and
            # carry on. A CPU failure is genuine and re-raises.
            if choice.device == "cpu":
                raise
            global _DEVICE
            _DEVICE = device.cpu_fallback(f"{type(exc).__name__}: {exc}")
            log(f"OCR device: {_DEVICE.describe()}")
            _OCR_ENGINES[lang] = _build_engine(lang, _DEVICE)
            choice = _DEVICE

        elapsed = time.perf_counter() - start
        log(
            f"{lang} model ready ({elapsed:.1f}s) - device={choice.device}, "
            f"det={DET_MODEL}, rec={REC_MODELS[lang]}, "
            f"threads={_ENGINE_OPTIONS['cpu_threads'] or choice.cpu_threads}"
        )

    return _OCR_ENGINES[lang]


def _ocr_with_lang(image, lang):
    engine = _get_engine(lang)

    log(f"Running OCR ({lang})...")

    start = time.perf_counter()

    results = engine.predict(image)

    elapsed = time.perf_counter() - start

    if not results:
        log(f"{lang}: no text found ({elapsed:.1f}s)")
        return [], 0.0

    res = results[0]

    texts = res["rec_texts"]
    scores = res["rec_scores"]
    polys = res["rec_polys"]

    avg_score = sum(scores) / len(scores) if scores else 0

    log(
        f"{lang}: {len(texts)} lines, "
        f"avg confidence={avg_score:.3f}, "
        f"time={elapsed:.1f}s"
    )

    return list(zip(polys, texts, scores)), avg_score


def _page_ocr_call(prepared_image):
    """Bind one prepared page array into the `ocr_one(lang)` shape that
    `LanguageStrategy` calls, so the policy never touches an engine."""
    def ocr_one(lang):
        return _ocr_with_lang(prepared_image, lang)
    return ocr_one


def _sort_lines_reading_order(lines):
    """Sort detected lines top-to-bottom, then left-to-right, using the
    top-left corner of each detection box. Groups lines into rows based
    on vertical proximity so a readable multi-line txt is produced."""
    if not lines:
        return []

    # box points: [[x1,y1],[x2,y1],[x2,y2],[x1,y2]]
    enriched = []
    for box, text, score in lines:
        y_center = sum(p[1] for p in box) / 4
        x_left = min(p[0] for p in box)
        enriched.append((y_center, x_left, text))

    enriched.sort(key=lambda t: (t[0], t[1]))

    # Group into rows: lines whose y_center is close together are one row
    rows = []
    current_row = [enriched[0]]
    row_height_threshold = 15  # pixels; adjust if lines get merged/split wrongly

    for item in enriched[1:]:
        if abs(item[0] - current_row[-1][0]) <= row_height_threshold:
            current_row.append(item)
        else:
            rows.append(current_row)
            current_row = [item]
    rows.append(current_row)

    out_lines = []
    for row in rows:
        row.sort(key=lambda t: t[1])  # left to right
        out_lines.append(" ".join(t[2] for t in row))

    return out_lines


def _pil_to_bgr(pil_image):
    """Convert a PIL image (RGB) to a numpy BGR array, as expected by PaddleOCR."""
    rgb = np.array(pil_image.convert("RGB"))
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def prepare_page(pil_image):
    """The exact array OCR will see for one page: BGR, and size-capped.

    Done once per page here rather than inside `_ocr_with_lang`, for two
    reasons. It would otherwise be repeated per language on every retry; and,
    more importantly, the caller needs to know the *resulting* pixel
    dimensions - detection polygons come back in this array's coordinate
    space, and `nbcg_pipeline.pdf_text.embed_text_layer` positions the
    searchable text layer by scaling those against the pixel size it is
    handed. Capping the image while still reporting the original size would
    put every embedded line in the wrong place.
    """
    return limit_image_size(_pil_to_bgr(pil_image))


def limit_image_size(image, max_pixels=12000000):
    h, w = image.shape[:2]

    pixels = h * w

    if pixels <= max_pixels:
        return image

    scale = (max_pixels / pixels) ** 0.5

    new_w = int(w * scale)
    new_h = int(h * scale)

    log(
        f"Resizing image "
        f"{w}x{h} -> {new_w}x{new_h}"
    )

    return cv2.resize(
        image,
        (new_w, new_h),
        interpolation=cv2.INTER_AREA
    )

def ocr_image(image, langs=("rs_latin", "rs_cyrillic"), page_label=None):
    """OCR a single standalone image, trying each language and keeping the
    best-scoring result. Returns (lines, confidence, raw_lines): `lines` are
    reading-order-sorted text lines (for the .txt output); `raw_lines` are
    the winning language's (poly, text, score) triples in detection order
    (for building a positioned, searchable text layer - see
    nbcg_pipeline.pdf_text).

    Multi-page input does *not* come through here - it goes via
    `LanguageStrategy`, which runs one script per page instead of all of
    them. Trying every language is only affordable when there is exactly one
    image, where there is no sample to detect a dominant script from.
    """
    best_lines = []
    best_score = -1.0
    best_lang = None

    for lang in langs:
        lines, score = _ocr_with_lang(image, lang)

        if score > best_score:
            best_lines = lines
            best_score = score
            best_lang = lang

    log(
        f"{page_label or 'image'}: using {best_lang} "
        f"(avg confidence {best_score:.3f})"
    )

    return _sort_lines_reading_order(best_lines), max(best_score, 0.0), best_lines




@dataclass
class OcrResult:
    """process_file's return value - named fields read better than a bare
    tuple now that there's a 4th, optional one."""
    output_text: Path
    output_pdf: Path | None
    pages: int
    avg_confidence: float
    language: str = ""
    pages_retried: int = 0


def _raw_lines_to_recognized(raw_lines) -> list[RecognizedLine]:
    return [
        RecognizedLine(poly=tuple((float(x), float(y)) for x, y in box), text=text)
        for box, text, _score in raw_lines
    ]


def process_file(
    input_path, langs, *, out_dir: Path | None = None, pages: list[str] | None = None,
) -> OcrResult:
    """OCR `input_path` (or, when `pages` is given, that explicit ordered
    list of page-image files instead - `input_path` is then only used to
    name the outputs and, for a PDF, as the embed target) and return an
    `OcrResult`.

    Writes `<input-stem>.txt` next to the input by default; `out_dir`, when
    given, writes it (and, for a PDF input, `<input-stem>.pdf` with an
    embedded text layer) there instead - the job runner uses this to stage
    into a temp location it then renames into place itself, for atomic
    writes."""
    input_path = Path(input_path)
    if not input_path.exists():
        raise FileNotFoundError(f"file not found: {input_path}")

    ext = input_path.suffix.lower()
    dest_dir = out_dir if out_dir is not None else input_path.parent
    output_text_path = dest_dir / (input_path.stem + ".txt")

    all_text_blocks = []
    scores: list[float] = []
    pages_lines: list[list[RecognizedLine]] = []
    pages_pixel_size: list[tuple[int, int]] = []

    # A page source, not a materialized list: pages are produced one at a
    # time so a long book's memory stays flat (see nbcg_pipeline.pages).
    page_images = None
    if pages:
        log(f"OCR-ing {len(pages)} source image(s) directly (no PDF rasterization)")
        page_images = ImageFilePages(pages)
    elif ext == ".pdf":
        log(f"Rasterizing PDF pages on demand: {input_path}")
        page_images = PdfPages(input_path)

    strategy = LanguageStrategy(langs, log=log)

    try:
        return _process_pages(
            input_path=input_path,
            ext=ext,
            dest_dir=dest_dir,
            output_text_path=output_text_path,
            page_images=page_images,
            pages=pages,
            strategy=strategy,
            langs=langs,
            all_text_blocks=all_text_blocks,
            scores=scores,
            pages_lines=pages_lines,
            pages_pixel_size=pages_pixel_size,
        )
    finally:
        if page_images is not None:
            page_images.close()


# ── parallel page recognition ────────────────────────────────────────────────
#
# One item used to be one process using two cores of twenty-two. PaddleOCR's
# own threading measured worse the wider it got, so the machine is used by
# running several narrow recognition processes over different slices of the
# same book. See nbcg_pipeline/workers.py for the sizing.
#
# Each worker owns its engines, its page source and its own LanguageStrategy,
# seeded with the script the parent already detected. Nothing is shared, which
# is what makes this safe under Windows' spawn start method: a worker
# re-imports this module and builds its own state from picklable arguments.

_WORKER: dict = {}


def _worker_init(pages, pdf_path, langs, primary, options):
    """Build one worker's engines and page source, once, before any page."""
    force_utf8_streams()
    configure_engines(**options)
    _WORKER["pages"] = PdfPages(pdf_path) if pdf_path else ImageFilePages(pages)
    strategy = LanguageStrategy(langs)
    # The parent already paid for detection; inherit the answer rather than
    # each worker re-deciding it from its own slice.
    strategy.primary = primary
    _WORKER["strategy"] = strategy


def _worker_page(index):
    """Recognize one page. Returns only picklable data - no numpy arrays, no
    open images - so the parent can assemble pages in order cheaply."""
    source = _WORKER["pages"]
    strategy = _WORKER["strategy"]
    prepared = prepare_page(source[index])
    raw_lines, score, used, retried = strategy.run_page(_page_ocr_call(prepared))
    return (
        index,
        _sort_lines_reading_order(raw_lines),
        [
            (tuple((float(x), float(y)) for x, y in box), text)
            for box, text, _score in raw_lines
        ],
        score,
        used,
        retried,
        (prepared.shape[1], prepared.shape[0]),
    )


def _recognize_in_parallel(page_total, strategy, langs, workers, pages, pdf_path):
    """Run every page across `workers` processes, yielding results in order."""
    import multiprocessing as mp

    options = dict(
        cpu_threads=_ENGINE_OPTIONS["cpu_threads"],
        rec_batch_size=_ENGINE_OPTIONS["rec_batch_size"],
        textline_orientation=_ENGINE_OPTIONS["textline_orientation"],
        prefer_gpu=_ENGINE_OPTIONS["prefer_gpu"],
    )
    ctx = mp.get_context("spawn")
    log(f"Recognizing {page_total} page(s) across {workers} worker process(es)...")

    done = 0
    with ctx.Pool(
        processes=workers,
        initializer=_worker_init,
        initargs=(pages, pdf_path, langs, strategy.primary, options),
    ) as pool:
        # imap preserves order, so pages come back as a book rather than a
        # race; chunksize 1 keeps a slow page from stalling a whole chunk.
        for result in pool.imap(_worker_page, range(page_total), chunksize=1):
            done += 1
            if done % 10 == 0 or done == page_total:
                log(f"  {done}/{page_total} pages recognized")
            yield result


def _recognize_sequentially(page_images, page_total, strategy):
    """One process, in the same result shape the pool returns, so the assembly
    loop has exactly one form to handle.

    Used for short items, where a worker cannot pay back the cost of loading
    the recognition models.
    """
    for index in range(page_total):
        log(f"Processing page {index + 1}/{page_total}...")
        prepared = prepare_page(page_images[index])
        raw_lines, score, used, retried = strategy.run_page(
            _page_ocr_call(prepared)
        )
        log(
            f"page {index + 1}: using {used} (avg confidence {score:.3f})"
            + (" [retried]" if retried else "")
        )
        yield (
            index,
            _sort_lines_reading_order(raw_lines),
            [
                (tuple((float(x), float(y)) for x, y in box), text)
                for box, text, _score in raw_lines
            ],
            score,
            used,
            retried,
            (prepared.shape[1], prepared.shape[0]),
        )


def _process_pages(
    *,
    input_path,
    ext,
    dest_dir,
    output_text_path,
    page_images,
    pages,
    strategy,
    langs,
    all_text_blocks,
    scores,
    pages_lines,
    pages_pixel_size,
) -> OcrResult:
    """The body of `process_file`, split out only so the page source can be
    closed in a `finally` without indenting the whole thing."""
    # Workers open their own page source rather than receiving one: a live
    # PdfPages holds a pdfium handle, which is neither picklable nor safe to
    # share across processes. Both are picklable descriptions instead.
    pdf_path = str(input_path) if (not pages and ext == ".pdf") else None
    if page_images is not None:
        log(f"Found {len(page_images)} page(s).")

        # Detection runs both languages over the sampled pages, and those
        # pages are then recognized again in the loop below. On a long book
        # that is a rounding error (5 sampled pages against several hundred).
        # On a short one it is most of the work, and pointless: with no more
        # pages than the sample, every page would be seen by both languages
        # anyway, so the per-page retry alone reaches the same answer for the
        # same cost. Measured on a 2-page document, detection was doing 4 of
        # the 7 total recognitions.
        if strategy.multilingual and len(page_images) > LANG_SAMPLE_PAGES:
            indices = sample_indices(len(page_images))
            log(f"Detecting dominant script from page(s) {[i + 1 for i in indices]}...")
            strategy.detect(
                _page_ocr_call(prepare_page(page_images[i])) for i in indices
            )
        elif strategy.multilingual:
            log(
                f"{len(page_images)} page(s) - skipping the detection sample; "
                "the per-page retry decides each page on its own."
            )

        page_total = len(page_images)
        workers = worker_count(page_total, requested=_ENGINE_OPTIONS["workers"])
        retried_pages = 0

        if workers > 1:
            # The parent's own page source is not used while the pool runs -
            # each worker opens its own - so release it first. On Windows a
            # PDF still held open here could not be rewritten by the embed
            # step later.
            page_images.close()
            results = _recognize_in_parallel(
                page_total, strategy, langs, workers, pages, pdf_path
            )
        else:
            results = _recognize_sequentially(page_images, page_total, strategy)

        for index, lines, recognized, score, used, retried, size in results:
            if retried:
                retried_pages += 1
            scores.append(score)
            all_text_blocks.append(f"--- Page {index + 1} ---\n" + "\n".join(lines))
            pages_lines.append(
                [RecognizedLine(poly=poly, text=text) for poly, text in recognized]
            )
            # The prepared array's dimensions, not the original PIL size: the
            # polygons above are in that space, and pdf_text scales them
            # against whatever size it is given here.
            pages_pixel_size.append(size)
        strategy.pages_retried = retried_pages
        page_count = page_total
        # Release the source before the embed step below. Without --out-dir
        # the embedded PDF is written back over `input_path` itself, and on
        # Windows that is the same file pypdfium2 still has open. Nothing
        # below needs pages any more - embedding works from the recognized
        # lines and their pixel sizes. close() is idempotent, so the caller's
        # `finally` remains a correct safety net.
        page_images.close()
    else:
        log(f"Processing image: {input_path}")
        lines, score, _raw_lines = ocr_image(str(input_path), langs=langs)
        scores.append(score)
        all_text_blocks.append("\n".join(lines))
        page_count = 1

    final_text = "\n\n".join(all_text_blocks)

    dest_dir.mkdir(parents=True, exist_ok=True)
    output_text_path.write_text(final_text, encoding="utf-8")
    log(f"Done. Text saved to: {output_text_path}")

    avg_confidence = sum(scores) / len(scores) if scores else 0.0

    # Embed the recognized text into the PDF itself - only when `input_path`
    # actually is one (true whether OCR read it via --pages or rasterized it
    # directly) and there's something to embed. Best-effort: a failure here
    # must not lose the .txt output already written above, and must not be
    # treated as a stage failure (see ocr.py's own seam-4 contract notes) -
    # so this is deliberately a separate, local try/except from main()'s.
    output_pdf_path: Path | None = None
    if ext == ".pdf" and page_count > 0:
        try:
            embedded = embed_text_layer(input_path.read_bytes(), pages_lines, pages_pixel_size)
            if embedded is not None:
                output_pdf_path = dest_dir / (input_path.stem + ".pdf")
                output_pdf_path.write_bytes(embedded)
                log(f"Embedded searchable text layer -> {output_pdf_path}")
            else:
                log("PDF already carries an embedded OCR text layer; skipping re-embed.")
        except Exception as exc:
            log(f"Could not embed searchable text layer (continuing without it): {exc}")

    return OcrResult(
        output_text=output_text_path,
        output_pdf=output_pdf_path,
        pages=page_count,
        avg_confidence=avg_confidence,
        language=strategy.primary,
        pages_retried=strategy.pages_retried,
    )


@dataclass
class OcrSummary:
    """The JSON payload written to stdout - additional to the .txt (and,
    for a PDF input, the embedded-text .pdf) output, not a replacement."""
    input: str = ""
    output_text: str = ""
    output_pdf: str | None = None
    pages: int = 0
    avg_confidence: float = 0.0
    memory_cap_applied: bool = False
    elapsed_seconds: float = 0.0
    # Which script won, and how many pages had to be run twice to find out -
    # the direct cost signal for the language strategy, so the retry rate on
    # real material is visible rather than assumed.
    language: str = ""
    pages_retried: int = 0
    errors: list[str] = field(default_factory=list)


def _resolve_pages(args):
    """The page list, from `--pages-file` if given, else `--pages`.

    The file wins because the job runner always uses it: a page list is
    unbounded in length and a command line is not.
    """
    if not args.pages_file:
        return args.pages
    path = Path(args.pages_file)
    lines = path.read_text(encoding="utf-8").splitlines()
    pages = [line.strip() for line in lines if line.strip()]
    log(f"Read {len(pages)} page path(s) from {path}")
    return pages or None


def main() -> int:
    force_utf8_streams()
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stderr,
    )

    parser = argparse.ArgumentParser()

    parser.add_argument("input")

    parser.add_argument(
        "--lang",
        nargs="+",
        default=["rs_latin", "rs_cyrillic"],
        help="PaddleOCR language code(s), e.g. rs_latin rs_cyrillic",
    )
    parser.add_argument(
        "--out-dir",
        type=str,
        default=None,
        help="Write the .txt (and, for a PDF, the embedded-text .pdf) output "
             "into this directory instead of next to the input (the job "
             "runner uses this for atomic writes).",
    )
    parser.add_argument(
        "--pages",
        nargs="+",
        default=None,
        metavar="FILE",
        help="Exact ordered list of source page-image files to OCR directly, "
             "instead of rasterizing `input` (which must still be given, and "
             "still names the outputs, and - if it is a PDF - is still the "
             "file the recognized text gets embedded into). Lets a caller "
             "that already has the original scan images (the job runner, "
             "from ItemRunRequest.pageImages) hand them over directly rather "
             "than this script rasterizing input.pdf back into images.",
    )
    parser.add_argument(
        "--pages-file",
        default=None,
        metavar="FILE",
        help="A UTF-8 text file holding one page-image path per line - the "
             "same list as --pages, passed out of band. Windows caps a whole "
             "command line at 32767 characters, and a 522-page book's paths "
             "come to about 52000, so passing them as arguments fails "
             "outright on exactly the long books that most need OCR. Blank "
             "lines are ignored. Takes precedence over --pages.",
    )
    parser.add_argument(
        "--cpu-threads",
        type=int,
        default=None,
        help=f"Inference threads per OCR process (default {DEFAULT_CPU_THREADS}). "
             "More is measurably slower, not faster: on 22 cores this went "
             "20.0s/page at 1 thread to 27.6s at 16. Use more of the machine "
             "by running more items at once instead.",
    )
    parser.add_argument(
        "--rec-batch-size",
        type=int,
        default=DEFAULT_REC_BATCH_SIZE,
        help="How many detected text lines are recognized per batch. "
             "Default is PaddleOCR's own choice, which measured fastest - "
             "forcing 16 or 32 was slower.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=None,
        help="Recognition worker processes (default: sized from the machine). "
             "One process used two cores of twenty-two, because PaddleOCR's "
             "own threading measures worse the wider it gets - the machine is "
             "used by running several narrow processes over slices of the "
             "same document instead.",
    )
    parser.add_argument(
        "--no-gpu",
        action="store_true",
        help="Never try the GPU, even if one is present. OCR always falls "
             "back to the CPU by itself when the GPU cannot be used, so this "
             "is only needed to skip the probe entirely.",
    )
    parser.add_argument(
        "--no-textline-orientation",
        action="store_true",
        help="Skip the per-line orientation classifier. Faster, but a page "
             "scanned sideways will not be corrected - only use it when the "
             "source is known to be upright.",
    )

    args = parser.parse_args()

    langs = tuple(args.lang)
    out_dir = Path(args.out_dir) if args.out_dir else None
    try:
        pages = _resolve_pages(args)
    except OSError as exc:
        # Before the summary object exists, so report it the same way main's
        # own error path would rather than dying without one.
        log(f"Error: {exc}")
        print_summary(OcrSummary(input=str(args.input), errors=[str(exc)]))
        return 1
    configure_engines(
        cpu_threads=args.cpu_threads,
        rec_batch_size=args.rec_batch_size,
        textline_orientation=not args.no_textline_orientation,
        prefer_gpu=not args.no_gpu,
        workers=args.workers,
    )

    start = time.perf_counter()
    log("Starting OCR")

    memory_cap_applied = apply_memory_cap(MAX_MEMORY)
    log(f"Memory cap applied: {memory_cap_applied}")

    summary = OcrSummary(input=str(args.input), memory_cap_applied=memory_cap_applied)

    try:
        result = process_file(args.input, langs, out_dir=out_dir, pages=pages)
    except Exception as exc:  # keep the seam-4 contract: always a parseable summary
        log(f"Error: {exc}")
        summary.errors.append(str(exc))
        summary.elapsed_seconds = time.perf_counter() - start
        print_summary(summary)
        return 1

    summary.output_text = str(result.output_text)
    summary.output_pdf = str(result.output_pdf) if result.output_pdf else None
    summary.pages = result.pages
    summary.avg_confidence = result.avg_confidence
    summary.language = result.language
    summary.pages_retried = result.pages_retried
    summary.elapsed_seconds = time.perf_counter() - start

    log(f"Finished in {summary.elapsed_seconds:.1f} seconds")
    print_summary(summary)

    return 2 if result.pages == 0 else 0


if __name__ == "__main__":
    sys.exit(main())
