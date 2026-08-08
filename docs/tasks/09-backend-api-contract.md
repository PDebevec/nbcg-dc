# Epic 09 — Backend API contract

> Depends on: — · Blocks: 04, 05, 07, 08, 10 · **Start early (Phase 0)**

Goal: nail down the real API between the app and the website. The site is
**ours to change**, so this is two-way design. Backend changes the archive needs
are filed in the **`nbcg` repo** under
[`todo/backend-archive-*`](../../../nbcg/todo); this epic tracks them and turns
the API into a firm, versioned contract.

> **Status: done (logic lane), 2026-08-07.** Every capability resolves to a
> verified endpoint; see [Progress](#progress--logic-lane). The headline is that
> the backend had already shipped most of what this doc listed as "to request" —
> and that four behaviours differ from what the wire shape suggests. Those are
> pinned in `src/services/api/dto.ts`.

## Capabilities (client need → endpoint → backend task)

Status column verified against the running backend + the `nbcg` source on
**2026-08-07**. Where a row once said "filed" or "needs adding", it now says what
the backend actually does — several requested items had already shipped.

| Capability | Endpoint (**verified**) | Status |
|---|---|---|
| **Auth** — static Keycloak bearer token sent on every call; verified by the backend at the point of use (`401`/`403`) | *(header `Authorization: Bearer`)* | ✅ no endpoint needed |
| **Metadata schema** — main + child field defs incl. parent-inheritable / issue-identifying flags | `GET /api/schema/record?level=main\|child` | ✅ **flags already present** (`parentInheritable`, `issueIdentifying`, `levels`); no `label` |
| **COBISS preview** — fetch + parse by CG-ID, no persist | `GET /api/import/cobiss/preview/:cobissId` | ✅ implemented — **path differs from the one these docs used to cite** |
| **External full-text ingest** — store archive OCR text, skip Tika | `POST /api/files/upload/:id` (multipart `extractedTexts` map, `doOCR=false`) + `PUT /api/files/:fileId/text` to reset | ✅ implemented |
| **Attachment roles** — `FileRole { SOURCE, ARCHIVAL, WEB, THUMBNAIL }` on each upload | upload DTO role is **batch-wide, not per-file** — a mixed-role set is one request per role | ✅ implemented (with that caveat) |
| **Replace file** — atomic swap of PDF + full text (re-upload) | `PUT /api/files/:fileId` | ✅ implemented — stable `id` + `role`; **omitting `extractedText` wipes the text** |
| ~~**Direct item read**~~ — decided **not to build** (use `GET /api/search/:id` + background refresh; see maybe-read-after-write) | ~~`GET /api/items/:id`~~ | ❌ dropped |
| **Optimistic concurrency** | `PATCH /api/items/:id` with a **required `expectedVersion` body field** → `409` | ✅ implemented — **not** the `version` + `If-Match` header shape this doc proposed |
| **Relations integrity** — clean dangling relations/counts on delete | (internal) | ⏳ `DELETE /api/items` does remove relations first; wider cleanup still open (P3) |
| **Ingest / publish** — create-or-update honouring targetState + **visibility** | `POST /api/items`, `PATCH`, `POST /api/items/transition`, `POST /api/relations/connect` | ✅ incl. `visibilityStatus`; transition is **not idempotent** |
| **Search / children** — discovery for sync + parent picker | `GET /api/search`, `/:id/children` | ✅ (CDC-lagged) |
| **Sync source** — catalogue metadata for tracked records; incremental "changed since" is optional | `GET /api/search` + `GET /api/search/:id` | ✅ full re-fetch accepted; incremental TBD |
| **Child / issue items** — main vs child | *(no backend capability needed — `ItemLevel` is local; `jeGlavnoGradivo` is a dead constant, see "Backend gaps")* | ✅ resolved locally |

> **Item inventory is NOT a backend capability** — the archive discovers items
> from the local filesystem; the backend owns catalogue metadata only. **Batches
> are local-only** and need no backend API. **Naming is folder-derived** and needs
> no backend step. (See [decisions](../03-open-questions.md).)

## Tasks

- [x] **Auth is a static bearer token — no identity/verify endpoint.** The app
      is single-workstation, single-user (no login), so there is nothing to
      "verify" a caller against; the token is authenticated by the backend on the
      first real write (`401`/`403`). Settings → Test connection is a plain
      reachability ping (`GET /api/health`). Identity/access-level display is
      deferred until (if ever) multi-user login is added.
- [x] **Schema endpoint — nothing to extend; it already exposes the flags.**
      Live-verified: `parentInheritable`, `issueIdentifying` and a `levels`
      array are per-field, and `?level=` filters on `levels`. **41 main · 31
      child · 41 unfiltered**; child is a strict *subset* of main (no child-only
      fields). 23 fields are parent-inheritable; exactly 2 are issue-identifying
      (`numberingAndDates`, `seriesVolume`). Shape agreed as
      `{ key, type, required, itemType?, allowedValues?, objectShape?, group,
      order, parentInheritable, issueIdentifying, levels }` — **there is no
      `label`**, so labels come from `allowedValues[].en`/`.cnr` or the client.
      Strong quoted-md5 `ETag` + `Cache-Control: public, max-age=86400`, and
      `If-None-Match` → `304` confirmed. Two traps recorded in `dto.ts`:
      `required` is a **UI hint only** (the backend enforces just a non-empty
      `title`; `collectionType` is marked required but defaults to `0`), and the
      backend's ETag cache is per-process with no invalidation, so a schema
      change needs a backend restart to reach clients.
- [x] **COBISS preview confirmed** — `GET /api/import/cobiss/preview/:cobissId`
      → `{ cobissId, itemId, alreadyExists, existsAs, metadata }`, needs
      `import:execute`. Error semantics are worse than this doc assumed: there
      is **no "multiple" error** (the first record in the SRU response wins),
      and `fetchCobissRecord` returns `null` — collapsing to one identical
      `404` — for a non-2xx from COBISS, a network failure, the **30 s
      timeout**, *and* a genuinely absent record. The archive cannot tell those
      apart, so its own request timeout must exceed 30 s or a slow-but-working
      upstream is misreported as a client timeout.
- [x] **Files contract confirmed** — `extractedTexts` map + `doOCR=false` on
      `POST …/upload`, `PUT /api/files/:fileId/text` to reset, `PUT
      /api/files/:fileId` to replace (stable `id` **and** `role`). Corrections:
      **`role` is batch-wide, not per-file** (as this doc had it); map keys must
      match the multipart filename **exactly**; an **empty-string** entry stores
      `NO_TEXT` but *still enqueues Tika*, which then overwrites it; and
      **replace without `extractedText` wipes the stored text** and re-enqueues
      extraction. Limits: ≤10 files per request, 2 GB per file, role defaults to
      `SOURCE`, `POST /:fileId/extract` `400`s on non-PDFs.
- [x] **Create/publish + PATCH confirmed.** `targetState` selects the collection
      (and thus the `*:manage` scope checked) and `visibilityStatus` is written
      verbatim; `PATCH` shallow-merges only the keys sent. Three sharp edges now
      pinned in `dto.ts`: (1) create **force-writes** `_source`,
      `childrenInDrafts`, `childrenInRecords`, `jeGlavnoGradivo` *after* the
      client metadata, so those are unsettable — while `collectionType` is only
      a *default* and can be overridden (live: sending `collectionType: 7`,
      `jeGlavnoGradivo: false`, `_source: 'cobiss'`, `childrenInDrafts: 99` and
      a junk key returned
      `{title, _source:'nbcg', collectionType:7, jeGlavnoGradivo:true,
      childrenInDrafts:0, childrenInRecords:0}`); (2) a **no-op `PATCH` returns
      `200` + empty body without ever comparing `expectedVersion`** (live: `999`
      against a v0 item → `200`, no `409`), and metadata containing only unknown
      keys takes that same silent path — so it is useless as a version check,
      though an unknown id *does* still `404` from the controller's access
      guard; (3) `POST /api/items/transition` is **not idempotent** — one
      already-transitioned id `400`s the whole batch.
- [x] ~~Confirm the **collections / parent-list** endpoint~~ — **there is none.**
      The parent picker is built on `GET /api/search`, and `collectionType` is a
      **number inside `metadata`**, not a column. Which value(s) are
      **data-passing** is still open, so it stays a configurable list
      (`AppConfig.dataPassingCollectionTypes`).
- [x] Confirm the **read-after-write** handling: **no direct read** — trust
      write responses and treat `GET /api/search/:id` as CDC-lagged (show local,
      refresh in background). Implemented in Epic 08; note the search `404` is
      ambiguous (CDC lag / visibility scope / infra / deleted) — see
      [PROJECT-KNOWLEDGE §4](../PROJECT-KNOWLEDGE.md) and `domain/sync`.
- [x] Decide the **sync source** shape: **full re-fetch accepted** — one
      `GET /api/search/:id` per tracked item at concurrency 4 (Epic 08). No
      incremental endpoint needed for now; add "changed since `<timestamp>`"
      only if run times become a problem (spec §12-G).
- [x] Document the **record/draft data model** — see
      [§ The record/draft data model](#the-recorddraft-data-model) below;
      endpoint names in [architecture](../02-architecture.md) brought in step
      (the COBISS-preview path and the "new backend work we requested" list were
      both stale).

## The record/draft data model

The shared reference. Typed in `src/services/api/dto.ts` + `src/domain/`.

**There is no `Item` table.** `drafts` and `records` are two tables with
identical columns; an item lives in exactly one of them and `targetState`
(`ItemType { DRAFT, RECORD }`) is which. The `id` is a cuid and is **immutable
across a transition** — moving draft↔record keeps the id, copies
`metadata`/`visibilityStatus`/`createdAt`, re-points attachments and rewrites the
relation rows. Columns: `id`, `visibilityStatus`, `metadata` (JSON), `version`
(starts at **0**), `createdAt`, `updatedAt`, `createdByUserId`, `updatedByUserId`.

**Required fields.** Only two things are enforced server-side: `visibilityStatus`
and `targetState` on the create body, and a **non-empty `metadata.title`**.
Everything else the schema marks `required` is a UI hint (see the schema task
above). Unknown metadata keys are dropped silently on both create and PATCH; a
known key with the wrong type is a `400`.

**Metadata = system fields + COMARC fields.** The system (non-COMARC) block is
the backend's `BaseMetadata`, and it splits on writability:

| Key | Type | Writable? |
|---|---|---|
| `title` | string | ✅ required, non-empty |
| `collectionType` | **number** (not an enum, not a column) | ✅ — server default `0` |
| `_source` | `'cobiss' \| 'nbcg'` | ❌ derived from `cobissId` presence |
| `childrenInDrafts` | number | ❌ DB trigger |
| `childrenInRecords` | number | ❌ DB trigger |
| `jeGlavnoGradivo` | boolean | ❌ hardcoded `true` — see gaps |

The rest of `metadata` is the schema-driven COMARC field set (41 keys), so the
schema endpoint — not this table — is the authority on field names and types.

**Main vs child.** *Not* a stored property. It is (a) the `levels` array on each
`FieldDescriptor`, which the editor uses to decide which of the 41 fields to
show, and (b) whether the item is the child end of an `item_relations` edge.
Child is a strict subset of main: 31 of the 41 fields, no child-only field.
`jeGlavnoGradivo` looks like the "is main material" flag but is not usable as one.

**Parent links.** `item_relations` is a directed graph:
`(parentId, parentType, childId, childType)`, composite PK, **no FK
constraints**, cycle-guarded on connect. An item can have several parents.
Writing an edge (`connect`/`disconnect`) mutates the **parent**: a trigger
updates its `childrenIn*` counts and **bumps its `version`** — invisibly, since
both endpoints return empty bodies. On read, the indexed document exposes only
the inbound edges, as `parent_relations[]` (explicit `null` when empty), and
`GET /api/search/:id/children` walks the other direction.

**Files** hang off exactly one item (`draft_id` XOR `record_id`, cascade delete),
each with a `FileRole` (`SOURCE` default) and an optional `extractedText`.

## Backend gaps opened by this epic

**One filed, P3** — [`backend-archive-relations-return-parent-version.md`](../../../nbcg/todo).
Relation writes bump the parent's `version` but return nothing, so after linking
N children the archive's cached parent version is stale by N and a later `PATCH`
on that parent `409`s. Not blocking: the archive never patches a parent in the
same flow that connects to it, and it can close this on its own side by
invalidating the parent's mirrored version after `connectParents` (see "Still
owed by the logic lane"). The backend fix — returning the parent's new `version`
from `connect`/`disconnect` — just saves depending on a CDC-lagged read for a
value the backend already computed.

**One considered and dropped: `jeGlavnoGradivo`.** It is unreachable through the
API (hardcoded `true` on every create path, dropped by the PATCH sanitiser,
never touched by a trigger), so every item in the system carries the same value.
That initially looked like it blocked child/issue upload — it does not. The
archive's main-vs-child concept is **local**: `ItemLevel` in `domain/item.ts`,
which drives the schema field-set filter (`domain/metadata-form.fieldsForLevel`)
and the provenance ingestion routing (`domain/provenance.ts`). Nothing in the
archive wants a server-side flag, and on the website side `jeGlavnoGradivo`
appears only as a type declaration in `frontend/src/api/search.ts` — it is never
read. So it is a dead constant and mild backend tech debt, not an integration
gap; no task was filed. The one thing that matters for us is recorded in
`domain/metadata.ts`: **do not build child/issue logic on it.**

## Acceptance

- A written, versioned API contract the app can build against, with every row
  above resolved to a real endpoint or an accepted `nbcg/todo` task. The
  verified contract lives in [`PROJECT-KNOWLEDGE.md`](../PROJECT-KNOWLEDGE.md) §4
  and in code at `src/services/api/dto.ts`.
- The schema-flags additions are agreed and filed. (No identity endpoint — auth
  is a static token, verified on use.)

## Progress — logic lane

**Status: done** (2026-08-07). Every capability row resolves to a real, verified
endpoint; the two open items are backend gaps, not archive work. `vue-tsc`
clean, 496 tests green.

Built / changed in this pass — all `.ts`, all Seam 3:

- **`services/api/dto.ts`** — the contract of record. Create/PATCH/transition/
  delete, relations, files and the schema response now carry the verified
  semantics inline, including the four traps that are invisible from the wire
  shape: the no-op-PATCH short-circuit, the batch-wide file `role`, the
  empty-string `extractedTexts` entry that still triggers Tika, and replace
  wiping the stored text. Added `UPLOAD_MAX_FILES` / `UPLOAD_MAX_FILE_BYTES`.
- **`services/api/{items,files,relations}.ts`** — caveats at the call sites that
  change how you call them (`updateItem`'s `undefined` is weaker than it looks;
  `transitionItems` is not idempotent; `replaceFile` must re-send text;
  `connectRelations` bumps the parent's version).
- **`domain/metadata.ts`** — `SystemMetadata` split into writable (`title`,
  `collectionType`) vs server-owned; the old "ignored on write" comment was
  wrong for both writable keys.
- **`docs/02-architecture.md`** — endpoint table corrected: the COBISS-preview
  path, and the "new backend work we requested" list (most of it had shipped).

### Verification

Backend source (controllers, services, DTOs, Prisma schema, trigger migrations)
**plus a live end-to-end write pass** against `localhost:3000` on 2026-08-07 —
create → PATCH → upload → replace → connect → transition → delete, with
throwaway items cleaned up afterwards. Every claim above is live-confirmed:

| Probe | Result |
|---|---|
| create with all server-owned fields set + a junk key | forced to `_source:'nbcg'`, `jeGlavnoGradivo:true`, `childrenIn*:0`; junk key dropped; **`collectionType:7` kept** |
| no-op PATCH, `expectedVersion:999`, item at v0 | `200` empty — **version never compared** |
| PATCH, metadata of only unknown keys | `200` empty, no `400`, no version bump |
| PATCH, unknown id | `404` (controller access guard, before the service) |
| real PATCH at v0 → stale PATCH at v0 | `{version:1}` → `409 Version conflict: expected 0, current 1` |
| upload 2 PDFs, `role=WEB`, `extractedTexts` with one real + one `""` | both `role=WEB` (batch-wide); real → `EXTRACTED`; `""` → `NO_TEXT`, text `null` |
| replace with **no** `extractedText` | `id` and `role` stable, text → `null`, status → `NOT_EXTRACTED` — **text wiped** |
| connect one child, then PATCH parent at v0 | `409 … expected 0, current 1` — **connect bumped the parent** |
| transition, then repeat; then a mixed batch | `201` → `400 Items already in state RECORD` → same `400`, **whole batch fails** |
| delete `[realId, bogusId]` | `404 Items not found: …`, and the real item **survived** |

One documented claim was **wrong and has been corrected**: a no-op PATCH is not
an existence-check bypass. The controller runs `assertCanManage` — which
resolves the item — before the service's short-circuit, so an unknown id `404`s
normally. Only the *version* check is skipped.

### Still owed by the logic lane

- **Act on the two sharp edges in Epic 07's upload flow** (contract is pinned,
  behaviour is not yet changed): re-read or invalidate a locally-tracked
  parent's `version` after `connectParents`, and filter the batch before any
  `transitionItems` call so a re-run does not `400`.
  — **Updated 2026-08-08:** the first is **done**
  (`services/upload.applyParentStates`). The second has **no call site to guard** —
  nothing in the archive calls `transitionItems` — so it stays documented at the
  call surface rather than wrapped speculatively. See
  [Epic 07 §Audit pass](07-upload-and-publish.md).
- Generating `dto.ts` from the backend's OpenAPI, if the backend ever exposes
  one — it is hand-maintained against the survey today.

### Owed by GUI (`.vue`/`.css`)

Nothing for this epic — it has no screen. Two facts do constrain the metadata
editor when Epic 04's UI lands, and both flow through composables, not the API:

- `FieldDescriptor` has **no `label`** — the UI must supply its own display
  names (or use `allowedValues[].en`/`.cnr` for coded fields). Group/order come
  from the descriptor (`group`, `order`).
- `required` on a field is a **UI hint**, not a server constraint, so the form
  owns that validation; only an empty `title` is actually rejected by the
  backend.

### Owed by Arch (`.rs`/`.py`/CI)

Nothing for this epic — no IPC surface, no Python. The pre-existing dependency
still stands: `tauri-plugin-http` must be registered with the backend host
allow-listed, or every call in `services/api/` is denied at runtime.

### Owed by the backend team (`nbcg`)

**Nothing outstanding.** Of the two gaps above:

- Relation writes bumping the parent's `version` without reporting it —
  **fixed 2026-08-07**. `connect`/`disconnect` now return
  `{ parentId, version, childrenInDrafts, childrenInRecords }` (and `disconnect`
  moved `204` → `200` to carry it); `transition` returns `{ id, version }[]`.
  Consumed by `services/upload` as `ItemUploadResult.parentStates`.
- `jeGlavnoGradivo` being unsettable — **not a gap after all**. It is a dead
  constant the website never reads, and the archive's main-vs-child concept is
  local (`ItemLevel`). No task filed; see PROJECT-KNOWLEDGE §8.15.

Three further bugs found later (Epic 10 + the round-trip) were filed and are also
**all fixed**: schema `?level` validation, the empty-`PATCH` guard order, and
indexed timestamps missing their timezone. See `nbcg/todo/`.

## Re-verification against the live backend, 2026-08-08

The contract above was surveyed from the backend *source*. It has now been
re-checked by actually driving the running backend (`localhost:3000`, a token with
every `*:manage` + `*:view:*` scope): create → patch → upload → connect →
transition → disconnect → search → delete, with the test items hard-deleted
afterwards and `GET /api/items/stats` confirmed back to baseline.

**60/60 checks passed.** Everything in §4 of
[PROJECT-KNOWLEDGE](../PROJECT-KNOWLEDGE.md) holds as written, including all four
of the 2026-08-07 backend fixes, the `version`-is-a-write-counter behaviour, the
all-or-nothing `DELETE`, the cycle/self-reference guards, the search pagination
boundaries, and the absence of any identity endpoint.

Three deltas, none of which change the endpoint table:

| Delta | Where it was wrong | Now |
|---|---|---|
| `?level` **is** validated — an unknown value is a `400`, case-sensitive | `dto.ts` still carried the pre-fix warning (`200 { fields: [] }`) | comment corrected; `services/api/schema.ts` was already right |
| `PUT /api/files/:fileId` (replace) mangles non-ASCII filenames **too** | listed as "untested, presumably the same bug" | confirmed. Narrower damage: `extractedText` is singular there, so the text survives — only the stored name is corrupted |
| The mangling is **reversible mojibake**, not lossy `?` | recorded as "characters destroyed, not escaped" | UTF-8 bytes read as Latin-1. Both shapes are reachable depending on the client's HTTP stack; the archive now handles both |

The last two are why Epic 07's re-upload path was silently duplicating
attachments — see [Epic 07 §Audit pass](07-upload-and-publish.md). The backend
todo was updated with the corrected reproduction
(`nbcg/todo/backend-multipart-filename-not-utf8.md`, still **P1**, still open).

> **What this pass did not cover.** COBISS preview was only exercised against a
> non-existent id (a `404`, which conflates "no such record" with "upstream
> down"). A real CG-ID round-trip needs `ws.cobiss.net` reachable from the
> backend, so the shape of a *successful* preview is still source-derived, not
> live-verified.
