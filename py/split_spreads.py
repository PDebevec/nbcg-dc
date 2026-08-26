#!/usr/bin/env python3
"""
split_spreads.py

Splits **two-page spreads** (two book pages photographed in one shot) into
single-page images.

Written for `nbcg_archive/scanned/ОКТОИХ петогласник 2`, where 162 scans are
uniformly landscape at ~1.41 aspect — i.e. two portrait pages side by side,
~324 pages in total. Books scanned one-page-at-a-time (`CERNAGORA`,
`Pisma iz Liona`) are portrait and are passed through untouched.

Standalone for now, run by hand on a folder. The intent (per Jernej, 2026-08-07)
is to fold it into the JPG/TIFF → PDF step later as an **invisible sub-step with
an on/off option**, not a separate visible pipeline stage — so the splitting
logic lives in `split_spread()` / `find_gutter()`, importable without the CLI.

## Contract (seam 4 — Native ↔ Python)

    python split_spreads.py <folder> [options]

Arguments in → output files on disk + a **JSON summary on stdout**; human-readable
logs go to **stderr**, so stdout stays machine-parseable. Exit codes:

    0  success (including "nothing needed splitting")
    1  error (bad folder, unreadable images)
    2  no images found

Originals are **never modified or deleted** — output goes to a separate folder
(default `<folder>/split`).

## Ordering

Images are discovered in **natural (numeric-aware) order**, so `2.jpg` sorts
before `10.jpg`. Plain lexicographic sorting shuffles a book
(`1, 10, 100, 2, …`), which is silent and ruinous — `web.py` used to do this
before both scripts moved onto the shared `nbcg_pipeline.find_images`.

`--pages` overrides discovery entirely with an exact ordered list. The job
runner passes `ItemRunRequest.pageImages` — the order the `.ts` lane already
computed — so that order is decided once and not re-derived here; `Summary.pages`
then carries the resulting split-page order onward to `web.py --pages`.

Each spread yields `<stem>_1` (left) and `<stem>_2` (right), reversed with
`--rtl` for right-to-left scripts. Keeping the source stem makes every output
traceable to the scan it came from.

## Gutter detection

A naive split down the exact middle cuts text whenever the book was not centred
under the camera. The binding gutter is normally a **dark vertical band** (its
shadow), so we take a downscaled greyscale copy, average each column's luminance
within a window around the centre, and split at the darkest column. If the
profile is too flat to be a real gutter (`--min-contrast`), we fall back to the
exact middle and say so in the summary. `--no-gutter-detect` forces the middle.

## Verified (2026-08-07, Python 3.14.7 + Pillow 12.3.0, Windows)

Run over the whole of `ОКТОИХ петогласник 2`: **162 images → 321 pages** in ~29s
(159 spreads split, 3 portrait singles copied through), **zero errors**, gutter
detected on all 159 with **no fallbacks**. All 321 outputs re-opened cleanly.

Split balance (narrow/wide half) — median **0.96**, only **one** pair below 0.80:
`161`, which is a photograph of the **open leather cover**, not a text spread. Two
pages were inspected visually and are complete with margins intact and no clipped
text. So the detection is sound on real material; the cover is a *content*
mismatch (see the note in `find_gutter`), best handled by not splitting cover
shots rather than by tuning the heuristic.

Usage:
    python split_spreads.py "C:/…/scanned/ОКТОИХ петогласник 2"
    python split_spreads.py <folder> --dry-run
    python split_spreads.py <folder> --out C:/tmp/pages --rtl
"""

from __future__ import annotations

import argparse
import logging
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

from nbcg_pipeline import find_images, force_utf8_streams, print_summary

# ---------------------------------------------------------------------------
# Config / defaults
# ---------------------------------------------------------------------------

# Width/height at or above which a landscape image is treated as a spread. Two
# portrait pages side by side land near 1.4–1.6; a single portrait page is < 1.0.
# 1.15 leaves room for near-square single pages without catching them.
DEFAULT_SPREAD_THRESHOLD = 1.15

# How far either side of centre the gutter is looked for, as a fraction of width.
GUTTER_SEARCH_FRACTION = 0.15

# Column-luminance spread (0–255) below which the profile is "too flat" to be a
# real gutter, so we fall back to the middle rather than trusting noise.
DEFAULT_MIN_CONTRAST = 6.0

# Width the greyscale copy is reduced to for the column scan — enough detail to
# locate a gutter, cheap on a 3600px scan.
GUTTER_SCAN_WIDTH = 600

DEFAULT_JPEG_QUALITY = 92

log = logging.getLogger("split_spreads")


# ---------------------------------------------------------------------------
# Gutter detection + splitting
# ---------------------------------------------------------------------------

@dataclass
class GutterResult:
    """Where to cut, and how confident we are about it."""
    x: int
    detected: bool
    contrast: float = 0.0


