//! Pre-batch folder snapshots: take one, change the folder the ways a batch
//! (and an operator) can, restore, and check the folder is exactly as it was.

mod common;

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use common::*;
use nbcg_dc_lib::core::snapshot;

struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    folder: PathBuf,
    snap: PathBuf,
    before: Vec<(String, String)>,
}

/// `scanned/BOOK` holding `files`, snapshotted for batch `b1`.
fn fixture(files: &[(&str, &str)]) -> Fixture {
    let tmp = tempfile::TempDir::new().unwrap();
    let root = tmp.path().join("scanned");
    let folder = root.join("BOOK");
    for (name, contents) in files {
        write_file(&folder.join(name), contents);
    }
    let snap = snapshot::item_dir(&root, "b1", "i1");
    snapshot::take(&folder, &snap).unwrap();
    let before = tree(&folder);
    Fixture {
        _tmp: tmp,
        root,
        folder,
        snap,
        before,
    }
}

/// The app's way of changing a file: a new file renamed over the old one.
fn replace(path: &Path, contents: &str) {
    let temp = path.with_extension("tmp-write");
    std::fs::write(&temp, contents).unwrap();
    std::fs::rename(&temp, path).unwrap();
}

#[test]
fn generated_outputs_are_removed() {
    let f = fixture(&[("1.jpg", "page one"), ("2.jpg", "page two")]);
    for name in [
        "BOOK.pdf",
        "BOOK_archive.pdf",
        "BOOK_thumb.png",
        "BOOK.txt",
        "metadata.json",
    ] {
        write_file(&f.folder.join(name), "made by the batch");
    }

    snapshot::restore(&f.folder, &f.snap).unwrap();

    assert_eq!(tree(&f.folder), f.before);
}

#[test]
fn a_replaced_file_comes_back_with_its_old_contents() {
    let f = fixture(&[("1.jpg", "page one"), ("metadata.json", "before the batch")]);
    replace(&f.folder.join("metadata.json"), "written by the batch");

    snapshot::restore(&f.folder, &f.snap).unwrap();

    assert_eq!(tree(&f.folder), f.before);
}

#[test]
fn a_supplied_pdf_filed_into_source_goes_back() {
    let f = fixture(&[("scan.pdf", "the operator's pdf")]);
    std::fs::create_dir_all(f.folder.join("source")).unwrap();
    std::fs::rename(f.folder.join("scan.pdf"), f.folder.join("source/scan.pdf")).unwrap();
    write_file(&f.folder.join("BOOK.pdf"), "derived");

    snapshot::restore(&f.folder, &f.snap).unwrap();

    assert_eq!(tree(&f.folder), f.before);
    assert!(
        !f.folder.join("source").exists(),
        "an emptied source/ was left behind"
    );
}

#[test]
fn a_file_deleted_by_hand_comes_back_and_one_added_by_hand_goes() {
    let f = fixture(&[("1.jpg", "page one"), ("2.jpg", "page two")]);
    std::fs::remove_file(f.folder.join("2.jpg")).unwrap();
    write_file(&f.folder.join("notes.docx"), "added by hand");

    snapshot::restore(&f.folder, &f.snap).unwrap();

    assert_eq!(tree(&f.folder), f.before);
}

#[test]
fn nested_item_folders_are_left_alone() {
    let f = fixture(&[("1.jpg", "page one"), ("Issue1/a.jpg", "nested item")]);
    write_file(&f.folder.join("Issue1/b.jpg"), "added to the nested item");

    snapshot::restore(&f.folder, &f.snap).unwrap();

    assert!(
        f.folder.join("Issue1/b.jpg").exists(),
        "restoring BOOK touched a nested item"
    );
}

#[test]
fn staging_folders_are_removed() {
    let f = fixture(&[("1.jpg", "page one")]);
    write_file(
        &f.folder.join(".nbcg-tmp-1234/BOOK.pdf"),
        "half-finished run",
    );

    snapshot::restore(&f.folder, &f.snap).unwrap();

    assert_eq!(tree(&f.folder), f.before);
}

#[test]
fn a_deleted_item_folder_is_recreated() {
    let f = fixture(&[("1.jpg", "page one"), ("2.jpg", "page two")]);
    std::fs::remove_dir_all(&f.folder).unwrap();

    snapshot::restore(&f.folder, &f.snap).unwrap();

    assert_eq!(tree(&f.folder), f.before);
}

#[test]
fn restore_is_idempotent() {
    let f = fixture(&[("1.jpg", "page one")]);
    write_file(&f.folder.join("BOOK.pdf"), "derived");

    snapshot::restore(&f.folder, &f.snap).unwrap();
    snapshot::restore(&f.folder, &f.snap).unwrap();

    assert_eq!(tree(&f.folder), f.before);
}

