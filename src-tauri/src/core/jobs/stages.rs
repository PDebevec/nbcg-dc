//! Per-stage execution: the `web`/`pdf`/`thumbnail` and `ocr` stages plus the
//! progress/status bookkeeping they share.

use std::path::{Path, PathBuf};

use crate::core::cancel::CancelToken;
use crate::core::db::{items, Db};
use crate::core::fs::finalize_staged_output;
use crate::core::python;
use crate::dto::{
    BatchRunRequest, InputShape, ItemRunRequest, JobProgressEvent, JobStageChangedEvent,
    RunnableStage, StageName, StageStatus,
};
use crate::error::{AppError, Result};

use super::limits::Semaphore;
use super::JobEvent;

// ─── orchestration ────────────────────────────────────────────────────────────

pub(super) const CANONICAL_ORDER: [RunnableStage; 3] = [
    RunnableStage::Pdf,
    RunnableStage::Thumbnail,
    RunnableStage::Ocr,
];

/// `item.stages` in canonical `[Pdf, Thumbnail, Ocr]` order, not as given —
/// OCR's precondition (the web PDF existing) depends on `Pdf` having run
/// first, so order must not be left to the caller.
pub(super) fn canonical_stages(requested: &[RunnableStage]) -> Vec<RunnableStage> {
    CANONICAL_ORDER
        .into_iter()
        .filter(|s| requested.contains(s))
        .collect()
}

pub(super) fn to_stage_name(stage: RunnableStage) -> StageName {
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
pub(super) fn web_mode(shape: InputShape) -> &'static str {
    match shape {
        InputShape::Tiffs => "paired",
        InputShape::PageImages | InputShape::ImagesOnly => "flat",
        InputShape::SuppliedPdf | InputShape::MultiplePdfs | InputShape::Empty => {
            unreachable!("run_web_stage is never called for {shape:?}")
        }
    }
}

pub(super) fn staging_dir(folder: &Path) -> PathBuf {
    folder.join(format!(".nbcg-tmp-{}", uuid::Uuid::new_v4()))
}

/// One item's tally, used to decide its `JobDoneEvent` and, under
/// `Reprocess`, whether/how it qualifies for `mark_needs_reupload`.
///
/// `content_changed`/`text_changed` are deliberately **not** one `any_done`
/// bool anymore (Epic 07 re-upload granularity) — a `pdf`/`thumbnail` stage
/// completing means new blob bytes exist on disk (`content_changed`); an
/// `ocr` stage completing means only the paired text file did
/// (`text_changed`). `run_one_item` reads both to pick a
/// `db::items::ReuploadKind`: content changing always means `Full` (a stale
/// `MultiplePdfs` precondition-verify success must *not* set either flag —
/// see `run_multiple_pdfs`'s `Pdf` arm, which writes nothing for that shape).
#[derive(Default)]
pub(super) struct ItemOutcome {
    pub(super) content_changed: bool,
    pub(super) text_changed: bool,
    pub(super) any_failed: bool,
    pub(super) first_error: Option<String>,
}

impl ItemOutcome {
    pub(super) fn record_failure(&mut self, message: String) {
        self.any_failed = true;
        if self.first_error.is_none() {
            self.first_error = Some(message);
        }
    }
}

