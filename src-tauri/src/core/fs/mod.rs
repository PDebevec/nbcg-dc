//! Filesystem layer: scanning the roots, the per-folder `metadata.json`
//! mirror, and moving a finished item across roots.
//!
//! One folder = one item = one backend record (docs/03 decisions) — at
//! **any** depth under a scan root, not just the top level; the scanner does
//! not judge which folder is "the real" record, the operator does (hide the
//! rest). Everything here reports *observations* — which folders exist and
//! what files are in them. Deliberately absent: any judgement about what
//! those files **mean**.
//! Classifying an asset as a source scan vs a web PDF vs a thumbnail is the
//! logic lane's job (`domain/files`), and duplicating the naming convention
//! here would give it two places to drift.
//!
//! The one exception is [`DerivedFiles`], used only by `index_rebuild`, which
//! by definition has no index to read and must infer stage completion from
//! filenames. It mirrors `domain/naming` and is the only naming knowledge in
//! this crate.

pub mod watcher;

use std::path::{Path, PathBuf};

use crate::dto::{
    IndexedAssetDto, ItemLevel, ItemType, LocalMetadataFile, ScanRoot, VisibilityStatus,
};
use crate::error::{AppError, Result};

/// The mirror file inside each item folder.
pub const METADATA_FILENAME: &str = "metadata.json";

/// Which derived outputs exist in a folder. Used only to reconstruct stage
/// status during a rebuild.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DerivedFiles {
    /// `<name>.pdf` — the downscaled web PDF (the one that gets uploaded).
    pub web_pdf: bool,
    /// `<name>_archive.pdf` — the full-quality archival master (stays local).
    pub archival_pdf: bool,
    /// `<name>_thumb.png`
    pub thumbnail: bool,
    /// `<name>.txt`
    pub ocr_text: bool,
}

/// One item folder as observed on disk, plus whatever its `metadata.json`
/// mirror claims. The index consumes these — see [`crate::core::db::items`].
#[derive(Debug, Clone)]
pub struct DiscoveredFolder {
    pub id: String,
    pub folder_name: String,
    pub folder_path: String,
    /// This folder's path relative to its scan root, forward-slash-joined
    /// (e.g. `"Cèrnagora/CERNAGORA"`). For a depth-1 folder this is just
    /// `folder_name`. Feeds [`item_id_for`] and the Overview list's
    /// hierarchy display — see that function's doc comment.
    pub relative_path: String,
    /// The immediate parent folder's absolute path, `None` at depth 1.
    pub parent_path: Option<String>,
    pub root: ScanRoot,
    pub level: Option<ItemLevel>,
    pub title: Option<String>,
    pub cobiss_id: Option<String>,
    pub backend_id: Option<String>,
    pub version: Option<i64>,
    pub target_state: Option<ItemType>,
    pub visibility_status: Option<VisibilityStatus>,
    pub synced_at: Option<String>,
    pub assets: Vec<IndexedAssetDto>,
    pub derived: DerivedFiles,
}

/// A stable id for an item folder, derived from its path **relative to its
/// scan root** (forward-slash-joined, e.g. `"Cèrnagora/CERNAGORA"`).
///
/// Deliberately deterministic rather than a random UUID, for one reason:
/// `index_rebuild` wipes the item table and re-derives it from folders, and
/// batches reference items by id. A random id would survive the rebuild only
/// in the batch's membership list, silently emptying every batch. Hashing the
/// relative path reproduces the same ids, so batches still resolve.
///
/// For a depth-1 folder the relative path **is** the bare folder name — every
/// id that existed before folders could nest deeper is unchanged. Nesting is
/// what makes the path (not just the leaf name) load-bearing: two folders at
/// different depths can share a leaf name (`arh/BookA/1` and `arh/BookB/1`),
/// and hashing only the name would collide them onto the same id, silently
/// overwriting one item's row with the other's on scan (`db::items::reconcile`
/// has no collision guard). Hashing the full relative path disambiguates them.
///
/// It is keyed on the relative path and not the absolute path because an
/// item's absolute path changes when it moves `/unprocessed` → `/processed`,
/// and that move must not change its identity — `move_to_processed` preserves
/// the relative path across the move for exactly this reason. Renaming *any*
/// folder in the chain (including a wrapper ancestor) *does* mint a new id
/// for it and everything nested under it, which is the honest reading: the
/// folder's name (and its ancestors' names) are part of the item's identity,
/// the same way a depth-1 folder's own name always was.
///
/// FNV-1a, so the value is stable across platforms and runs (Rust's default
/// hasher is randomly seeded per process and would produce a different id every
/// launch).
pub fn item_id_for(relative_path: &str) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    let mut hash = OFFSET;
    for byte in relative_path.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

