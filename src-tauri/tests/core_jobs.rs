//! The real job runner (Epic 06, first slice) - `core::jobs::run_batch`
//! exercised directly, without Tauri, matching `workflow.rs`/`fs_core.rs`'s
//! style: real temp dirs, a real (in-memory) `Db`, no mocks.
//!
//! `web.py` genuinely runs here (Pillow is installed in this environment) -
//! the PDF/thumbnail path is tested end to end, on disk. `ocr.py` needs
//! paddleocr/paddlepaddle/pdf2image/poppler, none of which are installed
//! here, so only its *wiring* is pinned (the precondition-failure path,
//! which never spawns Python at all) - a live OCR pass is a residual gap,
//! same as the `py/` test suite's own.

mod common;

use std::path::Path;
use std::sync::Mutex;

use common::*;
use nbcg_dc_lib::core::db::{items, Db};
use nbcg_dc_lib::core::fs::item_id_for;
use nbcg_dc_lib::core::jobs::{self, JobEvent, JobLimits, JobRunLock};
use nbcg_dc_lib::dto::*;

/// Every pre-existing test here asserts on exact event order / `batch_complete`
/// placement, written back when the runner was strictly sequential. Force
/// that same sequential behavior so those assertions stay valid unchanged —
/// the concurrency mechanism itself gets its own dedicated tests instead
/// (see the bottom of this file), which don't depend on timing.
const SEQUENTIAL: JobLimits = JobLimits {
    max_concurrent_items: 1,
    max_concurrent_ocr: 1,
};

/// A real, tiny, valid JPEG - Rust has no image-encoding crate in this
/// project, so this is a fixture rather than generated in-test.
const TINY_JPG: &[u8] = include_bytes!("fixtures/tiny.jpg");

/// A second fixture, a visibly different color (green vs. tiny.jpg's red), so
/// a test can prove *which* source image actually became the thumbnail.
const TINY_JPG_2: &[u8] = include_bytes!("fixtures/tiny2.jpg");

/// A landscape 2-up spread: 400x200 (aspect 2.0, well over `split_spreads.py`'s
/// 1.15 threshold), **left half red, right half blue**, with a dark band down
/// the centre so gutter detection fires on a real gutter rather than falling
/// back to the exact middle. The two-colour split is what lets a test prove
/// whether an output came from half a spread or the whole one.
const SPREAD_JPG: &[u8] = include_bytes!("fixtures/spread.jpg");

/// Rust has no image-decoding crate in this project either, so read a
/// thumbnail pixel back via the same Python/Pillow this whole pipeline
/// already depends on - test-only, not part of the runner itself.
fn png_pixel_red(png_path: &Path, x: u32, y: u32) -> u8 {
    let output = std::process::Command::new("python")
        .arg("-c")
        .arg(format!(
            "from PIL import Image; img = Image.open(r'{}').convert('RGB'); print(img.getpixel(({x}, {y}))[0])",
            png_path.display(),
        ))
        .output()
        .expect("failed to run python to decode the thumbnail for verification");
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .expect("expected an integer red-channel value on stdout")
}

fn png_top_left_red(png_path: &Path) -> u8 {
    png_pixel_red(png_path, 0, 0)
}

/// Write a real multi-page PDF, one page per colour, at a scan-like size
/// (1800px tall, so the derive genuinely has to downscale to the 1600px web
/// preview). Rust has no PDF-writing crate in this project, so this goes
/// through the same Pillow the pipeline already depends on - test-only.
fn write_pdf(path: &Path, colors: &[(u8, u8, u8)]) {
    let spec = colors
        .iter()
        .map(|(r, g, b)| format!("({r},{g},{b})"))
        .collect::<Vec<_>>()
        .join(",");
    let code = format!(
        "from PIL import Image\n\
         pages = [Image.new('RGB', (1200, 1800), c) for c in [{spec}]]\n\
         pages[0].save(r'{}', save_all=True, append_images=pages[1:], resolution=300)\n",
        path.display(),
    );
    let output = std::process::Command::new("python")
        .arg("-c")
        .arg(code)
        .output()
        .expect("failed to run python to build a test PDF");
    assert!(
        output.status.success(),
        "building the test PDF failed: {}",
        String::from_utf8_lossy(&output.stderr),
    );
}

/// The PDFs sitting directly in `dir` - the count that decides whether the
/// next scan reads the folder as `supplied-pdf` or `multiple-pdfs`.
fn pdfs_in_root(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.to_lowercase().ends_with(".pdf"))
        .collect();
    names.sort();
    names
}

fn discovered(name: &str, dir: &Path) -> nbcg_dc_lib::core::fs::DiscoveredFolder {
    let mut f = folder(name, ScanRoot::Unprocessed);
    f.id = item_id_for(name);
    f.folder_path = dir.to_string_lossy().into_owned();
    f
}

/// `reconcile` treats its argument as the *complete* current state and drops
/// any item not in it - so reconciling one folder at a time would delete the
/// previous one. Every test that needs more than one item must reconcile
/// them together, in a single call, like a real scan would.
fn reconciled_item(db: &Db, name: &str, dir: &Path) -> String {
    let f = discovered(name, dir);
    let id = f.id.clone();
    db.with(|c| items::reconcile(c, &[f])).unwrap();
    id
}

fn page_images_item(
    item_id: &str,
    dir: &Path,
    folder_name: &str,
    stages: Vec<RunnableStage>,
    page_images: Vec<&str>,
) -> ItemRunRequest {
    ItemRunRequest {
        item_id: item_id.to_string(),
        folder_path: dir.to_string_lossy().into_owned(),
        folder_name: folder_name.to_string(),
        input_shape: InputShape::PageImages,
        stages,
        primary_thumbnail: None,
        thumbnail_needs_choice: false,
        web_pdf_bases: Vec::new(),
        page_images: page_images.into_iter().map(String::from).collect(),
        split_spreads: false,
    }
}

fn stage_changed_statuses(events: &[JobEvent], stage: StageName) -> Vec<StageStatus> {
    events
        .iter()
        .filter_map(|e| match e {
            JobEvent::StageChanged(p) if p.stage == stage => Some(p.status),
            _ => None,
        })
        .collect()
}

