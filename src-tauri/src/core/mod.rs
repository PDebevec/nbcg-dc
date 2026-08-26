//! Implementation core — no Tauri glue.
//!
//! Everything in here is plain Rust over the filesystem, SQLite and the OS
//! credential store, so it is unit-testable without a webview or an app handle.
//! The `#[tauri::command]` wrappers in [`crate::commands`] are deliberately
//! thin: they resolve state, call in here, and translate errors.

pub mod cancel;
pub mod config;
pub mod db;
pub mod fs;
pub mod jobs;
pub mod python;
