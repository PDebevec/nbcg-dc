//! The `InputShape` handlers - one function per branch the `.ts` lane decided.

use std::path::{Path, PathBuf};

use crate::core::cancel::CancelToken;
use crate::core::db::Db;
use crate::core::python;
use crate::dto::{BatchRunRequest, ItemRunRequest, RunnableStage, StageName, StageStatus};
use crate::error::{AppError, Result};

use super::limits::Semaphore;
use super::stages::*;
use super::JobEvent;

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
// Owned by `core::fs` - the scanner has to know this layout too, so that a
// filed original stays visible to classification instead of vanishing.
use crate::core::fs::SOURCE_SUBFOLDER;

pub(super) fn pdfs_in(dir: &Path) -> Result<Vec<PathBuf>> {
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
pub(super) fn resolve_supplied_source(folder: &Path, folder_name: &str) -> Result<PathBuf> {
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
pub(super) fn run_supplied_pdf_stage(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    wants_pdf: bool,
    wants_thumb: bool,
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
        python::run_pdf_derive(
            &source,
            &staging,
            &item.folder_name,
            !wants_pdf,
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

/// The `multiple-pdfs` shape. The `pdf` stage builds nothing: the `.ts` lane's
/// own upload candidates keep each discovered PDF's own filename
/// (`domain/pipeline.uploadCandidates`), so the operator's PDFs already *are*
/// the web PDFs. Rewriting them in place would destroy the originals, which
/// nothing else in this pipeline does.
#[allow(clippy::too_many_arguments)]
pub(super) fn run_multiple_pdfs(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    stages: &[RunnableStage],
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
    runtime: Option<&python::PythonRuntime>,
    cancel: &CancelToken,
    ocr_gate: &Semaphore,
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
                    // Deliberately not `outcome.content_changed = true` here:
                    // this arm only *verifies* the operator's own PDFs are
                    // still present, it never writes anything for this shape
                    // (see this function's own doc comment) - a plain
                    // precondition-pass is not "new content," and flagging it
                    // as one would make every Reprocess-with-Pdf-requested
                    // pass on a `multiple-pdfs` item spuriously mark
                    // `reupload`, even when nothing on disk changed.
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
                run_multi_pdf_thumbnail(db, request, item, &bases, outcome, emit, runtime, cancel)?;
            }
            RunnableStage::Ocr => {
                run_ocr_stage(db, request, item, outcome, emit, runtime, cancel, ocr_gate)?;
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
pub(super) fn run_multi_pdf_thumbnail(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    bases: &[String],
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
    runtime: Option<&python::PythonRuntime>,
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
        result = python::run_pdf_derive(&source, &staging, base, true, runtime, cancel)
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
                runtime,
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

#[allow(clippy::too_many_arguments)]
pub(super) fn run_supplied_pdf(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    stages: &[RunnableStage],
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
    runtime: Option<&python::PythonRuntime>,
    cancel: &CancelToken,
    ocr_gate: &Semaphore,
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
            runtime,
            cancel,
        )?;
    }
    if stages.contains(&RunnableStage::Ocr) {
        run_ocr_stage(db, request, item, outcome, emit, runtime, cancel, ocr_gate)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run_pdf_thumbnail_ocr(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    stages: &[RunnableStage],
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
    runtime: Option<&python::PythonRuntime>,
    cancel: &CancelToken,
    ocr_gate: &Semaphore,
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
            runtime,
            cancel,
        )?;
    }
    if wants_ocr {
        run_ocr_stage(db, request, item, outcome, emit, runtime, cancel, ocr_gate)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run_images_only(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    stages: &[RunnableStage],
    outcome: &mut ItemOutcome,
    emit: &mut impl FnMut(JobEvent),
    runtime: Option<&python::PythonRuntime>,
    cancel: &CancelToken,
    ocr_gate: &Semaphore,
) -> Result<()> {
    for &stage in stages {
        match stage {
            RunnableStage::Thumbnail => {
                run_web_stage(
                    db, request, item, false, true, true, outcome, emit, runtime, cancel,
                )?;
            }
            RunnableStage::Ocr => {
                // A lone graphical work does carry text - a poster's title, a
                // map's legend - and `ocr.py` reads the image directly, so no
                // PDF is needed. `domain/pipeline` only asks for this stage
                // when the folder holds exactly one image; with several, which
                // asset owns the text is a content decision and it stays off.
                run_ocr_stage(db, request, item, outcome, emit, runtime, cancel, ocr_gate)?;
            }
            RunnableStage::Pdf => {
                // No PDF is ever built for a standalone graphical work.
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

pub(super) fn run_unsupported(
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
