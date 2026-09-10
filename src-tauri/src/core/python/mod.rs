//! Spawning `py/web.py` / `py/ocr.py` / `py/split_spreads.py` /
//! `py/pdf_derive.py`, and parsing what they print.
//!
//! No orchestration here — that's [`crate::core::jobs`]. This module only
//! knows how to find a Python interpreter, run one script, and turn its
//! seam-4 JSON summary (`docs/04-code-structure.md`) into a typed value or a
//! clear error.
//!
//! **Python invocation strategy.** Two paths, chosen per-call by whether a
//! [`PythonRuntime`] override is passed in:
//!
//! - `None` (dev default, and the only path that existed before Epic 11's
//!   bundling landed): bare `python`/`py` on `PATH`, with the four pipeline
//!   scripts' paths resolved at *compile* time via `CARGO_MANIFEST_DIR`
//!   (`src-tauri/`'s absolute path on the machine that built this binary) —
//!   not relocatable/packageable, but simplest for running from source.
//! - `Some(runtime)`: the vendored interpreter + `py/` tree shipped as a
//!   Tauri bundle resource (`scripts/vendor-python.ps1`,
//!   `docs/tasks/python-runtime-bundling.md`), resolved once at startup from
//!   `app.path().resource_dir()` and threaded down as plain data —
//!   `core::python`/`core::jobs` stay Tauri-free themselves, only `lib.rs`
//!   touches the Tauri-typed `resource_dir()` call.
//!
//! Every existing test passes `None` (or, for the two direct
//! `spawn_and_wait` callers, never touches this at all), so today's exact
//! bare-`PATH` behavior is unchanged for all of them.

use std::io::Read;
use std::path::{Path, PathBuf};
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

/// Where `scripts/vendor-python.ps1` actually puts the vendored interpreter
/// in the repo, for [`PythonRuntime::detect_dev`]. Note the layout is *not*
/// the bundle's: in the repo `binaries/` lives under `src-tauri/` while
/// `py/` is a sibling at the repo root, whereas `bundle.resources` flattens
/// both into `resource_dir`. Hence two probes rather than one.
const DEV_INTERPRETER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/binaries/python/python.exe");
const DEV_SCRIPT_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../py");

/// A vendored Python interpreter + script tree, replacing the dev-default
/// bare `python`/`py` on `PATH`. Built once at Tauri startup from
/// `app.path().resource_dir()` (a Tauri-typed call that must stay out of
/// this Tauri-free module — see [`PythonRuntime::detect`]) and threaded
/// down as plain data through `core::jobs` to every `run_*` call here,
/// mirroring how `config_dir: &Path` already reaches `core::config::load`.
#[derive(Debug, Clone)]
pub struct PythonRuntime {
    /// `<resource_dir>/binaries/python/python.exe`.
    pub interpreter: PathBuf,
    /// `<resource_dir>/py` — the whole bundled `py/` tree, not just one
    /// script, since `ocr.py`/`pdf_derive.py` import the local
    /// `nbcg_pipeline` package alongside them.
    pub script_dir: PathBuf,
    /// Extra `PATH` entries for the spawned child only, prepended so a
    /// vendored dependency wins over anything same-named already on the
    /// user's own `PATH`. Always empty today — `ocr.py` no longer needs
    /// Poppler (moved to pypdfium2) — kept as a general mechanism rather
    /// than deleted, since it costs nothing unused.
    pub extra_path: Vec<PathBuf>,
}

impl PythonRuntime {
    const INTERPRETER_REL: &'static str = "binaries/python/python.exe";
    const SCRIPT_DIR_REL: &'static str = "py";

    /// `None` when the vendored interpreter isn't actually present under
    /// `resource_dir` — an ordinary dev run (resources are only physically
    /// copied there by a real `tauri build`) or a build that skipped
    /// `scripts/vendor-python.ps1`. Callers fall back to bare `python`/`py`
    /// on `PATH` in that case, identical to pre-Epic-11 behavior.
    pub fn detect(resource_dir: &Path) -> Option<Self> {
        let interpreter = resource_dir.join(Self::INTERPRETER_REL);
        if !interpreter.is_file() {
            return None;
        }
        Some(Self {
            interpreter,
            script_dir: resource_dir.join(Self::SCRIPT_DIR_REL),
            extra_path: Vec::new(),
        })
    }

