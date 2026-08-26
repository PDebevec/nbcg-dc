//! The pipeline job runner (Epic 06, first slice).
//!
//! Sequential — one item, one stage at a time, no queue/concurrency cap.
//!
//! Handles **all six** `InputShape`s:
//!
//! - `PageImages`/`Tiffs` — `web.py` assembles the folder's images.
//! - `ImagesOnly` — thumbnail only (`web.py --thumbnail-only`); a standalone
//!   graphical work has no PDF, so no OCR either.
//! - `SuppliedPdf` — `pdf_derive.py` downscales the operator's PDF into
//!   `<folderName>.pdf`, with the original filed under `source/` (see
//!   [`SOURCE_SUBFOLDER`] for why that is required, not tidiness).
//! - `MultiplePdfs` — the discovered PDFs already *are* the web PDFs, so the
//!   `pdf` stage verifies rather than builds, and never rewrites them.
//! - `Empty` — nothing to run.
//!
//! Every field of `ItemRunRequest` the `.ts` lane decided is honoured and none
//! is re-derived here: `input_shape` (`web.py --mode`), `page_images`
//! (`--pages`), `folder_name` (`--name`), `primary_thumbnail`
//! (`--thumbnail-source`), `thumbnail_needs_choice` (withholds the stage's
//! `Done`), `split_spreads` (`split_spreads.py` before assembly) and
//! `web_pdf_bases` (one OCR text per web PDF).
//!
//! True concurrency, mid-process cancellation (`Command::kill`), and an
//! *interactive* multi-candidate thumbnail picker (there is no GUI for one
//! yet) are deliberately out of scope — see
//! `docs/tasks/06-processing-pipeline-and-jobs.md`.
//!
//! Tauri-free by design, matching `core::fs::FsWatcher`'s shape: [`run_batch`]
//! takes a plain `emit: impl FnMut(JobEvent)` closure rather than an
//! `AppHandle`, so it is unit-testable without a webview — only
//! `commands::jobs` turns that closure into real `app.emit(...)` calls.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::core::cancel::CancelToken;
use crate::core::db::{items, Db};
use crate::core::fs::finalize_staged_output;
use crate::core::python;
use crate::dto::{
    BatchRunRequest, InputShape, ItemRunRequest, JobDoneEvent, JobOutcome, JobProgressEvent,
    JobRunMode, JobStageChangedEvent, RunnableStage, StageName, StageStatus,
};
use crate::error::{AppError, Result};

// ─── single-run lock ──────────────────────────────────────────────────────────

/// One batch running at a time, per workstation. `cancel` doubles as the
/// cancel flag — only the running batch can ever be cancelled, so one field
/// set covers both.
#[derive(Debug, Default)]
pub struct JobRunLock {
    batch_id: Option<String>,
    cancel: CancelToken,
}

/// Holds the lock for the duration of a run. `Drop` unconditionally releases
/// it — whether the run returned `Ok`, `Err`, or unwound from a panic, since
/// the mutex is only ever held for the instant of a check/set/clear, never
/// across the run itself, so it cannot be poisoned by a panic inside
/// [`run_batch`].
pub struct JobRunGuard<'a> {
    lock: &'a Mutex<JobRunLock>,
    cancel: CancelToken,
}

impl JobRunGuard<'_> {
    pub fn cancel_requested(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// A clone of this run's cancel token, threaded down into
    /// `core::python`'s spawned children so a cancel kills whichever script
    /// is currently running, not just the *next* one.
    pub fn cancel_token(&self) -> CancelToken {
        self.cancel.clone()
    }
}

impl Drop for JobRunGuard<'_> {
    fn drop(&mut self) {
        let mut guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        guard.batch_id = None;
        // A fresh token, not a reset of the old one — a stale cancel from
        // this run must never leak into the next one, and a fresh
        // `CancelToken` is the simplest way to guarantee that.
        guard.cancel = CancelToken::new();
    }
}

/// Claim the lock for `batch_id`, or fail if another batch already holds it.
pub fn try_acquire<'a>(lock: &'a Mutex<JobRunLock>, batch_id: &str) -> Result<JobRunGuard<'a>> {
    let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(running) = &guard.batch_id {
        return Err(AppError::Invalid(format!(
            "batch {running} is already running"
        )));
    }
    guard.batch_id = Some(batch_id.to_string());
    guard.cancel = CancelToken::new();
    let cancel = guard.cancel.clone();
    drop(guard);
    Ok(JobRunGuard { lock, cancel })
}

/// Request cancellation of `batch_id`'s run, if it's the one currently
/// running. Returns whether it actually matched something.
pub fn request_cancel(lock: &Mutex<JobRunLock>, batch_id: &str) -> bool {
    let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    if guard.batch_id.as_deref() == Some(batch_id) {
        guard.cancel.cancel();
        true
    } else {
        false
    }
}

