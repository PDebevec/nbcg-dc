# Cover shots: the one bad split, and the thumbnail they should probably be

> Lane: **logic (`.ts`)** + a decision from Jernej · Found: 2026-08-07
> Data: [05-real-scan-data](../05-real-scan-data.md) · Relates to: Epics 04, 06

Two findings that turned out to be the same finding, from running
[`py/split_spreads.py`](../../py/split_spreads.py) over all 162 scans of
`ОКТОИХ петогласник 2`.

## The finding

**A scan folder is not homogeneous.** That book breaks down as:

| Images | What they are | Orientation |
| --- | --- | --- |
| `000`, `001` | front matter (title page etc.) | portrait — single pages |
| `002` … `159` | the text | landscape — **2-up spreads** |
| `160` | a page | portrait — single page |
| `161` | the **open leather binding** (front + back cover + spine) | landscape — *not a spread* |

Splitting is decided per image (correctly — 159 spreads split, 3 singles copied
through, all gutters detected). But `161` is landscape and so gets split, and it
is the **only badly-cut image of the 159**: balance 0.76 versus a median of 0.96,
because the spine is a wide dark band and the darkest-column rule lands on its
edge rather than its middle.

Tuning the heuristic does **not** fix it. Cutting at the dark band's *centre* was
implemented, measured, and reverted: the cover got worse (1578/2078 → 1456/2200,
the dark leather widening the band past the spine) while genuine text spreads moved
by ~5px. A cover photographed open simply is not two pages, so no gutter rule will
place a sensible cut in it. It is a **content** classification, not a detection
problem.

## …and the second half of it

Epic 06 says the thumbnail is the item's first page, and after the `page-images`
fix `domain/pipeline.planThumbnail` auto-picks `pages[0]` — `000.jpg`, the title
page. Sensible, and far better than asking the operator to choose among 162.

But **the cover is almost certainly the better thumbnail** for a catalogue entry,
and it is the last image, not the first. So the same misfit image is both the one
thing we should not split and the one thing we should probably show.

## Options (a decision is needed before implementing)

Position is **not** a usable signal: the cover is last here, but front matter is at
the start and is portrait, so "first or last image is the cover" holds for neither
end reliably. Candidates:

1. **Operator marks non-page images** in the Setup/Metadata tab — "cover", "not a
   page". Explicit, always correct, and it feeds both decisions at once (exclude
   from splitting, offer as the thumbnail). Costs one interaction per book that
   has one.
2. **Detect the cover** by material/appearance (a leather binding looks nothing
   like a text page — far darker, no text). Needs pixel access, so it lands in the
   Arch lane, and a wrong guess damages a page.
3. **Accept it.** One poorly-split image per book, and the title page as the
   thumbnail. Cheapest, and honestly not terrible — but it puts a mangled image in
   the middle of every published PDF.
4. **Split, but keep the unsplit original too**, so a cover is available whole even
   though its halves are in the page sequence. Wasteful but lossless.

My inclination is **1**, because it answers both questions with one operator
action and cannot be silently wrong — but it is a UX decision, so it is Jernej's.

## Tasks (blocked on the decision)

- [ ] **Decide** how cover / non-page images are identified.
- [ ] `.ts`: represent it — probably an extension of
      `domain/batch.BatchItemOverride` alongside `contentKind` (e.g. a set of
      excluded filenames, or a nominated cover), persisted with the batch.
- [ ] `.ts`: exclude such images from `domain/pipeline.pageImages` so they are
      neither split nor assembled into the PDF, and carry the exclusion to the
      runner in `ItemRunRequest`.
- [ ] `.ts`: let a nominated cover win over `pages[0]` in `planThumbnail`.
- [ ] `.py`: honour the exclusion in `split_spreads.py` (a `--skip` list, or just
      operate on the list the runner passes rather than scanning the folder).
- [ ] `.vue`: whatever the decision needs — a per-image "not a page / use as
      cover" control in the Setup or Metadata tab.

## Acceptance

- The open-cover scan of `ОКТОИХ петогласник 2` is not cut in half.
- That book's PDF contains 321 clean pages with no mangled image.
- The item's thumbnail is whatever the decision says it should be, reachable
  without the operator sifting 162 candidates.
