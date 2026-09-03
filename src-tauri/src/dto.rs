//! Serde mirrors of the IPC contract declared in `src/ipc/bindings.ts`.
//!
//! This file is the Rust half of **Seam 2**. Every type here has a counterpart
//! in `bindings.ts`; field names go over the wire in `camelCase` and the string
//! unions become unit enums, so a rename on either side is a compile error here
//! or a type error there.
//!
//! Vocabulary is single-sourced with `@domain/item`, `@domain/batch` and
//! `@domain/enums` — see the doc comments in `bindings.ts` for the semantics of
//! each field. Where a rule is easy to get wrong (a null meaning "leave
//! unchanged" rather than "clear"), it is restated here next to the field.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// ─── shared vocabulary ───────────────────────────────────────────────────────

/// The two scan roots an item folder can live under.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanRoot {
    Unprocessed,
    Processed,
}

impl ScanRoot {
    pub fn as_str(self) -> &'static str {
        match self {
            ScanRoot::Unprocessed => "unprocessed",
            ScanRoot::Processed => "processed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "unprocessed" => Some(ScanRoot::Unprocessed),
            "processed" => Some(ScanRoot::Processed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemLevel {
    Main,
    Child,
}

impl ItemLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            ItemLevel::Main => "main",
            ItemLevel::Child => "child",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "main" => Some(ItemLevel::Main),
            "child" => Some(ItemLevel::Child),
            _ => None,
        }
    }
}

/// The five pipeline stages, in run order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StageName {
    Pdf,
    Thumbnail,
    Ocr,
    Metadata,
    Upload,
}

pub const STAGE_NAMES: [StageName; 5] = [
    StageName::Pdf,
    StageName::Thumbnail,
    StageName::Ocr,
    StageName::Metadata,
    StageName::Upload,
];

impl StageName {
    pub fn as_str(self) -> &'static str {
        match self {
            StageName::Pdf => "pdf",
            StageName::Thumbnail => "thumbnail",
            StageName::Ocr => "ocr",
            StageName::Metadata => "metadata",
            StageName::Upload => "upload",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pdf" => Some(StageName::Pdf),
            "thumbnail" => Some(StageName::Thumbnail),
            "ocr" => Some(StageName::Ocr),
            "metadata" => Some(StageName::Metadata),
            "upload" => Some(StageName::Upload),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StageStatus {
    Pending,
    Queued,
    Running,
    Done,
    Failed,
    Skipped,
}

impl StageStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            StageStatus::Pending => "pending",
            StageStatus::Queued => "queued",
            StageStatus::Running => "running",
            StageStatus::Done => "done",
            StageStatus::Failed => "failed",
            StageStatus::Skipped => "skipped",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(StageStatus::Pending),
            "queued" => Some(StageStatus::Queued),
            "running" => Some(StageStatus::Running),
            "done" => Some(StageStatus::Done),
            "failed" => Some(StageStatus::Failed),
            "skipped" => Some(StageStatus::Skipped),
            _ => None,
        }
    }
}

/// Which backend table an item lives in (`targetState`). The backend has no
/// single `Item` model — parallel `drafts`/`records` tables.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum ItemType {
    Draft,
    Record,
}

impl ItemType {
    pub fn as_str(self) -> &'static str {
        match self {
            ItemType::Draft => "DRAFT",
            ItemType::Record => "RECORD",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "DRAFT" => Some(ItemType::Draft),
            "RECORD" => Some(ItemType::Record),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum VisibilityStatus {
    Public,
    Private,
    Hidden,
}

impl VisibilityStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            VisibilityStatus::Public => "PUBLIC",
            VisibilityStatus::Private => "PRIVATE",
            VisibilityStatus::Hidden => "HIDDEN",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "PUBLIC" => Some(VisibilityStatus::Public),
            "PRIVATE" => Some(VisibilityStatus::Private),
            "HIDDEN" => Some(VisibilityStatus::Hidden),
            _ => None,
        }
    }
}

/// The derived item states. Only ever *received* here — as `BatchDto.type`,
/// the single state a batch was created from. Never computed in Rust
/// (`domain/item.deriveItemState` owns that).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ItemState {
    Uploaded,
    InProgress,
    NeedsReupload,
    Stopped,
    ToProcess,
}

impl ItemState {
    pub fn as_str(self) -> &'static str {
        match self {
            ItemState::Uploaded => "uploaded",
            ItemState::InProgress => "in-progress",
            ItemState::NeedsReupload => "needs-reupload",
            ItemState::Stopped => "stopped",
            ItemState::ToProcess => "to-process",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "uploaded" => Some(ItemState::Uploaded),
            "in-progress" => Some(ItemState::InProgress),
            "needs-reupload" => Some(ItemState::NeedsReupload),
            "stopped" => Some(ItemState::Stopped),
            "to-process" => Some(ItemState::ToProcess),
            _ => None,
        }
    }
}

