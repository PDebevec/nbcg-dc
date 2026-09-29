//! Pre-batch snapshots of item folders — what makes a batch deletable
//! (docs/superpowers/specs/2026-09-29-delete-batch-design.md).
//!
//! When a batch is created, each member's **item scope** is hard-linked into
//! `<scan root>/.nbcg-snapshots/<batch id>/<item id>/`; deleting the batch
//! makes the folder match that snapshot again. Hard links cost no space and
//! no time, and every write this app makes replaces a file by renaming a new
//! one over it (`core::fs::write_metadata`, `finalize_staged_output`), which
//! leaves the snapshot's link on the old bytes. Where a volume can't hard-link
//! (FAT/exFAT, some network shares) the file is copied instead.
//!
//! Known limit: a program that edits a file *in place* changes the snapshot's
//! copy too, since both names are one file. The app never does; most editors
//! write a new file and rename it.
//!
//! Item scope = the folder's direct files plus the files directly in its
//! `source/` subfolder (where the supplied-pdf stage files the operator's
//! PDF). Other subfolders are separate items (nested records) and are never
//! touched; `.nbcg-tmp-*` staging folders are the job runner's scratch space —
//! never snapshotted, always removed on restore.
//!
//! Pure file operations on paths — no database, no config. A path inside a
//! scope is a `/`-joined relative string (`"a.pdf"`, `"source/a.pdf"`).

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

use crate::core::fs::{METADATA_FILENAME, SOURCE_SUBFOLDER};
use crate::error::{AppError, Result};

/// The folder under each scan root holding every live snapshot. A dot folder,
/// so the scanner never lists it as an item.
pub const SNAPSHOTS_DIR: &str = ".nbcg-snapshots";

/// Prefix of the job runner's per-run staging folders
/// (`core::jobs::stages::staging_dir`).
const STAGING_PREFIX: &str = ".nbcg-tmp-";

/// Suffix of the temp name a restored file is linked to before being renamed
/// into place.
const RESTORE_SUFFIX: &str = ".nbcg-restore";

/// `<root>/.nbcg-snapshots/<batch_id>` — every snapshot one batch took under one root.
pub fn batch_dir(root: &Path, batch_id: &str) -> PathBuf {
    root.join(SNAPSHOTS_DIR).join(batch_id)
}

/// `<root>/.nbcg-snapshots/<batch_id>/<item_id>` — one item's snapshot. Keyed
/// by id rather than relative path so a nested item's snapshot never sits
/// inside its parent's.
pub fn item_dir(root: &Path, batch_id: &str, item_id: &str) -> PathBuf {
    batch_dir(root, batch_id).join(item_id)
}

/// The scan root an item folder sits under: `folder` with its `relative_path`
/// (`/`-joined, as the index stores it) taken off the end. Derived from the
/// item rather than from config, so a root changed in Settings mid-batch
/// can't send a snapshot somewhere else.
pub fn root_of(folder: &Path, relative_path: &str) -> Option<PathBuf> {
    let depth = relative_path.split('/').filter(|s| !s.is_empty()).count();
    if depth == 0 {
        return None;
    }
    let mut root = folder.to_path_buf();
    for _ in 0..depth {
        if !root.pop() {
            return None;
        }
    }
    Some(root)
}

/// Whether a path lies inside a snapshot folder — the watcher ignores those,
/// or taking a snapshot would trigger a rescan.
pub fn is_snapshot_path(path: &Path) -> bool {
    path.components()
        .any(|c| matches!(c, Component::Normal(name) if name == OsStr::new(SNAPSHOTS_DIR)))
}

fn source_prefix() -> String {
    format!("{SOURCE_SUBFOLDER}/")
}

fn to_fs_path(base: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(base.to_path_buf(), |path, part| path.join(part))
}

/// Every file in `folder`'s item scope, keyed by its `/`-joined path in the
/// scope. A missing folder has an empty scope.
fn scope_files(folder: &Path) -> Result<BTreeMap<String, PathBuf>> {
    let mut out = BTreeMap::new();
    for (prefix, dir) in [
        (String::new(), folder.to_path_buf()),
        (source_prefix(), folder.join(SOURCE_SUBFOLDER)),
    ] {
        if !dir.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            out.insert(format!("{prefix}{name}"), entry.path());
        }
    }
    Ok(out)
}

/// The `.nbcg-tmp-*` folders directly in `folder`.
fn staging_dirs(folder: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    if !folder.is_dir() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(folder)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_dir() && name.starts_with(STAGING_PREFIX) {
            out.push(name);
        }
    }
    out.sort();
    Ok(out)
}