// ─── events ───────────────────────────────────────────────────────────────────

pub enum JobEvent {
    Progress(JobProgressEvent),
    StageChanged(JobStageChangedEvent),
    Done(JobDoneEvent),
}

// ─── orchestration ────────────────────────────────────────────────────────────

const CANONICAL_ORDER: [RunnableStage; 3] = [
    RunnableStage::Pdf,
    RunnableStage::Thumbnail,
    RunnableStage::Ocr,
];

/// `item.stages` in canonical `[Pdf, Thumbnail, Ocr]` order, not as given —
/// OCR's precondition (the web PDF existing) depends on `Pdf` having run
/// first, so order must not be left to the caller.
fn canonical_stages(requested: &[RunnableStage]) -> Vec<RunnableStage> {
    CANONICAL_ORDER
        .into_iter()
        .filter(|s| requested.contains(s))
        .collect()
}

fn to_stage_name(stage: RunnableStage) -> StageName {
    match stage {
        RunnableStage::Pdf => StageName::Pdf,
        RunnableStage::Thumbnail => StageName::Thumbnail,
        RunnableStage::Ocr => StageName::Ocr,
    }
}

/// `web.py --mode` for the shapes it's ever actually called for. The `.ts`
/// lane already decided the shape (`ItemRunRequest.inputShape`) — passing it
/// explicitly means `web.py` never re-derives its own, possibly-disagreeing
/// answer by re-scanning the folder for jpg/tif subfolders (the same
/// single-source-of-truth principle already applied to page order via
/// `--pages`). Only called from `run_web_stage`, itself only reached for
/// `PageImages`/`Tiffs`/`ImagesOnly` — the other shapes fail before any
/// script is invoked at all, so this is exhaustive in practice even though
/// it can't be exhaustive in the type system without over-narrowing the
/// parameter type.
fn web_mode(shape: InputShape) -> &'static str {
    match shape {
        InputShape::Tiffs => "paired",
        InputShape::PageImages | InputShape::ImagesOnly => "flat",
        InputShape::SuppliedPdf | InputShape::MultiplePdfs | InputShape::Empty => {
            unreachable!("run_web_stage is never called for {shape:?}")
        }
    }
}

fn staging_dir(folder: &Path) -> PathBuf {
    folder.join(format!(".nbcg-tmp-{}", uuid::Uuid::new_v4()))
}

/// One item's tally, used to decide its `JobDoneEvent` and whether it
/// qualifies for `mark_needs_reupload` under `Reprocess`.
#[derive(Default)]
struct ItemOutcome {
    any_done: bool,
    any_failed: bool,
    first_error: Option<String>,
}

impl ItemOutcome {
    fn record_failure(&mut self, message: String) {
        self.any_failed = true;
        if self.first_error.is_none() {
            self.first_error = Some(message);
        }
    }
}

fn set_stage_status(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    stage: StageName,
    status: StageStatus,
    error: Option<&str>,
    emit: &mut impl FnMut(JobEvent),
) -> Result<()> {
    db.with(|c| items::set_stage(c, &item.item_id, stage, status, error))?;
    emit(JobEvent::StageChanged(JobStageChangedEvent {
        batch_id: request.batch_id.clone(),
        item_id: item.item_id.clone(),
        stage,
        status,
        error: error.map(str::to_string),
        at: Some(crate::core::db::now_iso()),
    }));
    Ok(())
}

fn emit_progress(
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    stage: RunnableStage,
    message: &str,
    emit: &mut impl FnMut(JobEvent),
) {
    emit(JobEvent::Progress(JobProgressEvent {
        batch_id: request.batch_id.clone(),
        item_id: item.item_id.clone(),
        stage,
        progress: None,
        message: Some(message.to_string()),
    }));
}

/// A stage that never got to run at all (unsupported input shape, or a
/// defensively-handled `Empty` shape that somehow carried stages).
fn fail_stage_without_running(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    stage: StageName,
    message: &str,
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
) -> Result<()> {
    set_stage_status(
        db,
        request,
        item,
        stage,
        StageStatus::Failed,
        Some(message),
        emit,
    )?;
    outcome.record_failure(message.to_string());
    Ok(())
}

/// What `web.py` should actually be pointed at: normally the item's own
/// folder, but a staging directory of split pages when spreads were split
/// first.
struct WebSource {
    folder: PathBuf,
    pages: Option<Vec<String>>,
    /// `--thumbnail-source`, absolute when it must escape `folder` (see
    /// [`prepare_web_source`]).
    thumbnail: Option<String>,
}

