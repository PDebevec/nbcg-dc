#!/usr/bin/env python3
"""
web.py

Builds pipeline outputs for a scanned item folder, per docs/01 §Naming and
domain/naming.ts:

  <name>_archive.pdf   archival master, full quality (only when a lossless
                        TIFF source exists)
  <name>.pdf            web PDF, downscaled for online preview
  <name>_thumb.png       thumbnail, generated from the first page

Two input shapes, detected per folder:

  flat     A flat directory of JPGs - the shape every real scanner folder is
           in (docs/05-real-scan-data.md) - builds only the web PDF +
           thumbnail. No archival PDF: the source JPGs are already lossy, so
           a second lossy copy at full size would just be a bigger
           duplicate, not a genuinely higher-fidelity master (matches the
           page-images branch already shipped in domain/pipeline.ts, which
           has "no archival master since JPG is already lossy"). The source
           JPGs remain on disk, untouched, as the de facto archival material.

  paired   A folder with jpg/ and tif/ sibling subfolders, matched by
           position - builds all three outputs: archival PDF from the
           TIFFs, web PDF from the JPGs, thumbnail from the first JPG.
           Secondary/legacy path - no folder in the real corpus uses it.

Usage:
    python web.py /path/to/folder
    python web.py /path/to/folder --recursive
    python web.py /path/to/folder -r

If --recursive/-r is given, the script walks the tree under the given path
and processes every folder it finds that looks like an item (paired or
flat) - a folder that matches stops the walk descending into it, so a
paired folder's own jpg/tif subfolders are never also picked up as separate
flat targets.

Contract (seam 4 - Native <-> Python): arguments in -> output files on disk +
a JSON summary on stdout; human-readable logs go to stderr. Exit codes:

    0  success
    1  one or more folders errored
    2  no folder to process was found
"""

import argparse
import logging
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from nbcg_pipeline import (
    ARCHIVAL_DEFAULT_DPI,
    ARCHIVAL_JPEG_QUALITY,
    WEB_DPI,
    WEB_JPEG_QUALITY,
    build_pdf,
    build_thumbnail,
    find_images,
    force_utf8_streams,
    print_summary,
)

# ---------------------------------------------------------------------------
# Config / defaults
# ---------------------------------------------------------------------------

JPG_EXTENSIONS = {".jpg", ".jpeg"}
TIF_EXTENSIONS = {".tif", ".tiff"}

# Subfolder names are matched by *token*, not by exact name or raw substring,
# so "1936 TIFF", "1936_jpg", "TIF", "Tiffs", "JPEGs" etc. all match, while
# unrelated folders that merely contain the letters (e.g. "Artifacts") do not.
JPG_NAME_TOKENS = {"jpg", "jpgs", "jpeg", "jpegs"}
TIFF_NAME_TOKENS = {"tif", "tifs", "tiff", "tiffs"}

# Image loading, downscaling, PDF assembly and thumbnail generation now live in
# nbcg_pipeline.images - pdf_derive.py needs the identical rules, and a second
# copy of the size/quality constants is how the two branches would drift into
# producing different web previews for the same item.

logging.basicConfig(
    level=logging.INFO, format="%(levelname)s: %(message)s", stream=sys.stderr
)
log = logging.getLogger("web")


# ---------------------------------------------------------------------------
# Output naming (docs/01 §Naming, domain/naming.ts)
# ---------------------------------------------------------------------------

def archival_pdf_name(base: str) -> str:
    return f"{base}_archive.pdf"


def web_pdf_name(base: str) -> str:
    return f"{base}.pdf"


def thumbnail_name(base: str) -> str:
    return f"{base}_thumb.png"


# ---------------------------------------------------------------------------
# jpg/tif paired-folder discovery (secondary path)
# ---------------------------------------------------------------------------

def match_pairs(jpg_dir: Path, tif_dir: Path) -> list[tuple[int, Path, Path]]:
    """
    Match jpg/tif images purely by position: each folder is discovered in
    natural order on its own, and the Nth jpg is paired with the Nth tif.
    Filenames are not assumed to correspond between the two folders.
    """
    jpgs = find_images(jpg_dir, JPG_EXTENSIONS)
    tifs = find_images(tif_dir, TIF_EXTENSIONS)

    if len(jpgs) != len(tifs):
        log.warning(
            "  jpg folder has %d image(s) but tiff folder has %d -- "
            "using the first %d from each, extras are ignored.",
            len(jpgs), len(tifs), min(len(jpgs), len(tifs)),
        )

    return [(i, jpgs[i], tifs[i]) for i in range(min(len(jpgs), len(tifs)))]