fn done_events(events: &[JobEvent]) -> Vec<&JobDoneEvent> {
    events
        .iter()
        .filter_map(|e| match e {
            JobEvent::Done(p) => Some(p),
            _ => None,
        })
        .collect()
}

#[test]
fn page_images_pdf_and_thumbnail_run_for_real() {
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("BOOK");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("1.jpg"), TINY_JPG).unwrap();
    std::fs::write(dir.join("2.jpg"), TINY_JPG).unwrap();

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "BOOK", &dir);

    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Run,
        items: vec![page_images_item(
            &item_id,
            &dir,
            "BOOK",
            vec![RunnableStage::Pdf, RunnableStage::Thumbnail],
            vec!["1.jpg", "2.jpg"],
        )],
    };

    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    let mut events = Vec::new();
    jobs::run_batch(&db, &request, &guard, SEQUENTIAL, |e| events.push(e)).unwrap();
    drop(guard);

    // Real outputs on disk, correctly named, no archival PDF for a flat-JPG item.
    assert!(dir.join("BOOK.pdf").is_file());
    assert!(dir.join("BOOK_thumb.png").is_file());
    assert!(!dir.join("BOOK_archive.pdf").exists());
    // The staging dir must never survive a successful run.
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 4); // 1.jpg, 2.jpg, BOOK.pdf, BOOK_thumb.png

    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    assert_eq!(stored.stages[&StageName::Pdf].status, StageStatus::Done);
    assert_eq!(
        stored.stages[&StageName::Thumbnail].status,
        StageStatus::Done
    );

    // Every requested stage transitions queued -> running -> done.
    for stage in [StageName::Pdf, StageName::Thumbnail] {
        let statuses = stage_changed_statuses(&events, stage);
        assert_eq!(
            statuses,
            vec![StageStatus::Queued, StageStatus::Running, StageStatus::Done],
            "unexpected transitions for {stage:?}",
        );
    }

    let done = done_events(&events);
    assert_eq!(done.len(), 2);
    assert_eq!(done[0].outcome, JobOutcome::Done);
    assert!(!done[0].batch_complete);
    assert!(done[1].item_id.is_none());
    assert!(done[1].batch_complete);
}

#[test]
fn page_images_shape_is_not_misclassified_as_paired_by_web_pys_own_folder_sniffing() {
    // The exact bug this test pins: web.py used to decide flat-vs-paired by
    // scanning the folder itself (is_pair_folder() takes precedence over
    // flat), independent of what the .ts lane already decided. A folder that
    // is genuinely page-images (real page JPGs directly inside it) but
    // *also* happens to contain a jpg/+tif/ subfolder pair - e.g. leftover
    // from an old workflow, or an unrelated pair of source images someone
    // dropped in - would auto-detect as "paired" and get processed from the
    // wrong source entirely, silently. Passing `ItemRunRequest.inputShape`
    // through as `web.py --mode` closes that: the runner's own answer always
    // wins, web.py never re-derives a second, possibly-disagreeing one.
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("BOOK");
    std::fs::create_dir_all(&dir).unwrap();
    // The real, intended pages.
    std::fs::write(dir.join("1.jpg"), TINY_JPG).unwrap();
    std::fs::write(dir.join("2.jpg"), TINY_JPG).unwrap();
    // A red herring: an unrelated jpg/tif pair that would make
    // is_pair_folder() return true if web.py were left to auto-detect.
    std::fs::create_dir_all(dir.join("jpg")).unwrap();
    std::fs::create_dir_all(dir.join("tif")).unwrap();
    std::fs::write(dir.join("jpg").join("a.jpg"), TINY_JPG_2).unwrap();
    std::fs::write(dir.join("tif").join("a.tif"), TINY_JPG_2).unwrap();

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "BOOK", &dir);

    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Run,
        items: vec![page_images_item(
            &item_id,
            &dir,
            "BOOK",
            vec![RunnableStage::Pdf],
            vec!["1.jpg", "2.jpg"],
        )],
    };

    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    let mut events = Vec::new();
    jobs::run_batch(&db, &request, &guard, SEQUENTIAL, |e| events.push(e)).unwrap();
    drop(guard);

    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    assert_eq!(
        stored.stages[&StageName::Pdf].status,
        StageStatus::Done,
        "run failed: {:?}",
        stored.stages[&StageName::Pdf].error
    );

    assert!(dir.join("BOOK.pdf").is_file());
    // The single strongest signal: only paired mode ever produces this file.
    // Its absence alone proves flat mode ran, not a folder-sniffed "paired".
    assert!(
        !dir.join("BOOK_archive.pdf").exists(),
        "an archival PDF means the jpg/tif red herring was (wrongly) used - \
         web.py re-sniffed the folder instead of trusting --mode",
    );
}

/// Build the item and run it, returning the thumbnail's red channel well
/// inside the right-hand side of the image (x=400 of a 500px-wide thumbnail).
///
/// That single number separates the two outcomes unambiguously: a thumbnail
/// built from the *left half* of the spread is red there (~220), one built
/// from the whole unsplit spread is blue there (~20).
fn spread_thumbnail_right_side_red(split_spreads: bool) -> u8 {
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("BOOK");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("1.jpg"), SPREAD_JPG).unwrap();

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "BOOK", &dir);

    let mut item = page_images_item(
        &item_id,
        &dir,
        "BOOK",
        vec![RunnableStage::Pdf, RunnableStage::Thumbnail],
        vec!["1.jpg"],
    );
    item.split_spreads = split_spreads;

    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Run,
        items: vec![item],
    };

    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    jobs::run_batch(&db, &request, &guard, SEQUENTIAL, |_| {}).unwrap();
    drop(guard);

    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    assert_eq!(
        stored.stages[&StageName::Pdf].status,
        StageStatus::Done,
        "run failed: {:?}",
        stored.stages[&StageName::Pdf].error
    );
    // Outputs are still named after the item, never after the staging folder
    // the split pages were assembled from.
    assert!(dir.join("BOOK.pdf").is_file());
    assert!(
        std::fs::read_dir(&dir).unwrap().count() == 3,
        "staging must never survive a successful run",
    );

    png_pixel_red(&dir.join("BOOK_thumb.png"), 400, 10)
}

