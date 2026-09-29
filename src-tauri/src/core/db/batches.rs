//! Batch persistence — the operator's local working sets.
//!
//! Batches are **local-only** and never sent to the backend (docs/03). They
//! live here because they are the one piece of state with nowhere else to go:
//! a batch is a grouping the operator invented, so no folder and no backend
//! record describes it.
//!
//! `parents`, `overrides` and `proc` are stored as JSON columns rather than
//! child tables. They are always read and written as a whole batch, are never
//! queried across batches, and map 1:1 to the DTO — so normalising them would
//! buy joins nobody performs at the cost of four more tables to keep in step.
//! `item_ids` *is* a child table (`batch_items`), because membership has an
//! order and is joined against `items`.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::dto::{
    BatchCreateDto, BatchDto, BatchItemOverride, BatchParentRef, BatchStage, ItemRunStatus,
    ItemState, ItemType, VisibilityStatus,
};
use crate::error::{AppError, Result};

use super::{now_iso, snapshots};

/// Every batch, finished and unfinished — the store filters for display.
/// Newest first, which is the order the Batches list wants.
pub fn list(conn: &Connection) -> Result<Vec<BatchDto>> {
    let mut stmt = conn.prepare("SELECT id FROM batches ORDER BY batch_no DESC")?;
    let ids: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<_, _>>()?;
    ids.iter().map(|id| get(conn, id)).collect()
}

/// Read one batch by id.
pub fn get(conn: &Connection, batch_id: &str) -> Result<BatchDto> {
    let mut stmt = conn.prepare("SELECT * FROM batches WHERE id = ?1")?;
    let dto = stmt
        .query_row(params![batch_id], |row| Ok(from_row(row)))
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("batch {batch_id}")))?;

    let mut dto = dto?;
    dto.item_ids = member_ids(conn, batch_id)?;
    Ok(dto)
}

fn from_row(row: &Row) -> Result<BatchDto> {
    let item_type: String = row.get("item_type")?;
    let stage: String = row.get("stage")?;
    let publish: String = row.get("publish")?;
    let visibility: String = row.get("visibility")?;
    let parents: String = row.get("parents")?;
    let overrides: String = row.get("overrides")?;
    let proc: String = row.get("proc")?;

    let unknown =
        |field: &str, value: &str| AppError::Other(format!("batch has unknown {field} {value:?}"));

    Ok(BatchDto {
        id: row.get("id")?,
        no: row.get("batch_no")?,
        created_at: row.get("created_at")?,
        item_type: ItemState::parse(&item_type).ok_or_else(|| unknown("type", &item_type))?,
        item_ids: Vec::new(),
        stage: BatchStage::parse(&stage).ok_or_else(|| unknown("stage", &stage))?,
        running: row.get::<_, i64>("running")? != 0,
        proc: serde_json::from_str::<HashMap<String, ItemRunStatus>>(&proc)?,
        cobiss_id: row.get("cobiss_id")?,
        parents: serde_json::from_str::<Vec<BatchParentRef>>(&parents)?,
        publish: ItemType::parse(&publish).ok_or_else(|| unknown("publish", &publish))?,
        visibility: VisibilityStatus::parse(&visibility)
            .ok_or_else(|| unknown("visibility", &visibility))?,
        overrides: serde_json::from_str::<HashMap<String, BatchItemOverride>>(&overrides)?,
        archived_at: row.get("archived_at")?,
        backend_touched_at: row.get("backend_touched_at")?,
    })
}

