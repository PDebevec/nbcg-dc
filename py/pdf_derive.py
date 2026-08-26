#!/usr/bin/env python3
"""
pdf_derive.py

Derives pipeline outputs from a **PDF source**, rather than from a folder of
images:

  <BASE>.pdf         web PDF, downscaled for online preview
  <BASE>_thumb.png   thumbnail, rendered from page 1

This is the `supplied-pdf` / `multiple-pdfs` branch of the pipeline
(docs/tasks/06 §Source inputs) - a finished PDF dropped straight into an item
folder, rather than scans to assemble. No archival master is built: a supplied
PDF is already finished, and the original is preserved untouched (the job
runner files it under `source/`, see below).

Separate from `web.py` on purpose. `web.py`'s whole model is a *folder* shape
(flat JPGs, or paired jpg/tif subfolders); a single PDF is a different input
model, and bolting a third mode onto it would obscure both. The parts that must
not differ between the two - the downscale size, JPEG quality, DPI and
thumbnail width - are shared through `nbcg_pipeline.images`, so the same item
gets the same web preview whichever branch produced it.

## Why the original has to be filed away

The job runner moves the source PDF into `<folder>/source/` *before* calling
this script, then writes `<BASE>.pdf` into the folder root. That is not
tidiness. `domain/files.classifyAsset` calls every non-`_archive` PDF a
"web-pdf" and `domain/pipeline.classifyInput` branches on how many there are,
so a derived PDF sitting beside its original makes the folder look like
`multiple-pdfs` on the next scan - the item silently changes shape, and the
full-size original would be uploaded as a web asset. Only files directly inside
the item folder are discovered (`core::fs::describe_folder` does not recurse),
so a subfolder is enough to keep the count at one.

## Contract (seam 4 - Native <-> Python)

    python pdf_derive.py <source.pdf> --name BASE --out-dir DIR [--thumbnail-only]

Arguments in -> output files on disk + a **JSON summary on stdout**; human
logs go to **stderr**, so stdout stays machine-parseable. Exit codes:

    0  success
    1  error (unreadable source, render or write failure)
    2  the source PDF has no pages

`--name` is required rather than derived from the source filename: the naming
base is decided once in the `.ts` lane (`ItemRunRequest.folderName`), and the
source's own name is frequently unrelated to it - the real corpus's
`Pisma iz Liona` holds `Писма из Лиона_(310).pdf`.

## Rendering

Pages are rasterised with **pypdfium2** (Google's PDFium; BSD/Apache, ships a
self-contained wheel - no system dependency, unlike pdf2image's poppler, and no
AGPL obligation, unlike PyMuPDF).

PDF page sizes are in points (1/72"), which says nothing about the resolution
of the content inside, so pages are rendered at whatever scale puts the longest
side at `WEB_MAX_DIMENSION` and then passed through the shared
`resize_for_web`. The scale is clamped: a very small page would otherwise be
upscaled far past any real detail it holds, and a very large one rendered at
needless cost.

Pages are held in memory while the PDF is assembled, because Pillow's
`save_all=True` has no streaming form - the same characteristic `web.py` already
has for a folder of JPGs, and the reason neither is a good fit for a
thousand-page document.
"""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path

import pypdfium2 as pdfium

from nbcg_pipeline import (
    WEB_MAX_DIMENSION,
    build_pdf_from_images,
    build_thumbnail_from_image,
    force_utf8_streams,
    print_summary,
)

# Bounds on the render scale (see "Rendering" above). 4.0 is generous for any
# page holding a real scan; 0.1 stops a poster-sized page costing more than the
# downscale that immediately follows.
MAX_RENDER_SCALE = 4.0
MIN_RENDER_SCALE = 0.1

log = logging.getLogger("pdf_derive")


# ---------------------------------------------------------------------------
# Output naming (docs/01 §Naming, domain/naming.ts)
# ---------------------------------------------------------------------------

def web_pdf_name(base: str) -> str:
    return f"{base}.pdf"


