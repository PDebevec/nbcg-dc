#!/usr/bin/env python3
"""
make_pdfs.py

Builds, for every folder that contains a "jpg" and a "tif" subfolder with the
same set of images:

  1. <FolderName>.pdf       - full-quality archival PDF, built from the TIF
                               images (lossless source).
  2. <FolderName>_web.pdf   - smaller "web worthy" PDF, built from the JPG
                               images, downsampled/recompressed for online
                               preview use.
  3. <FolderName>_thumb.jpg - thumbnail image generated from the first page,
                               for use as a library/catalog thumbnail.

All three outputs are written into the matched folder itself (the one that
directly contains "jpg" and "tif").

Usage:
    python make_pdfs.py /path/to/folder
    python make_pdfs.py /path/to/folder --recursive
    python make_pdfs.py /path/to/folder -r

If --recursive/-r is given, the script walks the whole tree under the given
path and processes every folder it finds that has the jpg/tif structure.
If it is not given, only the given path itself is checked/processed.
"""

import argparse
import logging
import re
import sys
from pathlib import Path

from PIL import Image

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

ARCHIVAL_JPEG_QUALITY = 95        # used when a TIF page has no usable raw form
ARCHIVAL_DEFAULT_DPI = 300        # fallback if TIF has no DPI info

WEB_MAX_DIMENSION = 1600          # longest side, in pixels, for the web PDF
WEB_JPEG_QUALITY = 70
WEB_DPI = 150

THUMB_WIDTH = 500
THUMB_JPEG_QUALITY = 80

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger("make_pdfs")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def find_images(folder: Path, extensions: set[str]) -> list[Path]:
    """Return files in `folder` matching `extensions`, sorted by filename."""
    if not folder.is_dir():
        return []
    return sorted(
        f for f in folder.iterdir()
        if f.is_file() and f.suffix.lower() in extensions
    )