def find_gutter(
    img: Image.Image,
    search_fraction: float = GUTTER_SEARCH_FRACTION,
    min_contrast: float = DEFAULT_MIN_CONTRAST,
) -> GutterResult:
    """
    Locate the binding gutter as the darkest column near the centre.

    Falls back to the exact middle when the luminance profile is too flat to be a
    real gutter — a blank or evenly-lit spread must not be cut at whatever column
    happened to be a shade darker.
    """
    width, height = img.size
    middle = width // 2

    # Downscale to a fixed width for a cheap, noise-tolerant column scan.
    scale = min(1.0, GUTTER_SCAN_WIDTH / width)
    scan_w = max(2, int(width * scale))
    scan_h = max(1, int(height * scale))
    grey = img.convert("L").resize((scan_w, scan_h), Image.BILINEAR)
    pixels = grey.load()

    # Mean luminance per column, over the central search window only.
    half_window = max(1, int(scan_w * search_fraction))
    scan_middle = scan_w // 2
    start = max(0, scan_middle - half_window)
    end = min(scan_w, scan_middle + half_window)

    column_means: list[tuple[int, float]] = []
    for x in range(start, end):
        total = 0
        for y in range(scan_h):
            total += pixels[x, y]
        column_means.append((x, total / scan_h))

    if not column_means:
        return GutterResult(x=middle, detected=False)

    darkest_x, darkest = min(column_means, key=lambda c: c[1])
    brightest = max(column_means, key=lambda c: c[1])[1]
    contrast = brightest - darkest

    if contrast < min_contrast:
        return GutterResult(x=middle, detected=False, contrast=contrast)

    # Map the scan-space column back to full resolution.
    #
    # NOTE: cutting at the centre of the dark *band* instead of its darkest
    # column was tried and measured — it made things worse, not better. On the
    # open-cover photo (`ОКТОИХ петогласник 2/161.jpg`) the dark leather widens
    # the band well past the spine, pulling the midpoint further off-centre
    # (1578/2078 → 1456/2200), while text spreads moved by only ~5px. The single
    # darkest column is kept. A cover photographed open is not really a spread and
    # should not be split at all — that is a content decision, not a detection
    # one, so it is left to the operator rather than chased with heuristics.
    return GutterResult(
        x=int(round(darkest_x / scale)), detected=True, contrast=contrast
    )


def is_spread(img: Image.Image, threshold: float) -> bool:
    """True when the image is landscape enough to be two pages side by side."""
    width, height = img.size
    return height > 0 and (width / height) >= threshold


def split_spread(
    img: Image.Image, gutter_x: int, trim: int = 0, rtl: bool = False
) -> list[Image.Image]:
    """
    Cut a spread at `gutter_x` into two page images, in reading order.

    `trim` drops that many pixels either side of the cut, to shed the binding
    shadow. The cut is clamped so a mis-detected gutter can never produce an
    empty or negative-width crop.
    """
    width, height = img.size
    x = max(1, min(width - 1, gutter_x))

    left_end = max(1, x - trim)
    right_start = min(width - 1, x + trim)

    left = img.crop((0, 0, left_end, height))
    right = img.crop((right_start, 0, width, height))

    return [right, left] if rtl else [left, right]


# ---------------------------------------------------------------------------
# Saving
# ---------------------------------------------------------------------------

def save_page(img: Image.Image, path: Path, source: Image.Image, quality: int) -> None:
    """Save a page, carrying the source's DPI so the PDF step gets real sizes."""
    params: dict = {}
    dpi = source.info.get("dpi")
    if dpi:
        params["dpi"] = dpi

    if path.suffix.lower() in {".jpg", ".jpeg"}:
        rgb = img if img.mode == "RGB" else img.convert("RGB")
        rgb.save(path, quality=quality, **params)
    else:
        img.save(path, **params)


# ---------------------------------------------------------------------------
# Processing
# ---------------------------------------------------------------------------

@dataclass
class Summary:
    """The JSON payload written to stdout."""
    folder: str = ""
    out_dir: str = ""
    images_found: int = 0
    spreads_split: int = 0
    singles_copied: int = 0
    pages_written: int = 0
    gutter_detected: int = 0
    gutter_fallback: int = 0
    dry_run: bool = False
    errors: list[str] = field(default_factory=list)
    pages: list[str] = field(default_factory=list)


def resolve_pages(folder: Path, pages: list[str], summary: Summary) -> list[Path]:
    """The caller's exact ordered page list, resolved against `folder`.

    A named file that isn't there is reported and skipped rather than failing
    the whole folder - same handling (and same message) as `web.py --pages`.
    """
    resolved: list[Path] = []
    for name in pages:
        candidate = folder / name
        if not candidate.is_file():
            summary.errors.append(f"--pages entry not found: {name}")
            log.error("missing %s", name)
            continue
        resolved.append(candidate)
    return resolved


