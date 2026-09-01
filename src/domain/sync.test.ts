import { describe, it, expect } from "vitest";
import {
  ORPHAN_CONFIRMATIONS,
  ORPHAN_MIN_AGE_MS,
  SYNC_INTERVAL_MS,
  acceptRemoteVersion,
  isOrphaned,
  isOrphanedStreak,
  isRunSuspicious,
  isSyncDue,
  matchHitsToItems,
  mirrorDiffers,
  nextMissStreak,
  nextSyncAt,
  progressFraction,
  projectMirror,
  resolveVersion,
  summariseRun,
  syncableItems,
  type RemoteRecord,
  type SyncOutcome,
} from "./sync";
import { emptyStages, type Item } from "./item";
import { ItemType, VisibilityStatus } from "./enums";
import type { LocalMetadataFile } from "./metadata";

function makeItem(overrides: Partial<Item> = {}): Item {
  const base: Item = {
    id: "i1",
    folderName: "gorski_vijenac",
    folderPath: "/scans/unprocessed/gorski_vijenac",
    relativePath: "gorski_vijenac",
    hidden: false,
    root: "unprocessed",
    level: "main",
    assets: [],
    stages: emptyStages(),
    flags: { uploaded: false, reupload: false },
    backendId: null,
    batchId: null,
    title: null,
    catalogueId: null,
    createdAt: null,
    updatedAt: null,
    syncMissStreak: 0,
  };
  return { ...base, ...overrides };
}

function remote(over: Partial<RemoteRecord> = {}): RemoteRecord {
  return {
    id: "b1",
    targetState: ItemType.RECORD,
    visibilityStatus: VisibilityStatus.PUBLIC,
    version: 3,
    metadata: { title: "Gorski vijenac" },
    ...over,
  };
}

function mirror(over: Partial<LocalMetadataFile> = {}): LocalMetadataFile {
  return {
    backendId: "b1",
    version: 3,
    targetState: "RECORD",
    visibilityStatus: "PUBLIC",
    metadata: { title: "Gorski vijenac" },
    syncedAt: "2026-08-07T00:00:00.000Z",
    ...over,
  };
}