/// Scan both configured roots.
///
/// A root that is `None` or missing on disk contributes nothing rather than
/// erroring: a half-configured first run, or an unplugged network drive, should
/// leave the app usable and show an empty list, not fail to start.
///
/// On a name collision across the two roots the **unprocessed** copy wins — it
/// is the one still being worked on, and ids must stay unique.
pub fn scan_roots(
    unprocessed: Option<&Path>,
    processed: Option<&Path>,
) -> Result<Vec<DiscoveredFolder>> {
    let mut out: Vec<DiscoveredFolder> = Vec::new();

    for (root, path) in [
        (ScanRoot::Unprocessed, unprocessed),
        (ScanRoot::Processed, processed),
    ] {
        let Some(path) = path else { continue };
        if !path.is_dir() {
            continue;
        }
        for folder in scan_root(path, root)? {
            if out.iter().any(|f| f.id == folder.id) {
                continue;
            }
            out.push(folder);
        }
    }

    Ok(out)
}

/// Safety valve against pathological/cyclic directory structures — not a
/// product decision. Any real archive is nowhere near this deep.
const MAX_SCAN_DEPTH: u32 = 32;

/// Directory names never worth listing as a candidate record, skipped
/// unconditionally (not configurable) at every depth. Dotfolders (name
/// starts with `.`) are skipped alongside these by [`walk`].
const SKIP_DIR_NAMES: &[&str] = &["System Volume Information", "$RECYCLE.BIN"];

/// Scan a single root: **every** folder at **any** depth is one item —
/// depth doesn't decide what's a record, the operator does (see
/// `docs/tasks/nested-record-folders-and-manual-selection.md`). Rows come
/// back sorted by `relative_path`, which — because a prefix always sorts
/// before any longer string it's a prefix of — places a folder immediately
/// before all of its own descendants, correctly interleaved with unrelated
/// siblings. No tree structure is built; the sort order plus each row's
/// depth (count of `/` in `relative_path`) is enough for a flat list to read
/// as hierarchical.
pub fn scan_root(root_path: &Path, root: ScanRoot) -> Result<Vec<DiscoveredFolder>> {
    let mut out = Vec::new();
    walk(root_path, root, "", None, 0, &mut out)?;
    out.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(out)
}

fn walk(
    dir: &Path,
    root: ScanRoot,
    prefix: &str,
    parent: Option<&str>,
    depth: u32,
    out: &mut Vec<DiscoveredFolder>,
) -> Result<()> {
    if depth >= MAX_SCAN_DEPTH {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        // `DirEntry::file_type()` does not follow symlinks (unlike
        // `Path::metadata()`), so a symlinked directory reports as neither a
        // plain dir nor a file here and is silently skipped — this is what
        // keeps a symlink cycle from recursing forever. Do not swap this for
        // `entry.path().metadata()` without re-adding an explicit guard.
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || SKIP_DIR_NAMES.contains(&name.as_str()) {
            continue;
        }

        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let entry_path = entry.path();
        let folder_path = entry_path.to_string_lossy().into_owned();

        let mut described = describe_folder(&entry_path, root)?;
        described.id = item_id_for(&relative);
        described.relative_path = relative.clone();
        described.parent_path = parent.map(str::to_string);
        out.push(described);

        walk(
            &entry_path,
            root,
            &relative,
            Some(&folder_path),
            depth + 1,
            out,
        )?;
    }

    Ok(())
}

