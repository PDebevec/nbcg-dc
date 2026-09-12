#!/usr/bin/env python3
"""Benchmark `ocr.py`'s engine configuration against real page images.

Why this exists as a tracked tool rather than a throwaway script: every
decision in the OCR speed work is supposed to cite a measurement, and those
measurements have to be re-runnable after each change to prove the change
did what the table said it would.

It reports **time and quality together** - a configuration that halves the
runtime while quietly recognizing 30% fewer lines is a regression, not a
speedup, and that is only visible if both are printed side by side. Peak RSS
comes along too, because the setting this is mostly interrogating
(`cpu_threads`) was originally turned down to "limit CPU memory pressure",
and that claim deserves a number.

Usage:
    python py/tools/bench_ocr.py PAGE.jpg [PAGE.jpg ...]
    python py/tools/bench_ocr.py --quick PAGE.jpg ...      # baseline + key levers
    python py/tools/bench_ocr.py --dump-dir OUT PAGE.jpg ...  # save recognized text

Pick text-dense interior pages. Covers and blank pages recognize 0 lines and
carry no signal - they are what made an earlier, sloppier measurement of
this same question look 4x faster than reality.

Needs the full OCR stack (paddleocr + paddlepaddle), so it runs on the
vendored interpreter:
    src-tauri/binaries/python/python.exe py/tools/bench_ocr.py ...
"""
from __future__ import annotations

import argparse
import contextlib
import io
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

# Mirrors ocr.py: oneDNN reads OMP_NUM_THREADS, not `cpu_threads`, and it must
# be set before cv2/numpy/paddle load the OpenMP runtime. Without this the
# `threads` column below measures nothing once mkldnn is on.
os.environ.setdefault("OMP_NUM_THREADS", "2")

import cv2
import numpy as np
import psutil
from PIL import Image
from paddleocr import PaddleOCR

# Mirrors ocr.py's current _get_engine. Restated rather than imported: the
# point is to compare against what ships today, so this must not silently
# track edits to ocr.py while a comparison is in flight.
CURRENT_DET_MODEL = "PP-OCRv5_mobile_det"
CURRENT_CYRILLIC_REC = "cyrillic_PP-OCRv5_mobile_rec"
# What `lang="rs_latin"` resolves to on its own, via
# paddleocr/_pipelines/ocr.py: rs_latin is in LATIN_LANGS, hence _PPOCRV6_LANGS,
# hence PP-OCRv6. Nothing in ocr.py asks for this; it is the default leaking
# through because only the *detector* is pinned there.
CURRENT_LATIN_REC_EFFECTIVE = "PP-OCRv6_medium_rec"
# The mobile counterpart, i.e. what the cyrillic branch already pins.
CANDIDATE_LATIN_REC = "latin_PP-OCRv5_mobile_rec"

# Mirrors ocr.py: the detector cannot run under oneDNN, so PaddleX is told to
# fall back to the plain backend for it. Without this, every mkldnn config
# below dies in detection instead of measuring the recogniser.
try:
    from paddlex.inference.models.runners.paddle_static.config import blocklists

    if CURRENT_DET_MODEL not in blocklists.MKLDNN_BLOCKLIST:
        blocklists.MKLDNN_BLOCKLIST.append(CURRENT_DET_MODEL)
    ONEDNN_AVAILABLE = True
except Exception:
    ONEDNN_AVAILABLE = False


@dataclass(frozen=True)
class Config:
    """One point in the measurement matrix."""
    label: str
    lang: str = "rs_latin"
    threads: int = 2
    mkldnn: bool = True                # what ships; see ocr.py's ONEDNN note
    rec_model: str | None = None       # None = let paddleocr decide
    textline_ori: bool = True
    rec_batch: int | None = 32         # what ships; the library default is 1
    scale: float = 1.0


@dataclass
class Result:
    config: Config
    seconds: float = 0.0
    lines: float = 0.0
    confidence: float = 0.0
    peak_rss_mb: float = 0.0
    dims: tuple[int, int] = (0, 0)
    error: str | None = None
    texts: list[list[str]] = field(default_factory=list)