def thumbnail_name(base: str) -> str:
    return f"{base}_thumb.png"


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def render_scale_for(page) -> float:
    """The scale that puts the page's longest side at WEB_MAX_DIMENSION."""
    width_pt, height_pt = page.get_size()
    longest = max(width_pt, height_pt)
    if longest <= 0:
        return 1.0
    return max(MIN_RENDER_SCALE, min(MAX_RENDER_SCALE, WEB_MAX_DIMENSION / longest))


def render_page(page):
    """One PDF page as an RGB PIL image, at web-preview resolution."""
    bitmap = page.render(scale=render_scale_for(page))
    image = bitmap.to_pil()
    return image if image.mode == "RGB" else image.convert("RGB")


# ---------------------------------------------------------------------------
# Processing
# ---------------------------------------------------------------------------

@dataclass
class DeriveSummary:
    """The JSON payload written to stdout."""
    source: str = ""
    name: str = ""
    pages: int = 0
    outputs: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def derive(source: Path, base: str, dest: Path, *, thumbnail_only: bool) -> DeriveSummary:
    summary = DeriveSummary(source=str(source), name=base)

    document = pdfium.PdfDocument(source)
    try:
        summary.pages = len(document)
        if summary.pages == 0:
            summary.errors.append("the source PDF has no pages")
            return summary

        dest.mkdir(parents=True, exist_ok=True)

        if thumbnail_only:
            # Only page 1 is ever needed - rendering the rest of a 300-page
            # document to throw it away would dominate the runtime.
            log.info("Rendering page 1 of %d for the thumbnail", summary.pages)
            pages = [render_page(document[0])]
        else:
            log.info("Rendering %d page(s)", summary.pages)
            pages = [render_page(document[i]) for i in range(summary.pages)]

        try:
            if not thumbnail_only:
                web_pdf = dest / web_pdf_name(base)
                log.info("  Building PDF (%d page(s)) -> %s", len(pages), web_pdf.name)
                build_pdf_from_images(pages, web_pdf)
                summary.outputs.append(web_pdf.name)

            thumb = dest / thumbnail_name(base)
            log.info("  Building thumbnail from page 1 -> %s", thumb.name)
            build_thumbnail_from_image(pages[0], thumb)
            summary.outputs.append(thumb.name)
        finally:
            for page in pages:
                page.close()
    finally:
        document.close()

    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Derive a web PDF + thumbnail from a supplied PDF.",
    )
    parser.add_argument("source", help="Path to the source PDF.")
    parser.add_argument(
        "--name",
        required=True,
        metavar="BASE",
        help="Base name for the outputs (<BASE>.pdf, <BASE>_thumb.png). Required: "
             "the naming base is decided in the .ts lane "
             "(ItemRunRequest.folderName) and the source PDF's own filename is "
             "routinely unrelated to it.",
    )
    parser.add_argument(
        "--out-dir",
        default=None,
        metavar="DIR",
        help="Write outputs into DIR instead of beside the source (the job "
             "runner stages here, then renames into place itself, for atomic "
             "writes).",
    )
    parser.add_argument(
        "--thumbnail-only",
        action="store_true",
        help="Skip PDF assembly; only render page 1 into <BASE>_thumb.png. Used "
             "for multiple-pdfs items, where each PDF is already its own web "
             "PDF and only a thumbnail candidate is needed from it.",
    )
    parser.add_argument(
        "--quiet", action="store_true", help="Suppress per-step logging."
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

    source = Path(args.source).expanduser()
    dest = Path(args.out_dir) if args.out_dir else source.parent

    if not source.is_file():
        log.error("Not a file: %s", source)
        print_summary(DeriveSummary(
            source=str(source),
            name=args.name,
            errors=[f"source PDF not found: {source}"],
        ))
        return 1

    try:
        summary = derive(source, args.name, dest, thumbnail_only=args.thumbnail_only)
    except Exception as exc:  # noqa: BLE001 - report on stdout, never a traceback
        log.error("Failed deriving from '%s': %s", source, exc)
        print_summary(DeriveSummary(source=str(source), name=args.name, errors=[str(exc)]))
        return 1

    print_summary(summary)

    if summary.pages == 0:
        return 2
    return 1 if summary.errors else 0


if __name__ == "__main__":
    sys.exit(main())
