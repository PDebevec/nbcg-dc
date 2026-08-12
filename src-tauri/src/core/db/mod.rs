//! The local SQLite index.
//!
//! This is a **local index only** — never authoritative catalogue data. The
//! `nbcg` backend is the single source of truth; everything here is a tracker
//! for local work (which folders exist, how far each got through the pipeline,
//! which backend record it connected to) plus two pieces of purely local
//! working state that have nowhere else to live: **batches** and the
//! **sync-run history**.
//!
//! Because it is disposable, `rebuild` must be able to reconstruct the whole
//! thing from the folders alone — see [`items::rebuild`].

pub mod batches;
pub mod items;
pub mod sync_runs;

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::Result;

/// The schema version stored in `PRAGMA user_version`. Bump it and add a step
/// to [`migrate`] when the schema changes.
const SCHEMA_VERSION: i64 = 1;

/// How many sync runs to retain. The Sync screen shows a recent-runs log, not
/// an audit trail, so old rows are pruned on append.
pub const SYNC_RUN_HISTORY_LIMIT: i64 = 100;

/// The index handle. Held as Tauri managed state.
///
/// A single connection behind a `Mutex` rather than a pool: this is a
/// single-user desktop app whose write pattern is a burst per scan, and a
/// pooled writer would just multiply SQLITE_BUSY surface for no throughput
/// gain.
pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Open (creating if needed) the index at `path` and run migrations.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    /// An in-memory index — used by the test suite.
    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        // WAL survives a hard kill mid-write far better than the rollback
        // journal, which matters because the app is force-quit routinely.
        // `foreign_keys` is OFF by default in SQLite and we rely on the
        // ON DELETE CASCADEs, so it must be enabled per connection.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&conn)?;
        Ok(Db {
            conn: Mutex::new(conn),
        })
    }

    /// Run `f` with the connection locked.
    ///
    /// A poisoned mutex means another thread panicked mid-query. We recover the
    /// guard rather than propagating the panic: the connection itself is still
    /// usable (any half-finished transaction was rolled back when its guard
    /// dropped), and taking the app down over it would lose the operator's
    /// unsaved batch work.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let guard = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        f(&guard)
    }

    /// Run `f` inside a transaction, committing on `Ok` and rolling back on
    /// `Err`. Used wherever a write spans more than one table — notably
    /// `batch_create`, which must assign the running number *and* stamp
    /// `batch_id` onto every member item as one atomic step.
    pub fn transaction<T>(&self, f: impl FnOnce(&rusqlite::Transaction) -> Result<T>) -> Result<T> {
        let mut guard = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let tx = guard.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }
}

/// Create the schema and step it forward.
///
/// Column naming note: `no`, `type`, and `trigger` are all SQLite keywords or
/// near-keywords, so the columns are `batch_no`, `item_type`, and
/// `trigger_kind`. The DTO field names are unchanged — the mapping happens in
/// the query layer.
fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;

    if version < 1 {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS items (
                id                TEXT PRIMARY KEY,
                folder_name       TEXT NOT NULL,
                folder_path       TEXT NOT NULL UNIQUE,
                root              TEXT NOT NULL,
                level             TEXT,
                uploaded          INTEGER NOT NULL DEFAULT 0,
                reupload          INTEGER NOT NULL DEFAULT 0,
                backend_id        TEXT,
                version           INTEGER,
                target_state      TEXT,
                visibility_status TEXT,
                batch_id          TEXT,
                title             TEXT,
                cobiss_id         TEXT,
                miss_streak       INTEGER NOT NULL DEFAULT 0,
                synced_at         TEXT,
                created_at        TEXT NOT NULL,
                updated_at        TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS item_stages (
                item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                stage      TEXT NOT NULL,
                status     TEXT NOT NULL,
                error      TEXT,
                updated_at TEXT,
                PRIMARY KEY (item_id, stage)
            );

            CREATE TABLE IF NOT EXISTS item_assets (
                item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                filename   TEXT NOT NULL,
                path       TEXT NOT NULL,
                size_bytes INTEGER,
                PRIMARY KEY (item_id, filename)
            );

            CREATE TABLE IF NOT EXISTS batches (
                id          TEXT PRIMARY KEY,
                batch_no    INTEGER NOT NULL UNIQUE,
                created_at  TEXT NOT NULL,
                item_type   TEXT NOT NULL,
                stage       TEXT NOT NULL,
                running     INTEGER NOT NULL DEFAULT 0,
                cobiss_id   TEXT,
                publish     TEXT NOT NULL,
                visibility  TEXT NOT NULL,
                parents     TEXT NOT NULL DEFAULT '[]',
                overrides   TEXT NOT NULL DEFAULT '{}',
                proc        TEXT NOT NULL DEFAULT '{}',
                archived_at TEXT
            );

            CREATE TABLE IF NOT EXISTS batch_items (
                batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
                item_id  TEXT NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY (batch_id, item_id)
            );

            CREATE TABLE IF NOT EXISTS sync_runs (
                id           TEXT PRIMARY KEY,
                started_at   TEXT NOT NULL,
                finished_at  TEXT NOT NULL,
                status       TEXT NOT NULL,
                trigger_kind TEXT NOT NULL,
                checked      INTEGER NOT NULL,
                updated      INTEGER NOT NULL,
                up_to_date   INTEGER NOT NULL,
                missed       INTEGER NOT NULL,
                summary      TEXT NOT NULL,
                detail       TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_items_batch    ON items(batch_id);
            CREATE INDEX IF NOT EXISTS idx_items_root     ON items(root);
            CREATE INDEX IF NOT EXISTS idx_batch_items    ON batch_items(batch_id, position);
            CREATE INDEX IF NOT EXISTS idx_sync_runs_time ON sync_runs(started_at DESC);
            "#,
        )?;
    }

    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

/// `now` as an ISO-8601 UTC timestamp with a `Z` suffix.
///
/// The `Z` is deliberate and load-bearing: the backend's own indexed copies
/// drop it (see PROJECT-KNOWLEDGE — `SearchHit.source` timestamps parse as
/// *local* time in JS because of exactly that omission), and the logic lane
/// feeds these strings straight to `Date.parse`. Emitting a bare local
/// timestamp here would reintroduce the same offset-sized skew locally.
pub fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_and_migrates() {
        let db = Db::open_in_memory().expect("open");
        let version: i64 = db
            .with(|c| Ok(c.pragma_query_value(None, "user_version", |r| r.get(0))?))
            .expect("version");
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn migrate_is_idempotent() {
        let db = Db::open_in_memory().expect("open");
        // Running it a second time on the same connection must not error.
        db.with(migrate).expect("second migrate");
    }

    #[test]
    fn now_iso_is_utc_with_z_suffix() {
        let ts = now_iso();
        assert!(ts.ends_with('Z'), "expected a Z suffix, got {ts}");
        // Must round-trip through the same parser the logic lane uses.
        assert!(chrono::DateTime::parse_from_rfc3339(&ts).is_ok());
    }
}
