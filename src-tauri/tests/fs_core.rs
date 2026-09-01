//! Filesystem layer: scanning, the mirror, and the move across roots.

mod common;

use common::*;
use nbcg_dc_lib::core::fs;
use nbcg_dc_lib::dto::*;
use tempfile::TempDir;

/// A Cyrillic name **with spaces**, taken from the real corpus
/// (docs/tasks/naming-base-and-unicode-filenames.md). Non-ASCII folder names go
/// through the index, the mirror and eventually multipart upload, and none of
/// that was ever exercised with one.
const CYRILLIC: &str = "ОКТОИХ петогласник 2";

#[test]
fn item_id_is_stable_across_calls_and_unique_per_name() {
    assert_eq!(fs::item_id_for("BOOK"), fs::item_id_for("BOOK"));
    assert_ne!(fs::item_id_for("BOOK"), fs::item_id_for("BOOK 2"));
    // Stable *value*, not just stable within a process — a rebuild in a later
    // launch has to reproduce it.
    assert_eq!(fs::item_id_for("BOOK").len(), 16);
}

#[test]
fn item_id_handles_unicode_names() {
    let id = fs::item_id_for(CYRILLIC);
    assert_eq!(id.len(), 16);
    assert_eq!(id, fs::item_id_for(CYRILLIC));
    assert_ne!(id, fs::item_id_for("ОКТОИХ петогласник 3"));
}

#[test]
fn describe_folder_lists_files_and_flags_derived_outputs() {
    let root = TempDir::new().unwrap();
    let dir = make_item_dir(
        root.path(),
        "BOOK",
        &[
            ("1.jpg", "a"),
            ("2.jpg", "bb"),
            ("BOOK.pdf", "web"),
            ("BOOK_archive.pdf", "archival"),
            ("BOOK_thumb.png", "thumb"),
            ("BOOK.txt", "ocr text"),
        ],
    );

    let found = fs::describe_folder(&dir, ScanRoot::Unprocessed).unwrap();

    assert_eq!(found.folder_name, "BOOK");
    assert_eq!(found.assets.len(), 6);
    assert!(found.derived.web_pdf);
    assert!(found.derived.archival_pdf);
    assert!(found.derived.thumbnail);
    assert!(found.derived.ocr_text);
}

#[test]
fn derived_detection_is_scoped_to_the_folders_own_name() {
    let root = TempDir::new().unwrap();
    // A PDF that is *not* named after the folder is a supplied input, not our
    // derived output — mistaking it would mark the PDF stage done before it ran.
    let dir = make_item_dir(root.path(), "BOOK", &[("something-else.pdf", "x")]);

    let found = fs::describe_folder(&dir, ScanRoot::Unprocessed).unwrap();

    assert!(!found.derived.web_pdf);
    assert_eq!(found.assets.len(), 1);
}

#[test]
fn describe_folder_reads_the_mirror() {
    let root = TempDir::new().unwrap();
    let dir = make_item_dir(root.path(), "BOOK", &[]);
    let mirror = LocalMetadataFile {
        metadata: serde_json::json!({ "title": "Njegoš", "cobissId": "51966" }),
        ..metadata_mirror(Some("rec-42"), "unused")
    };
    fs::write_metadata(&dir, &mirror).unwrap();

    let found = fs::describe_folder(&dir, ScanRoot::Unprocessed).unwrap();

    assert_eq!(found.backend_id.as_deref(), Some("rec-42"));
    assert_eq!(found.title.as_deref(), Some("Njegoš"));
    assert_eq!(found.cobiss_id.as_deref(), Some("51966"));
    assert_eq!(found.version, Some(2));
    assert_eq!(found.target_state, Some(ItemType::Draft));
}

#[test]
fn a_numeric_cobiss_id_is_read_as_a_string() {
    let root = TempDir::new().unwrap();
    let dir = make_item_dir(root.path(), "BOOK", &[]);
    fs::write_metadata(
        &dir,
        &LocalMetadataFile {
            metadata: serde_json::json!({ "title": "t", "cobissId": 51966 }),
            ..metadata_mirror(None, "unused")
        },
    )
    .unwrap();

    let found = fs::describe_folder(&dir, ScanRoot::Unprocessed).unwrap();
    assert_eq!(found.cobiss_id.as_deref(), Some("51966"));
}

