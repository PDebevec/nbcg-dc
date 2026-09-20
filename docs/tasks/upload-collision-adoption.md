# Upload collision adoption + batch lock audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a `409 Item with this COBISS ID already exists` end in a finished, archived batch on the first Upload — and prove no other upload outcome can soft- or hard-lock an item or a batch.

**Architecture:** On a create collision the archive **adopts** the existing backend record instead of giving up: it resolves the record's id locally (the backend's item id is a pure function of the COBISS id), reads the record's authoritative state with `GET /api/search/:id`, writes that state into the local mirror, and then continues down the ordinary **replace** path — PATCH only what the operator genuinely changed, push the derived files, link parents, move to `/processed`. The backend stays the single source of truth throughout: adoption *pulls* backend state down before it pushes anything, and never transitions or re-publishes a record the archive did not create.

**Tech Stack:** TypeScript (Vue 3 / Pinia lane), Vitest. **No Rust or Python changes anywhere in this plan.** Tasks 1–5 and 7 are pure `.ts`; Tasks 6 and 7 each end with a `.vue` half that belongs to the GUI owner.

**Spec:** This file. Grounded against the running backend at `~/nbcg` (WSL) and the live schema endpoint on 2026-09-20; every backend claim below cites the file it was read from.

## Global Constraints

- **The backend is the single source of truth.** Adoption reads backend state *before* writing. A PATCH carries only fields that differ from the backend's current values (`changedMetadata`, already implemented). Adoption never calls `POST /api/items/transition` and never overrides a pre-existing record's `visibilityStatus` — it adopts the backend's and warns when the batch disagrees.
- **Never double-create.** Every path that could create a record must first be certain no record exists at that id. Only an *authoritative* absence counts (see "Two kinds of 404" below).
- **No lane crossing.** Tasks 1–5 touch `.ts` only (Jernej's lane, `docs/04-code-structure.md` seam 1). Task 6 needs a `.vue` change and must be handed to the GUI owner.
- **Existing seams unchanged.** No new IPC command, no `src-tauri/` change, no `dto.rs` change. `UploadRecordDto.backendId` stays a non-null `String`.
- **Every task ends green:** `npx vue-tsc --noEmit` exits 0 and `npx vitest run` is fully green before the commit.
- Baseline at the time of writing: **775 tests passing, `vue-tsc` clean.**

---

## 1. Two kinds of 404 — the fact the whole design rests on

These are not interchangeable, and conflating them is how you either lock an item forever or double-create a record.

| Call | Reads | A 404 means |
|---|---|---|
| `GET /api/search/:id` | **OpenSearch**, fed asynchronously by the pgsync CDC daemon | "Not indexed **yet**, or gone, or a visibility miss." **Not authoritative.** |
| `PATCH /api/items/:id` | **Postgres**, directly (`items.service.ts:190-196` — `prisma.draft.findUnique` + `prisma.record.findUnique`) | "The row does not exist." **Authoritative.** |

`services/api/search.findById` already documents the first. The second is what makes orphan recovery (Task 5) safe: when a PATCH 404s, the record is genuinely gone and re-creating cannot collide.

## 2. Why the collision id can be computed locally

`backend/src/shared/util/generateUuidFromCobissId.ts`:

```ts
export function generateDeterministicId(cobissId: string): string {
  const hash = createHash('sha256').update(`cobiss:${cobissId}`).digest('hex');
  const base36 = BigInt('0x' + hash).toString(36);
  return ('c' + base36).substring(0, 25);
}
```

Two consequences, both verified against `backend/src/modules/items/items.service.ts:94-106`:

1. **A create `409` can only ever be a COBISS-id collision.** `items.service.create` only sets an explicit `id` when `sanitizedMetadata.cobissId` is present; without one the database generates the id, so no collision is possible. The archive therefore always holds the input (`item.catalogueId`) that produced the colliding id.
2. **The id is a pure function of that input.** No network call is needed to compute it. Today's `resolveExistingBackendId` calls `previewCobiss`, which blocks on a 30-second upstream fetch to `ws.cobiss.net` — so when COBISS is down, a perfectly recoverable local collision becomes unrecoverable (lock **L3** below).

The port is verified byte-for-byte against the backend's own implementation (Task 1 ships these as fixtures):

| `cobissId` | `generateDeterministicId` |
|---|---|
| `"12345"` | `cbwkbr9guqs3w11xylpri1ylw` |
| `"1024"` | `c29acqe7cabtjuh28m580qhzg` |
| `"77"` | `c364tkc05vg2amt5266ezbs1z` |

**The duplication is deliberate and it is guarded.** Re-implementing a backend derivation in the client is a coupling risk, so the resolver never trusts the computed id blindly: it fetches the record at that id and **adopts only if the fetched record's `metadata.cobissId` equals the item's `catalogueId`**. A drift in the backend's algorithm therefore degrades to "not resolved" (today's safe behaviour), never to "adopted the wrong record". The `previewCobiss` call is kept as a second-choice fallback for exactly that case.

---

## 3. The flow, exactly

### 3.1 Today

```
Upload
 └─ POST /api/items                       → 409 "Item with this COBISS ID already exists"
     └─ recoverCreateCollision
         ├─ previewCobiss(catalogueId)    → itemId          [30s upstream dependency]
         ├─ writeThrough { backendId, version: NULL }
         └─ return "duplicate"

  allUploaded = every(status === "uploaded")  → FALSE
  → batch NOT marked Uploaded, NOT archived, items stay in /unprocessed

Operator presses Upload again
 └─ uploadMode() === "replace" (backendId now set)
     └─ mirror.version == null
         └─ return "error": "Local sync state is missing this item's version — re-sync it (Sync)…"
```

Two round-trips through the Sync screen, a second error message with a different wording for the same cause, and a batch that cannot close.

### 3.2 After this plan

```
Upload
 └─ POST /api/items                              → 409
     └─ adoptExistingRecord(item, ctx, deps)
         ├─ id = await deterministicItemId(item.catalogueId)          [local, offline]
         ├─ hit = await findById(id)                                  [GET /api/search/:id]
         ├─ verify hit.source.metadata.cobissId === item.catalogueId
         │    └─ mismatch / null → fallback: previewCobiss → findById → verify
         ├─ version === null or unverified → return { kind: "unresolved" }   (degrade, §3.4)
         ├─ writeThrough {                       ← BACKEND STATE, pulled down first
         │     backendId:        hit.id,
         │     version:          hit.version,
         │     targetState:      hit.targetState,        ← backend's, NOT the batch's
         │     visibilityStatus: hit.visibilityStatus,   ← backend's, NOT the batch's
         │     metadata:         hit.metadata }          ← backend's, wholesale
         └─ return { kind: "adopted", mirror }
     └─ replaceOnBackend(item, ctx, plan, pruned, mirror, deps, { adopted: true })
         ├─ patchOnBackend  → changedMetadata(pruned, mirror.metadata)
         │                    • nothing changed        → NO PATCH, version untouched
         │                    • operator changed a field → PATCH { expectedVersion, metadata: <diff only> }
         ├─ pushReplaceAssets → the web PDF / thumbnail / OCR text
         ├─ connectParents   → idempotent server-side
         ├─ moveToProcessed  (item.root === "unprocessed")
         └─ return "uploaded" + warnings

  allUploaded → TRUE → stage = Uploaded → archive() → items released
```