    /// Dev fallback: the repo's own vendored tree, probed when the copy
    /// under `resource_dir` isn't usable. In development it usually isn't,
    /// for two compounding reasons:
    ///
    /// - `scripts/vendor-python.ps1` is wired to `beforeBundleCommand`, so
    ///   it only ever runs on a real `tauri build` — a dev run never
    ///   vendors anything by itself.
    /// - Tauri copies `bundle.resources` next to the dev binary when its
    ///   build script runs, which makes that copy a *snapshot*. Vendoring
    ///   (or editing `py/`) afterwards leaves it stale, and cargo won't
    ///   re-run the build script just because those files changed. That is
    ///   exactly how a freshly vendored interpreter stayed invisible to the
    ///   app while `target/debug/binaries/` still held nothing but the
    ///   `.gitkeep` placeholder captured at the last build.
    ///
    /// Pointing straight at the repo tree also keeps `py/` edits live in
    /// dev instead of serving whatever snapshot the last build captured,
    /// and skips duplicating a ~1 GB interpreter into `target/`.
    ///
    /// Paths are compile-time (`CARGO_MANIFEST_DIR`), exactly like
    /// [`WEB_SCRIPT`] and friends — meaningless on any machine but the one
    /// that built the binary, which is precisely the case this serves. The
    /// `is_file` guard keeps it a no-op everywhere else, so an installed
    /// app never reaches for a path that only existed on a build machine.
    pub fn detect_dev() -> Option<Self> {
        let interpreter = PathBuf::from(DEV_INTERPRETER);
        if !interpreter.is_file() {
            return None;
        }
        Some(Self {
            interpreter,
            script_dir: PathBuf::from(DEV_SCRIPT_DIR),
            extra_path: Vec::new(),
        })
    }
}

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
    /// The embedded-text-layer PDF's *staged* location (under `--out-dir`),
    /// mirroring `output_text` — `None` when `ocr.py` skipped the embed step
    /// (input already marked `/NBCGOcrEmbedded`, or a best-effort embed
    /// attempt failed and was logged rather than treated as fatal).
    #[serde(default)]
    pub output_pdf: Option<String>,
    #[allow(dead_code)]
    pub pages: i64,
    #[allow(dead_code)]
    pub avg_confidence: f64,
    #[allow(dead_code)]
    pub memory_cap_applied: bool,
    #[allow(dead_code)]
    pub elapsed_seconds: f64,
    /// Which script `ocr.py` settled on for the item, and how many pages had
    /// to be recognized twice to establish it. `ocr.py` runs one language per
    /// page rather than all of them, retrying only pages that read badly, so
    /// `pages_retried` is the direct cost signal for that policy — the number
    /// worth watching if OCR runtime regresses. `#[serde(default)]` for the
    /// same reason as `output_pdf`: a summary written by an older `ocr.py`
    /// must still parse.
    #[serde(default)]
    #[allow(dead_code)]
    pub language: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub pages_retried: i64,
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
///
/// Frozen at this exact signature — called directly by two tests in this
/// module (`a_cancelled_child_is_killed_rather_than_waited_out`,
/// `a_script_that_floods_stderr_still_completes`), which is now this
/// function's only remaining caller, hence `#[cfg(test)]`: `spawn_python`
/// itself calls [`spawn_and_wait_with_env`] directly (it needs the `Path`/
/// `extra_path` parameters this wrapper doesn't have). The real body, and
/// the [`PythonRuntime`]-aware extras (an env `PATH` override, a clearer
/// error when a vendored interpreter can't even start), live there; this
/// is a 1-line wrapper with no `PATH` override, identical to this
/// function's own pre-Epic-11 behavior.
#[cfg(test)]
fn spawn_and_wait(
    interpreter: &str,
    script: &str,
    args: &[String],
    cancel: &CancelToken,
) -> Result<Output> {
    spawn_and_wait_with_env(interpreter, Path::new(script), args, &[], cancel)
}

/// The real spawn/poll/drain logic behind [`spawn_and_wait`], plus an
/// optional `extra_path` — prepended to the child's inherited `PATH` (never
/// the user's persistent one) so a vendored dependency wins over anything
/// same-named already installed.
fn spawn_and_wait_with_env(
    interpreter: &str,
    script: &Path,
    args: &[String],
    extra_path: &[PathBuf],
    cancel: &CancelToken,
) -> Result<Output> {
    let mut command = Command::new(interpreter);
    command
        .arg(script)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if !extra_path.is_empty() {
        let mut paths = extra_path.to_vec();
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            command.env("PATH", joined);
        }
    }

    let mut child = command.spawn().map_err(|e| {
        // Windows error 126 = ERROR_MOD_NOT_FOUND: CreateProcess located the
        // exe but couldn't resolve a DLL it depends on - the signature of a
        // vendored python-build-standalone interpreter on a machine missing
        // the Microsoft Visual C++ Redistributable (see
        // docs/tasks/python-runtime-bundling.md). Surface that plainly
        // rather than a bare "os error 126".
        if e.raw_os_error() == Some(126) {
            AppError::Other(format!(
                "'{interpreter}' failed to start (Windows error 126, ERROR_MOD_NOT_FOUND) — \
                 this usually means the Microsoft Visual C++ Redistributable isn't installed. \
                 See docs/tasks/python-runtime-bundling.md."
            ))
        } else {
            AppError::Io(e)
        }
    })?;

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

