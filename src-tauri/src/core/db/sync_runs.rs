//! Sync-run history — the Sync screen's four stat tiles and its recent-runs log.
//!
//! Persisted rather than kept in memory so the tiles and log survive a
//! relaunch. Local-only, like batches. The history is capped on append
//! ([`super::SYNC_RUN_HISTORY_LIMIT`]): this is an operator-facing recent-runs
//! list, not an audit trail, and an uncapped table would grow forever for a
//! screen that shows the newest handful.

use rusqlite::{params, Connection, Row};

use crate::dto::{SyncRunCreateDto, SyncRunDto, SyncRunStatus, SyncTrigger};
use crate::error::{AppError, Result};

/// Persist a finished run and return the stored row with its assigned id.
pub fn append(conn: &Connection, run: &SyncRunCreateDto) -> Result<SyncRunDto> {
    let id = uuid::Uuid::new_v4().to_string();

    conn.execute(
        "INSERT INTO sync_runs \
           (id, started_at, finished_at, status, trigger_kind, checked, updated, \
            up_to_date, missed, summary, detail) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            id,
            run.started_at,
            run.finished_at,
            run.status.as_str(),
            run.trigger.as_str(),
            run.checked,
            run.updated,
            run.up_to_date,
            run.missed,
            run.summary,
            run.detail,
        ],
    )?;

    prune(conn)?;

    // Built from the payload rather than read back. A re-read would have to
    // cope with this very row having just been pruned — appending a run older
    // than everything already retained is legitimate (a late-reported run) and
    // must not fail the caller. What we return is exactly what was written.
    Ok(SyncRunDto {
        id,
        started_at: run.started_at.clone(),
        finished_at: run.finished_at.clone(),
        status: run.status,
        trigger: run.trigger,
        checked: run.checked,
        updated: run.updated,
        up_to_date: run.up_to_date,
        missed: run.missed,
        summary: run.summary.clone(),
        detail: run.detail.clone(),
    })
}

/// Drop everything past the retention limit, oldest first.
fn prune(conn: &Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM sync_runs WHERE id NOT IN ( \
           SELECT id FROM sync_runs ORDER BY started_at DESC, rowid DESC LIMIT ?1 \
         )",
        params![super::SYNC_RUN_HISTORY_LIMIT],
    )?;
    Ok(())
}

/// The most recent runs, newest first.
pub fn list(conn: &Connection, limit: Option<i64>) -> Result<Vec<SyncRunDto>> {
    // A caller's limit is honoured but never allowed to exceed what we retain.
    let effective = limit
        .filter(|n| *n > 0)
        .unwrap_or(super::SYNC_RUN_HISTORY_LIMIT)
        .min(super::SYNC_RUN_HISTORY_LIMIT);

    let mut stmt =
        conn.prepare("SELECT * FROM sync_runs ORDER BY started_at DESC, rowid DESC LIMIT ?1")?;
    let rows = stmt.query_map(params![effective], |row| Ok(from_row(row)))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row??);
    }
    Ok(out)
}

fn from_row(row: &Row) -> Result<SyncRunDto> {
    let status: String = row.get("status")?;
    let trigger: String = row.get("trigger_kind")?;

    Ok(SyncRunDto {
        id: row.get("id")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        status: SyncRunStatus::parse(&status)
            .ok_or_else(|| AppError::Other(format!("unknown sync status {status:?}")))?,
        trigger: SyncTrigger::parse(&trigger)
            .ok_or_else(|| AppError::Other(format!("unknown sync trigger {trigger:?}")))?,
        checked: row.get("checked")?,
        updated: row.get("updated")?,
        up_to_date: row.get("up_to_date")?,
        missed: row.get("missed")?,
        summary: row.get("summary")?,
        detail: row.get("detail")?,
    })
}