One press. The batch closes.

### 3.3 What adoption deliberately does *not* do

These are the "backend is the source of truth" guarantees, enforced by `adopted: true`:

- **No transition.** `upload.ts` never calls `POST /api/items/transition` (verified — the only reference is in `services/api/items.ts`, uncalled from the upload path). An adopted `RECORD` stays a `RECORD` even if the batch says Draft. The mirror records the **backend's** `targetState`, and a warning tells the operator.
- **No visibility override.** `patchOnBackend` computes `visibilityChanged` from `mirror.visibilityStatus`. Because adoption writes the **backend's** visibility into the mirror first, and `replaceOnBackend` is told to use the adopted visibility as the effective one, an adopted record is never silently re-published or hidden. A warning is emitted when the batch's setting differs.
- **No metadata clobber.** The mirror holds the backend's complete metadata before any PATCH, so `changedMetadata(pruned, prevMeta)` diffs the operator's values against **the backend's real values**. Fields the operator never touched are not sent; `PATCH` shallow-merges, so backend-only fields survive untouched. If the operator changed nothing, no PATCH is issued at all.

The net effect: adoption **attaches this batch's derived files to the record that already exists**, and pushes metadata only where the operator deliberately differs.

### 3.4 When the record cannot be resolved

`findById` reads OpenSearch, so a record created seconds ago by another client may 409 the create while still being invisible to search (CDC lag). In that case `adoptExistingRecord` returns `{ kind: "unresolved" }` and the flow falls back to **exactly today's behaviour**: link what we can, return `duplicate`, tell the operator to Sync. That is a soft, self-clearing state — the next Sync supplies the version (`acceptRemoteVersion(null, n)` returns `true` for a local `null`), and the following Upload takes the ordinary replace path. It is a degradation, not a lock, and Task 6 guarantees the batch can still be closed.

---

## 4. Lock audit — every upload outcome

"Soft lock" = the operator can get out, but only via a non-obvious path. "Hard lock" = no path out from inside the app.

| # | Scenario | Today | After this plan |
|---|---|---|---|
| S1 | Create succeeds | `uploaded` → batch archives | unchanged |
| S2 | Create 409, record resolvable | **Soft lock.** `duplicate`; batch never closes; retry gives a *different* error; needs Sync → Upload | **Task 4.** Adopted → `uploaded` → batch archives, one press |
| S3 | Create 409, COBISS upstream down | **Soft lock.** `previewCobiss` fails → no link written → every retry 409s until COBISS returns | **Task 1+2.** Id computed locally; COBISS is no longer on the path |
| S4 | Create 409, record not yet in OpenSearch (CDC lag) | `duplicate`, version null | Degrades to S2-today (`unresolved`); Sync clears it. Not a lock; Task 6 still closes the batch |
| S5 | Replace, record deleted on the website (orphaned) | **HARD LOCK.** PATCH 404 → generic `error` forever. Nothing in the app clears `backendId`, and `uploadMode()` returns `"replace"` while it is set, so a re-create is unreachable. `FRONTEND-TODO §3B` confirms: "Orphaned badge … brez resolve akcije" | **Task 5.** PATCH 404 is authoritative → re-create; a COBISS item lands back on the same deterministic id |
| S6 | Replace, version stale (`409 Version conflict`) | `error` "refresh and retry" → Sync → Upload. Recoverable | unchanged (correct as-is) |
| S7 | Replace, mirror version null | `error` "re-sync before re-uploading" → Sync. Recoverable | No longer reachable from S2. Still reachable after an index rebuild; Sync clears it |
| S8 | Created, then assets failed mid-flight | `error`, but `backendId`+`version` were persisted first, so a retry replaces and never double-creates | unchanged (already correct — the comment at `upload.ts:466` explains why) |
| S9 | `blocked` — a hard gate (`not-processed`, `thumbnail-unresolved`, `metadata-invalid`, `processing-failed`, `no-assets`) | Operator fixes the gate and re-uploads | unchanged (correct) |
| S10 | `401` / `403` | Fixed 2026-09-20: `401` → `unauthenticated` ("check Settings"), `403` → `forbidden` ("account lacks scope") | unchanged |
| S11 | Mixed batch — some items uploaded, some not | Batch stays open. Re-upload re-PATCHes the successful ones; `changedMetadata` makes that a no-op, so no spurious version bump | unchanged + Task 6 |
| S12 | Crash mid-run | `reconcileCrashedRuns` on first `useBatches.load()` resets a batch left `running` | unchanged (correct) |
| S13 | Batch archived, item needs editing later | `archive()` releases members; they form a new re-work batch that opens read-only until explicit unlock (`requiresUnlock`) | unchanged (correct) |
| S14 | An item is legitimately un-uploadable and the operator accepts it | **Soft lock.** `batches.archive()` exists but **no UI calls it** — the only call site is the automatic one in `useUpload.ts:94`. The batch stays "In progress" forever | **Task 6.** Explicit "Close batch" action |

After Tasks 1–6 there is no hard lock, and the only soft state (S4) clears itself on the next Sync.

---

## 5. File structure

**Create**
- `src/services/api/deterministicId.ts` — the backend's item-id derivation, ported and fixture-tested. Lives in `services/api/` because it encodes a backend wire contract, same as `dto.ts`. Not in `domain/` — that lane is sync and dependency-free, and this needs `crypto.subtle`, which is async.
- `src/services/api/deterministicId.test.ts`

