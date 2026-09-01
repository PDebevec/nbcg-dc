# Nested record folders: let the operator pick, don't guess

> Lane: **Arch (`.rs`)** + **GUI (`.vue`)**, **decided, built and shipped
> 2026-08-27** · Found: 2026-08-26
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

## What actually shipped (2026-08-27) — supersedes "Open mechanics" below

The mechanics sketched below (browse-one-level-at-a-time,
`fs_list_subfolders`, a manual "claim this folder" command, a
double-listing-exclusion rule) turned out to be more machinery than the
problem needed. What shipped instead, per a later, more concrete instruction
from Peter ("depth doesn't matter, every folder is a potential record, the
operator hides the noise, just like file explorer"):

- **`core::fs::scan_root` now recurses to arbitrary depth** (capped at 32
  levels, a pure safety valve) — **every** folder under a configured root is
  a candidate item, full stop, no browse/claim step. `Cèrnagora`,
  `Cèrnagora/CERNAGORA`, and `Cèrnagora/CERNAGORA... 1851` all show up as
  three separate Overview rows automatically, indented to show the nesting
  (rows sort parent-before-descendants for free — a relative-path string
  sort already does this, no tree structure needed).
- **Item identity changed from name-only to root-relative-path hashing**
  (`core::fs::item_id_for`) — required, not a nicety: two folders at
  different depths sharing a leaf name (`arh/BookA/1`, `arh/BookB/1`) would
  otherwise collide onto the same id and silently overwrite each other in the
  index. For every folder that existed before recursion (all depth-1), the
  relative path *is* the bare name, so this is a no-op for all existing data
  — confirmed by a dedicated regression test.
- **No double-listing rule was needed.** Instead: a per-row **Hide** action
  (Overview ⋯ menu) plus a **Show hidden** toolbar toggle. The operator hides
  `Cèrnagora` (the wrapper — noise) and keeps its two children visible, or
  hides `sa vodenim zigom` (the duplicate child under `Budua und Cetinje`)
  directly. **Deliberately no cascade** — hiding a folder affects only that
  row, never its descendants or ancestors. This was checked against both
  motivating examples before deciding: cascading the `Cèrnagora` hide would
  have taken its two real-book children down with it, which is exactly
  backwards. Hidden state persists in the SQLite index (`items.hidden_at`,
  nullable timestamp) and survives both a rescan and an index rebuild.
- **Two new commands** rather than the sketched `fs_list_subfolders`/
  `index_add_item`: `index_set_hidden(itemId, hidden)` (the Hide/Unhide
  action) and `fs_peek_folder(path)` (the "View contents" row action — a
  thin wrapper directly reusing `describe_folder`, exactly the reuse this
  doc originally asked for, just attached to a simpler surface). "Open in
  Explorer" needed no changes at all — `fs_reveal_path` already took an
  arbitrary path.
- **`move_to_processed` now preserves an item's full relative path** across
  the `/unprocessed` → `/processed` move (previously flattened to the leaf
  name) — required so a nested item's id survives the move under the new
  relative-path-derived id scheme.

## Open mechanics (historical — the original sketch, not what shipped)

- ~~New Rust IPC surface to browse one level at a time
  (`fs_list_subfolders`)~~ — not needed; full recursion + Hide replaced it.
- ~~A manual "claim this folder as an item" command (`index_add_item`)~~ —
  not needed; every folder is already a candidate.
- ~~A rule to avoid double-listing a wrapper once a descendant is claimed~~ —
  not needed; per-row Hide (no cascade) does this job better, since it also
  covers the reverse case (hiding a noisy *child*, keeping the parent).
- ~~A tree/drill-down GUI, exact interaction undecided~~ — a flat,
  depth-indented table was sufficient; no expand/collapse control was built
  (see Deferred below).

## Acceptance

- Pointing `unprocessedRoot` at `arh/` and nothing else, the operator can
  reach `CERNAGORA`, `CERNAGORA... 1851`, `ОКТОИХ петогласник 1`, and
  `ОКТОИХ петогласник 2` as four separate, correctly-shaped items, and also
  keep `Budua und Cetinje`, `Успомена са Цетиња`, `Pisma iz Liona`, and
  `Plakat …` as the four top-level items they already are today — all eight,
  from one root, without renaming or restructuring anything on disk, and
  without ever editing `config.json` by hand. ✅ — verified live against
  the real `arh/` data.
- A folder structurally identical to another (loose file + one subfolder)
  but semantically different (`Budua und Cetinje` vs `Cèrnagora`) is never
  silently misclassified either way — the operator decides both, via Hide.
  ✅

## Deferred (fast-follows, not built in this pass)

Real, deliberately-scoped-out polish — build only if it turns out to matter:

- A real collapsible/expandable tree control in place of the flat
  indented-and-sorted list.
- A bulk "hide this folder's entire subtree in one click" action (per-row
  hide is functionally complete without it, just more clicks on a very deep
  wrapper).
- Table virtualization/pagination if real candidate counts prove large
  enough to matter (unknown yet — `arh/` today is dozens of folders, not
  thousands).
- Lazy/on-demand asset loading during the recursive scan if eager
  `describe_folder`-per-folder proves slow on a much larger real archive.
- Richer "view contents" previews (thumbnails/image preview) beyond
  filename+size chips.
- A "possible wrapper" hint badge (subfolder count) on rows that have
  children.
- Parent/child metadata auto-linking between sibling records discovered
  under a common wrapper (`domain/parent.ts` territory — Epic 04/05, a
  materially different and bigger design question).
- Bulk hidden-state management (e.g. "un-hide everything") beyond the single
  global show/hide toggle.
