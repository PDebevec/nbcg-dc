//! Spawning `py/web.py` / `py/ocr.py` / `py/split_spreads.py` /
//! `py/pdf_derive.py`, and parsing what they print.
//!
//! No orchestration here — that's [`crate::core::jobs`]. This module only
//! knows how to find a Python interpreter, run one script, and turn its
//! seam-4 JSON summary (`docs/04-code-structure.md`) into a typed value or a
//! clear error.
//!
//! **Python invocation strategy (Epic 06, dev slice): system Python on
//! `PATH`.** No sidecar bundling — that's Epic 11's packaging concern, out of
//! scope while the app is only run from source. The script paths below are
//! resolved at *compile* time via `CARGO_MANIFEST_DIR`, which is
//! `src-tauri/`'s absolute path on the machine that built this binary — that
//! sidesteps needing a real CWD convention, but is explicitly not
//! relocatable/packageable, same caveat.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Deserialize;

use crate::core::cancel::CancelToken;
use crate::error::{AppError, Result};

/// How often [`spawn_python`] polls the child for exit / the cancel token
/// while it runs. Small enough that a cancel is acted on promptly, large
/// enough not to burn a core busy-waiting.
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(100);

const WEB_SCRIPT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../py/web.py");
const OCR_SCRIPT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../py/ocr.py");
const SPLIT_SCRIPT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../py/split_spreads.py");
const PDF_DERIVE_SCRIPT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../py/pdf_derive.py");

/// Mirrors `web.py`'s `FolderSummary` dataclass field-for-field (Python's
/// `dataclasses.asdict` already emits snake_case, matching Rust's default —
/// no `#[serde(rename)]` needed anywhere in this module).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct WebFolderSummary {
    #[allow(dead_code)] // kept for parity with the script's summary; not read yet
    pub folder: String,
    #[allow(dead_code)]
    pub mode: String,
    #[allow(dead_code)]
    pub pages: i64,
    /// Output filenames, as `web.py` itself named them — the job runner
    /// finalizes exactly these, verbatim, rather than re-deriving what got
    /// written (same single-source-of-truth reasoning as page ordering).
    pub outputs: Vec<String>,
    pub errors: Vec<String>,
}

/// Mirrors `web.py`'s `RunSummary` dataclass.
#[derive(Debug, Deserialize)]
struct WebRunSummary {
    targets: Vec<WebFolderSummary>,
}

/// Mirrors `split_spreads.py`'s `Summary` dataclass.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct SplitSummary {
    #[allow(dead_code)] // kept for parity with the script's summary; not read yet
    pub folder: String,
    #[allow(dead_code)]
    pub out_dir: String,
    #[allow(dead_code)]
    pub images_found: i64,
    #[allow(dead_code)]
    pub spreads_split: i64,
    #[allow(dead_code)]
    pub singles_copied: i64,
    #[allow(dead_code)]
    pub pages_written: i64,
    #[allow(dead_code)]
    pub gutter_detected: i64,
    /// Spreads the script could not find a real gutter in and split down the
    /// middle instead. Not an error (the split still happened), but the number
    /// worth surfacing if a UI ever reports split quality.
    #[allow(dead_code)]
    pub gutter_fallback: i64,
    #[allow(dead_code)]
    pub dry_run: bool,
    /// The split pages' filenames, in page order — handed straight to
    /// `web.py --pages`, so the order the `.ts` lane decided survives the
    /// split rather than being re-derived from the staging folder.
    pub pages: Vec<String>,
    pub errors: Vec<String>,
}

/// Mirrors `pdf_derive.py`'s `DeriveSummary` dataclass.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct PdfDeriveSummary {
    #[allow(dead_code)] // kept for parity with the script's summary; not read yet
    pub source: String,
    #[allow(dead_code)]
    pub name: String,
    #[allow(dead_code)]
    pub pages: i64,
    /// Output filenames, as the script itself named them — finalized verbatim,
    /// same as [`WebFolderSummary::outputs`].
    pub outputs: Vec<String>,
    pub errors: Vec<String>,
}

