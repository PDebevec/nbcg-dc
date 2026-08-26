/**
 * Tests for the IPC-calling half of `services/pipeline.ts` — `startRun` /
 * `cancelRun` / `reprocessRun` / `watchJob*`. Kept in its own file, not folded
 * into `pipeline.test.ts`: `vi.mock` is file-scoped and hoisted, so mixing it
 * into the pure-function suite would force Tauri stubbing onto tests that
 * document themselves as pure/no-I/O.
 *
 * Mocks the app's only two runtime imports of `@tauri-apps/api` — `invoke`
 * (`@ipc/bindings`) and `listen` (`@ipc/events`) — everything else that
 * touches `@tauri-apps/api` is an erased `import type`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchRunRequest } from "@ipc/bindings";
import type { JobDoneEvent, JobProgressEvent, JobStageChangedEvent } from "@ipc/events";

const invoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
const listen =
  vi.fn<(ev: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>>();

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

// Deferred import so the mock factories above close over these already-
// initialised vi.fn()s (same pattern as stores/useSettings.test.ts).
const pipeline = await import("./pipeline");
const { IpcUnavailableError } = await import("@ipc/bindings");

/** `bindings.isTauri()` only probes for this marker property, so it is the
 * whole fixture — no jsdom, no mockIPC, no window.crypto needed. */
function underTauri(): void {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
}

beforeEach(() => {
  vi.unstubAllGlobals(); // default: NOT under Tauri
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  listen.mockReset();
  listen.mockResolvedValue(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const request: BatchRunRequest = { batchId: "b1", mode: "run", items: [] };

describe("under Tauri", () => {
  it("startRun calls invoke with jobs_start and the request", async () => {
    underTauri();
    await pipeline.startRun(request);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("jobs_start", { request });
  });

  it("reprocessRun calls invoke with jobs_reprocess, not jobs_start", async () => {
    underTauri();
    await pipeline.reprocessRun(request);
    expect(invoke).toHaveBeenCalledWith("jobs_reprocess", { request });
    expect(invoke).not.toHaveBeenCalledWith("jobs_start", expect.anything());
  });

  it("cancelRun calls invoke with jobs_cancel and the batchId", async () => {
    underTauri();
    await pipeline.cancelRun("b1");
    expect(invoke).toHaveBeenCalledWith("jobs_cancel", { batchId: "b1" });
  });

  it("a rejecting invoke propagates out of startRun rather than being swallowed", async () => {
    underTauri();
    invoke.mockRejectedValueOnce(new Error("native refused"));
    await expect(pipeline.startRun(request)).rejects.toThrow("native refused");
  });

  it("watchJobStageChanged listens on job://stage-changed and unwraps the payload", async () => {
    underTauri();
    const handler = vi.fn();
    await pipeline.watchJobStageChanged(handler);
    expect(listen).toHaveBeenCalledWith("job://stage-changed", expect.any(Function));
    const cb = listen.mock.calls[0][1];
    const event: JobStageChangedEvent = { batchId: "b1", itemId: "nb", stage: "pdf", status: "running" };
    cb({ payload: event });
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("watchJobDone listens on job://done and unwraps the payload", async () => {
    underTauri();
    const handler = vi.fn();
    await pipeline.watchJobDone(handler);
    expect(listen).toHaveBeenCalledWith("job://done", expect.any(Function));
    const cb = listen.mock.calls[0][1];
    const event: JobDoneEvent = { batchId: "b1", itemId: "nb", outcome: "done", batchComplete: false };
    cb({ payload: event });
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("watchJobProgress listens on job://progress and unwraps the payload", async () => {
    underTauri();
    const handler = vi.fn();
    await pipeline.watchJobProgress(handler);
    expect(listen).toHaveBeenCalledWith("job://progress", expect.any(Function));
    const cb = listen.mock.calls[0][1];
    const event: JobProgressEvent = { batchId: "b1", itemId: "nb", stage: "ocr", progress: 0.5 };
    cb({ payload: event });
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("watchJob* resolves to the exact unlisten function listen returned", async () => {
    underTauri();
    const stop = () => {};
    listen.mockResolvedValueOnce(stop);
    const unlisten = await pipeline.watchJobDone(vi.fn());
    expect(unlisten).toBe(stop);
  });
});

describe("outside Tauri (plain vite dev session)", () => {
  it("startRun/cancelRun/reprocessRun reject with IpcUnavailableError and never call invoke", async () => {
    await expect(pipeline.startRun(request)).rejects.toBeInstanceOf(IpcUnavailableError);
    await expect(pipeline.startRun(request)).rejects.toMatchObject({ command: "jobs_start" });
    await expect(pipeline.cancelRun("b1")).rejects.toMatchObject({ command: "jobs_cancel" });
    await expect(pipeline.reprocessRun(request)).rejects.toMatchObject({ command: "jobs_reprocess" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("watchJob* resolve to a harmless no-op and never touch listen", async () => {
    const handler = vi.fn();
    const unlistenStage = await pipeline.watchJobStageChanged(handler);
    const unlistenDone = await pipeline.watchJobDone(handler);
    const unlistenProgress = await pipeline.watchJobProgress(handler);
    expect(typeof unlistenStage).toBe("function");
    expect(() => unlistenStage()).not.toThrow();
    expect(() => unlistenDone()).not.toThrow();
    expect(() => unlistenProgress()).not.toThrow();
    expect(listen).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});
