//! Config persistence.
//!
//! The **secret** half is deliberately not covered here: `keyring` writes to
//! the real Windows Credential Manager for the logged-in user, so a test would
//! mutate the developer's own credential store and, worse, could clobber a real
//! `apiToken`. The store-file half below is what has logic worth asserting;
//! the keyring calls are a thin pass-through with no branching except the
//! `NoEntry` mapping.

mod common;

use nbcg_dc_lib::core::config;
use nbcg_dc_lib::dto::{PersistedConfig, ThemePreference};
use tempfile::TempDir;

fn sample() -> PersistedConfig {
    PersistedConfig {
        unprocessed_root: Some(r"D:\scans\unprocessed".into()),
        processed_root: Some(r"D:\scans\processed".into()),
        backend_base_url: Some("http://localhost:3000".into()),
        api_prefix: Some("/api".into()),
        theme: Some(ThemePreference::Dark),
        data_passing_collection_types: Some(vec![1, 4]),
        ..Default::default()
    }
}

#[test]
fn loading_a_fresh_install_is_none() {
    let dir = TempDir::new().unwrap();
    assert_eq!(config::load(dir.path()).unwrap(), None);
}

#[test]
fn save_then_load_round_trips() {
    let dir = TempDir::new().unwrap();
    config::save(dir.path(), &sample()).unwrap();

    assert_eq!(config::load(dir.path()).unwrap(), Some(sample()));
}

#[test]
fn save_creates_the_config_directory() {
    let parent = TempDir::new().unwrap();
    let nested = parent.path().join("does/not/exist/yet");

    config::save(&nested, &sample()).unwrap();

    assert!(config::config_path(&nested).is_file());
}

#[test]
fn a_partial_config_round_trips_without_inventing_defaults() {
    let dir = TempDir::new().unwrap();
    let partial = PersistedConfig {
        backend_base_url: Some("http://localhost:3000".into()),
        ..Default::default()
    };

    config::save(dir.path(), &partial).unwrap();
    let loaded = config::load(dir.path()).unwrap().unwrap();

    // Absent keys must stay absent — the TS side merges with DEFAULT_CONFIG,
    // and a null written here would override a default rather than defer to it.
    assert_eq!(
        loaded.backend_base_url.as_deref(),
        Some("http://localhost:3000")
    );
    assert_eq!(loaded.unprocessed_root, None);
    assert_eq!(loaded.theme, None);
}

#[test]
fn a_corrupt_store_reads_as_absent_rather_than_failing() {
    let dir = TempDir::new().unwrap();
    std::fs::write(config::config_path(dir.path()), "{ not json at all").unwrap();

    // An app that cannot start until someone hand-edits JSON is worse than one
    // that reopens on the first-run card — every value here is re-enterable.
    assert_eq!(config::load(dir.path()).unwrap(), None);
}

#[test]
fn saving_leaves_no_temp_file_behind() {
    let dir = TempDir::new().unwrap();
    config::save(dir.path(), &sample()).unwrap();

    let names: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["config.json"]);
}

#[test]
fn saving_twice_replaces_the_previous_config() {
    let dir = TempDir::new().unwrap();
    config::save(dir.path(), &sample()).unwrap();
    config::save(
        dir.path(),
        &PersistedConfig {
            backend_base_url: Some("https://api.nbcg.me".into()),
            ..Default::default()
        },
    )
    .unwrap();

    let loaded = config::load(dir.path()).unwrap().unwrap();
    assert_eq!(
        loaded.backend_base_url.as_deref(),
        Some("https://api.nbcg.me")
    );
    assert_eq!(loaded.unprocessed_root, None);
}

/// The job-runner concurrency caps are a backend-only knob (hand-edited in
/// config.json), never surfaced in Settings — so the `.ts` side never sends
/// them on `config_save`. Prove `save_preserving_job_limits` does what its
/// name says: a payload that omits them (exactly what a real GUI save looks
/// like) does not erase a value already on disk.
#[test]
fn save_preserving_job_limits_keeps_a_hand_edited_cap() {
    let dir = TempDir::new().unwrap();
    config::save(
        dir.path(),
        &PersistedConfig {
            max_concurrent_items: Some(5),
            max_concurrent_ocr: Some(2),
            ..sample()
        },
    )
    .unwrap();

    // A settings save from the GUI: same shape `sample()` has, i.e. no
    // `maxConcurrentItems`/`maxConcurrentOcr` at all - a different field
    // actually changes, which is the point (this isn't a no-op save).
    let gui_save = PersistedConfig {
        backend_base_url: Some("https://api.nbcg.me".into()),
        ..sample()
    };
    config::save_preserving_job_limits(dir.path(), gui_save).unwrap();

    let loaded = config::load(dir.path()).unwrap().unwrap();
    assert_eq!(loaded.max_concurrent_items, Some(5));
    assert_eq!(loaded.max_concurrent_ocr, Some(2));
    assert_eq!(
        loaded.backend_base_url.as_deref(),
        Some("https://api.nbcg.me")
    );
}

/// A fresh install has nothing on disk to preserve - the incoming payload's
/// own values (typically both `None`, since the `.ts` side never sets them)
/// win, with no error.
#[test]
fn save_preserving_job_limits_on_a_fresh_install_just_saves() {
    let dir = TempDir::new().unwrap();
    config::save_preserving_job_limits(dir.path(), sample()).unwrap();

    assert_eq!(config::load(dir.path()).unwrap(), Some(sample()));
}

/// The token must never be written into the plain config file — that is the
/// whole reason the secret store exists.
#[test]
fn the_config_file_contains_no_token_field() {
    let dir = TempDir::new().unwrap();
    config::save(dir.path(), &sample()).unwrap();

    let raw = std::fs::read_to_string(config::config_path(dir.path())).unwrap();
    assert!(!raw.contains("apiToken"));
    assert!(!raw.contains("token"));
}