def match_pairs(jpg_dir: Path, tif_dir: Path) -> list[tuple[int, Path, Path]]:
    """
    Match jpg/tif images purely by position: each folder is sorted
    alphabetically on its own, and the Nth jpg is paired with the Nth tif.
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


def find_pair_folders(root: Path, recursive: bool) -> list[Path]:
    """Find folders with the jpg/tiff structure, under `root`."""
    if not recursive:
        return [root] if is_pair_folder(root) else []

    matches = []
    if is_pair_folder(root):
        matches.append(root)
    for sub in sorted(p for p in root.rglob("*") if p.is_dir()):
        if is_pair_folder(sub):
            matches.append(sub)
    return matches


def get_tif_dpi(img: Image.Image) -> tuple[float, float]:
    dpi = img.info.get("dpi")
    if dpi and dpi[0] and dpi[1]:
        return dpi
    return (ARCHIVAL_DEFAULT_DPI, ARCHIVAL_DEFAULT_DPI)


def load_rgb(path: Path) -> Image.Image:
    img = Image.open(path)
    if img.mode != "RGB":
        img = img.convert("RGB")
    return img


def resize_for_web(img: Image.Image) -> Image.Image:
    w, h = img.size
    longest = max(w, h)
    if longest <= WEB_MAX_DIMENSION:
        return img
    scale = WEB_MAX_DIMENSION / longest
    new_size = (max(1, round(w * scale)), max(1, round(h * scale)))
    return img.resize(new_size, Image.LANCZOS)


# ---------------------------------------------------------------------------
# Core build steps
# ---------------------------------------------------------------------------

def build_archival_pdf(pairs, out_path: Path) -> None:
    log.info("  Building archival PDF from TIF source -> %s", out_path.name)
    images = []
    dpi = (ARCHIVAL_DEFAULT_DPI, ARCHIVAL_DEFAULT_DPI)
    for i, (_, _, tif_path) in enumerate(pairs):
        img = load_rgb(tif_path)
        if i == 0:
            dpi = get_tif_dpi(img)
        images.append(img)

    first, rest = images[0], images[1:]
    first.save(
        out_path,
        save_all=True,
        append_images=rest,
        resolution=dpi[0],
        quality=ARCHIVAL_JPEG_QUALITY,
    )
    for img in images:
        img.close()


def build_web_pdf(pairs, out_path: Path) -> None:
    log.info("  Building web preview PDF from JPG source -> %s", out_path.name)
    images = []
    for _, jpg_path, _ in pairs:
        img = load_rgb(jpg_path)
        img = resize_for_web(img)
        images.append(img)

    first, rest = images[0], images[1:]
    first.save(
        out_path,
        save_all=True,
        append_images=rest,
        resolution=WEB_DPI,
        quality=WEB_JPEG_QUALITY,
        optimize=True,
    )
    for img in images:
        img.close()


def build_thumbnail(pairs, out_path: Path) -> None:
    log.info("  Building thumbnail from first page -> %s", out_path.name)
    _, jpg_path, _ = pairs[0]
    img = load_rgb(jpg_path)
    w, h = img.size
    new_h = max(1, round(h * (THUMB_WIDTH / w)))
    thumb = img.resize((THUMB_WIDTH, new_h), Image.LANCZOS)
    thumb.save(out_path, quality=THUMB_JPEG_QUALITY, optimize=True)
    img.close()
    thumb.close()


# ---------------------------------------------------------------------------
# Per-folder processing
# ---------------------------------------------------------------------------

def process_folder(folder: Path) -> None:
    log.info("Processing: %s", folder)

    jpg_dir = find_jpg_dir(folder)
    tiff_dir = find_tiff_dir(folder)

    if jpg_dir is None or tiff_dir is None:
        log.warning("  Could not find both a jpg-like and a tiff-like subfolder, skipping.")
        return

    log.info("  Using jpg dir: '%s', tiff dir: '%s'", jpg_dir.name, tiff_dir.name)

    pairs = match_pairs(jpg_dir, tiff_dir)
    if not pairs:
        log.warning("  No matching jpg/tiff pairs found, skipping this folder.")
        return

    base_name = folder.name
    archival_pdf = folder / f"{base_name}.pdf"
    web_pdf = folder / f"{base_name}_web.pdf"
    thumb_jpg = folder / f"{base_name}_thumb.jpg"

    try:
        build_archival_pdf(pairs, archival_pdf)
        build_web_pdf(pairs, web_pdf)
        build_thumbnail(pairs, thumb_jpg)
        log.info("  Done: %d page(s) processed.", len(pairs))
    except Exception as exc:  # keep going with other folders on error
        log.error("  Failed processing '%s': %s", folder, exc)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build archival + web PDFs and a thumbnail from jpg/tif image folder pairs."
    )
    parser.add_argument(
        "path",
        type=str,
        help="Path to the folder containing 'jpg' and 'tif' subfolders "
             "(or, with --recursive, a tree containing such folders).",
    )
    parser.add_argument(
        "-r", "--recursive",
        action="store_true",
        default=False,
        help="Recurse into the given path and process every folder found "
             "with the jpg/tif structure. Without this flag, only the "
             "given path itself is processed.",
    )
    args = parser.parse_args()

    root = Path(args.path).expanduser().resolve()
    if not root.is_dir():
        log.error("Path does not exist or is not a directory: %s", root)
        return 1

    targets = find_pair_folders(root, args.recursive)
    if not targets:
        if args.recursive:
            log.error("No folders with 'jpg' and 'tif' subfolders found under: %s", root)
        else:
            log.error(
                "Given path does not directly contain 'jpg' and 'tif' subfolders: %s\n"
                "(use --recursive/-r to search subfolders instead)", root
            )
        return 1

    log.info("Found %d folder(s) to process.", len(targets))
    for folder in targets:
        process_folder(folder)

    return 0


if __name__ == "__main__":
    sys.exit(main())