#[test]
fn split_spreads_halves_each_scan_before_the_pdf_is_assembled() {
    // `ItemRunRequest.splitSpreads` used to reach the runner and be dropped:
    // an operator turning it on got byte-identical output to leaving it off,
    // and a 2-up book (ОКТОИХ петогласник 2 - 162 landscape scans, ~324 real
    // pages) assembled with two pages on every sheet. It builds, it opens,
    // nothing fails - only a reader notices. Hence a signal that cannot be
    // faked by the flag merely being *read*: the thumbnail's right-hand side
    // is red only if the page it came from really was cut at the gutter.
    let split = spread_thumbnail_right_side_red(true);
    let unsplit = spread_thumbnail_right_side_red(false);

    assert!(
        split > 150,
        "expected the left half of the spread (red) to be the first page, \
         got red={split} on the right-hand side of the thumbnail - the \
         spread was not split",
    );
    assert!(
        unsplit < 100,
        "expected the whole unsplit spread (blue on the right), got red={unsplit}",
    );
}

#[test]
fn split_spreads_keeps_the_operators_thumbnail_pick_unsplit() {
    // A chosen thumbnail is a decision about a whole image - typically the
    // cover, which in a book of spreads is the one image that must *not* be
    // cut in half (docs/05 open question #5). It also must not be dragged into
    // the split at all: `cover.jpg` is not in `pageImages`, so `--pages` alone
    // should keep split_spreads.py away from it.
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("BOOK");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("1.jpg"), TINY_JPG).unwrap();
    std::fs::write(dir.join("2.jpg"), TINY_JPG).unwrap();
    std::fs::write(dir.join("cover.jpg"), SPREAD_JPG).unwrap();

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "BOOK", &dir);

    let mut item = page_images_item(
        &item_id,
        &dir,
        "BOOK",
        vec![RunnableStage::Pdf, RunnableStage::Thumbnail],
        vec!["1.jpg", "2.jpg"],
    );
    item.split_spreads = true;
    item.primary_thumbnail = Some("cover.jpg".to_string());

    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Run,
        items: vec![item],
    };

    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    jobs::run_batch(&db, &request, &guard, SEQUENTIAL, |_| {}).unwrap();
    drop(guard);

    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    assert_eq!(
        stored.stages[&StageName::Thumbnail].status,
        StageStatus::Done,
        "run failed: {:?}",
        stored.stages[&StageName::Thumbnail].error
    );

    // Blue on the right = the whole spread, not the red left half of it.
    let red = png_pixel_red(&dir.join("BOOK_thumb.png"), 400, 10);
    assert!(
        red < 100,
        "the chosen thumbnail was built from a split half (red={red}); it \
         must come from the unsplit original",
    );
    // And the original itself is untouched, as always.
    assert_eq!(std::fs::read(dir.join("cover.jpg")).unwrap(), SPREAD_JPG);
}

#[test]
fn split_spreads_on_a_tiffs_item_fails_clearly_instead_of_being_ignored() {
    // The archival master has to come from the TIFFs at full fidelity, so
    // there is no correct way to honour the flag here. Refusing out loud is
    // the point: quietly building the un-split PDF anyway is exactly the
    // failure mode this whole change exists to remove.
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("PAIRED");
    std::fs::create_dir_all(dir.join("jpg")).unwrap();
    std::fs::create_dir_all(dir.join("tif")).unwrap();
    std::fs::write(dir.join("jpg").join("1.jpg"), TINY_JPG).unwrap();
    std::fs::write(dir.join("tif").join("1.tif"), TINY_JPG).unwrap();

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "PAIRED", &dir);

    let mut item = page_images_item(
        &item_id,
        &dir,
        "PAIRED",
        vec![RunnableStage::Pdf],
        Vec::new(),
    );
    item.input_shape = InputShape::Tiffs;
    item.split_spreads = true;

    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Run,
        items: vec![item],
    };

    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    let mut events = Vec::new();
    jobs::run_batch(&db, &request, &guard, SEQUENTIAL, |e| events.push(e)).unwrap();
    drop(guard);

    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    assert_eq!(stored.stages[&StageName::Pdf].status, StageStatus::Failed);
    let error = stored.stages[&StageName::Pdf].error.clone().unwrap();
    assert!(
        error.contains("split-spreads"),
        "unhelpful error message: {error}",
    );
    assert!(!dir.join("PAIRED.pdf").exists());
    assert!(!dir.join("PAIRED_archive.pdf").exists());

    let done = done_events(&events);
    assert_eq!(done.len(), 2);
    assert_eq!(done[0].outcome, JobOutcome::Failed);
    assert!(!done[0].batch_complete);
    assert!(done[1].item_id.is_none());
    assert!(done[1].batch_complete);
}

/// Run one item to completion and hand back the events, for the PDF-shape
/// tests that all need the same scaffolding.
fn run_one(db: &Db, item: ItemRunRequest) -> Vec<JobEvent> {
    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Run,
        items: vec![item],
    };
    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    let mut events = Vec::new();
    jobs::run_batch(db, &request, &guard, SEQUENTIAL, |e| events.push(e)).unwrap();
    drop(guard);
    events
}

#[test]
fn supplied_pdf_derives_the_web_pdf_and_files_the_original_under_source() {
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("Pisma iz Liona");
    std::fs::create_dir_all(&dir).unwrap();
    // The real corpus's case: the supplied PDF's name has nothing to do with
    // the folder's, so the derived output cannot be inferred from it.
    let supplied = dir.join("Писма из Лиона_(310).pdf");
    write_pdf(&supplied, &[(220, 20, 20), (20, 20, 220)]);
    let original_bytes = std::fs::read(&supplied).unwrap();

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "Pisma iz Liona", &dir);

    let mut item = page_images_item(
        &item_id,
        &dir,
        "Pisma iz Liona",
        vec![RunnableStage::Pdf, RunnableStage::Thumbnail],
        Vec::new(),
    );
    item.input_shape = InputShape::SuppliedPdf;
    item.web_pdf_bases = vec!["Pisma iz Liona".to_string()];

    run_one(&db, item);

    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    assert_eq!(
        stored.stages[&StageName::Pdf].status,
        StageStatus::Done,
        "run failed: {:?}",
        stored.stages[&StageName::Pdf].error
    );

    assert!(dir.join("Pisma iz Liona.pdf").is_file());
    assert!(dir.join("Pisma iz Liona_thumb.png").is_file());

    // The original is preserved byte-for-byte, just filed out of the way.
    let filed = dir.join("source").join("Писма из Лиона_(310).pdf");
    assert!(filed.is_file(), "the original was not filed under source/");
    assert_eq!(std::fs::read(&filed).unwrap(), original_bytes);

    // THE assertion. Two PDFs in the root would make `classifyInput` read this
    // folder as `multiple-pdfs` on the next scan - the item would silently
    // change shape and the full-size original would upload as a web asset.
    assert_eq!(
        pdfs_in_root(&dir),
        vec!["Pisma iz Liona.pdf".to_string()],
        "the folder root must hold exactly one PDF, or the shape flips",
    );
}