#[test]
fn a_corrupt_mirror_still_yields_a_listable_item() {
    let root = TempDir::new().unwrap();
    let dir = make_item_dir(root.path(), "BOOK", &[("metadata.json", "{ not json")]);

    let found = fs::describe_folder(&dir, ScanRoot::Unprocessed).unwrap();

    // The item must appear — hiding it would conceal the one the operator has
    // to fix. It simply carries no mirror facts.
    assert_eq!(found.folder_name, "BOOK");
    assert_eq!(found.backend_id, None);
    assert_eq!(found.title, None);
}

#[test]
fn scan_roots_covers_both_roots() {
    let unprocessed = TempDir::new().unwrap();
    let processed = TempDir::new().unwrap();
    make_item_dir(unprocessed.path(), "PENDING", &[]);
    make_item_dir(processed.path(), "DONE", &[]);

    let found = fs::scan_roots(Some(unprocessed.path()), Some(processed.path())).unwrap();

    assert_eq!(found.len(), 2);
    let pending = found.iter().find(|f| f.folder_name == "PENDING").unwrap();
    let done = found.iter().find(|f| f.folder_name == "DONE").unwrap();
    assert_eq!(pending.root, ScanRoot::Unprocessed);
    assert_eq!(done.root, ScanRoot::Processed);
}

#[test]
fn scan_roots_prefers_unprocessed_on_a_name_collision() {
    let unprocessed = TempDir::new().unwrap();
    let processed = TempDir::new().unwrap();
    make_item_dir(unprocessed.path(), "BOOK", &[]);
    make_item_dir(processed.path(), "BOOK", &[]);

    let found = fs::scan_roots(Some(unprocessed.path()), Some(processed.path())).unwrap();

    assert_eq!(found.len(), 1, "ids must stay unique");
    assert_eq!(found[0].root, ScanRoot::Unprocessed);
}

#[test]
fn scan_roots_tolerates_unconfigured_and_missing_roots() {
    let real = TempDir::new().unwrap();
    make_item_dir(real.path(), "BOOK", &[]);

    // Unconfigured second root.
    assert_eq!(fs::scan_roots(Some(real.path()), None).unwrap().len(), 1);
    // Nothing configured at all — a first run.
    assert!(fs::scan_roots(None, None).unwrap().is_empty());
    // A configured root that does not exist (unplugged drive).
    let gone = real.path().join("does-not-exist");
    assert_eq!(
        fs::scan_roots(Some(real.path()), Some(&gone))
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn scan_ignores_loose_files_at_the_root() {
    let root = TempDir::new().unwrap();
    make_item_dir(root.path(), "BOOK", &[]);
    std::fs::write(root.path().join("notes.txt"), "stray").unwrap();

    let found = fs::scan_roots(Some(root.path()), None).unwrap();

    assert_eq!(
        found.len(),
        1,
        "one folder = one item; loose files are not items"
    );
}

// ─── recursion (nested record folders) ──────────────────────────────────────

#[test]
fn scan_recurses_into_arbitrary_depth() {
    // Mirrors the real `Cèrnagora/` shape: a wrapper folder holding two real
    // book folders plus its own loose files.
    let root = TempDir::new().unwrap();
    make_item_dir(root.path(), "Cernagora", &[("loose.jpg", "x")]);
    make_item_dir(&root.path().join("Cernagora"), "BOOK-A", &[("1.jpg", "a")]);
    make_item_dir(&root.path().join("Cernagora"), "BOOK-B", &[("1.jpg", "a")]);

    let found = fs::scan_root(root.path(), ScanRoot::Unprocessed).unwrap();

    assert_eq!(
        found.len(),
        3,
        "the wrapper and both children are candidates"
    );
    let wrapper = found.iter().find(|f| f.folder_name == "Cernagora").unwrap();
    let a = found.iter().find(|f| f.folder_name == "BOOK-A").unwrap();
    let b = found.iter().find(|f| f.folder_name == "BOOK-B").unwrap();

    assert_eq!(wrapper.relative_path, "Cernagora");
    assert_eq!(wrapper.parent_path, None);
    assert_eq!(a.relative_path, "Cernagora/BOOK-A");
    assert_eq!(a.parent_path.as_deref(), Some(wrapper.folder_path.as_str()));
    assert_eq!(b.relative_path, "Cernagora/BOOK-B");
    assert_eq!(
        a.assets.len(),
        1,
        "a nested folder's own files are observed too"
    );
}

#[test]
fn scan_root_sorts_a_parent_immediately_before_its_own_descendants() {
    let root = TempDir::new().unwrap();
    make_item_dir(root.path(), "Budua", &[]);
    make_item_dir(root.path(), "Cernagora", &[]);
    make_item_dir(&root.path().join("Cernagora"), "BOOK-A", &[]);
    make_item_dir(root.path(), "Pisma", &[]);

    let found = fs::scan_root(root.path(), ScanRoot::Unprocessed).unwrap();
    let order: Vec<&str> = found.iter().map(|f| f.relative_path.as_str()).collect();

    assert_eq!(
        order,
        vec!["Budua", "Cernagora", "Cernagora/BOOK-A", "Pisma"]
    );
}

#[test]
fn scan_root_gives_different_ids_to_folders_sharing_a_leaf_name_at_different_parents() {
    // The exact collision `item_id_for`'s path-hashing exists to prevent:
    // arh/BookA/1 and arh/BookB/1 both have leaf name "1".
    let root = TempDir::new().unwrap();
    make_item_dir(root.path(), "BookA", &[]);
    make_item_dir(root.path(), "BookB", &[]);
    make_item_dir(&root.path().join("BookA"), "1", &[]);
    make_item_dir(&root.path().join("BookB"), "1", &[]);

    let found = fs::scan_root(root.path(), ScanRoot::Unprocessed).unwrap();
    let ones: Vec<&_> = found.iter().filter(|f| f.folder_name == "1").collect();

    assert_eq!(ones.len(), 2);
    assert_ne!(
        ones[0].id, ones[1].id,
        "same leaf name at different parents must not collide"
    );
    assert_eq!(
        found.len(),
        4,
        "reconcile must get one row per folder, not a merge"
    );
}

#[test]
fn item_id_for_a_depth_one_folder_is_unchanged_by_the_relative_path_scheme() {
    // The whole point of hashing the relative path rather than the bare name:
    // for every folder that existed before nesting was possible, the relative
    // path *is* the bare name, so every existing id is preserved byte-for-byte.
    let root = TempDir::new().unwrap();
    make_item_dir(root.path(), "BOOK", &[]);

    let found = fs::scan_root(root.path(), ScanRoot::Unprocessed).unwrap();

    assert_eq!(found[0].id, fs::item_id_for("BOOK"));
}

#[test]
fn scan_skips_dotfolders_and_windows_junk_folders() {
    let root = TempDir::new().unwrap();
    make_item_dir(root.path(), "BOOK", &[]);
    make_item_dir(root.path(), ".git", &[("config", "x")]);
    make_item_dir(root.path(), "System Volume Information", &[]);
    make_item_dir(root.path(), "$RECYCLE.BIN", &[]);

    let found = fs::scan_root(root.path(), ScanRoot::Unprocessed).unwrap();

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].folder_name, "BOOK");
}