// ─── local index DTOs (Epic 02) ──────────────────────────────────────────────

/// One discovered file, as the scan reports it. Deliberately **unclassified** —
/// the logic lane classifies by name via `@domain/files`, so the convention
/// lives in one place.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedAssetDto {
    pub filename: String,
    pub path: String,
    #[serde(default)]
    pub size_bytes: Option<i64>,
}

/// An ad-hoc "view contents" look at a folder — not necessarily a tracked
/// item (`fs_peek_folder`). Direct files only, same as `describe_folder`
/// itself never recurses into subfolders.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPeekDto {
    pub folder_name: String,
    pub assets: Vec<IndexedAssetDto>,
}

/// One stage's recorded outcome in the index.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedStageDto {
    pub status: StageStatus,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// One item folder as tracked by the index. `stages` may omit stages never
/// recorded — the logic lane defaults those to `pending`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedItemDto {
    pub id: String,
    pub folder_name: String,
    pub folder_path: String,
    /// This item's path relative to its scan root, forward-slash-joined
    /// (e.g. `"Cèrnagora/CERNAGORA"`) — equal to `folder_name` at depth 1.
    /// Drives the Overview list's hierarchy display; see
    /// `core::fs::item_id_for`'s doc comment for why it's also load-bearing
    /// for identity.
    pub relative_path: String,
    /// Operator-hidden from the default Overview list (never auto-set).
    pub hidden: bool,
    pub root: ScanRoot,
    /// From the folder's `metadata.json`; null when undetermined (the logic
    /// lane defaults to `main`).
    pub level: Option<ItemLevel>,
    pub assets: Vec<IndexedAssetDto>,
    pub stages: HashMap<StageName, IndexedStageDto>,
    pub uploaded: bool,
    pub reupload: bool,
    /// Only meaningful while `reupload` is true: whether the pending
    /// re-upload needs the blob replaced (`false`) or only its OCR text
    /// pushed (`true`) — see `core::db::items::ReuploadKind`.
    pub reupload_text_only: bool,
    pub backend_id: Option<String>,
    pub batch_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub cobiss_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    /// Consecutive sync misses. "Orphaned" is *derived* from this by the logic
    /// lane, never stored.
    #[serde(default)]
    pub miss_streak: Option<i64>,
}

/// Upload facts to persist after a successful backend create/replace (Epic 07).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadRecordDto {
    pub backend_id: String,
    pub version: Option<i64>,
    pub target_state: ItemType,
    pub visibility_status: VisibilityStatus,
}

/// One item a `rebuild` would downgrade from "uploaded" to "not uploaded" if
/// it ran right now — because a fresh scan can no longer corroborate the
/// backend connection the index currently has on record, whether its folder's
/// `metadata.json` mirror lost the backend id or the folder itself is gone.
/// Returned by `rebuild_impact` so the operator can be warned before
/// committing to `rebuild`, which has no undo.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildDowngradeDto {
    pub id: String,
    pub folder_name: String,
    pub backend_id: String,
}

/// Refreshed backend facts to fold onto an item's row after a **sync read**
/// (Epic 08).
///
/// Three rules this type exists to enforce, all restated from `bindings.ts`
/// because getting any of them wrong is silent:
///
/// 1. It must **never** set `uploaded`/`reupload` or any stage status — sync is
///    a read, and touching those would move the item's derived state and could
///    silently clear a pending re-upload.
/// 2. A **null `version` means "leave the stored one alone"**, not "clear it".
///    The stored version gates `PATCH expectedVersion`; clearing it would break
///    the next re-upload.
/// 3. Same for `target_state` / `visibility_status` / `title` — null is
///    "unchanged", not "null it out".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRecordDto {
    pub version: Option<i64>,
    pub target_state: Option<ItemType>,
    pub visibility_status: Option<VisibilityStatus>,
    pub title: Option<String>,
    /// Consecutive misses; `0` when found. Owned by `domain/sync.nextMissStreak`
    /// — stored verbatim here, never incremented Rust-side.
    pub miss_streak: i64,
    pub synced_at: String,
}

// ─── sync-run history (Epic 08) ──────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncRunStatus {
    Ok,
    Warning,
    Error,
}

impl SyncRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SyncRunStatus::Ok => "ok",
            SyncRunStatus::Warning => "warning",
            SyncRunStatus::Error => "error",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ok" => Some(SyncRunStatus::Ok),
            "warning" => Some(SyncRunStatus::Warning),
            "error" => Some(SyncRunStatus::Error),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncTrigger {
    Auto,
    Manual,
    Launch,
}

impl SyncTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            SyncTrigger::Auto => "auto",
            SyncTrigger::Manual => "manual",
            SyncTrigger::Launch => "launch",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(SyncTrigger::Auto),
            "manual" => Some(SyncTrigger::Manual),
            "launch" => Some(SyncTrigger::Launch),
            _ => None,
        }
    }
}