/// Run `split_spreads.py` first when the item asks for it, and report what
/// `web.py` should then assemble from.
///
/// `ItemRunRequest.split_spreads` is an operator decision made in the `.ts`
/// lane (`Batch.overrides[itemId].splitSpreads`); it cannot be detected there,
/// because telling a 2-up book spread from a landscape map needs pixel access
/// (docs/05-real-scan-data.md open question #4). So it is honoured here
/// exactly as given — and, where it cannot be honoured, refused out loud
/// rather than quietly dropped.
#[allow(clippy::too_many_arguments)]
fn prepare_web_source(
    item: &ItemRunRequest,
    folder: &Path,
    staging: &Path,
    pages: Option<&[String]>,
    request: &BatchRunRequest,
    emit: &mut impl FnMut(JobEvent),
    cancel: &CancelToken,
) -> Result<WebSource> {
    if !item.split_spreads {
        return Ok(WebSource {
            folder: folder.to_path_buf(),
            pages: pages.map(<[String]>::to_vec),
            thumbnail: item.primary_thumbnail.clone(),
        });
    }

    match item.input_shape {
        InputShape::PageImages => {}
        InputShape::Tiffs => {
            // The archival master has to come from the TIFFs at full fidelity;
            // splitting them is a different, unspecified job. Refuse rather
            // than build a PDF that silently ignores the operator's choice.
            return Err(AppError::Invalid(
                "split-spreads is not supported for jpg/tif paired folders".into(),
            ));
        }
        InputShape::ImagesOnly => {
            // Not ignored - inapplicable. `images-only` builds no PDF at all
            // (`--thumbnail-only`), and split-spreads is defined as a sub-step
            // of the image->PDF build, so there is nothing for it to act on.
            return Ok(WebSource {
                folder: folder.to_path_buf(),
                pages: pages.map(<[String]>::to_vec),
                thumbnail: item.primary_thumbnail.clone(),
            });
        }
        InputShape::SuppliedPdf | InputShape::MultiplePdfs | InputShape::Empty => {
            unreachable!("run_web_stage is never called for {:?}", item.input_shape)
        }
    }

    emit_progress(
        request,
        item,
        RunnableStage::Pdf,
        &format!("splitting spreads for {}", item.folder_name),
        emit,
    );

    let split_dir = staging.join("pages");
    let split = python::run_split_spreads(folder, &split_dir, pages, cancel)?;

    Ok(WebSource {
        folder: split_dir,
        pages: Some(split.pages),
        // A chosen thumbnail is a decision about a whole image - typically the
        // cover, which is the one image in a book of spreads that should not
        // be cut in half (docs/05 open question #5). Point at the original by
        // absolute path so it survives `web.py` running against `split_dir`.
        thumbnail: item
            .primary_thumbnail
            .as_ref()
            .map(|n| folder.join(n).to_string_lossy().into_owned()),
    })
}

/// Call `web.py` once and resolve whichever of `pdf`/`thumbnail` was actually
/// requested from its single outcome — `web.py` always writes all of its
/// mode's outputs per call, so one call satisfies both stages when both are
/// requested (the "bundling rule"), and a redundant PDF rebuild is accepted
/// as a documented simplification when only `thumbnail` was requested for a
/// paired/page-images item.
#[allow(clippy::too_many_arguments)]
fn run_web_stage(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    wants_pdf: bool,
    wants_thumb: bool,
    thumbnail_only: bool,
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
    cancel: &CancelToken,
) -> Result<()> {
    let resolved: Vec<StageName> = [
        (wants_pdf, StageName::Pdf),
        (wants_thumb, StageName::Thumbnail),
    ]
    .into_iter()
    .filter_map(|(wanted, name)| wanted.then_some(name))
    .collect();
    if resolved.is_empty() {
        return Ok(());
    }

    for &stage in &resolved {
        set_stage_status(db, request, item, stage, StageStatus::Running, None, emit)?;
    }
    let progress_stage = if wants_pdf {
        RunnableStage::Pdf
    } else {
        RunnableStage::Thumbnail
    };
    emit_progress(
        request,
        item,
        progress_stage,
        &format!("running web.py for {}", item.folder_name),
        emit,
    );

    let folder = Path::new(&item.folder_path);
    let staging = staging_dir(folder);
    std::fs::create_dir_all(&staging)?;

    let pages = (!item.page_images.is_empty()).then_some(item.page_images.as_slice());
    let run_result = prepare_web_source(item, folder, &staging, pages, request, emit, cancel)
        .and_then(|source| {
            python::run_web(
                &source.folder,
                &staging,
                web_mode(item.input_shape),
                &item.folder_name,
                source.pages.as_deref(),
                thumbnail_only,
                source.thumbnail.as_deref(),
                cancel,
            )
        });
    let finalize_result = match &run_result {
        Ok(summary) => finalize_outputs(folder, &staging, &summary.outputs),
        Err(_) => Ok(()),
    };
    let _ = std::fs::remove_dir_all(&staging);

    settle_web_stages(
        db,
        request,
        item,
        &resolved,
        run_result.map(|_| ()),
        finalize_result,
        outcome,
        emit,
    )
}