#[test]
fn scan_respects_the_max_depth_safety_cap() {
    // A pathologically deep single-child chain — the cap is a safety valve
    // against a cyclic/adversarial structure, not a product decision, so this
    // only checks it terminates and cuts off somewhere, not an exact number.
    let root = TempDir::new().unwrap();
    let mut dir = root.path().to_path_buf();
    for i in 0..40 {
        dir = dir.join(format!("d{i}"));
        std::fs::create_dir_all(&dir).unwrap();
    }

    let found = fs::scan_root(root.path(), ScanRoot::Unprocessed).unwrap();

    assert!(
        found.len() < 40,
        "the depth cap must cut the chain off well before the bottom"
    );
}

#[cfg(windows)]
#[test]
fn scan_does_not_follow_a_symlinked_directory() {
    let root = TempDir::new().unwrap();
    let real = make_item_dir(root.path(), "REAL", &[("1.jpg", "a")]);
    let link = root.path().join("LINK");

    if std::os::windows::fs::symlink_dir(&real, &link).is_err() {
        // No Developer Mode / no privilege in this environment — the
        // property this test pins (DirEntry::file_type() does not follow
        // symlinks, so is_dir() alone already excludes them) is unaffected;
        // it just can't be exercised here.
        eprintln!(
            "skipping: could not create a directory symlink (needs Developer Mode or elevation)"
        );
        return;
    }

    let found = fs::scan_root(root.path(), ScanRoot::Unprocessed).unwrap();

    assert_eq!(
        found.len(),
        1,
        "the symlink must not be scanned as a second item"
    );
    assert_eq!(found[0].folder_name, "REAL");
}

