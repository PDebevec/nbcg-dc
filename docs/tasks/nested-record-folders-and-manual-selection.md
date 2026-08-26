# Nested record folders: let the operator pick, don't guess

> Lane: **Arch (`.rs`)** + **GUI (`.vue`)**, decision made · Found: 2026-08-26
> Data: [05-real-scan-data](../05-real-scan-data.md) (a fuller slice, `arh/`,
> supplied by Peter 2026-08-26) · Relates to: Epic 02

Found running the app against a real, uncurated slice of the archive (`arh/`)
during the job-runner/cancellation smoke test
([06-processing-pipeline-and-jobs](06-processing-pipeline-and-jobs.md)).

## The finding

`core::fs::scan_root` (`src-tauri/src/core/fs/mod.rs`) is **strictly one level
deep, no recursion**: every immediate subdirectory of the configured
`unprocessedRoot` becomes exactly one item; anything nested deeper is
invisible, and loose files sitting directly in the root are skipped entirely.
Confirmed by reading the code — there is no `WalkDir`/recursion anywhere in
`core/fs`.

Real archive folders don't always match that shape. In `arh/`:

```
Cèrnagora/
  CERNAGORA/              <- 392 files, a real book
  CERNAGORA... 1851/      <- 132 files, a different real book
  CERNAGORA.jpg           <- one loose file
  CERNAGORA... 1851.pdf   <- one loose file
```

Pointed at `Cèrnagora/`'s parent, the scan produces **one** item (`Cèrnagora`,
two loose-file "assets," the 524 real images completely invisible). Pointed at
`Cèrnagora/` itself, it produces the two real books correctly — but that only
works because I hand-picked the right depth; nothing in the app can do that on
its own for an arbitrary archive.

**Porting `py/web.py`'s own `--recursive` heuristic doesn't solve it either.**
That script's `classify_folder` (`py/web.py:185-193`) stops descending as soon
as a folder has any direct image file — but `Budua und Cetinje/` has exactly
that same shape as `Cèrnagora/` (one loose image + one subfolder) and needs
the **opposite** answer: `Budua und Cetinje` itself is the one real record,
and its `sa vodenim zigom/` subfolder (a watermarked duplicate of the same
image) must be ignored, not descended into. Two folders, identical structure
on disk, opposite correct classification — there is no purely structural
signal (file counts, extensions, "has subfolders") that tells them apart.

## Decision (Peter, 2026-08-26)

**No automatic heuristic decides this. The operator picks**, the way they
would in a file browser: `arh/` (or whatever root is configured) is the one
thing the app is told about, but the operator can navigate into it at any
depth and designate *any* folder — `Cèrnagora/CERNAGORA`, or
`Budua und Cetinje` itself without ever opening `sa vodenim zigom/` — as a
record. One folder is presumed to hold exactly one record (no record's pages
are split across sibling folders), but which folder that is, at whatever
depth, is the operator's call, not a guess baked into the scanner.

This replaces silent auto-classification of ambiguous folders with explicit
operator action; it does not need to change how an already-flat archive
works today (a root full of plain item folders should still just show up,
zero extra clicks).

## Open mechanics (not yet decided — this is a task doc, not a spec)

- **New Rust IPC surface** to browse: something like
  `fs_list_subfolders(path) -> [{name, path, hasDirectFiles, subfolderCount}]`
  so the GUI can walk one level at a time without a full recursive scan up
  front. Reuse `describe_folder`'s per-folder inspection rather than
  duplicating it.
- **Registering a manually-picked folder as an item.** Today every `items`
  row comes from `scan_root`'s implicit one-level walk. Need either a new
  command (`index_add_item(path)`) or a generalization of the existing
  scan/reconcile path to accept explicit paths at arbitrary depth under the
  root, alongside the automatic top-level ones.
- **Avoiding a double-listing.** Once `Cèrnagora/CERNAGORA` is manually
  claimed, should `Cèrnagora` itself stop appearing as its own (wrong,
  wrapper) top-level item from the automatic scan? Almost certainly yes —
  needs a rule, e.g. "a folder with a manually-claimed descendant is excluded
  from the automatic listing," mirroring `web.py`'s own "a folder already
  claimed as an item should not have its own subfolders reprocessed," just
  running in the other direction.
- **GUI**: Overview needs a way to enter "browse instead of accept the
  automatic listing" for a given row — a tree/drill-down view, not just the
  current flat table. Exact interaction (a folder icon that expands in
  place? a separate picker dialog? multi-select at a chosen depth, like
  selecting `CERNAGORA` and `CERNAGORA... 1851` in one pass?) is undecided.
- **DB/schema**: confirm `items.folder_path` and whatever currently assumes
  "one level under the root" (if anything does, beyond `scan_root` itself)
  tolerates an arbitrary-depth path cleanly.

## Acceptance

- Pointing `unprocessedRoot` at `arh/` and nothing else, the operator can
  reach `CERNAGORA`, `CERNAGORA... 1851`, `ОКТОИХ петогласник 1`, and
  `ОКТОИХ петогласник 2` as four separate, correctly-shaped items, and also
  keep `Budua und Cetinje`, `Успомена са Цетиња`, `Pisma iz Liona`, and
  `Plakat …` as the four top-level items they already are today — all eight,
  from one root, without renaming or restructuring anything on disk, and
  without ever editing `config.json` by hand.
- A folder structurally identical to another (loose file + one subfolder)
  but semantically different (`Budua und Cetinje` vs `Cèrnagora`) is never
  silently misclassified either way — the operator decides both.