/// The web PDF base names this item's OCR should cover, one `.txt` each.
///
/// `ItemRunRequest.web_pdf_bases` is the `.ts` lane's own list of upload
/// candidates (`domain/pipeline.uploadCandidates`): `[folderName]` for
/// `tiffs`/`page-images`/`supplied-pdf`, and each discovered PDF's own base for
/// `multiple-pdfs` — which is what keeps `<base>.pdf` and `<base>.txt` matching
/// by name, the multi-PDF invariant in docs/tasks/06. The fallback covers a
/// caller that sent none.
fn ocr_bases(item: &ItemRunRequest) -> Vec<String> {
    if item.web_pdf_bases.is_empty() {
        vec![item.folder_name.clone()]
    } else {
        item.web_pdf_bases.clone()
    }
}

fn run_ocr_stage(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
    cancel: &CancelToken,
) -> Result<()> {
    if cancel.is_cancelled() {
        // A cancel that landed during this item's earlier stage(s) must not
        // let this stage's synchronous precondition check turn it into a
        // permanent Failed - there's no subprocess in that check for
        // spawn_and_wait's own cancel poll to intercept. OCR's DB status is
        // still exactly what run_batch queued it as (Queued, never flipped
        // to Running) - leave it untouched; the post-item
        // reset_unfinished_stages (mod.rs:1184) resets it to Pending, same
        // as every other interrupted stage.
        return Ok(());
    }
    let folder = Path::new(&item.folder_path);
    let bases = ocr_bases(item);

    // Precondition first, for every base, before any OCR starts: a run that
    // OCRs three of four PDFs and only then discovers the fourth is missing has
    // burned minutes to reach the same failure.
    for base in &bases {
        if !folder.join(format!("{base}.pdf")).is_file() {
            return fail_stage_without_running(
                db,
                request,
                item,
                StageName::Ocr,
                &format!("web PDF not found for '{base}'; run the pdf stage first"),
                outcome,
                emit,
            );
        }
    }

    set_stage_status(
        db,
        request,
        item,
        StageName::Ocr,
        StageStatus::Running,
        None,
        emit,
    )?;

    let staging = staging_dir(folder);
    std::fs::create_dir_all(&staging)?;

    let mut run_result = Ok(());
    let mut finalize_result = Ok(());
    for base in &bases {
        emit_progress(
            request,
            item,
            RunnableStage::Ocr,
            &format!("running ocr.py for {base}"),
            emit,
        );
        match python::run_ocr(&folder.join(format!("{base}.pdf")), &staging, cancel) {
            Ok(summary) => {
                let staged_txt = Path::new(&summary.output_text);
                finalize_result = match staged_txt.file_name() {
                    Some(name) => finalize_staged_output(staged_txt, &folder.join(name)),
                    None => Err(AppError::Other(format!(
                        "ocr.py reported an output_text path with no filename: {}",
                        summary.output_text
                    ))),
                };
                if finalize_result.is_err() {
                    break;
                }
            }
            Err(e) => {
                run_result = Err(e);
                break;
            }
        }
    }
    let _ = std::fs::remove_dir_all(&staging);

    match (run_result, finalize_result) {
        (Ok(_), Ok(())) => {
            set_stage_status(
                db,
                request,
                item,
                StageName::Ocr,
                StageStatus::Done,
                None,
                emit,
            )?;
            outcome.any_done = true;
        }
        (Ok(_), Err(e)) | (Err(e), _) if e.is_cancelled() => {
            // A cancel is not a failure: leave the stage `Pending` so
            // `stagesToRun` picks it straight back up on the next Start,
            // with no red the operator didn't cause.
            set_stage_status(
                db,
                request,
                item,
                StageName::Ocr,
                StageStatus::Pending,
                None,
                emit,
            )?;
        }
        (Ok(_), Err(e)) | (Err(e), _) => {
            let message = e.to_string();
            set_stage_status(
                db,
                request,
                item,
                StageName::Ocr,
                StageStatus::Failed,
                Some(&message),
                emit,
            )?;
            outcome.record_failure(message);
        }
    }
    Ok(())
}

fn finalize_outputs(folder: &Path, staging: &Path, outputs: &[String]) -> Result<()> {
    for name in outputs {
        finalize_staged_output(&staging.join(name), &folder.join(name))?;
    }
    Ok(())
}