**Modify**
- `src/services/api/search.ts` — move `hitToRemote` here from `services/sync.ts` (it projects a `SearchHit`, which is this module's type). Lets `upload.ts` reuse it without depending on `sync.ts`.
- `src/services/sync.ts` — import `hitToRemote` from `./api/search` instead of defining it.
- `src/services/upload.ts` — the bulk: `ExistingRecord`, `resolveExistingRecord` dep, `replaceOnBackend` extraction, `adoptExistingRecord`, orphan recovery.
- `src/services/upload.test.ts`
- `src/stores/useUpload.ts` — Task 6 close-batch action, Task 7 scoped cleanup.
- `src/composables/useProcessing.ts` — Tasks 6–7: `showClose`, `closeBatch`, `closableSummary`.
- `src/views/batch/ProcessingTab.vue` — Tasks 6–7 button + confirm dialog (**GUI lane**).
- `docs/tasks/07-upload-and-publish.md`, `docs/OUTSTANDING.md`, `docs/02-architecture.md` — Task 8.

---

## Task 1: The deterministic id

**Files:**
- Create: `src/services/api/deterministicId.ts`
- Test: `src/services/api/deterministicId.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `deterministicItemId(cobissId: string): Promise<string>`

- [ ] **Step 1: Write the failing test**

`src/services/api/deterministicId.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deterministicItemId } from "./deterministicId";