#[test]
fn supplied_pdf_rerun_derives_from_the_filed_original_not_the_previous_output() {
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("BOOK");
    std::fs::create_dir_all(&dir).unwrap();
    let supplied = dir.join("scan-output-4471.pdf");
    write_pdf(&supplied, &[(220, 20, 20), (20, 20, 220)]);
    let original_bytes = std::fs::read(&supplied).unwrap();

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "BOOK", &dir);

    let build = || {
        let mut item = page_images_item(
            &item_id,
            &dir,
            "BOOK",
            vec![RunnableStage::Pdf, RunnableStage::Thumbnail],
            Vec::new(),
        );
        item.input_shape = InputShape::SuppliedPdf;
        item
    };

    run_one(&db, build());
    assert!(dir.join("BOOK.pdf").is_file());

    // Remove the derived PDF, leaving *no* PDF in the folder root at all. A
    // second run can only succeed by reading the filed original - which is
    // the point: deriving from the previous output instead would downscale a
    // downscale, and the web PDF would rot a little more every rerun.
    std::fs::remove_file(dir.join("BOOK.pdf")).unwrap();
    assert_eq!(pdfs_in_root(&dir), Vec::<String>::new());

    run_one(&db, build());

    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    assert_eq!(
        stored.stages[&StageName::Pdf].status,
        StageStatus::Done,
        "the rerun failed: {:?}",
        stored.stages[&StageName::Pdf].error
    );
    assert!(dir.join("BOOK.pdf").is_file());
    // Filed once, never re-filed, never touched.
    assert_eq!(
        std::fs::read(dir.join("source").join("scan-output-4471.pdf")).unwrap(),
        original_bytes,
    );
    assert_eq!(pdfs_in_root(&dir), vec!["BOOK.pdf".to_string()]);
}

#[test]
fn multiple_pdfs_never_rewrites_the_operators_pdfs() {
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("SERIAL");
    std::fs::create_dir_all(&dir).unwrap();
    write_pdf(&dir.join("vol1.pdf"), &[(220, 20, 20)]);
    write_pdf(&dir.join("vol2.pdf"), &[(20, 20, 220)]);
    let vol1_bytes = std::fs::read(dir.join("vol1.pdf")).unwrap();
    let vol2_bytes = std::fs::read(dir.join("vol2.pdf")).unwrap();

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "SERIAL", &dir);

    let mut item = page_images_item(
        &item_id,
        &dir,
        "SERIAL",
        vec![RunnableStage::Pdf, RunnableStage::Thumbnail],
        Vec::new(),
    );
    item.input_shape = InputShape::MultiplePdfs;
    item.web_pdf_bases = vec!["vol1".to_string(), "vol2".to_string()];
    // Two PDFs means two first-page candidates, so the operator must choose.
    item.thumbnail_needs_choice = true;

    run_one(&db, item);

    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    assert_eq!(
        stored.stages[&StageName::Pdf].status,
        StageStatus::Done,
        "pdf stage failed: {:?}",
        stored.stages[&StageName::Pdf].error
    );

    // The whole point of the no-op `pdf` stage: the operator's PDFs are the
    // web PDFs and must come through untouched.
    assert_eq!(std::fs::read(dir.join("vol1.pdf")).unwrap(), vol1_bytes);
    assert_eq!(std::fs::read(dir.join("vol2.pdf")).unwrap(), vol2_bytes);
    assert_eq!(
        pdfs_in_root(&dir),
        vec!["vol1.pdf".to_string(), "vol2.pdf".to_string()],
        "no PDF may be added or removed for a multiple-pdfs item",
    );

    // One thumbnail candidate per PDF, each from its own first page.
    assert!(dir.join("vol1_thumb.png").is_file());
    assert!(dir.join("vol2_thumb.png").is_file());
    assert!(png_pixel_red(&dir.join("vol1_thumb.png"), 250, 10) > 150);
    assert!(png_pixel_red(&dir.join("vol2_thumb.png"), 250, 10) < 100);

    // Candidates exist, but the choice is still the operator's.
    assert_eq!(
        stored.stages[&StageName::Thumbnail].status,
        StageStatus::Pending,
    );
    assert!(!dir.join("SERIAL_thumb.png").exists());
}

#[test]
fn multiple_pdfs_normalises_the_operators_pick_to_the_items_own_thumbnail() {
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("SERIAL");
    std::fs::create_dir_all(&dir).unwrap();
    write_pdf(&dir.join("vol1.pdf"), &[(220, 20, 20)]);
    write_pdf(&dir.join("vol2.pdf"), &[(20, 20, 220)]);

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "SERIAL", &dir);

    let mut item = page_images_item(
        &item_id,
        &dir,
        "SERIAL",
        vec![RunnableStage::Thumbnail],
        Vec::new(),
    );
    item.input_shape = InputShape::MultiplePdfs;
    item.web_pdf_bases = vec!["vol1".to_string(), "vol2".to_string()];
    // The operator has picked the *second* volume's candidate.
    item.primary_thumbnail = Some("vol2_thumb.png".to_string());
    item.thumbnail_needs_choice = false;

    run_one(&db, item);

    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    assert_eq!(
        stored.stages[&StageName::Thumbnail].status,
        StageStatus::Done,
        "thumbnail stage failed: {:?}",
        stored.stages[&StageName::Thumbnail].error
    );

    // Blue, not red - the pick was honoured rather than the first candidate.
    let red = png_pixel_red(&dir.join("SERIAL_thumb.png"), 250, 10);
    assert!(
        red < 100,
        "the item thumbnail came from vol1 (red={red}), not the operator's vol2 pick",
    );
}