// ─── PDF-source shapes (supplied-pdf / multiple-pdfs) ─────────────────────────

/// Where a supplied PDF is filed once it has been derived from.
///
/// Not tidiness — necessity. `domain/files.classifyAsset` calls every
/// non-`_archive` PDF a `web-pdf` and `domain/pipeline.classifyInput` branches
/// on how many the folder has, so leaving the original beside the derived
/// `<folderName>.pdf` would make the item read as `multiple-pdfs` on the next
/// scan: it would silently change shape, and the full-size original would be
/// uploaded as a web asset. `core::fs::describe_folder` lists files without
/// recursing, so one subfolder is enough to keep the count at one.
const SOURCE_SUBFOLDER: &str = "source";

fn pdfs_in(dir: &Path) -> Result<Vec<PathBuf>> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut found: Vec<PathBuf> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let path = entry.path();
        let is_pdf = path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
        if is_pdf {
            found.push(path);
        }
    }
    // read_dir order is filesystem-defined; sort so a folder that somehow holds
    // several resolves the same way every run rather than at random.
    found.sort();
    Ok(found)
}

/// The pristine supplied PDF to derive from, filing it under `source/` the
/// first time so the folder never ends up holding two.
///
/// Deriving from the filed original rather than from a previous run's output is
/// the whole point of looking there first: re-running otherwise downscales a
/// downscale, and the web PDF visibly rots a little more each time.
fn resolve_supplied_source(folder: &Path, folder_name: &str) -> Result<PathBuf> {
    let filed = pdfs_in(&folder.join(SOURCE_SUBFOLDER))?;
    match filed.len() {
        1 => return Ok(filed.into_iter().next().unwrap()),
        0 => {}
        n => {
            return Err(AppError::Invalid(format!(
                "{SOURCE_SUBFOLDER}/ holds {n} PDFs - cannot tell which one is the source"
            )))
        }
    }

    let archival = format!("{folder_name}_archive.pdf");
    let candidates: Vec<PathBuf> = pdfs_in(folder)?
        .into_iter()
        .filter(|p| p.file_name().is_none_or(|n| n != archival.as_str()))
        .collect();

    let source = match candidates.len() {
        1 => candidates.into_iter().next().unwrap(),
        0 => {
            return Err(AppError::Invalid(
                "no PDF found to derive from - the folder no longer matches its \
                 'supplied-pdf' shape"
                    .into(),
            ))
        }
        n => {
            return Err(AppError::Invalid(format!(
                "found {n} PDFs where 'supplied-pdf' means exactly one - the folder \
                 changed since it was planned; rescan it"
            )))
        }
    };

    let filed_dir = folder.join(SOURCE_SUBFOLDER);
    std::fs::create_dir_all(&filed_dir)?;
    let destination = filed_dir.join(
        source
            .file_name()
            .ok_or_else(|| AppError::Invalid(format!("{} has no filename", source.display())))?,
    );
    if destination.exists() {
        return Err(AppError::Invalid(format!(
            "{} already exists - refusing to overwrite an operator's file",
            destination.display()
        )));
    }
    std::fs::rename(&source, &destination)?;
    Ok(destination)
}

/// The `supplied-pdf` shape: derive `<folderName>.pdf` + its thumbnail from the
/// one PDF the operator dropped in, which is filed under `source/` first.
#[allow(clippy::too_many_arguments)]
fn run_supplied_pdf_stage(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    wants_pdf: bool,
    wants_thumb: bool,
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
    cancel: &CancelToken,
) -> Result<()> {
    let resolved: Vec<StageName> = [
        (wants_pdf, StageName::Pdf),
        (wants_thumb, StageName::Thumbnail),
    ]
    .into_iter()
    .filter_map(|(wanted, name)| wanted.then_some(name))
    .collect();
    if resolved.is_empty() {
        return Ok(());
    }

    for &stage in &resolved {
        set_stage_status(db, request, item, stage, StageStatus::Running, None, emit)?;
    }
    emit_progress(
        request,
        item,
        if wants_pdf {
            RunnableStage::Pdf
        } else {
            RunnableStage::Thumbnail
        },
        &format!("deriving from the supplied PDF for {}", item.folder_name),
        emit,
    );

    let folder = Path::new(&item.folder_path);
    let staging = staging_dir(folder);
    std::fs::create_dir_all(&staging)?;

    let run_result = resolve_supplied_source(folder, &item.folder_name).and_then(|source| {
        // Only the thumbnail was asked for - rendering every page of a
        // 300-page document to throw it away would dominate the runtime.
        python::run_pdf_derive(&source, &staging, &item.folder_name, !wants_pdf, cancel)
    });
    let finalize_result = match &run_result {
        Ok(summary) => finalize_outputs(folder, &staging, &summary.outputs),
        Err(_) => Ok(()),
    };
    let _ = std::fs::remove_dir_all(&staging);

    settle_web_stages(
        db,
        request,
        item,
        &resolved,
        run_result.map(|_| ()),
        finalize_result,
        outcome,
        emit,
    )
}

