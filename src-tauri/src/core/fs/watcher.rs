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

/// The item folder a changed path belongs to.
///
/// A watch is recursive and items can now nest at any depth, so a changed
/// path is one of two things: a folder itself (created/removed — it *is* an
/// item, at whatever depth), or a file inside one (the consumer cares about
/// its immediate containing folder, not the whole ancestor chain — each
/// folder is independently tracked, so the file's direct parent is the right
/// item). `path.is_dir()` disambiguates for `Create`/`Modify`; for `Remove`
/// the path is already gone and can't be stat'd, so this falls back to the
/// immediate parent — a reasonable best effort, not a hard guarantee. This
/// isn't relied on for exactness: the actual consumer
/// (`useItems.startWatching`, TS side) does a full debounced rescan on any
/// event regardless of which folder this names.
pub fn item_folder_for(path: &Path, root_path: &Path) -> Option<PathBuf> {
    let relative = path.strip_prefix(root_path).ok()?;
    if relative.as_os_str().is_empty() {
        return None; // the root itself, not an item
    }
    if path.is_dir() {
        return Some(path.to_path_buf());
    }
    let parent = relative.parent()?;
    if parent.as_os_str().is_empty() {
        return None; // a loose file directly at the root - no owning item
    }
    Some(root_path.join(parent))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_depth_one_folder_created_maps_to_itself() {
        let root = tempfile::TempDir::new().unwrap();
        let book = root.path().join("BOOK");
        std::fs::create_dir_all(&book).unwrap();

        assert_eq!(item_folder_for(&book, root.path()), Some(book));
    }

    #[test]
    fn a_file_inside_a_depth_one_folder_maps_to_its_containing_folder() {
        let root = tempfile::TempDir::new().unwrap();
        let book = root.path().join("BOOK");
        std::fs::create_dir_all(&book).unwrap();
        let page = book.join("page_003.jpg");
        std::fs::write(&page, b"x").unwrap();

        assert_eq!(item_folder_for(&page, root.path()), Some(book));
    }

    #[test]
    fn a_file_nested_three_levels_deep_maps_to_its_immediate_parent_not_the_top_level_wrapper() {
        let root = tempfile::TempDir::new().unwrap();
        let nested = root.path().join("Wrapper").join("BOOK-A");
        std::fs::create_dir_all(&nested).unwrap();
        let page = nested.join("1.jpg");
        std::fs::write(&page, b"x").unwrap();

        assert_eq!(item_folder_for(&page, root.path()), Some(nested));
    }

    #[test]
    fn a_nested_folder_created_maps_to_itself_not_its_wrapper() {
        let root = tempfile::TempDir::new().unwrap();
        let nested = root.path().join("Wrapper").join("BOOK-A");
        std::fs::create_dir_all(&nested).unwrap();

        assert_eq!(item_folder_for(&nested, root.path()), Some(nested));
    }

    #[test]
    fn a_loose_file_directly_at_the_root_has_no_owning_item() {
        let root = tempfile::TempDir::new().unwrap();
        let loose = root.path().join("notes.txt");
        std::fs::write(&loose, b"x").unwrap();

        assert_eq!(item_folder_for(&loose, root.path()), None);
    }

    #[test]
    fn a_path_outside_the_root_has_no_owning_item() {
        let root = tempfile::TempDir::new().unwrap();
        let elsewhere = tempfile::TempDir::new().unwrap();

        assert_eq!(item_folder_for(elsewhere.path(), root.path()), None);
    }
}
