//! Shared fixtures for the core tests.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::Path;

use nbcg_dc_lib::core::fs::{DerivedFiles, DiscoveredFolder};
use nbcg_dc_lib::dto::*;

/// A discovered folder with nothing but filesystem facts — no mirror.
pub fn folder(name: &str, root: ScanRoot) -> DiscoveredFolder {
    DiscoveredFolder {
        id: nbcg_dc_lib::core::fs::item_id_for(name),
        folder_name: name.to_string(),
        folder_path: format!("/roots/{}/{name}", root.as_str()),
        relative_path: name.to_string(),
        parent_path: None,
        root,
        level: None,
        title: None,
        cobiss_id: None,
        backend_id: None,
        version: None,
        target_state: None,
        visibility_status: None,
        synced_at: None,
        assets: Vec::new(),
        derived: DerivedFiles::default(),
    }
}

/// A discovered folder carrying a `metadata.json` mirror with a backend id.
pub fn connected_folder(name: &str, backend_id: &str) -> DiscoveredFolder {
    let mut f = folder(name, ScanRoot::Unprocessed);
    f.backend_id = Some(backend_id.to_string());
    f.version = Some(3);
    f.target_state = Some(ItemType::Record);
    f.visibility_status = Some(VisibilityStatus::Public);
    f.title = Some(format!("{name} title"));
    f
}

pub fn asset(filename: &str, size: i64) -> IndexedAssetDto {
    IndexedAssetDto {
        filename: filename.to_string(),
        path: format!("/roots/unprocessed/x/{filename}"),
        size_bytes: Some(size),
    }
}

/// The minimum viable batch-create payload over the given items.
///
/// Generic over the id type so call sites can pass `&[&str]`, `&[&String]`, or
/// a collected `Vec<&str>` without ceremony.
pub fn batch_over<S: AsRef<str>>(item_ids: &[S]) -> BatchCreateDto {
    BatchCreateDto {
        item_type: ItemState::ToProcess,
        item_ids: item_ids.iter().map(|s| s.as_ref().to_string()).collect(),
        stage: BatchStage::Setup,
        running: false,
        proc: HashMap::new(),
        cobiss_id: None,
        parents: Vec::new(),
        publish: ItemType::Draft,
        visibility: VisibilityStatus::Public,
        overrides: HashMap::new(),
    }
}

pub fn sync_run(summary: &str, started_at: &str) -> SyncRunCreateDto {
    SyncRunCreateDto {
        started_at: started_at.to_string(),
        finished_at: started_at.to_string(),
        status: SyncRunStatus::Ok,
        trigger: SyncTrigger::Manual,
        checked: 4,
        updated: 1,
        up_to_date: 3,
        missed: 0,
        summary: summary.to_string(),
        detail: String::new(),
    }
}

/// Create `<root>/<name>/` and write `files` into it.
pub fn make_item_dir(root: &Path, name: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).expect("create item dir");
    for (filename, contents) in files {
        std::fs::write(dir.join(filename), contents).expect("write file");
    }
    dir
}

pub fn metadata_mirror(backend_id: Option<&str>, title: &str) -> LocalMetadataFile {
    LocalMetadataFile {
        backend_id: backend_id.map(String::from),
        version: Some(2),
        target_state: Some(ItemType::Draft),
        visibility_status: Some(VisibilityStatus::Private),
        metadata: serde_json::json!({ "title": title, "collectionType": 0 }),
        synced_at: "2026-08-12T10:00:00.000Z".to_string(),
    }
}