#[test]
fn diff_names_what_restore_will_do_and_changes_nothing() {
    let f = fixture(&[("1.jpg", "page one"), ("2.jpg", "page two")]);
    write_file(&f.folder.join("BOOK.pdf"), "derived");
    std::fs::remove_file(f.folder.join("2.jpg")).unwrap();
    write_file(&f.folder.join(".nbcg-tmp-9/x"), "scratch");
    let changed = tree(&f.folder);

    let diff = snapshot::diff(&f.folder, &f.snap).unwrap();

    assert_eq!(diff.remove, vec!["BOOK.pdf".to_string()]);
    assert_eq!(diff.restore, vec!["2.jpg".to_string()]);
    assert_eq!(diff.staging, vec![".nbcg-tmp-9".to_string()]);
    assert_eq!(tree(&f.folder), changed, "a dry run changed the folder");
}

#[test]
fn restoring_from_a_missing_snapshot_fails_and_touches_nothing() {
    let f = fixture(&[("1.jpg", "page one")]);
    write_file(&f.folder.join("BOOK.pdf"), "derived");
    let changed = tree(&f.folder);
    std::fs::remove_dir_all(&f.snap).unwrap();

    assert!(snapshot::restore(&f.folder, &f.snap).is_err());
    assert_eq!(tree(&f.folder), changed);
}

#[test]
fn take_refuses_to_overwrite_a_snapshot_or_to_snapshot_a_missing_folder() {
    let f = fixture(&[("1.jpg", "page one")]);
    assert!(snapshot::take(&f.folder, &f.snap).is_err());

    let nowhere = f.root.join("GONE");
    let dest = snapshot::item_dir(&f.root, "b2", "i9");
    assert!(snapshot::take(&nowhere, &dest).is_err());
    assert!(!dest.exists(), "a failed take left a folder behind");
}

#[test]
fn root_of_takes_the_relative_path_off_the_folder() {
    let folder = Path::new("/archive/scanned/Wrapper/BOOK");
    assert_eq!(
        snapshot::root_of(folder, "Wrapper/BOOK"),
        Some(PathBuf::from("/archive/scanned"))
    );
    assert_eq!(snapshot::root_of(folder, ""), None);
}

#[test]
fn drop_batch_removes_the_batch_and_the_emptied_snapshots_folder() {
    let f = fixture(&[("1.jpg", "page one")]);
    let batch = snapshot::batch_dir(&f.root, "b1");

    snapshot::drop_batch(&batch, "b1").unwrap();

    assert!(!f.root.join(snapshot::SNAPSHOTS_DIR).exists());
    assert_eq!(
        tree(&f.folder),
        f.before,
        "dropping a snapshot touched the item"
    );
}

#[test]
fn drop_batch_refuses_anything_that_is_not_a_snapshot_folder() {
    let f = fixture(&[("1.jpg", "page one")]);

    assert!(snapshot::drop_batch(&f.folder, "BOOK").is_err());
    assert!(snapshot::drop_batch(&snapshot::batch_dir(&f.root, "b1"), "other").is_err());
    assert_eq!(tree(&f.folder), f.before);
}

#[test]
fn sweep_removes_only_batches_that_are_not_live() {
    let f = fixture(&[("1.jpg", "page one")]);
    let other = snapshot::item_dir(&f.root, "b2", "i1");
    snapshot::take(&f.folder, &other).unwrap();

    snapshot::sweep(&f.root, &HashSet::from(["b1".to_string()])).unwrap();

    assert!(snapshot::batch_dir(&f.root, "b1").exists());
    assert!(!snapshot::batch_dir(&f.root, "b2").exists());
}

#[test]
fn app_outputs_are_told_apart_from_hand_added_files() {
    let scope: BTreeSet<String> = ["foo.pdf".to_string()].into();
    for name in [
        "BOOK.pdf",
        "BOOK_archive.pdf",
        "BOOK_thumb.png",
        "BOOK.txt",
        "BOOK_3.pdf",
        "BOOK_12.txt",
        "metadata.json",
        "metadata.json.tmp",
        "source/scan.pdf",
        "foo.txt",
    ] {
        assert!(snapshot::is_app_output(name, "BOOK", &scope), "{name}");
    }
    for name in ["notes.docx", "BOOK_x.pdf", "cover.jpg", "bar.txt"] {
        assert!(!snapshot::is_app_output(name, "BOOK", &scope), "{name}");
    }
}

#[test]
fn snapshot_paths_are_recognised() {
    assert!(snapshot::is_snapshot_path(Path::new(
        "/archive/scanned/.nbcg-snapshots/b1/i1/1.jpg"
    )));
    assert!(!snapshot::is_snapshot_path(Path::new(
        "/archive/scanned/BOOK/1.jpg"
    )));
}