/// Observe one item folder — its direct files only, never recursing into
/// subfolders (a subfolder is a separate candidate, observed separately).
/// Also used standalone by the `fs_peek_folder` command for an ad-hoc "view
/// contents" look at a folder that may not be a tracked item at all, which is
/// why `relative_path`/`parent_path` default to depth-1/standalone values
/// here — [`walk`] overwrites them with the true recursive context when this
/// is called as part of a scan.
pub fn describe_folder(folder: &Path, root: ScanRoot) -> Result<DiscoveredFolder> {
    let folder_name = folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::Invalid(format!("{} has no folder name", folder.display())))?;

    let mut assets = Vec::new();
    let mut derived = DerivedFiles::default();

    for entry in std::fs::read_dir(folder)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let filename = entry.file_name().to_string_lossy().into_owned();

        match filename.as_str() {
            f if f == format!("{folder_name}.pdf") => derived.web_pdf = true,
            f if f == format!("{folder_name}_archive.pdf") => derived.archival_pdf = true,
            f if f == format!("{folder_name}_thumb.png") => derived.thumbnail = true,
            f if f == format!("{folder_name}.txt") => derived.ocr_text = true,
            _ => {}
        }

        assets.push(IndexedAssetDto {
            path: entry.path().to_string_lossy().into_owned(),
            size_bytes: entry.metadata().ok().map(|m| m.len() as i64),
            filename,
        });
    }

    assets.sort_by(|a, b| a.filename.cmp(&b.filename));

    // An unreadable or malformed mirror is treated as absent. A folder whose
    // metadata.json is corrupt is still a real item that must appear in the
    // Overview — refusing to list it would hide the very item the operator
    // needs to fix.
    let mirror = read_metadata(folder).ok().flatten();

    let (title, cobiss_id, level) = match mirror.as_ref() {
        Some(m) => (
            m.metadata
                .get("title")
                .and_then(|v| v.as_str())
                .map(String::from),
            m.metadata.get("cobissId").and_then(|v| match v {
                serde_json::Value::String(s) => Some(s.clone()),
                serde_json::Value::Number(n) => Some(n.to_string()),
                _ => None,
            }),
            // `level` is the archive's own main-vs-child concept and is stored
            // under a private key — the backend has no equivalent field
            // (`jeGlavnoGradivo` is a dead constant, see PROJECT-KNOWLEDGE).
            m.metadata
                .get("_level")
                .and_then(|v| v.as_str())
                .and_then(ItemLevel::parse),
        ),
        None => (None, None, None),
    };

    Ok(DiscoveredFolder {
        id: item_id_for(&folder_name),
        relative_path: folder_name.clone(),
        parent_path: None,
        folder_name,
        folder_path: folder.to_string_lossy().into_owned(),
        root,
        level,
        title,
        cobiss_id,
        backend_id: mirror.as_ref().and_then(|m| m.backend_id.clone()),
        version: mirror.as_ref().and_then(|m| m.version),
        target_state: mirror.as_ref().and_then(|m| m.target_state),
        visibility_status: mirror.as_ref().and_then(|m| m.visibility_status),
        synced_at: mirror.as_ref().map(|m| m.synced_at.clone()),
        assets,
        derived,
    })
}

/// Read a folder's `metadata.json`. `Ok(None)` when the file is absent.
pub fn read_metadata(folder: &Path) -> Result<Option<LocalMetadataFile>> {
    let path = folder.join(METADATA_FILENAME);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    Ok(Some(serde_json::from_str(&raw)?))
}