#[test]
fn move_to_processed_preserves_a_nested_relative_path_and_its_id() {
    let unprocessed = TempDir::new().unwrap();
    let processed = TempDir::new().unwrap();
    make_item_dir(unprocessed.path(), "Cernagora", &[]);
    let dir = make_item_dir(
        &unprocessed.path().join("Cernagora"),
        "BOOK-A",
        &[("1.jpg", "a")],
    );

    let before = fs::scan_root(unprocessed.path(), ScanRoot::Unprocessed).unwrap();
    let item_before = before.iter().find(|f| f.folder_name == "BOOK-A").unwrap();
    assert_eq!(item_before.relative_path, "Cernagora/BOOK-A");

    let moved = fs::move_to_processed(
        &dir,
        std::path::Path::new(&item_before.relative_path),
        processed.path(),
    )
    .unwrap();

    assert_eq!(moved, processed.path().join("Cernagora").join("BOOK-A"));
    assert!(moved.join("1.jpg").is_file());

    // Rescanning the processed root after the move must reproduce the exact
    // same id — the whole point of preserving the relative path across the
    // move rather than flattening to the leaf name.
    let after = fs::scan_root(processed.path(), ScanRoot::Processed).unwrap();
    let item_after = after.iter().find(|f| f.folder_name == "BOOK-A").unwrap();
    assert_eq!(
        item_after.id, item_before.id,
        "identity must survive the move"
    );
    assert_eq!(item_after.relative_path, "Cernagora/BOOK-A");
}

// ─── the mirror ──────────────────────────────────────────────────────────────

#[test]
fn write_then_read_metadata_round_trips() {
    let root = TempDir::new().unwrap();
    let dir = make_item_dir(root.path(), "BOOK", &[]);
    let mirror = metadata_mirror(Some("rec-1"), "A title");

    fs::write_metadata(&dir, &mirror).unwrap();
    let read = fs::read_metadata(&dir).unwrap().expect("mirror");

    assert_eq!(read, mirror);
}

#[test]
fn writing_the_mirror_leaves_no_temp_file_behind() {
    let root = TempDir::new().unwrap();
    let dir = make_item_dir(root.path(), "BOOK", &[]);

    fs::write_metadata(&dir, &metadata_mirror(None, "t")).unwrap();

    let names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["metadata.json"]);
}

#[test]
fn writing_the_mirror_replaces_an_existing_one() {
    let root = TempDir::new().unwrap();
    let dir = make_item_dir(root.path(), "BOOK", &[]);

    fs::write_metadata(&dir, &metadata_mirror(Some("first"), "t")).unwrap();
    fs::write_metadata(&dir, &metadata_mirror(Some("second"), "t")).unwrap();

    let read = fs::read_metadata(&dir).unwrap().unwrap();
    assert_eq!(read.backend_id.as_deref(), Some("second"));
}

#[test]
fn reading_an_absent_mirror_is_none() {
    let root = TempDir::new().unwrap();
    let dir = make_item_dir(root.path(), "BOOK", &[]);
    assert!(fs::read_metadata(&dir).unwrap().is_none());
}

// ─── finalizing job-runner outputs (Epic 06) ────────────────────────────────

#[test]
fn finalize_staged_output_moves_the_file_into_place() {
    let root = TempDir::new().unwrap();
    let dir = make_item_dir(root.path(), "BOOK", &[]);
    let staged = dir.join(".nbcg-tmp-1").join("BOOK.pdf");
    std::fs::create_dir_all(staged.parent().unwrap()).unwrap();
    std::fs::write(&staged, b"pdf bytes").unwrap();

    let target = dir.join("BOOK.pdf");
    fs::finalize_staged_output(&staged, &target).unwrap();

    assert!(
        !staged.exists(),
        "the staged file must be consumed by the rename"
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"pdf bytes");
}

#[test]
fn finalize_staged_output_replaces_an_existing_target() {
    let root = TempDir::new().unwrap();
    let dir = make_item_dir(root.path(), "BOOK", &[("BOOK.pdf", "stale")]);
    let staged = dir.join(".nbcg-tmp-1").join("BOOK.pdf");
    std::fs::create_dir_all(staged.parent().unwrap()).unwrap();
    std::fs::write(&staged, b"fresh").unwrap();

    fs::finalize_staged_output(&staged, &dir.join("BOOK.pdf")).unwrap();

    assert_eq!(std::fs::read(dir.join("BOOK.pdf")).unwrap(), b"fresh");
}

#[test]
fn finalize_staged_output_on_a_missing_staged_file_errors_without_touching_target() {
    let root = TempDir::new().unwrap();
    let dir = make_item_dir(root.path(), "BOOK", &[("BOOK.pdf", "original")]);
    let staged = dir.join(".nbcg-tmp-1").join("BOOK.pdf");

    assert!(fs::finalize_staged_output(&staged, &dir.join("BOOK.pdf")).is_err());
    assert_eq!(std::fs::read(dir.join("BOOK.pdf")).unwrap(), b"original");
}

