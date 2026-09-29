//! Batch create / delete / archive across folders and index together — the
//! undo promise: after a delete, every member is as it was before the batch.

mod common;

use std::path::PathBuf;

use common::*;
use nbcg_dc_lib::core::batch_lifecycle as lifecycle;
use nbcg_dc_lib::core::db::{batches, items, snapshots, Db};
use nbcg_dc_lib::core::fs::{item_id_for, scan_root};
use nbcg_dc_lib::core::snapshot;
use nbcg_dc_lib::dto::*;
use nbcg_dc_lib::error::AppError;

struct Archive {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    db: Db,
}

impl Archive {
    fn new(folders: &[(&str, &[(&str, &str)])]) -> Self {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("scanned");
        for (name, files) in folders {
            make_item_dir(&root, name, files);
        }
        let db = Db::open_in_memory().unwrap();
        let found = scan_root(&root, ScanRoot::Unprocessed).unwrap();
        db.with(|c| items::reconcile(c, &found)).unwrap();
        Archive {
            _tmp: tmp,
            root,
            db,
        }
    }

    fn folder(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
}

const PAGES: &[(&str, &str)] = &[("1.jpg", "page one"), ("2.jpg", "page two")];

#[test]
fn create_snapshots_every_member() {
    let archive = Archive::new(&[("BOOK", PAGES)]);
    let id = item_id_for("BOOK");

    let batch = lifecycle::create(&archive.db, &batch_over(&[&id])).unwrap();

    let snap = snapshot::item_dir(&archive.root, &batch.id, &id);
    assert_eq!(tree(&snap), tree(&archive.folder("BOOK")));
    let rows = archive.db.with(|c| snapshots::list(c, &batch.id)).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].item.batch_id, None,
        "the snapshot was taken after the claim"
    );
    assert_eq!(batch.no, 1);
}

#[test]
fn delete_puts_folders_and_index_back_and_removes_the_batch() {
    let archive = Archive::new(&[("BOOK", PAGES)]);
    let id = item_id_for("BOOK");
    let folder_before = tree(&archive.folder("BOOK"));
    let item_before = archive.db.with(|c| items::get(c, &id)).unwrap();
    let batch = lifecycle::create(&archive.db, &batch_over(&[&id])).unwrap();

    // What a processing run does.
    for name in ["BOOK.pdf", "BOOK_thumb.png", "metadata.json"] {
        write_file(&archive.folder("BOOK").join(name), "made by the batch");
    }
    archive
        .db
        .with(|c| items::set_stage(c, &id, StageName::Pdf, StageStatus::Done, None))
        .unwrap();

    lifecycle::delete(&archive.db, &batch.id, false).unwrap();

    assert_eq!(tree(&archive.folder("BOOK")), folder_before);
    assert_eq!(
        archive.db.with(|c| items::get(c, &id)).unwrap(),
        item_before
    );
    assert!(archive.db.with(batches::list).unwrap().is_empty());
    assert!(!archive.root.join(snapshot::SNAPSHOTS_DIR).exists());
}

#[test]
fn preview_names_every_change_and_flags_hand_added_files() {
    let archive = Archive::new(&[("BOOK", PAGES)]);
    let id = item_id_for("BOOK");
    let batch = lifecycle::create(&archive.db, &batch_over(&[&id])).unwrap();
    write_file(&archive.folder("BOOK").join("BOOK.pdf"), "derived");
    write_file(&archive.folder("BOOK").join("notes.docx"), "added by hand");
    std::fs::remove_file(archive.folder("BOOK").join("2.jpg")).unwrap();

    let plan = lifecycle::preview(&archive.db, &batch.id, false).unwrap();

    assert!(plan.has_snapshot);
    assert_eq!(plan.blocked_reason, None);
    let item = &plan.items[0];
    assert_eq!(
        item.remove,
        vec![
            BatchDeleteFileDto {
                path: "BOOK.pdf".into(),
                generated: true
            },
            BatchDeleteFileDto {
                path: "notes.docx".into(),
                generated: false
            },
        ]
    );
    assert_eq!(item.restore, vec!["2.jpg".to_string()]);
    assert_eq!(item.before.as_ref().unwrap().batch_id, None);
    assert!(
        archive.folder("BOOK").join("notes.docx").exists(),
        "the preview changed files"
    );
}

