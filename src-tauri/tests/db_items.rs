//! Item-index behaviour.
//!
//! The tests that matter most here are the `record_sync` ones. Sync is a
//! *read*, and every way of getting it wrong is silent — the item still
//! renders, just in a state the operator did not put it in.

mod common;

use common::*;
use nbcg_dc_lib::core::db::{items, Db};
use nbcg_dc_lib::dto::*;

fn db_with(folders: &[nbcg_dc_lib::core::fs::DiscoveredFolder]) -> Db {
    let db = Db::open_in_memory().expect("open");
    db.with(|c| items::reconcile(c, folders))
        .expect("reconcile");
    db
}

#[test]
fn reconcile_inserts_discovered_folders() {
    let db = db_with(&[folder("BOOK A", ScanRoot::Unprocessed)]);
    let all = db.with(items::list).expect("list");

    assert_eq!(all.len(), 1);
    assert_eq!(all[0].folder_name, "BOOK A");
    assert_eq!(all[0].root, ScanRoot::Unprocessed);
    assert!(!all[0].uploaded);
    assert!(!all[0].reupload);
    assert_eq!(all[0].miss_streak, Some(0));
    // Stages are absent rather than defaulted — the TS side reads that as pending.
    assert!(all[0].stages.is_empty());
}

#[test]
fn reconcile_refreshes_the_asset_list() {
    let mut f = folder("BOOK", ScanRoot::Unprocessed);
    f.assets = vec![asset("1.jpg", 100), asset("2.jpg", 200)];
    let db = db_with(&[f.clone()]);

    assert_eq!(db.with(items::list).unwrap()[0].assets.len(), 2);

    // A page was deleted on disk; the index must follow.
    f.assets = vec![asset("1.jpg", 100)];
    db.with(|c| items::reconcile(c, &[f])).unwrap();

    let assets = &db.with(items::list).unwrap()[0].assets;
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].filename, "1.jpg");
}

#[test]
fn reconcile_preserves_state_a_scan_does_not_own() {
    let f = folder("BOOK", ScanRoot::Unprocessed);
    let db = db_with(std::slice::from_ref(&f));
    let id = f.id.clone();

    // Simulate work having happened: an upload, a re-upload flag, a stage, a
    // batch claim and a sync miss streak.
    db.with(|c| {
        items::record_upload(
            c,
            &id,
            &UploadRecordDto {
                backend_id: "backend-1".into(),
                version: Some(4),
                target_state: ItemType::Record,
                visibility_status: VisibilityStatus::Public,
            },
        )?;
        items::set_stage(c, &id, StageName::Ocr, StageStatus::Failed, Some("boom"))?;
        c.execute(
            "UPDATE items SET reupload = 1, batch_id = 'b1', miss_streak = 2 WHERE id = ?1",
            [&id],
        )?;
        Ok(())
    })
    .unwrap();

    // Rescanning the same folder must not disturb any of it.
    db.with(|c| items::reconcile(c, &[f])).unwrap();

    let item = db.with(|c| items::get(c, &id)).unwrap();
    assert!(item.uploaded, "scan cleared the uploaded flag");
    assert!(item.reupload, "scan cleared the re-upload flag");
    assert_eq!(
        item.batch_id.as_deref(),
        Some("b1"),
        "scan released the batch claim"
    );
    assert_eq!(item.miss_streak, Some(2), "scan reset the miss streak");
    assert_eq!(item.backend_id.as_deref(), Some("backend-1"));
    assert_eq!(
        item.stages.get(&StageName::Ocr).map(|s| s.status),
        Some(StageStatus::Failed),
        "scan wiped a recorded stage",
    );
}