def _name_tokens(name: str) -> set[str]:
    """Split a folder name into lowercase alphanumeric tokens.

    e.g. "1936 TIFF" -> {"1936", "tiff"}, "Zeta_jpgs-final" -> {"zeta", "jpgs", "final"}
    """
    return {t for t in re.split(r"[^a-zA-Z0-9]+", name.lower()) if t}


def find_subdir_by_tokens(folder: Path, tokens: set[str]) -> Path | None:
    """
    Find a direct subfolder of `folder` whose name contains one of `tokens`
    as a whole token (not just a raw substring). If several match, the
    alphabetically-first one is used and the rest are logged as ambiguous.
    """
    if not folder.is_dir():
        return None
    candidates = sorted(
        d for d in folder.iterdir()
        if d.is_dir() and _name_tokens(d.name) & tokens
    )
    if not candidates:
        return None
    if len(candidates) > 1:
        log.warning(
            "  Multiple possible matches for %s in '%s': %s -- using '%s'",
            "/".join(sorted(tokens)), folder,
            ", ".join(c.name for c in candidates), candidates[0].name,
        )
    return candidates[0]


def find_jpg_dir(folder: Path) -> Path | None:
    return find_subdir_by_tokens(folder, JPG_NAME_TOKENS)


def find_tiff_dir(folder: Path) -> Path | None:
    return find_subdir_by_tokens(folder, TIFF_NAME_TOKENS)


def is_pair_folder(folder: Path) -> bool:
    """True if `folder` directly contains both a jpg-like and a tiff-like subfolder."""
    return find_jpg_dir(folder) is not None and find_tiff_dir(folder) is not None


# ---------------------------------------------------------------------------
# Target discovery
# ---------------------------------------------------------------------------

@dataclass
class FolderTarget:
    """A folder to process, and which shape it was classified as."""
    path: Path
    mode: str  # "flat" | "paired"


def classify_folder(folder: Path) -> FolderTarget | None:
    """Classify a single folder: paired (jpg/+tif/ subfolders) takes
    precedence over flat (images directly inside); a folder that is
    neither is not a target."""
    if is_pair_folder(folder):
        return FolderTarget(path=folder, mode="paired")
    if find_images(folder, JPG_EXTENSIONS):
        return FolderTarget(path=folder, mode="flat")
    return None


def find_targets(root: Path, recursive: bool) -> list[FolderTarget]:
    """Find folders to process under `root`.

    A folder that classifies as a target stops the walk descending into it -
    a paired folder's own jpg/tif subfolders must never also be picked up as
    separate flat targets, and a folder already claimed as an item should not
    have its own subfolders (e.g. a previous run's "split" output) reprocessed.
    """
    target = classify_folder(root)
    if target:
        return [target]
    if not recursive:
        return []

    targets: list[FolderTarget] = []
    for sub in sorted(p for p in root.iterdir() if p.is_dir()):
        targets.extend(find_targets(sub, recursive=True))
    return targets


# ---------------------------------------------------------------------------
# Per-folder processing
# ---------------------------------------------------------------------------

@dataclass
class FolderSummary:
    """One folder's result, part of the JSON payload written to stdout."""
    folder: str = ""
    mode: str = ""
    pages: int = 0
    outputs: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def _resolve_thumbnail_source(
    target: FolderTarget, summary: FolderSummary, natural_first: Path, thumbnail_source: str | None
) -> Path:
    """The image `build_thumbnail` should use: the caller's explicit pick
    (`ItemRunRequest.primaryThumbnail`, e.g. a filename tagged "thumbnail" or
    an operator's choice) when given and present, else the natural-first
    image already used to build the PDF. A missing named file degrades to
    the natural-first image rather than failing the whole folder - the
    thumbnail is a soft concern next to the PDF/OCR work.

    An *absolute* `thumbnail_source` resolves to itself (pathlib's join
    semantics), which is how the job runner points at an unsplit original
    while the pages being assembled live in a staging folder."""
    if thumbnail_source is None:
        return natural_first
    candidate = target.path / thumbnail_source
    if candidate.is_file():
        return candidate
    summary.errors.append(f"--thumbnail-source not found: {thumbnail_source}")
    return natural_first


def process_flat(
    target: FolderTarget,
    summary: FolderSummary,
    *,
    dest: Path,
    pages: list[str] | None,
    thumbnail_only: bool,
    thumbnail_source: str | None = None,
    name: str | None = None,
) -> None:
    if pages is not None:
        images = []
        for page_name in pages:
            candidate = target.path / page_name
            if not candidate.is_file():
                summary.errors.append(f"--pages entry not found: {page_name}")
                continue
            images.append(candidate)
        if not images:
            return
    else:
        images = find_images(target.path, JPG_EXTENSIONS)
    if not images:
        # Reachable once mode can be forced via --mode (bypassing
        # classify_folder()'s own "flat only if find_images() is non-empty"
        # check) - auto-detection alone can never call process_flat with no
        # images to work with.
        summary.errors.append("flat mode requested but no JPG images were found")
        return
    summary.pages = len(images)
    base_name = name if name is not None else target.path.name

    thumb = dest / thumbnail_name(base_name)
    thumb_source = _resolve_thumbnail_source(target, summary, images[0], thumbnail_source)

    if not thumbnail_only:
        web_pdf = dest / web_pdf_name(base_name)
        build_pdf(
            images, web_pdf, downscale=True, quality=WEB_JPEG_QUALITY,
            dpi=(WEB_DPI, WEB_DPI), log=log,
        )
        summary.outputs.append(web_pdf.name)

    build_thumbnail(thumb_source, thumb, log=log)
    summary.outputs.append(thumb.name)