/// Mirrors `ocr.py`'s `OcrSummary` dataclass.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct OcrSummary {
    #[allow(dead_code)]
    pub input: String,
    /// The `.txt` file's *staged* location (under `--out-dir`) — the job
    /// runner finalizes it from here, same as `WebFolderSummary::outputs`.
    pub output_text: String,
    #[allow(dead_code)]
    pub pages: i64,
    #[allow(dead_code)]
    pub avg_confidence: f64,
    #[allow(dead_code)]
    pub memory_cap_applied: bool,
    #[allow(dead_code)]
    pub elapsed_seconds: f64,
    pub errors: Vec<String>,
}

/// Spawn `script` under `interpreter`, piping stdout/stderr so the child can
/// be polled and killed rather than waited out. Drains both pipes on their
/// own threads: polling `try_wait` while a child fills a pipe buffer nobody
/// is reading deadlocks the moment that buffer fills, and `ocr.py` logs a
/// line per page to stderr, so a real OCR run would hit exactly that.
///
/// `cancel` is polled once per [`CANCEL_POLL_INTERVAL`]; on a cancellation the
/// child is killed and reaped and this returns [`AppError::Cancelled`]
/// **unwrapped**, so a caller can distinguish "the operator cancelled this"
/// from "the script crashed" without parsing a message string.
fn spawn_and_wait(
    interpreter: &str,
    script: &str,
    args: &[String],
    cancel: &CancelToken,
) -> Result<Output> {
    let mut child = Command::new(interpreter)
        .arg(script)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let mut stdout_pipe = child.stdout.take().expect("stdout was piped");
    let mut stderr_pipe = child.stderr.take().expect("stderr was piped");
    let stdout_reader = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });
    let stderr_reader = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });

    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if cancel.is_cancelled() {
            // Best-effort: the child may have exited between the try_wait
            // above and here, in which case kill() errors and is ignored —
            // wait() below still reaps it either way.
            let _ = child.kill();
            let _ = child.wait();
            // Join the reader threads so they don't outlive the child's
            // closed pipes mid-read; their output is discarded, this run is
            // being thrown away.
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(AppError::Cancelled);
        }
        thread::sleep(CANCEL_POLL_INTERVAL);
    };

    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