describe("sync cadence", () => {
  it("schedules the next run 6 hours after the last", () => {
    const next = nextSyncAt("2026-08-07T00:00:00.000Z");
    expect(next?.toISOString()).toBe("2026-08-07T06:00:00.000Z");
    expect(SYNC_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("treats a never-synced archive as due now", () => {
    expect(nextSyncAt(null)).toBeNull();
    expect(isSyncDue(null)).toBe(true);
  });

  it("treats an unparseable timestamp as due rather than never-due", () => {
    expect(nextSyncAt("not a date")).toBeNull();
    expect(isSyncDue("not a date")).toBe(true);
  });

  it("is not due before the interval elapses, and is due after", () => {
    const last = "2026-08-07T00:00:00.000Z";
    expect(isSyncDue(last, new Date("2026-08-07T05:59:00.000Z"))).toBe(false);
    expect(isSyncDue(last, new Date("2026-08-07T06:00:00.000Z"))).toBe(true);
  });
});

describe("isRunSuspicious", () => {
  it("flags a run where everything went missing at once", () => {
    // The mis-scoped-token / dead-index signature.
    expect(isRunSuspicious(40, 40)).toBe(true);
    expect(isRunSuspicious(40, 20)).toBe(true);
  });

  it("does not flag a handful of genuine deletions", () => {
    expect(isRunSuspicious(40, 2)).toBe(false);
  });

  it("on a tiny sample only flags an all-missing run", () => {
    expect(isRunSuspicious(2, 1)).toBe(false); // 50% but meaningless
    expect(isRunSuspicious(2, 2)).toBe(true);
  });

  it("is false when nothing was checked", () => {
    expect(isRunSuspicious(0, 0)).toBe(false);
  });
});

describe("nextMissStreak", () => {
  const old = ORPHAN_MIN_AGE_MS * 2;

  it("advances on an unambiguous miss", () => {
    expect(nextMissStreak({ currentStreak: 0, ageMs: old, runSuspicious: false })).toBe(1);
    expect(nextMissStreak({ currentStreak: 1, ageMs: old, runSuspicious: false })).toBe(2);
  });

  it("does NOT advance during a suspicious run — a bad token cannot orphan the archive", () => {
    expect(nextMissStreak({ currentStreak: 1, ageMs: old, runSuspicious: true })).toBe(1);
  });

  it("does NOT advance for an item too fresh to be past CDC lag", () => {
    expect(nextMissStreak({ currentStreak: 0, ageMs: 1000, runSuspicious: false })).toBe(0);
  });

  it("advances when the age is unknown (an item with no timestamps still ages via runs)", () => {
    expect(nextMissStreak({ currentStreak: 0, ageMs: null, runSuspicious: false })).toBe(1);
  });
});

describe("orphan confirmation", () => {
  it("needs more than one miss", () => {
    expect(ORPHAN_CONFIRMATIONS).toBeGreaterThan(1);
    expect(isOrphanedStreak(1)).toBe(false);
    expect(isOrphanedStreak(ORPHAN_CONFIRMATIONS)).toBe(true);
  });

  it("never orphans an item that was never uploaded", () => {
    const item = makeItem({ backendId: null, syncMissStreak: 99 });
    expect(isOrphaned(item)).toBe(false);
  });

  it("orphans a connected item once confirmed", () => {
    expect(isOrphaned(makeItem({ backendId: "b1", syncMissStreak: 1 }))).toBe(false);
    expect(
      isOrphaned(makeItem({ backendId: "b1", syncMissStreak: ORPHAN_CONFIRMATIONS })),
    ).toBe(true);
  });
});

describe("acceptRemoteVersion / resolveVersion", () => {
  it("accepts a newer or equal remote version", () => {
    expect(acceptRemoteVersion(3, 4)).toBe(true);
    expect(acceptRemoteVersion(3, 3)).toBe(true);
  });

  it("REJECTS an older remote version — CDC lag must not move the mirror backwards", () => {
    // The archive just PATCHed to v5; the index still says v4. Taking v4 would
    // make the next PATCH's expectedVersion stale and 409.
    expect(acceptRemoteVersion(5, 4)).toBe(false);
    expect(resolveVersion(5, 4)).toBe(5);
  });

  it("accepts anything when nothing is known locally", () => {
    expect(acceptRemoteVersion(null, 0)).toBe(true);
    expect(resolveVersion(null, 0)).toBe(0);
  });

  it("keeps the local version when the remote one is absent", () => {
    expect(acceptRemoteVersion(2, null)).toBe(false);
    expect(acceptRemoteVersion(2, undefined)).toBe(false);
    expect(resolveVersion(2, undefined)).toBe(2);
  });

  it("treats version 0 as a real version, not as missing", () => {
    expect(acceptRemoteVersion(0, 0)).toBe(true);
    expect(resolveVersion(null, 0)).toBe(0);
  });
});

describe("projectMirror", () => {
  it("replaces the metadata blob wholesale rather than merging", () => {
    const previous = mirror({ metadata: { title: "Old", stale: "gone" } });
    const next = projectMirror(previous, remote({ metadata: { title: "New" } }), "T");
    expect(next.metadata).toEqual({ title: "New" });
    expect(next.metadata).not.toHaveProperty("stale");
  });

  it("guards the version against CDC lag", () => {
    const previous = mirror({ version: 9 });
    expect(projectMirror(previous, remote({ version: 4 }), "T").version).toBe(9);
  });

  it("keeps previous targetState/visibility when the read omits them", () => {
    const previous = mirror({ targetState: "DRAFT", visibilityStatus: "HIDDEN" });
    const next = projectMirror(
      previous,
      remote({ targetState: null, visibilityStatus: null }),
      "T",
    );
    expect(next.targetState).toBe("DRAFT");
    expect(next.visibilityStatus).toBe("HIDDEN");
  });

  it("reflects a transition made on the website", () => {
    const previous = mirror({ targetState: "DRAFT" });
    const next = projectMirror(previous, remote({ targetState: ItemType.RECORD }), "T");
    expect(next.targetState).toBe("RECORD");
  });

  it("builds a full mirror when there was none", () => {
    const next = projectMirror(null, remote(), "T");
    expect(next).toEqual({
      backendId: "b1",
      version: 3,
      targetState: "RECORD",
      visibilityStatus: "PUBLIC",
      metadata: { title: "Gorski vijenac" },
      syncedAt: "T",
    });
  });
});

describe("mirrorDiffers", () => {
  it("is true when there is no previous mirror", () => {
    expect(mirrorDiffers(null, mirror())).toBe(true);
  });

  it("IGNORES syncedAt — otherwise every run rewrites every folder", () => {
    const previous = mirror({ syncedAt: "2026-01-01T00:00:00.000Z" });
    const next = mirror({ syncedAt: "2026-08-07T12:00:00.000Z" });
    expect(mirrorDiffers(previous, next)).toBe(false);
  });

  it("detects version, visibility, targetState and id changes", () => {
    expect(mirrorDiffers(mirror(), mirror({ version: 4 }))).toBe(true);
    expect(mirrorDiffers(mirror(), mirror({ visibilityStatus: "PRIVATE" }))).toBe(true);
    expect(mirrorDiffers(mirror(), mirror({ targetState: "DRAFT" }))).toBe(true);
    expect(mirrorDiffers(mirror(), mirror({ backendId: "other" }))).toBe(true);
  });

  it("detects metadata changes including nested and array values", () => {
    expect(mirrorDiffers(mirror(), mirror({ metadata: { title: "Other" } }))).toBe(true);
    expect(
      mirrorDiffers(
        mirror({ metadata: { a: { b: [1, 2] } } }),
        mirror({ metadata: { a: { b: [1, 3] } } }),
      ),
    ).toBe(true);
    expect(
      mirrorDiffers(
        mirror({ metadata: { a: [1, 2] } }),
        mirror({ metadata: { a: [2, 1] } }),
      ),
    ).toBe(true); // array order is significant
  });

  it("is insensitive to key order — the backend does not guarantee it", () => {
    expect(
      mirrorDiffers(
        mirror({ metadata: { title: "T", year: "1847" } }),
        mirror({ metadata: { year: "1847", title: "T" } }),
      ),
    ).toBe(false);
  });

  it("detects an added or removed metadata key", () => {
    expect(
      mirrorDiffers(mirror({ metadata: { a: 1 } }), mirror({ metadata: { a: 1, b: 2 } })),
    ).toBe(true);
    expect(
      mirrorDiffers(mirror({ metadata: { a: 1, b: 2 } }), mirror({ metadata: { a: 1 } })),
    ).toBe(true);
  });

  it("does not confuse a missing key with an explicit undefined", () => {
    expect(
      mirrorDiffers(mirror({ metadata: { a: 1 } }), mirror({ metadata: { a: undefined } })),
    ).toBe(true);
  });
});

describe("summariseRun", () => {
  const found = (id: string): SyncOutcome => ({ itemId: id, kind: "up-to-date" });
  const updated = (id: string): SyncOutcome => ({ itemId: id, kind: "updated" });
  const missed = (id: string, reason: SyncOutcome["reason"] = "not-found"): SyncOutcome => ({
    itemId: id,
    kind: "missed",
    reason,
  });

  it("reports a clean run as ok", () => {
    const s = summariseRun([updated("a"), found("b")]);
    expect(s.status).toBe("ok");
    expect(s.stats).toEqual({ checked: 2, updated: 1, upToDate: 1, missed: 0 });
    expect(s.summary).toBe("1 record updated");
  });

  it("says everything is current when nothing changed", () => {
    expect(summariseRun([found("a"), found("b")]).summary).toBe("Everything up to date");
  });

  it("excludes skipped items from `checked` — they were never asked about", () => {
    const s = summariseRun([found("a"), { itemId: "b", kind: "skipped" }]);
    expect(s.stats.checked).toBe(1);
  });

  it("warns with the miss reason, matching the spec's example wording", () => {
    const s = summariseRun([found("a"), missed("b", "request-failed"), missed("c", "request-failed")]);
    expect(s.status).toBe("warning");
    expect(s.summary).toBe("2 missed — backend timeout");
  });

  it("escalates to error when every check missed", () => {
    const s = summariseRun([missed("a"), missed("b")]);
    expect(s.status).toBe("error");
  });

  it("reports an empty archive as ok, not as a failure", () => {
    const s = summariseRun([]);
    expect(s.status).toBe("ok");
    expect(s.summary).toBe("Nothing to sync");
  });

  it("reports a cancelled run as an error", () => {
    const s = summariseRun([found("a")], { aborted: true });
    expect(s.status).toBe("error");
    expect(s.summary).toBe("Sync cancelled");
  });

  it("explains a suspicious run instead of blaming deletion", () => {
    const s = summariseRun([missed("a"), missed("b")], { runSuspicious: true });
    expect(s.detail).toContain("view scopes");
    expect(s.detail).toContain("No item was flagged orphaned");
  });

  it("surfaces confirmed orphans in the detail and downgrades status", () => {
    const s = summariseRun([
      found("a"),
      { itemId: "b", kind: "missed", reason: "not-found", missStreak: 2, orphaned: true },
    ]);
    expect(s.status).toBe("warning");
    expect(s.detail).toContain("flagged orphaned");
    expect(s.detail).toContain("Local files are kept");
  });

  it("flags truncation so a partial view is never reported as complete", () => {
    const s = summariseRun([found("a")], { truncated: true });
    expect(s.status).toBe("warning");
    expect(s.detail).toContain("truncated");
  });
});

describe("progressFraction", () => {
  it("is a clamped completed/total", () => {
    expect(progressFraction({ stage: "writing", completed: 1, total: 4 })).toBe(0.25);
    expect(progressFraction({ stage: "writing", completed: 9, total: 4 })).toBe(1);
  });

  it("reads as complete for an empty finished run, and 0 while still working", () => {
    expect(progressFraction({ stage: "done", completed: 0, total: 0 })).toBe(1);
    expect(progressFraction({ stage: "contacting", completed: 0, total: 0 })).toBe(0);
  });
});

describe("matchHitsToItems", () => {
  it("pairs hits with the local item tracking them", () => {
    const items = [
      makeItem({ id: "i1", backendId: "b1" }),
      makeItem({ id: "i2", backendId: null }),
    ];
    const matched = matchHitsToItems([{ id: "b1" }, { id: "b2" }], items);
    expect(matched[0].item?.id).toBe("i1");
    expect(matched[0].isLocal).toBe(true);
    expect(matched[1].item).toBeNull();
    expect(matched[1].isLocal).toBe(false); // web-only — never auto-created
  });
});

describe("syncableItems", () => {
  it("keeps only items connected to a backend record", () => {
    const items = [
      makeItem({ id: "i1", backendId: "b1" }),
      makeItem({ id: "i2", backendId: null }),
    ];
    expect(syncableItems(items).map((i) => i.id)).toEqual(["i1"]);
  });
});