/// The `multiple-pdfs` shape. The `pdf` stage builds nothing: the `.ts` lane's
/// own upload candidates keep each discovered PDF's own filename
/// (`domain/pipeline.uploadCandidates`), so the operator's PDFs already *are*
/// the web PDFs. Rewriting them in place would destroy the originals, which
/// nothing else in this pipeline does.
fn run_multiple_pdfs(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    stages: &[RunnableStage],
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
    cancel: &CancelToken,
) -> Result<()> {
    let folder = Path::new(&item.folder_path);
    let bases = ocr_bases(item);

    for &stage in stages {
        match stage {
            RunnableStage::Pdf => {
                let missing: Vec<&String> = bases
                    .iter()
                    .filter(|b| !folder.join(format!("{b}.pdf")).is_file())
                    .collect();
                if missing.is_empty() {
                    set_stage_status(
                        db,
                        request,
                        item,
                        StageName::Pdf,
                        StageStatus::Done,
                        None,
                        emit,
                    )?;
                    outcome.any_done = true;
                } else {
                    let names: Vec<String> = missing.iter().map(|b| format!("{b}.pdf")).collect();
                    fail_stage_without_running(
                        db,
                        request,
                        item,
                        StageName::Pdf,
                        &format!("web PDF(s) missing from the folder: {}", names.join(", ")),
                        outcome,
                        emit,
                    )?;
                }
            }
            RunnableStage::Thumbnail => {
                run_multi_pdf_thumbnail(db, request, item, &bases, outcome, emit, cancel)?;
            }
            RunnableStage::Ocr => {
                run_ocr_stage(db, request, item, outcome, emit, cancel)?;
            }
        }
    }
    Ok(())
}

/// Render one `<base>_thumb.png` candidate per PDF, then resolve the stage.
///
/// The `<base>_thumb.png` naming is deliberate: `domain/files.classifyAsset`
/// already classifies `*_thumb` as kind `thumbnail`, so on the next scan these
/// become exactly the present-image candidate pool `planThumbnail` expects, and
/// the operator's pick flows back through `primaryThumbnail` unchanged.
#[allow(clippy::too_many_arguments)]
fn run_multi_pdf_thumbnail(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    bases: &[String],
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
    cancel: &CancelToken,
) -> Result<()> {
    set_stage_status(
        db,
        request,
        item,
        StageName::Thumbnail,
        StageStatus::Running,
        None,
        emit,
    )?;

    let folder = Path::new(&item.folder_path);
    let staging = staging_dir(folder);
    std::fs::create_dir_all(&staging)?;

    let mut result: Result<()> = Ok(());
    for base in bases {
        emit_progress(
            request,
            item,
            RunnableStage::Thumbnail,
            &format!("rendering a thumbnail candidate from {base}.pdf"),
            emit,
        );
        let source = folder.join(format!("{base}.pdf"));
        result = python::run_pdf_derive(&source, &staging, base, true, cancel)
            .and_then(|summary| finalize_outputs(folder, &staging, &summary.outputs));
        if result.is_err() {
            break;
        }
    }

    // With the candidates on disk, normalise the operator's pick (if they have
    // made one) to the item's own `<folderName>_thumb.png`. `--pages` restricts
    // web.py to exactly that file, so nothing else in the folder can be picked
    // up instead.
    if result.is_ok() {
        if let Some(pick) = item.primary_thumbnail.as_deref() {
            let picks = [pick.to_string()];
            result = python::run_web(
                folder,
                &staging,
                "flat",
                &item.folder_name,
                Some(&picks),
                true,
                Some(pick),
                cancel,
            )
            .and_then(|summary| finalize_outputs(folder, &staging, &summary.outputs));
        }
    }
    let _ = std::fs::remove_dir_all(&staging);

    settle_web_stages(
        db,
        request,
        item,
        &[StageName::Thumbnail],
        result,
        Ok(()),
        outcome,
        emit,
    )
}

