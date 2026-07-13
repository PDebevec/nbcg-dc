#!/usr/bin/env python3
"""
OCR script for Montenegrin / Balkan-language documents (Latin or Cyrillic script).
Works on a single image or a PDF (all pages).

Usage:
    python3 run.py image.jpg
    python3 run.py document.pdf

Output:
    Saves a readable .txt file next to the input (same name, .txt extension),
    with one recognized line per line of text, and page separators for PDFs.

Requirements:
    pip install paddleocr paddlepaddle pdf2image
    System: poppler-utils (for pdf2image)
        Ubuntu/Debian: sudo apt-get install poppler-utils
"""
import argparse
import time
from datetime import datetime

import sys
import os
from pathlib import Path

import numpy as np
import cv2
from paddleocr import PaddleOCR

import resource

# Maximum virtual memory: 8 GB
MAX_MEMORY = 8 * 1024 * 1024 * 1024

resource.setrlimit(
    resource.RLIMIT_AS,
    (MAX_MEMORY, MAX_MEMORY)
)

def log(msg):
    now = datetime.now().strftime("%H:%M:%S")
    print(f"[{now}] {msg}")

# Lazy import - only needed for PDFs
def _pdf_to_images(pdf_path, dpi=300):
    from pdf2image import convert_from_path
    return convert_from_path(pdf_path, dpi=dpi)


# PaddleOCR models for the two scripts Montenegrin can use.
# rs_latin covers Latin-script Serbian/Montenegrin/Croatian/Bosnian.
# cyrillic covers Cyrillic-script Serbian/Montenegrin/Russian/Bulgarian/Ukrainian.
_OCR_ENGINES = {}


def _get_engine(lang):
    if lang not in _OCR_ENGINES:
        start = time.perf_counter()

        log(f"Loading OCR model ({lang})...")

        common_args = dict(
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=True,
            enable_mkldnn=False,

            # limit CPU memory pressure
            cpu_threads=2,
        )

        if lang == "rs_cyrillic":
            _OCR_ENGINES[lang] = PaddleOCR(
                lang="cyrillic",
                
                # FORCE small detector
                text_detection_model_name="PP-OCRv5_mobile_det",

                # small recognizer
                text_recognition_model_name="cyrillic_PP-OCRv5_mobile_rec",

                **common_args
            )

        elif lang == "rs_latin":
            _OCR_ENGINES[lang] = PaddleOCR(
                lang="rs_latin",

                text_detection_model_name="PP-OCRv5_mobile_det",

                **common_args
            )

        elapsed = time.perf_counter() - start
        log(f"{lang} model ready ({elapsed:.1f}s)")

    return _OCR_ENGINES[lang]


def _ocr_with_lang(image, lang):
    engine = _get_engine(lang)

    log(f"Running OCR ({lang})...")

    start = time.perf_counter()

    results = engine.predict(image)
    if isinstance(image, np.ndarray):
        image = limit_image_size(image)

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
    best_lines = []
    best_score = -1
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

    return _sort_lines_reading_order(best_lines)


def process_file(input_path, langs):
    input_path = Path(input_path)
    if not input_path.exists():
        print(f"Error: file not found: {input_path}")
        sys.exit(1)

    ext = input_path.suffix.lower()
    output_path = input_path.with_suffix(".txt")

    all_text_blocks = []

    if ext == ".pdf":
        print(f"Converting PDF pages to images: {input_path}")
        pages = _pdf_to_images(str(input_path))
        print(f"Found {len(pages)} page(s).")
        for i, page_image in enumerate(pages, start=1):
            print(f"Processing page {i}/{len(pages)}...")
            lines = ocr_image(
                _pil_to_bgr(page_image),
                langs=langs,
                page_label=f"page {i}",
            )
            all_text_blocks.append(f"--- Page {i} ---\n" + "\n".join(lines))
    else:
        print(f"Processing image: {input_path}")
        lines = ocr_image(str(input_path), langs=langs)
        all_text_blocks.append("\n".join(lines))

    final_text = "\n\n".join(all_text_blocks)

    output_path.write_text(final_text, encoding="utf-8")
    print(f"\nDone. Text saved to: {output_path}")


def main():
    parser = argparse.ArgumentParser()

    parser.add_argument("input")

    parser.add_argument(
        "--lang",
        nargs="+",
        default=["rs_latin", "rs_cyrillic"],
        help="PaddleOCR language code(s), e.g. rs_latin rs_cyrillic",
    )

    args = parser.parse_args()

    langs = tuple(args.lang)

    start = time.perf_counter()

    log("Starting OCR")

    process_file(args.input, langs)

    elapsed = time.perf_counter() - start

    log(f"Finished in {elapsed:.1f} seconds")


if __name__ == "__main__":
    main()
