//! Filesystem layer: scanning the roots, the per-folder `metadata.json`
//! mirror, and moving a finished item across roots.
//!
//! One folder = one item = one backend record (docs/03 decisions). Everything
//! here reports *observations* — which folders exist and what files are in
//! them. Deliberately absent: any judgement about what those files **mean**.
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

/// A stable id for an item folder, derived from its **name**.
///
/// Deliberately deterministic rather than a random UUID, for one reason:
/// `index_rebuild` wipes the item table and re-derives it from folders, and
/// batches reference items by id. A random id would survive the rebuild only
/// in the batch's membership list, silently emptying every batch. Hashing the
/// folder name reproduces the same ids, so batches still resolve.
///
/// It is keyed on the name and not the full path because an item's path
/// changes when it moves `/unprocessed` → `/processed`, and that move must not
/// change its identity. Renaming a folder *does* mint a new item, which is the
/// honest reading — the folder name is the item's name and its derived files
/// are named after it.
///
/// FNV-1a, so the value is stable across platforms and runs (Rust's default
/// hasher is randomly seeded per process and would produce a different id every
/// launch).
pub fn item_id_for(folder_name: &str) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    let mut hash = OFFSET;
    for byte in folder_name.as_bytes() {
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

/// Scan a single root: every immediate subdirectory is one item.
pub fn scan_root(root_path: &Path, root: ScanRoot) -> Result<Vec<DiscoveredFolder>> {
    let mut out = Vec::new();

    for entry in std::fs::read_dir(root_path)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        out.push(describe_folder(&entry.path(), root)?);
    }

    out.sort_by(|a, b| a.folder_name.cmp(&b.folder_name));
    Ok(out)
}

/// Observe one item folder.
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

/// Move an item's folder from `/unprocessed` to `/processed`.
///
/// Returns the new folder path. Refuses to clobber an existing destination —
/// that would mean two items share a name, and silently merging them would
/// destroy one operator's work.
pub fn move_to_processed(folder: &Path, processed_root: &Path) -> Result<PathBuf> {
    if !folder.is_dir() {
        return Err(AppError::Invalid(format!(
            "{} is not a directory",
            folder.display()
        )));
    }
    let name = folder
        .file_name()
        .ok_or_else(|| AppError::Invalid(format!("{} has no folder name", folder.display())))?;

    std::fs::create_dir_all(processed_root)?;
    let destination = processed_root.join(name);

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
