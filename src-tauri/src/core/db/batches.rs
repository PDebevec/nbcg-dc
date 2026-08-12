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

use super::now_iso;

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

/// Create a batch: persist the row, assign the running `no`, and stamp
/// `batch_id` onto every member item.
///
/// **Must run inside a transaction** — the caller passes one. The three writes
/// are a single fact: a batch whose row exists but whose items were not stamped
/// leaves those items readable as unbatched (so selectable into a *second*
/// batch), and the running number would be consumed by a batch nobody can see.
///
/// The number comes from `MAX(batch_no) + 1` over *all* rows including archived
/// ones, so numbers are never reused — the operator refers to batches by number
/// and a recycled one would point at two different things.
pub fn create(conn: &Connection, fields: &BatchCreateDto) -> Result<BatchDto> {
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = now_iso();
    let next_no: i64 = conn.query_row(
        "SELECT COALESCE(MAX(batch_no), 0) + 1 FROM batches",
        [],
        |r| r.get(0),
    )?;

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

    write_members(conn, &id, &fields.item_ids)?;
    stamp_items(conn, &id, &fields.item_ids)?;

    get(conn, &id)
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
pub fn update(conn: &Connection, batch: &BatchDto) -> Result<BatchDto> {
    let previous = member_ids(conn, &batch.id)?;
    if !exists(conn, &batch.id)? {
        return Err(AppError::NotFound(format!("batch {}", batch.id)));
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

    get(conn, batch_id)
}