// ─── moving across roots ─────────────────────────────────────────────────────

#[test]
fn move_to_processed_relocates_the_whole_folder() {
    let unprocessed = TempDir::new().unwrap();
    let processed = TempDir::new().unwrap();
    let dir = make_item_dir(
        unprocessed.path(),
        "BOOK",
        &[("BOOK.pdf", "web"), ("BOOK.txt", "text")],
    );

    let moved =
        fs::move_to_processed(&dir, std::path::Path::new("BOOK"), processed.path()).unwrap();

    assert!(!dir.exists(), "the source folder was left behind");
    assert!(moved.join("BOOK.pdf").is_file());
    assert!(moved.join("BOOK.txt").is_file());
    assert_eq!(moved.parent().unwrap(), processed.path());
}

#[test]
fn move_to_processed_refuses_to_clobber_an_existing_folder() {
    let unprocessed = TempDir::new().unwrap();
    let processed = TempDir::new().unwrap();
    let source = make_item_dir(unprocessed.path(), "BOOK", &[("new.txt", "new")]);
    make_item_dir(processed.path(), "BOOK", &[("existing.txt", "keep me")]);

    let outcome = fs::move_to_processed(&source, std::path::Path::new("BOOK"), processed.path());

    assert!(
        outcome.is_err(),
        "silently merging would destroy one item's work"
    );
    assert!(source.exists(), "the source must be left intact on refusal");
    assert!(processed.path().join("BOOK/existing.txt").is_file());
}

#[test]
fn move_to_processed_creates_the_destination_root_if_needed() {
    let unprocessed = TempDir::new().unwrap();
    let parent = TempDir::new().unwrap();
    let processed = parent.path().join("not-created-yet");
    let dir = make_item_dir(unprocessed.path(), "BOOK", &[]);

    let moved = fs::move_to_processed(&dir, std::path::Path::new("BOOK"), &processed).unwrap();

    assert!(moved.is_dir());
}

// ─── unicode ─────────────────────────────────────────────────────────────────

#[test]
fn a_cyrillic_folder_name_survives_scan_mirror_and_move() {
    let unprocessed = TempDir::new().unwrap();
    let processed = TempDir::new().unwrap();
    let dir = make_item_dir(
        unprocessed.path(),
        CYRILLIC,
        &[(&format!("{CYRILLIC}.pdf"), "web")],
    );

    // Scan sees it, with its derived output correctly attributed.
    let found = fs::describe_folder(&dir, ScanRoot::Unprocessed).unwrap();
    assert_eq!(found.folder_name, CYRILLIC);
    assert!(found.derived.web_pdf);

    // The mirror round-trips.
    fs::write_metadata(&dir, &metadata_mirror(Some("rec-1"), CYRILLIC)).unwrap();
    let read = fs::read_metadata(&dir).unwrap().unwrap();
    assert_eq!(read.metadata["title"], serde_json::json!(CYRILLIC));

    // And it moves.
    let moved =
        fs::move_to_processed(&dir, std::path::Path::new(CYRILLIC), processed.path()).unwrap();
    assert!(moved.join(format!("{CYRILLIC}.pdf")).is_file());
    assert!(moved.join("metadata.json").is_file());
}

// ─── misc ────────────────────────────────────────────────────────────────────

#[test]
fn path_exists_only_accepts_directories() {
    let root = TempDir::new().unwrap();
    let dir = make_item_dir(root.path(), "BOOK", &[("file.txt", "x")]);

    assert!(fs::path_exists(&dir));
    assert!(
        !fs::path_exists(&dir.join("file.txt")),
        "a file is not a valid root"
    );
    assert!(!fs::path_exists(&dir.join("nope")));
}

#[test]
fn read_file_returns_raw_bytes() {
    let root = TempDir::new().unwrap();
    let dir = make_item_dir(root.path(), "BOOK", &[("BOOK.pdf", "%PDF-1.7 body")]);

    let bytes = fs::read_file(&dir.join("BOOK.pdf")).unwrap();

    assert_eq!(bytes, b"%PDF-1.7 body");
}

#[test]
fn read_file_on_a_missing_path_is_not_found() {
    let root = TempDir::new().unwrap();
    assert!(matches!(
        fs::read_file(&root.path().join("nope.pdf")),
        Err(nbcg_dc_lib::error::AppError::NotFound(_)),
    ));
}