#[test]
fn reconcile_never_overwrites_a_live_backend_connection() {
    let f = folder("BOOK", ScanRoot::Unprocessed);
    let db = db_with(std::slice::from_ref(&f));
    let id = f.id.clone();

    db.with(|c| {
        items::record_upload(
            c,
            &id,
            &UploadRecordDto {
                backend_id: "live-id".into(),
                version: Some(1),
                target_state: ItemType::Draft,
                visibility_status: VisibilityStatus::Private,
            },
        )
    })
    .unwrap();

    // A stale mirror on disk claims a different record.
    let mut stale = f.clone();
    stale.backend_id = Some("stale-id".into());
    db.with(|c| items::reconcile(c, &[stale])).unwrap();

    assert_eq!(
        db.with(|c| items::get(c, &id))
            .unwrap()
            .backend_id
            .as_deref(),
        Some("live-id"),
    );
}

#[test]
fn reconcile_adopts_a_backend_id_when_the_row_has_none() {
    let mut f = folder("BOOK", ScanRoot::Unprocessed);
    f.backend_id = Some("from-mirror".into());
    let db = db_with(&[f.clone()]);

    assert_eq!(
        db.with(|c| items::get(c, &f.id))
            .unwrap()
            .backend_id
            .as_deref(),
        Some("from-mirror"),
    );
}

#[test]
fn reconcile_drops_folders_that_disappeared() {
    let a = folder("A", ScanRoot::Unprocessed);
    let b = folder("B", ScanRoot::Unprocessed);
    let db = db_with(&[a.clone(), b.clone()]);
    assert_eq!(db.with(items::list).unwrap().len(), 2);

    db.with(|c| items::reconcile(c, &[a])).unwrap();

    let all = db.with(items::list).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].folder_name, "A");
}

#[test]
fn reconcile_follows_a_folder_across_roots() {
    let mut f = folder("BOOK", ScanRoot::Unprocessed);
    let db = db_with(&[f.clone()]);

    f.root = ScanRoot::Processed;
    f.folder_path = "/roots/processed/BOOK".into();
    db.with(|c| items::reconcile(c, &[f.clone()])).unwrap();

    let item = db.with(|c| items::get(c, &f.id)).unwrap();
    assert_eq!(item.root, ScanRoot::Processed);
    assert_eq!(item.folder_path, "/roots/processed/BOOK");
    // Identity is keyed on the name, so the move did not mint a new item.
    assert_eq!(db.with(items::list).unwrap().len(), 1);
}

// ─── record_upload ───────────────────────────────────────────────────────────

#[test]
fn record_upload_connects_and_clears_the_reupload_flag() {
    let f = folder("BOOK", ScanRoot::Unprocessed);
    let db = db_with(std::slice::from_ref(&f));
    db.with(|c| {
        c.execute("UPDATE items SET reupload = 1", [])
            .map(|_| ())
            .map_err(Into::into)
    })
    .unwrap();

    let updated = db
        .with(|c| {
            items::record_upload(
                c,
                &f.id,
                &UploadRecordDto {
                    backend_id: "rec-9".into(),
                    version: Some(7),
                    target_state: ItemType::Record,
                    visibility_status: VisibilityStatus::Hidden,
                },
            )
        })
        .unwrap();

    assert_eq!(updated.backend_id.as_deref(), Some("rec-9"));
    assert!(updated.uploaded);
    assert!(
        !updated.reupload,
        "a successful upload must clear the dirty flag"
    );
    assert_eq!(
        updated.stages.get(&StageName::Upload).map(|s| s.status),
        Some(StageStatus::Done),
    );
}

#[test]
fn record_upload_on_an_unknown_item_is_not_found() {
    let db = Db::open_in_memory().unwrap();
    let err = db.with(|c| {
        items::record_upload(
            c,
            "nope",
            &UploadRecordDto {
                backend_id: "x".into(),
                version: None,
                target_state: ItemType::Draft,
                visibility_status: VisibilityStatus::Public,
            },
        )
    });
    assert!(matches!(
        err,
        Err(nbcg_dc_lib::error::AppError::NotFound(_))
    ));
}

// ─── record_sync — the read-only path ────────────────────────────────────────

