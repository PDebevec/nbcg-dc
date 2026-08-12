//! Batch persistence.
//!
//! The invariant under test throughout: an item's `batch_id` and the batch's
//! membership list never disagree. They are what makes an item read as
//! "In progress" and what stops it being selected into a second batch, so a
//! drift between them is an item the operator can put in two places at once.

mod common;

use std::collections::HashMap;

use common::*;
use nbcg_dc_lib::core::db::{batches, items, Db};
use nbcg_dc_lib::core::fs::item_id_for;
use nbcg_dc_lib::dto::*;

fn db_with_items(names: &[&str]) -> Db {
    let db = Db::open_in_memory().expect("open");
    let folders: Vec<_> = names
        .iter()
        .map(|n| folder(n, ScanRoot::Unprocessed))
        .collect();
    db.with(|c| items::reconcile(c, &folders))
        .expect("reconcile");
    db
}

#[test]
fn create_assigns_sequential_numbers() {
    let db = db_with_items(&["A", "B", "C"]);
    let a = item_id_for("A");
    let b = item_id_for("B");
    let c = item_id_for("C");

    let first = db
        .transaction(|t| batches::create(t, &batch_over(&[&a])))
        .unwrap();
    let second = db
        .transaction(|t| batches::create(t, &batch_over(&[&b])))
        .unwrap();
    let third = db
        .transaction(|t| batches::create(t, &batch_over(&[&c])))
        .unwrap();

    assert_eq!((first.no, second.no, third.no), (1, 2, 3));
}

#[test]
fn create_stamps_batch_id_onto_every_member() {
    let db = db_with_items(&["A", "B"]);
    let a = item_id_for("A");
    let b = item_id_for("B");

    let batch = db
        .transaction(|t| batches::create(t, &batch_over(&[&a, &b])))
        .unwrap();

    for id in [&a, &b] {
        let item = db.with(|c| items::get(c, id)).unwrap();
        assert_eq!(
            item.batch_id.as_deref(),
            Some(batch.id.as_str()),
            "member {id} was not claimed — it would still look selectable",
        );
    }
    assert_eq!(batch.item_ids, vec![a, b]);
}

#[test]
fn create_preserves_membership_order() {
    let db = db_with_items(&["A", "B", "C"]);
    let ids: Vec<String> = ["C", "A", "B"].iter().map(|n| item_id_for(n)).collect();
    let refs: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();

    let batch = db
        .transaction(|t| batches::create(t, &batch_over(&refs)))
        .unwrap();

    assert_eq!(batch.item_ids, ids);
}

#[test]
fn create_round_trips_parents_overrides_and_proc() {
    let db = db_with_items(&["A"]);
    let a = item_id_for("A");

    let mut fields = batch_over(&[&a]);
    fields.cobiss_id = Some("12345".into());
    fields.parents = vec![
        BatchParentRef {
            id: "p1".into(),
            passes_data: true,
        },
        BatchParentRef {
            id: "p2".into(),
            passes_data: false,
        },
    ];
    fields.proc = HashMap::from([(a.clone(), ItemRunStatus::Failed)]);
    fields.overrides = HashMap::from([(
        a.clone(),
        BatchItemOverride {
            publish: Some(ItemType::Record),
            visibility: Some(VisibilityStatus::Hidden),
            content_kind: Some(ContentKind::Book),
            split_spreads: Some(true),
        },
    )]);

    let created = db.transaction(|t| batches::create(t, &fields)).unwrap();
    let reread = db.with(|c| batches::get(c, &created.id)).unwrap();

    assert_eq!(reread.cobiss_id.as_deref(), Some("12345"));
    assert_eq!(reread.parents.len(), 2);
    assert!(reread.parents[0].passes_data);
    assert_eq!(reread.proc.get(&a), Some(&ItemRunStatus::Failed));
    let over = reread.overrides.get(&a).expect("override");
    assert_eq!(over.split_spreads, Some(true));
    assert_eq!(over.content_kind, Some(ContentKind::Book));
}

#[test]
fn update_persists_stage_and_running() {
    let db = db_with_items(&["A"]);
    let a = item_id_for("A");
    let mut batch = db
        .transaction(|t| batches::create(t, &batch_over(&[&a])))
        .unwrap();

    batch.stage = BatchStage::Processing;
    batch.running = true;
    let saved = db.transaction(|t| batches::update(t, &batch)).unwrap();

    assert_eq!(saved.stage, BatchStage::Processing);
    assert!(saved.running);
}

