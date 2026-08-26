# NBCG-DC — Native core & developer setup

> Status: **config + fs + db + jobs (first slice + real cancel) implemented**
> Last updated: 2026-08-24 · Rust suite **100 green**, TS suite **618 green**

What the Rust lane (`src-tauri/`) currently does, how it is laid out, and what a
developer needs installed to build or run it. This is the companion to
[04 – Code structure](04-code-structure.md), which describes the *intended*
layout; this file records what actually exists.

---

## 1. Status at a glance

| Group | Commands | State |
|---|---|---|
| `config_*` | 5 | ✅ implemented |
| `fs_*` | 7 | ✅ implemented |
| `index_*` | 5 | ✅ implemented |
| `batch_*` | 4 | ✅ implemented |
| `sync_*` | 2 | ✅ implemented |
| `jobs_*` | 3 | ✅ **implemented — first slice** (Epic 06) |

Events: `fs://changed` and all three `job://*` channels ✅ emitted for real.

**26 of 26 commands do real work.** `jobs_start`/`jobs_reprocess` spawn
`py/web.py`/`py/ocr.py`/`py/split_spreads.py`/`py/pdf_derive.py` (system
`python`/`py` on `PATH` — no sidecar bundling yet, deferred to Epic 11 while
the app is dev-only) via `core::python`, sequentially — one item, one stage at
a time, no concurrency/queue. `core::jobs`
does the orchestration: real SQLite stage writes (`set_stage`, pre-existing —
its own doc comment anticipated this use), real `job://*` events, a native
single-run lock (`AppState.job_run`), and atomic output writes (script writes
into a `.nbcg-tmp-*` staging dir, Rust renames into place on success via the
new `core::fs::finalize_staged_output`).

**All six `InputShape`s are handled:**

| Shape | What runs |
|---|---|
| `PageImages` / `Tiffs` | `web.py` assembles the folder's images (`--mode flat`/`paired`) |
| `ImagesOnly` | thumbnail only (`web.py --thumbnail-only`) — a standalone graphical work has no PDF, so no OCR either |
| `SuppliedPdf` | `pdf_derive.py` downscales the operator's PDF into `<folderName>.pdf`; the original is filed under `source/` |
| `MultiplePdfs` | the discovered PDFs already *are* the web PDFs — the `pdf` stage verifies rather than builds, one `<base>_thumb.png` candidate is rendered per PDF, and OCR writes one `<base>.txt` each |
| `Empty` | nothing to run |