fn sync(version: Option<i64>, miss_streak: i64) -> SyncRecordDto {
    SyncRecordDto {
        version,
        target_state: None,
        visibility_status: None,
        title: None,
        miss_streak,
        synced_at: "2026-08-12T12:00:00.000Z".into(),
    }
}

#[test]
fn record_sync_does_not_touch_uploaded_reupload_or_stages() {
    let f = folder("BOOK", ScanRoot::Unprocessed);
    let db = db_with(std::slice::from_ref(&f));
    let id = f.id.clone();

    // An uploaded item the operator has since dirtied: it reads as "Needs
    // re-upload". A sync must leave it that way.
    db.with(|c| {
        items::record_upload(
            c,
            &id,
            &UploadRecordDto {
                backend_id: "rec-1".into(),
                version: Some(2),
                target_state: ItemType::Record,
                visibility_status: VisibilityStatus::Public,
            },
        )?;
        c.execute("UPDATE items SET reupload = 1 WHERE id = ?1", [&id])?;
        items::set_stage(
            c,
            &id,
            StageName::Pdf,
            StageStatus::Failed,
            Some("bad scan"),
        )?;
        Ok(())
    })
    .unwrap();

    let after = db
        .with(|c| items::record_sync(c, &id, &sync(Some(5), 0)))
        .unwrap();

    assert!(after.uploaded, "sync changed `uploaded`");
    assert!(
        after.reupload,
        "sync cleared a pending re-upload — the edit would never be pushed",
    );
    assert_eq!(
        after.stages.get(&StageName::Pdf).map(|s| s.status),
        Some(StageStatus::Failed),
        "sync overwrote a stage status",
    );
    // It *should* have folded in the backend facts. The stored version is not
    // on the DTO (deliberately — the folder mirror owns it), so read the row.
    let stored_version = db
        .with(|c| Ok(items::backend_facts(c, &id)?.version))
        .unwrap();
    assert_eq!(stored_version, Some(5));
}

#[test]
fn record_sync_null_version_leaves_the_stored_one_alone() {
    let f = folder("BOOK", ScanRoot::Unprocessed);
    let db = db_with(std::slice::from_ref(&f));
    let id = f.id.clone();

    db.with(|c| {
        items::record_upload(
            c,
            &id,
            &UploadRecordDto {
                backend_id: "rec-1".into(),
                version: Some(11),
                target_state: ItemType::Record,
                visibility_status: VisibilityStatus::Public,
            },
        )
    })
    .unwrap();

    // A CDC-lagged or ambiguous read reports no version.
    db.with(|c| items::record_sync(c, &id, &sync(None, 0)))
        .unwrap();

    let stored = db
        .with(|c| Ok(items::backend_facts(c, &id)?.version))
        .unwrap();
    assert_eq!(
        stored,
        Some(11),
        "a null version cleared the stored one — the next PATCH would have no expectedVersion",
    );
}

#[test]
fn record_sync_null_fields_leave_target_state_visibility_and_title_alone() {
    let f = connected_folder("BOOK", "rec-1");
    let db = db_with(std::slice::from_ref(&f));
    let id = f.id.clone();

    db.with(|c| {
        items::record_upload(
            c,
            &id,
            &UploadRecordDto {
                backend_id: "rec-1".into(),
                version: Some(1),
                target_state: ItemType::Record,
                visibility_status: VisibilityStatus::Hidden,
            },
        )
    })
    .unwrap();

    let after = db
        .with(|c| items::record_sync(c, &id, &sync(Some(2), 0)))
        .unwrap();

    assert_eq!(after.title.as_deref(), Some("BOOK title"));
    let facts = db.with(|c| items::backend_facts(c, &id)).unwrap();
    assert_eq!(facts.target_state, Some(ItemType::Record));
    assert_eq!(facts.visibility_status, Some(VisibilityStatus::Hidden));
}

