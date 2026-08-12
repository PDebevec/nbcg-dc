# NBCG-DC — Native core & developer setup

> Status: **config + fs + db implemented**; jobs/Python not started
> Last updated: 2026-08-12 · Rust suite **73 green**, TS suite **618 green**

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
| `jobs_*` | 3 | ❌ **not started** (Epic 06) |

Events: `fs://changed` ✅ emitted. The three `job://*` channels are not, since
the runner does not exist yet.

**23 of 26 commands are live.** The remaining three are the pipeline runner,
which is blocked behind the Python fixes in
[`py-real-data-mismatches`](tasks/py-real-data-mismatches.md) anyway.

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
  lib.rs                builder: plugins, managed state, the 23 commands, watcher wiring
  main.rs               entry point
  error.rs              AppError — serialized to the TS side as a plain string
  dto.rs                serde mirrors of every type in src/ipc/bindings.ts
  commands/             thin #[tauri::command] wrappers — no logic worth testing
    config.rs  fs.rs  index.rs  batch.rs  sync.rs
  core/                 plain Rust; the whole test surface
    config/mod.rs       store file + OS credential store
    db/                 mod.rs (schema/migrations) · items.rs · batches.rs · sync_runs.rs
    fs/                 mod.rs (scan, mirror, move) · watcher.rs
tests/                  integration tests over core/
  common/mod.rs  config_store.rs  db_items.rs  db_batches.rs
  db_sync_runs.rs  fs_core.rs  workflow.rs
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
cargo test             # 73 tests
cargo clippy --all-targets
cargo fmt
```

Nothing to do for the database — it is created and migrated on first launch,
per machine. It is a local index of *your* folders, not shared state; no server,
no connection string, no manual migration step.

---

## 6. Test suite

73 Rust tests, all against `core/` with real SQLite and real temp directories —
no mocks, because the things worth testing here are exactly the ones a mock
would paper over.

| File | Tests | Covers |
|---|---|---|
| `db_items.rs` | 18 | scan reconciliation, the three write paths, rebuild |
| `db_batches.rs` | 13 | numbering, atomic stamping, release-on-archive, rollback |
| `fs_core.rs` | 22 | scanning, derived-file detection, atomic mirror, moves, **Cyrillic names** |
| `config_store.rs` | 8 | store round-trip, partial config, corrupt-file tolerance |
| `db_sync_runs.rs` | 6 | ordering, limits, retention cap |
| `workflow.rs` | 3 | full lifecycle; rebuild-from-folders; reopen |
| `db/mod.rs` (unit) | 3 | migration idempotence, timestamp format |

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

- **`jobs_start` / `jobs_cancel` / `jobs_reprocess`** and the three `job://*`
  events — the queue, OCR-aware concurrency cap, single-run lock, and
  `(inputShape, stage) → script` mapping. See
  [Epic 06](tasks/06-processing-pipeline-and-jobs.md).
- **The Python fixes** — `web.py` cannot process any real scan folder today.
  See [py-real-data-mismatches](tasks/py-real-data-mismatches.md).
- **Per-file re-upload granularity** (Epic 07) — an optimisation, not a blocker.
- **Packaging** — [Epic 11](tasks/11-packaging-and-distribution.md), entirely
  unstarted.