pub(super) fn set_stage_status(
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

pub(super) fn emit_progress(
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
pub(super) fn fail_stage_without_running(
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
pub(super) struct WebSource {
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
pub(super) fn prepare_web_source(
    item: &ItemRunRequest,
    folder: &Path,
    staging: &Path,
    pages: Option<&[String]>,
    request: &BatchRunRequest,
    emit: &mut impl FnMut(JobEvent),
    runtime: Option<&python::PythonRuntime>,
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
    let split = python::run_split_spreads(folder, &split_dir, pages, runtime, cancel)?;

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
pub(super) fn run_web_stage(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    wants_pdf: bool,
    wants_thumb: bool,
    thumbnail_only: bool,
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
    runtime: Option<&python::PythonRuntime>,
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
    let run_result = prepare_web_source(
        item, folder, &staging, pages, request, emit, runtime, cancel,
    )
    .and_then(|source| {
        python::run_web(
            &source.folder,
            &staging,
            web_mode(item.input_shape),
            &item.folder_name,
            source.pages.as_deref(),
            thumbnail_only,
            source.thumbnail.as_deref(),
            runtime,
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
pub(super) fn ocr_bases(item: &ItemRunRequest) -> Vec<String> {
    if item.input_shape == InputShape::ImagesOnly {
        // One OCR pass per source image; the base is the image filename
        // itself, which `ocr_input` resolves against the folder.
        return item.ocr_images.clone();
    }
    if item.web_pdf_bases.is_empty() {
        vec![item.folder_name.clone()]
    } else {
        item.web_pdf_bases.clone()
    }
}

/// The file `ocr.py` is pointed at for each base.
///
/// Normally `<base>.pdf` - the web PDF the `pdf` stage built. An
/// `images-only` item has no PDF and never will: it is a lone graphical
/// work, and `ocr.py` reads an image directly (its non-PDF branch), writing
/// `<stem>.txt` beside it. The image is `primary_thumbnail`, which for a
/// one-image folder is that image, auto-resolved by `domain/pipeline`.
///
/// `None` means there is nothing to read, and the stage is not applicable.
pub(super) fn ocr_input(item: &ItemRunRequest, folder: &Path, base: &str) -> Option<PathBuf> {
    if item.input_shape == InputShape::ImagesOnly {
        // `base` is already the image filename (see `ocr_bases`). Never
        // `primary_thumbnail`: on a processed item that is the generated
        // `<name>_thumb.png`, and OCR-ing a downscale would lose the text.
        return (!base.is_empty()).then(|| folder.join(base));
    }
    Some(folder.join(format!("{base}.pdf")))
}

/// The original source images OCR should read directly, as absolute paths,
/// instead of rasterizing the web PDF — or `None` to fall back to that
/// rasterization (`ocr.py` does it internally via pypdfium2, no poppler).
///
/// Only ever resolved for `PageImages` — the shape every real scanner
/// folder is (this module's own doc comment) — since that is the only
/// shape with source images sitting in the folder at all:
/// `SuppliedPdf`/`MultiplePdfs` have none (a supplied PDF *is* the source),
/// and the legacy jpg/tif `Tiffs` pairing is unused in the real corpus, not
/// worth threading its separate `jpg/` source through.
///
/// `split_spreads` items need the *split* pages, not the flat originals
/// (each spread becomes two PDF pages) — `run_web_stage`'s own split
/// staging is already deleted by the time OCR runs (it can run at a
/// different time entirely, via per-stage Rerun/Reprocess), so this reruns
/// `split_spreads.py` fresh into OCR's own staging dir. It's Pillow-only
/// and fast, so re-running it is not a meaningful cost — and it's the only
/// way to get the exact page list without coupling the `pdf`/`ocr` stages'
/// lifetimes together.
///
/// Without `split_spreads` and with no authoritative `page_images` list
/// (the `.ts` lane didn't send one), this deliberately does not fall back
/// to re-scanning the folder itself — that would be exactly the "script
/// re-derives what `.ts` already decided" mistake this codebase has caught
/// and fixed elsewhere. `None` is the safe default: identical to today's
/// behavior for that edge case.
pub(super) fn resolve_ocr_pages(
    item: &ItemRunRequest,
    folder: &Path,
    staging: &Path,
    runtime: Option<&python::PythonRuntime>,
    cancel: &CancelToken,
) -> Result<Option<Vec<String>>> {
    if item.input_shape != InputShape::PageImages {
        return Ok(None);
    }

    if item.split_spreads {
        let pages = (!item.page_images.is_empty()).then_some(item.page_images.as_slice());
        let split_dir = staging.join("ocr_pages");
        let split = python::run_split_spreads(folder, &split_dir, pages, runtime, cancel)?;
        return Ok(Some(
            split
                .pages
                .iter()
                .map(|name| split_dir.join(name).to_string_lossy().into_owned())
                .collect(),
        ));
    }

    if !item.page_images.is_empty() {
        return Ok(Some(
            item.page_images
                .iter()
                .map(|name| folder.join(name).to_string_lossy().into_owned())
                .collect(),
        ));
    }

    Ok(None)
}

/// Resolve `ocr.py`'s reported staged-output filename and finalize it into
/// `folder` under that same name — shared by `.txt` and (when present) the
/// embedded-text `.pdf`, since both are just "a staged file `ocr.py` named
/// after the input, atomically moved into place."
pub(super) fn finalize_ocr_output(staged_path: &str, folder: &Path, label: &str) -> Result<()> {
    let staged = Path::new(staged_path);
    match staged.file_name() {
        Some(name) => finalize_staged_output(staged, &folder.join(name)),
        None => Err(AppError::Other(format!(
            "ocr.py reported {label} with no filename: {staged_path}"
        ))),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run_ocr_stage(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
    runtime: Option<&python::PythonRuntime>,
    cancel: &CancelToken,
    ocr_gate: &Semaphore,
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

    // Nothing to read: an images-only item that carries no source image.
    // Without this the empty loop below would fall straight through to the
    // success arm and report OCR as Done having produced no text at all.
    if bases.is_empty() {
        set_stage_status(
            db,
            request,
            item,
            StageName::Ocr,
            StageStatus::Skipped,
            None,
            emit,
        )?;
        return Ok(());
    }

    // Precondition first, for every base, before any OCR starts: a run that
    // OCRs three of four PDFs and only then discovers the fourth is missing has
    // burned minutes to reach the same failure.
    for base in &bases {
        let Some(input) = ocr_input(item, folder, base) else {
            // images-only with no image resolved: there is nothing to read, so
            // this is "not applicable", not a failure. Failing would block the
            // item over what is a caller mistake - `domain/pipeline` only
            // asks for OCR here when exactly one image resolved it.
            set_stage_status(
                db,
                request,
                item,
                StageName::Ocr,
                StageStatus::Skipped,
                None,
                emit,
            )?;
            return Ok(());
        };
        if input.is_file() {
            continue;
        }
        let missing = if item.input_shape == InputShape::ImagesOnly {
            format!("image not found for OCR: {}", input.display())
        } else {
            format!("web PDF not found for '{base}'; run the pdf stage first")
        };
        return fail_stage_without_running(
            db,
            request,
            item,
            StageName::Ocr,
            &missing,
            outcome,
            emit,
        );
    }

    // Held for this item's whole OCR stage (every base it covers), not
    // per-PDF - the resource contention this guards against is "how many
    // items are OCR-ing at once", not "how many PDF files". Re-check cancel
    // immediately after acquiring: a permit can free up after a cancel was
    // already requested, and a stale item shouldn't burn a fresh OCR run it
    // would just have to settle `Pending` anyway.
    let _permit = ocr_gate.acquire();
    if cancel.is_cancelled() {
        return Ok(());
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
    let mut pdf_embedded = false;

    match resolve_ocr_pages(item, folder, &staging, runtime, cancel) {
        Ok(ocr_pages) => {
            for base in &bases {
                emit_progress(
                    request,
                    item,
                    RunnableStage::Ocr,
                    &format!("running ocr.py for {base}"),
                    emit,
                );
                let Some(input) = ocr_input(item, folder, base) else {
                    break;
                };
                match python::run_ocr(&input, &staging, ocr_pages.as_deref(), runtime, cancel) {
                    Ok(summary) => {
                        finalize_result = finalize_ocr_output(
                            &summary.output_text,
                            folder,
                            "an output_text path",
                        );
                        if finalize_result.is_ok() {
                            if let Some(output_pdf) = &summary.output_pdf {
                                finalize_result =
                                    finalize_ocr_output(output_pdf, folder, "an output_pdf path");
                                if finalize_result.is_ok() {
                                    pdf_embedded = true;
                                }
                            }
                        }
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
        }
        Err(e) => run_result = Err(e),
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
            outcome.text_changed = true;
            // Embedding rewrites the PDF's own bytes, so a run that actually
            // embedded needs a `Full` reupload (blob included), not `TextOnly`
            // (`reupload_kind_for` below) — otherwise the embedded PDF would
            // sit correctly on local disk forever, but its invisible text
            // layer would never reach the uploaded/public copy.
            if pdf_embedded {
                outcome.content_changed = true;
            }
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

pub(super) fn finalize_outputs(folder: &Path, staging: &Path, outputs: &[String]) -> Result<()> {
    for name in outputs {
        finalize_staged_output(&staging.join(name), &folder.join(name))?;
    }
    Ok(())
}

/// Write the terminal status for the stages one script call resolved, applying
/// the `thumbnailNeedsChoice` rule. Shared by every branch so a stage cannot
/// reach `Done` in one shape and `Pending` in another for the same reason.
#[allow(clippy::too_many_arguments)]
pub(super) fn settle_web_stages(
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
                    // `resolved` here is always a subset of {Pdf, Thumbnail}
                    // (see this function's callers - never Ocr), so a real
                    // settle at this point always means new blob bytes.
                    outcome.content_changed = true;
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