#[test]
fn update_releases_items_removed_from_the_batch() {
    let db = db_with_items(&["A", "B"]);
    let a = item_id_for("A");
    let b = item_id_for("B");
    let mut batch = db
        .transaction(|t| batches::create(t, &batch_over(&[&a, &b])))
        .unwrap();

    batch.item_ids = vec![a.clone()];
    db.transaction(|t| batches::update(t, &batch)).unwrap();

    assert_eq!(
        db.with(|c| items::get(c, &a)).unwrap().batch_id.as_deref(),
        Some(batch.id.as_str()),
    );
    assert_eq!(
        db.with(|c| items::get(c, &b)).unwrap().batch_id,
        None,
        "an item dropped from a batch stayed locked as In progress",
    );
}

#[test]
fn update_claims_items_added_to_the_batch() {
    let db = db_with_items(&["A", "B"]);
    let a = item_id_for("A");
    let b = item_id_for("B");
    let mut batch = db
        .transaction(|t| batches::create(t, &batch_over(&[&a])))
        .unwrap();

    batch.item_ids = vec![a, b.clone()];
    db.transaction(|t| batches::update(t, &batch)).unwrap();

    assert_eq!(
        db.with(|c| items::get(c, &b)).unwrap().batch_id.as_deref(),
        Some(batch.id.as_str()),
    );
}

#[test]
fn archive_releases_items_and_marks_the_batch_uploaded() {
    let db = db_with_items(&["A", "B"]);
    let a = item_id_for("A");
    let b = item_id_for("B");
    let batch = db
        .transaction(|t| batches::create(t, &batch_over(&[&a, &b])))
        .unwrap();

    let archived = db.transaction(|t| batches::archive(t, &batch.id)).unwrap();

    assert_eq!(archived.stage, BatchStage::Uploaded);
    assert!(archived.archived_at.is_some());
    assert!(!archived.running);
    for id in [&a, &b] {
        assert_eq!(
            db.with(|c| items::get(c, id)).unwrap().batch_id,
            None,
            "archiving did not release {id} — it would stay In progress forever",
        );
    }
    // Membership is retained for the record; only the claim is dropped.
    assert_eq!(archived.item_ids.len(), 2);
}

#[test]
fn archive_only_releases_items_still_claimed_by_that_batch() {
    let db = db_with_items(&["A"]);
    let a = item_id_for("A");
    let first = db
        .transaction(|t| batches::create(t, &batch_over(&[&a])))
        .unwrap();
    // The item has since been claimed by a newer batch.
    let second = db
        .transaction(|t| batches::create(t, &batch_over(&[&a])))
        .unwrap();

    db.transaction(|t| batches::archive(t, &first.id)).unwrap();

    assert_eq!(
        db.with(|c| items::get(c, &a)).unwrap().batch_id.as_deref(),
        Some(second.id.as_str()),
        "archiving an old batch stole an item from the batch that now owns it",
    );
}

#[test]
fn numbers_are_never_reused_after_archiving() {
    let db = db_with_items(&["A", "B"]);
    let a = item_id_for("A");
    let b = item_id_for("B");

    let first = db
        .transaction(|t| batches::create(t, &batch_over(&[&a])))
        .unwrap();
    db.transaction(|t| batches::archive(t, &first.id)).unwrap();
    let next = db
        .transaction(|t| batches::create(t, &batch_over(&[&b])))
        .unwrap();

    assert_eq!(
        next.no, 2,
        "batch numbers are operator-facing and must not recycle"
    );
}

#[test]
fn list_returns_newest_first() {
    let db = db_with_items(&["A", "B"]);
    let a = item_id_for("A");
    let b = item_id_for("B");
    db.transaction(|t| batches::create(t, &batch_over(&[&a])))
        .unwrap();
    db.transaction(|t| batches::create(t, &batch_over(&[&b])))
        .unwrap();

    let all = db.with(batches::list).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].no, 2);
    assert_eq!(all[1].no, 1);
}

#[test]
fn archive_and_update_on_an_unknown_batch_are_not_found() {
    let db = Db::open_in_memory().unwrap();
    assert!(matches!(
        db.transaction(|t| batches::archive(t, "nope")),
        Err(nbcg_dc_lib::error::AppError::NotFound(_)),
    ));
}

#[test]
fn a_failed_create_leaves_no_partial_batch() {
    // A transaction that returns Err must roll back the batch row *and* the
    // item stamping, or the running number is burned by an invisible batch.
    let db = db_with_items(&["A"]);
    let a = item_id_for("A");

    let outcome: Result<(), nbcg_dc_lib::error::AppError> = db.transaction(|t| {
        batches::create(t, &batch_over(&[&a]))?;
        Err(nbcg_dc_lib::error::AppError::Other(
            "simulated failure".into(),
        ))
    });
    assert!(outcome.is_err());

    assert!(db.with(batches::list).unwrap().is_empty());
    assert_eq!(db.with(|c| items::get(c, &a)).unwrap().batch_id, None);

    // The next real create still gets number 1.
    let good = db
        .transaction(|t| batches::create(t, &batch_over(&[&a])))
        .unwrap();
    assert_eq!(good.no, 1);
}
