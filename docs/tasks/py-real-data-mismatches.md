# `py/` vs real scanner output — five mismatches

> Lane: **Arch/DevOps** (`.py`) · Found: 2026-08-07 · Blocks: Epic 06 running at all
> Source of truth for the data: [05-real-scan-data](../05-real-scan-data.md)

Found while checking the existing Python scripts against the **first real scanner
output** and while writing + running [`py/split_spreads.py`](../../py/split_spreads.py).
The logic lane's side of Epic 06 is done and verified against this data; these are
the `.py` gaps that stop the pipeline from actually running on it.

Ordered by how badly each one bites.

## 1. `web.py` sorts pages lexicographically → shuffled books ⚠️

**`find_images` returns files "sorted by filename"** (`py/web.py:68-76`). Real
folders are numbered `1.jpg … 260.jpg` (`CERNAGORA`, unpadded), so plain sorting
gives:

```
1, 10, 100, 101, … 109, 11, 110, … 2, 20, 200, …
```

A 260-page book assembled in that order is **silently wrong** — it builds, it
opens, every page is present, and the text is nonsense. Nothing fails, so nothing
alerts anyone; the error only surfaces when a reader tries to read it.

- [ ] Sort with a **natural (numeric-aware)** key.
      `py/split_spreads.py:natural_key` already has one — lift it into the shared
      helper module (`py/nbcg_pipeline/`, per docs/04) and use it in both.
- [ ] **Better: don't re-derive the order at all.** The `.ts` lane already hands
      the runner **`ItemRunRequest.pageImages`, in page order**
      (`domain/naming.compareNatural`, verified against all three real books).
      Consuming that list as given makes the ordering single-sourced; re-sorting
      native-side just creates a second place for it to go wrong.

Zero-padded folders (`ОКТОИХ`, `000…161`) happen to sort correctly, which is why
this can pass a casual test and still be broken.

## 2. `web.py` requires `jpg/` + `tif/` subfolders that do not exist

`is_pair_folder` / `find_jpg_dir` / `find_tiff_dir` (`py/web.py:98-155`) look for
sibling subdirectories matched by token (`jpg`, `tiff`, …), and `match_pairs`
pairs images across them by position. **Every real folder is a flat directory of
JPGs**, and there are **no TIFFs anywhere in the corpus**. As written, `web.py`
processes **none** of the four sample folders.

- [ ] Support a **flat folder of images** as the primary input shape.
- [ ] Keep the `jpg/`+`tif/` pairing as an optional branch if TIFF material is
      still expected from some workflows — but it can no longer be the only path.
- [ ] Drive the branch from **`ItemRunRequest.inputShape`** rather than
      re-sniffing the folder: the `.ts` lane already classifies `tiffs` /
      `supplied-pdf` / `multiple-pdfs` / `page-images` / `images-only`, including
      the operator's `ContentKind` override, and re-deriving it in Python would
      let the two disagree.

## 3. `web.py`'s output names contradict the documented convention ⚠️

| | `web.py` writes | Convention (docs/01 §Naming, `domain/naming.ts`) |
| --- | --- | --- |
| archival master | **`<name>.pdf`** | `<name>_archive.pdf` |
| web PDF | `<name>_web.pdf` | **`<name>.pdf`** |
| thumbnail | `<name>_thumb.jpg` | `<name>_thumb.png` |

The plain `<name>.pdf` means **the opposite thing** in each — the archival master
in `web.py`, the web PDF everywhere else. That is the most dangerous kind of
disagreement: the logic lane classifies a discovered `<name>.pdf` as `web-pdf`
(`domain/files.classifyAsset`) and would upload the **full-quality archival
master** as the web preview, and `<name>_archive.pdf` — the one thing that must
never be uploaded — would never be found.

- [ ] Rename the outputs to match the convention, or state the convention is
      wrong and change `domain/naming.ts` + the docs instead. **Either is fine;
      the current split is not.**
- [ ] Thumbnail extension: convention says **PNG**. `.jpg` is defensible for a
      photographic thumbnail, but pick one — `domain/naming.thumbnailName` and
      the runner's "normalise to `<name>_thumb.png`" contract both assume PNG.

## 4. Every script that prints a summary needs UTF-8 streams ⚠️

`split_spreads.py` crashed with `UnicodeEncodeError` on
`ОКТОИХ петогласник 2` — **after doing all 162 images of work** — because Windows
stdout defaults to a legacy code page (cp1250 on this machine) that cannot encode
Cyrillic, and the JSON summary contains the folder path.

Since the summary on stdout *is* the seam-4 contract, this turns a successful run
into a failed one. Montenegrin material is routinely Cyrillic, so this would have
hit on day one in production.

- [ ] Apply the same fix in **`ocr.py`** and **`web.py`**: pin `sys.stdout` to
      UTF-8 (and `stderr` to UTF-8 with `backslashreplace`, so a log line can
      never kill the process). See `split_spreads.force_utf8_streams()` — worth
      moving into the shared helper module.
- [ ] While there: neither script currently emits the **JSON summary on stdout**
      that docs/04 seam 4 specifies. `split_spreads.py` shows the shape.

## 5. `ocr.py` is still Linux-only

Already tracked as a checkbox in [Epic 06](06-processing-pipeline-and-jobs.md):
`resource.setrlimit` does not exist on Windows, and Windows is the target OS.
Repeated here so the `py/` work is in one place.

- [ ] Replace the `resource.setrlimit` memory cap with a Windows-safe approach.

## Also owed (not a mismatch, just missing)

- [ ] **`py/requirements.txt`** — none exists. Verified working on this machine:
      **Python 3.14.7 + Pillow 12.3.0** (a `cp314` wheel is published, no build
      needed). `split_spreads.py` needs only Pillow.
- [ ] **`py/README.md`** — the seam-4 CLI contract (args in → output files + JSON
      summary on stdout + exit codes) is specified in docs/04 but not written
      down for the scripts. `split_spreads.py`'s docstring documents its own
      contract in the meantime.

## Acceptance

- `web.py` (or its successor) processes a flat folder of JPGs — `CERNAGORA`,
  `ОКТОИХ петогласник 2`, `Pisma iz Liona` — in **correct page order**.
- Output filenames agree with `domain/naming.ts` in both directions.
- All three scripts run clean on a Cyrillic-named folder and print a parseable
  JSON summary.
- `ocr.py` runs on Windows.