/// Write the terminal status for the stages one script call resolved, applying
/// the `thumbnailNeedsChoice` rule. Shared by every branch so a stage cannot
/// reach `Done` in one shape and `Pending` in another for the same reason.
#[allow(clippy::too_many_arguments)]
fn settle_web_stages(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    resolved: &[StageName],
    run_result: Result<()>,
    finalize_result: Result<()>,
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
) -> Result<()> {
    match (run_result, finalize_result) {
        (Ok(()), Ok(())) => {
            for &stage in resolved {
                if stage == StageName::Thumbnail && item.thumbnail_needs_choice {
                    // Not Done: a later skip-if-done pass must still offer
                    // the operator a thumbnail choice. Not Failed either -
                    // the script succeeded; there's just a pending decision.
                    set_stage_status(db, request, item, stage, StageStatus::Pending, None, emit)?;
                } else {
                    set_stage_status(db, request, item, stage, StageStatus::Done, None, emit)?;
                    outcome.any_done = true;
                }
            }
            Ok(())
        }
        (Ok(()), Err(e)) | (Err(e), _) if e.is_cancelled() => {
            // A cancel is not a failure: leave every stage this call was
            // resolving `Pending` so `stagesToRun` picks them straight back
            // up on the next Start, with no red the operator didn't cause.
            for &stage in resolved {
                set_stage_status(db, request, item, stage, StageStatus::Pending, None, emit)?;
            }
            Ok(())
        }
        (Ok(()), Err(e)) | (Err(e), _) => {
            let message = e.to_string();
            for &stage in resolved {
                set_stage_status(
                    db,
                    request,
                    item,
                    stage,
                    StageStatus::Failed,
                    Some(&message),
                    emit,
                )?;
            }
            outcome.record_failure(message);
            Ok(())
        }
    }
}

fn run_supplied_pdf(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    stages: &[RunnableStage],
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
    cancel: &CancelToken,
) -> Result<()> {
    let wants_pdf = stages.contains(&RunnableStage::Pdf);
    let wants_thumb = stages.contains(&RunnableStage::Thumbnail);

    if wants_pdf || wants_thumb {
        run_supplied_pdf_stage(
            db,
            request,
            item,
            wants_pdf,
            wants_thumb,
            outcome,
            emit,
            cancel,
        )?;
    }
    if stages.contains(&RunnableStage::Ocr) {
        run_ocr_stage(db, request, item, outcome, emit, cancel)?;
    }
    Ok(())
}

fn run_pdf_thumbnail_ocr(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    stages: &[RunnableStage],
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
    cancel: &CancelToken,
) -> Result<()> {
    let wants_pdf = stages.contains(&RunnableStage::Pdf);
    let wants_thumb = stages.contains(&RunnableStage::Thumbnail);
    let wants_ocr = stages.contains(&RunnableStage::Ocr);

    if wants_pdf || wants_thumb {
        run_web_stage(
            db,
            request,
            item,
            wants_pdf,
            wants_thumb,
            false,
            outcome,
            emit,
            cancel,
        )?;
    }
    if wants_ocr {
        run_ocr_stage(db, request, item, outcome, emit, cancel)?;
    }
    Ok(())
}

fn run_images_only(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    stages: &[RunnableStage],
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
    cancel: &CancelToken,
) -> Result<()> {
    for &stage in stages {
        match stage {
            RunnableStage::Thumbnail => {
                run_web_stage(db, request, item, false, true, true, outcome, emit, cancel)?;
            }
            RunnableStage::Pdf | RunnableStage::Ocr => {
                // No PDF for a standalone graphical work, so no OCR either -
                // there's no running text to extract.
                set_stage_status(
                    db,
                    request,
                    item,
                    to_stage_name(stage),
                    StageStatus::Skipped,
                    None,
                    emit,
                )?;
            }
        }
    }
    Ok(())
}

fn run_unsupported(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    stages: &[RunnableStage],
    reason: &str,
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
) -> Result<()> {
    for &stage in stages {
        fail_stage_without_running(
            db,
            request,
            item,
            to_stage_name(stage),
            reason,
            outcome,
            emit,
        )?;
    }
    Ok(())
}

fn run_item(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    emit: &mut impl FnMut(JobEvent),
    cancel: &CancelToken,
) -> Result<ItemOutcome> {
    let mut outcome = ItemOutcome::default();
    let stages = canonical_stages(&item.stages);
    if stages.is_empty() {
        return Ok(outcome);
    }

    match item.input_shape {
        InputShape::PageImages | InputShape::Tiffs => {
            run_pdf_thumbnail_ocr(db, request, item, &stages, &mut outcome, emit, cancel)?;
        }
        InputShape::ImagesOnly => {
            run_images_only(db, request, item, &stages, &mut outcome, emit, cancel)?;
        }
        InputShape::SuppliedPdf => {
            run_supplied_pdf(db, request, item, &stages, &mut outcome, emit, cancel)?;
        }
        InputShape::MultiplePdfs => {
            run_multiple_pdfs(db, request, item, &stages, &mut outcome, emit, cancel)?;
        }
        InputShape::Empty => {
            // TS shouldn't send stages for an empty folder; handled
            // defensively the same as an unsupported shape if it somehow does.
            run_unsupported(
                db,
                request,
                item,
                &stages,
                "input shape 'empty' has nothing to run",
                &mut outcome,
                emit,
            )?;
        }
    }

    Ok(outcome)
}