#[test]
fn multiple_pdfs_ocr_precondition_names_the_specific_missing_pdf() {
    // One `.txt` per web PDF is the multi-PDF invariant, so the precondition
    // has to be checked per base - and say *which* one is missing, or an
    // operator with eight volumes learns nothing from the error.
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("SERIAL");
    std::fs::create_dir_all(&dir).unwrap();
    write_pdf(&dir.join("vol1.pdf"), &[(220, 20, 20)]);

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "SERIAL", &dir);

    let mut item = page_images_item(
        &item_id,
        &dir,
        "SERIAL",
        vec![RunnableStage::Ocr],
        Vec::new(),
    );
    item.input_shape = InputShape::MultiplePdfs;
    item.web_pdf_bases = vec!["vol1".to_string(), "vol2".to_string()];

    run_one(&db, item);

    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    assert_eq!(stored.stages[&StageName::Ocr].status, StageStatus::Failed);
    let error = stored.stages[&StageName::Ocr].error.clone().unwrap();
    assert!(
        error.contains("vol2"),
        "error does not name the culprit: {error}"
    );
    // vol1 exists, so nothing should have been OCR'd - the precondition is
    // checked for every base before any run starts.
    assert!(!dir.join("vol1.txt").exists());
}

#[test]
fn thumbnail_needs_choice_withholds_done_and_leaves_it_pending() {
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("BOOK");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("1.jpg"), TINY_JPG).unwrap();

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "BOOK", &dir);

    let mut item = page_images_item(
        &item_id,
        &dir,
        "BOOK",
        vec![RunnableStage::Pdf, RunnableStage::Thumbnail],
        vec!["1.jpg"],
    );
    item.thumbnail_needs_choice = true;

    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Run,
        items: vec![item],
    };

    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    let mut events = Vec::new();
    jobs::run_batch(&db, &request, &guard, SEQUENTIAL, |e| events.push(e)).unwrap();
    drop(guard);

    // web.py still produced a candidate thumbnail on disk...
    assert!(dir.join("BOOK_thumb.png").is_file());

    // ...but the stage must not read Done, so a later skip-if-done pass
    // still offers the operator a choice.
    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    assert_eq!(stored.stages[&StageName::Pdf].status, StageStatus::Done);
    assert_eq!(
        stored.stages[&StageName::Thumbnail].status,
        StageStatus::Pending
    );

    // Pdf alone still counts as progress - the item's overall outcome is Done.
    let done = done_events(&events);
    assert_eq!(done[0].outcome, JobOutcome::Done);
}

#[test]
fn images_only_thumbnail_only_never_builds_a_pdf() {
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("MAP");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("map.jpg"), TINY_JPG).unwrap();

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "MAP", &dir);

    let item = ItemRunRequest {
        item_id: item_id.clone(),
        folder_path: dir.to_string_lossy().into_owned(),
        folder_name: "MAP".to_string(),
        input_shape: InputShape::ImagesOnly,
        stages: vec![
            RunnableStage::Pdf,
            RunnableStage::Thumbnail,
            RunnableStage::Ocr,
        ],
        primary_thumbnail: None,
        thumbnail_needs_choice: false,
        web_pdf_bases: Vec::new(),
        page_images: Vec::new(),
        split_spreads: false,
    };

    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Run,
        items: vec![item],
    };

    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    let mut events = Vec::new();
    jobs::run_batch(&db, &request, &guard, SEQUENTIAL, |e| events.push(e)).unwrap();
    drop(guard);

    assert!(dir.join("MAP_thumb.png").is_file());
    assert!(!dir.join("MAP.pdf").exists());

    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    assert_eq!(
        stored.stages[&StageName::Thumbnail].status,
        StageStatus::Done
    );
    assert_eq!(stored.stages[&StageName::Pdf].status, StageStatus::Skipped);
    assert_eq!(stored.stages[&StageName::Ocr].status, StageStatus::Skipped);
}

#[test]
fn images_only_honours_the_tagged_thumbnail_over_the_natural_first_image() {
    // The exact bug this test pins: a folder with two standalone images,
    // one conventionally named "thumbnail" - domain/files.ts's autoThumbnail
    // picks the tagged file even though it isn't first alphabetically/
    // naturally, so `needs_choice` is false and `primary_thumbnail` names it.
    // Before this fix, the runner ignored `primary_thumbnail` entirely and
    // always used the natural-first image - silently uploading the wrong
    // picture while reporting the stage Done.
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("MAP");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("map.jpg"), TINY_JPG).unwrap(); // natural-first; red
    std::fs::write(dir.join("thumbnail.jpg"), TINY_JPG_2).unwrap(); // tagged; green

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "MAP", &dir);

    let item = ItemRunRequest {
        item_id: item_id.clone(),
        folder_path: dir.to_string_lossy().into_owned(),
        folder_name: "MAP".to_string(),
        input_shape: InputShape::ImagesOnly,
        stages: vec![RunnableStage::Thumbnail],
        primary_thumbnail: Some("thumbnail.jpg".to_string()),
        thumbnail_needs_choice: false,
        web_pdf_bases: Vec::new(),
        page_images: Vec::new(),
        split_spreads: false,
    };

    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Run,
        items: vec![item],
    };

    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    let mut events = Vec::new();
    jobs::run_batch(&db, &request, &guard, SEQUENTIAL, |e| events.push(e)).unwrap();
    drop(guard);

    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    assert_eq!(
        stored.stages[&StageName::Thumbnail].status,
        StageStatus::Done
    );

    let red = png_top_left_red(&dir.join("MAP_thumb.png"));
    assert!(
        red < 100,
        "thumbnail should be built from thumbnail.jpg (green, low red channel), got red={red} - looks like the natural-first image (map.jpg, red) was used instead",
    );
}

