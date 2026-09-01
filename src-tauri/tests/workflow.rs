//! End-to-end walk through the archive's real lifecycle, against a real
//! temp filesystem and a real file-backed SQLite index.
//!
//! The per-module tests pin individual behaviours; this one checks they compose
//! — that an item can go arrivals → batch → upload → move → sync → release
//! without any step quietly undoing an earlier one. That is where the
//! interesting bugs live, because each write path is correct in isolation and
//! wrong only in combination.

mod common;

use common::*;
use nbcg_dc_lib::core::db::{batches, items, Db};
use nbcg_dc_lib::core::fs;
use nbcg_dc_lib::dto::*;
use tempfile::TempDir;

struct Fixture {
    _home: TempDir,
    unprocessed: std::path::PathBuf,
    processed: std::path::PathBuf,
    db_path: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let home = TempDir::new().unwrap();
        let unprocessed = home.path().join("unprocessed");
        let processed = home.path().join("processed");
        std::fs::create_dir_all(&unprocessed).unwrap();
        std::fs::create_dir_all(&processed).unwrap();
        let db_path = home.path().join("index.db");
        Fixture {
            _home: home,
            unprocessed,
            processed,
            db_path,
        }
    }

    fn open_db(&self) -> Db {
        Db::open(&self.db_path).expect("open index")
    }

    fn rescan(&self, db: &Db) {
        let found = fs::scan_roots(Some(&self.unprocessed), Some(&self.processed)).expect("scan");
        db.transaction(|tx| items::reconcile(tx, &found))
            .expect("reconcile");
    }
}

#[test]
fn an_item_survives_the_whole_lifecycle() {
    let fx = Fixture::new();

    // ── Arrivals: two folders land in /unprocessed, as a scanner would leave
    // them — a flat run of page images, no PDFs yet.
    make_item_dir(&fx.unprocessed, "NJEGOS", &[("1.jpg", "a"), ("2.jpg", "b")]);
    make_item_dir(&fx.unprocessed, "OKTOIH", &[("1.jpg", "a")]);

    let db = fx.open_db();
    fx.rescan(&db);

    let all = db.with(items::list).unwrap();
    assert_eq!(all.len(), 2, "both arrivals should be tracked");
    assert!(all.iter().all(|i| i.root == ScanRoot::Unprocessed));
    assert!(all.iter().all(|i| !i.uploaded && i.batch_id.is_none()));

    let njegos = fs::item_id_for("NJEGOS");
    let oktoih = fs::item_id_for("OKTOIH");

    // ── Batch: the operator selects both and creates a batch.
    let batch = db
        .transaction(|tx| batches::create(tx, &batch_over(&[&njegos, &oktoih])))
        .unwrap();
    assert_eq!(batch.no, 1);
    for id in [&njegos, &oktoih] {
        assert_eq!(
            db.with(|c| items::get(c, id)).unwrap().batch_id.as_deref(),
            Some(batch.id.as_str()),
            "both items should read as In progress",
        );
    }

    // ── Processing: the pipeline writes derived outputs for one item.
    for (name, contents) in [
        ("NJEGOS.pdf", "web pdf"),
        ("NJEGOS_archive.pdf", "archival"),
        ("NJEGOS_thumb.png", "thumb"),
        ("NJEGOS.txt", "ocr text"),
    ] {
        std::fs::write(fx.unprocessed.join("NJEGOS").join(name), contents).unwrap();
    }
    db.with(|c| {
        for stage in [StageName::Pdf, StageName::Thumbnail, StageName::Ocr] {
            items::set_stage(c, &njegos, stage, StageStatus::Done, None)?;
        }
        Ok(())
    })
    .unwrap();

    // A rescan now picks up the new files without disturbing the run.
    fx.rescan(&db);
    let item = db.with(|c| items::get(c, &njegos)).unwrap();
    assert_eq!(item.assets.len(), 6, "derived outputs should be indexed");
    assert_eq!(
        item.stages.get(&StageName::Ocr).map(|s| s.status),
        Some(StageStatus::Done),
        "a rescan wiped the pipeline's work",
    );
    assert_eq!(item.batch_id.as_deref(), Some(batch.id.as_str()));

    // ── Upload: the backend accepts it; we write through to index and mirror.
    db.transaction(|tx| {
        items::record_upload(
            tx,
            &njegos,
            &UploadRecordDto {
                backend_id: "rec-001".into(),
                version: Some(1),
                target_state: ItemType::Record,
                visibility_status: VisibilityStatus::Public,
            },
        )
    })
    .unwrap();
    fs::write_metadata(
        &fx.unprocessed.join("NJEGOS"),
        &LocalMetadataFile {
            backend_id: Some("rec-001".into()),
            version: Some(1),
            target_state: Some(ItemType::Record),
            visibility_status: Some(VisibilityStatus::Public),
            metadata: serde_json::json!({ "title": "Gorski vijenac" }),
            synced_at: "2026-08-12T12:00:00.000Z".into(),
        },
    )
    .unwrap();

    // ── Reposition: the folder moves to /processed and the row follows.
    let moved = fs::move_to_processed(
        &fx.unprocessed.join("NJEGOS"),
        std::path::Path::new("NJEGOS"),
        &fx.processed,
    )
    .unwrap();
    let relocated = db
        .with(|c| items::set_location(c, &njegos, ScanRoot::Processed, &moved.to_string_lossy()))
        .unwrap();
    assert_eq!(relocated.root, ScanRoot::Processed);
    assert!(relocated.uploaded);

    // A rescan across both roots must not mint a second item for the move.
    fx.rescan(&db);
    assert_eq!(
        db.with(items::list).unwrap().len(),
        2,
        "the move duplicated an item"
    );
    let after_move = db.with(|c| items::get(c, &njegos)).unwrap();
    assert_eq!(after_move.root, ScanRoot::Processed);
    assert_eq!(after_move.title.as_deref(), Some("Gorski vijenac"));

    // ── Sync: a later backend read refreshes cached facts only.
    db.with(|c| {
        c.execute("UPDATE items SET reupload = 1 WHERE id = ?1", [&njegos])
            .map(|_| ())
            .map_err(Into::into)
    })
    .unwrap();
    let synced = db
        .transaction(|tx| {
            items::record_sync(
                tx,
                &njegos,
                &SyncRecordDto {
                    version: None,
                    target_state: None,
                    visibility_status: None,
                    title: Some("Gorski vijenac (2nd ed.)".into()),
                    miss_streak: 0,
                    synced_at: "2026-08-12T18:00:00.000Z".into(),
                },
            )
        })
        .unwrap();
    assert_eq!(synced.title.as_deref(), Some("Gorski vijenac (2nd ed.)"));
    assert!(synced.reupload, "sync cleared a pending re-upload");
    let facts = db.with(|c| items::backend_facts(c, &njegos)).unwrap();
    assert_eq!(
        facts.version,
        Some(1),
        "a null version cleared the stored one"
    );

    // ── Archive: the batch completes and releases both items.
    db.transaction(|tx| batches::archive(tx, &batch.id))
        .unwrap();
    for id in [&njegos, &oktoih] {
        assert_eq!(
            db.with(|c| items::get(c, id)).unwrap().batch_id,
            None,
            "archiving left an item stuck In progress",
        );
    }
}

