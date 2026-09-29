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

/// The distinct `<root>/.nbcg-snapshots/<batch>` folders holding these item
/// snapshots.
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
            eprintln!(
                "[nbcg-dc] couldn't remove the snapshot at {}: {e}",
                dir.display()
            );
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
    match snapshot::diff(
        Path::new(&row.item.folder_path),
        Path::new(&row.snapshot_dir),
    ) {
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
        for id in batch
            .item_ids
            .iter()
            .filter(|id| !snapshotted.contains(id.as_str()))
        {
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
                    folder_name: before
                        .as_ref()
                        .map_or_else(|| id.clone(), |i| i.folder_name.clone()),
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
    let (batch, rows) =
        db.with(|c| Ok((batches::get(c, batch_id)?, snapshots::list(c, batch_id)?)))?;
    if let Some(reason) = delete_blocked_reason(&batch, running) {
        return Err(AppError::Invalid(reason.to_string()));
    }

    let failures: Vec<String> = rows
        .iter()
        .filter_map(|row| {
            snapshot::restore(
                Path::new(&row.item.folder_path),
                Path::new(&row.snapshot_dir),
            )
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