#[test]
fn record_sync_applies_the_values_it_is_given() {
    let f = connected_folder("BOOK", "rec-1");
    let db = db_with(std::slice::from_ref(&f));

    let after = db
        .with(|c| {
            items::record_sync(
                c,
                &f.id,
                &SyncRecordDto {
                    version: Some(9),
                    target_state: Some(ItemType::Draft),
                    visibility_status: Some(VisibilityStatus::Private),
                    title: Some("Renamed on the website".into()),
                    miss_streak: 0,
                    synced_at: "2026-08-12T12:00:00.000Z".into(),
                },
            )
        })
        .unwrap();

    assert_eq!(after.title.as_deref(), Some("Renamed on the website"));
    let facts = db.with(|c| items::backend_facts(c, &f.id)).unwrap();
    assert_eq!(facts.version, Some(9));
    assert_eq!(facts.target_state, Some(ItemType::Draft));
    assert_eq!(facts.visibility_status, Some(VisibilityStatus::Private));
}

#[test]
fn record_sync_stores_the_miss_streak_verbatim_including_a_reset() {
    let f = folder("BOOK", ScanRoot::Unprocessed);
    let db = db_with(std::slice::from_ref(&f));

    let missed = db
        .with(|c| items::record_sync(c, &f.id, &sync(None, 3)))
        .unwrap();
    assert_eq!(missed.miss_streak, Some(3));

    // The record reappeared — the logic lane resets the counter to 0 and the
    // index must accept that, not treat 0 as "unchanged".
    let found = db
        .with(|c| items::record_sync(c, &f.id, &sync(None, 0)))
        .unwrap();
    assert_eq!(found.miss_streak, Some(0));
}

// ─── rebuild ─────────────────────────────────────────────────────────────────

#[test]
fn rebuild_reconstructs_stages_from_derived_files() {
    let db = Db::open_in_memory().unwrap();
    let mut f = connected_folder("BOOK", "rec-7");
    f.derived.web_pdf = true;
    f.derived.thumbnail = true;
    f.derived.ocr_text = false;

    db.with(|c| items::rebuild(c, &[f.clone()])).unwrap();
    let item = db.with(|c| items::get(c, &f.id)).unwrap();

    assert_eq!(
        item.stages.get(&StageName::Pdf).map(|s| s.status),
        Some(StageStatus::Done),
    );
    assert_eq!(
        item.stages.get(&StageName::Thumbnail).map(|s| s.status),
        Some(StageStatus::Done),
    );
    // A missing output is left unrecorded, never inferred as failed.
    assert!(!item.stages.contains_key(&StageName::Ocr));
    // A connected mirror means it was uploaded.
    assert!(item.uploaded);
    assert_eq!(
        item.stages.get(&StageName::Upload).map(|s| s.status),
        Some(StageStatus::Done),
    );
}

#[test]
fn rebuild_leaves_an_unconnected_item_unuploaded() {
    let db = Db::open_in_memory().unwrap();
    let f = folder("BOOK", ScanRoot::Unprocessed);

    db.with(|c| items::rebuild(c, std::slice::from_ref(&f)))
        .unwrap();
    let item = db.with(|c| items::get(c, &f.id)).unwrap();

    assert!(!item.uploaded);
    assert!(!item.stages.contains_key(&StageName::Upload));
}

#[test]
fn rebuild_reproduces_the_same_ids_so_batches_still_resolve() {
    let db = Db::open_in_memory().unwrap();
    let f = folder("BOOK", ScanRoot::Unprocessed);
    db.with(|c| items::reconcile(c, std::slice::from_ref(&f)))
        .unwrap();
    let before = db.with(items::list).unwrap()[0].id.clone();

    db.with(|c| items::rebuild(c, &[f])).unwrap();
    let after = db.with(items::list).unwrap()[0].id.clone();

    assert_eq!(
        before, after,
        "a rebuild that re-mints ids would silently empty every batch",
    );
}

#[test]
fn get_on_an_unknown_item_is_not_found() {
    let db = Db::open_in_memory().unwrap();
    assert!(matches!(
        db.with(|c| items::get(c, "missing")),
        Err(nbcg_dc_lib::error::AppError::NotFound(_)),
    ));
}