/// Run `script` under whichever of `python`/`py` is on `PATH`.
///
/// Tries `python` first; only falls back to `py` (the Windows launcher) if
/// `python` itself isn't found, not on any other failure — a script that
/// fails for its own reasons (bad args, a Python-level exception) must
/// surface that failure, not silently retry under a different interpreter.
fn spawn_python(script: &str, args: &[String], cancel: &CancelToken) -> Result<Output> {
    for interpreter in ["python", "py"] {
        match spawn_and_wait(interpreter, script, args, cancel) {
            Ok(output) => return Ok(output),
            Err(AppError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        }
    }
    Err(AppError::Other(
        "could not locate a Python interpreter on PATH (tried python, py)".into(),
    ))
}

/// Parse a script's stdout as its JSON summary, with a stderr-tail fallback
/// error when it isn't parseable (a crash before the summary line, or a
/// print of something that isn't the summary).
fn parse_summary<T: DeserializeOwned>(output: &Output, script_label: &str) -> Result<T> {
    serde_json::from_slice(&output.stdout).map_err(|e| {
        let stderr_tail: String = String::from_utf8_lossy(&output.stderr)
            .chars()
            .rev()
            .take(500)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        AppError::Other(format!(
            "{script_label} did not print a parseable JSON summary (exit {:?}): {e}\nstderr tail: {stderr_tail}",
            output.status.code(),
        ))
    })
}

/// Split every two-page spread in `folder` into single pages, written into
/// `out_dir` (the originals are never touched). `pages`, when given, is the
/// authoritative page order passed through as `--pages`, so the script does
/// not re-discover and re-sort the folder — the same single-source-of-truth
/// reasoning as [`run_web`]'s.
///
/// The returned [`SplitSummary::pages`] is the resulting page order, which
/// the caller feeds to `web.py --pages`.
pub(crate) fn run_split_spreads(
    folder: &Path,
    out_dir: &Path,
    pages: Option<&[String]>,
    cancel: &CancelToken,
) -> Result<SplitSummary> {
    let mut args: Vec<String> = vec![
        folder.to_string_lossy().into_owned(),
        "--out".to_string(),
        out_dir.to_string_lossy().into_owned(),
    ];
    if let Some(pages) = pages {
        if !pages.is_empty() {
            args.push("--pages".to_string());
            args.extend(pages.iter().cloned());
        }
    }

    let output = spawn_python(SPLIT_SCRIPT, &args, cancel)?;
    let summary: SplitSummary = parse_summary(&output, "split_spreads.py")?;

    if !output.status.success() || !summary.errors.is_empty() {
        return Err(AppError::Other(format!(
            "split_spreads.py failed for {} (exit {:?}): {}",
            folder.display(),
            output.status.code(),
            if summary.errors.is_empty() {
                "non-zero exit, no reported errors".to_string()
            } else {
                summary.errors.join("; ")
            },
        )));
    }

    Ok(summary)
}

/// Derive a web PDF (+ thumbnail) from a **supplied PDF**, staging the outputs
/// into `staging`.
///
/// `name` is `ItemRunRequest.folder_name` — the naming base the `.ts` lane
/// decided, which the source PDF's own filename routinely contradicts
/// (`Pisma iz Liona` holds `Писма из Лиона_(310).pdf`), so the script requires
/// it rather than guessing. `thumbnail_only` renders page 1 alone and builds no
/// PDF: the `multiple-pdfs` case, where each discovered PDF already *is* its
/// own web PDF and only a thumbnail candidate is wanted from it.
pub(crate) fn run_pdf_derive(
    source: &Path,
    staging: &Path,
    name: &str,
    thumbnail_only: bool,
    cancel: &CancelToken,
) -> Result<PdfDeriveSummary> {
    let mut args: Vec<String> = vec![
        source.to_string_lossy().into_owned(),
        "--name".to_string(),
        name.to_string(),
        "--out-dir".to_string(),
        staging.to_string_lossy().into_owned(),
    ];
    if thumbnail_only {
        args.push("--thumbnail-only".to_string());
    }

    let output = spawn_python(PDF_DERIVE_SCRIPT, &args, cancel)?;
    let summary: PdfDeriveSummary = parse_summary(&output, "pdf_derive.py")?;

    if !output.status.success() || !summary.errors.is_empty() {
        return Err(AppError::Other(format!(
            "pdf_derive.py failed for {} (exit {:?}): {}",
            source.display(),
            output.status.code(),
            if summary.errors.is_empty() {
                "non-zero exit, no reported errors".to_string()
            } else {
                summary.errors.join("; ")
            },
        )));
    }

    Ok(summary)
}

/// Run `web.py` over `folder`, staging its outputs into `staging` rather than
/// writing into `folder` directly (the caller finalizes them atomically —
/// see [`crate::core::fs::finalize_staged_output`]).
///
/// `mode` (`"flat"` or `"paired"`) is passed as `--mode` — the shape the `.ts`
/// lane already decided (`ItemRunRequest.inputShape`), so this script never
/// re-derives its own, possibly-disagreeing answer by re-scanning the folder
/// (the same single-source-of-truth principle as `pages` below). `name` is
/// `ItemRunRequest.folder_name` passed as `--name` — likewise the naming base
/// the `.ts` lane decided, rather than one re-derived from `folder`'s own
/// name, which also lets `folder` be a staging directory of split pages
/// without the outputs taking that directory's name. `pages`, when given, is
/// the authoritative page order passed through verbatim as `--pages`.
/// `thumbnail_only` skips PDF assembly entirely (the `images-only` shape: a
/// standalone graphical work has no PDF at all). `thumbnail_source`, when
/// given, is `ItemRunRequest.primary_thumbnail` passed through as
/// `--thumbnail-source` — an image tagged "thumbnail" or an operator's own
/// pick, independent of whichever images build the PDF (per docs/tasks/06's
/// "NB": complete Thumbnail *named* `primaryThumbnail`, not just the
/// natural-first image); it may be an absolute path, which is how a chosen
/// thumbnail stays unsplit while the pages come from a staging folder.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_web(
    folder: &Path,
    staging: &Path,
    mode: &str,
    name: &str,
    pages: Option<&[String]>,
    thumbnail_only: bool,
    thumbnail_source: Option<&str>,
    cancel: &CancelToken,
) -> Result<WebFolderSummary> {
    let mut args: Vec<String> = vec![
        folder.to_string_lossy().into_owned(),
        "--out-dir".to_string(),
        staging.to_string_lossy().into_owned(),
        "--mode".to_string(),
        mode.to_string(),
        "--name".to_string(),
        name.to_string(),
    ];
    if let Some(pages) = pages {
        if !pages.is_empty() {
            args.push("--pages".to_string());
            args.extend(pages.iter().cloned());
        }
    }
    if thumbnail_only {
        args.push("--thumbnail-only".to_string());
    }
    if let Some(source) = thumbnail_source {
        args.push("--thumbnail-source".to_string());
        args.push(source.to_string());
    }

    let output = spawn_python(WEB_SCRIPT, &args, cancel)?;
    let run: WebRunSummary = parse_summary(&output, "web.py")?;

    if run.targets.len() != 1 {
        return Err(AppError::Other(format!(
            "web.py returned {} target(s) for a single-folder call on {} - expected exactly 1",
            run.targets.len(),
            folder.display(),
        )));
    }
    let target = run.targets.into_iter().next().unwrap();

    if !output.status.success() || !target.errors.is_empty() {
        return Err(AppError::Other(format!(
            "web.py failed for {} (exit {:?}): {}",
            folder.display(),
            output.status.code(),
            if target.errors.is_empty() {
                "non-zero exit, no reported errors".to_string()
            } else {
                target.errors.join("; ")
            },
        )));
    }

    Ok(target)
}

