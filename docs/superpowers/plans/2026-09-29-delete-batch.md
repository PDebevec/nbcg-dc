# Delete Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator delete an unfinished batch, putting every member item back exactly as it was before the batch — folders and index — as long as the batch hasn't written to the backend.

**Architecture:** When a batch is created, each member's item scope (direct files + `source/`) is hard-linked into `<scan root>/.nbcg-snapshots/<batchId>/<itemId>/` and its index row is copied into a new `batch_snapshots` table. Delete makes each folder match its snapshot, writes the index rows back, then removes the batch. A write-ahead `backend_touched_at` mark, set just before an upload's first backend write, disables Delete for good. Batch numbers move to a stored counter so a deleted number is never reused.

**Tech Stack:** Rust (Tauri 2, rusqlite 0.40 bundled, tempfile for tests), TypeScript + Vue 3 + Pinia, vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-delete-batch-design.md`

## Global Constraints

- Delete is **local only**; it never calls the backend.
- Blocked-reason texts, identical in Rust (`core::batch_lifecycle`) and TS (`domain/batch.DELETE_BLOCKED`):
  - running: `Stop the processing run before deleting this batch.`
  - uploading (TS only): `Wait for the upload to finish.`
  - archived: `Uploaded batches can't be deleted.`
  - backend: `This batch has already sent changes to the backend, so it can't be undone. Use Close batch instead.`
- Snapshot folder name: `.nbcg-snapshots`. Item scope = direct files + files directly in `source/`; `.nbcg-tmp-*` staging folders are removed on restore, never snapshotted.
- Never `remove_dir_all` a path that isn't `<…>/.nbcg-snapshots/<batchId>`.
- Batch numbers are never reused.
- Commits: only when the user asks (session rule). Each task ends with a green test run instead of a commit.
- Commands: TS tests `npx vitest run`, typecheck `npx vue-tsc --noEmit` (repo root); native `cargo test`, `cargo clippy --all-targets` (in `src-tauri`).

## File map

| File | Responsibility |
|---|---|
| `src-tauri/src/core/db/mod.rs` | migration v4 (column, `batch_snapshots`, `counters`) |
| `src-tauri/src/core/db/batches.rs` | counter numbering, `create_with_id`, `mark_backend_touched`, `delete`, archive/update snapshot-row upkeep |
| `src-tauri/src/core/db/snapshots.rs` (new) | `batch_snapshots` rows: read/insert/list/restore index state |
| `src-tauri/src/core/snapshot.rs` (new) | file side: take / diff / restore / drop / sweep, app-output naming |
| `src-tauri/src/core/batch_lifecycle.rs` (new) | create / preview / delete / archive / sweep across files + DB |
| `src-tauri/src/core/jobs/lock.rs` | `running_batch` |
| `src-tauri/src/core/fs/watcher.rs` | ignore `.nbcg-snapshots` events |
| `src-tauri/src/dto.rs` | `BatchDto.backend_touched_at`, delete-plan DTOs |
| `src-tauri/src/commands/batch.rs`, `src-tauri/src/lib.rs` | commands, registration, startup sweep |
| `src/ipc/bindings.ts` | contract |
| `src/domain/batch.ts` | `backendTouchedAt`, `DELETE_BLOCKED`, `deleteBlockedReason`, plan types |
| `src/services/batches.ts` | preview/delete/mark wrappers |
| `src/services/upload.ts`, `src/stores/useUpload.ts` | `withBackendWriteMark` + wiring |
| `src/stores/useBatches.ts` | `previewDelete`, `remove`, `markBackendTouched` |
| `src/stores/useMetadata.ts` | `forget` |
| `src/composables/useDeleteBatch.ts` (new) | dialog state machine + plan view |
| `src/components/batch/DeleteBatchDialog.vue` (new), `BatchCard.vue`, `src/views/BatchesView.vue`, `src/views/BatchWorkView.vue`, `src/composables/useBatches.ts`, `src/composables/useBatch.ts` | UI |

---

### Task 1: Schema v4, batch counter, backend mark, row-level delete

**Files:**
- Modify: `src-tauri/src/core/db/mod.rs` (SCHEMA_VERSION, migrate, tests)
- Modify: `src-tauri/src/core/db/batches.rs`
- Modify: `src-tauri/src/dto.rs` (`BatchDto`)
- Test: `src-tauri/tests/db_batches.rs`

**Interfaces:**
- Produces: `batches::create_with_id(conn, id: &str, fields: &BatchCreateDto) -> Result<BatchDto>`, `batches::mark_backend_touched(conn, batch_id) -> Result<BatchDto>`, `batches::delete(conn, batch_id) -> Result<()>`, `BatchDto.backend_touched_at: Option<String>`; tables `batch_snapshots(batch_id, item_id, snapshot_dir, item_row, item_dto, taken_at)` and `counters(name, value)`.

- [ ] **Step 1: Write the failing tests** — append to `src-tauri/tests/db_batches.rs`:

```rust
#[test]
fn numbers_are_never_reused_after_deleting_the_newest_batch() {
    let db = db_with_items(&["A", "B"]);
    let a = item_id_for("A");
    let b = item_id_for("B");

    let first = db
        .transaction(|t| batches::create(t, &batch_over(&[&a])))
        .unwrap();
    db.transaction(|t| batches::delete(t, &first.id)).unwrap();
    let next = db
        .transaction(|t| batches::create(t, &batch_over(&[&b])))
        .unwrap();

    assert_eq!(next.no, 2, "deleting batch #1 handed its number to the next batch");
}

#[test]
fn delete_removes_the_batch_and_releases_its_items() {
    let db = db_with_items(&["A"]);
    let a = item_id_for("A");
    let batch = db
        .transaction(|t| batches::create(t, &batch_over(&[&a])))
        .unwrap();

    db.transaction(|t| batches::delete(t, &batch.id)).unwrap();

    assert!(db.with(batches::list).unwrap().is_empty());
    assert_eq!(db.with(|c| items::get(c, &a)).unwrap().batch_id, None);
    let members: i64 = db
        .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM batch_items", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(members, 0, "membership rows outlived their batch");
}

#[test]
fn delete_of_an_unknown_batch_is_not_found() {
    let db = Db::open_in_memory().unwrap();
    assert!(matches!(
        db.transaction(|t| batches::delete(t, "nope")),
        Err(nbcg_dc_lib::error::AppError::NotFound(_)),
    ));
}

#[test]
fn mark_backend_touched_keeps_the_first_timestamp() {
    let db = db_with_items(&["A"]);
    let a = item_id_for("A");
    let batch = db
        .transaction(|t| batches::create(t, &batch_over(&[&a])))
        .unwrap();
    assert_eq!(batch.backend_touched_at, None);

    let first = db.with(|c| batches::mark_backend_touched(c, &batch.id)).unwrap();
    let stamp = first.backend_touched_at.clone().expect("marked");
    let again = db.with(|c| batches::mark_backend_touched(c, &batch.id)).unwrap();

    assert_eq!(again.backend_touched_at, Some(stamp));
}

#[test]
fn update_never_clears_the_backend_mark() {
    let db = db_with_items(&["A"]);
    let a = item_id_for("A");
    let batch = db
        .transaction(|t| batches::create(t, &batch_over(&[&a])))
        .unwrap();
    db.with(|c| batches::mark_backend_touched(c, &batch.id)).unwrap();

    // A copy the TS side read before the mark, sent back by a write-through.
    let mut stale = batch.clone();
    stale.backend_touched_at = None;
    let saved = db.transaction(|t| batches::update(t, &stale)).unwrap();

    assert!(saved.backend_touched_at.is_some(), "a stale update re-enabled Delete");
}
```

And in `src-tauri/src/core/db/mod.rs` `mod tests`:

```rust
    #[test]
    fn migrating_to_v4_seeds_the_batch_counter_from_existing_batches() {
        let conn = Connection::open_in_memory().expect("open");
        migrate(&conn).expect("migrate");
        conn.execute_batch(
            "INSERT INTO batches (id, batch_no, created_at, item_type, stage, publish, visibility) \
             VALUES ('b7', 7, 'now', 'to-process', 'setup', 'DRAFT', 'PRIVATE'); \
             DELETE FROM counters;",
        )
        .expect("seed");
        conn.pragma_update(None, "user_version", 3i64).expect("rewind");

        migrate(&conn).expect("migrate to v4");

        let value: i64 = conn
            .query_row("SELECT value FROM counters WHERE name = 'batch_no'", [], |r| r.get(0))
            .expect("counter");
        assert_eq!(value, 7);
    }
```

- [ ] **Step 2: Run to verify they fail**

Run (in `src-tauri`): `cargo test --test db_batches` and `cargo test --lib core::db`
Expected: compile errors — `batches::delete`, `mark_backend_touched`, `backend_touched_at` don't exist.

- [ ] **Step 3: Implement**

`dto.rs` — in `BatchDto`, after `archived_at`:

```rust
    /// When the batch first wrote to the backend (set write-ahead, just before
    /// an upload's first backend write), or null. Once set the batch can't be
    /// deleted. Native-owned: `batch_update` never writes it, so a stale copy
    /// sent back from the TS side can't clear it.
    #[serde(default)]
    pub backend_touched_at: Option<String>,
```

`db/mod.rs` — `const SCHEMA_VERSION: i64 = 4;` and a new step before the `user_version` bump:

```rust
    if version < 4 {
        // Delete batch (docs/superpowers/specs/2026-09-29-delete-batch-design.md):
        // the write-ahead "reached the backend" mark, each member's pre-batch
        // index state, and a stored batch-number high-water mark — batch rows
        // can now be deleted, so `MAX(batch_no) + 1` alone would reuse a number.
        if !column_exists(&tx, "batches", "backend_touched_at")? {
            tx.execute_batch("ALTER TABLE batches ADD COLUMN backend_touched_at TEXT;")?;
        }
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS batch_snapshots (
                batch_id     TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
                item_id      TEXT NOT NULL,
                snapshot_dir TEXT NOT NULL,
                item_row     TEXT NOT NULL,
                item_dto     TEXT NOT NULL,
                taken_at     TEXT NOT NULL,
                PRIMARY KEY (batch_id, item_id)
            );

            CREATE TABLE IF NOT EXISTS counters (
                name  TEXT PRIMARY KEY,
                value INTEGER NOT NULL
            );

            INSERT OR IGNORE INTO counters (name, value)
                SELECT 'batch_no', COALESCE(MAX(batch_no), 0) FROM batches;
            "#,
        )?;
    }
```

`db/batches.rs`:
- `from_row`: add `backend_touched_at: row.get("backend_touched_at")?,`.
- Replace the numbering in `create` with a call to `next_batch_no`, and split `create`:

```rust
/// The `counters` row holding the highest batch number ever handed out.
const BATCH_NO_COUNTER: &str = "batch_no";

/// Take the next batch number. Numbers are never reused — the operator refers
/// to batches by number, so a recycled one would point at two different
/// things. That used to follow from `MAX(batch_no) + 1` because rows were never
/// deleted; a deleted batch's row is gone, so the high-water mark lives in
/// `counters`. `MAX(batch_no)` still takes part, so a counter that somehow lags
/// the table can't hand out a number already in use.
fn next_batch_no(conn: &Connection) -> Result<i64> {
    let counter: i64 = conn
        .query_row(
            "SELECT value FROM counters WHERE name = ?1",
            params![BATCH_NO_COUNTER],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);
    let max: i64 = conn.query_row("SELECT COALESCE(MAX(batch_no), 0) FROM batches", [], |r| {
        r.get(0)
    })?;
    let next = counter.max(max) + 1;
    conn.execute(
        "INSERT INTO counters (name, value) VALUES (?1, ?2) \
         ON CONFLICT(name) DO UPDATE SET value = excluded.value",
        params![BATCH_NO_COUNTER, next],
    )?;
    Ok(next)
}

pub fn create(conn: &Connection, fields: &BatchCreateDto) -> Result<BatchDto> {
    create_with_id(conn, &uuid::Uuid::new_v4().to_string(), fields)
}

/// [`create`] with a caller-chosen id — `core::batch_lifecycle` needs the id
/// before the row exists, to name the snapshot folders it takes first.
pub fn create_with_id(conn: &Connection, id: &str, fields: &BatchCreateDto) -> Result<BatchDto> {
    let created_at = now_iso();
    let next_no = next_batch_no(conn)?;
    // … the existing INSERT / write_members / stamp_items / get, using `id` …
}
```