def process_folder(folder: Path, args: argparse.Namespace) -> Summary:
    summary = Summary(folder=str(folder), dry_run=args.dry_run)

    if args.pages is not None:
        images = resolve_pages(folder, args.pages, summary)
    else:
        images = find_images(folder)
    summary.images_found = len(images)
    if not images:
        log.warning("No images found in %s", folder)
        return summary

    out_dir = Path(args.out) if args.out else folder / "split"
    summary.out_dir = str(out_dir)
    if not args.dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)

    for path in images:
        try:
            with Image.open(path) as img:
                img.load()

                if not is_spread(img, args.threshold):
                    # A single page: copy it through so the output folder is a
                    # complete, ordered page set ready for the PDF step.
                    summary.singles_copied += 1
                    target = out_dir / path.name
                    log.info("single  %s (%dx%d)", path.name, *img.size)
                    if not args.dry_run:
                        shutil.copy2(path, target)
                    summary.pages.append(target.name)
                    summary.pages_written += 1
                    continue

                gutter = (
                    find_gutter(img, min_contrast=args.min_contrast)
                    if args.gutter_detect
                    else GutterResult(x=img.size[0] // 2, detected=False)
                )
                if gutter.detected:
                    summary.gutter_detected += 1
                else:
                    summary.gutter_fallback += 1

                pages = split_spread(
                    img, gutter.x, trim=args.gutter_trim, rtl=args.rtl
                )
                summary.spreads_split += 1
                log.info(
                    "spread  %s (%dx%d) → cut at x=%d (%s, contrast %.1f)",
                    path.name,
                    img.size[0],
                    img.size[1],
                    gutter.x,
                    "detected" if gutter.detected else "middle",
                    gutter.contrast,
                )

                for index, page in enumerate(pages, start=1):
                    target = out_dir / f"{path.stem}_{index}{path.suffix}"
                    if not args.dry_run:
                        save_page(page, target, img, args.quality)
                    summary.pages.append(target.name)
                    summary.pages_written += 1

        except Exception as exc:  # noqa: BLE001 — report and carry on
            message = f"{path.name}: {exc}"
            summary.errors.append(message)
            log.error("failed  %s", message)

    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Split two-page spreads into single-page images.",
    )
    parser.add_argument("folder", help="Folder of scanned images.")
    parser.add_argument(
        "--out",
        default=None,
        help="Output folder (default: <folder>/split). Originals are never touched.",
    )
    parser.add_argument(
        "--pages",
        nargs="+",
        default=None,
        metavar="FILE",
        help="Exact ordered list of image filenames (relative to the folder) to "
             "split, instead of discovering and natural-sorting the folder. Lets "
             "a caller that already computed the authoritative page order (the "
             "job runner, from ItemRunRequest.pageImages) hand it over directly "
             "rather than this script re-deriving it - otherwise the order would "
             "be decided in two places and could disagree. Files named here but "
             "not present are reported in the summary and skipped.",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=DEFAULT_SPREAD_THRESHOLD,
        help=f"Width/height at or above which an image is a spread "
             f"(default {DEFAULT_SPREAD_THRESHOLD}).",
    )
    parser.add_argument(
        "--rtl",
        action="store_true",
        help="Right-to-left reading order (right half is the earlier page).",
    )
    parser.add_argument(
        "--no-gutter-detect",
        dest="gutter_detect",
        action="store_false",
        help="Always split at the exact middle instead of detecting the gutter.",
    )
    parser.add_argument(
        "--min-contrast",
        type=float,
        default=DEFAULT_MIN_CONTRAST,
        help=f"Minimum column-luminance spread to trust a detected gutter "
             f"(default {DEFAULT_MIN_CONTRAST}); below it, split at the middle.",
    )
    parser.add_argument(
        "--gutter-trim",
        type=int,
        default=0,
        help="Pixels to drop either side of the cut, to shed the binding shadow.",
    )
    parser.add_argument(
        "--quality",
        type=int,
        default=DEFAULT_JPEG_QUALITY,
        help=f"JPEG quality for written pages (default {DEFAULT_JPEG_QUALITY}).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would happen without writing anything.",
    )
    parser.add_argument(
        "--quiet", action="store_true", help="Suppress per-image logging."
    )
    return parser


def main() -> int:
    force_utf8_streams()
    args = build_parser().parse_args()

    # Logs to stderr so stdout carries only the JSON summary.
    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(levelname)s: %(message)s",
        stream=sys.stderr,
    )

    folder = Path(args.folder)
    if not folder.is_dir():
        log.error("Not a folder: %s", folder)
        return 1

    summary = process_folder(folder, args)
    print_summary(summary)

    # Errors outrank "found nothing": a --pages list whose every entry is
    # missing leaves images_found at 0, but that is a caller mistake (exit 1),
    # not an empty folder (exit 2).
    if summary.errors:
        return 1
    return 2 if summary.images_found == 0 else 0


if __name__ == "__main__":
    sys.exit(main())
