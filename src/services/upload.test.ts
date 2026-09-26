import { beforeEach, describe, it, expect, vi } from "vitest";
import { ApiError } from "./api/client";
import { deterministicItemId } from "./api/deterministicId";
import { findById } from "./api/search";
import { previewCobiss } from "./api/cobiss";
import {
  uploadItem,
  uploadBatch,
  resolveExistingRecordWith,
  removableBackendIds,
  cleanupUnfinishedRecords,
  type UploadDeps,
  type UploadItemContext,
  type ItemUploadResult,
} from "./upload";
import type { UploadFile } from "./api/files";
import { discoverAsset, type DiscoveredAsset } from "@domain/files";
import { emptyStages, type Item, type ItemStages, type StageName } from "@domain/item";
import type { ItemEntity, FileAttachment } from "./api/dto";
import type { SearchHit } from "./api/search";
import { fieldV2, schemaV2 } from "@domain/schema.fixture";
import type { LocalMetadataFile } from "@domain/metadata";
import { MAX_FILES_PER_REQUEST } from "@domain/upload";

// The two network reads `defaultDeps().resolveExistingRecord` is built from.
// Everything else in both modules stays real — `hitToRemote` in particular,
// which `hitToExisting` runs the fetched record through. Mocked at module
// level so one test can drive the GENUINE default resolver end-to-end
// (`uploadItem` → the id it picks → the lookup → the verification), which is
// the seam every `resolveExistingRecord`-stubbing test leaves untouched.
// No other test in this file reaches either function: `fakeDeps` always
// supplies `resolveExistingRecord`, and nothing here calls COBISS preview.
vi.mock("./api/search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/search")>()),
  findById: vi.fn(),
}));
vi.mock("./api/cobiss", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/cobiss")>()),
  previewCobiss: vi.fn(),
}));

// ── fixtures ──────────────────────────────────────────────────────────────

function stagesDone(overrides: Partial<Record<StageName, ItemStages[StageName]>> = {}): ItemStages {
  return {
    ...emptyStages(),
    pdf: { status: "done" },
    thumbnail: { status: "done" },
    ocr: { status: "done" },
    ...overrides,
  };
}

const ASSETS: DiscoveredAsset[] = [
  discoverAsset("gorski.pdf", "/p/gorski.pdf"),
  discoverAsset("gorski_archive.pdf", "/p/gorski_archive.pdf"),
  discoverAsset("gorski.tif", "/p/gorski.tif"),
  discoverAsset("gorski.txt", "/p/gorski.txt"),
  discoverAsset("gorski_thumb.png", "/p/gorski_thumb.png"),
];

function makeItem(overrides: Partial<Item> = {}): Item {
  const base: Item = {
    id: "item-1",
    folderName: "gorski",
    folderPath: "/p",
    relativePath: "gorski",
    hidden: false,
    root: "unprocessed",
    level: "main",
    assets: ASSETS,
    stages: stagesDone(),
    flags: { uploaded: false, reupload: false, reuploadTextOnly: false },
    backendId: null,
    batchId: "batch-1",
    title: "Gorski vijenac",
    catalogueId: null,
    createdAt: null,
    updatedAt: null,
    syncMissStreak: 0,
  };
  return { ...base, ...overrides };
}

const SCHEMA = schemaV2([fieldV2({ key: "title", required: true }), fieldV2({ key: "year" })]);

/**
 * `SCHEMA` plus `cobissId`.
 *
 * The app's real record schema carries the field; the fixture above does not,
 * and `pruneForUpload` drops every key the schema does not name. So a test
 * about *the COBISS id the create actually sent* has to use this one —
 * otherwise `pruned.cobissId` is absent, nothing collidable goes on the wire,
 * and the scenario cannot exist.
 */
const COBISS_SCHEMA = schemaV2([...SCHEMA.fields, fieldV2({ key: "cobissId" })]);

const ENTITY: ItemEntity = {
  id: "rec_1",
  visibilityStatus: "PUBLIC",
  metadata: { title: "Gorski vijenac", year: "2020", collectionType: 1 },
  version: 0,
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
  createdByUserId: "u1",
  updatedByUserId: null,
};

function attachment(filename: string, over: Partial<FileAttachment> = {}): FileAttachment {
  return {
    id: `att-${filename}`,
    draft_id: null,
    record_id: "rec_1",
    fileType: filename.endsWith(".pdf") ? "PDF" : "IMAGE",
    role: "WEB",
    originalFid: "fid",
    filename,
    mimeType: "application/octet-stream",
    sizeBytes: 1,
    textExtractionStatus: "EXTRACTED",
    createdAt: "2026-08-06T00:00:00.000Z",
    ...over,
  };
}