/// Run `ocr.py` over `input` (a single web PDF, never the archival master),
/// staging its `.txt` output into `staging`.
pub(crate) fn run_ocr(input: &Path, staging: &Path, cancel: &CancelToken) -> Result<OcrSummary> {
    let args: Vec<String> = vec![
        input.to_string_lossy().into_owned(),
        "--out-dir".to_string(),
        staging.to_string_lossy().into_owned(),
    ];

    let output = spawn_python(OCR_SCRIPT, &args, cancel)?;
    let summary: OcrSummary = parse_summary(&output, "ocr.py")?;

    if !output.status.success() || !summary.errors.is_empty() {
        return Err(AppError::Other(format!(
            "ocr.py failed for {} (exit {:?}): {}",
            input.display(),
            output.status.code(),
            if summary.errors.is_empty() {
                "non-zero exit, no reported errors".to_string()
            } else {
                summary.errors.join("; ")
            },
        )));
    }

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// Cancelling must kill the child rather than wait it out. The elapsed
    /// time *is* the assertion — waiting the child out would take 30s, so a
    /// pass in a second or two proves `kill()` actually fired.
    #[test]
    fn a_cancelled_child_is_killed_rather_than_waited_out() {
        let cancel = CancelToken::new();
        let cancel_clone = cancel.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            cancel_clone.cancel();
        });

        let start = Instant::now();
        let result = spawn_and_wait(
            "python",
            "-c",
            &["import time; time.sleep(30)".to_string()],
            &cancel,
        );
        let elapsed = start.elapsed();

        assert!(matches!(result, Err(AppError::Cancelled)));
        assert!(
            elapsed < Duration::from_secs(10),
            "expected the child to be killed promptly, took {elapsed:?}"
        );
    }

    /// A script that writes a lot to stderr before exiting must not deadlock
    /// `try_wait` polling against a full, undrained pipe buffer — the failure
    /// mode a real OCR run (which logs per page) would otherwise hit.
    #[test]
    fn a_script_that_floods_stderr_still_completes() {
        let cancel = CancelToken::new();
        let script = "import sys\n\
                       for _ in range(20000):\n\
                       \tsys.stderr.write('x' * 100 + chr(10))\n\
                       sys.stdout.write('done')\n";

        let start = Instant::now();
        let result = spawn_and_wait("python", "-c", &[script.to_string()], &cancel);
        let elapsed = start.elapsed();

        let output = result.expect("must not deadlock or error");
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout), "done");
        assert!(
            elapsed < Duration::from_secs(15),
            "expected prompt completion, took {elapsed:?}"
        );
    }
}