**Filing a supplied PDF under `source/` is required, not tidiness.**
`domain/files.classifyAsset` calls every non-`_archive` PDF a `web-pdf` and
`classifyInput` branches on how many the folder holds, so leaving the original
beside the derived `<folderName>.pdf` would make the item read as
`MultiplePdfs` on the next scan — a silent shape change, with the full-size
original then uploading as a web asset. `describe_folder` lists files without
recursing (§below), so one subfolder keeps the count at one. Re-runs derive
from the filed original rather than the previous output, or each run would
downscale a downscale. See
[docs/05 open question #1](05-real-scan-data.md), answered 2026-08-21.

Deliberately **not** in this slice, flagged as follow-ups: true OCR-aware
concurrency (still no queue — sequential only), and an *interactive*
multi-candidate thumbnail picker (there is no GUI for one yet).

**Mid-process cancellation is real, 2026-08-24** — and fixing it surfaced a
worse bug underneath. `jobs_start`/`jobs_reprocess` were plain synchronous
`#[tauri::command]`s, which Tauri v2 runs inline on the **main thread**
(`ExecutionContext::Blocking`) rather than dispatching to a worker. A whole
batch ran inside that one IPC call — freezing the window for the run's
duration — and `jobs_cancel`, also an invoke, could not even be *delivered*
until the run it was meant to cancel had already finished on its own. The
runner's own cooperative between-items cancel check was correct but
unreachable in practice — not because no UI existed (**correction,
2026-08-25:** `src/views/batch/ProcessingTab.vue`/`src/composables/useProcessing.ts`
already called the real IPC commands, committed in `15511db "Frontend v2, my
TODO"`, predating this fix — this section previously and wrongly said "no UI
calls `jobs_start` yet"), but because nobody had actually clicked through a
real run yet to observe the freeze. Fixed by marking both `#[tauri::command(async)]`, so
the body dispatches onto a tokio worker instead
(`tauri::async_runtime::spawn`) and the main thread stays free to handle
`jobs_cancel` promptly.

That alone would only stop the *next* stage, so `core::python::spawn_python`
was rewritten from a single blocking `Command::output()` call into a
spawn-then-poll loop (`core::cancel::CancelToken`, shared via
`JobRunGuard::cancel_token()`): the child's stdout/stderr are piped and
drained on their own threads (skipping this deadlocks the moment a chatty
script like `ocr.py` — one log line per page — fills an undrained pipe
buffer), and every 100 ms the loop checks both `try_wait()` and the cancel
token, killing the child immediately on a match. A cancelled script now
returns `AppError::Cancelled` — a distinct error kind from a real failure —
so `core::jobs`'s stage-settle points can tell "the operator cancelled this"
from "the script crashed" and write `Pending`, never `Failed`: a cancel is not
a failure, so `stagesToRun` just picks the stage back up on the next Start
with no red the operator didn't cause. A new `reset_unfinished_stages` also
closes a related bug found alongside it — `run_batch` queues every stage of
every item up front and previously never reset that on cancel, so an
un-started item's stages sat `Queued` in SQLite forever after a cancel; they
now read back from the index and reset to `Pending` too.

Every field of `ItemRunRequest` the `.ts` lane decides is now honoured, and
none is re-derived native-side — three of them only after being caught in
review the same day (see [Epic 06](tasks/06-processing-pipeline-and-jobs.md)'s
progress section). The flags added to the scripts for it, all additive and
backward-compatible with the existing `py/tests/` suite:

| Flag | Carries |
|---|---|
| `web.py --mode {flat,paired}` | `inputShape` — instead of `web.py` re-sniffing the folder for jpg/tif subfolders |
| `web.py --pages FILE …` | `pageImages`, the authoritative page order — instead of a re-scan and re-sort |
| `web.py --name BASE` | `folderName`, the naming base — instead of the processed folder's own name |
| `web.py --thumbnail-source FILE` | `primaryThumbnail` (absolute when it must escape the assembly folder) |
| `web.py --thumbnail-only` | the `images-only` shape: no PDF at all |
| `split_spreads.py --pages FILE …` | the same page order, so the split doesn't re-derive it either |
| `web_pdf_bases` | one OCR text per web PDF (`<base>.txt`), the multi-PDF invariant |
| every script's output dir | staging, for the atomic-write rename |

`splitSpreads` runs `split_spreads.py` into the staging folder before `web.py`
and assembles from the page order it reports — an invisible sub-step of `pdf`,
not a visible stage. `page-images` only: on `tiffs` the runner refuses (the
archival master must come from the TIFFs at full fidelity) rather than
ignoring the flag, and on `images-only` it is inapplicable since no PDF is
built. A chosen `primaryThumbnail` is passed as an absolute path so it is
built from the whole original, never half a spread.

Tested at `core::jobs`/`core::python` directly (`src-tauri/tests/core_jobs.rs`,
21 tests) — Pillow and pypdfium2 are installed here, so the
PDF/thumbnail/split/derive paths all run for real, on disk; `ocr.py` needs
paddleocr/paddlepaddle/pdf2image/poppler, none
installed here, so only its wiring (the precondition-failure path) is pinned —
a live OCR pass is a residual gap. Tauri's own mock-IPC test harness
(`tauri::test`) was tried and abandoned: it fails at process startup with
`STATUS_ENTRYPOINT_NOT_FOUND` in this environment, reproducible on a trivial
no-arg command and unrelated to this code, so `core::jobs` is tested directly
instead — consistent with `core/` being Tauri-free by design.

This closes the Arch-lane obligations recorded in Epics
[02](tasks/02-overview-and-index.md), [03](tasks/03-batches-and-lifecycle.md),
[08](tasks/08-sync-and-backend-data.md) and [10](tasks/10-settings-and-naming.md),
and the non-jobs half of [07](tasks/07-upload-and-publish.md).

---

## 2. Layout

Follows [04 – Code structure](04-code-structure.md) exactly. The split matters:
`core/` contains **no Tauri types**, which is the only reason it can be
unit-tested without a webview.

```
src-tauri/src/
  lib.rs                builder: plugins, managed state, the 26 commands, watcher wiring
  main.rs               entry point
  error.rs              AppError — serialized to the TS side as a plain string
  dto.rs                serde mirrors of every type in src/ipc/bindings.ts
  commands/             thin #[tauri::command] wrappers — no logic worth testing
    config.rs  fs.rs  index.rs  batch.rs  sync.rs  jobs.rs
  core/                 plain Rust; the whole test surface
    config/mod.rs       store file + OS credential store
    db/                 mod.rs (schema/migrations) · items.rs · batches.rs · sync_runs.rs
    fs/                 mod.rs (scan, mirror, move) · watcher.rs
    jobs/mod.rs          the job runner: single-run lock, stage-to-script mapping, events
    python/mod.rs        spawning the py/ scripts, parsing their JSON summaries
tests/                  integration tests over core/
  common/mod.rs  config_store.rs  db_items.rs  db_batches.rs
  db_sync_runs.rs  fs_core.rs  workflow.rs  core_jobs.rs
  fixtures/tiny.jpg      a real minimal JPEG — core_jobs.rs exercises web.py for real
  fixtures/tiny2.jpg      a second, distinctly-colored JPEG — proves *which*
                           source image a test's output actually came from
  fixtures/spread.jpg     a red-left/blue-right landscape 2-up with a dark
                           gutter — one pixel says whether an output came
                           from half a spread or the whole one
```

### Dependencies added

`rusqlite` (bundled SQLite) · `keyring` (Windows Credential Manager) ·
`notify` (fs watcher) · `tauri-plugin-dialog` (folder picker) · `thiserror` ·
`chrono` · `uuid` · `tempfile` (dev).

---

## 3. The SQLite index

Created automatically at `%APPDATA%\local.nbcg-dc\index.db` on first launch,
in WAL mode, with `foreign_keys` ON. Migrations run on startup, versioned via
`PRAGMA user_version` (currently `1`).

| Table | Holds |
|---|---|
| `items` | path, root, level, `backend_id`, `version`, `uploaded`/`reupload`, `batch_id`, `miss_streak`, title, timestamps |
| `item_stages` | `(item_id, stage)` → status + error, for the five pipeline stages |
| `item_assets` | discovered files per item |
| `batches` | one row per batch; `parents`/`overrides`/`proc` as JSON columns |
| `batch_items` | membership + order |
| `sync_runs` | run history, capped at 100 rows |

> **Column naming:** `no`, `type` and `trigger` are SQLite keywords, so the
> columns are `batch_no`, `item_type` and `trigger_kind`. DTO field names are
> unchanged — the mapping happens in the query layer.

It is a **local index only**, never authoritative catalogue data, and it is
disposable: `index_rebuild` reconstructs the whole thing from the folders.

---

## 4. Decisions worth knowing

### Item ids are a deterministic hash of the folder name

Not UUIDs. `index_rebuild` wipes the item table and re-derives it from disk, and
batches reference items by id — random ids would survive only in the batch's
membership list, silently emptying every batch. `item_id_for()` is FNV-1a over
the folder name (Rust's default hasher is randomly seeded per process and would
produce a different id every launch).

Keyed on the **name**, not the path, so moving `/unprocessed` → `/processed`
does not change identity. Renaming a folder *does* mint a new item — the honest
reading, since the folder name is the item's name and its derived files are
named after it. On a name collision across the two roots, unprocessed wins.

### The three item write paths are not interchangeable

- `reconcile` (scan) — filesystem facts only. Never touches
  `uploaded`/`reupload`/stages/`batch_id`/`miss_streak`. Adopts a `backend_id`
  from `metadata.json` only when the row has none, so a stale mirror can never
  overwrite a live connection.
- `record_upload` — sets the connection, flips `uploaded`, clears `reupload`,
  marks the `upload` stage done.
- `record_sync` — a **read**. Uses `COALESCE(?, column)` throughout, so a null
  means "leave unchanged", not "clear". Critically, a null `version` must not
  clear the stored one: it gates the next `PATCH expectedVersion`.

Every way of confusing these is silent — the item still renders, just in a state
nobody put it in. Hence the disproportionate test coverage on `record_sync`.

### JSON columns for batch sub-objects

`parents`, `overrides` and `proc` are JSON text; `item_ids` is a real child
table. The first three are always read and written as a whole batch and never
queried across batches; membership has an order and joins against `items`.

### `batch_create` is transactional, and numbers never recycle

The batch row, its membership, and the `batch_id` stamp on each item are one
fact. A batch whose row exists but whose items were not stamped leaves those
items selectable into a *second* batch. Numbers come from `MAX(batch_no) + 1`
over all rows including archived ones — the operator refers to batches by
number, and a recycled one would point at two different things.

`archive` releases only items still pointing at *that* batch, so an item since
claimed elsewhere is left alone.

### Atomic writes

`metadata.json` and `config.json` are both written temp → `sync_all` → rename.
The mirror is what a rebuild reconstructs from, so a truncated one loses an
item's backend connection and the next upload creates a duplicate record.

### Rust does no HTTP

All backend calls stay in TypeScript (`services/api/`), per the seam-3 decision
in [04](04-code-structure.md). The native core never sees the Keycloak token
except to store it.

---

## 5. Developer setup

### What you need, and when

| You are | Rust + Build Tools? | What you get |
|---|---|---|
| Working on `.vue` / `.css` only, via `npm run dev` | **No** | Browser view. Renders fully, but **0 items, no batches, no scanning** — every IPC call is unavailable outside Tauri. Config persists only via a dev-only `localStorage` fallback. Fine for styling; useless for behaviour. |
| Running the real desktop app from source — even unchanged | **Yes** | The actual app |
| Library staff | **No** | The installer (Epic 11) |

The middle row is the one that surprises people. The repo ships **source, not a
binary** (`src-tauri/target/` is gitignored), so `git clone && npm install`
cannot produce a running desktop app. You must compile to see an item appear,
whether or not you intend to touch a line of Rust.

**Escape hatch:** hand a colleague a compiled `nbcg-dc.exe` and it runs with no
toolchain at all. That is exactly what the Epic 11 installer formalises — and
why bundling matters far more for Python (a genuine *runtime* dependency) than
for Rust (build-time only).

### Why Visual Studio is involved

Rust ships no linker for Windows. The default target
(`x86_64-pc-windows-msvc`) links with Microsoft's `link.exe` and needs the
Windows SDK; separately, `rusqlite`'s `bundled` feature compiles SQLite from C
and needs `cl.exe`. We install **Build Tools** — the command-line compiler,
linker and SDK — not the Visual Studio IDE.

*(The `windows-gnu` target avoids Microsoft tooling entirely, but Tauri
officially targets MSVC on Windows.)*

### Install

```powershell
winget install Rustlang.Rustup
rustup default stable

winget install Microsoft.VisualStudio.2022.BuildTools --override `
  "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

The Build Tools installer needs an **admin UAC prompt that must be clicked** —
an unattended run exits with code `1602` (user cancelled) if nobody accepts it.

First full compile of the Tauri dependency tree takes **~5.5 minutes**;
incremental builds afterwards are seconds. `Cargo.lock` is committed, so
everyone resolves identical dependency versions.

### Commands

```bash
npm run dev            # frontend only, no Rust — hollow but fast
npm run tauri dev      # the real app, with the native core
npm run build          # vue-tsc typecheck + vite build

cd src-tauri
cargo test             # 101 tests
cargo clippy --all-targets
cargo fmt
```

Nothing to do for the database — it is created and migrated on first launch,
per machine. It is a local index of *your* folders, not shared state; no server,
no connection string, no manual migration step.

---

## 6. Test suite

101 Rust tests, all against `core/` with real SQLite, real temp directories,
and — for `core_jobs.rs`/`core::python`'s own unit tests — real Python
subprocesses (`web.py`/`split_spreads.py`/`pdf_derive.py`, and a bare `python
-c` for the cancel/pipe-draining tests). No mocks, because the things worth
testing here are exactly the ones a mock would paper over.

| File | Tests | Covers |
|---|---|---|
| `db_items.rs` | 20 | scan reconciliation, the three write paths, rebuild, `mark_needs_reupload` |
| `db_batches.rs` | 13 | numbering, atomic stamping, release-on-archive, rollback |
| `fs_core.rs` | 25 | scanning, derived-file detection, atomic mirror, moves, **Cyrillic names**, `finalize_staged_output` |
| `core_jobs.rs` | 21 | the job runner end to end across all six input shapes (real `web.py`/`split_spreads.py`/`pdf_derive.py`), the precondition-gated OCR path, the single-run lock, `primaryThumbnail`/`--mode`/`splitSpreads`/supplied-PDF-filing correctness, that a cancel — before a run starts, or mid-item — settles every affected stage `Pending`, never `Failed`, with exactly one terminal `Cancelled` event and no misleading per-item `Done`, and (new, 2026-08-26) that a cancel landing during `pdf`/`thumbnail` also settles the still-queued `ocr` stage `Pending`, not a stale precondition `Failed` |
| `config_store.rs` | 8 | store round-trip, partial config, corrupt-file tolerance |
| `db_sync_runs.rs` | 6 | ordering, limits, retention cap |
| `workflow.rs` | 3 | full lifecycle; rebuild-from-folders; reopen |
| `db/mod.rs` (unit) | 3 | migration idempotence, timestamp format |
| `core::python` (unit, new 2026-08-24) | 2 | a cancelled child is killed within ~1s rather than waited out; a script that floods stderr (the `ocr.py` shape) still completes without deadlocking the undrained-pipe pathway |

The unicode coverage is deliberate: `ОКТОИХ петогласник 2` — Cyrillic **with
spaces** — comes from the real corpus and is a documented risk area
([naming-base-and-unicode-filenames](tasks/naming-base-and-unicode-filenames.md)).

The **secret store is deliberately untested**: `keyring` writes to the real
Windows Credential Manager for the logged-in user, so a test would mutate the
developer's own store and could clobber a live `apiToken`.

---

## 7. Capability changes

[`capabilities/default.json`](../src-tauri/capabilities/default.json) gained:

- `core:app:allow-version` — without it `getAppVersion()` silently falls back to
  the compiled-in constant and the Settings version line drifts from the
  installed bundle.
- `dialog:allow-open` — the folder picker.
- `opener:allow-reveal-item-in-dir` — Overview ⋯ → Open in Explorer.

The `http:default` allow-list (backend + COBISS hosts) was already present.

---

## 8. What is still owed by this lane

- **Concurrency/queueing for `jobs_*`** — the first slice is sequential (one
  item, one stage at a time); an OCR-aware concurrency cap is still open
  question #3 in [Epic 06](tasks/06-processing-pipeline-and-jobs.md). Real
  cancellation (below) is a prerequisite for this, not a substitute — it just
  landed first because it was unblocked.
- **`child.kill()` on Windows reaches the interpreter process only** — if a
  script ever spawned its own children they would survive the kill; none of
  the four scripts does today, so this is a stated limit, not an open bug. A
  Job Object would be the real fix, same reasoning as `ocr.py`'s memory cap
  already being a documented no-op on Windows.
- **Automatic spread detection** — `splitSpreads` is honoured but stays an
  operator toggle: telling a 2-up spread from a landscape map needs pixel
  access (docs/05 open question #4). Related and also open: whether cover
  shots should be excluded from splitting (#5).
- **Sidecar Python bundling** — the runner shells out to system `python`/`py`
  on `PATH`, fine for dev, not for a shipped installer. Epic 11.
- **Per-file re-upload granularity** (Epic 07) — an optimisation, not a blocker.
- **Packaging** — [Epic 11](tasks/11-packaging-and-distribution.md), entirely
  unstarted.

~~The Python fixes~~ — done, 2026-08-20. ~~The real `jobs_*` runner~~ — first
slice done, 2026-08-21 (see §1 above). ~~True mid-process cancellation~~ —
done, 2026-08-24, along with the main-thread-blocking bug it depended on
fixing first (see §1). `py/README.md` documents the Python side;
`src-tauri/tests/core_jobs.rs` documents the Rust side's real coverage.