function bytes(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

/** All deps as spies, overridable per test. */
function fakeDeps(over: Partial<UploadDeps> = {}): UploadDeps {
  return {
    createItem: vi.fn(async () => ENTITY),
    updateItem: vi.fn(async () => ({ version: 4 })),
    uploadFiles: vi.fn(async (_id: string, files: UploadFile[]) => files.map((f) => attachment(f.filename))),
    replaceFile: vi.fn(async (_id, file) => attachment(file.filename)),
    listFiles: vi.fn(async () => [] as FileAttachment[]),
    setFileText: vi.fn(async () => ({ updated: true as const })),
    connectParent: vi.fn(async (parentId: string) => ({
      parentId,
      version: 7,
      childrenInDrafts: 1,
      childrenInRecords: 0,
    })),
    readFileBytes: vi.fn(async (path: string) => bytes(path)),
    readTextFile: vi.fn(async () => "OCR text"),
    readMirror: vi.fn(async () => null),
    writeMirror: vi.fn(async () => {}),
    recordUpload: vi.fn(async () => {}),
    resolveExistingRecord: vi.fn(async () => null),
    moveToProcessed: vi.fn(async () => {}),
    listItems: vi.fn(async () => [] as Item[]),
    getSchema: vi.fn(async () => SCHEMA),
    now: vi.fn(() => "2026-08-06T12:00:00.000Z"),
    sleep: vi.fn(async () => {}),
    ...over,
  };
}

const CTX: UploadItemContext = {
  targetState: "RECORD",
  visibility: "PUBLIC",
  parentIds: ["par1"],
  metadata: { title: "Gorski vijenac", year: "2020" },
  metadataReady: true,
  primaryThumbnail: null,
};

// ── create happy path ─────────────────────────────────────────────────────

describe("uploadItem — create", () => {
  it("creates, uploads two role groups, links the parent, writes through, moves", async () => {
    const deps = fakeDeps();
    const res = await uploadItem(makeItem(), CTX, deps);

    expect(res.status).toBe("uploaded");
    expect(res.backendId).toBe("rec_1");

    // create dto is the pruned metadata + publish decisions
    expect(deps.createItem).toHaveBeenCalledTimes(1);
    expect((deps.createItem as any).mock.calls[0][0]).toEqual({
      visibilityStatus: "PUBLIC",
      targetState: "RECORD",
      metadata: { title: "Gorski vijenac", year: "2020" },
      parentIds: ["par1"],
    });

    // two upload requests: THUMBNAIL then WEB, extractedTexts only on WEB
    expect(deps.uploadFiles).toHaveBeenCalledTimes(2);
    const [thumbCall, webCall] = (deps.uploadFiles as any).mock.calls;
    expect(thumbCall[1].map((f: any) => f.filename)).toEqual(["gorski_thumb.png"]);
    expect(thumbCall[2].role).toBe("THUMBNAIL");
    expect(thumbCall[2].extractedTexts).toEqual({});
    expect(webCall[1].map((f: any) => f.filename)).toEqual(["gorski.pdf"]);
    expect(webCall[2].role).toBe("WEB");
    expect(webCall[2].doOCR).toBe(false);
    expect(webCall[2].extractedTexts).toEqual({ "gorski.pdf": "OCR text" });

    // parent linked (child = the new id)
    expect(deps.connectParent).toHaveBeenCalledWith("par1", "rec_1");

    // write-through mirror + index, using the backend metadata
    expect((deps.writeMirror as any).mock.calls[0][1]).toEqual({
      backendId: "rec_1",
      version: 0,
      targetState: "RECORD",
      visibilityStatus: "PUBLIC",
      metadata: ENTITY.metadata,
      syncedAt: "2026-08-06T12:00:00.000Z",
    });
    expect(deps.recordUpload).toHaveBeenCalledWith("item-1", {
      backendId: "rec_1",
      version: 0,
      targetState: "RECORD",
      visibilityStatus: "PUBLIC",
    });

    // repositioned (root was unprocessed)
    expect(deps.moveToProcessed).toHaveBeenCalledTimes(1);
  });

  it("archival + tiff are never uploaded", async () => {
    const deps = fakeDeps();
    await uploadItem(makeItem(), CTX, deps);
    const uploadedNames = (deps.uploadFiles as any).mock.calls.flatMap((c: any) =>
      c[1].map((f: any) => f.filename),
    );
    expect(uploadedNames).toEqual(["gorski_thumb.png", "gorski.pdf"]);
  });

  it("surfaces a text-quality warning from the backend response", async () => {
    const deps = fakeDeps({
      uploadFiles: vi.fn(async (_id: string, files: UploadFile[]) =>
        files.map((f) => attachment(f.filename, { textExtractionStatus: f.filename.endsWith(".pdf") ? "GARBAGE" : "EXTRACTED" })),
      ),
    });
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(res.status).toBe("uploaded");
    expect(res.warnings.some((w) => w.code === "ocr-garbage")).toBe(true);
  });

  it("persists the new backendId BEFORE assets, so a post-create failure never double-creates", async () => {
    // Create succeeds, then the asset upload fails with a non-transient 400.
    const deps = fakeDeps({
      uploadFiles: vi.fn(async () => {
        throw apiError("bad_request", 400, { message: ["boom"] });
      }),
    });
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(res.status).toBe("error");
    // The catch reports the id we actually created (not the pre-upload null)…
    expect(res.backendId).toBe("rec_1");
    // …and the link was already persisted, so a retry enters replace mode.
    expect(deps.recordUpload).toHaveBeenCalledWith(
      "item-1",
      expect.objectContaining({ backendId: "rec_1" }),
    );
  });

  it("folds a schema-fetch failure into an error result instead of throwing (never crashes the batch)", async () => {
    const deps = fakeDeps({
      getSchema: vi.fn(async () => {
        throw apiError("server", 500);
      }),
    });
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(res.status).toBe("error");
    expect(deps.createItem).not.toHaveBeenCalled();
  });

  it("adopts a resolvable create-409 collision instead of reporting duplicate", async () => {
    const deps = fakeDeps({
      createItem: vi.fn(async () => {
        throw apiError("conflict", 409);
      }),
      resolveExistingRecord: vi.fn(async () => ({
        id: "rec_existing",
        version: 3,
        targetState: "RECORD" as const,
        visibilityStatus: "PUBLIC" as const,
        metadata: {},
      })),
    });
    const res = await uploadItem(makeItem({ catalogueId: "COBISS.123" }), CTX, deps);
    expect(res.status).toBe("uploaded");
    expect(res.backendId).toBe("rec_existing");

    // The FIRST write-through captures the backend's authoritative state
    // (id/version/targetState/visibility) BEFORE any patch is attempted — a
    // recovered collision that skips the mirror leaves the same "index says
    // uploaded, mirror absent" state that makes an item a landmine for the
    // next index rebuild.
    expect((deps.writeMirror as any).mock.calls[0][1]).toMatchObject({
      backendId: "rec_existing",
      version: 3,
      targetState: "RECORD",
      visibilityStatus: "PUBLIC",
    });
    expect(deps.recordUpload).toHaveBeenCalledWith("item-1", {
      backendId: "rec_existing",
      version: 3,
      targetState: "RECORD",
      visibilityStatus: "PUBLIC",
    });
  });

  it("reports duplicate (no double-create) when the existing id can't be resolved", async () => {
    const deps = fakeDeps({
      createItem: vi.fn(async () => {
        throw apiError("conflict", 409);
      }),
      resolveExistingRecord: vi.fn(async () => null),
    });
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(res.status).toBe("duplicate");
    // Nothing to link, so nothing to write.
    expect(deps.writeMirror).not.toHaveBeenCalled();
    expect(deps.recordUpload).not.toHaveBeenCalled();
  });

  it("creates a new item under the batch's parents and does not connect it afterwards", async () => {
    const linked = [{ parentId: "par1", version: 9, childrenInDrafts: 1, childrenInRecords: 0 }];
    const deps = fakeDeps({ createItem: vi.fn(async () => ({ ...ENTITY, parents: linked })) });
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(deps.createItem).toHaveBeenCalledWith(expect.objectContaining({ parentIds: ["par1"] }));
    expect(deps.connectParent).not.toHaveBeenCalled();
    expect(res.status).toBe("uploaded");
    expect(res.parentStates).toEqual(linked);
  });

  it("adopts the parents' new versions right after the create, even when the files then fail", async () => {
    const parentItem = makeItem({ id: "parent-item", backendId: "par1" });
    const parentMirror = {
      backendId: "par1",
      version: 3,
      targetState: "RECORD" as const,
      visibilityStatus: "PUBLIC" as const,
      metadata: { title: "Pobjeda" },
      syncedAt: "2026-09-25T00:00:00.000Z",
    };
    const deps = fakeDeps({
      createItem: vi.fn(async () => ({
        ...ENTITY,
        parents: [{ parentId: "par1", version: 9, childrenInDrafts: 1, childrenInRecords: 0 }],
      })),
      uploadFiles: vi.fn(async () => {
        throw apiError("server", 500);
      }),
      listItems: vi.fn(async () => [parentItem]),
      readMirror: vi.fn(async (target) => (target.id === "parent-item" ? parentMirror : null)),
    });
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(res.status).not.toBe("uploaded");
    expect(deps.writeMirror).toHaveBeenCalledWith(
      expect.objectContaining({ id: "parent-item" }),
      expect.objectContaining({ version: 9 }),
    );
  });

  it("falls back to connect when the backend did not report the links", async () => {
    const deps = fakeDeps(); // ENTITY has no `parents`
    await uploadItem(makeItem(), CTX, deps);
    expect(deps.connectParent).toHaveBeenCalledWith("par1", "rec_1");
  });
});

// ── create collision — adoption ─────────────────────────────────────────────

describe("create collision — adoption", () => {
  const existing = {
    id: "cbwkbr9guqs3w11xylpri1ylw",
    version: 7,
    targetState: "RECORD" as const,
    visibilityStatus: "PUBLIC" as const,
    metadata: { cobissId: "12345", title: "Existing title" },
  };
  const conflict = () => { throw apiError("conflict", 409); };

  it("adopts, attaches files and reports uploaded", async () => {
    const updateItem = vi.fn(async () => ({ version: 8 }));
    const deps = fakeDeps({
      createItem: vi.fn(async () => conflict()),
      resolveExistingRecord: vi.fn(async () => existing),
      updateItem,
      uploadFiles: vi.fn(async () => []),
    });
    const res = await uploadItem(makeItem(), { ...CTX, metadata: { title: "New title" } }, deps);

    expect(res.status).toBe("uploaded");
    expect(res.backendId).toBe(existing.id);
    expect(res.warnings.some((w) => w.code === "adopted-existing")).toBe(true);
  });

  it("PATCHes only what the operator actually changed", async () => {
    const updateItem = vi.fn(async () => ({ version: 8 }));
    const deps = fakeDeps({
      createItem: vi.fn(async () => conflict()),
      resolveExistingRecord: vi.fn(async () => existing),
      updateItem,
    });
    await uploadItem(makeItem(), { ...CTX, metadata: { cobissId: "12345", title: "New title" } }, deps);

    expect(updateItem).toHaveBeenCalledTimes(1);
    const [, body] = (updateItem as any).mock.calls[0];
    expect(body.expectedVersion).toBe(7);
    expect(body.metadata).toEqual({ title: "New title" }); // cobissId matched → not resent
  });

  it("issues NO patch when the operator changed nothing", async () => {
    const updateItem = vi.fn();
    const deps = fakeDeps({
      createItem: vi.fn(async () => conflict()),
      resolveExistingRecord: vi.fn(async () => existing),
      updateItem,
    });
    const res = await uploadItem(
      makeItem(),
      { ...CTX, metadata: { ...existing.metadata }, visibility: "PUBLIC" },
      deps,
    );
    expect(updateItem).not.toHaveBeenCalled();
    expect(res.status).toBe("uploaded");
  });

  it("keeps the BACKEND's targetState and visibility, and warns", async () => {
    const recordUpload = vi.fn(async () => {});
    const updateItem = vi.fn(async () => ({ version: 8 }));
    const deps = fakeDeps({
      createItem: vi.fn(async () => conflict()),
      resolveExistingRecord: vi.fn(async () => existing),
      updateItem,
      recordUpload,
    });
    // The batch says DRAFT/PRIVATE; the live record is RECORD/PUBLIC.
    const res = await uploadItem(
      makeItem(),
      { ...CTX, targetState: "DRAFT", visibility: "PRIVATE" },
      deps,
    );

    // `recordUpload` is called twice on this path: once by `adoptExistingRecord`
    // (built literally from `existing.*`, so it can't carry ctx and proves
    // nothing about a leak), and once more by `replaceOnBackend`'s write-through
    // AFTER the PATCH — that LAST call is the one `adoptedCtx` actually feeds,
    // so it's the one that would show DRAFT/PRIVATE if the batch's settings
    // leaked back onto an adopted record.
    const calls = (recordUpload as any).mock.calls;
    const [, dto] = calls[calls.length - 1];
    expect(dto.targetState).toBe("RECORD");
    expect(dto.visibilityStatus).toBe("PUBLIC");
    expect(res.warnings.some((w) => w.code === "adopted-existing")).toBe(true);
  });

  it("never PATCHes visibilityStatus on the adoption path, even when the batch's known differs from the backend's", async () => {
    // Ruling: on the adoption path the PATCH body must NEVER carry
    // `visibilityStatus` — not merely when the backend's is unknown.
    // `existing.visibilityStatus` is a known "PUBLIC" here (not null), so this
    // is the case a null-check-only fix would still get wrong: the backend's
    // value is known and DOES differ from the batch's, yet it must still never
    // be offered to the PATCH.
    const updateItem = vi.fn(async () => ({ version: 8 }));
    const deps = fakeDeps({
      createItem: vi.fn(async () => conflict()),
      resolveExistingRecord: vi.fn(async () => existing), // visibilityStatus: "PUBLIC"
      updateItem,
    });
    const res = await uploadItem(
      makeItem(),
      { ...CTX, metadata: { title: "New title" }, visibility: "PRIVATE" },
      deps,
    );

    expect(res.status).toBe("uploaded");
    expect(updateItem).toHaveBeenCalledTimes(1);
    const [, body] = (updateItem as any).mock.calls[0];
    expect(body).not.toHaveProperty("visibilityStatus");
  });

  it("never PATCHes visibilityStatus when the adopted record's own visibility is unknown", async () => {
    // A search hit that omitted `visibilityStatus` (`hitToRemote` yields `null`
    // for it). The ruling: on the adoption path the PATCH body must NEVER carry
    // `visibilityStatus` — not only when it's unknown — but this is the case
    // that would leak the batch's own visibility if that guarantee weren't
    // threaded as an explicit flag.
    const updateItem = vi.fn(async () => ({ version: 8 }));
    const deps = fakeDeps({
      createItem: vi.fn(async () => conflict()),
      resolveExistingRecord: vi.fn(async () => ({ ...existing, visibilityStatus: null })),
      updateItem,
    });
    const res = await uploadItem(
      makeItem(),
      { ...CTX, metadata: { title: "New title" }, visibility: "PRIVATE" },
      deps,
    );

    expect(res.status).toBe("uploaded");
    expect(updateItem).toHaveBeenCalledTimes(1);
    const [, body] = (updateItem as any).mock.calls[0];
    expect(body).not.toHaveProperty("visibilityStatus");
  });

  it("resolves (never rejects) when the PATCH after adoption itself 409s, carrying the adopted backendId", async () => {
    // The same CDC lag that motivates adoption can just as well make the
    // follow-up PATCH lose the optimistic-concurrency race. A bare
    // `return replaceOnBackend(...)` inside the create branch's `catch` would
    // let that rejection escape `uploadItem`'s own `catch` (and `mapUploadError`
    // with it) straight up to `uploadBatch`, which awaits each item with no
    // try/catch — discarding every already-uploaded item's result in the run.
    const deps = fakeDeps({
      createItem: vi.fn(async () => conflict()),
      resolveExistingRecord: vi.fn(async () => existing),
      updateItem: vi.fn(async () => conflict()),
    });
    const res = await uploadItem(makeItem(), { ...CTX, metadata: { title: "New title" } }, deps);

    expect(res.status).not.toBe("uploaded");
    expect(res.backendId).toBe(existing.id);
  });

  it("records ONE visibility for an unknown one, in both local stores, and never the batch's", async () => {
    // A search hit may omit `visibilityStatus` (`hitToRemote` → null), while
    // the SQLite row's `UploadRecordDto.visibilityStatus` is non-null — so
    // something has to be invented. Inventing it twice left `metadata.json`
    // saying null and the index row saying PRIVATE for the same unknown, and
    // then the null fell through `adopted.visibilityStatus ?? ctx.visibility`
    // so the *batch's* setting was persisted as if it were the record's real
    // state — a value adoption deliberately never pushed to the backend.
    const writeMirror = vi.fn(async () => {});
    const recordUpload = vi.fn(async () => {});
    const deps = fakeDeps({
      createItem: vi.fn(async () => conflict()),
      resolveExistingRecord: vi.fn(async () => ({ ...existing, visibilityStatus: null })),
      updateItem: vi.fn(async () => ({ version: 8 })),
      writeMirror,
      recordUpload,
    });

    // The batch says PUBLIC. The backend's own value is unknown.
    const res = await uploadItem(
      makeItem(),
      { ...CTX, metadata: { title: "New title" }, visibility: "PUBLIC" },
      deps,
    );

    expect(res.status).toBe("uploaded");
    const mirrored = (writeMirror as any).mock.calls.map((c: any[]) => c[1].visibilityStatus);
    const indexed = (recordUpload as any).mock.calls.map((c: any[]) => c[1].visibilityStatus);
    expect(mirrored.length).toBeGreaterThan(0);
    expect(indexed.length).toBeGreaterThan(0);
    expect(new Set([...mirrored, ...indexed])).toEqual(new Set(["PRIVATE"]));
  });

  it("carries the adopted-existing warning onto a FAILED adoption, not just a successful one", async () => {
    // `removableBackendIds` refuses to hard-delete a record carrying this
    // warning — and that exclusion can only ever be consulted on a
    // non-`uploaded` result, because `uploaded` is dropped one line earlier.
    // While `mapUploadError` built its results without the run's warnings, the
    // marker existed on exactly the outcomes that never reach the check and on
    // none of the outcomes that do: the exclusion was dead code against the
    // live catalogue, and `created` was the only thing standing between an
    // adopted, possibly curated record and a permanent DELETE.
    const deps = fakeDeps({
      createItem: vi.fn(async () => conflict()),
      resolveExistingRecord: vi.fn(async () => existing),
      // The PATCH after adoption loses the optimistic-concurrency race.
      updateItem: vi.fn(async () => conflict()),
    });
    const res = await uploadItem(makeItem(), { ...CTX, metadata: { title: "New title" } }, deps);

    expect(res.status).not.toBe("uploaded");
    expect(res.warnings.map((w) => w.code)).toContain("adopted-existing");
    // And the exclusion it exists for now actually fires. `created` is forced
    // on because the guard is only meaningful against a result that would
    // otherwise be removable — the shape adoption → PATCH 404 →
    // `recreateOrphaned` really can produce.
    expect(removableBackendIds([{ ...res, created: true }])).toEqual([]);
  });

  it("degrades to duplicate when the record cannot be resolved", async () => {
    const deps = fakeDeps({
      createItem: vi.fn(async () => conflict()),
      resolveExistingRecord: vi.fn(async () => null),
    });
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(res.status).toBe("duplicate");
    expect(res.message).toMatch(/sync/i);
  });
});

// ── which record adoption actually resolves ────────────────────────────────
//
// Every test above stubs `deps.resolveExistingRecord` wholesale, so none of
// them exercises the decision that picks WHICH record gets adopted: the COBISS
// id `uploadItem` hands the resolver. These two drive the genuine default dep
// — only `findById` and `previewCobiss` are faked — with the item's indexed
// `catalogueId` and the live form value in disagreement.
//
// `catalogueId` comes from the SQLite row (`indexing.ts`) and is refreshed only
// by a folder rescan, so it lags what the operator just typed. Keying off it
// failed in both directions: a corrected id adopted the OLD record (and the
// cobissId guard passed, because it verified against the same stale value),
// and an id entered this session left `catalogueId` null so adoption never
// fired at all.

describe("create collision — resolved on the id this run actually sent", () => {
  beforeEach(() => {
    vi.mocked(findById).mockReset();
    vi.mocked(previewCobiss).mockReset();
    // The COBISS fallback must not be what rescues either test.
    vi.mocked(previewCobiss).mockResolvedValue({ itemId: null } as never);
  });

  /** `fakeDeps` minus `resolveExistingRecord`, so `withDefaults` supplies the
   * real one and the whole resolution path runs. */
  function depsUsingTheRealResolver(over: Partial<UploadDeps> = {}): Partial<UploadDeps> {
    const deps: Partial<UploadDeps> = fakeDeps(over);
    delete deps.resolveExistingRecord;
    return deps;
  }

  function hitFor(id: string, cobissId: string, version: number, title: string): SearchHit {
    return {
      id,
      index: "records",
      score: 1,
      source: { version, visibilityStatus: "PUBLIC", metadata: { cobissId, title } },
    };
  }

  it("looks up the live cobissId, never the item's stale indexed one", async () => {
    const staleId = await deterministicItemId("111"); // what the index row still says
    const liveId = await deterministicItemId("222"); // what this create sent
    expect(staleId).not.toBe(liveId);

    const byId: Record<string, SearchHit> = {
      [staleId]: hitFor(staleId, "111", 3, "Someone else's record"),
      [liveId]: hitFor(liveId, "222", 9, "The record that collided"),
    };
    vi.mocked(findById).mockImplementation(async (id: string) => byId[id] ?? null);

    const res = await uploadItem(
      // The operator corrected 111 → 222 this session; no rescan has landed.
      makeItem({ catalogueId: "111" }),
      { ...CTX, metadata: { cobissId: "222", title: "Gorski vijenac" } },
      depsUsingTheRealResolver({
        createItem: vi.fn(async () => { throw apiError("conflict", 409); }),
        getSchema: vi.fn(async () => COBISS_SCHEMA),
        updateItem: vi.fn(async () => ({ version: 10 })),
      }),
    );

    // The lookup that mattered: id(222), and id(111) never fetched at all.
    expect(vi.mocked(findById).mock.calls.map((c) => c[0])).toEqual([liveId]);
    expect(res.status).toBe("uploaded");
    expect(res.backendId).toBe(liveId);
    expect(res.backendId).not.toBe(staleId);
  });

  it("adopts on the first press when the COBISS id was typed this session (catalogueId still null)", async () => {
    // The branch's headline win. `useMetadata.saveItem` refreshes only the
    // row's title, and the debounced rescan lands after `upload()` has captured
    // its members — so a brand-new item's `catalogueId` is still null when the
    // create collides. Resolving from it returned null before any lookup and
    // the run degraded to the old `duplicate` outcome: exactly the two-trip
    // Sync → Upload dance this branch exists to remove.
    const liveId = await deterministicItemId("222");
    vi.mocked(findById).mockImplementation(async (id: string) =>
      id === liveId ? hitFor(liveId, "222", 9, "The record that collided") : null,
    );

    const res = await uploadItem(
      makeItem({ catalogueId: null }),
      { ...CTX, metadata: { cobissId: "222", title: "Gorski vijenac" } },
      depsUsingTheRealResolver({
        createItem: vi.fn(async () => { throw apiError("conflict", 409); }),
        getSchema: vi.fn(async () => COBISS_SCHEMA),
        updateItem: vi.fn(async () => ({ version: 10 })),
      }),
    );

    expect(vi.mocked(findById)).toHaveBeenCalledWith(liveId);
    expect(res.status).toBe("uploaded");
    expect(res.backendId).toBe(liveId);
    expect(res.warnings.map((w) => w.code)).toContain("adopted-existing");
  });
});

// ── the empty-OCR-text trap ────────────────────────────────────────────────
//
// `dto.UploadFilesParts`: an empty-string `extractedTexts` entry stores NO_TEXT
// *and* still enqueues Tika (the queue filter is a truthiness test), which then
// overwrites it. So an OCR run that produced nothing must NOT go in the map — it
// is set by id afterwards, where nothing is enqueued.

describe("uploadItem — empty OCR text", () => {
  it("never sends an empty extractedTexts entry, and records it by id instead", async () => {
    const deps = fakeDeps({ readTextFile: vi.fn(async () => "") });
    const res = await uploadItem(makeItem(), CTX, deps);

    expect(res.status).toBe("uploaded");

    // The WEB request carries no key for the PDF at all — an empty-string entry
    // here is exactly what enqueues the Tika run this upload avoids.
    const webCall = (deps.uploadFiles as any).mock.calls[1];
    expect(webCall[2].extractedTexts).toEqual({});
    expect(webCall[2].extractedTexts).not.toHaveProperty("gorski.pdf");

    // …and the empty result is stated explicitly on the attachment, by id.
    expect(deps.setFileText).toHaveBeenCalledWith("att-gorski.pdf", "");
  });

  it("still sends a non-empty text in the map (no id round-trip)", async () => {
    const deps = fakeDeps();
    await uploadItem(makeItem(), CTX, deps);

    const webCall = (deps.uploadFiles as any).mock.calls[1];
    expect(webCall[2].extractedTexts).toEqual({ "gorski.pdf": "OCR text" });
    expect(deps.setFileText).not.toHaveBeenCalled();
  });

  it("does not fail the upload when recording the empty result fails", async () => {
    const deps = fakeDeps({
      readTextFile: vi.fn(async () => ""),
      setFileText: vi.fn(async () => {
        throw apiError("server", 500);
      }),
    });
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(res.status).toBe("uploaded");
  });
});

// ── gating ─────────────────────────────────────────────────────────────────

describe("uploadItem — gating", () => {
  it("blocks before any backend call when metadata is not ready", async () => {
    const deps = fakeDeps();
    const res = await uploadItem(makeItem(), { ...CTX, metadataReady: false }, deps);
    expect(res.status).toBe("blocked");
    expect(res.blockers.map((b) => b.code)).toContain("metadata-invalid");
    expect(deps.createItem).not.toHaveBeenCalled();
  });
});

// ── error mapping ────────────────────────────────────────────────────────────

function apiError(kind: ApiError["kind"], status: number, body?: unknown): ApiError {
  return new ApiError({ kind, status, url: "u", method: "POST", message: `err ${status}`, body });
}

describe("uploadItem — error outcomes", () => {
  it("maps 403 to forbidden", async () => {
    const deps = fakeDeps({ createItem: vi.fn(async () => { throw apiError("forbidden", 403); }) });
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(res.status).toBe("forbidden");
    expect(res.message).toMatch(/write access/i);
  });

  it("maps 401 to unauthenticated, not forbidden", async () => {
    // A 401 means no usable token was sent at all — fixed in Settings, not by
    // changing the account's roles. Reporting it as "no write access" sends
    // the operator to Keycloak to audit permissions that were never at fault.
    const deps = fakeDeps({
      createItem: vi.fn(async () => { throw apiError("unauthorized", 401); }),
    });
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(res.status).toBe("unauthenticated");
    expect(res.message).toMatch(/settings/i);
  });

  it("maps a create 409 to duplicate", async () => {
    const deps = fakeDeps({ createItem: vi.fn(async () => { throw apiError("conflict", 409); }) });
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(res.status).toBe("duplicate");
  });

  it("maps a 400 to field errors", async () => {
    const deps = fakeDeps({
      createItem: vi.fn(async () => { throw apiError("bad_request", 400, { message: ["title should not be empty"] }); }),
    });
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(res.status).toBe("error");
    expect(res.fieldErrors).toEqual([{ key: "title", message: "title should not be empty" }]);
  });

  it("retries a transient network failure then succeeds", async () => {
    let calls = 0;
    const deps = fakeDeps({
      createItem: vi.fn(async () => {
        calls++;
        if (calls === 1) throw apiError("network", 0);
        return ENTITY;
      }),
    });
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(res.status).toBe("uploaded");
    expect(calls).toBe(2);
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it("records a parent-link failure without failing the upload", async () => {
    const deps = fakeDeps({ connectParent: vi.fn(async () => { throw apiError("not_found", 404); }) });
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(res.status).toBe("uploaded");
    expect(res.relationErrors).toHaveLength(1);
    expect(res.relationErrors[0].parentId).toBe("par1");
    // A failed connect contributes no parent state.
    expect(res.parentStates).toEqual([]);
  });

  it("surfaces each connected parent's post-write version", async () => {
    // The connect trigger bumps the parent's version, so a mirror of that parent
    // is stale the moment this succeeds. The backend now reports the resulting
    // version (2026-08-07) instead of leaving it to a CDC-lagged re-read.
    const res = await uploadItem(makeItem(), CTX, fakeDeps());
    expect(res.status).toBe("uploaded");
    expect(res.parentStates).toEqual([
      { parentId: "par1", version: 7, childrenInDrafts: 1, childrenInRecords: 0 },
    ]);
  });

  it("recovers the full text when the backend mangles a non-ASCII filename", async () => {
    // Reproduces the live failure (2026-08-07): a Cyrillic multipart filename comes
    // back as `??????`, so the filename-keyed `extractedTexts` matches nothing and
    // the text is dropped on an HTTP 201. Recovery goes through the id-keyed
    // PUT /files/:id/text, which is immune to the same bug.
    const cyr = "ОКТОИХ петогласник 2.pdf";
    const assets = [
      discoverAsset(cyr, `/p/${cyr}`, "gorski"),
      discoverAsset("ОКТОИХ петогласник 2.txt", "/p/ОКТОИХ петогласник 2.txt", "gorski"),
    ];
    const deps = fakeDeps({
      // The backend replaces every non-ASCII character with '?'.
      uploadFiles: vi.fn(async (_id: string, files: UploadFile[]) =>
        files.map((f) =>
          attachment(f.filename.replace(/[^\x00-\x7f]/g, "?"), {
            textExtractionStatus: "NOT_EXTRACTED",
          }),
        ),
      ),
    });

    const res = await uploadItem(makeItem({ assets }), CTX, deps);

    expect(res.status).toBe("uploaded");
    // The mismatch is reported — the stored filename stays corrupted.
    expect(res.warnings.some((w) => w.code === "filename-mangled")).toBe(true);
    // …and the text was re-attached by file id, with the right content.
    expect(deps.setFileText).toHaveBeenCalledTimes(1);
    const [fileId, text] = (deps.setFileText as any).mock.calls[0];
    expect(fileId).toBe("att-?????? ??????????? 2.pdf");
    expect(text).toBe("OCR text");
  });

  it("does not touch setFileText when filenames round-trip intact", async () => {
    const deps = fakeDeps();
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(res.warnings.some((w) => w.code === "filename-mangled")).toBe(false);
    expect(deps.setFileText).not.toHaveBeenCalled();
  });

  it("warns but does not claim recovery when re-attaching the text also fails", async () => {
    const cyr = "Црна Гора.pdf";
    const assets = [
      discoverAsset(cyr, `/p/${cyr}`, "gorski"),
      discoverAsset("Црна Гора.txt", "/p/Црна Гора.txt", "gorski"),
    ];
    const deps = fakeDeps({
      uploadFiles: vi.fn(async (_id: string, files: UploadFile[]) =>
        files.map((f) => attachment(f.filename.replace(/[^\x00-\x7f]/g, "?"))),
      ),
      setFileText: vi.fn(async () => {
        throw apiError("bad_request", 400);
      }),
    });

    const res = await uploadItem(makeItem({ assets }), CTX, deps);
    expect(res.status).toBe("uploaded");
    expect(res.warnings.some((w) => w.code === "filename-mangled")).toBe(true);
    // The operator is told the text is missing rather than left assuming success.
    expect(res.warnings.some((w) => w.code === "ocr-missing")).toBe(true);
  });

  it("splits a many-image item into several upload requests", async () => {
    // The backend caps files per request; one oversized multipart would 400 the
    // whole upload. Reachable via the `graphical` content override on a book.
    const many = Array.from({ length: 23 }, (_, i) =>
      discoverAsset(`${i + 1}.jpg`, `/p/${i + 1}.jpg`, "gorski"),
    );
    const deps = fakeDeps();
    const res = await uploadItem(
      makeItem({ assets: many }),
      { ...CTX, primaryThumbnail: "1.jpg" },
      deps,
    );

    expect(res.status).toBe("uploaded");
    const calls = (deps.uploadFiles as any).mock.calls;
    // 1 THUMBNAIL + ceil(22/10) WEB = 4 requests, none over the cap.
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call[1].length).toBeLessThanOrEqual(MAX_FILES_PER_REQUEST);
    }
    // Every image reached the backend exactly once.
    const sent = calls.flatMap((c: any) => c[1].map((f: any) => f.filename));
    expect(sent).toHaveLength(23);
    expect(new Set(sent).size).toBe(23);
  });

  it("tolerates an older backend that still returns an empty connect body", async () => {
    // Pre-2026-08-07 the endpoint was 204 + empty, which decodes to undefined. The
    // app and the backend deploy independently, so this skew is reachable; it must
    // cost the optimisation, not crash the upload.
    const deps = fakeDeps({
      connectParent: vi.fn(async () => undefined as unknown as never),
    });
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(res.status).toBe("uploaded");
    expect(res.parentStates).toEqual([]);
    expect(res.relationErrors).toEqual([]);
  });

  it("collects parent states per parent, skipping the ones that failed", async () => {
    const deps = fakeDeps({
      connectParent: vi.fn(async (parentId: string) => {
        if (parentId === "bad") throw apiError("not_found", 404);
        return { parentId, version: 9, childrenInDrafts: 2, childrenInRecords: 0 };
      }),
    });
    const res = await uploadItem(
      makeItem(),
      { ...CTX, parentIds: ["par1", "bad", "par2"] },
      deps,
    );
    expect(res.parentStates.map((s) => s.parentId)).toEqual(["par1", "par2"]);
    expect(res.relationErrors.map((e) => e.parentId)).toEqual(["bad"]);
  });
});

// ── replace path ─────────────────────────────────────────────────────────────

describe("uploadItem — replace", () => {
  const MIRROR: LocalMetadataFile = {
    backendId: "rec_1",
    version: 3,
    targetState: "RECORD",
    visibilityStatus: "PUBLIC",
    metadata: { title: "Old title", year: "2020" },
    syncedAt: "2026-08-01T00:00:00.000Z",
  };

  function replaceItem(): Item {
    return makeItem({ root: "processed", backendId: "rec_1", flags: { uploaded: true, reupload: true, reuploadTextOnly: false } });
  }

  it("PATCHes only the changed keys with expectedVersion and replaces matched files", async () => {
    const deps = fakeDeps({
      readMirror: vi.fn(async () => MIRROR),
      listFiles: vi.fn(async () => [attachment("gorski.pdf", { id: "f-pdf" }), attachment("gorski_thumb.png", { id: "f-thumb" })]),
    });
    const res = await uploadItem(replaceItem(), { ...CTX, metadata: { title: "New title", year: "2020" } }, deps);

    expect(res.status).toBe("uploaded");
    expect(deps.createItem).not.toHaveBeenCalled();
    expect((deps.updateItem as any).mock.calls[0]).toEqual([
      "rec_1",
      { expectedVersion: 3, metadata: { title: "New title" } },
      {},
    ]);
    // both files replaced in place, none freshly uploaded
    expect(deps.replaceFile).toHaveBeenCalledTimes(2);
    expect(deps.uploadFiles).not.toHaveBeenCalled();
    // a replace stays in /processed
    expect(deps.moveToProcessed).not.toHaveBeenCalled();
  });

  // Deployment skew: the app is installed on a workstation while the backend is
  // deployed independently, so a newer app can meet a pre-2026-08-07 backend that
  // still answers a no-op PATCH with an empty body (→ `undefined`). Reading
  // `.version` off that throws a TypeError, which is not an ApiError and would
  // reach the operator raw. `connectParents` already tolerates this; so must this.
  it("survives a backend that answers PATCH with an empty body", async () => {
    const deps = fakeDeps({
      readMirror: vi.fn(async () => MIRROR),
      updateItem: vi.fn(async () => undefined as never),
      listFiles: vi.fn(async () => [attachment("gorski.pdf", { id: "f-pdf" })]),
    });
    const res = await uploadItem(
      replaceItem(),
      { ...CTX, metadata: { title: "New title", year: "2020" } },
      deps,
    );

    expect(res.status).toBe("uploaded");
    // Falls back to the version we already knew, rather than crashing or
    // mirroring `undefined` — which would break the next PATCH's expectedVersion.
    expect((deps.writeMirror as any).mock.calls[0][1].version).toBe(3);
  });

  // Regression: the backend stores non-ASCII multipart filenames corrupted, so a
  // filename-keyed lookup never matched Cyrillic material — every re-upload took
  // the "not on the backend" branch and ADDED a duplicate attachment instead of
  // replacing in place. Live-verified before the fix: two attachments after one
  // re-upload. See `domain/naming.isSameUploadedFilename`.
  it("replaces in place when the backend mangled the stored filename", async () => {
    const local = "ОКТОИХ петогласник 2.pdf";
    const stored = Array.from(new TextEncoder().encode(local), (b) =>
      String.fromCharCode(b),
    ).join("");

    const deps = fakeDeps({
      readMirror: vi.fn(async () => MIRROR),
      listFiles: vi.fn(async () => [attachment(stored, { id: "f-pdf" })]),
    });
    const item = makeItem({
      root: "processed",
      backendId: "rec_1",
      flags: { uploaded: true, reupload: true, reuploadTextOnly: false },
      folderName: "ОКТОИХ петогласник 2",
      assets: [discoverAsset(local, `/p/${local}`)],
    });

    const res = await uploadItem(item, { ...CTX, metadata: { title: "Old title", year: "2020" } }, deps);

    expect(res.status).toBe("uploaded");
    // The whole point: replaced by id, NOT uploaded as a second copy.
    expect(deps.replaceFile).toHaveBeenCalledTimes(1);
    expect((deps.replaceFile as any).mock.calls[0][0]).toBe("f-pdf");
    expect(deps.uploadFiles).not.toHaveBeenCalled();
    // The operator is still told the stored name is corrupted — only the backend
    // can repair the value it holds.
    expect(res.warnings.map((w) => w.code)).toContain("filename-mangled");
  });

  it("does not let two local files claim the same backend attachment", async () => {
    const deps = fakeDeps({
      readMirror: vi.fn(async () => MIRROR),
      listFiles: vi.fn(async () => [attachment("gorski.pdf", { id: "f-pdf" })]),
    });
    const item = makeItem({
      root: "processed",
      backendId: "rec_1",
      flags: { uploaded: true, reupload: true, reuploadTextOnly: false },
      assets: [
        discoverAsset("gorski.pdf", "/p/gorski.pdf"),
        discoverAsset("gorski_thumb.png", "/p/gorski_thumb.png"),
      ],
    });
    await uploadItem(item, { ...CTX, metadata: { title: "Old title", year: "2020" } }, deps);

    // Only the PDF matched; the thumbnail is genuinely missing and uploads fresh.
    expect(deps.replaceFile).toHaveBeenCalledTimes(1);
    expect(deps.uploadFiles).toHaveBeenCalledTimes(1);
  });

  it("includes visibilityStatus in the PATCH when it changed", async () => {
    const deps = fakeDeps({
      readMirror: vi.fn(async () => MIRROR),
      listFiles: vi.fn(async () => [attachment("gorski.pdf", { id: "f-pdf" }), attachment("gorski_thumb.png", { id: "f-thumb" })]),
    });
    await uploadItem(replaceItem(), { ...CTX, visibility: "PRIVATE", metadata: { title: "Old title", year: "2020" } }, deps);
    expect((deps.updateItem as any).mock.calls[0][1]).toEqual({ expectedVersion: 3, visibilityStatus: "PRIVATE" });
  });

  it("skips the PATCH entirely when nothing changed", async () => {
    const deps = fakeDeps({
      readMirror: vi.fn(async () => MIRROR),
      listFiles: vi.fn(async () => [attachment("gorski.pdf", { id: "f-pdf" }), attachment("gorski_thumb.png", { id: "f-thumb" })]),
    });
    await uploadItem(replaceItem(), { ...CTX, metadata: { title: "Old title", year: "2020" } }, deps);
    expect(deps.updateItem).not.toHaveBeenCalled();
    // Nothing was sent, so the mirror keeps the version it already had.
    expect((deps.writeMirror as any).mock.calls[0][1].version).toBe(3);
  });

  it("mirrors the version the backend returned from the PATCH", async () => {
    const deps = fakeDeps({
      readMirror: vi.fn(async () => MIRROR),
      listFiles: vi.fn(async () => [attachment("gorski.pdf", { id: "f-pdf" }), attachment("gorski_thumb.png", { id: "f-thumb" })]),
      updateItem: vi.fn(async () => ({ version: 42 })),
    });
    await uploadItem(replaceItem(), { ...CTX, metadata: { title: "New title", year: "2020" } }, deps);
    expect((deps.writeMirror as any).mock.calls[0][1].version).toBe(42);
    expect((deps.recordUpload as any).mock.calls[0][1].version).toBe(42);
  });

  it("trusts the returned version even when the backend wrote nothing", async () => {
    // The PATCH response is uniform since the 2026-08-07 backend fix: a request
    // with nothing to write returns the UNCHANGED version rather than an empty
    // body. Previously this arm resolved to `undefined` and the caller had to
    // guess — and a wrong `expectedVersion` produced the same `undefined`, so it
    // could not be told apart from success. Now `409` covers that and the body is
    // always authoritative.
    const deps = fakeDeps({
      readMirror: vi.fn(async () => MIRROR),
      listFiles: vi.fn(async () => [attachment("gorski.pdf", { id: "f-pdf" }), attachment("gorski_thumb.png", { id: "f-thumb" })]),
      updateItem: vi.fn(async () => ({ version: 3 })),
    });
    await uploadItem(replaceItem(), { ...CTX, metadata: { title: "New title", year: "2020" } }, deps);
    expect(deps.updateItem).toHaveBeenCalledTimes(1);
    expect((deps.writeMirror as any).mock.calls[0][1].version).toBe(3);
  });

  it("does NOT re-push unchanged blobs on a metadata-only re-upload (reupload=false)", async () => {
    const deps = fakeDeps({
      readMirror: vi.fn(async () => MIRROR),
      listFiles: vi.fn(async () => [attachment("gorski.pdf", { id: "f-pdf" }), attachment("gorski_thumb.png", { id: "f-thumb" })]),
    });
    const item = makeItem({ root: "processed", backendId: "rec_1", flags: { uploaded: true, reupload: false, reuploadTextOnly: false } });
    const res = await uploadItem(item, { ...CTX, metadata: { title: "New title", year: "2020" } }, deps);
    expect(res.status).toBe("uploaded");
    expect(deps.updateItem).toHaveBeenCalledTimes(1); // metadata still PATCHed
    expect(deps.replaceFile).not.toHaveBeenCalled(); // present + unchanged → left alone
    expect(deps.uploadFiles).not.toHaveBeenCalled(); // nothing missing
  });

  it("uploads only the MISSING files on a metadata-only re-upload (recovery)", async () => {
    // The thumbnail is already on the backend; the web PDF is not (a prior create
    // whose asset step failed). reupload=false, but the missing file is still sent.
    const deps = fakeDeps({
      readMirror: vi.fn(async () => MIRROR),
      listFiles: vi.fn(async () => [attachment("gorski_thumb.png", { id: "f-thumb" })]),
    });
    const item = makeItem({ root: "processed", backendId: "rec_1", flags: { uploaded: true, reupload: false, reuploadTextOnly: false } });
    await uploadItem(item, { ...CTX, metadata: { title: "Old title", year: "2020" } }, deps);
    expect(deps.replaceFile).not.toHaveBeenCalled();
    expect(deps.uploadFiles).toHaveBeenCalledTimes(1); // the missing WEB pdf
    expect((deps.uploadFiles as any).mock.calls[0][1].map((f: any) => f.filename)).toEqual(["gorski.pdf"]);
  });

  it("pushes only the OCR text (no blob) on a text-only re-upload (reuploadTextOnly=true)", async () => {
    const deps = fakeDeps({
      readMirror: vi.fn(async () => MIRROR),
      listFiles: vi.fn(async () => [attachment("gorski.pdf", { id: "f-pdf" }), attachment("gorski_thumb.png", { id: "f-thumb" })]),
    });
    const item = makeItem({ root: "processed", backendId: "rec_1", flags: { uploaded: true, reupload: true, reuploadTextOnly: true } });
    const res = await uploadItem(item, { ...CTX, metadata: { title: "New title", year: "2020" } }, deps);

    expect(res.status).toBe("uploaded");
    expect(deps.replaceFile).not.toHaveBeenCalled(); // the whole point — no blob PUT
    expect(deps.uploadFiles).not.toHaveBeenCalled(); // nothing missing
    expect(deps.setFileText).toHaveBeenCalledWith("f-pdf", "OCR text");
    // The thumbnail has no paired text file — nothing to push for it at all.
    expect(deps.setFileText).toHaveBeenCalledTimes(1);
  });

  it("still does a full blob replace when reupload=true and reuploadTextOnly=false", async () => {
    const deps = fakeDeps({
      readMirror: vi.fn(async () => MIRROR),
      listFiles: vi.fn(async () => [attachment("gorski.pdf", { id: "f-pdf" }), attachment("gorski_thumb.png", { id: "f-thumb" })]),
    });
    const item = makeItem({ root: "processed", backendId: "rec_1", flags: { uploaded: true, reupload: true, reuploadTextOnly: false } });
    const res = await uploadItem(item, { ...CTX, metadata: { title: "New title", year: "2020" } }, deps);

    expect(res.status).toBe("uploaded");
    expect(deps.replaceFile).toHaveBeenCalledTimes(2); // both matched assets
    expect(deps.setFileText).not.toHaveBeenCalled(); // text rides along on the replace instead
  });

  it("errors (asks for re-sync) on a replace with no known local version", async () => {
    const deps = fakeDeps({
      readMirror: vi.fn(async () => ({ ...MIRROR, version: null })),
    });
    const res = await uploadItem(replaceItem(), CTX, deps);
    expect(res.status).toBe("error");
    expect(res.message).toMatch(/re-sync/i);
    expect(deps.updateItem).not.toHaveBeenCalled();
    expect(deps.listFiles).not.toHaveBeenCalled();
  });
});

// ── orphan recovery ──────────────────────────────────────────────────────────
// A PATCH 404 reads Postgres directly, unlike a search 404 which is CDC-lagged
// — so it is authoritative: the record really is gone, and re-creating it
// cannot double-create. A 409 must NOT trigger this — that record still exists.

const ORPHAN_MIRROR: LocalMetadataFile = {
  backendId: "cbwkbr9guqs3w11xylpri1ylw",
  version: 3,
  targetState: "RECORD",
  visibilityStatus: "PUBLIC",
  metadata: {},
  syncedAt: "2026-09-20T00:00:00.000Z",
};

describe("orphan recovery", () => {
  it("re-creates when the backend says the record is gone", async () => {
    // A PATCH 404 reads Postgres directly (items.service.ts:190-196), unlike a
    // search 404 which is CDC-lagged. So it is authoritative: the row is gone
    // and re-creating cannot double-create.
    const createItem = vi.fn(async () => ({
      ...ENTITY,
      id: "cbwkbr9guqs3w11xylpri1ylw",
      version: 0,
      metadata: {},
    }));
    const deps = fakeDeps({
      readMirror: vi.fn(async () => ORPHAN_MIRROR),
      updateItem: vi.fn(async () => { throw apiError("not_found", 404); }),
      createItem,
    });
    const item = { ...makeItem(), backendId: "cbwkbr9guqs3w11xylpri1ylw" };

    const res = await uploadItem(item, CTX, deps);

    expect(createItem).toHaveBeenCalledTimes(1);
    expect(res.status).toBe("uploaded");
    expect(res.warnings.map((w) => w.code)).toContain("recreated-orphaned");
  });

  it("brings the record back in the state the mirror last saw, not the batch's", async () => {
    // A restoration, not a publication. The mirror says this was a PUBLIC
    // RECORD; the batch this re-upload happens to run under is a routine
    // DRAFT/PRIVATE one. Re-creating with the batch's settings silently
    // unpublished material that had been live on the National Library's public
    // catalogue — and the operator only ever saw "the upload retried and
    // worked".
    const createItem = vi.fn(async () => ({
      ...ENTITY,
      id: "cbwkbr9guqs3w11xylpri1ylw",
      version: 0,
      metadata: {},
    }));
    const recordUpload = vi.fn(async () => {});
    const deps = fakeDeps({
      readMirror: vi.fn(async () => ORPHAN_MIRROR), // RECORD / PUBLIC
      updateItem: vi.fn(async () => { throw apiError("not_found", 404); }),
      createItem,
      recordUpload,
    });
    const item = { ...makeItem(), backendId: "cbwkbr9guqs3w11xylpri1ylw" };

    const res = await uploadItem(
      item,
      { ...CTX, targetState: "DRAFT", visibility: "PRIVATE" },
      deps,
    );

    expect(res.status).toBe("uploaded");
    const [dto] = (createItem as any).mock.calls[0];
    expect(dto.targetState).toBe("RECORD");
    expect(dto.visibilityStatus).toBe("PUBLIC");
    // …and the local stores record the state it was actually re-created in.
    const calls = (recordUpload as any).mock.calls;
    const [, upload] = calls[calls.length - 1];
    expect(upload.targetState).toBe("RECORD");
    expect(upload.visibilityStatus).toBe("PUBLIC");
  });

  it("falls back to the batch's settings when the mirror never recorded any", async () => {
    // A mirror written before `targetState`/`visibilityStatus` existed. There
    // is nothing better than the batch's values, and refusing to re-create
    // would put the item back in the hard lock this path exists to clear.
    const createItem = vi.fn(async () => ({
      ...ENTITY,
      id: "cbwkbr9guqs3w11xylpri1ylw",
      version: 0,
      metadata: {},
    }));
    const deps = fakeDeps({
      readMirror: vi.fn(async () => ({
        ...ORPHAN_MIRROR,
        targetState: null,
        visibilityStatus: null,
      })),
      updateItem: vi.fn(async () => { throw apiError("not_found", 404); }),
      createItem,
    });
    const item = { ...makeItem(), backendId: "cbwkbr9guqs3w11xylpri1ylw" };

    const res = await uploadItem(
      item,
      { ...CTX, targetState: "DRAFT", visibility: "PRIVATE" },
      deps,
    );

    expect(res.status).toBe("uploaded");
    const [dto] = (createItem as any).mock.calls[0];
    expect(dto.targetState).toBe("DRAFT");
    expect(dto.visibilityStatus).toBe("PRIVATE");
  });

  it("does NOT re-create on a 409 — that record still exists", async () => {
    const createItem = vi.fn();
    const deps = fakeDeps({
      readMirror: vi.fn(async () => ORPHAN_MIRROR),
      updateItem: vi.fn(async () => { throw apiError("conflict", 409); }),
      createItem,
    });
    const item = { ...makeItem(), backendId: "cbwkbr9guqs3w11xylpri1ylw" };

    const res = await uploadItem(item, CTX, deps);

    expect(createItem).not.toHaveBeenCalled();
    expect(res.status).toBe("error");
  });
});

// ── connected parents adopt their bumped version ─────────────────────────────
// `POST /api/relations/connect` fires a trigger that bumps the PARENT's version
// once per edge, so connecting a child silently invalidates the parent's
// mirrored version and its next ordinary PATCH 409s. The connect response
// carries the authoritative post-trigger version; these pin that it is applied.

describe("applyParentStates", () => {
  const parentItem = (over: Partial<Item> = {}): Item =>
    makeItem({ id: "parent-item", folderPath: "/parent", backendId: "par1", ...over });

  const parentMirror = (version: number | null): LocalMetadataFile => ({
    backendId: "par1",
    version,
    targetState: "RECORD",
    visibilityStatus: "PUBLIC",
    metadata: { title: "Parent", childrenInDrafts: 0, childrenInRecords: 0 },
    syncedAt: "2026-08-01T00:00:00.000Z",
  });

  it("adopts the connected parent's new version into its mirror", async () => {
    const deps = fakeDeps({
      listItems: vi.fn(async () => [parentItem()]),
      readMirror: vi.fn(async (item: Item) =>
        item.id === "parent-item" ? parentMirror(3) : null,
      ),
    });
    await uploadItem(makeItem(), CTX, deps);

    const write = (deps.writeMirror as any).mock.calls.find(
      (c: any[]) => c[0].id === "parent-item",
    );
    expect(write).toBeDefined();
    // `connectParent` in the fixture reports version 7.
    expect(write[1].version).toBe(7);
    expect(write[1].metadata.childrenInDrafts).toBe(1);
  });

  it("never moves a parent's version backwards (CDC / out-of-order guard)", async () => {
    const deps = fakeDeps({
      listItems: vi.fn(async () => [parentItem()]),
      readMirror: vi.fn(async (item: Item) =>
        item.id === "parent-item" ? parentMirror(12) : null,
      ),
    });
    await uploadItem(makeItem(), CTX, deps);

    const write = (deps.writeMirror as any).mock.calls.find(
      (c: any[]) => c[0].id === "parent-item",
    );
    expect(write).toBeUndefined(); // 7 < 12 → left alone
  });

  it("skips a parent that is not tracked locally", async () => {
    const deps = fakeDeps({ listItems: vi.fn(async () => []) });
    const res = await uploadItem(makeItem(), CTX, deps);

    expect(res.status).toBe("uploaded");
    const write = (deps.writeMirror as any).mock.calls.find(
      (c: any[]) => c[0].id === "parent-item",
    );
    expect(write).toBeUndefined();
  });

  it("does not fail the upload when the parent mirror cannot be written", async () => {
    const deps = fakeDeps({
      listItems: vi.fn(async () => [parentItem()]),
      readMirror: vi.fn(async (item: Item) =>
        item.id === "parent-item" ? parentMirror(3) : null,
      ),
      writeMirror: vi.fn(async (item: Item) => {
        if (item.id === "parent-item") throw new Error("disk full");
      }),
    });
    const res = await uploadItem(makeItem(), CTX, deps);

    // The item itself is uploaded — a stale parent mirror is recoverable by sync.
    expect(res.status).toBe("uploaded");
  });
});

// ── batch driver ─────────────────────────────────────────────────────────────

describe("uploadBatch", () => {
  it("uploads each item, reports progress, and flags allUploaded", async () => {
    const deps = fakeDeps();
    const items = [makeItem({ id: "a", folderPath: "/a" }), makeItem({ id: "b", folderPath: "/b" })];
    const phases: string[] = [];
    const out = await uploadBatch(items, {
      resolveContext: () => CTX,
      onProgress: (p) => phases.push(`${p.itemId}:${p.phase}`),
      deps,
    });
    expect(out.results.map((r) => r.status)).toEqual(["uploaded", "uploaded"]);
    expect(out.allUploaded).toBe(true);
    expect(phases).toEqual(["a:start", "a:done", "b:start", "b:done"]);
  });

  it("allUploaded is false when any item fails", async () => {
    const deps = fakeDeps({ createItem: vi.fn(async () => { throw apiError("forbidden", 403); }) });
    const out = await uploadBatch([makeItem()], { resolveContext: () => CTX, deps });
    expect(out.allUploaded).toBe(false);
    expect(out.results[0].status).toBe("forbidden");
  });
});

describe("PARENT_NOT_FOUND", () => {
  const gone = () =>
    new ApiError({
      kind: "bad_request",
      status: 400,
      url: "u",
      method: "POST",
      message: "Parent not found: par1",
      body: { statusCode: 400, code: "PARENT_NOT_FOUND", message: "Parent not found: par1", parentIds: ["par1"] },
    });

  it("reports the missing parent on the item", async () => {
    const deps = fakeDeps({ createItem: vi.fn(async () => { throw gone(); }) });
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(res.status).toBe("error");
    expect(res.missingParentIds).toEqual(["par1"]);
  });

  it("stops the batch instead of failing every item the same way", async () => {
    const deps = fakeDeps({ createItem: vi.fn(async () => { throw gone(); }) });
    const out = await uploadBatch([makeItem({ id: "a" }), makeItem({ id: "b" })], { resolveContext: () => CTX, deps });
    expect(out.results).toHaveLength(1);
    expect(out.missingParentIds).toEqual(["par1"]);
    expect(deps.createItem).toHaveBeenCalledTimes(1);
  });
});

// ── retry policy on the calls that carry a payload ──────────────────────────
//
// A 105 MB web PDF that missed its deadline used to be sent three times before
// the batch was told anything — the retry is for a flaky link, and against a
// transfer that simply needs longer than it was given it only triples the wait.

describe("transfer retries", () => {
  it("does not repeat a file upload that timed out", async () => {
    let calls = 0;
    const deps = fakeDeps({
      uploadFiles: vi.fn(async () => {
        calls++;
        throw apiError("timeout", 0);
      }),
    });

    const res = await uploadItem(makeItem(), CTX, deps);

    expect(res.status).toBe("error");
    expect(calls).toBe(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("still repeats a file upload that hit a dropped connection", async () => {
    let calls = 0;
    const deps = fakeDeps({
      uploadFiles: vi.fn(async (_id: string, files: UploadFile[]) => {
        calls++;
        if (calls === 1) throw apiError("network", 0);
        return files.map((f) => attachment(f.filename));
      }),
    });

    const res = await uploadItem(makeItem(), CTX, deps);

    expect(res.status).toBe("uploaded");
    expect(deps.sleep).toHaveBeenCalledTimes(1);
    // Three, not two: this item uploads a WEB group and a THUMBNAIL group, so
    // there are two requests even before the retry.
    expect(calls).toBe(3);
  });

  it("leaves the metadata calls alone — a timeout there is still worth a retry", async () => {
    let calls = 0;
    const deps = fakeDeps({
      createItem: vi.fn(async () => {
        calls++;
        if (calls <= 1) throw apiError("timeout", 0);
        return ENTITY;
      }),
    });

    const res = await uploadItem(makeItem(), CTX, deps);

    expect(res.status).toBe("uploaded");
    expect(calls).toBe(2);
  });

  it("does not repeat a full-text write that timed out", async () => {
    let calls = 0;
    const deps = fakeDeps({
      // Force the setFileText recovery path: the backend reports a filename
      // that does not match what was sent, so the text is pushed by id.
      uploadFiles: vi.fn(async (_id: string, files: UploadFile[]) =>
        files.map((f) => attachment(`mangled-${f.filename}`)),
      ),
      setFileText: vi.fn(async () => {
        calls++;
        throw apiError("timeout", 0);
      }),
    });

    const res = await uploadItem(makeItem(), CTX, deps);

    expect(calls).toBe(1);
    // The item still publishes — a text that could not be re-attached is a
    // warning, not a lost upload — but it says so instead of retrying blind.
    expect(res.status).toBe("uploaded");
    expect(res.warnings.some((w) => w.message.includes("could not be attached"))).toBe(true);
  });
});

describe("resolveExistingRecord (default dep)", () => {
  it("adopts a record whose cobissId matches the one that collided", async () => {
    const hit: SearchHit = {
      id: "cbwkbr9guqs3w11xylpri1ylw",
      index: "records",
      score: 1,
      source: {
        version: 7,
        visibilityStatus: "PUBLIC",
        metadata: { cobissId: "12345", title: "Existing" },
      },
    };
    const found = await resolveExistingRecordWith(
      "12345",
      { findById: vi.fn(async () => hit), previewCobiss: vi.fn() },
    );
    expect(found).toEqual({
      id: "cbwkbr9guqs3w11xylpri1ylw",
      version: 7,
      targetState: "RECORD",
      visibilityStatus: "PUBLIC",
      metadata: { cobissId: "12345", title: "Existing" },
    });
  });

  it("refuses a record whose cobissId does NOT match", async () => {
    // The computed id is a port of a backend invariant. If the backend's
    // derivation ever drifts we must degrade, never adopt a stranger's record.
    const hit: SearchHit = {
      id: "cbwkbr9guqs3w11xylpri1ylw",
      index: "records",
      score: 1,
      source: { version: 7, visibilityStatus: "PUBLIC", metadata: { cobissId: "999" } },
    };
    const found = await resolveExistingRecordWith(
      "12345",
      { findById: vi.fn(async () => hit), previewCobiss: vi.fn(async () => ({ itemId: null })) },
    );
    expect(found).toBeNull();
  });

  it("refuses a hit with no version (nothing to do optimistic concurrency with)", async () => {
    const hit: SearchHit = {
      id: "cbwkbr9guqs3w11xylpri1ylw",
      index: "records",
      score: 1,
      source: { visibilityStatus: "PUBLIC", metadata: { cobissId: "12345" } },
    };
    const found = await resolveExistingRecordWith(
      "12345",
      { findById: vi.fn(async () => hit), previewCobiss: vi.fn(async () => ({ itemId: null })) },
    );
    expect(found).toBeNull();
  });

  it("returns null without any network call when there is no cobissId at all", async () => {
    const findById = vi.fn();
    const found = await resolveExistingRecordWith(
      null,
      { findById, previewCobiss: vi.fn() },
    );
    expect(found).toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });
});

// ── close-time cleanup ───────────────────────────────────────────────────

/** An `ItemUploadResult` fixture — defaults to an unfinished, created item
 * (the removable shape), overridable per test. */
function uploadResult(over: Partial<ItemUploadResult> = {}): ItemUploadResult {
  return {
    itemId: "i",
    status: "error",
    backendId: null,
    created: true,
    blockers: [],
    warnings: [],
    fieldErrors: [],
    relationErrors: [],
    parentStates: [],
    missingParentIds: [],
    message: null,
    ...over,
  };
}

describe("removableBackendIds", () => {
  it("includes an item this batch created and did not finish", () => {
    const ids = removableBackendIds([
      uploadResult({ itemId: "i2", status: "error", backendId: "b2" }),
    ]);
    expect(ids).toEqual(["b2"]);
  });

  it("excludes an item that reached uploaded", () => {
    // Non-vacuous against removing the `status === "uploaded"` check: without
    // it "b1" would be included alongside "b2".
    const ids = removableBackendIds([
      uploadResult({ itemId: "i1", status: "uploaded", backendId: "b1" }),
      uploadResult({ itemId: "i2", status: "error", backendId: "b2" }),
    ]);
    expect(ids).toEqual(["b2"]);
  });

  it("excludes an adopted-existing record, even though the item failed", () => {
    // Non-vacuous against removing the `adopted-existing` warning check:
    // without it "b3" — someone else's pre-existing record — would be
    // included.
    const ids = removableBackendIds([
      uploadResult({
        itemId: "i3",
        status: "error",
        backendId: "b3",
        warnings: [{ code: "adopted-existing", message: "" }],
      }),
    ]);
    expect(ids).toEqual([]);
  });

  it("excludes an item with no backendId — nothing was ever created", () => {
    // Non-vacuous against removing the `!r.backendId` check: without it a
    // null id would be pushed onto the result.
    const ids = removableBackendIds([
      uploadResult({ itemId: "i4", status: "blocked", backendId: null }),
    ]);
    expect(ids).toEqual([]);
  });

  it("does NOT exclude a recreated-orphaned record — that one is removable", () => {
    // Non-vacuous against over-broadening the warning-code check: if
    // "recreated-orphaned" were folded into the exclusion (as it must not
    // be — see the doc comment on `removableBackendIds`), "b5" would be
    // dropped.
    const ids = removableBackendIds([
      uploadResult({
        itemId: "i5",
        status: "error",
        backendId: "b5",
        warnings: [{ code: "recreated-orphaned", message: "" }],
      }),
    ]);
    expect(ids).toEqual(["b5"]);
  });

  it("applies all three exclusions independently across a mixed batch", () => {
    const results = [
      uploadResult({ itemId: "i1", status: "uploaded", backendId: "b1" }),
      uploadResult({ itemId: "i2", status: "error", backendId: "b2" }),
      uploadResult({
        itemId: "i3",
        status: "error",
        backendId: "b3",
        warnings: [{ code: "adopted-existing", message: "" }],
      }),
      uploadResult({ itemId: "i4", status: "blocked", backendId: null }),
    ];
    expect(removableBackendIds(results)).toEqual(["b2"]);
  });
});

describe("cleanupUnfinishedRecords", () => {
  it("calls deleteItems once with exactly the removable ids", async () => {
    const deleteItems = vi.fn(async () => {});
    const results = [
      uploadResult({ itemId: "i1", status: "uploaded", backendId: "b1" }),
      uploadResult({ itemId: "i2", status: "error", backendId: "b2" }),
      uploadResult({
        itemId: "i3",
        status: "error",
        backendId: "b3",
        warnings: [{ code: "adopted-existing", message: "" }],
      }),
    ];

    const ok = await cleanupUnfinishedRecords(results, { deleteItems });

    expect(deleteItems).toHaveBeenCalledTimes(1);
    expect(deleteItems).toHaveBeenCalledWith(["b2"]);
    expect(ok).toBe(true);
  });

  it("does not call deleteItems when nothing is removable", async () => {
    // Non-vacuous against dropping the `ids.length === 0` guard: without it
    // deleteItems would be called with an empty array.
    const deleteItems = vi.fn(async () => {});

    const ok = await cleanupUnfinishedRecords(
      [uploadResult({ itemId: "i1", status: "uploaded", backendId: "b1" })],
      { deleteItems },
    );

    expect(deleteItems).not.toHaveBeenCalled();
    expect(ok).toBe(true);
  });

  it("is best-effort: a rejected delete does not throw, but reports failure", async () => {
    // Non-vacuous against removing the try/catch: without it the rejection
    // would propagate and this assertion would fail. Non-vacuous against
    // always returning `true`: without a real `false` on the caught branch,
    // `closeBatch` would have no way to tell the operator cleanup failed.
    const deleteItems = vi.fn(async () => {
      throw new Error("boom");
    });

    const ok = await cleanupUnfinishedRecords(
      [uploadResult({ itemId: "i2", status: "error", backendId: "b2" })],
      { deleteItems },
    );

    expect(deleteItems).toHaveBeenCalledWith(["b2"]);
    expect(ok).toBe(false);
  });
});

// ── created provenance drives removability, end to end ──────────────────────
// Task 7 fix: the ORIGINAL selection rule inferred "this batch created it"
// from `backendId` alone — but `backendId` is seeded from `item.backendId`, a
// *persistent local* value from the `metadata.json` mirror. It survives
// sessions and means "linked", not "made here". These run the real
// `uploadItem` pipeline (not a synthetic fixture) so the `created` flag under
// test is the one the production code actually computed — proving the fix
// where it matters: at the site that produced a false positive before.

const REPLACE_MIRROR: LocalMetadataFile = {
  backendId: "rec_1",
  version: 3,
  targetState: "RECORD",
  visibilityStatus: "PUBLIC",
  metadata: { title: "Old title" },
  syncedAt: "2026-08-01T00:00:00.000Z",
};

describe("removableBackendIds — created provenance (regression)", () => {
  it("a failed replace with a pre-existing backendId and no warning is NOT removable", async () => {
    const deps = fakeDeps({
      readMirror: vi.fn(async () => REPLACE_MIRROR),
      // A non-transient, non-404, non-409 PATCH failure — nothing about it
      // suggests a fresh record.
      updateItem: vi.fn(async () => {
        throw apiError("server", 500);
      }),
    });
    const item = makeItem({
      root: "processed",
      backendId: "rec_1",
      flags: { uploaded: true, reupload: true, reuploadTextOnly: false },
    });

    const res = await uploadItem(item, CTX, deps);

    expect(res.status).toBe("error");
    expect(res.backendId).toBe("rec_1");
    expect(res.created).toBe(false);
    expect(removableBackendIds([res])).toEqual([]);
  });

  it("a blocked item carrying a pre-existing backendId is NOT removable", async () => {
    const item = makeItem({ backendId: "rec_1" });

    const res = await uploadItem(item, { ...CTX, metadataReady: false }, fakeDeps());

    expect(res.status).toBe("blocked");
    expect(res.backendId).toBe("rec_1");
    expect(res.created).toBe(false);
    expect(removableBackendIds([res])).toEqual([]);
  });

  it("an unauthenticated (401) replace with a pre-existing backendId is NOT removable", async () => {
    const deps = fakeDeps({
      readMirror: vi.fn(async () => REPLACE_MIRROR),
      updateItem: vi.fn(async () => {
        throw apiError("unauthorized", 401);
      }),
    });
    const item = makeItem({
      root: "processed",
      backendId: "rec_1",
      flags: { uploaded: true, reupload: true, reuploadTextOnly: false },
    });

    const res = await uploadItem(item, CTX, deps);

    expect(res.status).toBe("unauthenticated");
    expect(res.backendId).toBe("rec_1");
    expect(res.created).toBe(false);
    expect(removableBackendIds([res])).toEqual([]);
  });

  it("a forbidden (403) replace with a pre-existing backendId is NOT removable", async () => {
    const deps = fakeDeps({
      readMirror: vi.fn(async () => REPLACE_MIRROR),
      updateItem: vi.fn(async () => {
        throw apiError("forbidden", 403);
      }),
    });
    const item = makeItem({
      root: "processed",
      backendId: "rec_1",
      flags: { uploaded: true, reupload: true, reuploadTextOnly: false },
    });

    const res = await uploadItem(item, CTX, deps);

    expect(res.status).toBe("forbidden");
    expect(res.backendId).toBe("rec_1");
    expect(res.created).toBe(false);
    expect(removableBackendIds([res])).toEqual([]);
  });

  it("a failed create (created this run, assets failed) IS removable", async () => {
    const deps = fakeDeps({
      uploadFiles: vi.fn(async () => {
        throw apiError("bad_request", 400, { message: ["boom"] });
      }),
    });

    const res = await uploadItem(makeItem(), CTX, deps);

    expect(res.status).toBe("error");
    expect(res.backendId).toBe("rec_1");
    expect(res.created).toBe(true);
    expect(removableBackendIds([res])).toEqual(["rec_1"]);
  });

  it("a failed recreated-orphaned run IS removable, at the fresh id — not the dead one", async () => {
    // The subtle case: `recreateOrphaned` mints a NEW id ("new_rec_2") while
    // `uploadItem`'s hoisted `backendId` still reads the dead, 404'd orphan
    // id ("cbwkbr9guqs3w11xylpri1ylw"). Reporting the dead id would send
    // close-time cleanup at a record that no longer exists.
    const orphanMirror: LocalMetadataFile = {
      backendId: "cbwkbr9guqs3w11xylpri1ylw",
      version: 3,
      targetState: "RECORD",
      visibilityStatus: "PUBLIC",
      metadata: {},
      syncedAt: "2026-09-20T00:00:00.000Z",
    };
    const deps = fakeDeps({
      readMirror: vi.fn(async () => orphanMirror),
      updateItem: vi.fn(async () => {
        throw apiError("not_found", 404);
      }),
      createItem: vi.fn(async () => ({ ...ENTITY, id: "new_rec_2", version: 0, metadata: {} })),
      // The re-created record's own asset upload then fails — stranding the
      // fresh record this run just made.
      uploadFiles: vi.fn(async () => {
        throw apiError("bad_request", 400, { message: ["boom"] });
      }),
    });
    const item = { ...makeItem(), backendId: "cbwkbr9guqs3w11xylpri1ylw" };

    const res = await uploadItem(item, CTX, deps);

    // Note: `mapUploadError` (the sole constructor for an `"error"` outcome
    // reached via a throw) does not thread the accumulated `warnings` array
    // through, so the "recreated-orphaned" warning pushed inside
    // `recreateOrphaned` does not survive onto this failed result — a
    // pre-existing gap outside this fix's scope. `created`/`backendId` are
    // exactly what `removableBackendIds` acts on, and both are asserted below.
    expect(res.status).toBe("error");
    expect(res.backendId).toBe("new_rec_2");
    expect(res.created).toBe(true);
    expect(removableBackendIds([res])).toEqual(["new_rec_2"]);
  });
});
