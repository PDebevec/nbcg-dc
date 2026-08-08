import { describe, it, expect, vi } from "vitest";
import { ApiError } from "./api/client";
import { uploadItem, uploadBatch, type UploadDeps, type UploadItemContext } from "./upload";
import type { UploadFile } from "./api/files";
import { discoverAsset, type DiscoveredAsset } from "@domain/files";
import { emptyStages, type Item, type ItemStages, type StageName } from "@domain/item";
import type { ItemEntity, FileAttachment } from "./api/dto";
import type { RecordSchema } from "@domain/schema";
import type { LocalMetadataFile } from "@domain/metadata";
import { MAX_FILES_PER_REQUEST } from "@domain/upload";

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
  return {
    id: "item-1",
    folderName: "gorski",
    folderPath: "/p",
    root: "unprocessed",
    level: "main",
    assets: ASSETS,
    stages: stagesDone(),
    flags: { uploaded: false, reupload: false },
    backendId: null,
    batchId: "batch-1",
    title: "Gorski vijenac",
    catalogueId: null,
    createdAt: null,
    updatedAt: null,
    syncMissStreak: 0,
    ...overrides,
  };
}

const SCHEMA: RecordSchema = {
  fields: [
    { key: "title", type: "string", required: true, group: "basic", order: 0, parentInheritable: false, issueIdentifying: false, levels: ["main", "child"] },
    { key: "year", type: "string", required: false, group: "basic", order: 1, parentInheritable: false, issueIdentifying: false, levels: ["main", "child"] },
  ],
};

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
    resolveExistingBackendId: vi.fn(async () => null),
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

  it("recovers a create-409 by reusing the existing (deterministic) id and linking it", async () => {
    const deps = fakeDeps({
      createItem: vi.fn(async () => {
        throw apiError("conflict", 409);
      }),
      resolveExistingBackendId: vi.fn(async () => "rec_existing"),
    });
    const res = await uploadItem(makeItem({ catalogueId: "COBISS.123" }), CTX, deps);
    expect(res.status).toBe("duplicate");
    expect(res.backendId).toBe("rec_existing");
    expect(deps.recordUpload).toHaveBeenCalledWith("item-1", {
      backendId: "rec_existing",
      version: null,
      targetState: "RECORD",
      visibilityStatus: "PUBLIC",
    });
  });

  it("reports duplicate (no double-create) when the existing id can't be resolved", async () => {
    const deps = fakeDeps({
      createItem: vi.fn(async () => {
        throw apiError("conflict", 409);
      }),
      resolveExistingBackendId: vi.fn(async () => null),
    });
    const res = await uploadItem(makeItem(), CTX, deps);
    expect(res.status).toBe("duplicate");
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
          attachment(f.filename.replace(/[^ -]/g, "?"), {
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
        files.map((f) => attachment(f.filename.replace(/[^ -]/g, "?"))),
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
    return makeItem({ root: "processed", backendId: "rec_1", flags: { uploaded: true, reupload: true } });
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
      flags: { uploaded: true, reupload: true },
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
      flags: { uploaded: true, reupload: true },
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
    const item = makeItem({ root: "processed", backendId: "rec_1", flags: { uploaded: true, reupload: false } });
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
    const item = makeItem({ root: "processed", backendId: "rec_1", flags: { uploaded: true, reupload: false } });
    await uploadItem(item, { ...CTX, metadata: { title: "Old title", year: "2020" } }, deps);
    expect(deps.replaceFile).not.toHaveBeenCalled();
    expect(deps.uploadFiles).toHaveBeenCalledTimes(1); // the missing WEB pdf
    expect((deps.uploadFiles as any).mock.calls[0][1].map((f: any) => f.filename)).toEqual(["gorski.pdf"]);
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