@contextlib.contextmanager
def _quiet():
    """PaddleOCR narrates model loading on stdout; keep the table readable."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        yield


def load_page(path: str, scale: float) -> tuple[np.ndarray, tuple[int, int]]:
    image = Image.open(path).convert("RGB")
    if scale != 1.0:
        w, h = image.size
        image = image.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    return cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR), image.size


def build_engine(config: Config) -> PaddleOCR:
    kwargs = dict(
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=config.textline_ori,
        enable_mkldnn=config.mkldnn,
        cpu_threads=config.threads,
        text_detection_model_name=CURRENT_DET_MODEL,
    )
    if config.lang == "rs_cyrillic":
        kwargs["lang"] = "cyrillic"
        kwargs["text_recognition_model_name"] = config.rec_model or CURRENT_CYRILLIC_REC
    else:
        kwargs["lang"] = "rs_latin"
        if config.rec_model:
            kwargs["text_recognition_model_name"] = config.rec_model
    if config.rec_batch is not None:
        kwargs["text_recognition_batch_size"] = config.rec_batch
    with _quiet():
        return PaddleOCR(**kwargs)


def run_config(config: Config, pages: list[str]) -> Result:
    result = Result(config=config)
    process = psutil.Process()

    try:
        engine = build_engine(config)
    except Exception as exc:  # a rejected model/param combination, not a crash
        result.error = f"{type(exc).__name__}: {exc}"
        return result

    images = []
    for page in pages:
        image, dims = load_page(page, config.scale)
        images.append(image)
        result.dims = dims

    # Warm-up: the first predict pays lazy graph/kernel init that has nothing
    # to do with per-page cost. Timing it would flatter every later config,
    # since the models stay cached process-wide.
    try:
        with _quiet():
            engine.predict(images[0])
    except Exception as exc:
        result.error = f"{type(exc).__name__}: {exc}"
        return result

    times, line_counts, confidences = [], [], []
    peak = process.memory_info().rss
    for image in images:
        started = time.perf_counter()
        with _quiet():
            predictions = engine.predict(image)
        times.append(time.perf_counter() - started)
        peak = max(peak, process.memory_info().rss)

        if predictions:
            texts = predictions[0]["rec_texts"]
            scores = predictions[0]["rec_scores"]
            line_counts.append(len(texts))
            confidences.append(sum(scores) / len(scores) if scores else 0.0)
            result.texts.append(list(texts))
        else:
            line_counts.append(0)
            confidences.append(0.0)
            result.texts.append([])

    result.seconds = sum(times) / len(times)
    result.lines = sum(line_counts) / len(line_counts)
    result.confidence = sum(confidences) / len(confidences)
    result.peak_rss_mb = peak / (1024 * 1024)
    return result


def matrix(quick: bool) -> list[Config]:
    """Ordered by measured impact, biggest first.

    oneDNN is no longer a dead lever, and the note that used to stand here
    was half right. It does crash on paddlepaddle 3.3.1 - but only in the
    *detector*. The recogniser, which is ~95% of the runtime, runs under it
    fine, so `ocr.py` now blocklists the detector and leaves oneDNN on. Both
    this module and `ocr.py` therefore default `mkldnn=True`.

    Two live consequences for anyone reading a table out of this tool:

    - the `threads` column only means something while OMP_NUM_THREADS is
      pinned (top of this file), because that, not `cpu_threads`, is what
      oneDNN honours;
    - **the batch-size rows must be re-measured.** Every batch number quoted
      in `ocr.py`'s history was taken with oneDNN off, where batching loses;
      with it on, batching wins by ~4x. Any conclusion about one of these
      settings that was reached without the other is void.
    """
    configs = [
        Config("baseline (what ships today)"),
        # The suspected regression: ocr.py pins the *detector* but lets the
        # recognizer default, and paddleocr 3.7.0 routes every Latin language
        # to the heavy PP-OCRv6_medium_rec. This is the v5 mobile recognizer
        # the cyrillic branch already pins - i.e. what the unpinned dependency
        # used to resolve to.
        Config("mobile rec (v5, matches cyrillic branch)",
               rec_model=CANDIDATE_LATIN_REC),
        Config("mobile rec, threads=10 (lib default)",
               rec_model=CANDIDATE_LATIN_REC, threads=10),
    ]
    if quick:
        return configs

    configs += [
        # Thread sweep. Do not assume "more cores, more threads": measured on
        # a 22-core machine, threads=10 came out *slower* than threads=2 and
        # threads=16 was catastrophic. These are small mobile models; the
        # per-op parallelism does not pay for the contention.
        Config("mobile rec, threads=1", rec_model=CANDIDATE_LATIN_REC, threads=1),
        Config("mobile rec, threads=4", rec_model=CANDIDATE_LATIN_REC, threads=4),
        Config("mobile rec, threads=6", rec_model=CANDIDATE_LATIN_REC, threads=6),
        Config("mobile rec, threads=16",
               rec_model=CANDIDATE_LATIN_REC, threads=16),
        # These vary one lever each against the *measured best* thread count,
        # not against threads=10 - pairing them with a thread setting that is
        # itself a regression would hide whether the lever helps.
        Config("mobile rec, t2, no textline-ori",
               rec_model=CANDIDATE_LATIN_REC, threads=2, textline_ori=False),
        Config("mobile rec, t2, rec batch=16",
               rec_model=CANDIDATE_LATIN_REC, threads=2, rec_batch=16),
        Config("mobile rec, t2, rec batch=32",
               rec_model=CANDIDATE_LATIN_REC, threads=2, rec_batch=32),
        Config("mobile rec, t2, scale=0.75",
               rec_model=CANDIDATE_LATIN_REC, threads=2, scale=0.75),
    ]
    return configs


def print_row(result: Result) -> None:
    config = result.config
    if result.error:
        print(f"{config.label:<40} {'FAILED':>10}  {result.error[:60]}", flush=True)
        return
    size = f"{result.dims[0]}x{result.dims[1]}"
    print(
        f"{config.label:<40} {result.seconds:8.2f}s "
        f"{result.lines:7.1f} {result.confidence:8.3f} "
        f"{result.peak_rss_mb:8.0f} {size:>12}",
        flush=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pages", nargs="+", help="text-dense page images")
    parser.add_argument("--quick", action="store_true",
                        help="baseline plus the three headline levers only")
    parser.add_argument("--dump-dir", default=None,
                        help="write each config's recognized text here, for diffing")
    parser.add_argument("--only", default=None, metavar="SUBSTRING",
                        help="run just the configs whose label contains this. "
                             "Every config in one invocation shares a process, "
                             "and engines are never released - measured for "
                             "real, later configs came out implausibly faster "
                             "than the same settings run first. Use --only, "
                             "once per config, whenever a number is going to "
                             "decide something.")
    parser.add_argument("--no-calibration", action="store_true",
                        help="skip the wrong-script calibration row")
    args = parser.parse_args()

    missing = [p for p in args.pages if not Path(p).is_file()]
    if missing:
        print(f"no such page image(s): {missing}", file=sys.stderr)
        return 1

    print(f"cores={os.cpu_count()}  pages={[Path(p).name for p in args.pages]}")
    print(f"{'config':<40} {'time/page':>9} {'lines':>7} {'conf':>8} "
          f"{'peakMB':>8} {'size':>12}")
    print("-" * 92)

    configs = matrix(args.quick)
    if args.only:
        configs = [c for c in configs if args.only.lower() in c.label.lower()]
        if not configs:
            print(f"no config label contains {args.only!r}", file=sys.stderr)
            return 1

    results = []
    for config in configs:
        result = run_config(config, args.pages)
        print_row(result)
        results.append(result)

    # Calibration for the per-page language fallback: what does the *wrong*
    # script score on these pages? The retry threshold in ocr.py should sit
    # between this and the right-script confidence, not at a guessed constant.
    wrong = None
    if not args.no_calibration:
        print("-" * 92)
        wrong = run_config(
            Config("wrong script (cyrillic on these pages)",
                   lang="rs_cyrillic", threads=10),
            args.pages,
        )
        print_row(wrong)

    ok = [r for r in results if not r.error]
    if ok:
        best = min(ok, key=lambda r: r.seconds)
        base = ok[0]
        print("-" * 92)
        print(f"fastest: {best.config.label}  "
              f"{base.seconds / best.seconds:.1f}x faster than baseline, "
              f"lines {base.lines:.1f} -> {best.lines:.1f}, "
              f"conf {base.confidence:.3f} -> {best.confidence:.3f}")
        print(f"391-page item: {base.seconds * 2 * 391 / 3600:.1f} h at baseline "
              f"(both languages) -> {best.seconds * 391 / 3600:.1f} h "
              f"(one language, fastest config)")

    if args.dump_dir:
        out = Path(args.dump_dir)
        out.mkdir(parents=True, exist_ok=True)
        for result in results + ([wrong] if wrong else []):
            if result.error:
                continue
            safe = "".join(c if c.isalnum() else "_" for c in result.config.label)
            blocks = [
                f"--- {Path(page).name} ---\n" + "\n".join(texts)
                for page, texts in zip(args.pages, result.texts)
            ]
            (out / f"{safe}.txt").write_text("\n\n".join(blocks), encoding="utf-8")
        print(f"\nrecognized text written to {out}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