def process_paired(
    target: FolderTarget,
    summary: FolderSummary,
    *,
    dest: Path,
    thumbnail_only: bool,
    thumbnail_source: str | None = None,
    name: str | None = None,
) -> None:
    jpg_dir = find_jpg_dir(target.path)
    tiff_dir = find_tiff_dir(target.path)
    if jpg_dir is None or tiff_dir is None:
        # Reachable once `mode` can be forced via --mode (bypassing the
        # is_pair_folder() precondition classify_folder() normally enforces)
        # - auto-detection alone can never call this branch with either None.
        summary.errors.append(
            "paired mode requested but no jpg/tif subfolders were found"
        )
        return
    log.info("  Using jpg dir: '%s', tiff dir: '%s'", jpg_dir.name, tiff_dir.name)

    pairs = match_pairs(jpg_dir, tiff_dir)
    if not pairs:
        summary.errors.append("no matching jpg/tiff pairs found")
        return

    summary.pages = len(pairs)
    jpgs = [jpg for _, jpg, _ in pairs]
    tifs = [tif for _, _, tif in pairs]
    base_name = name if name is not None else target.path.name

    thumb = dest / thumbnail_name(base_name)
    thumb_source = _resolve_thumbnail_source(target, summary, jpgs[0], thumbnail_source)

    if not thumbnail_only:
        archival_pdf = dest / archival_pdf_name(base_name)
        web_pdf = dest / web_pdf_name(base_name)
        build_pdf(
            tifs, archival_pdf, downscale=False,
            quality=ARCHIVAL_JPEG_QUALITY, dpi=(ARCHIVAL_DEFAULT_DPI, ARCHIVAL_DEFAULT_DPI),
            log=log,
        )
        summary.outputs.append(archival_pdf.name)
        build_pdf(
            jpgs, web_pdf, downscale=True, quality=WEB_JPEG_QUALITY,
            dpi=(WEB_DPI, WEB_DPI), log=log,
        )
        summary.outputs.append(web_pdf.name)

    build_thumbnail(thumb_source, thumb, log=log)
    summary.outputs.append(thumb.name)


def process_folder(
    target: FolderTarget,
    *,
    out_dir: Path | None,
    pages: list[str] | None,
    thumbnail_only: bool,
    thumbnail_source: str | None,
    name: str | None = None,
) -> FolderSummary:
    log.info("Processing (%s): %s", target.mode, target.path)
    summary = FolderSummary(folder=str(target.path), mode=target.mode)
    try:
        dest = out_dir if out_dir is not None else target.path
        dest.mkdir(parents=True, exist_ok=True)
        if target.mode == "flat":
            process_flat(
                target, summary, dest=dest, pages=pages, thumbnail_only=thumbnail_only,
                thumbnail_source=thumbnail_source, name=name,
            )
        else:
            if pages is not None:
                log.warning("  --pages is ignored for a paired (jpg/tif) folder")
            process_paired(
                target, summary, dest=dest, thumbnail_only=thumbnail_only,
                thumbnail_source=thumbnail_source, name=name,
            )
        log.info("  Done: %d page(s) processed.", summary.pages)
    except Exception as exc:  # keep going with other folders on error
        summary.errors.append(str(exc))
        log.error("  Failed processing '%s': %s", target.path, exc)
    return summary


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

@dataclass
class RunSummary:
    """The JSON payload written to stdout - always this shape, whether or
    not --recursive was given, so stdout's structure never varies by flag."""
    targets: list[FolderSummary] = field(default_factory=list)


