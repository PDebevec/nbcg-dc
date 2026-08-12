//! Scan-root watcher — emits `fs://changed` so freshly scanned folders appear
//! without a restart (Epic 02).
//!
//! The debounce lives on the **TypeScript** side (`useItems.startWatching`
//! debounces before rescanning), so this layer stays a plain translation of
//! notify events into the DTO. Debouncing in both places would compound the
//! delay for no benefit.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::dto::{FsChangeKind, FsChangedEvent, ScanRoot};
use crate::error::Result;

/// Owns the live watchers. Dropping this stops watching — so it must be held
/// for as long as the app runs (it lives in Tauri managed state).
#[derive(Default)]
pub struct FsWatcher {
    watchers: Mutex<Vec<RecommendedWatcher>>,
}

impl FsWatcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Watch both roots, replacing any previous watch.
    ///
    /// Called at startup and again whenever the configured roots change — a
    /// stale watcher on the old folder would report changes the app no longer
    /// cares about while missing the new root entirely.
    pub fn watch_roots<F>(
        &self,
        unprocessed: Option<&Path>,
        processed: Option<&Path>,
        emit: F,
    ) -> Result<()>
    where
        F: Fn(FsChangedEvent) + Send + Clone + 'static,
    {
        let mut guard = self.watchers.lock().unwrap_or_else(|e| e.into_inner());
        guard.clear();

        for (root, path) in [
            (ScanRoot::Unprocessed, unprocessed),
            (ScanRoot::Processed, processed),
        ] {
            let Some(path) = path else { continue };
            if !path.is_dir() {
                continue;
            }
            guard.push(spawn_watch(path, root, emit.clone())?);
        }

        Ok(())
    }

    /// Stop watching everything.
    pub fn clear(&self) {
        self.watchers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

fn spawn_watch<F>(path: &Path, root: ScanRoot, emit: F) -> Result<RecommendedWatcher>
where
    F: Fn(FsChangedEvent) + Send + 'static,
{
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        // A watch error (the folder was unmounted, permissions changed) is not
        // worth taking down: the operator's next manual refresh still works,
        // and there is no UI surface for "the watcher died".
        let Ok(event) = res else { return };
        let Some(kind) = classify(&event.kind) else {
            return;
        };
        for path in event.paths {
            emit(FsChangedEvent {
                root,
                kind,
                path: path.to_string_lossy().into_owned(),
            });
        }
    })
    .map_err(|e| crate::error::AppError::Other(format!("watcher: {e}")))?;

    watcher
        .watch(path, RecursiveMode::Recursive)
        .map_err(|e| crate::error::AppError::Other(format!("watch {}: {e}", path.display())))?;

    Ok(watcher)
}

/// Map a notify event kind onto the three the contract declares.
///
/// `Access` events are dropped: merely opening or reading a file is not a
/// change, and on Windows they fire constantly (including for our own reads
/// during a scan), which would drive a rescan loop.
fn classify(kind: &EventKind) -> Option<FsChangeKind> {
    match kind {
        EventKind::Create(_) => Some(FsChangeKind::Created),
        EventKind::Remove(_) => Some(FsChangeKind::Removed),
        EventKind::Modify(_) => Some(FsChangeKind::Modified),
        _ => None,
    }
}

/// Resolve which configured root a changed path sits under, if any.
pub fn root_for(
    path: &Path,
    unprocessed: Option<&Path>,
    processed: Option<&Path>,
) -> Option<ScanRoot> {
    let matches =
        |root: Option<&Path>| -> bool { root.map(|r| path.starts_with(r)).unwrap_or(false) };
    if matches(unprocessed) {
        Some(ScanRoot::Unprocessed)
    } else if matches(processed) {
        Some(ScanRoot::Processed)
    } else {
        None
    }
}

/// The item folder a changed path belongs to — the immediate child of the root.
///
/// A watch is recursive, so an event usually names a file *inside* an item
/// folder (`…/unprocessed/BOOK/page_003.jpg`); the consumer cares about `BOOK`.
pub fn item_folder_for(path: &Path, root_path: &Path) -> Option<PathBuf> {
    let relative = path.strip_prefix(root_path).ok()?;
    let first = relative.components().next()?;
    Some(root_path.join(first))
}
