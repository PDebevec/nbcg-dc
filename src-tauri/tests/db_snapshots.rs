//! `batch_snapshots`: an item's index state from before its batch, and
//! putting it back.

mod common;

use common::*;
use nbcg_dc_lib::core::db::items::ReuploadKind;
use nbcg_dc_lib::core::db::{batches, items, snapshots, Db};
use nbcg_dc_lib::core::fs::{item_id_for, DiscoveredFolder};
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

fn db_with(folders: Vec<DiscoveredFolder>) -> Db {
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

    let row = db
        .with(|c| snapshots::list(c, &batch.id))
        .unwrap()
        .remove(0);
    db.transaction(|t| snapshots::restore_index(t, &row))
        .unwrap();

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

    let row = db
        .with(|c| snapshots::list(c, &batch.id))
        .unwrap()
        .remove(0);
    db.transaction(|t| snapshots::restore_index(t, &row))
        .unwrap();

    assert_eq!(db.with(|c| items::get(c, &a)).unwrap(), before);
}

#[test]
fn restore_index_leaves_a_claim_by_another_batch_alone() {
    let db = db_with(vec![folder("A", ScanRoot::Unprocessed)]);
    let a = item_id_for("A");
    let first = snapshotted_batch(&db, &[&a]);
    // The item has since been claimed by a newer batch.
    let second = db
        .transaction(|t| batches::create(t, &batch_over(&[&a])))
        .unwrap();

    let row = db
        .with(|c| snapshots::list(c, &first.id))
        .unwrap()
        .remove(0);
    db.transaction(|t| snapshots::restore_index(t, &row))
        .unwrap();

    assert_eq!(
        db.with(|c| items::get(c, &a)).unwrap().batch_id.as_deref(),
        Some(second.id.as_str()),
    );
}

#[test]
fn update_refuses_a_new_member_that_has_no_snapshot() {
    let db = db_with(vec![
        folder("A", ScanRoot::Unprocessed),
        folder("B", ScanRoot::Unprocessed),
    ]);
    let (a, b) = (item_id_for("A"), item_id_for("B"));
    let mut batch = snapshotted_batch(&db, &[&a]);

    batch.item_ids.push(b.clone());
    let refused = db.transaction(|t| batches::update(t, &batch));

    assert!(matches!(refused, Err(AppError::Invalid(_))));
    assert_eq!(db.with(|c| items::get(c, &b)).unwrap().batch_id, None);
}

#[test]
fn update_drops_the_snapshot_of_a_member_it_removes() {
    let db = db_with(vec![
        folder("A", ScanRoot::Unprocessed),
        folder("B", ScanRoot::Unprocessed),
    ]);
    let (a, b) = (item_id_for("A"), item_id_for("B"));
    let mut batch = snapshotted_batch(&db, &[&a, &b]);

    batch.item_ids = vec![a.clone()];
    db.transaction(|t| batches::update(t, &batch)).unwrap();

    let rows = db.with(|c| snapshots::list(c, &batch.id)).unwrap();
    assert_eq!(
        rows.iter().map(|r| r.item_id.as_str()).collect::<Vec<_>>(),
        vec![a.as_str()]
    );
}

#[test]
fn archive_and_delete_drop_the_snapshot_rows() {
    let db = db_with(vec![
        folder("A", ScanRoot::Unprocessed),
        folder("B", ScanRoot::Unprocessed),
    ]);
    let (a, b) = (item_id_for("A"), item_id_for("B"));
    let first = snapshotted_batch(&db, &[&a]);
    let second = snapshotted_batch(&db, &[&b]);
    assert_eq!(db.with(snapshots::live_batch_ids).unwrap().len(), 2);

    db.transaction(|t| batches::archive(t, &first.id)).unwrap();
    db.transaction(|t| batches::delete(t, &second.id)).unwrap();

    assert!(db.with(snapshots::live_batch_ids).unwrap().is_empty());
}