#[test]
fn the_index_can_be_rebuilt_from_the_folders_alone() {
    let fx = Fixture::new();

    // An uploaded item, complete with mirror and derived outputs.
    let dir = make_item_dir(
        &fx.processed,
        "NJEGOS",
        &[
            ("NJEGOS.pdf", "web"),
            ("NJEGOS_thumb.png", "t"),
            ("NJEGOS.txt", "x"),
        ],
    );
    fs::write_metadata(&dir, &metadata_mirror(Some("rec-001"), "Gorski vijenac")).unwrap();
    // …and one still awaiting work.
    make_item_dir(&fx.unprocessed, "OKTOIH", &[("1.jpg", "a")]);

    let db = fx.open_db();
    fx.rescan(&db);
    let batch_id = {
        let njegos = fs::item_id_for("NJEGOS");
        db.transaction(|tx| batches::create(tx, &batch_over(&[&njegos])))
            .unwrap()
            .id
    };

    // Simulate a lost index: wipe every item row and reconstruct from disk.
    let found = fs::scan_roots(Some(&fx.unprocessed), Some(&fx.processed)).unwrap();
    db.transaction(|tx| items::rebuild(tx, &found)).unwrap();

    let njegos = db
        .with(|c| items::get(c, &fs::item_id_for("NJEGOS")))
        .unwrap();
    assert!(
        njegos.uploaded,
        "the mirror's backend id should imply uploaded"
    );
    assert_eq!(njegos.backend_id.as_deref(), Some("rec-001"));
    assert_eq!(njegos.root, ScanRoot::Processed);
    assert_eq!(
        njegos.stages.get(&StageName::Pdf).map(|s| s.status),
        Some(StageStatus::Done),
        "derived files should reconstruct stage status",
    );

    let oktoih = db
        .with(|c| items::get(c, &fs::item_id_for("OKTOIH")))
        .unwrap();
    assert!(!oktoih.uploaded);

    // The batch survived, and its membership still resolves to a real item —
    // this is what deterministic ids buy.
    let batch = db.with(|c| batches::get(c, &batch_id)).unwrap();
    assert_eq!(batch.item_ids, vec![fs::item_id_for("NJEGOS")]);
    assert!(db.with(|c| items::exists(c, &batch.item_ids[0])).unwrap());
}

#[test]
fn the_index_survives_being_closed_and_reopened() {
    let fx = Fixture::new();
    make_item_dir(&fx.unprocessed, "NJEGOS", &[("1.jpg", "a")]);

    let batch_id = {
        let db = fx.open_db();
        fx.rescan(&db);
        db.transaction(|tx| batches::create(tx, &batch_over(&[&fs::item_id_for("NJEGOS")])))
            .unwrap()
            .id
    };

    // Reopen the same file — migrations must be idempotent and data intact.
    let db = fx.open_db();
    assert_eq!(db.with(items::list).unwrap().len(), 1);
    let batch = db.with(|c| batches::get(c, &batch_id)).unwrap();
    assert_eq!(batch.no, 1);
    assert_eq!(batch.item_ids.len(), 1);
}