/// After a cancelled run, every stage this run queued but never finished
/// (still `Queued` or `Running` in SQLite) is reset to `Pending` rather than
/// left stuck `Queued` forever — `stagesToRun` re-runs anything not `done`,
/// so a `Pending` stage resumes cleanly on the next Start with no red the
/// operator didn't cause. Reads each item's current status back from the
/// index rather than tracking a separate bookkeeping set, so it is
/// self-correcting regardless of exactly where in the batch the cancel
/// landed — items already settled (Done/Failed/Skipped/Pending) are simply a
/// no-op here.
fn reset_unfinished_stages(
    db: &Db,
    request: &BatchRunRequest,
    emit: &mut impl FnMut(JobEvent),
) -> Result<()> {
    for item in &request.items {
        let current = db.with(|c| items::get(c, &item.item_id))?;
        for stage in canonical_stages(&item.stages) {
            let stage_name = to_stage_name(stage);
            let is_unfinished = current
                .stages
                .get(&stage_name)
                .is_some_and(|s| matches!(s.status, StageStatus::Queued | StageStatus::Running));
            if is_unfinished {
                set_stage_status(
                    db,
                    request,
                    item,
                    stage_name,
                    StageStatus::Pending,
                    None,
                    emit,
                )?;
            }
        }
    }
    Ok(())
}

/// Run every item in `request`, sequentially, one stage at a time. Handles
/// `Run`/`Rerun`/`Reprocess` alike - `mode` only changes whether
/// `mark_needs_reupload` fires, not the execution path.
pub fn run_batch(
    db: &Db,
    request: &BatchRunRequest,
    guard: &JobRunGuard<'_>,
    mut emit: impl FnMut(JobEvent),
) -> Result<()> {
    if request.items.is_empty() {
        emit(JobEvent::Done(JobDoneEvent {
            batch_id: request.batch_id.clone(),
            item_id: None,
            outcome: JobOutcome::Done,
            error: None,
            batch_complete: true,
        }));
        return Ok(());
    }

    // Queue everything up front, so the UI can show the whole run's shape
    // before the first stage actually starts.
    for item in &request.items {
        for stage in canonical_stages(&item.stages) {
            set_stage_status(
                db,
                request,
                item,
                to_stage_name(stage),
                StageStatus::Queued,
                None,
                &mut emit,
            )?;
        }
    }

    let cancel_token = guard.cancel_token();
    let last_index = request.items.len() - 1;

    for (index, item) in request.items.iter().enumerate() {
        if guard.cancel_requested() {
            reset_unfinished_stages(db, request, &mut emit)?;
            emit(JobEvent::Done(JobDoneEvent {
                batch_id: request.batch_id.clone(),
                item_id: None,
                outcome: JobOutcome::Cancelled,
                error: None,
                batch_complete: true,
            }));
            return Ok(());
        }

        let outcome = run_item(db, request, item, &mut emit, &cancel_token)?;

        if guard.cancel_requested() {
            // The cancel landed mid-item: its own settle points already left
            // the interrupted stage(s) `Pending` (never `Failed`), but do not
            // emit this item's own terminal event — reporting it `done`/
            // `failed` here would be wrong when a later stage never ran, and
            // `resetInFlightRuns` on the `.ts` side already cleans up any
            // item still mid-flight once the batch-level `Cancelled` event
            // below arrives.
            reset_unfinished_stages(db, request, &mut emit)?;
            emit(JobEvent::Done(JobDoneEvent {
                batch_id: request.batch_id.clone(),
                item_id: None,
                outcome: JobOutcome::Cancelled,
                error: None,
                batch_complete: true,
            }));
            return Ok(());
        }

        if request.mode == JobRunMode::Reprocess && outcome.any_done {
            let already_uploaded = db.with(|c| items::get(c, &item.item_id))?.uploaded;
            if already_uploaded {
                db.with(|c| items::mark_needs_reupload(c, &item.item_id))?;
            }
        }

        emit(JobEvent::Done(JobDoneEvent {
            batch_id: request.batch_id.clone(),
            item_id: Some(item.item_id.clone()),
            outcome: if outcome.any_failed {
                JobOutcome::Failed
            } else {
                JobOutcome::Done
            },
            error: outcome.first_error,
            batch_complete: index == last_index,
        }));
    }

    Ok(())
}