(Keep `create`'s doc comment, but say the number comes from [`next_batch_no`].)

- `update`: add to its doc comment "`backend_touched_at` is never written here — see [`mark_backend_touched`]." (the UPDATE already omits it).
- `archive`: after releasing items, drop the snapshot rows (a finished batch can't be deleted, so they'd only hold state):

```rust
    conn.execute(
        "DELETE FROM batch_snapshots WHERE batch_id = ?1",
        params![batch_id],
    )?;
```

- New functions:

```rust
/// Record that `batch_id` is about to write to the backend — write-ahead,
/// called before an upload's first backend write. Idempotent: the first
/// timestamp is kept. From then on the batch can't be deleted, because its
/// changes are no longer only local (`core::batch_lifecycle`).
pub fn mark_backend_touched(conn: &Connection, batch_id: &str) -> Result<BatchDto> {
    let changed = conn.execute(
        "UPDATE batches SET backend_touched_at = COALESCE(backend_touched_at, ?2) WHERE id = ?1",
        params![batch_id, now_iso()],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("batch {batch_id}")));
    }
    get(conn, batch_id)
}

/// Remove a batch's rows — the batch, its membership and its snapshot rows —
/// and release every item still claimed by it.
///
/// Rows only: putting the members' folders and index state back is
/// `core::batch_lifecycle::delete`'s job, which calls this last, in the same
/// transaction as the index restore. The child rows are deleted explicitly
/// rather than left to `ON DELETE CASCADE`, which needs `foreign_keys` on.
pub fn delete(conn: &Connection, batch_id: &str) -> Result<()> {
    if !exists(conn, batch_id)? {
        return Err(AppError::NotFound(format!("batch {batch_id}")));
    }
    conn.execute(
        "UPDATE items SET batch_id = NULL, updated_at = ?2 WHERE batch_id = ?1",
        params![batch_id, now_iso()],
    )?;
    conn.execute("DELETE FROM batch_snapshots WHERE batch_id = ?1", params![batch_id])?;
    conn.execute("DELETE FROM batch_items WHERE batch_id = ?1", params![batch_id])?;
    conn.execute("DELETE FROM batches WHERE id = ?1", params![batch_id])?;
    Ok(())
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cargo test --test db_batches` and `cargo test --lib core::db`
Expected: all pass, including the pre-existing numbering tests.

---

### Task 2: File snapshots (`core::snapshot`)

**Files:**
- Create: `src-tauri/src/core/snapshot.rs`
- Modify: `src-tauri/src/core/mod.rs` (`pub mod snapshot;`)
- Modify: `src-tauri/tests/common/mod.rs` (`write_file`, `tree`)
- Test: `src-tauri/tests/snapshot.rs`

**Interfaces:**
- Produces: `SNAPSHOTS_DIR`, `batch_dir(root, batch_id)`, `item_dir(root, batch_id, item_id)`, `root_of(folder, relative_path) -> Option<PathBuf>`, `take(folder, dest) -> Result<()>`, `diff(folder, snapshot) -> Result<FolderDiff>` (`FolderDiff { remove, restore, staging: Vec<String>, scope: BTreeSet<String> }`), `restore(folder, snapshot) -> Result<()>`, `drop_batch(batch_dir, batch_id) -> Result<()>`, `sweep(root, live: &HashSet<String>) -> Result<()>`, `is_app_output(rel, folder_name, scope) -> bool`, `is_snapshot_path(path) -> bool`.

- [ ] **Step 1: Add test helpers** to `tests/common/mod.rs`:

```rust
/// Write `contents` to `path`, creating its folder.
pub fn write_file(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(path, contents).expect("write file");
}

/// Every file under `dir`, recursively, with its contents — `/`-joined
/// relative paths, sorted. The whole truth about a folder, nested items and
/// snapshot links included.
pub fn tree(dir: &Path) -> Vec<(String, String)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).expect("read dir") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                walk(base, &path, out);
            } else {
                let rel = path
                    .strip_prefix(base)
                    .expect("under base")
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, std::fs::read_to_string(&path).unwrap_or_default()));
            }
        }
    }
    let mut out = Vec::new();
    if dir.is_dir() {
        walk(dir, dir, &mut out);
    }
    out.sort();
    out
}
```

- [ ] **Step 2: Write the failing tests** — `src-tauri/tests/snapshot.rs`:

```rust
//! Pre-batch folder snapshots: take one, change the folder the ways a batch
//! (and an operator) can, restore, and check the folder is exactly as it was.

mod common;

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use common::*;
use nbcg_dc_lib::core::snapshot;

struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    folder: PathBuf,
    snap: PathBuf,
    before: Vec<(String, String)>,
}

/// `scanned/BOOK` holding `files`, snapshotted for batch `b1`.
fn fixture(files: &[(&str, &str)]) -> Fixture {
    let tmp = tempfile::TempDir::new().unwrap();
    let root = tmp.path().join("scanned");
    let folder = root.join("BOOK");
    for (name, contents) in files {
        write_file(&folder.join(name), contents);
    }
    let snap = snapshot::item_dir(&root, "b1", "i1");
    snapshot::take(&folder, &snap).unwrap();
    let before = tree(&folder);
    Fixture { _tmp: tmp, root, folder, snap, before }
}

/// The app's way of changing a file: a new file renamed over the old one.
fn replace(path: &Path, contents: &str) {
    let temp = path.with_extension("tmp-write");
    std::fs::write(&temp, contents).unwrap();
    std::fs::rename(&temp, path).unwrap();
}

#[test]
fn generated_outputs_are_removed() {
    let f = fixture(&[("1.jpg", "page one"), ("2.jpg", "page two")]);
    for name in ["BOOK.pdf", "BOOK_archive.pdf", "BOOK_thumb.png", "BOOK.txt", "metadata.json"] {
        write_file(&f.folder.join(name), "made by the batch");
    }

    snapshot::restore(&f.folder, &f.snap).unwrap();

    assert_eq!(tree(&f.folder), f.before);
}

#[test]
fn a_replaced_file_comes_back_with_its_old_contents() {
    let f = fixture(&[("1.jpg", "page one"), ("metadata.json", "before the batch")]);
    replace(&f.folder.join("metadata.json"), "written by the batch");

    snapshot::restore(&f.folder, &f.snap).unwrap();

    assert_eq!(tree(&f.folder), f.before);
}

#[test]
fn a_supplied_pdf_filed_into_source_goes_back() {
    let f = fixture(&[("scan.pdf", "the operator's pdf")]);
    std::fs::create_dir_all(f.folder.join("source")).unwrap();
    std::fs::rename(f.folder.join("scan.pdf"), f.folder.join("source/scan.pdf")).unwrap();
    write_file(&f.folder.join("BOOK.pdf"), "derived");

    snapshot::restore(&f.folder, &f.snap).unwrap();

    assert_eq!(tree(&f.folder), f.before);
    assert!(!f.folder.join("source").exists(), "an emptied source/ was left behind");
}

#[test]
fn a_file_deleted_by_hand_comes_back_and_one_added_by_hand_goes() {
    let f = fixture(&[("1.jpg", "page one"), ("2.jpg", "page two")]);
    std::fs::remove_file(f.folder.join("2.jpg")).unwrap();
    write_file(&f.folder.join("notes.docx"), "added by hand");

    snapshot::restore(&f.folder, &f.snap).unwrap();

    assert_eq!(tree(&f.folder), f.before);
}

#[test]
fn nested_item_folders_are_left_alone() {
    let f = fixture(&[("1.jpg", "page one"), ("Issue1/a.jpg", "nested item")]);
    write_file(&f.folder.join("Issue1/b.jpg"), "added to the nested item");

    snapshot::restore(&f.folder, &f.snap).unwrap();

    assert!(f.folder.join("Issue1/b.jpg").exists(), "restoring BOOK touched a nested item");
}

#[test]
fn staging_folders_are_removed() {
    let f = fixture(&[("1.jpg", "page one")]);
    write_file(&f.folder.join(".nbcg-tmp-1234/BOOK.pdf"), "half-finished run");

    snapshot::restore(&f.folder, &f.snap).unwrap();

    assert_eq!(tree(&f.folder), f.before);
}

#[test]
fn a_deleted_item_folder_is_recreated() {
    let f = fixture(&[("1.jpg", "page one"), ("2.jpg", "page two")]);
    std::fs::remove_dir_all(&f.folder).unwrap();

    snapshot::restore(&f.folder, &f.snap).unwrap();

    assert_eq!(tree(&f.folder), f.before);
}

#[test]
fn restore_is_idempotent() {
    let f = fixture(&[("1.jpg", "page one")]);
    write_file(&f.folder.join("BOOK.pdf"), "derived");

    snapshot::restore(&f.folder, &f.snap).unwrap();
    snapshot::restore(&f.folder, &f.snap).unwrap();

    assert_eq!(tree(&f.folder), f.before);
}

#[test]
fn diff_names_what_restore_will_do_and_changes_nothing() {
    let f = fixture(&[("1.jpg", "page one"), ("2.jpg", "page two")]);
    write_file(&f.folder.join("BOOK.pdf"), "derived");
    std::fs::remove_file(f.folder.join("2.jpg")).unwrap();
    write_file(&f.folder.join(".nbcg-tmp-9/x"), "scratch");
    let changed = tree(&f.folder);

    let diff = snapshot::diff(&f.folder, &f.snap).unwrap();

    assert_eq!(diff.remove, vec!["BOOK.pdf".to_string()]);
    assert_eq!(diff.restore, vec!["2.jpg".to_string()]);
    assert_eq!(diff.staging, vec![".nbcg-tmp-9".to_string()]);
    assert_eq!(tree(&f.folder), changed, "a dry run changed the folder");
}

#[test]
fn restoring_from_a_missing_snapshot_fails_and_touches_nothing() {
    let f = fixture(&[("1.jpg", "page one")]);
    write_file(&f.folder.join("BOOK.pdf"), "derived");
    let changed = tree(&f.folder);
    std::fs::remove_dir_all(&f.snap).unwrap();

    assert!(snapshot::restore(&f.folder, &f.snap).is_err());
    assert_eq!(tree(&f.folder), changed);
}

#[test]
fn take_refuses_to_overwrite_a_snapshot_or_to_snapshot_a_missing_folder() {
    let f = fixture(&[("1.jpg", "page one")]);
    assert!(snapshot::take(&f.folder, &f.snap).is_err());

    let nowhere = f.root.join("GONE");
    let dest = snapshot::item_dir(&f.root, "b2", "i9");
    assert!(snapshot::take(&nowhere, &dest).is_err());
    assert!(!dest.exists(), "a failed take left a folder behind");
}

#[test]
fn root_of_takes_the_relative_path_off_the_folder() {
    let folder = Path::new("/archive/scanned/Wrapper/BOOK");
    assert_eq!(
        snapshot::root_of(folder, "Wrapper/BOOK"),
        Some(PathBuf::from("/archive/scanned"))
    );
    assert_eq!(snapshot::root_of(folder, ""), None);
}

#[test]
fn drop_batch_removes_the_batch_and_the_emptied_snapshots_folder() {
    let f = fixture(&[("1.jpg", "page one")]);
    let batch = snapshot::batch_dir(&f.root, "b1");

    snapshot::drop_batch(&batch, "b1").unwrap();

    assert!(!f.root.join(snapshot::SNAPSHOTS_DIR).exists());
    assert_eq!(tree(&f.folder), f.before, "dropping a snapshot touched the item");
}

#[test]
fn drop_batch_refuses_anything_that_is_not_a_snapshot_folder() {
    let f = fixture(&[("1.jpg", "page one")]);

    assert!(snapshot::drop_batch(&f.folder, "BOOK").is_err());
    assert!(snapshot::drop_batch(&snapshot::batch_dir(&f.root, "b1"), "other").is_err());
    assert_eq!(tree(&f.folder), f.before);
}

#[test]
fn sweep_removes_only_batches_that_are_not_live() {
    let f = fixture(&[("1.jpg", "page one")]);
    let other = snapshot::item_dir(&f.root, "b2", "i1");
    snapshot::take(&f.folder, &other).unwrap();

    snapshot::sweep(&f.root, &HashSet::from(["b1".to_string()])).unwrap();

    assert!(snapshot::batch_dir(&f.root, "b1").exists());
    assert!(!snapshot::batch_dir(&f.root, "b2").exists());
}

#[test]
fn app_outputs_are_told_apart_from_hand_added_files() {
    let scope: BTreeSet<String> = ["foo.pdf".to_string()].into();
    for name in [
        "BOOK.pdf",
        "BOOK_archive.pdf",
        "BOOK_thumb.png",
        "BOOK.txt",
        "BOOK_3.pdf",
        "BOOK_12.txt",
        "metadata.json",
        "metadata.json.tmp",
        "source/scan.pdf",
        "foo.txt",
    ] {
        assert!(snapshot::is_app_output(name, "BOOK", &scope), "{name}");
    }
    for name in ["notes.docx", "BOOK_x.pdf", "cover.jpg", "bar.txt"] {
        assert!(!snapshot::is_app_output(name, "BOOK", &scope), "{name}");
    }
}

#[test]
fn snapshot_paths_are_recognised() {
    assert!(snapshot::is_snapshot_path(Path::new(
        "/archive/scanned/.nbcg-snapshots/b1/i1/1.jpg"
    )));
    assert!(!snapshot::is_snapshot_path(Path::new("/archive/scanned/BOOK/1.jpg")));
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `cargo test --test snapshot`
Expected: compile error — `core::snapshot` doesn't exist.

- [ ] **Step 4: Implement** — `src-tauri/src/core/snapshot.rs`:

```rust
//! Pre-batch snapshots of item folders — what makes a batch deletable
//! (docs/superpowers/specs/2026-09-29-delete-batch-design.md).
//!
//! When a batch is created, each member's **item scope** is hard-linked into
//! `<scan root>/.nbcg-snapshots/<batch id>/<item id>/`; deleting the batch
//! makes the folder match that snapshot again. Hard links cost no space and
//! no time, and every write this app makes replaces a file by renaming a new
//! one over it (`core::fs::write_metadata`, `finalize_staged_output`), which
//! leaves the snapshot's link on the old bytes. Where a volume can't hard-link
//! (FAT/exFAT, some network shares) the file is copied instead.
//!
//! Known limit: a program that edits a file *in place* changes the snapshot's
//! copy too, since both names are one file. The app never does; most editors
//! write a new file and rename it.
//!
//! Item scope = the folder's direct files plus the files directly in its
//! `source/` subfolder (where the supplied-pdf stage files the operator's
//! PDF). Other subfolders are separate items (nested records) and are never
//! touched; `.nbcg-tmp-*` staging folders are the job runner's scratch space —
//! never snapshotted, always removed on restore.
//!
//! Pure file operations on paths — no database, no config. A path inside a
//! scope is a `/`-joined relative string (`"a.pdf"`, `"source/a.pdf"`).

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

use crate::core::fs::{METADATA_FILENAME, SOURCE_SUBFOLDER};
use crate::error::{AppError, Result};

/// The folder under each scan root holding every live snapshot. A dot folder,
/// so the scanner never lists it as an item.
pub const SNAPSHOTS_DIR: &str = ".nbcg-snapshots";

/// Prefix of the job runner's per-run staging folders
/// (`core::jobs::stages::staging_dir`).
const STAGING_PREFIX: &str = ".nbcg-tmp-";

/// Suffix of the temp name a restored file is linked to before being renamed
/// into place.
const RESTORE_SUFFIX: &str = ".nbcg-restore";

/// `<root>/.nbcg-snapshots/<batch_id>` — every snapshot one batch took under one root.
pub fn batch_dir(root: &Path, batch_id: &str) -> PathBuf {
    root.join(SNAPSHOTS_DIR).join(batch_id)
}

/// `<root>/.nbcg-snapshots/<batch_id>/<item_id>` — one item's snapshot. Keyed
/// by id rather than relative path so a nested item's snapshot never sits
/// inside its parent's.
pub fn item_dir(root: &Path, batch_id: &str, item_id: &str) -> PathBuf {
    batch_dir(root, batch_id).join(item_id)
}

/// The scan root an item folder sits under: `folder` with its `relative_path`
/// (`/`-joined, as the index stores it) taken off the end. Derived from the
/// item rather than from config, so a root changed in Settings mid-batch
/// can't send a snapshot somewhere else.
pub fn root_of(folder: &Path, relative_path: &str) -> Option<PathBuf> {
    let depth = relative_path.split('/').filter(|s| !s.is_empty()).count();
    if depth == 0 {
        return None;
    }
    let mut root = folder.to_path_buf();
    for _ in 0..depth {
        if !root.pop() {
            return None;
        }
    }
    Some(root)
}

/// Whether a path lies inside a snapshot folder — the watcher ignores those,
/// or taking a snapshot would trigger a rescan.
pub fn is_snapshot_path(path: &Path) -> bool {
    path.components()
        .any(|c| matches!(c, Component::Normal(name) if name == OsStr::new(SNAPSHOTS_DIR)))
}

fn source_prefix() -> String {
    format!("{SOURCE_SUBFOLDER}/")
}

fn to_fs_path(base: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(base.to_path_buf(), |path, part| path.join(part))
}

/// Every file in `folder`'s item scope, keyed by its `/`-joined path in the
/// scope. A missing folder has an empty scope.
fn scope_files(folder: &Path) -> Result<BTreeMap<String, PathBuf>> {
    let mut out = BTreeMap::new();
    for (prefix, dir) in [
        (String::new(), folder.to_path_buf()),
        (source_prefix(), folder.join(SOURCE_SUBFOLDER)),
    ] {
        if !dir.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            out.insert(format!("{prefix}{name}"), entry.path());
        }
    }
    Ok(out)
}

/// The `.nbcg-tmp-*` folders directly in `folder`.
fn staging_dirs(folder: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    if !folder.is_dir() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(folder)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_dir() && name.starts_with(STAGING_PREFIX) {
            out.push(name);
        }
    }
    out.sort();
    Ok(out)
}

/// Hard-link `src` at `dst`, or copy it where the volume can't hard-link.
fn link_or_copy(src: &Path, dst: &Path) -> Result<()> {
    if std::fs::hard_link(src, dst).is_ok() {
        return Ok(());
    }
    std::fs::copy(src, dst)?;
    Ok(())
}

/// Snapshot `folder`'s item scope into `dest`, which must not exist yet. On
/// failure nothing is left at `dest`.
pub fn take(folder: &Path, dest: &Path) -> Result<()> {
    take_with(folder, dest, link_or_copy)
}

