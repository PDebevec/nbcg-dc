/**
 * Typed Tauri event listeners (Seam 2 — the push half).
 *
 * The native core emits progress/filesystem events; these wrappers give the
 * application layer a typed `on*` API returning an unlisten function. Payload
 * shapes are the contract Arch emits from `src-tauri`. The job events (Epic 06)
 * are consumed by `stores/useProcessing` via `services/pipeline`; the fs-watch
 * event (Epic 02) by `stores/useItems`.
 *
 * Three job channels, by cadence + who cares:
 *  - `job://progress`     — high-frequency fraction for the live bar (ephemeral;
 *                           the display layer only).
 *  - `job://stage-changed`— a single pipeline stage transitioned; updates the
 *                           item's per-stage pips + recorded status.
 *  - `job://done`         — an item finished its whole run (coarse `proc`), and
 *                           the batch-complete signal that clears `running`.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "./bindings";
import type { StageName, StageStatus } from "@domain/item";
import type { RunnableStage } from "@domain/pipeline";

export const Events = {
  jobProgress: "job://progress",
  jobStageChanged: "job://stage-changed",
  jobDone: "job://done",
  fsChanged: "fs://changed",
} as const;

/**
 * High-frequency progress for a single running stage (drives the live bar).
 * Ephemeral — carries no authoritative status (that is `job://stage-changed`);
 * `progress` is 0–1 for long stages (OCR), else null.
 */
export interface JobProgressEvent {
  batchId: string;
  itemId: string;
  stage: RunnableStage;
  progress: number | null;
  message?: string;
}

/**
 * A single pipeline stage changed status (`pending → running → done | failed`,
 * or `skipped`). The authoritative per-stage signal — the native runner writes
 * the SQLite index and emits this so the Overview pips + item stage map update
 * live.
 */
export interface JobStageChangedEvent {
  batchId: string;
  itemId: string;
  stage: StageName;
  status: StageStatus;
  /** Failure detail when `status === "failed"`. */
  error?: string | null;
  /** ISO timestamp of the transition. */
  at?: string | null;
}

/**
 * An item finished its whole pipeline run, or the batch run completed. When
 * `itemId` is set, `outcome` is that item's coarse result (→ its `proc` entry).
 * When `batchComplete` is true the run has ended (clear `running`); a terminal
 * event may carry `itemId: null` (e.g. a cancel with no single item to report).
 */
export interface JobDoneEvent {
  batchId: string;
  itemId: string | null;
  outcome: "done" | "failed" | "cancelled";
  error?: string | null;
  /** True on the final event of the run — the whole batch is no longer running. */
  batchComplete: boolean;
}

/** A scan-root change detected by the native watcher (Epic 02). */
export interface FsChangedEvent {
  root: "unprocessed" | "processed";
  kind: "created" | "removed" | "modified";
  path: string;
}

/** No-op unlisten used when not running under Tauri. */
const noopUnlisten: UnlistenFn = () => {};

async function on<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return noopUnlisten;
  return listen<T>(event, (e) => handler(e.payload));
}

export function onJobProgress(
  handler: (payload: JobProgressEvent) => void,
): Promise<UnlistenFn> {
  return on(Events.jobProgress, handler);
}

export function onJobStageChanged(
  handler: (payload: JobStageChangedEvent) => void,
): Promise<UnlistenFn> {
  return on(Events.jobStageChanged, handler);
}

export function onJobDone(
  handler: (payload: JobDoneEvent) => void,
): Promise<UnlistenFn> {
  return on(Events.jobDone, handler);
}

export function onFsChanged(
  handler: (payload: FsChangedEvent) => void,
): Promise<UnlistenFn> {
  return on(Events.fsChanged, handler);
}
