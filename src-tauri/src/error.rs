//! The single error type crossing the IPC boundary.
//!
//! Tauri requires a command's error to be `Serialize`. We serialize as a plain
//! string so the TypeScript side gets a readable `Error.message` — the logic
//! lane never branches on a Rust error *kind*, it only reports or retries, so a
//! structured payload would be unused weight.

use serde::{Serialize, Serializer};

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("secret store error: {0}")]
    Keyring(String),

    /// A referenced row does not exist (unknown item id, unknown batch id).
    #[error("not found: {0}")]
    NotFound(String),

    /// The caller passed something the core cannot act on (e.g. a root that is
    /// not configured, a path outside the configured roots).
    #[error("invalid input: {0}")]
    Invalid(String),

    #[error("{0}")]
    Other(String),
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        AppError::Keyring(e.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