describe("deterministicItemId", () => {
  // Fixtures generated by running the backend's OWN generateDeterministicId
  // (backend/src/shared/util/generateUuidFromCobissId.ts) under node on
  // 2026-09-20. If one of these ever fails, the backend changed its id
  // derivation and `resolveExistingRecord`'s fast path is stale — the
  // cobissId verification there means that degrades safely, but fix it.
  it.each([
    ["12345", "cbwkbr9guqs3w11xylpri1ylw"],
    ["1024", "c29acqe7cabtjuh28m580qhzg"],
    ["77", "c364tkc05vg2amt5266ezbs1z"],
  ])("matches the backend for %s", async (cobissId, expected) => {
    expect(await deterministicItemId(cobissId)).toBe(expected);
  });

  it("is always 25 characters and 'c'-prefixed", async () => {
    const id = await deterministicItemId("999999");
    expect(id).toHaveLength(25);
    expect(id.startsWith("c")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/services/api/deterministicId.test.ts`
Expected: FAIL — `Failed to resolve import "./deterministicId"`.

- [ ] **Step 3: Write the implementation**

`src/services/api/deterministicId.ts`:

```ts
/**
 * The backend's item-id derivation, ported.
 *
 * `POST /api/items` sets an explicit id — and can therefore collide with a
 * `409` — only when the metadata carries a `cobissId`
 * (`backend/src/modules/items/items.service.ts:94-106`). That id is a pure
 * function of the COBISS id
 * (`backend/src/shared/util/generateUuidFromCobissId.ts`):
 *
 * ```ts
 * const hash = createHash('sha256').update(`cobiss:${cobissId}`).digest('hex');
 * const base36 = BigInt('0x' + hash).toString(36);
 * return ('c' + base36).substring(0, 25);
 * ```
 *
 * Computing it here rather than asking the backend is what keeps collision
 * recovery working when COBISS itself is down: the alternative,
 * `previewCobiss`, blocks on a 30-second upstream fetch to `ws.cobiss.net`.
 *
 * This duplicates a backend invariant, which is a real coupling risk, so no
 * caller may trust the result blindly. `upload.resolveExistingRecord` reads
 * the record back and adopts it only when its `metadata.cobissId` matches the
 * item's `catalogueId`, so a drift in the backend's algorithm degrades to
 * "not resolved" instead of "adopted the wrong record".
 *
 * Async because `crypto.subtle.digest` is — which is also why this lives in
 * `services/`, not the sync, dependency-free `domain/` lane.
 */
export async function deterministicItemId(cobissId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`cobiss:${cobissId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const base36 = BigInt("0x" + hex).toString(36);
  return ("c" + base36).substring(0, 25);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/services/api/deterministicId.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/api/deterministicId.ts src/services/api/deterministicId.test.ts
git commit -m "Port the backend's deterministic COBISS item id"
```

---

## Task 2: Resolve the existing record

**Files:**
- Modify: `src/services/api/search.ts` (move `hitToRemote` in)
- Modify: `src/services/sync.ts` (import it from there)
- Modify: `src/services/upload.ts` (`ExistingRecord`, `resolveExistingRecord`)
- Test: `src/services/upload.test.ts`

**Interfaces:**
- Consumes: `deterministicItemId` (Task 1); `findById` and `hitToRemote` from `services/api/search`.
- Produces:
  - `export interface ExistingRecord { id: string; version: number; targetState: ItemType; visibilityStatus: VisibilityStatus | null; metadata: RecordMetadata; }`
  - `UploadDeps.resolveExistingRecord: (item: Item) => Promise<ExistingRecord | null>` — **replaces** `resolveExistingBackendId`, which is deleted.

- [ ] **Step 1: Move `hitToRemote` to `services/api/search.ts`**

Cut the `hitToRemote` function and the `RemoteRecord` import from `src/services/sync.ts` and paste the function into `src/services/api/search.ts`, exported. It projects a `SearchHit` — this module's own type — so it belongs here, and `upload.ts` can now use it without depending on `sync.ts`. In `src/services/sync.ts`, add it to the existing `./api/search` import and delete the local definition. `RemoteRecord` stays in `domain/sync`.

- [ ] **Step 2: Run the suite to confirm the move is behaviour-neutral**

Run: `npx vue-tsc --noEmit && npx vitest run`
Expected: `tsc` exit 0, all green (775).

- [ ] **Step 3: Commit the move on its own**

```bash
git add src/services/api/search.ts src/services/sync.ts
git commit -m "Move hitToRemote to services/api/search, next to SearchHit"
```

- [ ] **Step 4: Write the failing test for the resolver**

Append to the `uploadItem` describe block in `src/services/upload.test.ts`:

```ts
describe("resolveExistingRecord (default dep)", () => {
  it("adopts a record whose cobissId matches the item's", async () => {
    const hit = {
      id: "cbwkbr9guqs3w11xylpri1ylw",
      index: "records",
      source: {
        version: 7,
        visibilityStatus: "PUBLIC",
        metadata: { cobissId: "12345", title: "Existing" },
      },
    };
    const found = await resolveExistingRecordWith(
      { ...makeItem(), catalogueId: "12345" },
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
    const hit = {
      id: "cbwkbr9guqs3w11xylpri1ylw",
      index: "records",
      source: { version: 7, visibilityStatus: "PUBLIC", metadata: { cobissId: "999" } },
    };
    const found = await resolveExistingRecordWith(
      { ...makeItem(), catalogueId: "12345" },
      { findById: vi.fn(async () => hit), previewCobiss: vi.fn(async () => ({ itemId: null })) },
    );
    expect(found).toBeNull();
  });

  it("refuses a hit with no version (nothing to do optimistic concurrency with)", async () => {
    const hit = {
      id: "cbwkbr9guqs3w11xylpri1ylw",
      index: "records",
      source: { visibilityStatus: "PUBLIC", metadata: { cobissId: "12345" } },
    };
    const found = await resolveExistingRecordWith(
      { ...makeItem(), catalogueId: "12345" },
      { findById: vi.fn(async () => hit), previewCobiss: vi.fn(async () => ({ itemId: null })) },
    );
    expect(found).toBeNull();
  });

  it("returns null without any network call when the item has no catalogueId", async () => {
    const findById = vi.fn();
    const found = await resolveExistingRecordWith(
      { ...makeItem(), catalogueId: null },
      { findById, previewCobiss: vi.fn() },
    );
    expect(found).toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run src/services/upload.test.ts -t resolveExistingRecord`
Expected: FAIL — `resolveExistingRecordWith is not defined`.

- [ ] **Step 6: Implement**

In `src/services/upload.ts`, delete `resolveExistingBackendId` from `UploadDeps` and from `defaultDeps()`, and add:

```ts
/** A backend record that already exists at the id this item would have created.
 * `version` is non-null by construction — a record we cannot do optimistic
 * concurrency against is not adoptable, so the resolver returns null instead. */
export interface ExistingRecord {
  id: string;
  version: number;
  targetState: ItemType;
  visibilityStatus: VisibilityStatus | null;
  metadata: RecordMetadata;
}

/** The two reads `resolveExistingRecordWith` needs, injectable for tests. */
export interface ResolveExistingDeps {
  findById: (id: string) => Promise<SearchHit | null>;
  previewCobiss: (cobissId: string) => Promise<{ itemId?: string | null }>;
}

/** Project a search hit into an {@link ExistingRecord}, but ONLY if it really is
 * this item's record. See `services/api/deterministicId` for why the check is
 * not optional. */
function hitToExisting(
  hit: SearchHit | null,
  expectCobissId: string,
): ExistingRecord | null {
  if (!hit) return null;
  const remote = hitToRemote(hit);
  if (remote.version === null) return null;
  if (remote.targetState === null) return null;
  const cobissId = (remote.metadata as { cobissId?: unknown }).cobissId;
  if (cobissId !== expectCobissId) return null;
  return {
    id: remote.id,
    version: remote.version,
    targetState: remote.targetState,
    visibilityStatus: remote.visibilityStatus,
    metadata: remote.metadata,
  };
}

/**
 * Find the record a create-`409` collided with.
 *
 * Fast path: compute the id locally and read it back. Offline-capable and
 * instant. Fallback: ask the backend what id it would use, which costs a
 * COBISS upstream round-trip — used only when the fast path does not verify,
 * i.e. when the backend's derivation has drifted from our port.
 *
 * `null` is a legitimate answer (CDC lag, or a genuinely unresolvable id) and
 * the caller degrades to a `duplicate` outcome rather than failing.
 */
export async function resolveExistingRecordWith(
  item: Item,
  deps: ResolveExistingDeps,
): Promise<ExistingRecord | null> {
  const cobissId = item.catalogueId;
  if (!cobissId) return null;

  const computed = await deterministicItemId(cobissId).catch(() => null);
  if (computed) {
    const hit = await deps.findById(computed).catch(() => null);
    const found = hitToExisting(hit, cobissId);
    if (found) return found;
  }

  const previewed = await deps
    .previewCobiss(cobissId)
    .then((p) => p.itemId ?? null)
    .catch(() => null);
  if (!previewed || previewed === computed) return null;

  const hit = await deps.findById(previewed).catch(() => null);
  return hitToExisting(hit, cobissId);
}
```

Then in `UploadDeps` add `resolveExistingRecord: (item: Item) => Promise<ExistingRecord | null>;` and in `defaultDeps()`:

```ts
resolveExistingRecord: (item) =>
  resolveExistingRecordWith(item, {
    findById: (id) => findById(id),
    previewCobiss: (cobissId) => previewCobiss(cobissId),
  }),
```

Add the imports: `deterministicItemId` from `./api/deterministicId`, `findById` and `hitToRemote` and the `SearchHit` type from `./api/search`.

`recoverCreateCollision` still calls the old dep — point it at `deps.resolveExistingRecord(item)` and read `.id` off the result for now, so the suite stays green. Task 4 replaces it wholesale.

- [ ] **Step 7: Run the tests**

Run: `npx vue-tsc --noEmit && npx vitest run`
Expected: `tsc` exit 0, all green (779).

- [ ] **Step 8: Commit**

```bash
git add src/services/upload.ts src/services/upload.test.ts
git commit -m "Resolve a create-collision's record locally, verified by cobissId"
```

---

## Task 3: Extract the replace path (pure refactor, no behaviour change)

Adoption has to *continue into* the replace path, which today is an `else` branch inside `uploadItem` and is unreachable from the create branch. Extracting it is a prerequisite and is worth its own review gate precisely because it must change nothing.

**Files:**
- Modify: `src/services/upload.ts` (`uploadItem`, roughly lines 455–540)

**Interfaces:**
- Consumes: `patchOnBackend`, `pushReplaceAssets`, `connectParents`, `applyParentStates`, `writeThrough`, `textQualityWarnings` (all already private to the module).
- Produces:
  ```ts
  async function replaceOnBackend(
    item: Item,
    ctx: UploadItemContext,
    plan: ItemUploadPlan,
    pruned: RecordMetadataInput,
    mirror: LocalMetadataFile,
    deps: UploadDeps,
    warnings: UploadWarning[],
  ): Promise<ItemUploadResult>
  ```

- [ ] **Step 1: Extract, changing nothing**

Move the body of the `else` branch of `uploadItem` — from `backendId = plan.backendId as string;` through the `return result(item.id, "uploaded", …)` — into `replaceOnBackend`, including the mirror/version guard, the PATCH, the asset push, `connectParents`, `applyParentStates`, and the `moveToProcessed` step. Call it from the `else` branch: `return replaceOnBackend(item, ctx, plan, pruned, mirror, deps, warnings);`.

Keep the `mirror.version == null` guard inside `replaceOnBackend` for now — Task 4 relies on it being unreachable after adoption rather than on it being gone.

- [ ] **Step 2: Run the suite — the refactor must be invisible**

Run: `npx vue-tsc --noEmit && npx vitest run`
Expected: `tsc` exit 0, all green (779). **No test file may be edited in this task.** If a test needs changing, the extraction changed behaviour — revert and redo it.

- [ ] **Step 3: Commit**

```bash
git add src/services/upload.ts
git commit -m "Extract replaceOnBackend from uploadItem (no behaviour change)"
```

---

## Task 4: Adopt on collision and finish the upload

**Files:**
- Modify: `src/services/upload.ts`
- Test: `src/services/upload.test.ts`

**Interfaces:**
- Consumes: `resolveExistingRecord` (Task 2), `replaceOnBackend` (Task 3).
- Produces: `adoptExistingRecord` (module-private); a new `UploadWarningCode` member `"adopted-existing"`; `recoverCreateCollision` is deleted.

- [ ] **Step 1: Write the failing tests**

```ts
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
    const [, body] = updateItem.mock.calls[0];
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
    const deps = fakeDeps({
      createItem: vi.fn(async () => conflict()),
      resolveExistingRecord: vi.fn(async () => existing),
      updateItem: vi.fn(async () => ({ version: 8 })),
      recordUpload,
    });
    // The batch says DRAFT/PRIVATE; the live record is RECORD/PUBLIC.
    const res = await uploadItem(
      makeItem(),
      { ...CTX, targetState: "DRAFT", visibility: "PRIVATE" },
      deps,
    );

    const [, dto] = recordUpload.mock.calls[0];
    expect(dto.targetState).toBe("RECORD");
    expect(dto.visibilityStatus).toBe("PUBLIC");
    expect(res.warnings.some((w) => w.code === "adopted-existing")).toBe(true);
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/services/upload.test.ts -t "create collision"`
Expected: FAIL — `resolveExistingRecord` is not a known dep override / status is `"duplicate"` not `"uploaded"`.

- [ ] **Step 3: Implement**

Add to `UploadWarningCode` in `src/domain/upload.ts`:

```ts
  /** The create collided with an existing record, which this upload adopted
   * instead of creating a second one. The batch's publish/visibility settings
   * were NOT applied — the backend's own remain authoritative. */
  | "adopted-existing"
```

Replace `recoverCreateCollision` in `src/services/upload.ts` with:

```ts
/**
 * Adopt the record a create-`409` collided with.
 *
 * Pulls the backend's authoritative state down into the mirror FIRST — id,
 * version, targetState, visibilityStatus and the complete metadata — so that
 * the replace path which follows diffs the operator's values against what the
 * backend really holds, and sends only genuine changes. This is what keeps the
 * backend the single source of truth through a path that ends in a write.
 *
 * The batch's own `targetState`/`visibilityStatus` are deliberately NOT
 * applied: the archive did not create this record and must not silently
 * re-publish or hide one somebody else curated. The caller warns instead.
 *
 * `null` when the record could not be resolved (CDC lag, or a drifted id
 * derivation) — the caller then degrades to today's `duplicate` outcome.
 */
async function adoptExistingRecord(
  item: Item,
  deps: UploadDeps,
): Promise<LocalMetadataFile | null> {
  const existing = await deps.resolveExistingRecord(item).catch(() => null);
  if (!existing) return null;

  const mirror: LocalMetadataFile = {
    backendId: existing.id,
    version: existing.version,
    targetState: existing.targetState,
    visibilityStatus: existing.visibilityStatus,
    metadata: existing.metadata,
    syncedAt: deps.now(),
  };
  await writeThrough(item, deps, {
    backendId: existing.id,
    version: existing.version,
    targetState: existing.targetState,
    visibility: existing.visibilityStatus ?? "PRIVATE",
    metadata: existing.metadata,
  });
  return mirror;
}
```

In `uploadItem`'s create branch, replace the `catch`:

```ts
} catch (err) {
  if (!(err instanceof ApiError) || err.kind !== "conflict") throw err;

  const adopted = await adoptExistingRecord(item, deps);
  if (!adopted) {
    return result(item.id, "duplicate", {
      backendId: null,
      message:
        "Already on the backend, but its current state could not be read — run Sync, then upload again.",
    });
  }

  if (
    adopted.targetState !== ctx.targetState ||
    adopted.visibilityStatus !== ctx.visibility
  ) {
    warnings.push({
      code: "adopted-existing",
      message: `Adopted the existing ${adopted.targetState} on the backend; this batch's publish and visibility settings were not applied to it.`,
    });
  } else {
    warnings.push({
      code: "adopted-existing",
      message: "Adopted the record that already existed on the backend.",
    });
  }

  const adoptedCtx: UploadItemContext = {
    ...ctx,
    targetState: adopted.targetState ?? ctx.targetState,
    visibility: adopted.visibilityStatus ?? ctx.visibility,
  };
  // `mode` flips too: the plan was assembled as a create, and leaving it
  // saying "create" would mislead anyone reading the plan downstream even
  // though `replaceOnBackend` only reads `backendId`.
  const adoptedPlan: ItemUploadPlan = {
    ...plan,
    mode: "replace",
    backendId: adopted.backendId,
  };
  return replaceOnBackend(item, adoptedCtx, adoptedPlan, pruned, adopted, deps, warnings);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vue-tsc --noEmit && npx vitest run`
Expected: `tsc` exit 0, all green (784).

- [ ] **Step 5: Commit**

```bash
git add src/domain/upload.ts src/services/upload.ts src/services/upload.test.ts
git commit -m "Adopt the colliding record and finish the upload in one run"
```

---

## Task 5: Orphan recovery — unlock S5

**Files:**
- Modify: `src/services/upload.ts` (`replaceOnBackend`)
- Test: `src/services/upload.test.ts`

**Interfaces:**
- Consumes: `replaceOnBackend` (Task 3), `createItem`/`uploadCreateAssets` (existing).
- Produces: no new exports; `replaceOnBackend` gains a `not_found` branch.

- [ ] **Step 1: Write the failing test**

```ts
describe("orphan recovery", () => {
  it("re-creates when the backend says the record is gone", async () => {
    // A PATCH 404 reads Postgres directly (items.service.ts:190-196), unlike a
    // search 404 which is CDC-lagged. So it is authoritative: the row is gone
    // and re-creating cannot double-create.
    const createItem = vi.fn(async () => ({
      id: "cbwkbr9guqs3w11xylpri1ylw",
      version: 0,
      metadata: {},
    }));
    const deps = fakeDeps({
      readMirror: vi.fn(async () => ({
        backendId: "cbwkbr9guqs3w11xylpri1ylw",
        version: 3,
        targetState: "RECORD",
        visibilityStatus: "PUBLIC",
        metadata: {},
        syncedAt: "2026-09-20T00:00:00.000Z",
      })),
      updateItem: vi.fn(async () => { throw apiError("not_found", 404); }),
      createItem,
    });
    const item = { ...makeItem(), backendId: "cbwkbr9guqs3w11xylpri1ylw" };

    const res = await uploadItem(item, CTX, deps);

    expect(createItem).toHaveBeenCalledTimes(1);
    expect(res.status).toBe("uploaded");
  });

  it("does NOT re-create on a 409 — that record still exists", async () => {
    const createItem = vi.fn();
    const deps = fakeDeps({
      readMirror: vi.fn(async () => ({
        backendId: "cbwkbr9guqs3w11xylpri1ylw",
        version: 3,
        targetState: "RECORD",
        visibilityStatus: "PUBLIC",
        metadata: {},
        syncedAt: "2026-09-20T00:00:00.000Z",
      })),
      updateItem: vi.fn(async () => { throw apiError("conflict", 409); }),
      createItem,
    });
    const item = { ...makeItem(), backendId: "cbwkbr9guqs3w11xylpri1ylw" };

    const res = await uploadItem(item, CTX, deps);

    expect(createItem).not.toHaveBeenCalled();
    expect(res.status).toBe("error");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/services/upload.test.ts -t "orphan recovery"`
Expected: FAIL — first test gets `status: "error"` and `createItem` was never called.

- [ ] **Step 3: Implement**

Wrap the `patchOnBackend` call inside `replaceOnBackend`:

```ts
let version: number;
try {
  version = await patchOnBackend(item, backendId, pruned, ctx, mirror, deps);
} catch (err) {
  // A PATCH 404 comes from Postgres, not the CDC-lagged search index
  // (backend items.service.ts:190-196), so it is authoritative: the record
  // really is gone — deleted on the website after we linked to it. Without
  // this branch the item is permanently stuck, because `uploadMode()` returns
  // "replace" for as long as `backendId` is set and nothing ever clears it.
  //
  // Re-creating is safe precisely because the absence is authoritative. For a
  // COBISS item the backend regenerates the SAME deterministic id, so the
  // local link stays valid; for a non-COBISS item it mints a new one and
  // `writeThrough` records it.
  if (err instanceof ApiError && err.kind === "not_found") {
    return recreateOrphaned(item, ctx, plan, pruned, deps, warnings);
  }
  throw err;
}
```

And add, next to `adoptExistingRecord`:

```ts
/** Re-create a record the backend has authoritatively lost, then finish the
 * upload as a create (assets, parents, move). See the caller for why this
 * cannot double-create. */
async function recreateOrphaned(
  item: Item,
  ctx: UploadItemContext,
  plan: ItemUploadPlan,
  pruned: RecordMetadataInput,
  deps: UploadDeps,
  warnings: UploadWarning[],
): Promise<ItemUploadResult> {
  warnings.push({
    code: "adopted-existing",
    message:
      "The linked record no longer exists on the backend — it was re-created from the local copy.",
  });
  const created = await withRetry(
    () => deps.createItem({
      targetState: ctx.targetState,
      visibilityStatus: ctx.visibility,
      metadata: pruned,
    }, {}),
    deps,
  );
  await writeThrough(item, deps, {
    backendId: created.id,
    version: created.version,
    targetState: ctx.targetState,
    visibility: ctx.visibility,
    metadata: created.metadata,
  });
  const attachments = await uploadCreateAssets(created.id, { ...plan, backendId: created.id }, deps, warnings);
  warnings.push(...textQualityWarnings(attachments));
  const { errors: relationErrors, states } = await connectParents(created.id, ctx.parentIds, deps);
  await applyParentStates(states, deps);
  if (item.root === "unprocessed") {
    try { await deps.moveToProcessed(item); }
    catch (err) { logger.warn("upload", `Re-created ${item.id} but failed to move it.`, err); }
  }
  return result(item.id, "uploaded", { backendId: created.id, warnings, relationErrors });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vue-tsc --noEmit && npx vitest run`
Expected: `tsc` exit 0, all green (786).

- [ ] **Step 5: Commit**

```bash
git add src/services/upload.ts src/services/upload.test.ts
git commit -m "Re-create a record the backend has authoritatively lost"
```

---

## Task 6: "Close batch" escape hatch — unlock S14 (**cross-lane**)

> **Lane note:** the store change is `.ts`; the button is `.vue` and belongs to the GUI owner (`docs/04-code-structure.md` seam 1). Do not write the `.vue` half without them.

**Files:**
- Modify: `src/stores/useUpload.ts` (expose `closeBatch`)
- Modify: `src/composables/useProcessing.ts` (`showClose`, `closeBatch`)
- Modify: `src/views/batch/ProcessingTab.vue` (**GUI lane** — the button + confirm)
- Test: `src/stores/useUpload.test.ts`

**Interfaces:**
- Produces: `useUploadStore.closeBatch(batchId: string): Promise<void>`; `useProcessing().showClose: ComputedRef<boolean>`, `useProcessing().closeBatch(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
it("closeBatch archives a batch that did not fully upload", async () => {
  // S14: without this, a batch containing any non-uploaded item stays "In
  // progress" forever — archive() exists but nothing in the UI reaches it.
  const store = useUploadStore();
  const batches = useBatchesStore();
  const archive = vi.spyOn(batches, "archive").mockResolvedValue({} as never);
  const update = vi.spyOn(batches, "update").mockResolvedValue({} as never);

  await store.closeBatch("b1");

  expect(update).toHaveBeenCalledWith(expect.objectContaining({ stage: BatchStage.Uploaded }));
  expect(archive).toHaveBeenCalledWith("b1");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/stores/useUpload.test.ts -t closeBatch`
Expected: FAIL — `store.closeBatch is not a function`.

- [ ] **Step 3: Implement the store half**

In `src/stores/useUpload.ts`, extract the archive block from `run()` into a shared function and export it:

```ts
/**
 * Mark a batch finished and archive it, regardless of whether every item
 * uploaded.
 *
 * `run()` calls this automatically on an all-`uploaded` outcome. It is exposed
 * so the operator can also close a batch they have decided is done — an item
 * that legitimately cannot upload (duplicate that only needs a Sync, a blocked
 * folder they will redo later) would otherwise pin the batch "In progress"
 * with no way out, since this is the only archive call site in the app.
 */
async function closeBatch(batchId: string): Promise<void> {
  const batches = useBatchesStore();
  const batch = batches.get(batchId);
  if (batch) {
    try { await batches.update({ ...batch, stage: BatchStage.Uploaded }); }
    catch (err) { logger.warn("upload", "Couldn't mark the batch uploaded.", err); }
  }
  try { await batches.archive(batchId); }
  catch (err) {
    logger.error("upload", "Couldn't archive the batch.", err);
    error.value = "The batch could not be archived.";
  }
}
```

Call it from `run()` where the inline block was, and add `closeBatch` to the store's return object.

In `src/composables/useProcessing.ts` add:

```ts
/** Offer an explicit close once an upload has been attempted and left the
 * batch open — never before, so it cannot be mistaken for "upload". */
const showClose = computed(
  () => editable.value && !running.value && !uploading.value && !uploaded.value
    && uploadStore.resultsFor(batch.value?.id ?? "").size > 0,
);

async function closeBatch(): Promise<void> {
  const b = batch.value;
  if (!b) return;
  await uploadStore.closeBatch(b.id);
  toasts.push("Batch closed.", "success");
}
```

and add both to the returned object.

- [ ] **Step 4: Run the tests**

Run: `npx vue-tsc --noEmit && npx vitest run`
Expected: `tsc` exit 0, all green (787).

- [ ] **Step 5: Commit the store half**

```bash
git add src/stores/useUpload.ts src/stores/useUpload.test.ts src/composables/useProcessing.ts
git commit -m "Let the operator close a batch that did not fully upload"
```

- [ ] **Step 6: Hand the `.vue` half to the GUI owner**

The button belongs next to "Rerun all failed" in `ProcessingTab.vue`, bound to `showClose` / `closeBatch()`, styled as `btn-outline` (not primary — it is a deliberate, irreversible act: archived batches have no unlock, `requiresUnlock` returns false for them). It must confirm first, naming how many items did not upload, and offering the Task 7 cleanup choice.

---

## Task 7: Clean up what the batch left half-made

A batch closed with an incomplete item can leave a **record on the live website carrying metadata and no files** — `createItem` succeeded, the asset upload did not, and the link was persisted first on purpose (`upload.ts:466`) so a retry would replace rather than double-create. Closing the batch at that point strands it.

### What may and may not be removed

| | Removable? | Why |
|---|---|---|
| Backend record **this batch created**, never reached `uploaded` | **Yes** | The archive made it, nobody has curated it, and it is incomplete |
| Backend record this batch **adopted** (`"adopted-existing"` warning) | **Never** | It existed before the batch. It may be a librarian's curated record. Deleting it destroys third-party data |
| Item that reached `uploaded` in a mixed batch | **Never** | Legitimately published. The operator is closing because of a *different* item |
| Local **source scans** (`*.jpg`/`*.tif`) | **Never** | The library's irreplaceable material. The archive does not own it — and note there is **no `fs_delete*` command in `src-tauri`**, by design |
| Local **derived files** (`*.pdf`, `*_thumb.png`, `*.txt`) | **Never** | Hours of OCR compute, and exactly what a later retry needs |
| Local `metadata.json` mirror | **Never** | Leave the dead link in place — Task 5 turns the next upload's authoritative 404 into a clean re-create. Clearing it would need a `dto.rs` change (`UploadRecordDto.backend_id` is a non-null `String`), which this plan deliberately avoids |

**No persistence needed.** `showClose` already requires `uploadStore.resultsFor(batchId).size > 0`, i.e. an upload was attempted **in this session**, so the per-item outcomes are still in memory. Cleanup reads them and needs no new field on the mirror or the index — which is what keeps this task inside the `.ts` lane.

**Hard delete is acceptable here, narrowly.** `DELETE /api/items` is all-or-nothing (`PROJECT-KNOWLEDGE` §"DELETE /api/items": a `404` on any id deletes nothing), so the caller must send only ids it is confident exist, one request, and treat failure as non-fatal. The open relations-integrity P3 (`docs/tasks/09`) barely applies: `connectParents` runs *after* the asset upload, so an item that failed at assets has no relations at all — and the endpoint removes relations before deleting anyway.

**Files:**
- Modify: `src/stores/useUpload.ts` (`closeBatch` gains a `cleanup` flag)
- Modify: `src/composables/useProcessing.ts` (`closableSummary`)
- Test: `src/stores/useUpload.test.ts`

**Interfaces:**
- Consumes: `deleteItems` from `services/api/items`; `ItemUploadResult` (Task 4).
- Produces: `closeBatch(batchId: string, options?: { cleanup?: boolean }): Promise<void>`; `useProcessing().closableSummary: ComputedRef<{ total: number; removable: string[] }>`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("closeBatch cleanup", () => {
  const results = [
    { itemId: "i1", status: "uploaded", backendId: "b1", warnings: [] },
    // created, then the asset upload failed — a record with no files
    { itemId: "i2", status: "error", backendId: "b2", warnings: [] },
    // adopted someone else's existing record
    { itemId: "i3", status: "error", backendId: "b3",
      warnings: [{ code: "adopted-existing", message: "" }] },
    // never reached the backend at all
    { itemId: "i4", status: "blocked", backendId: null, warnings: [] },
  ];

  it("deletes ONLY records this batch created and did not finish", async () => {
    const store = useUploadStore();
    for (const r of results) store.setResult("b", r as never);
    const del = vi.spyOn(itemsApi, "deleteItems").mockResolvedValue();

    await store.closeBatch("b", { cleanup: true });

    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(["b2"]);
  });

  it("never deletes an adopted record, even when the item failed", async () => {
    const store = useUploadStore();
    store.setResult("b", results[2] as never);
    const del = vi.spyOn(itemsApi, "deleteItems").mockResolvedValue();

    await store.closeBatch("b", { cleanup: true });

    expect(del).not.toHaveBeenCalled();
  });

  it("deletes nothing when cleanup is not asked for", async () => {
    const store = useUploadStore();
    for (const r of results) store.setResult("b", r as never);
    const del = vi.spyOn(itemsApi, "deleteItems").mockResolvedValue();

    await store.closeBatch("b");

    expect(del).not.toHaveBeenCalled();
  });

  it("still archives when the delete call fails", async () => {
    // Cleanup is best-effort. A batch the operator asked to close must close.
    const store = useUploadStore();
    store.setResult("b", results[1] as never);
    vi.spyOn(itemsApi, "deleteItems").mockRejectedValue(new Error("boom"));
    const archive = vi.spyOn(useBatchesStore(), "archive").mockResolvedValue({} as never);

    await store.closeBatch("b", { cleanup: true });

    expect(archive).toHaveBeenCalledWith("b");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/stores/useUpload.test.ts -t "closeBatch cleanup"`
Expected: FAIL — `closeBatch` takes one argument and never calls `deleteItems`.

- [ ] **Step 3: Implement**

In `src/stores/useUpload.ts`:

```ts
/**
 * Backend ids this batch CREATED and did not finish — the only records a
 * close may remove.
 *
 * Three exclusions, each load-bearing:
 *  - `uploaded` items are legitimately published; in a mixed batch the
 *    operator is closing because of some *other* item.
 *  - an `"adopted-existing"` warning means the record pre-dated this batch
 *    (see `adoptExistingRecord`). It may be a librarian's own record —
 *    deleting it would destroy third-party data.
 *  - no `backendId` means nothing was ever created.
 */
function removableBackendIds(batchId: string): string[] {
  const out: string[] = [];
  for (const r of resultsFor(batchId).values()) {
    if (r.status === "uploaded") continue;
    if (!r.backendId) continue;
    if (r.warnings.some((w) => w.code === "adopted-existing")) continue;
    out.push(r.backendId);
  }
  return out;
}
```

and extend `closeBatch`:

```ts
async function closeBatch(
  batchId: string,
  options: { cleanup?: boolean } = {},
): Promise<void> {
  if (options.cleanup) {
    const ids = removableBackendIds(batchId);
    if (ids.length > 0) {
      // One request: `DELETE /api/items` is all-or-nothing, so a 404 on any id
      // deletes nothing. Best-effort — a failed cleanup must not stop the
      // close the operator asked for. The local link is left alone on purpose:
      // the next upload's authoritative 404 re-creates the record (Task 5).
      try {
        await deleteItems(ids);
      } catch (err) {
        logger.warn("upload", `Closed the batch but could not remove ${ids.length} unfinished record(s).`, err);
        error.value = "The batch was closed, but unfinished records could not be removed from the backend.";
      }
    }
  }
  const batches = useBatchesStore();
  // ...existing update + archive, unchanged
}
```

In `src/composables/useProcessing.ts`, expose what the dialog must state before the operator commits:

```ts
/** What a close would do, for the confirm dialog. `removable` is the count of
 * unfinished records this batch created that cleanup would delete. */
const closableSummary = computed(() => {
  const res = uploadStore.resultsFor(batch.value?.id ?? "");
  const all = Array.from(res.values());
  return {
    total: all.filter((r) => r.status !== "uploaded").length,
    removable: all.filter(
      (r) => r.status !== "uploaded" && r.backendId
        && !r.warnings.some((w) => w.code === "adopted-existing"),
    ).length,
  };
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vue-tsc --noEmit && npx vitest run`
Expected: `tsc` exit 0, all green (791).

- [ ] **Step 5: Commit**

```bash
git add src/stores/useUpload.ts src/stores/useUpload.test.ts src/composables/useProcessing.ts
git commit -m "Optionally remove records a closed batch left unfinished"
```

- [ ] **Step 6: GUI half — the confirm dialog (**GUI lane**)**

The dialog must name both numbers from `closableSummary` and default the cleanup checkbox to **off**. Closing is already irreversible (an archived batch has no unlock); stacking a second irreversible act behind the same click, pre-ticked, is how operators lose data they meant to keep. Suggested copy:

> Close batch #017?
> 3 items did not upload. Closing is permanent — the batch cannot be reopened.
> ☐ Also remove the 1 unfinished record this batch created from the backend.
> Your scans and processed files are never deleted.

That last line matters: it is the reassurance that makes the checkbox safe to offer at all.

---

## Task 8: Documentation

**Files:**
- Modify: `docs/tasks/07-upload-and-publish.md`, `docs/OUTSTANDING.md`, `docs/02-architecture.md`

- [ ] **Step 1: Record the two backend facts**

In `docs/02-architecture.md` §"Two consistency caveats", add a third: `GET /api/search/:id` 404s are CDC-lagged and non-authoritative, while `PATCH /api/items/:id` 404s read Postgres and are authoritative. This distinction is load-bearing for Task 5 and is not obvious from the endpoint list.

- [ ] **Step 2: Record the id derivation**

In `docs/tasks/07-upload-and-publish.md`, document that a create `409` is always a COBISS-id collision, that the colliding id is `generateDeterministicId(cobissId)`, and that `services/api/deterministicId.ts` ports it with a cobissId verification guard.

- [ ] **Step 3: Close the OUTSTANDING entries**

In `docs/OUTSTANDING.md` §5, the "Settings cannot point at the offending field" item is unrelated, but add a line recording that the orphaned-item hard lock (`FRONTEND-TODO §3B` "Orphaned badge … brez resolve akcije") is now resolved by automatic re-creation on an authoritative 404, so the badge no longer needs a manual resolve action.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "Document the adoption flow and the two kinds of 404"
```

---

## Self-review

**Spec coverage.** §3.2's flow is Tasks 1–4. §3.3's three source-of-truth guarantees are tested in Task 4 Step 1 (`keeps the BACKEND's targetState and visibility`, `PATCHes only what the operator actually changed`, `issues NO patch when the operator changed nothing`). §3.4's degradation is the `degrades to duplicate` test. The §4 audit's S2/S3 are Tasks 1–4, S5 is Task 5, S14 is Task 6; S1, S6–S13 are asserted unchanged and need no task. Task 7 implements no audit row — it removes the half-made record a closed batch would otherwise strand on the live site, and its exclusion table is enforced by `removableBackendIds` plus the `never deletes an adopted record` test.

**Placeholders.** None: every code step carries the actual code, every test the actual assertions, and the Task 1 fixtures are real values generated from the backend's own function rather than invented.

**Type consistency.** `ExistingRecord` (Task 2) is consumed by `adoptExistingRecord` (Task 4) with the same field names. `resolveExistingRecord` is the dep name in both. `replaceOnBackend`'s seven-parameter signature (Task 3) is what Task 4 calls with `adoptedCtx`/`adoptedPlan`/`adopted`. `deterministicItemId` is async in Task 1 and awaited in Task 2. The warning code `"adopted-existing"` is declared in Task 4 Step 3 and used in Task 5's `recreateOrphaned`.

**Type consistency, Task 7.** `closeBatch` is one-argument in Task 6 and gains an optional `options` object in Task 7, so Task 6's call sites keep compiling. `removableBackendIds` reads `ItemUploadResult.warnings[].code`, which is `UploadWarningCode` — the same `"adopted-existing"` member Task 4 declares.

**Known follow-up, deliberately out of scope.** `resolveExistingRecordWith` is exported solely for its tests; if the team adopts a convention against that, fold it behind the dep and test through `uploadItem`. Task 6/7's confirm dialog copy is the GUI owner's call.

**Deliberately NOT built.** Deleting local files — source scans or derived PDF/thumbnail/OCR — on close. The archive does not own the scans, and `src-tauri` exposes no delete command at all, which is a safety property worth keeping rather than an omission to fix. An operator who wants a folder gone uses the file manager. Also not built: clearing the local link after a cleanup delete. It would need a `dto.rs` change, and Task 5 already turns the resulting dead link into a clean re-create on the next upload.