/// Hard-link `src` at `dst`, or copy it where the volume can't hard-link.
fn link_or_copy(src: &Path, dst: &Path) -> Result<()> {
    if std::fs::hard_link(src, dst).is_ok() {
        return Ok(());
    }
    std::fs::copy(src, dst)?;
    Ok(())
}

/// Snapshot `folder`'s item scope into `dest`, which must not exist yet. On
/// failure nothing is left at `dest`.
pub fn take(folder: &Path, dest: &Path) -> Result<()> {
    take_with(folder, dest, link_or_copy)
}

fn take_with(folder: &Path, dest: &Path, link: fn(&Path, &Path) -> Result<()>) -> Result<()> {
    if !folder.is_dir() {
        return Err(AppError::Invalid(format!(
            "{} is not a folder any more - rescan and try again",
            folder.display()
        )));
    }
    if dest.exists() {
        return Err(AppError::Invalid(format!(
            "a snapshot already exists at {}",
            dest.display()
        )));
    }
    let result = (|| -> Result<()> {
        std::fs::create_dir_all(dest)?;
        for (rel, src) in scope_files(folder)? {
            let target = to_fs_path(dest, &rel);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            link(&src, &target)?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(dest);
    }
    result
}

/// What restoring a folder from its snapshot would change.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FolderDiff {
    /// In the scope now but not in the snapshot — removed on restore.
    pub remove: Vec<String>,
    /// In the snapshot but missing now, or different — put back on restore.
    pub restore: Vec<String>,
    /// `.nbcg-tmp-*` staging folders in the item folder — removed on restore.
    pub staging: Vec<String>,
    /// Every path in either the folder's scope or the snapshot.
    pub scope: BTreeSet<String>,
}

/// Compare `folder` with `snapshot`. Read-only.
pub fn diff(folder: &Path, snapshot: &Path) -> Result<FolderDiff> {
    if !snapshot.is_dir() {
        return Err(AppError::Invalid(format!(
            "its snapshot at {} is missing",
            snapshot.display()
        )));
    }
    let current = scope_files(folder)?;
    let before = scope_files(snapshot)?;

    let remove = current
        .keys()
        .filter(|rel| !before.contains_key(*rel))
        .cloned()
        .collect();
    let mut restore = Vec::new();
    for (rel, snap) in &before {
        match current.get(rel) {
            Some(now) if same_file(now, snap)? => {}
            _ => restore.push(rel.clone()),
        }
    }
    let scope = current.keys().chain(before.keys()).cloned().collect();
    Ok(FolderDiff {
        remove,
        restore,
        staging: staging_dirs(folder)?,
        scope,
    })
}

/// Whether two paths hold the same file, judged by size and modified time —
/// a hard link shares both; the app's rename-over writes change the time.
/// `std::fs::metadata`, not `DirEntry::metadata`: on Windows the latter reads
/// the directory entry's cached copy, which goes stale for a hard-linked file
/// changed through its other name.
fn same_file(a: &Path, b: &Path) -> Result<bool> {
    let (a, b) = (std::fs::metadata(a)?, std::fs::metadata(b)?);
    Ok(a.len() == b.len() && a.modified()? == b.modified()?)
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// Make `folder`'s item scope match `snapshot` exactly. Idempotent: running it
/// again after a partial failure finishes the job.
pub fn restore(folder: &Path, snapshot: &Path) -> Result<()> {
    let plan = diff(folder, snapshot)?;
    std::fs::create_dir_all(folder)?;
    for rel in &plan.remove {
        std::fs::remove_file(to_fs_path(folder, rel))?;
    }
    for name in &plan.staging {
        std::fs::remove_dir_all(folder.join(name))?;
    }
    for rel in &plan.restore {
        let target = to_fs_path(folder, rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp = with_suffix(&target, RESTORE_SUFFIX);
        let _ = std::fs::remove_file(&temp);
        link_or_copy(&to_fs_path(snapshot, rel), &temp)?;
        // Replaces an existing target on Windows too (MoveFileEx with
        // MOVEFILE_REPLACE_EXISTING).
        if let Err(e) = std::fs::rename(&temp, &target) {
            let _ = std::fs::remove_file(&temp);
            return Err(e.into());
        }
    }
    // A `source/` the snapshot doesn't have was made by the batch; drop it
    // once emptied (remove_dir fails, harmlessly, while anything is left).
    if !snapshot.join(SOURCE_SUBFOLDER).is_dir() {
        let _ = std::fs::remove_dir(folder.join(SOURCE_SUBFOLDER));
    }
    Ok(())
}

/// Remove one batch's snapshot folder under one root, then `.nbcg-snapshots`
/// itself once nothing else is in it. Missing is fine.
///
/// Refuses any path that isn't `<…>/.nbcg-snapshots/<batch_id>`: this is a
/// recursive delete, and the path comes from a database row.
pub fn drop_batch(batch_dir: &Path, batch_id: &str) -> Result<()> {
    let parent = batch_dir.parent();
    let is_snapshot_folder = batch_dir.file_name() == Some(OsStr::new(batch_id))
        && parent.and_then(Path::file_name) == Some(OsStr::new(SNAPSHOTS_DIR));
    if !is_snapshot_folder {
        return Err(AppError::Invalid(format!(
            "{} is not a snapshot folder of batch {batch_id}",
            batch_dir.display()
        )));
    }
    match std::fs::remove_dir_all(batch_dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    if let Some(parent) = parent {
        let _ = std::fs::remove_dir(parent); // only succeeds when empty
    }
    Ok(())
}

/// Remove every batch folder under `<root>/.nbcg-snapshots` whose batch id is
/// not in `live` — left behind by a crash between a database commit and the
/// folder cleanup after it.
pub fn sweep(root: &Path, live: &HashSet<String>) -> Result<()> {
    let dir = root.join(SNAPSHOTS_DIR);
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_dir() && !live.contains(&name) {
            std::fs::remove_dir_all(entry.path())?;
        }
    }
    let _ = std::fs::remove_dir(&dir); // only succeeds when empty
    Ok(())
}

/// Whether `rel` is a file this app writes into an item folder, by the
/// folder-derived naming convention (docs/01 §Naming). Only used to flag, in
/// the delete confirmation, the files that are **not** — an operator's own
/// file is never removed without being named as such. `scope` is every path
/// in the folder or its snapshot (for OCR text beside a PDF).
pub fn is_app_output(rel: &str, folder_name: &str, scope: &BTreeSet<String>) -> bool {
    if rel.starts_with(&source_prefix()) || rel.ends_with(RESTORE_SUFFIX) {
        return true;
    }
    let fixed = [
        format!("{folder_name}.pdf"),
        format!("{folder_name}_archive.pdf"),
        format!("{folder_name}_thumb.png"),
        format!("{folder_name}.txt"),
        METADATA_FILENAME.to_string(),
        format!("{METADATA_FILENAME}.tmp"),
    ];
    if fixed.iter().any(|name| name == rel) {
        return true;
    }
    let Some((stem, ext)) = rel.rsplit_once('.') else {
        return false;
    };
    // Page-numbered outputs: `<name>_<n>.pdf`, `<name>_<n>.txt`.
    if let Some(n) = stem.strip_prefix(&format!("{folder_name}_")) {
        if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && (ext == "pdf" || ext == "txt")
        {
            return true;
        }
    }
    // OCR text for one of several PDFs: `<base>.txt` beside `<base>.pdf`.
    ext == "txt" && scope.contains(&format!("{stem}.pdf"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copy_only(src: &Path, dst: &Path) -> Result<()> {
        std::fs::copy(src, dst)?;
        Ok(())
    }

    /// The copy fallback (a volume that can't hard-link) restores the same
    /// folder a hard-linked snapshot does.
    #[test]
    fn a_copied_snapshot_restores_like_a_linked_one() {
        let tmp = tempfile::TempDir::new().unwrap();
        let folder = tmp.path().join("scanned/BOOK");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("1.jpg"), "page one").unwrap();
        std::fs::write(folder.join("metadata.json"), "before").unwrap();
        let snap = item_dir(&tmp.path().join("scanned"), "b1", "i1");
        take_with(&folder, &snap, copy_only).unwrap();

        std::fs::write(folder.join("metadata.json.new"), "after").unwrap();
        std::fs::rename(
            folder.join("metadata.json.new"),
            folder.join("metadata.json"),
        )
        .unwrap();
        std::fs::write(folder.join("BOOK.pdf"), "derived").unwrap();
        restore(&folder, &snap).unwrap();

        assert_eq!(
            std::fs::read_to_string(folder.join("metadata.json")).unwrap(),
            "before"
        );
        assert!(!folder.join("BOOK.pdf").exists());
    }
}
