//! The IPC surface — thin `#[tauri::command]` wrappers over [`crate::core`].
//!
//! Nothing here should contain logic worth testing. Each function resolves
//! managed state, calls into the core, and lets the error type serialize
//! itself. That is what keeps the core testable without a webview.

pub mod batch;
pub mod config;
pub mod fs;
pub mod index;
pub mod sync;

use std::path::PathBuf;

use crate::core::db::Db;
use crate::core::fs::watcher::FsWatcher;
use crate::error::Result;

/// Everything the commands need, held as Tauri managed state.
pub struct AppState {
    pub db: Db,
    /// Where `config.json` lives (the OS app-config dir in production, a temp
    /// dir in tests).
    pub config_dir: PathBuf,
    pub watcher: FsWatcher,
}

impl AppState {
    /// The two configured scan roots, as paths.
    ///
    /// Unconfigured roots come back as `None` rather than an error — a
    /// first run has neither, and every caller here treats that as "nothing to
    /// scan" rather than a failure.
    pub fn roots(&self) -> Result<(Option<PathBuf>, Option<PathBuf>)> {
        let config = crate::core::config::load(&self.config_dir)?.unwrap_or_default();
        Ok((
            config.unprocessed_root.map(PathBuf::from),
            config.processed_root.map(PathBuf::from),
        ))
    }
}
