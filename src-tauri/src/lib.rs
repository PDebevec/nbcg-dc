//! nbcg-dc native core.
//!
//! The Rust half of the desktop archive: the local SQLite index, the
//! filesystem layer over the two scan roots, and config/secret storage. It
//! deliberately does **not** talk to the `nbcg` backend — all HTTP lives in the
//! TypeScript lane (`services/api/`, docs/04 seam 3), so the Keycloak token and
//! every wire concern stay in one place.
//!
//! The command surface mirrors `src/ipc/bindings.ts`. The job runner
//! (`jobs_*`, Epic 06) spawns `py/web.py`/`py/ocr.py` for real, sequentially
//! (no queue/concurrency cap yet) — see `core::jobs` and `core::python`.

pub mod commands;
pub mod core;
pub mod dto;
pub mod error;

use std::path::Path;

use tauri::{AppHandle, Emitter, Manager};

use commands::AppState;
use core::db::Db;
use core::fs::watcher::FsWatcher;

/// Filename of the SQLite index inside the app data dir.
const INDEX_FILENAME: &str = "index.db";

/// The event name the watcher pushes on. Mirrors `ipc/events.ts`.
const FS_CHANGED_EVENT: &str = "fs://changed";

/// Point the watcher at the given roots and emit `fs://changed` for anything
/// that moves under them.
///
/// Best-effort by design: a watch that cannot be established (an unplugged
/// network drive, a root the operator deleted) must not stop the app. The
/// Overview still refreshes on demand — it just will not update by itself.
pub fn rewatch(
    app: &AppHandle,
    state: &AppState,
    unprocessed: Option<&Path>,
    processed: Option<&Path>,
) {
    let handle = app.clone();
    let result = state
        .watcher
        .watch_roots(unprocessed, processed, move |event| {
            let _ = handle.emit(FS_CHANGED_EVENT, event);
        });

    if let Err(e) = result {
        eprintln!("[nbcg-dc] could not watch the scan roots: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();

            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            std::fs::create_dir_all(&data_dir)?;

            // Two sources for the vendored interpreter, tried in an order
            // that depends on the build profile:
            //
            // - Debug: the repo's own tree first. Tauri copies
            //   `bundle.resources` next to the dev binary only when its build
            //   script runs, so `resource_dir()` there is a *snapshot* —
            //   preferring it would serve whatever `py/` looked like at the
            //   last build, and would hide a freshly vendored interpreter
            //   behind the stale `.gitkeep` placeholder captured before it.
            // - Release: the bundled resources first, so a release build made
            //   on this machine still exercises the real installed-app path
            //   instead of silently reaching back into the repo.
            //
            // Both probes require the interpreter to really be on disk, and
            // `detect_dev`'s paths are compile-time ones that exist only on
            // the machine that built the binary — so an installed app resolves
            // through `resource_dir()` either way, and with nothing vendored
            // at all this stays `None`: bare system `python`/`py`, as before.
            //
            // `.ok()`, not `?`: a `resource_dir()` resolution failure degrades
            // to that same fallback rather than aborting startup.
            let bundled = || {
                app.path()
                    .resource_dir()
                    .ok()
                    .and_then(|dir| core::python::PythonRuntime::detect(&dir))
            };
            let python_runtime = if cfg!(debug_assertions) {
                core::python::PythonRuntime::detect_dev().or_else(bundled)
            } else {
                bundled().or_else(core::python::PythonRuntime::detect_dev)
            };

            let db = Db::open(&data_dir.join(INDEX_FILENAME))?;
            let state = AppState {
                db,
                config_dir,
                watcher: FsWatcher::new(),
                job_run: std::sync::Mutex::new(Default::default()),
                python_runtime,
            };

            // Start watching whatever is already configured. A first run has no
            // roots yet; `config_save` re-points the watcher once they are set.
            if let Ok((unprocessed, processed)) = state.roots() {
                rewatch(
                    &handle,
                    &state,
                    unprocessed.as_deref(),
                    processed.as_deref(),
                );
            }

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::config::config_load,
            commands::config::config_save,
            commands::config::config_get_secret,
            commands::config::config_set_secret,
            commands::config::config_delete_secret,
            commands::fs::fs_pick_directory,
            commands::fs::fs_path_exists,
            commands::fs::fs_read_metadata,
            commands::fs::fs_write_metadata,
            commands::fs::fs_reveal_path,
            commands::fs::fs_move_to_processed,
            commands::fs::fs_read_file,
            commands::fs::fs_peek_folder,
            commands::index::index_scan,
            commands::index::index_list,
            commands::index::index_rebuild,
            commands::index::index_rebuild_impact,
            commands::index::index_record_upload,
            commands::index::index_record_sync,
            commands::index::index_set_hidden,
            commands::batch::batch_list,
            commands::batch::batch_create,
            commands::batch::batch_update,
            commands::batch::batch_archive,
            commands::sync::sync_log_append,
            commands::sync::sync_log_list,
            commands::jobs::jobs_start,
            commands::jobs::jobs_cancel,
            commands::jobs::jobs_reprocess,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