/// One persisted sync-run summary. Local-only working state, like batches.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRunDto {
    pub id: String,
    pub started_at: String,
    pub finished_at: String,
    pub status: SyncRunStatus,
    pub trigger: SyncTrigger,
    pub checked: i64,
    pub updated: i64,
    pub up_to_date: i64,
    pub missed: i64,
    pub summary: String,
    pub detail: String,
}

/// The append payload — everything except the native-assigned `id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRunCreateDto {
    pub started_at: String,
    pub finished_at: String,
    pub status: SyncRunStatus,
    pub trigger: SyncTrigger,
    pub checked: i64,
    pub updated: i64,
    pub up_to_date: i64,
    pub missed: i64,
    pub summary: String,
    pub detail: String,
}

// ─── batch DTOs (Epic 03) ────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BatchStage {
    Setup,
    Metadata,
    Processing,
    Ready,
    Uploaded,
}

impl BatchStage {
    pub fn as_str(self) -> &'static str {
        match self {
            BatchStage::Setup => "setup",
            BatchStage::Metadata => "metadata",
            BatchStage::Processing => "processing",
            BatchStage::Ready => "ready",
            BatchStage::Uploaded => "uploaded",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "setup" => Some(BatchStage::Setup),
            "metadata" => Some(BatchStage::Metadata),
            "processing" => Some(BatchStage::Processing),
            "ready" => Some(BatchStage::Ready),
            "uploaded" => Some(BatchStage::Uploaded),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemRunStatus {
    Idle,
    Queued,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContentKind {
    Auto,
    Book,
    Graphical,
}

/// A parent record linked to the batch at Setup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchParentRef {
    pub id: String,
    pub passes_data: bool,
}

/// A per-item override of the batch's publish/visibility defaults.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItemOverride {
    #[serde(default)]
    pub publish: Option<ItemType>,
    #[serde(default)]
    pub visibility: Option<VisibilityStatus>,
    #[serde(default)]
    pub content_kind: Option<ContentKind>,
    #[serde(default)]
    pub split_spreads: Option<bool>,
}

/// One batch row. Local-only working state — never sent to the backend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchDto {
    pub id: String,
    pub no: i64,
    pub created_at: String,
    /// The single item state the batch was created from. `type` is a Rust
    /// keyword, hence the rename.
    #[serde(rename = "type")]
    pub item_type: ItemState,
    pub item_ids: Vec<String>,
    pub stage: BatchStage,
    pub running: bool,
    pub proc: HashMap<String, ItemRunStatus>,
    pub cobiss_id: Option<String>,
    pub parents: Vec<BatchParentRef>,
    pub publish: ItemType,
    pub visibility: VisibilityStatus,
    pub overrides: HashMap<String, BatchItemOverride>,
    pub archived_at: Option<String>,
}

/// The create payload — everything except the native-assigned `id`/`no`/
/// `createdAt` (and `archivedAt`, always null at birth).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchCreateDto {
    #[serde(rename = "type")]
    pub item_type: ItemState,
    pub item_ids: Vec<String>,
    pub stage: BatchStage,
    pub running: bool,
    pub proc: HashMap<String, ItemRunStatus>,
    pub cobiss_id: Option<String>,
    pub parents: Vec<BatchParentRef>,
    pub publish: ItemType,
    pub visibility: VisibilityStatus,
    pub overrides: HashMap<String, BatchItemOverride>,
}

// ─── job run DTOs (Epic 06) ──────────────────────────────────────────────────
//
// Mirrors `ItemRunRequest`/`BatchRunRequest` in `bindings.ts`. The adaptive
// branching (which shape a folder is, which stages it needs) is decided in
// `.ts` via `domain/pipeline` and handed over as this fully-decided request —
// the runner is not meant to re-derive any of it, only execute it.

/// Why a run was started. `Reprocess` force-rebuilds and marks an
/// already-uploaded item Needs re-upload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobRunMode {
    Run,
    Rerun,
    Reprocess,
}

/// What a folder holds, which selects the pipeline branch (docs/tasks/06
/// §Source inputs). Decided in `.ts`; the runner must not re-derive it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InputShape {
    Tiffs,
    SuppliedPdf,
    MultiplePdfs,
    PageImages,
    ImagesOnly,
    Empty,
}

/// The pipeline stages a local script actually produces output for
/// (`metadata`/`upload` are not script-run, so they are not here).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunnableStage {
    Pdf,
    Thumbnail,
    Ocr,
}