fn take_with(folder: &Path, dest: &Path, link: fn(&Path, &Path) -> Result<()>) -> Result<()> {
    if !folder.is_dir() {
        return Err(AppError::Invalid(format!(
            "{} is not a folder any more - rescan and try again",
            folder.display()
        )));
    }
    if dest.exists() {
        return Err(AppError::Invalid(format!(
            "a snapshot already exists at {}",
            dest.display()
        )));
    }
    let result = (|| -> Result<()> {
        std::fs::create_dir_all(dest)?;
        for (rel, src) in scope_files(folder)? {
            let target = to_fs_path(dest, &rel);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            link(&src, &target)?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(dest);
    }
    result
}

/// What restoring a folder from its snapshot would change.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FolderDiff {
    /// In the scope now but not in the snapshot — removed on restore.
    pub remove: Vec<String>,
    /// In the snapshot but missing now, or different — put back on restore.
    pub restore: Vec<String>,
    /// `.nbcg-tmp-*` staging folders in the item folder — removed on restore.
    pub staging: Vec<String>,
    /// Every path in either the folder's scope or the snapshot.
    pub scope: BTreeSet<String>,
}

/// Compare `folder` with `snapshot`. Read-only.
pub fn diff(folder: &Path, snapshot: &Path) -> Result<FolderDiff> {
    if !snapshot.is_dir() {
        return Err(AppError::Invalid(format!(
            "its snapshot at {} is missing",
            snapshot.display()
        )));
    }
    let current = scope_files(folder)?;
    let before = scope_files(snapshot)?;

    let remove = current
        .keys()
        .filter(|rel| !before.contains_key(*rel))
        .cloned()
        .collect();
    let mut restore = Vec::new();
    for (rel, snap) in &before {
        match current.get(rel) {
            Some(now) if same_file(now, snap)? => {}
            _ => restore.push(rel.clone()),
        }
    }
    let scope = current.keys().chain(before.keys()).cloned().collect();
    Ok(FolderDiff {
        remove,
        restore,
        staging: staging_dirs(folder)?,
        scope,
    })
}

/// Whether two paths hold the same file, judged by size and modified time —
/// a hard link shares both; the app's rename-over writes change the time.
/// `std::fs::metadata`, not `DirEntry::metadata`: on Windows the latter reads
/// the directory entry's cached copy, which goes stale for a hard-linked file
/// changed through its other name.
fn same_file(a: &Path, b: &Path) -> Result<bool> {
    let (a, b) = (std::fs::metadata(a)?, std::fs::metadata(b)?);
    Ok(a.len() == b.len() && a.modified()? == b.modified()?)
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// Make `folder`'s item scope match `snapshot` exactly. Idempotent: running it
/// again after a partial failure finishes the job.
pub fn restore(folder: &Path, snapshot: &Path) -> Result<()> {
    let plan = diff(folder, snapshot)?;
    std::fs::create_dir_all(folder)?;
    for rel in &plan.remove {
        std::fs::remove_file(to_fs_path(folder, rel))?;
    }
    for name in &plan.staging {
        std::fs::remove_dir_all(folder.join(name))?;
    }
    for rel in &plan.restore {
        let target = to_fs_path(folder, rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp = with_suffix(&target, RESTORE_SUFFIX);
        let _ = std::fs::remove_file(&temp);
        link_or_copy(&to_fs_path(snapshot, rel), &temp)?;
        // Replaces an existing target on Windows too (MoveFileEx with
        // MOVEFILE_REPLACE_EXISTING).
        if let Err(e) = std::fs::rename(&temp, &target) {
            let _ = std::fs::remove_file(&temp);
            return Err(e.into());
        }
    }
    // A `source/` the snapshot doesn't have was made by the batch; drop it
    // once emptied (remove_dir fails, harmlessly, while anything is left).
    if !snapshot.join(SOURCE_SUBFOLDER).is_dir() {
        let _ = std::fs::remove_dir(folder.join(SOURCE_SUBFOLDER));
    }
    Ok(())
}

/// Remove one batch's snapshot folder under one root, then `.nbcg-snapshots`
/// itself once nothing else is in it. Missing is fine.
///
/// Refuses any path that isn't `<…>/.nbcg-snapshots/<batch_id>`: this is a
/// recursive delete, and the path comes from a database row.
pub fn drop_batch(batch_dir: &Path, batch_id: &str) -> Result<()> {
    let parent = batch_dir.parent();
    let is_snapshot_folder = batch_dir.file_name() == Some(OsStr::new(batch_id))
        && parent.and_then(Path::file_name) == Some(OsStr::new(SNAPSHOTS_DIR));
    if !is_snapshot_folder {
        return Err(AppError::Invalid(format!(
            "{} is not a snapshot folder of batch {batch_id}",
            batch_dir.display()
        )));
    }
    match std::fs::remove_dir_all(batch_dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    if let Some(parent) = parent {
        let _ = std::fs::remove_dir(parent); // only succeeds when empty
    }
    Ok(())
}

/// Remove every batch folder under `<root>/.nbcg-snapshots` whose batch id is
/// not in `live` — left behind by a crash between a database commit and the
/// folder cleanup after it.
pub fn sweep(root: &Path, live: &HashSet<String>) -> Result<()> {
    let dir = root.join(SNAPSHOTS_DIR);
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_dir() && !live.contains(&name) {
            std::fs::remove_dir_all(entry.path())?;
        }
    }
    let _ = std::fs::remove_dir(&dir); // only succeeds when empty
    Ok(())
}

/// Whether `rel` is a file this app writes into an item folder, by the
/// folder-derived naming convention (docs/01 §Naming). Only used to flag, in
/// the delete confirmation, the files that are **not** — an operator's own
/// file is never removed without being named as such. `scope` is every path
/// in the folder or its snapshot (for OCR text beside a PDF).
pub fn is_app_output(rel: &str, folder_name: &str, scope: &BTreeSet<String>) -> bool {
    if rel.starts_with(&source_prefix()) || rel.ends_with(RESTORE_SUFFIX) {
        return true;
    }
    let fixed = [
        format!("{folder_name}.pdf"),
        format!("{folder_name}_archive.pdf"),
        format!("{folder_name}_thumb.png"),
        format!("{folder_name}.txt"),
        METADATA_FILENAME.to_string(),
        format!("{METADATA_FILENAME}.tmp"),
    ];
    if fixed.iter().any(|name| name == rel) {
        return true;
    }
    let Some((stem, ext)) = rel.rsplit_once('.') else {
        return false;
    };
    // Page-numbered outputs: `<name>_<n>.pdf`, `<name>_<n>.txt`.
    if let Some(n) = stem.strip_prefix(&format!("{folder_name}_")) {
        if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && (ext == "pdf" || ext == "txt") {
            return true;
        }
    }
    // OCR text for one of several PDFs: `<base>.txt` beside `<base>.pdf`.
    ext == "txt" && scope.contains(&format!("{stem}.pdf"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copy_only(src: &Path, dst: &Path) -> Result<()> {
        std::fs::copy(src, dst)?;
        Ok(())
    }

    /// The copy fallback (a volume that can't hard-link) restores the same
    /// folder a hard-linked snapshot does.
    #[test]
    fn a_copied_snapshot_restores_like_a_linked_one() {
        let tmp = tempfile::TempDir::new().unwrap();
        let folder = tmp.path().join("scanned/BOOK");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("1.jpg"), "page one").unwrap();
        std::fs::write(folder.join("metadata.json"), "before").unwrap();
        let snap = item_dir(&tmp.path().join("scanned"), "b1", "i1");
        take_with(&folder, &snap, copy_only).unwrap();

        std::fs::write(folder.join("metadata.json.new"), "after").unwrap();
        std::fs::rename(folder.join("metadata.json.new"), folder.join("metadata.json")).unwrap();
        std::fs::write(folder.join("BOOK.pdf"), "derived").unwrap();
        restore(&folder, &snap).unwrap();

        assert_eq!(std::fs::read_to_string(folder.join("metadata.json")).unwrap(), "before");
        assert!(!folder.join("BOOK.pdf").exists());
    }
}
```

Add `pub mod snapshot;` to `src-tauri/src/core/mod.rs`.

- [ ] **Step 5: Run to verify they pass**

Run: `cargo test --test snapshot` and `cargo test --lib core::snapshot`
Expected: all pass.

---

### Task 3: Snapshot rows (`core::db::snapshots`) and membership upkeep

**Files:**
- Create: `src-tauri/src/core/db/snapshots.rs`
- Modify: `src-tauri/src/core/db/mod.rs` (`pub mod snapshots;`)
- Modify: `src-tauri/src/core/db/batches.rs` (`update`)
- Test: `src-tauri/tests/db_snapshots.rs`

**Interfaces:**
- Consumes: Task 1's `batch_snapshots` table.
- Produces: `IndexState { item_row: Map<String, Json>, item: IndexedItemDto }`, `SnapshotRow { batch_id, item_id, snapshot_dir, item_row, item }`, `read_state(conn, item_id) -> Result<IndexState>`, `insert(conn, batch_id, &IndexState, snapshot_dir) -> Result<()>`, `list(conn, batch_id) -> Result<Vec<SnapshotRow>>`, `exists(conn, batch_id, item_id) -> Result<bool>`, `has_any(conn, batch_id) -> Result<bool>`, `delete_one(conn, batch_id, item_id) -> Result<()>`, `live_batch_ids(conn) -> Result<HashSet<String>>`, `restore_index(conn, &SnapshotRow) -> Result<()>`.

- [ ] **Step 1: Write the failing tests** — `src-tauri/tests/db_snapshots.rs`:

```rust
//! `batch_snapshots`: an item's index state from before its batch, and
//! putting it back.

mod common;

use common::*;
use nbcg_dc_lib::core::db::items::ReuploadKind;
use nbcg_dc_lib::core::db::{batches, items, snapshots, Db};
use nbcg_dc_lib::core::fs::item_id_for;
use nbcg_dc_lib::dto::*;
use nbcg_dc_lib::error::AppError;

/// A batch over `ids` whose members were snapshotted first, as
/// `core::batch_lifecycle::create` does it.
fn snapshotted_batch(db: &Db, ids: &[&str]) -> BatchDto {
    db.transaction(|t| {
        let states = ids
            .iter()
            .map(|id| snapshots::read_state(t, id))
            .collect::<nbcg_dc_lib::error::Result<Vec<_>>>()?;
        let batch = batches::create(t, &batch_over(ids))?;
        for state in &states {
            snapshots::insert(t, &batch.id, state, &format!("/snap/{}", state.item.id))?;
        }
        Ok(batch)
    })
    .unwrap()
}

fn db_with(folders: Vec<nbcg_dc_lib::core::fs::DiscoveredFolder>) -> Db {
    let db = Db::open_in_memory().unwrap();
    db.with(|c| items::reconcile(c, &folders)).unwrap();
    db
}

#[test]
fn read_state_keeps_columns_the_dto_does_not_carry() {
    let db = db_with(vec![connected_folder("A", "rec-1")]);
    let state = db
        .with(|c| snapshots::read_state(c, &item_id_for("A")))
        .unwrap();

    assert_eq!(state.item_row["version"], serde_json::json!(3));
    assert_eq!(state.item_row["target_state"], serde_json::json!("RECORD"));
    assert_eq!(state.item_row["hidden_at"], serde_json::Value::Null);
    assert_eq!(state.item.backend_id.as_deref(), Some("rec-1"));
}

#[test]
fn restore_index_puts_back_everything_the_batch_changed() {
    let mut folder = connected_folder("A", "rec-1");
    folder.assets = vec![asset("1.jpg", 10)];
    let db = db_with(vec![folder.clone()]);
    let a = item_id_for("A");
    db.with(|c| items::set_stage(c, &a, StageName::Pdf, StageStatus::Done, None))
        .unwrap();
    let before = db.with(|c| items::get(c, &a)).unwrap();
    let batch = snapshotted_batch(&db, &[&a]);

    db.with(|c| {
        items::set_stage(c, &a, StageName::Ocr, StageStatus::Failed, Some("boom"))?;
        items::mark_needs_reupload(c, &a, ReuploadKind::TextOnly)?;
        items::record_upload(
            c,
            &a,
            &UploadRecordDto {
                backend_id: "rec-2".into(),
                version: Some(9),
                target_state: ItemType::Draft,
                visibility_status: VisibilityStatus::Hidden,
            },
        )?;
        Ok(())
    })
    .unwrap();
    folder.assets.push(asset("A.pdf", 99));
    db.with(|c| items::reconcile(c, &[folder])).unwrap();

    let row = db.with(|c| snapshots::list(c, &batch.id)).unwrap().remove(0);
    db.transaction(|t| snapshots::restore_index(t, &row)).unwrap();

    assert_eq!(db.with(|c| items::get(c, &a)).unwrap(), before);
    let (version, target): (i64, String) = db
        .with(|c| {
            Ok(c.query_row(
                "SELECT version, target_state FROM items WHERE id = ?1",
                [&a],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!((version, target.as_str()), (3, "RECORD"));
}

#[test]
fn restore_index_brings_back_a_row_a_rescan_dropped() {
    let db = db_with(vec![folder("A", ScanRoot::Unprocessed)]);
    let a = item_id_for("A");
    let before = db.with(|c| items::get(c, &a)).unwrap();
    let batch = snapshotted_batch(&db, &[&a]);
    db.with(|c| items::reconcile(c, &[])).unwrap(); // the folder vanished

    let row = db.with(|c| snapshots::list(c, &batch.id)).unwrap().remove(0);
    db.transaction(|t| snapshots::restore_index(t, &row)).unwrap();

    assert_eq!(db.with(|c| items::get(c, &a)).unwrap(), before);
}

#[test]
fn update_refuses_a_new_member_that_has_no_snapshot() {
    let db = db_with(vec![folder("A", ScanRoot::Unprocessed), folder("B", ScanRoot::Unprocessed)]);
    let (a, b) = (item_id_for("A"), item_id_for("B"));
    let mut batch = snapshotted_batch(&db, &[&a]);

    batch.item_ids.push(b.clone());
    let refused = db.transaction(|t| batches::update(t, &batch));

    assert!(matches!(refused, Err(AppError::Invalid(_))));
    assert_eq!(db.with(|c| items::get(c, &b)).unwrap().batch_id, None);
}

#[test]
fn update_drops_the_snapshot_of_a_member_it_removes() {
    let db = db_with(vec![folder("A", ScanRoot::Unprocessed), folder("B", ScanRoot::Unprocessed)]);
    let (a, b) = (item_id_for("A"), item_id_for("B"));
    let mut batch = snapshotted_batch(&db, &[&a, &b]);

    batch.item_ids = vec![a.clone()];
    db.transaction(|t| batches::update(t, &batch)).unwrap();

    let rows = db.with(|c| snapshots::list(c, &batch.id)).unwrap();
    assert_eq!(rows.iter().map(|r| r.item_id.as_str()).collect::<Vec<_>>(), vec![a.as_str()]);
}

#[test]
fn archive_and_delete_drop_the_snapshot_rows() {
    let db = db_with(vec![folder("A", ScanRoot::Unprocessed), folder("B", ScanRoot::Unprocessed)]);
    let (a, b) = (item_id_for("A"), item_id_for("B"));
    let first = snapshotted_batch(&db, &[&a]);
    let second = snapshotted_batch(&db, &[&b]);
    assert_eq!(db.with(snapshots::live_batch_ids).unwrap().len(), 2);

    db.transaction(|t| batches::archive(t, &first.id)).unwrap();
    db.transaction(|t| batches::delete(t, &second.id)).unwrap();

    assert!(db.with(snapshots::live_batch_ids).unwrap().is_empty());
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --test db_snapshots`
Expected: compile error — `core::db::snapshots` doesn't exist.

- [ ] **Step 3: Implement** — `src-tauri/src/core/db/snapshots.rs`:

```rust
//! `batch_snapshots` — each batch member's index state from just before the
//! batch claimed it. The file side is `core::snapshot`; the two are tied
//! together by `core::batch_lifecycle`.
//!
//! Two copies of the same moment, for two jobs:
//! - `item_row`: the raw `items` row as a column → value map, so a delete puts
//!   back **every** column — including the ones `IndexedItemDto` doesn't carry
//!   (`version`, `target_state`, `hidden_at`, …);
//! - `item_dto`: the `IndexedItemDto`, stages and assets included — what the
//!   delete confirmation shows as "returns to", and where a delete takes the
//!   stages and assets from.

use std::collections::HashSet;

use rusqlite::types::{Value, ValueRef};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde_json::{Map, Value as Json};

use crate::dto::IndexedItemDto;
use crate::error::{AppError, Result};

use super::{items, now_iso};

/// An item's index state, read before a batch claims it.
#[derive(Debug, Clone)]
pub struct IndexState {
    pub item_row: Map<String, Json>,
    pub item: IndexedItemDto,
}

/// One batch member's snapshot row.
#[derive(Debug, Clone)]
pub struct SnapshotRow {
    pub batch_id: String,
    pub item_id: String,
    /// Where `core::snapshot::take` put the item's files.
    pub snapshot_dir: String,
    pub item_row: Map<String, Json>,
    pub item: IndexedItemDto,
}

fn to_json(value: ValueRef) -> Json {
    match value {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) => Json::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Json::Null, Json::Number),
        ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).into_owned()),
        // `items` has no BLOB columns.
        ValueRef::Blob(_) => Json::Null,
    }
}

fn to_sql(value: &Json) -> Value {
    match value {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Integer(i64::from(*b)),
        Json::Number(n) => n
            .as_i64()
            .map(Value::Integer)
            .unwrap_or_else(|| Value::Real(n.as_f64().unwrap_or_default())),
        Json::String(s) => Value::Text(s.clone()),
        other => Value::Text(other.to_string()),
    }
}

/// Read `item_id`'s index state as it is right now.
pub fn read_state(conn: &Connection, item_id: &str) -> Result<IndexState> {
    let mut stmt = conn.prepare("SELECT * FROM items WHERE id = ?1")?;
    let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
    let item_row = stmt
        .query_row(params![item_id], |row| {
            let mut map = Map::new();
            for (i, name) in names.iter().enumerate() {
                map.insert(name.clone(), to_json(row.get_ref(i)?));
            }
            Ok(map)
        })
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("item {item_id}")))?;
    Ok(IndexState {
        item_row,
        item: items::get(conn, item_id)?,
    })
}

/// Record `state` as `batch_id`'s snapshot of its item.
pub fn insert(conn: &Connection, batch_id: &str, state: &IndexState, snapshot_dir: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO batch_snapshots \
           (batch_id, item_id, snapshot_dir, item_row, item_dto, taken_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            batch_id,
            state.item.id,
            snapshot_dir,
            serde_json::to_string(&state.item_row)?,
            serde_json::to_string(&state.item)?,
            now_iso(),
        ],
    )?;
    Ok(())
}

/// Every snapshot row of `batch_id`.
pub fn list(conn: &Connection, batch_id: &str) -> Result<Vec<SnapshotRow>> {
    let mut stmt = conn.prepare(
        "SELECT item_id, snapshot_dir, item_row, item_dto FROM batch_snapshots \
         WHERE batch_id = ?1 ORDER BY item_id",
    )?;
    let rows = stmt.query_map(params![batch_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (item_id, snapshot_dir, item_row, item_dto) = row?;
        out.push(SnapshotRow {
            batch_id: batch_id.to_string(),
            item_id,
            snapshot_dir,
            item_row: serde_json::from_str(&item_row)?,
            item: serde_json::from_str(&item_dto)?,
        });
    }
    Ok(out)
}

pub fn exists(conn: &Connection, batch_id: &str, item_id: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM batch_snapshots WHERE batch_id = ?1 AND item_id = ?2",
        params![batch_id, item_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Whether `batch_id` took snapshots at all — false for a batch made before
/// they existed, whose delete can only release its items.
pub fn has_any(conn: &Connection, batch_id: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM batch_snapshots WHERE batch_id = ?1",
        params![batch_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

pub fn delete_one(conn: &Connection, batch_id: &str, item_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM batch_snapshots WHERE batch_id = ?1 AND item_id = ?2",
        params![batch_id, item_id],
    )?;
    Ok(())
}

/// Ids of the batches that hold snapshots — the ones whose snapshot folders
/// a sweep must keep.
pub fn live_batch_ids(conn: &Connection) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT DISTINCT batch_id FROM batch_snapshots")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn item_columns(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("PRAGMA table_info(items)")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// Put `row`'s item back in the index as it was before its batch: every
/// column of its `items` row, its stages and its assets. Re-inserts the row if
/// a rescan dropped it while its folder was gone.
///
/// The batch's claim is dropped here, and only if the item is still claimed
/// by *this* batch — so `batches::delete`'s release afterwards finds nothing
/// to do and `updated_at` stays the snapshot's. A column added after the
/// snapshot was taken keeps its current value.
pub fn restore_index(conn: &Connection, row: &SnapshotRow) -> Result<()> {
    let values: Vec<(String, Value)> = item_columns(conn)?
        .into_iter()
        .filter(|c| c != "id" && c != "batch_id")
        .filter_map(|c| row.item_row.get(&c).map(|v| (c.clone(), to_sql(v))))
        .collect();
    let item_id = Value::Text(row.item_id.clone());

    if items::exists(conn, &row.item_id)? {
        let set = values
            .iter()
            .enumerate()
            .map(|(i, (c, _))| format!("\"{c}\" = ?{}", i + 3))
            .chain(std::iter::once(
                "\"batch_id\" = CASE WHEN \"batch_id\" = ?2 THEN NULL ELSE \"batch_id\" END"
                    .to_string(),
            ))
            .collect::<Vec<_>>()
            .join(", ");
        let bound = [item_id, Value::Text(row.batch_id.clone())]
            .into_iter()
            .chain(values.iter().map(|(_, v)| v.clone()));
        conn.execute(&format!("UPDATE items SET {set} WHERE id = ?1"), params_from_iter(bound))?;
    } else {
        let columns = std::iter::once("\"id\"".to_string())
            .chain(values.iter().map(|(c, _)| format!("\"{c}\"")))
            .collect::<Vec<_>>();
        let placeholders = (1..=columns.len()).map(|i| format!("?{i}")).collect::<Vec<_>>();
        let bound = std::iter::once(item_id).chain(values.iter().map(|(_, v)| v.clone()));
        conn.execute(
            &format!(
                "INSERT INTO items ({}) VALUES ({})",
                columns.join(", "),
                placeholders.join(", ")
            ),
            params_from_iter(bound),
        )?;
    }

    conn.execute("DELETE FROM item_stages WHERE item_id = ?1", params![row.item_id])?;
    for (stage, s) in &row.item.stages {
        conn.execute(
            "INSERT INTO item_stages (item_id, stage, status, error, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![row.item_id, stage.as_str(), s.status.as_str(), s.error, s.updated_at],
        )?;
    }
    conn.execute("DELETE FROM item_assets WHERE item_id = ?1", params![row.item_id])?;
    for a in &row.item.assets {
        conn.execute(
            "INSERT INTO item_assets (item_id, filename, path, size_bytes) VALUES (?1, ?2, ?3, ?4)",
            params![row.item_id, a.filename, a.path, a.size_bytes],
        )?;
    }
    Ok(())
}
```

In `db/mod.rs`: `pub mod snapshots;`.

In `db/batches.rs` `update`, before the UPDATE statement (after the `exists` check):

```rust
    // A member added after creation has no pre-batch snapshot, so a delete
    // couldn't put it back. Refused for any batch that took snapshots; a
    // batch made before snapshots existed can only be released anyway.
    let added: Vec<&String> = batch
        .item_ids
        .iter()
        .filter(|id| !previous.contains(*id))
        .collect();
    if !added.is_empty() && snapshots::has_any(conn, &batch.id)? {
        for id in added {
            if !snapshots::exists(conn, &batch.id, id)? {
                return Err(AppError::Invalid(format!(
                    "item {id} can't join a batch after it was created - deleting the \
                     batch couldn't put it back. Start a new batch for it instead."
                )));
            }
        }
    }
```

and in the removal loop:

```rust
    for gone in previous.iter().filter(|id| !batch.item_ids.contains(id)) {
        release_item(conn, &batch.id, gone)?;
        snapshots::delete_one(conn, &batch.id, gone)?;
    }
```

(`use super::{now_iso, snapshots};` at the top.)

- [ ] **Step 4: Run to verify they pass**

Run: `cargo test --test db_snapshots` and `cargo test --test db_batches`
Expected: all pass.

---

### Task 4: Lifecycle — create / preview / delete / archive / sweep

**Files:**
- Create: `src-tauri/src/core/batch_lifecycle.rs`
- Modify: `src-tauri/src/core/mod.rs` (`pub mod batch_lifecycle;`)
- Modify: `src-tauri/src/dto.rs` (delete-plan DTOs)
- Modify: `src-tauri/src/core/jobs/lock.rs`, `src-tauri/src/core/jobs/mod.rs` (`running_batch`)
- Test: `src-tauri/tests/batch_lifecycle.rs`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `RUNNING_REASON`, `ARCHIVED_REASON`, `BACKEND_REASON`, `delete_blocked_reason(&BatchDto, running: bool) -> Option<&'static str>`, `create(&Db, &BatchCreateDto) -> Result<BatchDto>`, `preview(&Db, batch_id, running) -> Result<BatchDeletePlanDto>`, `delete(&Db, batch_id, running) -> Result<()>`, `archive(&Db, batch_id) -> Result<BatchDto>`, `sweep(&Db, roots: &[PathBuf]) -> Result<()>`; `jobs::running_batch(&Mutex<JobRunLock>) -> Option<String>`; DTOs `BatchDeleteFileDto { path, generated }`, `BatchDeleteItemDto { item_id, folder_name, before: Option<IndexedItemDto>, remove, restore, error: Option<String> }`, `BatchDeletePlanDto { batch_id, has_snapshot, blocked_reason: Option<String>, items }`.

- [ ] **Step 1: Write the failing tests** — `src-tauri/tests/batch_lifecycle.rs`:

```rust
//! Batch create / delete / archive across folders and index together — the
//! undo promise: after a delete, every member is as it was before the batch.

mod common;

use std::path::PathBuf;

use common::*;
use nbcg_dc_lib::core::batch_lifecycle as lifecycle;
use nbcg_dc_lib::core::db::{batches, items, snapshots, Db};
use nbcg_dc_lib::core::fs::{item_id_for, scan_root};
use nbcg_dc_lib::core::snapshot;
use nbcg_dc_lib::dto::*;
use nbcg_dc_lib::error::AppError;

struct Archive {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    db: Db,
}

impl Archive {
    fn new(folders: &[(&str, &[(&str, &str)])]) -> Self {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("scanned");
        for (name, files) in folders {
            make_item_dir(&root, name, files);
        }
        let db = Db::open_in_memory().unwrap();
        let found = scan_root(&root, ScanRoot::Unprocessed).unwrap();
        db.with(|c| items::reconcile(c, &found)).unwrap();
        Archive { _tmp: tmp, root, db }
    }

    fn folder(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
}

const PAGES: &[(&str, &str)] = &[("1.jpg", "page one"), ("2.jpg", "page two")];

#[test]
fn create_snapshots_every_member() {
    let archive = Archive::new(&[("BOOK", PAGES)]);
    let id = item_id_for("BOOK");

    let batch = lifecycle::create(&archive.db, &batch_over(&[&id])).unwrap();

    let snap = snapshot::item_dir(&archive.root, &batch.id, &id);
    assert_eq!(tree(&snap), tree(&archive.folder("BOOK")));
    let rows = archive.db.with(|c| snapshots::list(c, &batch.id)).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].item.batch_id, None, "the snapshot was taken after the claim");
    assert_eq!(batch.no, 1);
}

#[test]
fn delete_puts_folders_and_index_back_and_removes_the_batch() {
    let archive = Archive::new(&[("BOOK", PAGES)]);
    let id = item_id_for("BOOK");
    let folder_before = tree(&archive.folder("BOOK"));
    let item_before = archive.db.with(|c| items::get(c, &id)).unwrap();
    let batch = lifecycle::create(&archive.db, &batch_over(&[&id])).unwrap();

    // What a processing run does.
    for name in ["BOOK.pdf", "BOOK_thumb.png", "metadata.json"] {
        write_file(&archive.folder("BOOK").join(name), "made by the batch");
    }
    archive
        .db
        .with(|c| items::set_stage(c, &id, StageName::Pdf, StageStatus::Done, None))
        .unwrap();

    lifecycle::delete(&archive.db, &batch.id, false).unwrap();

    assert_eq!(tree(&archive.folder("BOOK")), folder_before);
    assert_eq!(archive.db.with(|c| items::get(c, &id)).unwrap(), item_before);
    assert!(archive.db.with(batches::list).unwrap().is_empty());
    assert!(!archive.root.join(snapshot::SNAPSHOTS_DIR).exists());
}

#[test]
fn preview_names_every_change_and_flags_hand_added_files() {
    let archive = Archive::new(&[("BOOK", PAGES)]);
    let id = item_id_for("BOOK");
    let batch = lifecycle::create(&archive.db, &batch_over(&[&id])).unwrap();
    write_file(&archive.folder("BOOK").join("BOOK.pdf"), "derived");
    write_file(&archive.folder("BOOK").join("notes.docx"), "added by hand");
    std::fs::remove_file(archive.folder("BOOK").join("2.jpg")).unwrap();

    let plan = lifecycle::preview(&archive.db, &batch.id, false).unwrap();

    assert!(plan.has_snapshot);
    assert_eq!(plan.blocked_reason, None);
    let item = &plan.items[0];
    assert_eq!(
        item.remove,
        vec![
            BatchDeleteFileDto { path: "BOOK.pdf".into(), generated: true },
            BatchDeleteFileDto { path: "notes.docx".into(), generated: false },
        ]
    );
    assert_eq!(item.restore, vec!["2.jpg".to_string()]);
    assert_eq!(item.before.as_ref().unwrap().batch_id, None);
    assert!(archive.folder("BOOK").join("notes.docx").exists(), "the preview changed files");
}

#[test]
fn delete_is_refused_once_the_backend_was_touched_or_while_running() {
    let archive = Archive::new(&[("BOOK", PAGES)]);
    let id = item_id_for("BOOK");
    let batch = lifecycle::create(&archive.db, &batch_over(&[&id])).unwrap();

    let running = lifecycle::delete(&archive.db, &batch.id, true);
    assert!(matches!(running, Err(AppError::Invalid(ref m)) if m == lifecycle::RUNNING_REASON));

    archive
        .db
        .with(|c| batches::mark_backend_touched(c, &batch.id))
        .unwrap();
    let touched = lifecycle::delete(&archive.db, &batch.id, false);
    assert!(matches!(touched, Err(AppError::Invalid(ref m)) if m == lifecycle::BACKEND_REASON));
    let plan = lifecycle::preview(&archive.db, &batch.id, false).unwrap();
    assert_eq!(plan.blocked_reason.as_deref(), Some(lifecycle::BACKEND_REASON));
    assert_eq!(archive.db.with(batches::list).unwrap().len(), 1);
}

#[test]
fn a_failed_restore_keeps_the_batch_so_a_retry_can_finish() {
    let archive = Archive::new(&[("A", PAGES), ("B", PAGES)]);
    let (a, b) = (item_id_for("A"), item_id_for("B"));
    let batch = lifecycle::create(&archive.db, &batch_over(&[&a, &b])).unwrap();
    std::fs::remove_dir_all(snapshot::item_dir(&archive.root, &batch.id, &b)).unwrap();

    assert!(lifecycle::delete(&archive.db, &batch.id, false).is_err());

    assert_eq!(archive.db.with(batches::list).unwrap().len(), 1);
    assert_eq!(
        archive.db.with(|c| items::get(c, &b)).unwrap().batch_id.as_deref(),
        Some(batch.id.as_str())
    );
}

#[test]
fn a_batch_without_snapshots_is_deleted_by_releasing_its_items() {
    let archive = Archive::new(&[("BOOK", PAGES)]);
    let id = item_id_for("BOOK");
    let legacy = archive
        .db
        .transaction(|t| batches::create(t, &batch_over(&[&id])))
        .unwrap();
    write_file(&archive.folder("BOOK").join("BOOK.pdf"), "made before snapshots");

    let plan = lifecycle::preview(&archive.db, &legacy.id, false).unwrap();
    assert!(!plan.has_snapshot);
    lifecycle::delete(&archive.db, &legacy.id, false).unwrap();

    assert_eq!(archive.db.with(|c| items::get(c, &id)).unwrap().batch_id, None);
    assert!(archive.folder("BOOK").join("BOOK.pdf").exists(), "a legacy delete touched files");
}

#[test]
fn archive_drops_the_snapshot_folders() {
    let archive = Archive::new(&[("BOOK", PAGES)]);
    let id = item_id_for("BOOK");
    let batch = lifecycle::create(&archive.db, &batch_over(&[&id])).unwrap();

    lifecycle::archive(&archive.db, &batch.id).unwrap();

    assert!(!archive.root.join(snapshot::SNAPSHOTS_DIR).exists());
    assert!(archive.db.with(|c| snapshots::list(c, &batch.id)).unwrap().is_empty());
}

#[test]
fn sweep_removes_snapshots_whose_batch_is_gone() {
    let archive = Archive::new(&[("A", PAGES), ("B", PAGES)]);
    let (a, b) = (item_id_for("A"), item_id_for("B"));
    let kept = lifecycle::create(&archive.db, &batch_over(&[&a])).unwrap();
    let gone = lifecycle::create(&archive.db, &batch_over(&[&b])).unwrap();
    // A crash between the delete's commit and its folder cleanup.
    archive.db.transaction(|t| batches::delete(t, &gone.id)).unwrap();

    lifecycle::sweep(&archive.db, &[archive.root.clone()]).unwrap();

    assert!(snapshot::batch_dir(&archive.root, &kept.id).exists());
    assert!(!snapshot::batch_dir(&archive.root, &gone.id).exists());
}

#[test]
fn create_fails_cleanly_when_a_member_folder_is_missing() {
    let archive = Archive::new(&[("A", PAGES), ("B", PAGES)]);
    let (a, b) = (item_id_for("A"), item_id_for("B"));
    std::fs::remove_dir_all(archive.folder("B")).unwrap();

    assert!(lifecycle::create(&archive.db, &batch_over(&[&a, &b])).is_err());

    assert!(archive.db.with(batches::list).unwrap().is_empty());
    assert!(!archive.root.join(snapshot::SNAPSHOTS_DIR).exists());
    assert_eq!(archive.db.with(|c| items::get(c, &a)).unwrap().batch_id, None);
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --test batch_lifecycle`
Expected: compile error — `core::batch_lifecycle` doesn't exist.

- [ ] **Step 3: Implement**

`dto.rs`, after `BatchCreateDto`:

```rust
/// One file a batch delete would remove from an item folder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchDeleteFileDto {
    /// `/`-joined path inside the item folder (`"a.pdf"`, `"source/a.pdf"`,
    /// `".nbcg-tmp-…/"` for a staging folder).
    pub path: String,
    /// Named like one of the app's own outputs; false flags a file someone
    /// added by hand.
    pub generated: bool,
}

/// What deleting a batch does to one member.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchDeleteItemDto {
    pub item_id: String,
    pub folder_name: String,
    /// The item's index state after the delete: its pre-batch state, or for
    /// a batch without snapshots its current state minus the claim. Null
    /// when the item is no longer in the index.
    pub before: Option<IndexedItemDto>,
    pub remove: Vec<BatchDeleteFileDto>,
    /// Paths put back from the snapshot (missing now, or changed).
    pub restore: Vec<String>,
    /// Why this item's folder can't be compared with its snapshot.
    pub error: Option<String>,
}

/// A read-only dry run of `batch_delete` — the confirmation's content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchDeletePlanDto {
    pub batch_id: String,
    /// False for a batch made before snapshots existed: deleting it only
    /// releases its items.
    pub has_snapshot: bool,
    /// Why the batch can't be deleted right now.
    pub blocked_reason: Option<String>,
    pub items: Vec<BatchDeleteItemDto>,
}
```

`core/jobs/lock.rs`:

```rust
/// The batch currently holding the lock, if any.
pub fn running_batch(lock: &Mutex<JobRunLock>) -> Option<String> {
    lock.lock()
        .unwrap_or_else(|e| e.into_inner())
        .batch_id
        .clone()
}
```

and export it from `core/jobs/mod.rs`: `pub use lock::{request_cancel, running_batch, try_acquire, JobRunGuard, JobRunLock};`

`src-tauri/src/core/batch_lifecycle.rs`:

```rust
//! Batch create / preview / delete / archive where they touch the folders
//! and the index together — the undo side of
//! docs/superpowers/specs/2026-09-29-delete-batch-design.md.
//!
//! File work happens outside the database transaction (it can't be rolled
//! back), ordered so a failure leaves nothing a retry can't finish:
//! - create takes the snapshots first, then commits; a failed commit removes them;
//! - delete restores every folder first (idempotent) and commits only once all
//!   of them succeeded, so a partial failure keeps the batch for a retry;
//! - archive and delete remove snapshot folders only after the commit, best
//!   effort — [`sweep`] catches whatever a crash left behind.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::core::db::{batches, items, snapshots, Db};
use crate::core::snapshot;
use crate::dto::{
    BatchCreateDto, BatchDeleteFileDto, BatchDeleteItemDto, BatchDeletePlanDto, BatchDto,
    IndexedItemDto,
};
use crate::error::{AppError, Result};

// The three refusals, word for word as `domain/batch.DELETE_BLOCKED` shows them.
pub const RUNNING_REASON: &str = "Stop the processing run before deleting this batch.";
pub const ARCHIVED_REASON: &str = "Uploaded batches can't be deleted.";
pub const BACKEND_REASON: &str =
    "This batch has already sent changes to the backend, so it can't be undone. Use Close batch instead.";

/// Why `batch` can't be deleted, or `None` when it can. `running` is whether
/// its processing run holds the job lock right now.
pub fn delete_blocked_reason(batch: &BatchDto, running: bool) -> Option<&'static str> {
    if running {
        return Some(RUNNING_REASON);
    }
    if batch.archived_at.is_some() {
        return Some(ARCHIVED_REASON);
    }
    if batch.backend_touched_at.is_some() {
        return Some(BACKEND_REASON);
    }
    None
}

/// The distinct `<root>/.nbcg-snapshots/<batch>` folders holding these item snapshots.
fn batch_dirs<'a>(item_dirs: impl Iterator<Item = &'a Path>) -> BTreeSet<PathBuf> {
    item_dirs
        .filter_map(|dir| dir.parent().map(Path::to_path_buf))
        .collect()
}

/// Remove a batch's snapshot folders, best effort — a leftover is swept at
/// the next launch.
fn drop_snapshots<'a>(batch_id: &str, item_dirs: impl Iterator<Item = &'a Path>) {
    for dir in batch_dirs(item_dirs) {
        if let Err(e) = snapshot::drop_batch(&dir, batch_id) {
            eprintln!("[nbcg-dc] couldn't remove the snapshot at {}: {e}", dir.display());
        }
    }
}

/// Create a batch: snapshot every member's folder, then — in one
/// transaction — record each member's index state, create the row and claim
/// the items.
pub fn create(db: &Db, fields: &BatchCreateDto) -> Result<BatchDto> {
    let batch_id = uuid::Uuid::new_v4().to_string();
    let members = db.with(|c| {
        fields
            .item_ids
            .iter()
            .map(|id| items::get(c, id))
            .collect::<Result<Vec<_>>>()
    })?;

    let mut taken: Vec<(String, PathBuf)> = Vec::new();
    for item in &members {
        let folder = Path::new(&item.folder_path);
        let taking = snapshot::root_of(folder, &item.relative_path)
            .ok_or_else(|| {
                AppError::Invalid(format!(
                    "can't tell which scan root {} is under",
                    item.folder_path
                ))
            })
            .map(|root| snapshot::item_dir(&root, &batch_id, &item.id))
            .and_then(|dest| snapshot::take(folder, &dest).map(|()| dest));
        match taking {
            Ok(dest) => taken.push((item.id.clone(), dest)),
            Err(e) => {
                drop_snapshots(&batch_id, taken.iter().map(|(_, d)| d.as_path()));
                return Err(AppError::Invalid(format!(
                    "Couldn't prepare {} for undo: {e}",
                    item.folder_name
                )));
            }
        }
    }

    let created = db.transaction(|tx| {
        let states = taken
            .iter()
            .map(|(id, _)| snapshots::read_state(tx, id))
            .collect::<Result<Vec<_>>>()?;
        let batch = batches::create_with_id(tx, &batch_id, fields)?;
        for (state, (_, dest)) in states.iter().zip(&taken) {
            snapshots::insert(tx, &batch_id, state, &dest.to_string_lossy())?;
        }
        Ok(batch)
    });
    if created.is_err() {
        drop_snapshots(&batch_id, taken.iter().map(|(_, d)| d.as_path()));
    }
    created
}

fn without_claim(mut item: IndexedItemDto) -> IndexedItemDto {
    item.batch_id = None;
    item
}

fn plan_for_snapshot(row: &snapshots::SnapshotRow) -> BatchDeleteItemDto {
    let folder_name = row.item.folder_name.clone();
    let before = Some(without_claim(row.item.clone()));
    match snapshot::diff(Path::new(&row.item.folder_path), Path::new(&row.snapshot_dir)) {
        Ok(diff) => BatchDeleteItemDto {
            item_id: row.item_id.clone(),
            remove: diff
                .remove
                .iter()
                .map(|path| BatchDeleteFileDto {
                    generated: snapshot::is_app_output(path, &folder_name, &diff.scope),
                    path: path.clone(),
                })
                .chain(diff.staging.iter().map(|dir| BatchDeleteFileDto {
                    path: format!("{dir}/"),
                    generated: true,
                }))
                .collect(),
            restore: diff.restore,
            folder_name,
            before,
            error: None,
        },
        Err(e) => BatchDeleteItemDto {
            item_id: row.item_id.clone(),
            folder_name,
            before,
            remove: Vec::new(),
            restore: Vec::new(),
            error: Some(e.to_string()),
        },
    }
}

/// A read-only dry run of [`delete`]: per member, what goes, what comes back
/// and what state it returns to.
pub fn preview(db: &Db, batch_id: &str, running: bool) -> Result<BatchDeletePlanDto> {
    let (batch, rows, released) = db.with(|c| {
        let batch = batches::get(c, batch_id)?;
        let rows = snapshots::list(c, batch_id)?;
        let snapshotted: HashSet<&str> = rows.iter().map(|r| r.item_id.as_str()).collect();
        // A member without a snapshot (a batch made before snapshots) is
        // only released: it returns to its current state minus the claim.
        let mut released = HashMap::new();
        for id in batch.item_ids.iter().filter(|id| !snapshotted.contains(id.as_str())) {
            match items::get(c, id) {
                Ok(item) => {
                    released.insert(id.clone(), without_claim(item));
                }
                Err(AppError::NotFound(_)) => {}
                Err(e) => return Err(e),
            }
        }
        Ok((batch, rows, released))
    })?;

    let by_item: HashMap<&str, &snapshots::SnapshotRow> =
        rows.iter().map(|r| (r.item_id.as_str(), r)).collect();
    let items = batch
        .item_ids
        .iter()
        .map(|id| match by_item.get(id.as_str()) {
            Some(row) => plan_for_snapshot(row),
            None => {
                let before = released.get(id).cloned();
                BatchDeleteItemDto {
                    item_id: id.clone(),
                    folder_name: before.as_ref().map_or_else(|| id.clone(), |i| i.folder_name.clone()),
                    before,
                    remove: Vec::new(),
                    restore: Vec::new(),
                    error: None,
                }
            }
        })
        .collect();

    Ok(BatchDeletePlanDto {
        batch_id: batch.id.clone(),
        has_snapshot: !rows.is_empty(),
        blocked_reason: delete_blocked_reason(&batch, running).map(String::from),
        items,
    })
}

/// Delete a batch: put every member's folder back from its snapshot, then —
/// in one transaction — its index state, and remove the batch. A batch
/// without snapshots only releases its items.
///
/// If any folder can't be restored (a file open in another program), the
/// batch and the index are left as they are and the error names each item;
/// folder restores are idempotent, so trying again finishes the job.
pub fn delete(db: &Db, batch_id: &str, running: bool) -> Result<()> {
    let (batch, rows) = db.with(|c| Ok((batches::get(c, batch_id)?, snapshots::list(c, batch_id)?)))?;
    if let Some(reason) = delete_blocked_reason(&batch, running) {
        return Err(AppError::Invalid(reason.to_string()));
    }

    let failures: Vec<String> = rows
        .iter()
        .filter_map(|row| {
            snapshot::restore(Path::new(&row.item.folder_path), Path::new(&row.snapshot_dir))
                .err()
                .map(|e| format!("{} ({e})", row.item.folder_name))
        })
        .collect();
    if !failures.is_empty() {
        return Err(AppError::Invalid(format!(
            "Couldn't put back {}. The batch was kept - close anything that has these \
             files open, then try again.",
            failures.join("; ")
        )));
    }

    db.transaction(|tx| {
        for row in &rows {
            snapshots::restore_index(tx, row)?;
        }
        batches::delete(tx, batch_id)
    })?;
    drop_snapshots(batch_id, rows.iter().map(|r| Path::new(&r.snapshot_dir)));
    Ok(())
}

/// Archive a batch (see `batches::archive`) and remove its snapshots — an
/// archived batch can't be deleted, so they would only hold disk space.
pub fn archive(db: &Db, batch_id: &str) -> Result<BatchDto> {
    let rows = db.with(|c| snapshots::list(c, batch_id))?;
    let archived = db.transaction(|tx| batches::archive(tx, batch_id))?;
    drop_snapshots(batch_id, rows.iter().map(|r| Path::new(&r.snapshot_dir)));
    Ok(archived)
}

/// Remove, under each root, the snapshot folders of batches that no longer
/// hold snapshots. Run once at launch, before any command can create one.
pub fn sweep(db: &Db, roots: &[PathBuf]) -> Result<()> {
    let live = db.with(snapshots::live_batch_ids)?;
    for root in roots {
        snapshot::sweep(root, &live)?;
    }
    Ok(())
}
```

Add `pub mod batch_lifecycle;` to `core/mod.rs`.

- [ ] **Step 4: Run to verify they pass**

Run: `cargo test --test batch_lifecycle`
Expected: all pass.

---

### Task 5: Commands, registration, startup sweep, watcher filter

**Files:**
- Modify: `src-tauri/src/commands/batch.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/core/fs/watcher.rs`

**Interfaces:**
- Produces IPC: `batch_create` (now async + snapshots), `batch_archive` (drops snapshots), `batch_delete_preview({ batchId }) -> BatchDeletePlanDto`, `batch_delete({ batchId }) -> ()`, `batch_mark_backend_touched({ batchId }) -> BatchDto`.

- [ ] **Step 1: Watcher filter** — in `spawn_watch`, skip snapshot paths:

```rust
        for path in event.paths {
            // Taking or dropping a batch snapshot is not a change to any item.
            if crate::core::snapshot::is_snapshot_path(&path) {
                continue;
            }
            emit(FsChangedEvent { … });
        }
```

(Its test is `snapshot_paths_are_recognised` in Task 2.)

- [ ] **Step 2: Commands** — `commands/batch.rs`:

```rust
use crate::core::{batch_lifecycle, db, jobs};
use crate::dto::{BatchCreateDto, BatchDeletePlanDto, BatchDto};
use crate::error::{AppError, Result};

/// Create a batch: snapshot every member's folder for undo, then persist the
/// row, assign its number and claim its items (see
/// [`batch_lifecycle::create`]). Async: snapshotting falls back to copying on
/// a volume that can't hard-link, which must not freeze the window.
#[tauri::command(async)]
pub fn batch_create(state: State<'_, AppState>, fields: BatchCreateDto) -> Result<BatchDto> {
    batch_lifecycle::create(&state.db, &fields)
}

/// Archive a batch, release its items and drop its snapshots.
#[tauri::command]
pub fn batch_archive(state: State<'_, AppState>, batch_id: String) -> Result<BatchDto> {
    batch_lifecycle::archive(&state.db, &batch_id)
}

/// Record, before an upload's first backend write, that this batch is about
/// to change the backend — from then on it can't be deleted.
#[tauri::command]
pub fn batch_mark_backend_touched(state: State<'_, AppState>, batch_id: String) -> Result<BatchDto> {
    state.db.with(|c| db::batches::mark_backend_touched(c, &batch_id))
}

/// Dry-run a delete: per member, what goes, what comes back, and why the
/// batch can't be deleted if it can't.
#[tauri::command(async)]
pub fn batch_delete_preview(state: State<'_, AppState>, batch_id: String) -> Result<BatchDeletePlanDto> {
    let running = jobs::running_batch(&state.job_run).as_deref() == Some(batch_id.as_str());
    batch_lifecycle::preview(&state.db, &batch_id, running)
}

/// Delete a batch, putting its members back as they were before it.
///
/// Holds the job lock while it works, so the batch can't start processing
/// mid-restore. If another batch holds it, this one can't start either until
/// that run ends — so there is nothing to wait for.
#[tauri::command(async)]
pub fn batch_delete(state: State<'_, AppState>, batch_id: String) -> Result<()> {
    let _guard = match jobs::try_acquire(&state.job_run, &batch_id) {
        Ok(guard) => Some(guard),
        Err(_) if jobs::running_batch(&state.job_run).as_deref() == Some(batch_id.as_str()) => {
            return Err(AppError::Invalid(batch_lifecycle::RUNNING_REASON.into()));
        }
        Err(_) => None,
    };
    batch_lifecycle::delete(&state.db, &batch_id, false)
}
```

(`batch_list` and `batch_update` stay as they are.)

- [ ] **Step 3: Register + sweep** — `lib.rs`: add `commands::batch::batch_delete_preview, commands::batch::batch_delete, commands::batch::batch_mark_backend_touched,` to `generate_handler!`, and replace the startup watch block with:

```rust
            // Start watching whatever is already configured, and clear out
            // snapshots of batches that ended while a crash kept their folder
            // cleanup from running. A first run has no roots yet;
            // `config_save` re-points the watcher once they are set.
            if let Ok((unprocessed, processed)) = state.roots() {
                let roots: Vec<PathBuf> =
                    [unprocessed.clone(), processed.clone()].into_iter().flatten().collect();
                if let Err(e) = core::batch_lifecycle::sweep(&state.db, &roots) {
                    eprintln!("[nbcg-dc] could not clean up old batch snapshots: {e}");
                }
                rewatch(&handle, &state, unprocessed.as_deref(), processed.as_deref());
            }
```

(`use std::path::{Path, PathBuf};`)

- [ ] **Step 4: Verify the native side**

Run (in `src-tauri`): `cargo test` then `cargo clippy --all-targets`
Expected: all tests pass; no new clippy warnings.

---

### Task 6: TS contract, domain rule, services, store actions

**Files:**
- Modify: `src/ipc/bindings.ts`, `src/domain/batch.ts`, `src/services/batches.ts`, `src/stores/useBatches.ts`
- Modify fixtures (add `backendTouchedAt: null`): `src/domain/batch.test.ts`, `src/composables/useMetadataForm.test.ts`, `src/composables/useProcessing.test.ts`, `src/services/pipeline.test.ts`, `src/stores/useBatchWork.test.ts`, `src/stores/useProcessing.test.ts`, `src/stores/useUpload.test.ts`
- Test: `src/domain/batch.test.ts`, `src/stores/useBatches.test.ts` (new)

**Interfaces:**
- Produces: `Batch.backendTouchedAt: string | null`; `DELETE_BLOCKED`; `deleteBlockedReason(batch, { uploading }) -> string | null`; types `BatchDeleteFile`, `BatchDeleteItem`, `BatchDeletePlan`; services `previewBatchDelete`, `deleteBatch`, `markBatchBackendTouched`; store `previewDelete(id)`, `remove(id)`, `markBackendTouched(id)`.

- [ ] **Step 1: Write the failing tests**

In `src/domain/batch.test.ts` (import `deleteBlockedReason`, `DELETE_BLOCKED`):

```ts
describe("deleteBlockedReason", () => {
  const idle = { uploading: false };

  it("allows a batch that has not reached the backend", () => {
    expect(deleteBlockedReason(makeBatch(), idle)).toBeNull();
  });

  it("blocks while the batch processes or uploads", () => {
    expect(deleteBlockedReason(makeBatch({ running: true }), idle)).toBe(DELETE_BLOCKED.running);
    expect(deleteBlockedReason(makeBatch(), { uploading: true })).toBe(DELETE_BLOCKED.uploading);
  });

  it("blocks an archived batch and one that has touched the backend", () => {
    expect(deleteBlockedReason(makeBatch({ archivedAt: "2026-09-29T10:00:00.000Z" }), idle)).toBe(
      DELETE_BLOCKED.archived,
    );
    expect(
      deleteBlockedReason(makeBatch({ backendTouchedAt: "2026-09-29T10:00:00.000Z" }), idle),
    ).toBe(DELETE_BLOCKED.backend);
  });
});
```

New `src/stores/useBatches.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { newBatchFields, type Batch } from "@domain/batch";
import { ItemState } from "@domain/item";

const refresh = vi.fn(async () => {});
vi.mock("./useItems", () => ({ useItemsStore: () => ({ refresh, load: async () => {} }) }));
vi.mock("@services/batches", () => ({
  listBatches: vi.fn(async () => []),
  createBatch: vi.fn(),
  updateBatch: vi.fn(),
  archiveBatch: vi.fn(),
  previewBatchDelete: vi.fn(),
  deleteBatch: vi.fn(async () => {}),
  markBatchBackendTouched: vi.fn(),
}));

const { useBatchesStore } = await import("./useBatches");
const services = await import("@services/batches");

function makeBatch(over: Partial<Batch> = {}): Batch {
  return {
    ...newBatchFields({ type: ItemState.ToProcess, itemIds: ["i1"] }),
    id: "b1",
    no: 1,
    createdAt: "2026-09-29T00:00:00.000Z",
    archivedAt: null,
    backendTouchedAt: null,
    ...over,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  refresh.mockClear();
  vi.mocked(services.deleteBatch).mockReset().mockResolvedValue();
});

describe("useBatchesStore delete", () => {
  it("remove deletes natively, drops the batch and rescans", async () => {
    const store = useBatchesStore();
    store.batches = [makeBatch(), makeBatch({ id: "b2", no: 2 })];

    await store.remove("b1");

    expect(services.deleteBatch).toHaveBeenCalledWith("b1");
    expect(store.batches.map((b) => b.id)).toEqual(["b2"]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps the batch when the native delete fails", async () => {
    const store = useBatchesStore();
    store.batches = [makeBatch()];
    vi.mocked(services.deleteBatch).mockRejectedValueOnce("file in use");

    await expect(store.remove("b1")).rejects.toBe("file in use");

    expect(store.batches).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("markBackendTouched stores the marked batch", async () => {
    const store = useBatchesStore();
    store.batches = [makeBatch()];
    const marked = makeBatch({ backendTouchedAt: "2026-09-29T10:00:00.000Z" });
    vi.mocked(services.markBatchBackendTouched).mockResolvedValueOnce(marked);

    await store.markBackendTouched("b1");

    expect(store.get("b1")?.backendTouchedAt).toBe("2026-09-29T10:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/domain/batch.test.ts src/stores/useBatches.test.ts`
Expected: FAIL — `deleteBlockedReason` / `remove` not defined.

- [ ] **Step 3: Implement**

`bindings.ts`:
- `Commands`: add `batchDeletePreview: "batch_delete_preview"`, `batchDelete: "batch_delete"`, `batchMarkBackendTouched: "batch_mark_backend_touched"`.
- `BatchDto`: add after `archivedAt`

```ts
  /**
   * When the batch first wrote to the backend (set write-ahead, just before an
   * upload's first backend write), or null. Once set it can't be deleted — its
   * changes are no longer only local. Native-owned: `batch_update` never
   * writes it, so a stale copy sent back can't clear it.
   */
  backendTouchedAt: string | null;
```

- `BatchCreateDto`: omit `"backendTouchedAt"` too.
- New DTOs after `BatchCreateDto`:

```ts
/** One file a batch delete would remove from an item folder. */
export interface BatchDeleteFileDto {
  /** `/`-joined path inside the item folder (`"a.pdf"`, `"source/a.pdf"`,
   * `".nbcg-tmp-…/"` for a staging folder). */
  path: string;
  /** Named like one of the app's own outputs; false flags a file someone
   * added by hand. */
  generated: boolean;
}

/** What deleting a batch does to one member. */
export interface BatchDeleteItemDto {
  itemId: string;
  folderName: string;
  /** The item's index state after the delete — its pre-batch state, or for a
   * batch without snapshots its current state minus the claim. Null when the
   * item is no longer in the index. */
  before: IndexedItemDto | null;
  remove: BatchDeleteFileDto[];
  /** Paths put back from the snapshot (missing now, or changed). */
  restore: string[];
  /** Why this item's folder can't be compared with its snapshot. */
  error: string | null;
}

/** A read-only dry run of `batch.delete` — the confirmation's content. */
export interface BatchDeletePlanDto {
  batchId: string;
  /** False for a batch made before snapshots existed: deleting it only
   * releases its items. */
  hasSnapshot: boolean;
  /** Why the batch can't be deleted right now. */
  blockedReason: string | null;
  items: BatchDeleteItemDto[];
}
```

- `ipc.batch`: add

```ts
    /** Dry-run a delete (read-only): per member, what goes and what comes back. */
    deletePreview: (batchId: string) =>
      call<BatchDeletePlanDto>(Commands.batchDeletePreview, { batchId }),
    /** Delete a batch: put each member's folder and index state back from its
     * pre-batch snapshot, then remove the batch. Refused once it has touched
     * the backend. */
    delete: (batchId: string) => call<void>(Commands.batchDelete, { batchId }),
    /** Record, before an upload's first backend write, that this batch is about
     * to change the backend (idempotent). */
    markBackendTouched: (batchId: string) =>
      call<BatchDto>(Commands.batchMarkBackendTouched, { batchId }),
```

`domain/batch.ts`:
- `import { ItemState, type Item } from "./item";`
- `Batch`: add after `archivedAt`

```ts
  /** When the batch first wrote to the backend, or null. Once set it can't be
   * deleted (see {@link deleteBlockedReason}). */
  backendTouchedAt: string | null;
```

- `NewBatchFields`: `Omit<Batch, "id" | "no" | "createdAt" | "archivedAt" | "backendTouchedAt">`.
- After `isUnfinished`:

```ts
/** Why a batch can't be deleted — word for word what `core::batch_lifecycle`
 * refuses with, so the button's tooltip and a native refusal read alike. */
export const DELETE_BLOCKED = {
  running: "Stop the processing run before deleting this batch.",
  uploading: "Wait for the upload to finish.",
  archived: "Uploaded batches can't be deleted.",
  backend:
    "This batch has already sent changes to the backend, so it can't be undone. Use Close batch instead.",
} as const;

/**
 * Why `batch` can't be deleted right now, or null when it can. Delete is an
 * undo of local work only: once the batch has written to the backend it is
 * blocked for good. The native side re-checks all of this except `uploading`,
 * which only the upload store knows.
 */
export function deleteBlockedReason(
  batch: Batch,
  context: { uploading: boolean },
): string | null {
  if (batch.running) return DELETE_BLOCKED.running;
  if (context.uploading) return DELETE_BLOCKED.uploading;
  if (isArchived(batch)) return DELETE_BLOCKED.archived;
  if (batch.backendTouchedAt != null) return DELETE_BLOCKED.backend;
  return null;
}

/** One file a batch delete removes. */
export interface BatchDeleteFile {
  path: string;
  /** Named like one of the app's own outputs; false = added by hand. */
  generated: boolean;
}

/** What deleting a batch does to one member (`ipc/bindings.BatchDeleteItemDto`). */
export interface BatchDeleteItem {
  itemId: string;
  folderName: string;
  /** The item as it will be after the delete, or null if it left the index. */
  before: Item | null;
  remove: BatchDeleteFile[];
  restore: string[];
  error: string | null;
}

/** A dry run of a batch delete — the confirmation's content. */
export interface BatchDeletePlan {
  batchId: string;
  hasSnapshot: boolean;
  blockedReason: string | null;
  items: BatchDeleteItem[];
}
```

`services/batches.ts`:
- `toBatch`: add `backendTouchedAt: dto.backendTouchedAt ?? null,`
- imports: `import { toItem } from "./indexing";` and `type BatchDeletePlan` from `@domain/batch`.
- New functions:

```ts
/** Dry-run a delete (read-only): per member, what goes, what comes back and
 * the state it returns to. */
export async function previewBatchDelete(batchId: string): Promise<BatchDeletePlan> {
  const dto = await ipc.batch.deletePreview(batchId);
  return {
    batchId: dto.batchId,
    hasSnapshot: dto.hasSnapshot,
    blockedReason: dto.blockedReason ?? null,
    items: dto.items.map((i) => ({
      itemId: i.itemId,
      folderName: i.folderName,
      before: i.before ? toItem(i.before) : null,
      remove: i.remove,
      restore: i.restore,
      error: i.error ?? null,
    })),
  };
}

/** Delete a batch, putting its members back as they were before it. Throws
 * outside Tauri. */
export async function deleteBatch(batchId: string): Promise<void> {
  await ipc.batch.delete(batchId);
}

/** Record that a batch is about to write to the backend (write-ahead; see
 * `stores/useUpload.run`). */
export async function markBatchBackendTouched(batchId: string): Promise<Batch> {
  return toBatch(await ipc.batch.markBackendTouched(batchId));
}
```

`stores/useBatches.ts` — import the three services and `type BatchDeletePlan`, then add actions (and return them):

```ts
  /** Dry-run a delete — the confirmation's content (read-only). */
  function previewDelete(batchId: string): Promise<BatchDeletePlan> {
    return previewBatchDelete(batchId);
  }

  /**
   * Delete a batch natively — each member's folder and index state go back to
   * how they were before it — then drop it here and rescan, so the Overview
   * shows the restored folders. The caller stops the members' pending metadata
   * autosaves first (`composables/useDeleteBatch`).
   */
  async function remove(batchId: string): Promise<void> {
    await deleteBatch(batchId);
    batches.value = batches.value.filter((b) => b.id !== batchId);
    await useItemsStore().refresh();
  }

  /** Record that a batch is about to write to the backend (write-ahead). */
  async function markBackendTouched(batchId: string): Promise<void> {
    replaceInList(await markBatchBackendTouched(batchId));
  }
```

Fixtures: add `backendTouchedAt: null,` next to `archivedAt: null,` in each listed test file.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run` and `npx vue-tsc --noEmit`
Expected: all pass, typecheck clean.

---

### Task 7: Write-ahead backend mark on upload

**Files:**
- Modify: `src/services/upload.ts`, `src/stores/useUpload.ts`
- Test: `src/services/upload.test.ts`, `src/stores/useUpload.test.ts`

**Interfaces:**
- Consumes: `useBatchesStore().markBackendTouched(batchId)` (Task 6).
- Produces: `withBackendWriteMark(mark: () => Promise<void>, base?: Partial<UploadDeps>): Partial<UploadDeps>`.

- [ ] **Step 1: Write the failing tests**

`src/services/upload.test.ts` (import `withBackendWriteMark`):

```ts
describe("withBackendWriteMark", () => {
  it("marks once, before the first backend write", async () => {
    const order: string[] = [];
    const mark = vi.fn(async () => {
      order.push("mark");
    });
    const deps = withBackendWriteMark(mark, {
      createItem: vi.fn(async () => {
        order.push("create");
        return {} as never;
      }),
      connectParent: vi.fn(async () => {
        order.push("connect");
        return {} as never;
      }),
    });

    await deps.createItem!({} as never);
    await deps.connectParent!("p1", "c1");

    expect(mark).toHaveBeenCalledOnce();
    expect(order).toEqual(["mark", "create", "connect"]);
  });

  it("never marks for a read", async () => {
    const mark = vi.fn(async () => {});
    const listFiles = vi.fn(async () => []);
    const deps = withBackendWriteMark(mark, { listFiles });

    await deps.listFiles!("rec-1");

    expect(listFiles).toHaveBeenCalledOnce();
    expect(mark).not.toHaveBeenCalled();
  });

  it("writes nothing when the mark can't be saved", async () => {
    const mark = vi.fn(async () => {
      throw new Error("disk full");
    });
    const createItem = vi.fn();
    const deps = withBackendWriteMark(mark, { createItem });

    await expect(deps.createItem!({} as never)).rejects.toThrow("disk full");
    await expect(deps.createItem!({} as never)).rejects.toThrow("disk full");

    expect(createItem).not.toHaveBeenCalled();
    expect(mark).toHaveBeenCalledOnce();
  });
});
```

`src/stores/useUpload.test.ts`:

```ts
describe("useUpload.run backend mark", () => {
  it("marks the batch before the upload's first backend write", async () => {
    const batches = useBatchesStore();
    batches.batches = [makeBatch()];
    const mark = vi.spyOn(batches, "markBackendTouched").mockResolvedValue();
    vi.mocked(uploadBatch).mockImplementationOnce(async (_items, options) => {
      expect(mark).not.toHaveBeenCalled();
      // The real createItem fails here (no backend) — only the mark matters.
      await options.deps?.createItem?.({} as never).catch(() => undefined);
      expect(mark).toHaveBeenCalledWith("b1");
      return { results: [], allUploaded: false, missingParentIds: [] };
    });
    vi.spyOn(useItemsStore(), "refresh").mockResolvedValue();

    await useUploadStore().run("b1", [{ id: "i1" } as Item], () => ({}) as UploadItemContext);

    expect(mark).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/services/upload.test.ts src/stores/useUpload.test.ts`
Expected: FAIL — `withBackendWriteMark` not exported; the store never marks.

- [ ] **Step 3: Implement**

`services/upload.ts`, after `withDefaults`:

```ts
/**
 * `base` with every backend **write** made to await `mark()` first — once per
 * run, before the first write. What keeps batch delete honest: a batch whose
 * upload got as far as the backend is no longer only local, so it must never
 * be offered for undo (docs/superpowers/specs/2026-09-29-delete-batch-design.md).
 *
 * Fails closed: if the mark can't be saved, no write is attempted — every
 * write in the run rejects with the mark's error. Reads are left alone.
 */
export function withBackendWriteMark(
  mark: () => Promise<void>,
  base: Partial<UploadDeps> = {},
): Partial<UploadDeps> {
  const deps = withDefaults(base);
  let marked: Promise<void> | null = null;
  const beforeWrite = (): Promise<void> => (marked ??= mark());
  return {
    ...base,
    createItem: async (...args) => {
      await beforeWrite();
      return deps.createItem(...args);
    },
    updateItem: async (...args) => {
      await beforeWrite();
      return deps.updateItem(...args);
    },
    uploadFiles: async (...args) => {
      await beforeWrite();
      return deps.uploadFiles(...args);
    },
    replaceFile: async (...args) => {
      await beforeWrite();
      return deps.replaceFile(...args);
    },
    setFileText: async (...args) => {
      await beforeWrite();
      return deps.setFileText(...args);
    },
    connectParent: async (...args) => {
      await beforeWrite();
      return deps.connectParent(...args);
    },
  };
}
```

`stores/useUpload.ts` — import `withBackendWriteMark`; in `run`, pass it to `uploadBatch`:

```ts
      const outcome = await uploadBatch(items, {
        resolveContext,
        onProgress: (p) => {
          progress.value = p;
        },
        // Write-ahead: the batch is marked as having reached the backend
        // before its first write, so it is never offered for delete after.
        deps: withBackendWriteMark(() => markBackendTouched(batchId)),
      });
```

and add inside the store:

```ts
  /** Persist the batch's "reached the backend" mark; a failure stops the
   * upload before anything is sent (see `withBackendWriteMark`). */
  async function markBackendTouched(batchId: string): Promise<void> {
    try {
      await useBatchesStore().markBackendTouched(batchId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Couldn't record that this batch is being uploaded, so nothing was sent: ${reason}`);
    }
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/services/upload.test.ts src/stores/useUpload.test.ts` then `npx vue-tsc --noEmit`
Expected: pass; typecheck clean.

---

### Task 8: `useMetadata.forget`

**Files:**
- Modify: `src/stores/useMetadata.ts`
- Test: `src/stores/useMetadata.test.ts`

**Interfaces:**
- Produces: `useMetadataStore().forget(itemIds: readonly string[]): void`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("forget", () => {
  it("cancels a pending autosave so nothing is written after a batch delete", async () => {
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    vi.useFakeTimers();
    try {
      store.setFieldValue("i1", "title", "Typed just before the delete");
      store.forget(["i1"]);
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }

    expect(writeMirror).not.toHaveBeenCalled();
    expect(store.getValues("i1")).toEqual({});
    expect(store.loadedItems.has("i1")).toBe(false);
  });

  it("re-reads the item from disk on its next load", async () => {
    mirrors.set("i1", {
      backendId: null,
      version: null,
      targetState: null,
      visibilityStatus: null,
      metadata: { title: "Before the batch", collectionType: 0 },
      syncedAt: "2026-09-29T00:00:00.000Z",
    });
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    store.setFieldValue("i1", "title", "Changed in the batch");

    store.forget(["i1"]);
    await store.ensureItemLoaded(item());

    expect(store.plainValues("i1").title).toBe("Before the batch");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/stores/useMetadata.test.ts`
Expected: FAIL — `store.forget is not a function`.

- [ ] **Step 3: Implement** — in `useMetadata.ts`, after `reloadMirrors`:

```ts
  /**
   * Drop everything held for `itemIds` — values, mirrors and, above all, any
   * pending autosave. Called before a batch delete: an autosave landing after
   * the folders were restored would write the deleted batch's edits straight
   * back into them. The next `ensureItemLoaded` re-reads each item from disk.
   */
  function forget(itemIds: readonly string[]): void {
    const ids = new Set(itemIds);
    for (const id of ids) {
      const timer = saveTimers.get(id);
      if (timer) clearTimeout(timer);
      saveTimers.delete(id);
      mirrors.delete(id);
      knownItems.delete(id);
      loadPromises.delete(id);
    }
    const keep = <T>(map: Map<string, T>) => new Map([...map].filter(([id]) => !ids.has(id)));
    const keepSet = (set: Set<string>) => new Set([...set].filter((id) => !ids.has(id)));
    values.value = keep(values.value);
    backendStates.value = keep(backendStates.value);
    touched.value = keepSet(touched.value);
    loadedItems.value = keepSet(loadedItems.value);
    loadingItems.value = keepSet(loadingItems.value);
    saving.value = keepSet(saving.value);
  }
```

and add `forget,` to the returned object (under `// values`).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/stores/useMetadata.test.ts`
Expected: pass.

---

### Task 9: `useDeleteBatch` composable

**Files:**
- Create: `src/composables/useDeleteBatch.ts`
- Test: `src/composables/useDeleteBatch.test.ts`

**Interfaces:**
- Consumes: store `previewDelete`, `remove`, `get` (Task 6); `forget` (Task 8); `useUploadStore().clearResults`; `useToastsStore().push`.
- Produces: `toDeletePlanView(plan, no)`, `useDeleteBatch({ onDeleted? })` → `{ open, loading, deleting, error, plan, canConfirm, request(id), cancel(), confirm() }`; view types `DeleteBatchPlanView`, `DeleteBatchItemView`, `DeleteBatchFileView`.

- [ ] **Step 1: Write the failing tests** — `src/composables/useDeleteBatch.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { newBatchFields, type Batch, type BatchDeletePlan } from "@domain/batch";
import { emptyStages, ItemState, type Item } from "@domain/item";
import { useBatchesStore } from "@stores/useBatches";
import { useMetadataStore } from "@stores/useMetadata";
import { useUploadStore } from "@stores/useUpload";
import { toDeletePlanView, useDeleteBatch } from "./useDeleteBatch";

function makeBatch(over: Partial<Batch> = {}): Batch {
  return {
    ...newBatchFields({ type: ItemState.ToProcess, itemIds: ["i1", "i2"] }),
    id: "b1",
    no: 3,
    createdAt: "2026-09-29T00:00:00.000Z",
    archivedAt: null,
    backendTouchedAt: null,
    ...over,
  };
}

function makeItem(over: Partial<Item> = {}): Item {
  return {
    id: "i1",
    folderName: "BOOK",
    folderPath: "/scanned/BOOK",
    relativePath: "BOOK",
    hidden: false,
    root: "unprocessed",
    assets: [],
    stages: emptyStages(),
    flags: { uploaded: false, reupload: false, reuploadTextOnly: false },
    backendId: null,
    batchId: null,
    title: null,
    catalogueId: null,
    createdAt: null,
    updatedAt: null,
    syncMissStreak: 0,
    ...over,
  };
}

function makePlan(over: Partial<BatchDeletePlan> = {}): BatchDeletePlan {
  return {
    batchId: "b1",
    hasSnapshot: true,
    blockedReason: null,
    items: [
      {
        itemId: "i1",
        folderName: "BOOK",
        before: makeItem(),
        remove: [
          { path: "BOOK.pdf", generated: true },
          { path: "notes.docx", generated: false },
        ],
        restore: ["metadata.json"],
        error: null,
      },
      {
        itemId: "i2",
        folderName: "MAP",
        before: makeItem({
          id: "i2",
          folderName: "MAP",
          flags: { uploaded: true, reupload: false, reuploadTextOnly: false },
        }),
        remove: [],
        restore: [],
        error: null,
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("toDeletePlanView", () => {
  it("names the state each item returns to and flags hand-added files", () => {
    const view = toDeletePlanView(makePlan(), 3);

    expect(view.label).toBe("Batch #003");
    expect(view.legacy).toBe(false);
    expect(view.handAddedCount).toBe(1);
    expect(view.items[0].returnsTo).toBe("To process");
    expect(view.items[0].remove).toEqual([
      { path: "BOOK.pdf", handAdded: false },
      { path: "notes.docx", handAdded: true },
    ]);
    expect(view.items[1].returnsTo).toBe("Uploaded");
    expect(view.items[1].unchanged).toBe(true);
  });

  it("marks a batch without snapshots as legacy", () => {
    expect(toDeletePlanView(makePlan({ hasSnapshot: false }), 1).legacy).toBe(true);
  });
});

describe("useDeleteBatch", () => {
  function setup(onDeleted = vi.fn()) {
    const batches = useBatchesStore();
    batches.batches = [makeBatch()];
    vi.spyOn(batches, "previewDelete").mockResolvedValue(makePlan());
    const del = useDeleteBatch({ onDeleted });
    return { batches, del, onDeleted };
  }

  it("loads the dry run when opened", async () => {
    const { del } = setup();

    await del.request("b1");

    expect(del.open.value).toBe(true);
    expect(del.plan.value?.label).toBe("Batch #003");
    expect(del.canConfirm.value).toBe(true);
  });

  it("can't confirm a blocked batch", async () => {
    const { batches, del } = setup();
    vi.mocked(batches.previewDelete).mockResolvedValueOnce(
      makePlan({ blockedReason: "Uploaded batches can't be deleted." }),
    );

    await del.request("b1");

    expect(del.canConfirm.value).toBe(false);
  });

  it("stops pending autosaves before deleting, then cleans up and closes", async () => {
    const { batches, del, onDeleted } = setup();
    const calls: string[] = [];
    vi.spyOn(useMetadataStore(), "forget").mockImplementation((ids) => {
      calls.push(`forget:${ids.join(",")}`);
    });
    vi.spyOn(batches, "remove").mockImplementation(async () => {
      calls.push("remove");
    });
    const clearResults = vi.spyOn(useUploadStore(), "clearResults");

    await del.request("b1");
    await del.confirm();

    expect(calls).toEqual(["forget:i1,i2", "remove"]);
    expect(clearResults).toHaveBeenCalledWith("b1");
    expect(onDeleted).toHaveBeenCalledWith("b1");
    expect(del.open.value).toBe(false);
  });

  it("keeps the dialog open with the reason when the delete fails", async () => {
    const { batches, del, onDeleted } = setup();
    vi.spyOn(batches, "remove").mockRejectedValue("Couldn't put back BOOK (file in use).");

    await del.request("b1");
    await del.confirm();

    expect(del.open.value).toBe(true);
    expect(del.error.value).toBe("Couldn't put back BOOK (file in use).");
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/composables/useDeleteBatch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/composables/useDeleteBatch.ts`:

```ts
/**
 * `useDeleteBatch` — the delete-batch confirmation, shared by the Batches list
 * and the batch workspace (docs/superpowers/specs/2026-09-29-delete-batch-design.md).
 *
 * `request(id)` opens the dialog and loads the native dry run; `confirm()`
 * deletes. The delete itself is native — every member's folder and index state
 * go back to their pre-batch snapshot. What only this side can do is stop the
 * members' pending metadata autosaves first (one landing after the restore
 * would write the deleted batch's edits back) and drop the batch's upload
 * results after.
 */

import { computed, ref } from "vue";
import { useBatchesStore } from "@stores/useBatches";
import { useMetadataStore } from "@stores/useMetadata";
import { useUploadStore } from "@stores/useUpload";
import { useToastsStore } from "@stores/useToasts";
import { batchLabel, type BatchDeletePlan } from "@domain/batch";
import { ITEM_STATE_LABELS, deriveItemState } from "@domain/item";
import { logger } from "@lib/logger";

/** One file the delete removes. */
export interface DeleteBatchFileView {
  path: string;
  /** Not named like any of the app's outputs — someone added it by hand. */
  handAdded: boolean;
}

/** One member in the confirmation. */
export interface DeleteBatchItemView {
  id: string;
  name: string;
  /** The state it returns to ("To process", "Uploaded", …), when known. */
  returnsTo: string | null;
  remove: DeleteBatchFileView[];
  restore: string[];
  /** Nothing to remove or put back. */
  unchanged: boolean;
  error: string | null;
}

/** The confirmation's content. */
export interface DeleteBatchPlanView {
  batchId: string;
  /** "Batch #003". */
  label: string;
  /** Made before snapshots: deleting only unlocks its items. */
  legacy: boolean;
  blockedReason: string | null;
  items: DeleteBatchItemView[];
  itemCount: number;
  handAddedCount: number;
}

export function toDeletePlanView(plan: BatchDeletePlan, no: number | null): DeleteBatchPlanView {
  const items = plan.items.map((item) => {
    const remove = item.remove.map((f) => ({ path: f.path, handAdded: !f.generated }));
    return {
      id: item.itemId,
      name: item.folderName,
      returnsTo: item.before ? ITEM_STATE_LABELS[deriveItemState(item.before)] : null,
      remove,
      restore: [...item.restore],
      unchanged: remove.length === 0 && item.restore.length === 0 && item.error == null,
      error: item.error,
    };
  });
  return {
    batchId: plan.batchId,
    label: no != null ? batchLabel(no) : "this batch",
    legacy: !plan.hasSnapshot,
    blockedReason: plan.blockedReason,
    items,
    itemCount: items.length,
    handAddedCount: items.reduce((n, i) => n + i.remove.filter((f) => f.handAdded).length, 0),
  };
}

/** Tauri rejects with the native error as a plain string. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "Something went wrong.";
}

export function useDeleteBatch(options: { onDeleted?: (batchId: string) => void } = {}) {
  const batches = useBatchesStore();
  const metadata = useMetadataStore();
  const upload = useUploadStore();
  const toasts = useToastsStore();

  const open = ref(false);
  const loading = ref(false);
  const deleting = ref(false);
  const error = ref<string | null>(null);
  const plan = ref<DeleteBatchPlanView | null>(null);

  /** Delete is possible: the dry run loaded, nothing blocks it, and every
   * member's folder could be compared with its snapshot. */
  const canConfirm = computed(
    () =>
      open.value &&
      !loading.value &&
      !deleting.value &&
      plan.value != null &&
      plan.value.blockedReason == null &&
      plan.value.items.every((i) => i.error == null),
  );

  async function request(batchId: string): Promise<void> {
    open.value = true;
    loading.value = true;
    error.value = null;
    plan.value = null;
    try {
      const preview = await batches.previewDelete(batchId);
      plan.value = toDeletePlanView(preview, batches.get(batchId)?.no ?? null);
    } catch (err) {
      error.value = `Couldn't check what this batch changed: ${messageOf(err)}`;
      logger.error("batches", "Delete preview failed.", err);
    } finally {
      loading.value = false;
    }
  }

  function cancel(): void {
    if (deleting.value) return;
    open.value = false;
    plan.value = null;
    error.value = null;
  }

  async function confirm(): Promise<void> {
    const current = plan.value;
    if (!current || !canConfirm.value) return;
    const memberIds = batches.get(current.batchId)?.itemIds ?? current.items.map((i) => i.id);
    deleting.value = true;
    error.value = null;
    metadata.forget(memberIds);
    try {
      await batches.remove(current.batchId);
    } catch (err) {
      error.value = messageOf(err);
      logger.error("batches", "Batch delete failed.", err);
      deleting.value = false;
      return;
    }
    upload.clearResults(current.batchId);
    deleting.value = false;
    open.value = false;
    plan.value = null;
    toasts.push(
      current.legacy
        ? `${current.label} deleted — its items are unlocked.`
        : `${current.label} deleted — its items are back as they were.`,
      "success",
    );
    options.onDeleted?.(current.batchId);
  }

  return { open, loading, deleting, error, plan, canConfirm, request, cancel, confirm };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/composables/useDeleteBatch.test.ts`
Expected: pass.

---

### Task 10: UI — dialog, card button, workspace button

**Files:**
- Create: `src/components/batch/DeleteBatchDialog.vue`
- Modify: `src/components/batch/BatchCard.vue`, `src/views/BatchesView.vue`, `src/views/BatchWorkView.vue`, `src/composables/useBatches.ts`, `src/composables/useBatch.ts`

**Interfaces:**
- Consumes: `useDeleteBatch` (Task 9), `deleteBlockedReason` (Task 6).
- Produces: `BatchCardView.deleteBlocked: string | null`, `BatchHeaderView.deleteBlocked: string | null`; `BatchCard` emits `delete: [id]`.

- [ ] **Step 1: View-models**

`composables/useBatches.ts`: `BatchCardView` gains

```ts
  /** Why the card's delete button is disabled, or null when it isn't. */
  deleteBlocked: string | null;
```

`toCard(batch, uploadingId: string | null)` sets `deleteBlocked: deleteBlockedReason(batch, { uploading: batch.id === uploadingId })`; `cards` becomes `unfinished.value.map((b) => toCard(b, uploadingId.value))` with `const { activeBatchId: uploadingId } = storeToRefs(useUploadStore());`.

`composables/useBatch.ts`: `BatchHeaderView` gains the same `deleteBlocked` field; in `header`, `deleteBlocked: deleteBlockedReason(b, { uploading: upload.activeBatchId === b.id })` with `const upload = useUploadStore();`.

- [ ] **Step 2: Dialog** — `src/components/batch/DeleteBatchDialog.vue`:

```vue
<script setup lang="ts">
import type { DeleteBatchPlanView } from "@composables/useDeleteBatch";
import Spinner from "@ui/common/Spinner.vue";

defineProps<{
  open: boolean;
  loading: boolean;
  deleting: boolean;
  canConfirm: boolean;
  error: string | null;
  plan: DeleteBatchPlanView | null;
}>();

defineEmits<{ cancel: []; confirm: [] }>();
</script>

<template>
  <!-- Delete batch: every member goes back to its pre-batch snapshot. Lists
       what will be removed and put back first, flagging any file the app
       didn't make, because this can't be undone. -->
  <div v-if="open" class="backdrop" @click.self="!deleting && $emit('cancel')">
    <div class="panel" role="dialog" aria-modal="true">
      <div class="head">
        <span>{{ plan ? `Delete ${plan.label}?` : "Delete batch?" }}</span>
        <button class="x" title="Cancel" :disabled="deleting" @click="$emit('cancel')">✕</button>
      </div>

      <div class="body">
        <div v-if="loading" class="muted checking">
          <Spinner :size="12" /> Checking what this batch changed…
        </div>
        <template v-else-if="plan">
          <p v-if="plan.blockedReason" class="blocked">{{ plan.blockedReason }}</p>
          <template v-else>
            <p v-if="plan.legacy" class="lead">
              This batch was made before batches could be undone, so its folders
              can't be put back. Deleting it only unlocks its
              {{ plan.itemCount }} {{ plan.itemCount === 1 ? "item" : "items" }};
              any files it created stay where they are.
            </p>
            <p v-else class="lead">
              Every item goes back to exactly how it was before this batch.
              <b>This can't be undone.</b>
            </p>
            <p v-if="plan.handAddedCount > 0" class="warn">
              {{ plan.handAddedCount }}
              {{ plan.handAddedCount === 1 ? "file wasn't" : "files weren't" }}
              made by the app and will be deleted too — marked below.
            </p>
            <div class="items">
              <div v-for="item in plan.items" :key="item.id" class="item">
                <div class="item-head">
                  <span class="item-name">{{ item.name }}</span>
                  <span v-if="item.returnsTo" class="returns">→ {{ item.returnsTo }}</span>
                </div>
                <div v-if="item.error" class="item-error">{{ item.error }}</div>
                <div v-else-if="item.unchanged && !plan.legacy" class="muted">No file changes.</div>
                <template v-else>
                  <div v-if="item.remove.length > 0" class="group">
                    <div class="group-label">Removed</div>
                    <div
                      v-for="f in item.remove"
                      :key="f.path"
                      class="file"
                      :class="{ hand: f.handAdded }"
                    >
                      <span class="mono">{{ f.path }}</span>
                      <span v-if="f.handAdded" class="tag">not made by the app</span>
                    </div>
                  </div>
                  <div v-if="item.restore.length > 0" class="group">
                    <div class="group-label">Put back</div>
                    <div v-for="p in item.restore" :key="p" class="file">
                      <span class="mono">{{ p }}</span>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </template>
        </template>
        <div v-if="error" class="error">✗ {{ error }}</div>
      </div>

      <div class="actions">
        <button class="cancel" :disabled="deleting" @click="$emit('cancel')">Cancel</button>
        <button class="confirm" :disabled="!canConfirm" @click="$emit('confirm')">
          <Spinner v-if="deleting" :size="11" />
          {{ deleting ? "Deleting…" : "Delete batch" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Same shell as the Close-batch confirm in ProcessingTab.vue (styles are
   scoped per file, so it is repeated rather than imported). */
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(20, 22, 34, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
  animation: fadein 0.12s;
}

.panel {
  width: 560px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 96px);
  display: flex;
  flex-direction: column;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: 14px;
  box-shadow: var(--shadow-menu);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--c-border-row);
  font-weight: 600;
  font-size: 13.5px;
  color: var(--c-text-strong);
}

.x {
  width: 26px;
  height: 26px;
  border-radius: var(--r-sm);
  color: #9aa1bb;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}

.lead,
.blocked,
.warn {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--c-text-strong);
}

.blocked {
  color: var(--c-text-muted);
}

.warn {
  padding: 10px 12px;
  border: 1px solid var(--c-danger-border);
  border-radius: var(--r-md);
  background: var(--c-danger-bg);
  color: var(--c-danger-deep);
  font-size: 13px;
}

.muted {
  font-size: 12.5px;
  color: var(--c-text-muted);
}

.checking {
  display: flex;
  align-items: center;
  gap: 8px;
}

.items {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.item {
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  padding: 10px 12px;
  background: var(--c-surface-input);
}

.item-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}

.item-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--c-text-strong);
}

.returns {
  font-size: 12px;
  color: var(--c-text-muted);
}

.item-error {
  font-size: 12.5px;
  color: var(--c-danger-text);
}

.group + .group {
  margin-top: 6px;
}

.group-label {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--c-text-faint);
  margin-bottom: 2px;
}

.file {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--c-text-mid);
}

.file.hand {
  color: var(--c-danger-text);
  font-weight: 600;
}

.mono {
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: var(--r-xs);
  border: 1px solid var(--c-danger-border);
  background: var(--c-danger-bg);
}

.error {
  font-size: 13px;
  color: var(--c-danger-deep);
  background: var(--c-danger-bg);
  border: 1px solid var(--c-danger-border);
  border-radius: var(--r-md);
  padding: 10px 12px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
  padding: 13px 16px;
  border-top: 1px solid var(--c-border-row);
}

.cancel,
.confirm {
  height: 34px;
  padding: 0 14px;
  border-radius: var(--r-md);
  font-weight: 600;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.cancel {
  border: 1px solid var(--c-border);
  background: var(--c-surface);
  color: var(--c-text-muted);
}

.confirm {
  border: 1px solid var(--c-danger-border);
  background: #fdf0ee;
  color: var(--c-danger-text);
}

.confirm:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
```

- [ ] **Step 3: Card button** — `BatchCard.vue`: emits `{ open: [id: string]; delete: [id: string] }`; after the `created` span:

```vue
      <!-- The wrapper carries the tooltip (a disabled button gets no hover)
           and stops the click from opening the card. -->
      <span class="delete-wrap" :title="card.deleteBlocked ?? 'Delete batch'" @click.stop>
        <button
          class="delete-btn"
          :disabled="card.deleteBlocked != null"
          aria-label="Delete batch"
          @click="$emit('delete', card.id)"
        >
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M3.5 5.5h13M8 5.5V4h4v1.5M5.5 5.5l.8 11h7.4l.8-11M8.5 8.5v5M11.5 8.5v5" />
          </svg>
        </button>
      </span>
```

with styles:

```css
.delete-wrap {
  display: inline-flex;
}

.delete-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--r-sm);
  color: #9aa1bb;
  display: flex;
  align-items: center;
  justify-content: center;
}

.delete-btn:hover:not(:disabled) {
  background: var(--c-danger-bg);
  color: var(--c-danger-text);
}

.delete-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
```

- [ ] **Step 4: Screens**

`BatchesView.vue`:

```ts
import { useBatches } from "@composables/useBatches";
import { useDeleteBatch } from "@composables/useDeleteBatch";
import BatchCard from "@ui/batch/BatchCard.vue";
import DeleteBatchDialog from "@ui/batch/DeleteBatchDialog.vue";

const { cards, isEmpty, loading, error, open, newFromOverview } = useBatches();
const {
  open: deleteOpen,
  loading: deleteLoading,
  deleting,
  error: deleteError,
  plan: deletePlan,
  canConfirm,
  request: requestDelete,
  cancel: cancelDelete,
  confirm: confirmDelete,
} = useDeleteBatch();
```

Card: `@delete="requestDelete"`; after the grid:

```vue
    <DeleteBatchDialog
      :open="deleteOpen"
      :loading="deleteLoading"
      :deleting="deleting"
      :can-confirm="canConfirm"
      :error="deleteError"
      :plan="deletePlan"
      @cancel="cancelDelete()"
      @confirm="confirmDelete()"
    />
```

`BatchWorkView.vue`: the same destructuring with `useDeleteBatch({ onDeleted: () => back() })`, the same dialog at the end of `.workspace`, and in `.head-row` after the `saved` div:

```vue
        <span
          v-if="header"
          class="delete-wrap"
          :title="header.deleteBlocked ?? 'Delete this batch and put its items back as they were'"
        >
          <button
            class="delete-btn"
            :disabled="header.deleteBlocked != null"
            @click="requestDelete(header.id)"
          >
            Delete batch
          </button>
        </span>
```

with styles:

```css
.delete-wrap {
  display: inline-flex;
  flex: none;
}

.delete-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: var(--r-md);
  border: 1px solid var(--c-danger-border);
  background: var(--c-surface);
  color: var(--c-danger-text);
  font-weight: 600;
  font-size: 12.5px;
}

.delete-btn:hover:not(:disabled) {
  background: var(--c-danger-bg);
}

.delete-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
```

- [ ] **Step 5: Create-batch busy state** — creating a batch now snapshots every member, which is a copy (not a link) on a volume that can't hard-link. `useOverview` gets `const creatingBatch = ref(false)`, set around the `batches.create` call in `createBatchFor` (`try … finally`), returned as `creatingBatch`; `createBatchFor` returns early while it is true. `OverviewView.vue`'s Create batch button: `:disabled="!canCreateBatch || creatingBatch"` and text `{{ creatingBatch ? "Creating…" : "Create batch" }}` (keeping the glyph).

- [ ] **Step 6: Verify**

Run: `npx vitest run` and `npx vue-tsc --noEmit`
Expected: all pass; typecheck clean.

---

### Task 11: Docs and full verification

**Files:**
- Modify: `docs/tasks/03-batches-and-lifecycle.md`, `docs/01-concept-and-ux.md`, `docs/superpowers/specs/2026-09-29-delete-batch-design.md`

- [ ] **Step 1: Docs**
  - `docs/01-concept-and-ux.md` §Batches & lifecycle: add a **Deletable until it reaches the backend** bullet (delete puts every member back from its pre-batch snapshot; blocked once the upload's first backend write is about to happen; Close batch remains the way out after that).
  - `docs/tasks/03-batches-and-lifecycle.md` Rules: same bullet; Arch section: list `batch_delete_preview`, `batch_delete`, `batch_mark_backend_touched`, and that `batch_create`/`batch_archive` take/drop snapshots.
  - Spec: correct the storage columns (`item_row`, `item_dto`), that the composable (not the store) calls `useMetadata.forget` / `useUpload.clearResults`, and that `useProcessing` holds nothing batch-keyed to clear.

- [ ] **Step 2: Full verification**

Run: `npx vitest run`, `npx vue-tsc --noEmit`, and in `src-tauri`: `cargo test`, `cargo clippy --all-targets`
Expected: everything green.