/// Write a folder's `metadata.json` **atomically**.
///
/// Write to a sibling temp file, flush it to the platter, then rename over the
/// target. A rename within a directory is atomic, so a crash or a pulled power
/// cord leaves either the old mirror or the new one — never a half-written
/// file. This matters more here than it looks: the mirror is what
/// `index_rebuild` reconstructs the index from, so a truncated one loses an
/// item's backend connection and the next upload creates a duplicate record.
///
/// The `sync_all` before the rename is the part that is easy to drop and
/// impossible to notice in testing — without it the rename can reach the disk
/// ahead of the contents.
pub fn write_metadata(folder: &Path, metadata: &LocalMetadataFile) -> Result<()> {
    if !folder.is_dir() {
        return Err(AppError::Invalid(format!(
            "{} is not a directory",
            folder.display()
        )));
    }

    let target = folder.join(METADATA_FILENAME);
    let temp = folder.join(format!("{METADATA_FILENAME}.tmp"));
    let json = serde_json::to_string_pretty(metadata)?;

    {
        use std::io::Write;
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
    }

    // std::fs::rename replaces an existing destination on Windows (MoveFileEx
    // with MOVEFILE_REPLACE_EXISTING) as well as on unix.
    match std::fs::rename(&temp, &target) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            Err(e.into())
        }
    }
}

/// Finalize one file a subprocess already wrote to a staging location,
/// atomically, over `target` (Epic 06 job runner).
///
/// Same temp→sync→rename discipline as [`write_metadata`] above, but for a
/// file that already exists on disk (written by `py/web.py`/`py/ocr.py`)
/// rather than an in-memory buffer — so this is a sibling, not a
/// generalization: there is no bytes-in-hand to share the write step with.
/// `staged` is consumed (renamed away) on success; left in place on failure
/// so the caller's staging-dir cleanup still finds it.
pub fn finalize_staged_output(staged: &Path, target: &Path) -> Result<()> {
    {
        // `File::open` is read-only, and `sync_all` (`FlushFileBuffers` on
        // Windows) needs a writable handle even when nothing is written
        // through it — a read-only handle fails the flush with
        // `ERROR_ACCESS_DENIED`. Unix's `fsync` has no such restriction, but
        // opening for write costs nothing there either.
        let file = std::fs::OpenOptions::new().write(true).open(staged)?;
        file.sync_all()?;
    }

    // std::fs::rename replaces an existing destination on Windows (MoveFileEx
    // with MOVEFILE_REPLACE_EXISTING) as well as on unix.
    std::fs::rename(staged, target)?;
    Ok(())
}

/// Move an item's folder from `/unprocessed` to `/processed`, preserving its
/// full relative path (not just its leaf name) so any wrapper folders it sits
/// under are recreated on the processed side.
///
/// Returns the new folder path. Refuses to clobber an existing destination —
/// that would mean two items share a relative path, and silently merging
/// them would destroy one operator's work.
///
/// `relative` **must** be the same relative path `item_id_for` was hashed
/// from — flattening to just the leaf name here (as this function used to)
/// would change a nested item's relative path across the move and silently
/// mint it a new id mid-move, orphaning its upload/batch history.
pub fn move_to_processed(folder: &Path, relative: &Path, processed_root: &Path) -> Result<PathBuf> {
    if !folder.is_dir() {
        return Err(AppError::Invalid(format!(
            "{} is not a directory",
            folder.display()
        )));
    }

    let destination = processed_root.join(relative);
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }

    if destination.exists() {
        return Err(AppError::Invalid(format!(
            "{} already exists — refusing to overwrite",
            destination.display()
        )));
    }

    // A plain rename fails across volumes (roots can be on different drives),
    // so fall back to a recursive copy + delete.
    match std::fs::rename(folder, &destination) {
        Ok(()) => Ok(destination),
        Err(_) => {
            copy_dir_all(folder, &destination)?;
            std::fs::remove_dir_all(folder)?;
            Ok(destination)
        }
    }
}

fn copy_dir_all(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Whether a path exists and is a directory (Settings → folder validity).
pub fn path_exists(path: &Path) -> bool {
    path.is_dir()
}

/// Read a file's raw bytes, for building a multipart upload in the logic lane.
pub fn read_file(path: &Path) -> Result<Vec<u8>> {
    if !path.is_file() {
        return Err(AppError::NotFound(format!("{}", path.display())));
    }
    Ok(std::fs::read(path)?)
}