#[test]
fn ocr_without_a_pdf_fails_on_the_precondition_and_never_spawns_python() {
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("BOOK");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("1.jpg"), TINY_JPG).unwrap();

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "BOOK", &dir);

    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Run,
        items: vec![page_images_item(
            &item_id,
            &dir,
            "BOOK",
            vec![RunnableStage::Ocr],
            vec!["1.jpg"],
        )],
    };

    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    let mut events = Vec::new();
    jobs::run_batch(&db, &request, &guard, SEQUENTIAL, |e| events.push(e)).unwrap();
    drop(guard);

    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    let ocr = &stored.stages[&StageName::Ocr];
    assert_eq!(ocr.status, StageStatus::Failed);
    // This exact message only comes from the Rust-side precondition check in
    // run_ocr_stage, which returns *before* ever calling python::run_ocr - a
    // real spawn attempt (with no paddleocr installed here) would instead
    // fail with a "did not print a parseable JSON summary" / exit-code style
    // message. Getting this one is itself the proof python was never spawned.
    assert!(ocr
        .error
        .as_deref()
        .unwrap()
        .contains("run the pdf stage first"));

    // No "running" transition either - the stage never got that far.
    assert!(!stage_changed_statuses(&events, StageName::Ocr).contains(&StageStatus::Running));

    let done = done_events(&events);
    assert_eq!(done[0].outcome, JobOutcome::Failed);
}

#[test]
fn a_shape_with_nothing_to_run_fails_that_item_but_the_batch_continues() {
    let root = tempfile::TempDir::new().unwrap();

    let dir_a = root.path().join("UNSUPPORTED");
    std::fs::create_dir_all(&dir_a).unwrap();
    let dir_b = root.path().join("BOOK");
    std::fs::create_dir_all(&dir_b).unwrap();
    std::fs::write(dir_b.join("1.jpg"), TINY_JPG).unwrap();

    let db = Db::open_in_memory().unwrap();
    let f_a = discovered("UNSUPPORTED", &dir_a);
    let f_b = discovered("BOOK", &dir_b);
    let id_a = f_a.id.clone();
    let id_b = f_b.id.clone();
    db.with(|c| items::reconcile(c, &[f_a, f_b])).unwrap();

    let mut item_a = page_images_item(
        &id_a,
        &dir_a,
        "UNSUPPORTED",
        vec![RunnableStage::Pdf],
        vec![],
    );
    // `Empty` is the one shape with no work to do at all. TS shouldn't send
    // stages for it; if it ever does, the item fails on its own rather than
    // taking the batch down with it.
    item_a.input_shape = InputShape::Empty;

    let item_b = page_images_item(
        &id_b,
        &dir_b,
        "BOOK",
        vec![RunnableStage::Thumbnail],
        vec!["1.jpg"],
    );

    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Run,
        items: vec![item_a, item_b],
    };

    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    let mut events = Vec::new();
    jobs::run_batch(&db, &request, &guard, SEQUENTIAL, |e| events.push(e)).unwrap();
    drop(guard);

    let stored_a = db.with(|c| items::get(c, &id_a)).unwrap();
    assert_eq!(stored_a.stages[&StageName::Pdf].status, StageStatus::Failed);
    assert!(stored_a.stages[&StageName::Pdf]
        .error
        .as_deref()
        .unwrap()
        .contains("nothing to run"));

    // The second, supported item is unaffected - one bad item does not abort the batch.
    let stored_b = db.with(|c| items::get(c, &id_b)).unwrap();
    assert_eq!(
        stored_b.stages[&StageName::Thumbnail].status,
        StageStatus::Done
    );
    assert!(dir_b.join("BOOK_thumb.png").is_file());

    let done = done_events(&events);
    assert_eq!(done.len(), 3);
    assert_eq!(done[0].outcome, JobOutcome::Failed);
    assert!(!done[0].batch_complete);
    assert_eq!(done[1].outcome, JobOutcome::Done);
    assert!(!done[1].batch_complete);
    assert!(done[2].item_id.is_none());
    assert!(done[2].batch_complete);
}

#[test]
fn an_empty_batch_still_emits_a_terminal_done_event() {
    let db = Db::open_in_memory().unwrap();
    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Run,
        items: vec![],
    };

    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    let mut events = Vec::new();
    jobs::run_batch(&db, &request, &guard, SEQUENTIAL, |e| events.push(e)).unwrap();
    drop(guard);

    let done = done_events(&events);
    assert_eq!(done.len(), 1);
    assert!(done[0].item_id.is_none());
    assert!(done[0].batch_complete);
}

// ─── single-run lock ──────────────────────────────────────────────────────────

#[test]
fn a_second_batch_is_rejected_while_the_first_holds_the_lock() {
    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());

    let guard = jobs::try_acquire(&lock, "batch-1").unwrap();
    assert!(jobs::try_acquire(&lock, "batch-2").is_err());

    // Releasing the guard - not just letting it go out of scope elsewhere -
    // must free the lock immediately, whether the run succeeded or not.
    drop(guard);
    assert!(jobs::try_acquire(&lock, "batch-2").is_ok());
}

#[test]
fn cancel_only_matches_the_currently_running_batch() {
    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let _guard = jobs::try_acquire(&lock, "batch-1").unwrap();

    assert!(!jobs::request_cancel(&lock, "batch-2"));
    assert!(jobs::request_cancel(&lock, "batch-1"));
}

// ─── mid-process cancellation ─────────────────────────────────────────────────
//
// `jobs_start` used to be a synchronous `#[tauri::command]`, which Tauri runs
// on the main thread - so `jobs_cancel` (also an invoke) could never be
// delivered until the run it was meant to cancel had already finished. Fixed
// by making the command `async` and giving `core::python` an actual
// `Command::kill()` path. These two tests pin what `run_batch` itself
// guarantees once a cancel reaches it - they don't touch the Tauri layer,
// which has no logic worth testing per this module's own convention.