fn member_ids(conn: &Connection, batch_id: &str) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT item_id FROM batch_items WHERE batch_id = ?1 ORDER BY position")?;
    let rows = stmt.query_map(params![batch_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn write_members(conn: &Connection, batch_id: &str, item_ids: &[String]) -> Result<()> {
    conn.execute(
        "DELETE FROM batch_items WHERE batch_id = ?1",
        params![batch_id],
    )?;
    let mut stmt =
        conn.prepare("INSERT INTO batch_items (batch_id, item_id, position) VALUES (?1, ?2, ?3)")?;
    for (position, item_id) in item_ids.iter().enumerate() {
        stmt.execute(params![batch_id, item_id, position as i64])?;
    }
    Ok(())
}

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

/// Create a batch: persist the row, assign the running `no`, and stamp
/// `batch_id` onto every member item.
///
/// **Must run inside a transaction** — the caller passes one. The three writes
/// are a single fact: a batch whose row exists but whose items were not stamped
/// leaves those items readable as unbatched (so selectable into a *second*
/// batch), and the running number would be consumed by a batch nobody can see.
///
/// The number comes from [`next_batch_no`], so it is never reused.
pub fn create(conn: &Connection, fields: &BatchCreateDto) -> Result<BatchDto> {
    create_with_id(conn, &uuid::Uuid::new_v4().to_string(), fields)
}

/// [`create`] with a caller-chosen id — `core::batch_lifecycle` needs the id
/// before the row exists, to name the snapshot folders it takes first.
pub fn create_with_id(conn: &Connection, id: &str, fields: &BatchCreateDto) -> Result<BatchDto> {
    let created_at = now_iso();
    let next_no = next_batch_no(conn)?;

    conn.execute(
        "INSERT INTO batches \
           (id, batch_no, created_at, item_type, stage, running, cobiss_id, publish, \
            visibility, parents, overrides, proc, archived_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL)",
        params![
            id,
            next_no,
            created_at,
            fields.item_type.as_str(),
            fields.stage.as_str(),
            fields.running as i64,
            fields.cobiss_id,
            fields.publish.as_str(),
            fields.visibility.as_str(),
            serde_json::to_string(&fields.parents)?,
            serde_json::to_string(&fields.overrides)?,
            serde_json::to_string(&fields.proc)?,
        ],
    )?;

    write_members(conn, id, &fields.item_ids)?;
    stamp_items(conn, id, &fields.item_ids)?;

    get(conn, id)
}

fn stamp_items(conn: &Connection, batch_id: &str, item_ids: &[String]) -> Result<()> {
    let now = now_iso();
    let mut stmt = conn.prepare("UPDATE items SET batch_id = ?2, updated_at = ?3 WHERE id = ?1")?;
    for item_id in item_ids {
        stmt.execute(params![item_id, batch_id, now])?;
    }
    Ok(())
}

/// Persist a whole batch (write-through for stage/running/proc/parents/…).
///
/// Membership is rewritten too, and item stamping is re-applied so an item
/// added to an existing batch gets its `batch_id`. Items *removed* from the
/// batch are released, otherwise they would stay locked as In progress with no
/// batch claiming them.
///
/// `backend_touched_at` is never written here — see [`mark_backend_touched`].
pub fn update(conn: &Connection, batch: &BatchDto) -> Result<BatchDto> {
    let previous = member_ids(conn, &batch.id)?;
    if !exists(conn, &batch.id)? {
        return Err(AppError::NotFound(format!("batch {}", batch.id)));
    }

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

    conn.execute(
        "UPDATE batches SET \
           item_type = ?2, stage = ?3, running = ?4, cobiss_id = ?5, publish = ?6, \
           visibility = ?7, parents = ?8, overrides = ?9, proc = ?10, archived_at = ?11 \
         WHERE id = ?1",
        params![
            batch.id,
            batch.item_type.as_str(),
            batch.stage.as_str(),
            batch.running as i64,
            batch.cobiss_id,
            batch.publish.as_str(),
            batch.visibility.as_str(),
            serde_json::to_string(&batch.parents)?,
            serde_json::to_string(&batch.overrides)?,
            serde_json::to_string(&batch.proc)?,
            batch.archived_at,
        ],
    )?;

    write_members(conn, &batch.id, &batch.item_ids)?;
    stamp_items(conn, &batch.id, &batch.item_ids)?;

    for gone in previous.iter().filter(|id| !batch.item_ids.contains(id)) {
        release_item(conn, &batch.id, gone)?;
        snapshots::delete_one(conn, &batch.id, gone)?;
    }

    get(conn, &batch.id)
}

fn release_item(conn: &Connection, batch_id: &str, item_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE items SET batch_id = NULL, updated_at = ?3 \
         WHERE id = ?1 AND batch_id = ?2",
        params![item_id, batch_id, now_iso()],
    )?;
    Ok(())
}

/// True when a batch row exists.
pub fn exists(conn: &Connection, batch_id: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM batches WHERE id = ?1",
        params![batch_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Archive an uploaded batch and **release** its items.
///
/// Clearing `batch_id` is what moves the items out of In progress — their
/// derived state then falls through to Uploaded. The batch row is kept (the
/// list shows finished batches), marked `uploaded` and stamped `archived_at`.
///
/// The release is scoped to items still pointing at *this* batch, so an item
/// that has since been claimed elsewhere is left alone.
///
/// Its snapshot rows go too: an archived batch can't be deleted, so they would
/// only hold state (`core::batch_lifecycle::archive` removes the folders).
pub fn archive(conn: &Connection, batch_id: &str) -> Result<BatchDto> {
    if !exists(conn, batch_id)? {
        return Err(AppError::NotFound(format!("batch {batch_id}")));
    }

    let now = now_iso();
    conn.execute(
        "UPDATE batches SET stage = ?2, running = 0, archived_at = ?3 WHERE id = ?1",
        params![batch_id, BatchStage::Uploaded.as_str(), now],
    )?;
    conn.execute(
        "UPDATE items SET batch_id = NULL, updated_at = ?2 WHERE batch_id = ?1",
        params![batch_id, now],
    )?;
    conn.execute(
        "DELETE FROM batch_snapshots WHERE batch_id = ?1",
        params![batch_id],
    )?;

    get(conn, batch_id)
}

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
    conn.execute(
        "DELETE FROM batch_snapshots WHERE batch_id = ?1",
        params![batch_id],
    )?;
    conn.execute(
        "DELETE FROM batch_items WHERE batch_id = ?1",
        params![batch_id],
    )?;
    conn.execute("DELETE FROM batches WHERE id = ?1", params![batch_id])?;
    Ok(())
}
