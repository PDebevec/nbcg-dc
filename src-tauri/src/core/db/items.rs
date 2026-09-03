//! Item-index queries.
//!
//! Three write paths touch an item row and they are deliberately **not**
//! interchangeable:
//!
//! - [`reconcile`] — a scan. Filesystem facts only. Never touches
//!   `uploaded`/`reupload`/stages/`batch_id`/`miss_streak`.
//! - [`record_upload`] — a successful backend write. Sets the connection and
//!   flips the item to uploaded.
//! - [`record_sync`] — a backend *read*. Refreshes cached backend facts and
//!   must not move the item's derived state at all.
//!
//! Mixing them up is silent: the item still renders, just in the wrong state.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::core::fs::DiscoveredFolder;
use crate::dto::{
    IndexedAssetDto, IndexedItemDto, IndexedStageDto, ItemLevel, ItemType, RebuildDowngradeDto,
    ScanRoot, StageName, StageStatus, SyncRecordDto, UploadRecordDto, VisibilityStatus,
};
use crate::error::{AppError, Result};

use super::now_iso;

/// Read every tracked item, newest folder first is *not* imposed here — the
/// logic lane sorts for display. Ordered by folder name for a stable result.
pub fn list(conn: &Connection) -> Result<Vec<IndexedItemDto>> {
    let mut stmt = conn.prepare("SELECT * FROM items ORDER BY folder_name COLLATE NOCASE")?;
    let ids: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>("id"))?
        .collect::<std::result::Result<_, _>>()?;

    ids.iter().map(|id| get(conn, id)).collect()
}

/// Read one item by id.
pub fn get(conn: &Connection, item_id: &str) -> Result<IndexedItemDto> {
    let mut stmt = conn.prepare("SELECT * FROM items WHERE id = ?1")?;
    let dto = stmt
        .query_row(params![item_id], |row| Ok(base_from_row(row)))
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("item {item_id}")))?;

    let mut dto = dto?;
    dto.assets = assets_for(conn, item_id)?;
    dto.stages = stages_for(conn, item_id)?;
    Ok(dto)
}