#[test]
fn a_cancel_before_the_run_leaves_every_stage_pending_not_queued() {
    // The exact bug this test pins: `run_batch` queues every stage of every
    // item up front, and used to never reset that on the cancel path - so a
    // batch cancelled before it even started left every stage stuck `Queued`
    // in SQLite forever (`stagesToRun` would still re-run them, but the
    // operator would see a batch that looks permanently mid-run).
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("BOOK");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("1.jpg"), TINY_JPG).unwrap();
    std::fs::write(dir.join("2.jpg"), TINY_JPG).unwrap();

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "BOOK", &dir);

    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Run,
        items: vec![page_images_item(
            &item_id,
            &dir,
            "BOOK",
            vec![RunnableStage::Pdf, RunnableStage::Thumbnail],
            vec!["1.jpg", "2.jpg"],
        )],
    };

    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    jobs::request_cancel(&lock, &request.batch_id);

    let mut events = Vec::new();
    jobs::run_batch(&db, &request, &guard, SEQUENTIAL, |e| events.push(e)).unwrap();
    drop(guard);

    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    for stage in [StageName::Pdf, StageName::Thumbnail] {
        assert_eq!(
            stored.stages[&stage].status,
            StageStatus::Pending,
            "a cancel-before-start batch must leave stages Pending, not stuck Queued",
        );
    }
    // No python process was ever spawned - the folder still holds only its
    // two source images.
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);

    let done = done_events(&events);
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].outcome, JobOutcome::Cancelled);
    assert!(done[0].item_id.is_none());
    assert!(done[0].batch_complete);
}

#[test]
fn a_cancel_mid_run_settles_the_interrupted_stage_pending_not_failed() {
    // Cancel from inside the `emit` closure the instant the first stage goes
    // `Running`. `run_web_stage` emits that event *before* spawning
    // `web.py` (`set_stage_status` happens first, the script runs after), so
    // the cancel token is set before the child ever starts - the kill path
    // in `core::python::spawn_and_wait` fires on its very first poll,
    // deterministically, rather than racing a sleep against real work.
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("BOOK");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("1.jpg"), TINY_JPG).unwrap();
    std::fs::write(dir.join("2.jpg"), TINY_JPG).unwrap();

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "BOOK", &dir);

    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Run,
        items: vec![page_images_item(
            &item_id,
            &dir,
            "BOOK",
            vec![RunnableStage::Pdf, RunnableStage::Thumbnail],
            vec!["1.jpg", "2.jpg"],
        )],
    };

    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    let cancel = guard.cancel_token();

    let mut events = Vec::new();
    jobs::run_batch(&db, &request, &guard, SEQUENTIAL, |e| {
        if let JobEvent::StageChanged(p) = &e {
            if p.status == StageStatus::Running {
                cancel.cancel();
            }
        }
        events.push(e);
    })
    .unwrap();
    drop(guard);

    // Neither stage this call was resolving reads Failed - a cancel is not a
    // failure, per the operator's decision.
    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    for stage in [StageName::Pdf, StageName::Thumbnail] {
        assert_ne!(
            stored.stages[&stage].status,
            StageStatus::Failed,
            "a cancel must never read as a failure for {stage:?}",
        );
    }

    // Only the batch-level terminal event fires - no misleading per-item
    // Done for the item the cancel actually landed on.
    let done = done_events(&events);
    assert_eq!(
        done.len(),
        1,
        "expected only the terminal batch-level Done event"
    );
    assert_eq!(done[0].outcome, JobOutcome::Cancelled);
    assert!(done[0].item_id.is_none());
    assert!(done[0].batch_complete);

    // The staging dir is always cleaned up, cancel or not.
    assert!(
        std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .all(|e| !e.file_name().to_string_lossy().starts_with(".nbcg-tmp-")),
        "a killed run must not leave its staging directory behind",
    );
}

#[test]
fn a_cancel_mid_run_settles_ocr_pending_too_not_a_stale_precondition_failure() {
    // Pins a regression found smoke-testing against real archive data:
    // `run_pdf_thumbnail_ocr` called `run_web_stage` then `run_ocr_stage`
    // with no cancel check between them. A cancel landing mid-`run_web_stage`
    // correctly settled pdf/thumbnail to Pending via `settle_web_stages`'s
    // `is_cancelled` arm - but `run_ocr_stage`'s synchronous "does the web
    // PDF exist" precondition ran unconditionally regardless, and since the
    // PDF was never built, it always failed *permanently*, telling the
    // operator to "run the pdf stage first" even though pdf/thumbnail had
    // already reset to Pending and would rerun on the very next Start.
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("BOOK");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("1.jpg"), TINY_JPG).unwrap();
    std::fs::write(dir.join("2.jpg"), TINY_JPG).unwrap();

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "BOOK", &dir);

    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Run,
        items: vec![page_images_item(
            &item_id,
            &dir,
            "BOOK",
            vec![
                RunnableStage::Pdf,
                RunnableStage::Thumbnail,
                RunnableStage::Ocr,
            ],
            vec!["1.jpg", "2.jpg"],
        )],
    };

    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    let cancel = guard.cancel_token();

    let mut events = Vec::new();
    jobs::run_batch(&db, &request, &guard, SEQUENTIAL, |e| {
        if let JobEvent::StageChanged(p) = &e {
            if p.status == StageStatus::Running {
                cancel.cancel();
            }
        }
        events.push(e);
    })
    .unwrap();
    drop(guard);

    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    for stage in [StageName::Pdf, StageName::Thumbnail, StageName::Ocr] {
        assert_eq!(
            stored.stages[&stage].status,
            StageStatus::Pending,
            "{stage:?} must settle Pending on a cancel, never Failed",
        );
    }
    assert!(
        stored.stages[&StageName::Ocr].error.is_none(),
        "a cancelled OCR stage must carry no stale 'run the pdf stage first' error",
    );

    let done = done_events(&events);
    assert_eq!(
        done.len(),
        1,
        "expected only the terminal batch-level Done event"
    );
    assert_eq!(done[0].outcome, JobOutcome::Cancelled);
    assert!(done[0].item_id.is_none());
    assert!(done[0].batch_complete);

    // web.py was killed before writing BOOK.pdf; ocr.py was never spawned at
    // all - the folder holds nothing beyond the two source images.
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
}

// ─── concurrency (default, non-`SEQUENTIAL` limits) ────────────────────────