#[test]
fn delete_is_refused_once_the_backend_was_touched_or_while_running() {
    let archive = Archive::new(&[("BOOK", PAGES)]);
    let id = item_id_for("BOOK");
    let batch = lifecycle::create(&archive.db, &batch_over(&[&id])).unwrap();

    let running = lifecycle::delete(&archive.db, &batch.id, true);
    assert!(matches!(running, Err(AppError::Invalid(ref m)) if m == lifecycle::RUNNING_REASON));

    archive
        .db
        .with(|c| batches::mark_backend_touched(c, &batch.id))
        .unwrap();
    let touched = lifecycle::delete(&archive.db, &batch.id, false);
    assert!(matches!(touched, Err(AppError::Invalid(ref m)) if m == lifecycle::BACKEND_REASON));
    let plan = lifecycle::preview(&archive.db, &batch.id, false).unwrap();
    assert_eq!(
        plan.blocked_reason.as_deref(),
        Some(lifecycle::BACKEND_REASON)
    );
    assert_eq!(archive.db.with(batches::list).unwrap().len(), 1);
}

#[test]
fn a_failed_restore_keeps_the_batch_so_a_retry_can_finish() {
    let archive = Archive::new(&[("A", PAGES), ("B", PAGES)]);
    let (a, b) = (item_id_for("A"), item_id_for("B"));
    let batch = lifecycle::create(&archive.db, &batch_over(&[&a, &b])).unwrap();
    std::fs::remove_dir_all(snapshot::item_dir(&archive.root, &batch.id, &b)).unwrap();

    assert!(lifecycle::delete(&archive.db, &batch.id, false).is_err());

    assert_eq!(archive.db.with(batches::list).unwrap().len(), 1);
    assert_eq!(
        archive
            .db
            .with(|c| items::get(c, &b))
            .unwrap()
            .batch_id
            .as_deref(),
        Some(batch.id.as_str())
    );
}

#[test]
fn a_batch_without_snapshots_is_deleted_by_releasing_its_items() {
    let archive = Archive::new(&[("BOOK", PAGES)]);
    let id = item_id_for("BOOK");
    let legacy = archive
        .db
        .transaction(|t| batches::create(t, &batch_over(&[&id])))
        .unwrap();
    write_file(
        &archive.folder("BOOK").join("BOOK.pdf"),
        "made before snapshots",
    );

    let plan = lifecycle::preview(&archive.db, &legacy.id, false).unwrap();
    assert!(!plan.has_snapshot);
    assert_eq!(plan.items[0].before.as_ref().unwrap().batch_id, None);
    lifecycle::delete(&archive.db, &legacy.id, false).unwrap();

    assert_eq!(
        archive.db.with(|c| items::get(c, &id)).unwrap().batch_id,
        None
    );
    assert!(
        archive.folder("BOOK").join("BOOK.pdf").exists(),
        "a legacy delete touched files"
    );
}

#[test]
fn archive_drops_the_snapshot_folders() {
    let archive = Archive::new(&[("BOOK", PAGES)]);
    let id = item_id_for("BOOK");
    let batch = lifecycle::create(&archive.db, &batch_over(&[&id])).unwrap();

    lifecycle::archive(&archive.db, &batch.id).unwrap();

    assert!(!archive.root.join(snapshot::SNAPSHOTS_DIR).exists());
    assert!(archive
        .db
        .with(|c| snapshots::list(c, &batch.id))
        .unwrap()
        .is_empty());
}

#[test]
fn sweep_removes_snapshots_whose_batch_is_gone() {
    let archive = Archive::new(&[("A", PAGES), ("B", PAGES)]);
    let (a, b) = (item_id_for("A"), item_id_for("B"));
    let kept = lifecycle::create(&archive.db, &batch_over(&[&a])).unwrap();
    let gone = lifecycle::create(&archive.db, &batch_over(&[&b])).unwrap();
    // A crash between the delete's commit and its folder cleanup.
    archive
        .db
        .transaction(|t| batches::delete(t, &gone.id))
        .unwrap();

    lifecycle::sweep(&archive.db, std::slice::from_ref(&archive.root)).unwrap();

    assert!(snapshot::batch_dir(&archive.root, &kept.id).exists());
    assert!(!snapshot::batch_dir(&archive.root, &gone.id).exists());
}

#[test]
fn create_fails_cleanly_when_a_member_folder_is_missing() {
    let archive = Archive::new(&[("A", PAGES), ("B", PAGES)]);
    let (a, b) = (item_id_for("A"), item_id_for("B"));
    std::fs::remove_dir_all(archive.folder("B")).unwrap();

    assert!(lifecycle::create(&archive.db, &batch_over(&[&a, &b])).is_err());

    assert!(archive.db.with(batches::list).unwrap().is_empty());
    assert!(!archive.root.join(snapshot::SNAPSHOTS_DIR).exists());
    assert_eq!(
        archive.db.with(|c| items::get(c, &a)).unwrap().batch_id,
        None
    );
}