/// One item's work in a run. `stages` is already reduced by skip-if-done, so
/// the runner executes exactly these.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRunRequest {
    pub item_id: String,
    pub folder_path: String,
    pub folder_name: String,
    pub input_shape: InputShape,
    pub stages: Vec<RunnableStage>,
    pub primary_thumbnail: Option<String>,
    pub thumbnail_needs_choice: bool,
    pub web_pdf_bases: Vec<String>,
    /// `page-images` only: page filenames in page order, natural-sorted by
    /// the `.ts` lane already — the runner must not re-sort.
    pub page_images: Vec<String>,
    pub split_spreads: bool,
}

/// A whole run: the batch, why, and the per-item work. `Reprocess` may carry
/// a single item that is not part of any active batch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRunRequest {
    pub batch_id: String,
    pub mode: JobRunMode,
    pub items: Vec<ItemRunRequest>,
}

// ─── job events (Epic 06) ─────────────────────────────────────────────────────
//
// Mirrors `JobProgressEvent`/`JobStageChangedEvent`/`JobDoneEvent` in
// `src/ipc/events.ts` field-for-field. Outbound only (native → TS over
// `app.emit`), so `Serialize` alone — nothing here is ever deserialized.

/// High-frequency progress for a running stage. Ephemeral — carries no
/// authoritative status, that's `JobStageChangedEvent`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgressEvent {
    pub batch_id: String,
    pub item_id: String,
    pub stage: RunnableStage,
    pub progress: Option<f64>,
    /// `events.ts` types this an *optional key* (`message?: string`), not a
    /// nullable one — omit it rather than emit `null` when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// A single pipeline stage transitioned. The authoritative per-stage signal —
/// always emitted after the matching `set_stage` DB write, never before.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStageChangedEvent {
    pub batch_id: String,
    pub item_id: String,
    pub stage: StageName,
    pub status: StageStatus,
    /// `events.ts` types `error`/`at` as *nullable* fields (`string | null`),
    /// not optional keys — unlike `JobProgressEvent.message` above, these
    /// must always be present on the wire, `null` when absent. No
    /// `skip_serializing_if` here; that distinction is deliberate.
    pub error: Option<String>,
    pub at: Option<String>,
}

/// Why a run (or one item's run) ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobOutcome {
    Done,
    Failed,
    Cancelled,
}

/// An item finished its run, or the batch run completed. `batchComplete` is
/// only `true` on the terminal event of a run; `itemId` is `None` for a
/// cancel with no single item to report (`events.ts`'s own doc comment
/// documents this case explicitly).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDoneEvent {
    pub batch_id: String,
    pub item_id: Option<String>,
    pub outcome: JobOutcome,
    pub error: Option<String>,
    pub batch_complete: bool,
}

// ─── filesystem DTOs (Epic 02 / 07) ──────────────────────────────────────────

/// The per-folder `metadata.json` mirror. `metadata` is the backend record's
/// metadata blob, passed through opaquely — the schema lives on the backend and
/// the form logic in `.ts`, so Rust must not interpret it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMetadataFile {
    pub backend_id: Option<String>,
    pub version: Option<i64>,
    #[serde(default)]
    pub target_state: Option<ItemType>,
    #[serde(default)]
    pub visibility_status: Option<VisibilityStatus>,
    pub metadata: serde_json::Value,
    pub synced_at: String,
}

/// A scan-root change detected by the watcher (Epic 02).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangedEvent {
    pub root: ScanRoot,
    pub kind: FsChangeKind,
    pub path: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FsChangeKind {
    Created,
    Removed,
    Modified,
}

// ─── config (Epic 01 / 10) ───────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    Light,
    Dark,
    System,
}

/// Non-secret persisted config. The Keycloak **password** (previously a
/// single manually-pasted `apiToken`) is deliberately **not** here — it
/// lives in the OS secret store (`config_*_secret`); the username (below)
/// is not sensitive and is stored right here. See `services/keycloakAuth.ts`
/// on the TS side for how the actual bearer token is minted/refreshed.
///
/// Stored and returned partially (`PersistedConfig = Partial<AppConfig>` on the
/// TS side), so every field is optional and callers merge with defaults.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unprocessed_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processed_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_prefix: Option<String>,
    /// Keycloak host (e.g. `http://localhost:8082` in dev). Realm/client id
    /// are not configurable — see `services/keycloakAuth.ts`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keycloak_url: Option<String>,
    /// Keycloak username. Not a secret (see `dto.rs`'s note on this struct);
    /// the password pairing it lives in the OS secret store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kc_username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<ThemePreference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_passing_collection_types: Option<Vec<i64>>,
    /// Job-runner concurrency caps (Epic 06) — backend-only, hand-edited in
    /// `config.json` directly. The `.ts` settings type does not carry these,
    /// so `commands::config::config_save` restores whatever is already on
    /// disk before writing, rather than let an unrelated Settings save reset
    /// them to `None`. See `core::jobs::JobLimits`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrent_items: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrent_ocr: Option<u32>,
}