def main() -> int:
    force_utf8_streams()

    parser = argparse.ArgumentParser(
        description="Build a web PDF + thumbnail (and, for jpg/tif-paired "
                     "folders, an archival PDF) from a scanned item folder."
    )
    parser.add_argument(
        "path",
        type=str,
        help="Path to a folder of scanned images (a flat folder of JPGs, or "
             "one containing jpg/tif subfolders), or, with --recursive, a "
             "tree containing such folders.",
    )
    parser.add_argument(
        "-r", "--recursive",
        action="store_true",
        default=False,
        help="Recurse into the given path and process every folder found "
             "that looks like an item folder. Without this flag, only the "
             "given path itself is processed.",
    )
    parser.add_argument(
        "--out-dir",
        type=str,
        default=None,
        help="Write outputs into this directory instead of the source folder "
             "(the job runner uses this for atomic writes: it stages here, "
             "then renames into place itself). Not usable with --recursive.",
    )
    parser.add_argument(
        "--mode",
        choices=["flat", "paired"],
        default=None,
        help="Force the folder shape instead of auto-detecting it by "
             "scanning for jpg/tif subfolders. The job runner already knows "
             "the shape (ItemRunRequest.inputShape, decided once in the .ts "
             "lane) and passes it here, so this script never re-derives a "
             "second, possibly-disagreeing answer. Without this flag, "
             "falls back to the auto-detection standalone/manual runs rely "
             "on. Not usable with --recursive (each folder in a tree could "
             "differ; forcing one mode across all of them would be wrong).",
    )
    parser.add_argument(
        "--name",
        type=str,
        default=None,
        metavar="BASE",
        help="Base name for the outputs (<BASE>.pdf, <BASE>_thumb.png, ...) "
             "instead of deriving it from the processed folder's own name. The "
             "job runner passes ItemRunRequest.folderName, the naming base the "
             ".ts lane already decided, so this script never re-derives a "
             "second answer. Also what makes it possible to assemble from a "
             "staging folder (e.g. split-spread output) while still naming the "
             "outputs after the item.",
    )
    parser.add_argument(
        "--pages",
        nargs="+",
        default=None,
        metavar="FILE",
        help="Exact ordered list of page-image filenames (relative to the "
             "folder) to assemble, instead of re-scanning and re-sorting the "
             "folder. Flat-mode only; ignored for a jpg/tif-paired folder. "
             "Lets a caller that already computed the authoritative page "
             "order (the job runner, from ItemRunRequest.pageImages) hand it "
             "over directly rather than this script re-deriving it.",
    )
    parser.add_argument(
        "--thumbnail-only",
        action="store_true",
        help="Skip PDF assembly entirely; only build the thumbnail. For a "
             "standalone graphical work (images-only) that has no PDF at all.",
    )
    parser.add_argument(
        "--thumbnail-source",
        type=str,
        default=None,
        metavar="FILE",
        help="Build the thumbnail from this exact filename (relative to the "
             "folder, or an absolute path) instead of the natural-first image. "
             "Lets a caller pass ItemRunRequest.primaryThumbnail through "
             "directly - an image conventionally named 'thumbnail', or an "
             "operator's own pick - independent of whichever images are used to "
             "assemble the PDF. The absolute form is how the job runner keeps a "
             "chosen thumbnail unsplit while the PDF is assembled from split "
             "spreads staged elsewhere. Falls back to the natural-first image "
             "if the named file is not found.",
    )
    args = parser.parse_args()

    if args.out_dir and args.recursive:
        parser.error("--out-dir cannot be combined with --recursive")
    if args.mode and args.recursive:
        parser.error("--mode cannot be combined with --recursive")
    if args.name and args.recursive:
        # Every folder in the tree would produce identically-named outputs,
        # each overwriting the last.
        parser.error("--name cannot be combined with --recursive")

    root = Path(args.path).expanduser().resolve()
    out_dir = Path(args.out_dir) if args.out_dir else None
    run_summary = RunSummary()

    if not root.is_dir():
        log.error("Path does not exist or is not a directory: %s", root)
        print_summary(run_summary)
        return 2

    if args.mode is not None:
        # Forced: skip auto-detection entirely rather than let it agree or
        # disagree with the caller's own answer. A folder that doesn't
        # actually match the forced mode surfaces as a per-target error
        # (exit 1) from inside process_folder, not a "nothing found" (exit 2)
        # - the folder is real, the caller was just wrong about its shape.
        targets = [FolderTarget(path=root, mode=args.mode)]
    else:
        targets = find_targets(root, args.recursive)
    if not targets:
        if args.recursive:
            log.error("No folders with page images found under: %s", root)
        else:
            log.error(
                "Given path contains neither a flat set of images nor "
                "jpg/tif subfolders: %s\n"
                "(use --recursive/-r to search subfolders instead)", root
            )
        print_summary(run_summary)
        return 2

    log.info("Found %d folder(s) to process.", len(targets))
    for target in targets:
        run_summary.targets.append(
            process_folder(
                target,
                out_dir=out_dir,
                pages=args.pages,
                thumbnail_only=args.thumbnail_only,
                thumbnail_source=args.thumbnail_source,
                name=args.name,
            )
        )

    print_summary(run_summary)
    return 1 if any(t.errors for t in run_summary.targets) else 0


if __name__ == "__main__":
    sys.exit(main())