/// True when an item row exists.
pub fn exists(conn: &Connection, item_id: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM items WHERE id = ?1",
        params![item_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

fn base_from_row(row: &Row) -> Result<IndexedItemDto> {
    let root_raw: String = row.get("root")?;
    let level_raw: Option<String> = row.get("level")?;
    Ok(IndexedItemDto {
        id: row.get("id")?,
        folder_name: row.get("folder_name")?,
        folder_path: row.get("folder_path")?,
        relative_path: row.get("relative_path")?,
        hidden: row.get::<_, Option<String>>("hidden_at")?.is_some(),
        root: ScanRoot::parse(&root_raw)
            .ok_or_else(|| AppError::Other(format!("unknown scan root {root_raw:?}")))?,
        level: level_raw.as_deref().and_then(ItemLevel::parse),
        assets: Vec::new(),
        stages: HashMap::new(),
        uploaded: row.get::<_, i64>("uploaded")? != 0,
        reupload: row.get::<_, i64>("reupload")? != 0,
        reupload_text_only: row.get::<_, i64>("reupload_text_only")? != 0,
        backend_id: row.get("backend_id")?,
        batch_id: row.get("batch_id")?,
        title: row.get("title")?,
        cobiss_id: row.get("cobiss_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        miss_streak: row.get("miss_streak")?,
    })
}

fn assets_for(conn: &Connection, item_id: &str) -> Result<Vec<IndexedAssetDto>> {
    let mut stmt = conn.prepare(
        "SELECT filename, path, size_bytes FROM item_assets WHERE item_id = ?1 \
         ORDER BY filename COLLATE NOCASE",
    )?;
    let rows = stmt.query_map(params![item_id], |row| {
        Ok(IndexedAssetDto {
            filename: row.get(0)?,
            path: row.get(1)?,
            size_bytes: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn stages_for(conn: &Connection, item_id: &str) -> Result<HashMap<StageName, IndexedStageDto>> {
    let mut stmt = conn
        .prepare("SELECT stage, status, error, updated_at FROM item_stages WHERE item_id = ?1")?;
    let rows = stmt.query_map(params![item_id], |row| {
        let stage: String = row.get(0)?;
        let status: String = row.get(1)?;
        let error: Option<String> = row.get(2)?;
        let updated_at: Option<String> = row.get(3)?;
        Ok((stage, status, error, updated_at))
    })?;

    let mut out = HashMap::new();
    for row in rows {
        let (stage, status, error, updated_at) = row?;
        // An unrecognised stage/status is stale data from an older schema.
        // Skipping it degrades to "pending" on the TS side, which is the safe
        // reading — far better than failing the whole item list.
        let (Some(stage), Some(status)) = (StageName::parse(&stage), StageStatus::parse(&status))
        else {
            continue;
        };
        out.insert(
            stage,
            IndexedStageDto {
                status,
                error,
                updated_at,
            },
        );
    }
    Ok(out)
}

/// Record one stage's outcome (used by rebuild now, and by the job runner in
/// Epic 06).
pub fn set_stage(
    conn: &Connection,
    item_id: &str,
    stage: StageName,
    status: StageStatus,
    error: Option<&str>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO item_stages (item_id, stage, status, error, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(item_id, stage) DO UPDATE SET \
           status = excluded.status, error = excluded.error, updated_at = excluded.updated_at",
        params![item_id, stage.as_str(), status.as_str(), error, now_iso()],
    )?;
    Ok(())
}

/// What a pending re-upload actually needs to push, per the `.rs`-side
/// stage(s) that produced new bytes on the reprocess pass that triggered it
/// (`core::jobs::ItemOutcome`). `Full` means a `pdf`/`thumbnail` stage ran —
/// `services/upload.ts` must replace the blob (and therefore resend its
/// paired text, or the backend wipes it — see `pushReplaceAssets`).
/// `TextOnly` means only `ocr` ran — the blob itself is unchanged, so a
/// cheap `PUT /files/:fileId/text` suffices.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReuploadKind {
    Full,
    TextOnly,
}

/// Flag an item **Needs re-upload** (Epic 06 job runner, `Reprocess` mode
/// only). The only writer of `reupload = 1` — `reconcile` never touches it
/// and `record_upload` only ever clears it back to `0` on a successful write.
///
/// `kind` is a per-*call* fact (what this reprocess pass changed), but
/// `reupload_text_only` has to reflect the whole *pending* window since the
/// last upload, not just this call — so it is never a plain assignment:
///
/// - `Full` always wins outright (`reupload_text_only = 0`), even over an
///   already-pending `TextOnly` — a later content change must never be
///   silently downgraded back to "text only," or the blob replace it needs
///   would get skipped.
/// - A second `TextOnly` call while one is already pending is a no-op on the
///   column (`reupload = 1` already, so it keeps whatever kind is already
///   stored) — it must not *un-set* a `Full` that a different, earlier call
///   in the same pending window already established.
/// - Only when `reupload` was `0` (nothing pending yet) does a `TextOnly`
///   call actually set the column to `1` — the first call in a fresh
///   pending window is the one that gets to decide its starting kind.
pub fn mark_needs_reupload(conn: &Connection, item_id: &str, kind: ReuploadKind) -> Result<()> {
    if !exists(conn, item_id)? {
        return Err(AppError::NotFound(format!("item {item_id}")));
    }

    let is_text_only = kind == ReuploadKind::TextOnly;
    conn.execute(
        "UPDATE items SET \
           reupload = 1, \
           reupload_text_only = CASE \
             WHEN NOT ?2 THEN 0 \
             WHEN reupload = 1 THEN reupload_text_only \
             ELSE 1 \
           END, \
           updated_at = ?3 \
         WHERE id = ?1",
        params![item_id, is_text_only, now_iso()],
    )?;
    Ok(())
}

/// Set (or clear) an item's hidden flag — the operator saying "this folder is
/// not a real record, stop showing it," never inferred automatically. The
/// only writer of `hidden_at`. Deliberately per-row only, no cascade to
/// descendants or ancestors: hiding a wrapper folder must not also hide the
/// real records nested under it (see
/// `docs/tasks/nested-record-folders-and-manual-selection.md`).
pub fn set_hidden(conn: &Connection, item_id: &str, hidden: bool) -> Result<()> {
    if !exists(conn, item_id)? {
        return Err(AppError::NotFound(format!("item {item_id}")));
    }
    let hidden_at = if hidden { Some(now_iso()) } else { None };
    conn.execute(
        "UPDATE items SET hidden_at = ?2 WHERE id = ?1",
        params![item_id, hidden_at],
    )?;
    Ok(())
}

fn replace_assets(conn: &Connection, item_id: &str, assets: &[IndexedAssetDto]) -> Result<()> {
    conn.execute(
        "DELETE FROM item_assets WHERE item_id = ?1",
        params![item_id],
    )?;
    let mut stmt = conn.prepare(
        "INSERT OR REPLACE INTO item_assets (item_id, filename, path, size_bytes) \
         VALUES (?1, ?2, ?3, ?4)",
    )?;
    for a in assets {
        stmt.execute(params![item_id, a.filename, a.path, a.size_bytes])?;
    }
    Ok(())
}

/// Fold a filesystem scan into the index.
///
/// Insert-or-update by folder identity, refresh the asset list, and drop items
/// whose folders have disappeared. What it deliberately does **not** touch on
/// an existing row: `uploaded`, `reupload`, every stage, `batch_id`,
/// `miss_streak`, `version`, `hidden_at`. Those are owned by the
/// upload/sync/batch/hide paths; a rescan is a filesystem observation and must
/// not move an item's state or discard operator intent. `relative_path` *is*
/// always overwritten here — unlike `hidden_at` it's filesystem-observed, not
/// operator intent (it changes if the folder itself moves).
///
/// `backend_id` is adopted from `metadata.json` only when the row has none —
/// so an index that lost a connection can recover it from the folder mirror,
/// but a live connection is never overwritten by a stale file.
pub fn reconcile(conn: &Connection, discovered: &[DiscoveredFolder]) -> Result<()> {
    let now = now_iso();

    for folder in discovered {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM items WHERE id = ?1",
                params![folder.id],
                |r| r.get(0),
            )
            .optional()?;

        if existing.is_some() {
            conn.execute(
                "UPDATE items SET \
                   folder_name = ?2, folder_path = ?3, relative_path = ?4, root = ?5, \
                   level      = COALESCE(?6, level), \
                   title      = COALESCE(?7, title), \
                   cobiss_id  = COALESCE(?8, cobiss_id), \
                   backend_id = COALESCE(backend_id, ?9), \
                   updated_at = ?10 \
                 WHERE id = ?1",
                params![
                    folder.id,
                    folder.folder_name,
                    folder.folder_path,
                    folder.relative_path,
                    folder.root.as_str(),
                    folder.level.map(|l| l.as_str()),
                    folder.title,
                    folder.cobiss_id,
                    folder.backend_id,
                    now,
                ],
            )?;
        } else {
            conn.execute(
                "INSERT INTO items \
                   (id, folder_name, folder_path, relative_path, root, level, uploaded, reupload, \
                    backend_id, version, target_state, visibility_status, batch_id, \
                    title, cobiss_id, miss_streak, synced_at, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7, ?8, ?9, ?10, NULL, ?11, ?12, 0, ?13, ?14, ?14)",
                params![
                    folder.id,
                    folder.folder_name,
                    folder.folder_path,
                    folder.relative_path,
                    folder.root.as_str(),
                    folder.level.map(|l| l.as_str()),
                    folder.backend_id,
                    folder.version,
                    folder.target_state.map(|t| t.as_str()),
                    folder.visibility_status.map(|v| v.as_str()),
                    folder.title,
                    folder.cobiss_id,
                    folder.synced_at,
                    now,
                ],
            )?;
        }

        replace_assets(conn, &folder.id, &folder.assets)?;
    }

    // Drop rows whose folders are gone.
    let seen: Vec<&str> = discovered.iter().map(|f| f.id.as_str()).collect();
    let mut stmt = conn.prepare("SELECT id FROM items")?;
    let all: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<_, _>>()?;
    for id in all {
        if !seen.contains(&id.as_str()) {
            conn.execute("DELETE FROM items WHERE id = ?1", params![id])?;
        }
    }

    Ok(())
}

/// Reconstruct the index from folders alone.
///
/// The recovery path for a lost or corrupt index (docs/02 §Per-item folder:
/// "folders should carry enough to rebuild the index"). Everything item-scoped
/// is dropped and re-derived from each folder's `metadata.json` plus the
/// presence of its derived files.
///
/// Two things survive because they are **not** derivable from a folder:
/// batches and the sync-run log. That is also why item ids are derived
/// deterministically from the folder name ([`crate::core::fs::item_id_for`]) —
/// a rebuild reproduces the same ids, so batch membership still resolves.
///
/// What is lost and cannot be otherwise: `reupload` (an operator intent with no
/// on-disk trace) and `miss_streak` (a counter, not a fact about the folder).
/// Both reset, which is the conservative direction — a re-upload flag lost
/// means an item reads as Uploaded until the next edit dirties it again.
///
/// `hidden_at` is the one operator-intent field that **does** survive —
/// snapshotted before the delete and re-applied after reinsert for any id
/// that still exists. Ids are reproducible across a rebuild (see
/// `item_id_for`'s doc comment), so matching the snapshot back up by id is
/// safe. Without this, hiding a folder would be undone by the next "Rebuild
/// index" click, which is a real click an operator will actually make.
pub fn rebuild(conn: &Connection, discovered: &[DiscoveredFolder]) -> Result<()> {
    let mut hidden_snapshot: HashMap<String, String> = HashMap::new();
    {
        let mut stmt =
            conn.prepare("SELECT id, hidden_at FROM items WHERE hidden_at IS NOT NULL")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, hidden_at) = row?;
            hidden_snapshot.insert(id, hidden_at);
        }
    }

    conn.execute("DELETE FROM items", [])?;

    let now = now_iso();
    for folder in discovered {
        conn.execute(
            "INSERT INTO items \
               (id, folder_name, folder_path, relative_path, root, level, uploaded, reupload, \
                backend_id, version, target_state, visibility_status, batch_id, \
                title, cobiss_id, miss_streak, synced_at, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?11, NULL, ?12, ?13, 0, ?14, ?15, ?15)",
            params![
                folder.id,
                folder.folder_name,
                folder.folder_path,
                folder.relative_path,
                folder.root.as_str(),
                folder.level.map(|l| l.as_str()),
                // An item with a connected backend id in its mirror has been
                // uploaded — that is the whole point of the mirror.
                folder.backend_id.is_some() as i64,
                folder.backend_id,
                folder.version,
                folder.target_state.map(|t| t.as_str()),
                folder.visibility_status.map(|v| v.as_str()),
                folder.title,
                folder.cobiss_id,
                folder.synced_at,
                now,
            ],
        )?;

        if let Some(hidden_at) = hidden_snapshot.get(&folder.id) {
            conn.execute(
                "UPDATE items SET hidden_at = ?2 WHERE id = ?1",
                params![folder.id, hidden_at],
            )?;
        }

        replace_assets(conn, &folder.id, &folder.assets)?;

        // Derived-file presence → stage status. Only ever marks stages `done`;
        // an absent output stays unrecorded, which the TS side reads as
        // `pending`. We never infer `failed` — a missing file is
        // indistinguishable from "never run", and claiming a failure would put
        // a red pip on an item nobody has touched.
        for (stage, present) in [
            (StageName::Pdf, folder.derived.web_pdf),
            (StageName::Thumbnail, folder.derived.thumbnail),
            (StageName::Ocr, folder.derived.ocr_text),
            (StageName::Upload, folder.backend_id.is_some()),
        ] {
            if present {
                set_stage(conn, &folder.id, stage, StageStatus::Done, None)?;
            }
        }
    }

    Ok(())
}

/// Dry-run [`rebuild`]: which currently-`uploaded` rows would lose that state
/// if `rebuild` ran against `discovered` right now. Read-only — makes no
/// writes. See [`RebuildDowngradeDto`] for why a row is flagged.
pub fn rebuild_impact(
    conn: &Connection,
    discovered: &[DiscoveredFolder],
) -> Result<Vec<RebuildDowngradeDto>> {
    let by_id: HashMap<&str, Option<&str>> = discovered
        .iter()
        .map(|f| (f.id.as_str(), f.backend_id.as_deref()))
        .collect();

    let mut stmt =
        conn.prepare("SELECT id, folder_name, backend_id FROM items WHERE uploaded = 1")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })?;

    let mut out = Vec::new();
    for row in rows {
        let (id, folder_name, backend_id) = row?;
        // Survives rebuild unscathed only when the fresh scan still finds
        // this exact folder AND its mirror still carries a backend id —
        // covering both ways `rebuild` can downgrade a row: a present but
        // mirror-less folder (`Some(None)`) and a folder that has vanished
        // from the scan entirely (`None`) both fail this check.
        let would_survive = matches!(by_id.get(id.as_str()), Some(Some(_)));
        if !would_survive {
            out.push(RebuildDowngradeDto {
                id,
                folder_name,
                backend_id: backend_id.unwrap_or_default(),
            });
        }
    }
    Ok(out)
}

/// Write through a successful backend create/replace (Epic 07).
///
/// Sets the connection, flips `uploaded` on, clears `reupload` (both the flag
/// and its `reupload_text_only` kind — a clean slate, not just the flag: the
/// next reprocess pass must decide the kind fresh, not inherit a stale one),
/// and marks the `upload` stage done.
pub fn record_upload(
    conn: &Connection,
    item_id: &str,
    upload: &UploadRecordDto,
) -> Result<IndexedItemDto> {
    if !exists(conn, item_id)? {
        return Err(AppError::NotFound(format!("item {item_id}")));
    }

    conn.execute(
        "UPDATE items SET \
           backend_id = ?2, version = ?3, target_state = ?4, visibility_status = ?5, \
           uploaded = 1, reupload = 0, reupload_text_only = 0, updated_at = ?6 \
         WHERE id = ?1",
        params![
            item_id,
            upload.backend_id,
            upload.version,
            upload.target_state.as_str(),
            upload.visibility_status.as_str(),
            now_iso(),
        ],
    )?;

    set_stage(conn, item_id, StageName::Upload, StageStatus::Done, None)?;
    get(conn, item_id)
}

/// Fold a backend **sync read** onto an item's row (Epic 08).
///
/// Read-only with respect to item state. This function must never write
/// `uploaded`, `reupload`, or any stage — see [`SyncRecordDto`] for why. Every
/// nullable field means "leave unchanged" when null, which is what the
/// `COALESCE(?, column)` pattern below encodes; in particular a null `version`
/// must not clear the stored one, because that value gates the next
/// `PATCH expectedVersion` and clearing it would break the following re-upload.
///
/// `miss_streak` is **not** coalesced — it is non-optional in the DTO and the
/// logic lane owns its value, including resetting it to `0` on a hit.
pub fn record_sync(
    conn: &Connection,
    item_id: &str,
    sync: &SyncRecordDto,
) -> Result<IndexedItemDto> {
    if !exists(conn, item_id)? {
        return Err(AppError::NotFound(format!("item {item_id}")));
    }

    conn.execute(
        "UPDATE items SET \
           version           = COALESCE(?2, version), \
           target_state      = COALESCE(?3, target_state), \
           visibility_status = COALESCE(?4, visibility_status), \
           title             = COALESCE(?5, title), \
           miss_streak       = ?6, \
           synced_at         = ?7, \
           updated_at        = ?8 \
         WHERE id = ?1",
        params![
            item_id,
            sync.version,
            sync.target_state.map(|t| t.as_str()),
            sync.visibility_status.map(|v| v.as_str()),
            sync.title,
            sync.miss_streak,
            sync.synced_at,
            now_iso(),
        ],
    )?;

    get(conn, item_id)
}

/// Relocate an item to the other scan root (the Epic 07 "reposition").
pub fn set_location(
    conn: &Connection,
    item_id: &str,
    root: ScanRoot,
    folder_path: &str,
) -> Result<IndexedItemDto> {
    if !exists(conn, item_id)? {
        return Err(AppError::NotFound(format!("item {item_id}")));
    }
    conn.execute(
        "UPDATE items SET root = ?2, folder_path = ?3, updated_at = ?4 WHERE id = ?1",
        params![item_id, root.as_str(), folder_path, now_iso()],
    )?;
    get(conn, item_id)
}

/// The backend facts cached on an item's row.
///
/// Kept off [`IndexedItemDto`] deliberately: the authoritative `version` lives
/// in the folder's `metadata.json` mirror, which is where `services/upload`
/// reads it for `PATCH expectedVersion`. One source of truth. These are the
/// index's copy, for callers that have a row but not the folder.
#[derive(Debug, Clone, PartialEq)]
pub struct BackendFacts {
    pub backend_id: Option<String>,
    pub version: Option<i64>,
    pub target_state: Option<ItemType>,
    pub visibility_status: Option<VisibilityStatus>,
}

/// Read the cached backend facts for one item.
pub fn backend_facts(conn: &Connection, item_id: &str) -> Result<BackendFacts> {
    let mut stmt = conn.prepare(
        "SELECT backend_id, version, target_state, visibility_status FROM items WHERE id = ?1",
    )?;
    stmt.query_row(params![item_id], |row| {
        let target: Option<String> = row.get(2)?;
        let vis: Option<String> = row.get(3)?;
        Ok(BackendFacts {
            backend_id: row.get(0)?,
            version: row.get(1)?,
            target_state: target.as_deref().and_then(ItemType::parse),
            visibility_status: vis.as_deref().and_then(VisibilityStatus::parse),
        })
    })
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("item {item_id}")))
}