/// Real concurrency, not the `SEQUENTIAL` limits every other test in this
/// file forces - default `JobLimits` (`max_concurrent_items: 3`), three
/// independent items, real `web.py` calls. Asserts *outcome* correctness,
/// not timing: asserting actual wall-clock overlap would be flaky against
/// real subprocess scheduling (`core::jobs::tests::semaphore_*` pins the
/// concurrency mechanism itself against a synthetic, timing-controlled
/// workload instead). Every item still reaches `Done`, exactly one
/// batch-level terminal event fires, and nothing - no `StageChanged`, no
/// `Progress`, no other `Done` - arrives after it.
#[test]
fn concurrent_items_all_complete_and_the_batch_terminal_event_fires_once_last() {
    let root = tempfile::TempDir::new().unwrap();
    let mut folders = Vec::new();
    for name in ["BOOK-A", "BOOK-B", "BOOK-C"] {
        let dir = root.path().join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("1.jpg"), TINY_JPG).unwrap();
        folders.push((name, dir));
    }

    let db = Db::open_in_memory().unwrap();
    let discovered_folders: Vec<_> = folders
        .iter()
        .map(|(name, dir)| discovered(name, dir))
        .collect();
    let ids: Vec<String> = discovered_folders.iter().map(|f| f.id.clone()).collect();
    db.with(|c| items::reconcile(c, &discovered_folders))
        .unwrap();

    let batch_items: Vec<ItemRunRequest> = folders
        .iter()
        .zip(&ids)
        .map(|((name, dir), id)| {
            page_images_item(
                id,
                dir,
                name,
                vec![RunnableStage::Pdf, RunnableStage::Thumbnail],
                vec!["1.jpg"],
            )
        })
        .collect();

    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Run,
        items: batch_items,
    };

    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    let mut events = Vec::new();
    jobs::run_batch(&db, &request, &guard, JobLimits::from_config(None), |e| {
        events.push(e);
    })
    .unwrap();
    drop(guard);

    for id in &ids {
        let stored = db.with(|c| items::get(c, id)).unwrap();
        assert_eq!(stored.stages[&StageName::Pdf].status, StageStatus::Done);
        assert_eq!(
            stored.stages[&StageName::Thumbnail].status,
            StageStatus::Done
        );
    }

    let done = done_events(&events);
    assert_eq!(done.len(), 4, "3 items + 1 batch-level terminal event");
    let item_dones: Vec<_> = done.iter().filter(|d| d.item_id.is_some()).collect();
    assert_eq!(item_dones.len(), 3);
    for d in &item_dones {
        assert_eq!(d.outcome, JobOutcome::Done);
        assert!(!d.batch_complete);
    }
    assert_eq!(
        done.iter().filter(|d| d.item_id.is_none()).count(),
        1,
        "exactly one batch-level terminal event, no matter how the workers interleaved"
    );

    let is_terminal_done =
        |e: &JobEvent| matches!(e, JobEvent::Done(d) if d.item_id.is_none() && d.batch_complete);
    assert!(
        events.last().is_some_and(is_terminal_done),
        "the batch-level terminal event must be the very last event of the run"
    );
}

// ─── re-upload granularity (Epic 07) ────────────────────────────────────────

fn mark_uploaded(db: &Db, item_id: &str) {
    db.with(|c| {
        items::record_upload(
            c,
            item_id,
            &UploadRecordDto {
                backend_id: "rec-1".to_string(),
                version: Some(1),
                target_state: ItemType::Record,
                visibility_status: VisibilityStatus::Public,
            },
        )
    })
    .unwrap();
}

/// The `content_changed` half of `core::jobs::reupload_kind_for` runs for
/// real here (Pillow is installed, unlike paddleocr - see
/// `reupload_kind_for`'s own doc comment for why `text_changed` can only be
/// pinned at the unit level in this environment): a real `pdf`/`thumbnail`
/// rebuild on an already-uploaded item must classify as `Full`.
#[test]
fn reprocessing_the_pdf_stage_marks_a_full_reupload_when_already_uploaded() {
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("BOOK");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("1.jpg"), TINY_JPG).unwrap();

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "BOOK", &dir);
    mark_uploaded(&db, &item_id);

    let item = page_images_item(
        &item_id,
        &dir,
        "BOOK",
        vec![RunnableStage::Pdf, RunnableStage::Thumbnail],
        vec!["1.jpg"],
    );
    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Reprocess,
        items: vec![item],
    };
    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    jobs::run_batch(&db, &request, &guard, SEQUENTIAL, |_| {}).unwrap();
    drop(guard);

    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    assert!(stored.reupload);
    assert!(
        !stored.reupload_text_only,
        "a real pdf/thumbnail rebuild must classify as Full, not text-only"
    );
}

/// The regression test for the found-along-the-way fix: `run_multiple_pdfs`'s
/// `Pdf` arm only ever *verifies* the operator's own PDFs for this shape — it
/// writes nothing — so a Reprocess that only requests `Pdf` on an
/// already-uploaded `multiple-pdfs` item must not spuriously flag `reupload`
/// when nothing on disk actually changed.
#[test]
fn multiple_pdfs_pdf_verify_alone_does_not_spuriously_mark_reupload() {
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().join("SERIAL");
    std::fs::create_dir_all(&dir).unwrap();
    write_pdf(&dir.join("vol1.pdf"), &[(220, 20, 20)]);
    write_pdf(&dir.join("vol2.pdf"), &[(20, 20, 220)]);

    let db = Db::open_in_memory().unwrap();
    let item_id = reconciled_item(&db, "SERIAL", &dir);
    mark_uploaded(&db, &item_id);

    let mut item = page_images_item(
        &item_id,
        &dir,
        "SERIAL",
        vec![RunnableStage::Pdf],
        Vec::new(),
    );
    item.input_shape = InputShape::MultiplePdfs;
    item.web_pdf_bases = vec!["vol1".to_string(), "vol2".to_string()];

    let request = BatchRunRequest {
        batch_id: "batch-1".to_string(),
        mode: JobRunMode::Reprocess,
        items: vec![item],
    };
    let lock: Mutex<JobRunLock> = Mutex::new(Default::default());
    let guard = jobs::try_acquire(&lock, &request.batch_id).unwrap();
    jobs::run_batch(&db, &request, &guard, SEQUENTIAL, |_| {}).unwrap();
    drop(guard);

    let stored = db.with(|c| items::get(c, &item_id)).unwrap();
    assert_eq!(stored.stages[&StageName::Pdf].status, StageStatus::Done);
    assert!(
        !stored.reupload,
        "a pure verify-pass that changed nothing on disk must not flag reupload"
    );
}
