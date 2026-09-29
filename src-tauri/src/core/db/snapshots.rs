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
pub fn insert(
    conn: &Connection,
    batch_id: &str,
    state: &IndexState,
    snapshot_dir: &str,
) -> Result<()> {
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

/// Ids of the batches that hold snapshots — the ones whose snapshot folders a
/// sweep must keep.
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
        conn.execute(
            &format!("UPDATE items SET {set} WHERE id = ?1"),
            params_from_iter(bound),
        )?;
    } else {
        let columns = std::iter::once("\"id\"".to_string())
            .chain(values.iter().map(|(c, _)| format!("\"{c}\"")))
            .collect::<Vec<_>>();
        let placeholders = (1..=columns.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>();
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

    conn.execute(
        "DELETE FROM item_stages WHERE item_id = ?1",
        params![row.item_id],
    )?;
    for (stage, s) in &row.item.stages {
        conn.execute(
            "INSERT INTO item_stages (item_id, stage, status, error, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                row.item_id,
                stage.as_str(),
                s.status.as_str(),
                s.error,
                s.updated_at
            ],
        )?;
    }
    conn.execute(
        "DELETE FROM item_assets WHERE item_id = ?1",
        params![row.item_id],
    )?;
    for a in &row.item.assets {
        conn.execute(
            "INSERT INTO item_assets (item_id, filename, path, size_bytes) \
             VALUES (?1, ?2, ?3, ?4)",
            params![row.item_id, a.filename, a.path, a.size_bytes],
        )?;
    }
    Ok(())
}