/// Run `script` under `runtime`'s vendored interpreter when given, else
/// whichever of `python`/`py` is on `PATH`.
///
/// A vendored `runtime` is tried directly, with no `python`/`py` fallback —
/// it's either there and correct, or a packaging bug, and silently falling
/// back to a system interpreter would mask that rather than surface it.
/// With `runtime: None`, tries `python` first, only falling back to `py`
/// (the Windows launcher) if `python` itself isn't found, not on any other
/// failure — a script that fails for its own reasons (bad args, a
/// Python-level exception) must surface that failure, not silently retry
/// under a different interpreter. Identical to this function's behavior
/// before `runtime` existed.
fn spawn_python(
    script: &Path,
    args: &[String],
    runtime: Option<&PythonRuntime>,
    cancel: &CancelToken,
) -> Result<Output> {
    if let Some(rt) = runtime {
        let interpreter = rt.interpreter.to_string_lossy().into_owned();
        return spawn_and_wait_with_env(&interpreter, script, args, &rt.extra_path, cancel);
    }
    for interpreter in ["python", "py"] {
        match spawn_and_wait_with_env(interpreter, script, args, &[], cancel) {
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
    runtime: Option<&PythonRuntime>,
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

    let script: PathBuf = runtime
        .map(|rt| rt.script_dir.join("split_spreads.py"))
        .unwrap_or_else(|| PathBuf::from(SPLIT_SCRIPT));
    let output = spawn_python(&script, &args, runtime, cancel)?;
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
    runtime: Option<&PythonRuntime>,
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

    let script: PathBuf = runtime
        .map(|rt| rt.script_dir.join("pdf_derive.py"))
        .unwrap_or_else(|| PathBuf::from(PDF_DERIVE_SCRIPT));
    let output = spawn_python(&script, &args, runtime, cancel)?;
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
    runtime: Option<&PythonRuntime>,
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

    let script: PathBuf = runtime
        .map(|rt| rt.script_dir.join("web.py"))
        .unwrap_or_else(|| PathBuf::from(WEB_SCRIPT));
    let output = spawn_python(&script, &args, runtime, cancel)?;
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
/// staging its `.txt` (and, when it embeds a searchable text layer, `.pdf`)
/// output into `staging`.
///
/// `pages`, when given, is the item's original source page images — the
/// `.ts` lane's own authoritative order (`ItemRunRequest.pageImages`, or a
/// fresh `split_spreads.py` re-run when the item asked for splitting) —
/// passed through as `--pages` so `ocr.py` reads those directly instead of
/// rasterizing `input`. Same "don't re-derive what's already decided"
/// reasoning as `run_web`'s own `pages` parameter, and the same shape.
pub(crate) fn run_ocr(
    input: &Path,
    staging: &Path,
    pages: Option<&[String]>,
    runtime: Option<&PythonRuntime>,
    cancel: &CancelToken,
) -> Result<OcrSummary> {
    let mut args: Vec<String> = vec![
        input.to_string_lossy().into_owned(),
        "--out-dir".to_string(),
        staging.to_string_lossy().into_owned(),
    ];
    if let Some(pages) = pages {
        if !pages.is_empty() {
            // Written to a file rather than passed as arguments. Windows caps
            // an entire command line at 32767 characters; one page path here
            // runs about 100, so a 522-page book comes to roughly 52000 and
            // the spawn fails outright - on precisely the long books that most
            // need OCR. Measured against this archive: the 391-page item sat
            // at ~31300, four percent under the limit, which is not a margin
            // worth shipping.
            //
            // The file lives in the staging directory the caller already
            // creates and already deletes, so it needs no cleanup of its own.
            let list_path = staging.join("ocr_pages.txt");
            let mut contents = String::with_capacity(pages.len() * 96);
            for page in pages {
                contents.push_str(page);
                contents.push('\n');
            }
            std::fs::write(&list_path, contents)?;
            args.push("--pages-file".to_string());
            args.push(list_path.to_string_lossy().into_owned());
        }
    }

    let script: PathBuf = runtime
        .map(|rt| rt.script_dir.join("ocr.py"))
        .unwrap_or_else(|| PathBuf::from(OCR_SCRIPT));
    let output = spawn_python(&script, &args, runtime, cancel)?;
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

    /// `output_pdf` is `Option` because `ocr.py` omits it whenever it has
    /// nothing new to report (no embed attempted, or a marker-skip) — must
    /// deserialize cleanly either way, not just when present.
    #[test]
    fn ocr_summary_deserializes_output_pdf_present_and_absent() {
        let with_pdf = r#"{"input":"a.pdf","output_text":"a.txt","output_pdf":"a.pdf","pages":1,"avg_confidence":0.9,"memory_cap_applied":false,"elapsed_seconds":1.0,"errors":[]}"#;
        let summary: OcrSummary = serde_json::from_str(with_pdf).expect("should parse");
        assert_eq!(summary.output_pdf.as_deref(), Some("a.pdf"));

        let without_pdf = r#"{"input":"a.pdf","output_text":"a.txt","pages":1,"avg_confidence":0.9,"memory_cap_applied":false,"elapsed_seconds":1.0,"errors":[]}"#;
        let summary: OcrSummary = serde_json::from_str(without_pdf).expect("should parse");
        assert_eq!(summary.output_pdf, None);
    }

    /// The dev-run/unvendored-build fallback: no vendored interpreter file
    /// present under `resource_dir` means `None`, so callers fall back to
    /// bare `python`/`py` on `PATH`.
    #[test]
    fn python_runtime_detect_is_none_without_a_vendored_interpreter() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(PythonRuntime::detect(dir.path()).is_none());
    }

    /// `Some` once the vendored interpreter file actually exists, with
    /// `script_dir` pointing at `<resource_dir>/py` (the whole tree, not
    /// one script — `ocr.py`/`pdf_derive.py` import `nbcg_pipeline`).
    #[test]
    fn python_runtime_detect_is_some_once_the_interpreter_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let interpreter_dir = dir.path().join("binaries").join("python");
        std::fs::create_dir_all(&interpreter_dir).unwrap();
        std::fs::write(interpreter_dir.join("python.exe"), b"").unwrap();

        let runtime =
            PythonRuntime::detect(dir.path()).expect("should detect the vendored interpreter");
        assert_eq!(runtime.interpreter, interpreter_dir.join("python.exe"));
        assert_eq!(runtime.script_dir, dir.path().join("py"));
        assert!(runtime.extra_path.is_empty());
    }

    /// `detect_dev` must agree with what is actually on disk, on a vendored
    /// machine and a bare one alike — and when it does fire, point at the
    /// repo's *real* `py/` tree. The dev layout is asymmetric
    /// (`src-tauri/binaries/` but `../py/`), so a `script_dir` that silently
    /// pointed at the bundle-shaped `src-tauri/py` would leave every script
    /// path unresolvable; asserting a known script is really there catches
    /// that, which comparing two computed paths would not.
    #[test]
    fn python_runtime_detect_dev_matches_the_repo_tree_on_disk() {
        let interpreter = Path::new(DEV_INTERPRETER);
        match PythonRuntime::detect_dev() {
            Some(runtime) => {
                assert!(
                    interpreter.is_file(),
                    "detect_dev returned Some with no interpreter on disk"
                );
                assert_eq!(runtime.interpreter, interpreter);
                assert!(
                    runtime.script_dir.join("ocr.py").is_file(),
                    "dev script_dir must hold the real pipeline scripts, got {}",
                    runtime.script_dir.display()
                );
                assert!(runtime.extra_path.is_empty());
            }
            None => assert!(
                !interpreter.is_file(),
                "detect_dev returned None despite {} existing",
                interpreter.display()
            ),
        }
    }

    /// `extra_path` entries must be prepended ahead of the inherited PATH —
    /// a vendored dependency should win over anything same-named already
    /// installed, never lose to it.
    #[test]
    fn extra_path_entries_are_prepended_ahead_of_the_inherited_path() {
        let cancel = CancelToken::new();
        let extra = std::env::temp_dir().join("nbcg-dc-test-extra-path-entry");
        let script = "import os, sys; sys.stdout.write(os.environ.get('PATH', ''))";

        let output = spawn_and_wait_with_env(
            "python",
            Path::new("-c"),
            &[script.to_string()],
            std::slice::from_ref(&extra),
            &cancel,
        )
        .expect("must not error");

        let stdout = String::from_utf8_lossy(&output.stdout);
        let first_entry = std::env::split_paths(stdout.as_ref()).next();
        assert_eq!(first_entry.as_deref(), Some(extra.as_path()));
    }

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
