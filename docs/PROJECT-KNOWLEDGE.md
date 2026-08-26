# NBCG-DC — Project Knowledge & Backend Reference

> **Read this first.** Single source of truth for continuing work on `nbcg-dc`,
> especially the `.ts` logic lane and its integration with the `nbcg` backend.
> Everything here is verified against the real code (backend surveyed
> 2026-08-03) — where it disagrees with the planning docs in `docs/`, **trust
> this file** (see §8 for the specific discrepancies). §9 and §10 record the two
> review passes that checked this file *against the code*, rather than the
> reverse; §10 is the most recent state.

---

## 1. What these two projects are

- **`nbcg-dc`** (`C:\Users\jerne\Documents\GitHub\nbcg-dc`) — a **Tauri 2 + Vue 3**
  desktop app for National Library of Montenegro staff. It turns folders of
  scanned documents into correctly-uploaded **records/drafts** on the library
  website, with Python doing the heavy file work (OCR, PDF building).
  **Deployment: one workstation, one implicit user, no login.**
- **`nbcg`** (`C:\Users\jerne\Documents\GitHub\nbcg`) — the library **website
  backend**: NestJS + Prisma + PostgreSQL, with OpenSearch (search), SeaweedFS
  (file blobs), Apache Tika (text extraction), Keycloak (auth), and BullMQ/Redis
  (background queues). **It is the single source of truth**, and it is "ours to
  change."
- **Relationship:** `nbcg-dc` is a **thick client** of `nbcg`'s REST API. Writes
  go to the backend first, then the archive rewrites its local mirror. Sync is
  one-way backend → archive. Links are by immutable `id`.

## 2. Team lanes (who owns what in `nbcg-dc`)

Split **by file type** (see [`04-code-structure.md`](04-code-structure.md)):

| Dev | Lane | Files |
|---|---|---|
| **Jernej** (you) | Application / logic | `.ts` — `domain/ services/ stores/ composables/ ipc/ app/ lib/` |
| GUI dev | Presentation | `.vue`, `.css` — `views/ components/ design/` |
| Arch/DevOps dev | Native + Ops | `.rs`, `.py`, CI — `src-tauri/ py/` |

Stay in the `.ts` lane. Four seams: composables (GUI↔Jernej), the IPC
command/event contract (`src/ipc/`, Jernej↔Arch), the REST API
(`src/services/api/`, Jernej-only), the Python CLI (Arch-internal). Path aliases:
`@domain @services @ipc @stores @composables @ui @lib @app`.

## 3. Decisions that shape the integration

- **No login / no identity.** One workstation, one operator. Auth is a **static
  Keycloak bearer token** stored in app config, sent as `Authorization: Bearer`
  on every call. There is **no per-user login and no identity/verify endpoint**,
  and none is needed — a bad token simply fails the first real write with
  `401`/`403` ("verify on use"). If multi-user login is ever wanted, add it then.
- **Backend is the source of truth.** Write-through (backend → then local
  `metadata.json` + SQLite). Never read authoritative data *from* the archive
  for items that exist on the backend.
- **OCR runs on the archive** (PaddleOCR). Upload the web PDF with `doOCR=false`
  and push OCR text in the `extractedTexts` map.
- **Batches are local-only** (SQLite); never sent to the backend. One batch
  processes at a time per workstation (app-enforced; single machine → no backend
  lock).
- **Naming is folder-derived** — the scan folder name is the base name for
  derived outputs.
- **Concurrency/consistency:** `PATCH` uses optimistic concurrency
  (`expectedVersion`); search reads are CDC-lagged (trust write responses).

---

## 4. The `nbcg` backend — verified REST contract

**Base & prefix.** Global prefix `/api` (`setGlobalPrefix('api')`); port 3000
(env `PORT`); no API versioning. Default host `https://api.nbcg.me`. **Full URL
= `<baseUrl>` + `/api` + `<path>`.** (Confirm whether the public host already
includes `/api`; the client keeps `apiPrefix` configurable.) CORS allows
`Authorization` + `Content-Type`. Global `ValidationPipe { whitelist, transform }`
strips unknown body props.

**Auth model (important).**
- Keycloak **RS256 JWT** via `Authorization: Bearer <token>` (JWKS from
  `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`; audience = `KEYCLOAK_CLIENT_ID`,
  default `nbcg-api`). A cookie `nbcg_at` is accepted **only** on the file
  `download` GET.
- Two global guards: **`OptionalJwtGuard`** (validates a token if present but
  **never rejects** — missing/invalid/expired → anonymous) then **`ScopesGuard`**
  (enforces `@RequireScopes`; anonymous → `401`, insufficient → `403`).
- Consequence: **unauthenticated-OK routes return `200` even with a garbage
  token.** Only scoped endpoints reveal token validity. **There is NO
  `/api/me` / `/verify` / identity route** — the principal is never serialized
  back to the client.
- **Scopes** (bare strings, Keycloak client roles; not a TS enum):
  `records:manage`, `drafts:manage`, `records:view:private`,
  `records:view:hidden`, `drafts:view:public`, `drafts:view:private`,
  `drafts:view:hidden`, `import:execute`. Writes need the `*:manage` scope for
  the target collection; `transition` needs **both** `records:manage` +
  `drafts:manage`; COBISS needs `import:execute`.

**Enums** (Prisma `generated/prisma/enums`):
- `VisibilityStatus` = `PUBLIC | PRIVATE | HIDDEN`
- `ItemType` = `DRAFT | RECORD` (this is `targetState`; there is **no**
  `ItemState` enum)
- `FileRole` = `SOURCE | ARCHIVAL | WEB | THUMBNAIL`
- `FileType` = `IMAGE | PDF | UNKNOWN`
- `TextExtractionStatus` = `NOT_EXTRACTED | EXTRACTED | GARBAGE | NO_TEXT`

**Data model.** No single `Item` model — parallel `drafts` + `records` tables,
identical columns: `id` (cuid, immutable), `visibilityStatus`, `metadata` (JSON),
`version` (optimistic-concurrency counter, starts 0), `createdAt`, `updatedAt`,
`createdByUserId`, `updatedByUserId`. `item_relations` = directed graph
(`parentId`,`parentType`,`childId`,`childType`; composite PK; no FK constraints;
cycle-guarded on connect). `file_attachments` link to exactly one of
`draft_id`/`record_id` (cascade delete).

**Metadata JSON shape** (`metadata` on a draft/record): system fields
`title` (string, required non-empty), `collectionType` (**a number**, not an
enum/column — drives parent data-passing eligibility), `childrenInDrafts`,
`childrenInRecords`, `jeGlavnoGradivo`, `_source` (`'cobiss'|'nbcg'`), plus the
schema-driven COMARC domain fields.

### Endpoint reference

**Items** — `src/modules/items`
| Method / path | Auth | Body → Response |
|---|---|---|
| `POST /api/items` | `records:manage` or `drafts:manage` (by `targetState`) | `{ visibilityStatus*, targetState*, metadata? }` → full entity `{id, visibilityStatus, metadata, version:0, createdAt, updatedAt, createdBy…, updatedBy…}`. `metadata.title` required. `cobissId` in metadata ⇒ deterministic id (409 if it exists). **Server force-writes `_source`, `childrenInDrafts:0`, `childrenInRecords:0`, `jeGlavnoGradivo:true` AFTER the client metadata — unsettable; `collectionType` is only a default (`0`) and IS overridable.** |
| `PATCH /api/items/:id` | manage (by collection) | `{ visibilityStatus?, metadata?, expectedVersion* }` → **always `{ version }`**: the new version on a real change, the **unchanged** one when the payload had nothing to write. **Metadata is SHALLOW-merged** (only sent keys; nested replaced; unknown dropped; no unset). `409` on version mismatch. ✅ **Fixed 2026-08-07** — the no-op early return now sits *after* the existence and version guards, so a wrong `expectedVersion` is always a `409` and the returned version is always authoritative (it used to short-circuit first, returning `200` + an empty body with the version never compared). Metadata of only-unknown keys still sanitises to `{}` and counts as "nothing to write" — no `400`. |
| `POST /api/items/transition` | `records:manage` **and** `drafts:manage` | `{ ids[], targetState }` → **`{ id, version }[]`** (since 2026-08-07; versions are *read back* post-trigger, not computed as +1, because a transitioned item that is itself a parent gets bumped twice). ⚠️ **Not idempotent** — any id already in `targetState` throws `400 Items already in state …` and the whole batch fails. Preserves `id`, re-points attachments, rewrites relation `childType`/`parentType`. |
| `DELETE /api/items` | manage (per collection touched) | `{ ids[] }` (body on DELETE) → empty. Hard delete, **all-or-nothing** (`404` if any id is missing → nothing deleted). Relations removed first (so the counts trigger fires), attachments cascade, blobs deleted best-effort after commit. |
| `GET /api/items/stats` | `records:view:hidden` + `drafts:view:hidden` | → `{ records:{PUBLIC,PRIVATE,HIDDEN}, drafts:{…} }`. Only scoped GET. |

**Files** — `src/modules/files`
| Method / path | Notes |
|---|---|
| `POST /api/files/upload/:itemId` | multipart, file field **`files`** (≤10, 2 GB each). Parts: `doOCR` (bool str, default false), `extractedTexts` (JSON string map `filename→text`, **per-file**, matched on the EXACT `originalname`), `role` (**ONE `FileRole` for the whole batch — NOT per-file**; omitted ⇒ `SOURCE`). → `FileAttachment[]`. A THUMBNAIL+WEB mix ⇒ **two upload requests**. ⚠️ An **empty-string** map entry stores `NO_TEXT` *and still enqueues Tika* (the queue filter is a truthiness test) — which then overwrites it. Enqueue failures are swallowed; the upload still succeeds. |
| `PUT /api/files/:fileId` | **replace** — file field `file` (single), `extractedText` (singular). → updated `FileAttachment` (stable `id` **and** `role`; `filename`/`mimeType`/`fileType` overwritten). ⚠️ **Omitting `extractedText` WIPES the stored text** (→ null + `NOT_EXTRACTED`) and re-enqueues Tika. |
| `PUT /api/files/:fileId/text` | `{ text }` → `{ updated: true }`. Empty string ⇒ null. Never enqueues — the safe way to set/clear text. |
| `POST /api/files/:fileId/extract` | `{ doOCR? }` (default **true**) → `{ enqueued: true }`. PDFs only (`400` otherwise). |
| `GET /api/files/:itemId` | → `FileAttachment[]` (**`extractedText` omitted** — can be MBs). |
| `GET /api/files/:fileId/download` | binary stream; `?inline=1` for inline. Accepts the `nbcg_at` cookie. |
| `DELETE /api/files/:fileId` | → empty. |

`FileAttachment` = `{ id, draft_id, record_id, fileType, role, originalFid,
extractedText?, filename, mimeType, sizeBytes, textExtractionStatus, createdAt }`.

**Relations** — `src/modules/relations`
- `POST /api/relations/connect` — `{ parentId, childIds[] }` →
  **`201 { parentId, version, childrenInDrafts, childrenInRecords }`**.
  Idempotent, cycle-guarded, self-ref rejected. Manage checked on **parent**
  collection only.
- `POST /api/relations/disconnect` — same body → **`200`** with the same shape
  (**changed from `204` on 2026-08-07** — a `204` must not carry a body).
  Unchecked directional edge delete.

> ### Writing a relation bumps the **parent**'s `version` — but now tells you
>
> `trg_item_relations_children_count` (migration `20260725120000`) fires per edge
> row and runs `UPDATE drafts|records SET metadata = jsonb_set(…childrenIn*…),
> version = version + 1 WHERE id = <parentId>`, so connecting N children advances
> the parent's version by N.
>
> **✅ Fixed 2026-08-07:** both endpoints now return the parent's post-write state,
> so a mirrored parent adopts the new version directly instead of `409`ing on its
> next `PATCH`. `services/upload` carries these up as
> `ItemUploadResult.parentStates`.
>
> Two caveats survive the fix:
> - The trigger writes raw SQL, so the parent's `updatedAt` does **not** move even
>   though its version and metadata did — `updatedAt` is not a reliable change
>   signal for parents.
> - **Don't try to confirm a connect by reading children back.** Live-verified:
>   `GET /api/search/:id/children` returned `total: 0` immediately after a connect
>   *whose parent document was already indexed* — the relation edge propagates
>   through CDC independently of the item. Trust the write response.

**Search** — `src/modules/search` (OpenSearch; **CDC-lagged** — lags writes)
- `GET /api/search` — query params `q, type(all|records|drafts), page, limit(≤100),
  title, author, fullText, publisher, language, materialType, yearFrom, yearTo,
  isbn, issn, cobissId, fields, sort(relevance|newest)` → `{ total, page, limit,
  pages, hits[] }`. `hits[]` = `{ id, index, score, source, matchedFiles?,
  highlights? }` (`source` = indexed doc; `extractedText` always excluded).
- `GET /api/search/:id` — a single `SearchHit` (404 if not found/not visible).
  Ignores `?fields`; returns a constant `score: 1`.
- `GET /api/search/:id/children` — same envelope, children of `:id` (filters on
  `parent_relations.parentId`).
- `GET /api/search/suggest?field=&q=&limit=&type=` — typeahead (bonus endpoint),
  15-field allowlist; an unknown `field` is a `400`.
- Deep pagination past ~10k (`from+size ≥ 10000`) → `400`. No collections
  endpoint — the **parent picker uses search**; `collectionType` comes from a
  hit's `source.metadata.collectionType`.

**The indexed document** (`SearchHit.source`) — verified against
`nbcg/infrastructure/docker/pgsync/schema.json`: `{ id, visibilityStatus,
metadata, version, createdAt, updatedAt, createdByUserId, updatedByUserId,
file_attachments[], parent_relations[] }`. Two things follow:
- **`version` is indexed**, so a search read can refresh the mirror's
  optimistic-concurrency counter — but it is CDC-lagged, so it must never
  overwrite a newer locally-known version (`domain/sync.acceptRemoteVersion`).
- **`targetState` is NOT a field** — it is the *index* the hit came from
  (`records`/`drafts`). That is how the archive detects a DRAFT↔RECORD
  transition made on the website (`services/api/search.searchIndexToItemType`).

> ### ⚠️ A search `404` does not mean "deleted"
>
> The single most important integration fact. `GET /api/search/:id` returns 404
> for four indistinguishable reasons, deliberately (a visibility miss must not
> leak an item's existence): **CDC lag** (just written, not yet indexed);
> **visibility scope**; **infrastructure** (OpenSearch down); and actual
> deletion. Per `ResourceAccessService.visibilityFilter`, PUBLIC records are the
> baseline for everyone, but PRIVATE/HIDDEN need `records:view:private`/`:hidden`
> — and **drafts are invisible without an explicit `drafts:view:*` scope**
> (`*:manage` also grants full visibility). A token lacking those 404s on every
> draft the archive ever uploaded. Anything that treats a 404 as authoritative
> absence is a bug; see `domain/sync` for the confirmation policy.
>
> **Measured on the dev backend 2026-08-07:** the index holds 9 records (all
> PRIVATE) and 5 drafts (3 PUBLIC, 2 PRIVATE); anonymous `GET /api/search`
> returns `total: 0` for all 14 — including the PUBLIC drafts. Empty is a
> perfectly normal answer here and is never evidence of absence.

**Live write round-trip** (2026-08-07, real token with all `*:manage` +
`*:view:*` scopes; created a draft, patched, uploaded, connected, read back, then
hard-deleted — stats returned to baseline):

- `POST /api/items` → `201` with the full entity. The server **adds** metadata
  defaults: `_source: "nbcg"`, `jeGlavnoGradivo: true`, `childrenInDrafts: 0`,
  `childrenInRecords: 0`. `version` starts `0`.
- **A `PATCH` that changes nothing still bumps `version`.** Sending the *identical*
  `subtitle` with the correct `expectedVersion` returned `{version: 2}`. This is
  **deliberate and now documented backend-side**: `version` is a **write counter,
  not a change counter**. Change-detection was considered and rejected — a deep
  semantic comparison of nested metadata could wrongly report "unchanged" and leave
  every mirror stale, which is worse than a spare bump. Always adopt the returned
  `version`; never infer "the content changed" from a bump.
- `expectedVersion` mismatch → `409 "Version conflict: expected 0, current 1.
  Re-fetch the item and retry."` Confirmed.
- File upload with `role=WEB` + `extractedTexts` → `201`; the attachment comes back
  `textExtractionStatus: "EXTRACTED"` with `extractedText` **present on the upload
  response** but **omitted from `GET /api/files/:itemId`**, exactly as documented.
- **The relations parent-version bump is real** — and is why `connect`/`disconnect`
  now return the parent's state. Before that fix, a `PATCH` on the parent with
  `expectedVersion: 0` immediately after connecting → `409 current 1`.
- **Search was NOT lagged here** — `GET /api/search/:id` returned the new draft
  (with its patched metadata and file attachment) within seconds. CDC lag is short
  in dev; treat that as luck, not a guarantee.
- **`GET /api/search/:id/children` returned `total: 0` right after `connect`** —
  the edge had not propagated even though the item itself had. So children are
  lagged independently of the parent doc; never read children back to confirm a
  connect.
- **Indexed timestamps carry an offset — ✅ fixed 2026-08-07.** They used to come
  out of a naive `timestamp` column as `"2026-08-07T14:11:00.682"` (**no `Z`**)
  while REST returned `…682Z`, so `Date.parse()` read the indexed copy as *local*
  time and every consumer was off by the UTC offset. The columns are now
  `timestamptz` and the corpus was reindexed, so both representations parse to the
  same instant (`…504Z` vs `…504+00:00`). **Do not add a compensating `Z`** — that
  would now double-correct. Nothing in `domain/sync` / `services/sync` ever parsed
  these, so the archive needed no change.

> ### 🔴 Non-ASCII upload filenames are mangled — and the full text is lost
>
> **Live-verified 2026-08-07, re-verified and corrected 2026-08-08.** The single
> worst integration bug found so far. `POST /api/files/upload/:itemId` with a
> multipart filename containing Cyrillic:
>
> ```
> sent     : ОКТОИХ петогласник 2.pdf   + extractedTexts keyed by that name
> → 201
> stored   : ÐÐÐ¢ÐÐÐ¥ Ð¿ÐµÑÐ¾Ð³Ð»Ð°ÑÐ½Ð¸Ðº 2.pdf
>            textExtractionStatus NOT_EXTRACTED, extractedText null
> ASCII control (same shape): filename intact, EXTRACTED, text attached ✅
> ```
>
> Two failures on a `201`: the stored filename is corrupted, **and** because
> `extractedTexts` is keyed **by filename** the OCR text matches nothing and is
> silently dropped. This hits the material the library actually catalogues —
> `ОКТОИХ петогласник 2` is a real folder in the sample set. Filed **P1**:
> `nbcg/todo/backend-multipart-filename-not-utf8.md`.
>
> **Three corrections to the original note (2026-08-08):**
>
> 1. **The corruption is reversible mojibake, not lossy `?`.** It is UTF-8 bytes
>    read as Latin-1, so `Buffer.from(stored,'latin1').toString('utf8')` recovers
>    the original exactly. The `??????` shape in the first report came from a
>    client that transcoded before sending — **both shapes are reachable**
>    depending on the HTTP stack.
> 2. **`PUT /api/files/:fileId` (replace) has the same bug** — was "untested",
>    now confirmed. Damage is narrower there: `extractedText` is singular and not
>    name-keyed, so the *text* survives; only the stored filename is corrupted.
> 3. **It also caused duplicate attachments.** Any client that reconciles "which
>    of my files are already uploaded?" by filename gets a miss and uploads a
>    second copy. The archive did exactly this — re-uploading a Cyrillic-named
>    PDF left **two** attachments (live-verified).
>
> **The archive defends itself in two places:**
> - `services/upload.repairMangledText` (first upload) compares each returned
>   attachment's `filename` against the one it sent — **positionally**, since
>   matching by name is exactly what is broken — raises a `filename-mangled`
>   warning, and re-attaches the text through `PUT /api/files/:fileId/text`, which
>   is keyed by **id** and verified immune (`{"updated":true}` → `EXTRACTED`).
> - **`domain/naming.isSameUploadedFilename` (re-upload)** — the fix for #3.
>   **Never compare a backend-returned filename with `===`; always go through
>   this.** It matches exact, mojibake (by decoding) and lossy (structurally).
>
> Only the backend can fix the stored filename. `Content-Disposition` on download
> still needs the RFC 6266 `filename*` form (untested).

**All four 2026-08-07 backend fixes — verified live** (fresh token, full
round-trip, test items deleted afterwards, stats back to baseline):

| Check | Result |
|---|---|
| `PATCH` real change | `200 {version:1}` ✅ |
| **`PATCH` empty payload + wrong `expectedVersion`** | **`409`** ✅ (was `200` — the fixed bug) |
| `PATCH` empty payload + right version | `200 {version:1}` unchanged ✅ |
| `PATCH` unknown-keys-only payload | `200 {version:1}`, no bump ✅ |
| `POST /relations/connect` | `201 {parentId, version:1, childrenInDrafts:1, childrenInRecords:0}` ✅ |
| **`PATCH` parent at the returned version** | **`200 {version:2}` — no `409`** ✅ (the point of the fix) |
| `POST /relations/disconnect` | **`200`** with body ✅ (was `204` empty) |
| `POST /items/transition` | `201 [{id, version:2}]` ✅ |
| Indexed `createdAt` | `"2026-08-07T16:30:52.748+00:00"` — offset present ✅ |
| `GET /api/schema/record?level=bogus\|MAIN` | `400` ✅ (`main`/`child`/none unchanged: 41/31/41, same ETags, `304` works) |

Note `disconnect` reported `version: 3` where the preceding `PATCH` left the parent
at `2` — the disconnect trigger bumps it too, which is consistent with `version`
being a write counter.

**Live-verified details** (2026-08-07, against the running backend + OpenSearch):
- `parent_relations` and `file_attachments` are an explicit **`null`** when
  empty, not an absent key — narrow with `?? []`.
- **`version` starts at `0`** — falsy. Never test it for truthiness.
- Documents also carry a `_meta` key (pgsync bookkeeping); ignore it.
- `GET /api/search/:id/children` on an unknown id is **`200` + empty envelope**,
  not a `404`.
- `?limit>100` → `400`; `from + limit >= 10000` → `400` (exact boundary: page 100
  at limit 100 is rejected, page 99 is fine).
- A **garbage token on an unauthenticated-OK route still returns `200`** — only
  scoped endpoints (`/api/items/stats`) reveal a bad token with `401`.

**COBISS / import** — `src/modules/import`
- `GET /api/import/cobiss/preview/:cobissId` — **synchronous**, no persist.
  Needs `import:execute`. → `{ cobissId, itemId, alreadyExists, existsAs:
  'DRAFT'|'RECORD'|null, metadata: DomainRecord }`. `itemId` is the deterministic
  id a create would use. **Gotchas:** the route is this exact path (NOT
  `/api/cobiss/:id/preview`); a `404` conflates "not found" **and** "COBISS
  upstream unreachable/timeout"; `metadata.title` may be `undefined` (raw record,
  no fallback). The archive's create flow = preview then `POST /api/items`
  (avoids orphan drafts).
  **Confirmed 2026-08-07:** `fetchCobissRecord` returns `null` — and the
  controller turns every `null` into the same `404` — for a non-2xx from
  `ws.cobiss.net`, a network failure, the **30 s `AbortSignal.timeout`**, and an
  XML response with no record. There is **no "multiple records" error**:
  `extractFirstRecordXml` takes the first hit. Because the upstream fetch alone
  can burn 30 s, the archive's own request timeout must exceed that or a
  slow-but-working COBISS is misreported as a client-side timeout.
  **✅ Enforced 2026-08-08** — it wasn't, until then. The client default is *also*
  30 s and its clock starts earlier, so the archive aborted first on every slow
  COBISS and reported `offline` ("Backend unreachable — check your connection"),
  sending the operator after a nonexistent network fault. Now
  `services/api/cobiss.COBISS_PREVIEW_TIMEOUT_MS` (45 s) overrides it via the new
  per-request `RequestOptions.timeoutMs`. **If the backend's `FETCH_TIMEOUT_MS`
  changes, change this with it.**
- `POST /api/import/cobiss` — async import (creates items). `{ ids[], target,
  visibilityStatus }` → `{ jobId }`. Poll `GET /api/import/jobs/:jobId`.
- `GET /api/import/jobs/:jobId` — needs `import:execute`. Job disappears (→404)
  after TTL (24h complete / 7d failed).

**Schema** — `src/modules/schema`
- `GET /api/schema/record?level=main|child` → `{ fields: FieldDescriptor[] }`.
  Anonymous-OK. **Strong ETag** (quoted md5) + `Cache-Control: max-age=86400`;
  send `If-None-Match` for a `304`.
- `FieldDescriptor` = `{ key, type('string'|'number'|'boolean'|'date'|'enum'|
  'array'|'object'), required, itemType?, allowedValues?: ResolvedCode[],
  objectShape?: FieldDescriptor[] (recursive), group, order, parentInheritable,
  issueIdentifying, levels: ('main'|'child')[] }`. **No `label`** — labels come
  from `allowedValues[].en` / `.cnr`. `ResolvedCode` = `{ code, en, cnr }` (cnr =
  Montenegrin). Main vs child = the `levels` array + `?level` filter (no separate
  field-set).
- **Live-verified 2026-08-07:** `41` main fields, `31` child, `41` unfiltered; the
  `If-None-Match` → `304` revalidation works as documented. `?level` is validated
  since 2026-08-07 — an unrecognised value is a **`400`** (case-sensitive), so the
  old `200 { fields: [] }` trap is gone. **Child is a strict
  subset of main — there are no child-only fields**, so `?level` only ever
  removes fields. 23 fields are `parentInheritable`; exactly two are
  `issueIdentifying` (`numberingAndDates`, `seriesVolume`).
- **`required` is a UI hint, not a server constraint.** The schema marks both
  `title` and `collectionType` required, but `items.service.create` enforces only
  a non-empty `title` and defaults `collectionType` to `0`. Never rely on the
  backend to reject a missing "required" field.
- The backend's ETag cache (`SchemaController.etagCache`) is **per-process with
  no invalidation**, so a schema change only reaches clients after a backend
  restart.
- **`level` is validated** since 2026-08-07: an unrecognised value is a `400`
  (case-sensitive — `?level=Main` fails), while `?level=` empty keeps its
  long-standing "all fields" meaning. It used to return `200 { fields: [] }`, which
  made an empty field list a reachable response.
  `services/api/schema` still refuses to let an empty schema replace a non-empty
  cached one — not for that cause, which is gone, but because a `200` with no
  fields remains possible from a transient backend fault and would leave the
  metadata editor a form with no fields for the full 24h max-age, **offline copy
  included**.

**Health** — `GET /api/health` (unauthenticated) → `{ status, timestamp }`.
`GET /api/` → `'Hello World!'`.

> ### ⚠️ Reaching the host is not reaching the API
>
> **Live-verified 2026-08-07:** `GET /api/health` → `200
> {"status":"ok","timestamp":…}`, but `GET /health` on the same host → **`404`**.
> So a wrong `apiPrefix`, or an `/api` accidentally left on `backendBaseUrl`
> (producing `/api/api/health`), still reaches a live server. Any reachability
> check that only asks "did the transport fail?" reports a **misconfiguration as
> Connected** — and sends the operator hunting for a network fault.
>
> Two corollaries, both handled in `services/api/health` (Epic 10):
> - Classify the outcome, don't reduce it to a boolean:
>   `ok` / `not-nbcg-api` / `server-error` / `unreachable` (`domain/connection`).
> - **Fetch the health body as text and parse it yourself.** Decoding it as JSON
>   throws a `SyntaxError`, which is *not* an `ApiError`, so a proxy landing page
>   or SPA `index.html` fallback falls through to the transport branch and gets
>   misreported as "unreachable".
>
> `domain/config.validateBaseUrl` rejects a trailing `/api` up front, since that
> is the mistake most likely to produce this.

### Backend internals worth knowing
- Storage: Postgres (drafts/records/item_relations/file_attachments), OpenSearch
  fed by **pgsync CDC** (search lag), SeaweedFS (blobs, best-effort delete →
  possible orphans), Tika (server-side extraction, skipped when `extractedTexts`
  supplied), Keycloak (JWT), BullMQ/Redis (`import-queue`, `pdf-extraction`).
- Deterministic COBISS ids: `sha256(cobissId) → base36`, 25-char cuid-like — so
  re-importing a COBISS id can't duplicate.
- `nbcg/todo` actually contains: `backend-archive-cobiss-preview.md`,
  `backend-archive-material-type-field-visibility.md`,
  `backend-file-download-cookie-auth.md`, `frontend-collection-views.md`,
  `README.md`, plus the one Epic 09 filed (2026-08-07, P3):
  `backend-archive-relations-return-parent-version.md`. The archive-integration
  todos the `nbcg-dc` docs cite (identity, schema-endpoint, replace-file, etc.)
  are **mostly not present** — several are already implemented in code, others
  were never filed.

---

## 5. What `nbcg-dc` has now (logic lane, Epics 01–08 + 10 — DONE)

Typechecks (`vue-tsc`) + builds (`vite build`) clean; **618 unit tests green**.
Last updated 2026-08-08 (the doc-vs-code review — see §10).

> The suite count is stated **here only**. It used to appear in four files with
> three different values (561 / 566 / 567), none of them current, because every
> pass added its own. Epic docs now say "the suite is green" and link here.

```
src/
  main.ts                     bootstrap: Pinia + router + boot()
  app/{router,config,boot}.ts 4-rail router; constants; startup (config → connection → batches → jobs → sync)
  domain/                     framework-free vocabulary (imports nothing)
    enums schema metadata metadata-form config connection naming files item
    overview batch parent provenance pipeline upload sync
  services/
    api/client.ts             base client: /api join, Bearer auth, typed ApiError, JSON/multipart/binary, timeout
    api/dto.ts                THE FULL VERIFIED BACKEND CONTRACT — start here for any API work
    api/{health,schema,cobiss,search,collections,relations,items,files}.ts
    config.ts backend.ts      config + token persistence, root probing, app version; the singleton ApiClient
    indexing.ts batches.ts    local index ↔ domain Item; batch persistence
    pipeline.ts upload.ts     the 5-stage run; create/replace + assets + relations + write-through
    sync.ts                   backend → archive refresh (Epic 08)
  ipc/{bindings,events}.ts    typed Rust command/event CONTRACT (Arch implements; tauri-specta will regenerate)
  stores/                     useSettings useConnection useToasts useItems useBatches
                              useBatchWork useProcessing useSync
  composables/                useOverview useBatch useBatches   (the rest deferred with the GUI)
  lib/logger.ts
```

> ### ⚠️ Real scans are JPG, and that broke the pipeline's input classification
>
> **Read [`05-real-scan-data.md`](05-real-scan-data.md) before touching
> `domain/pipeline`.** The first real scanner output (2026-08-07) showed the
> planning docs' assumption — TIFFs as the marker of "pages to assemble" — does
> not hold: everything is JPG. Three of four sample folders were mishandled, a
> 260-page book getting **no PDF and no OCR** because it matched the
> "graphical work" branch. Fixed by adding the **`page-images`** shape + the
> **`ContentKind`** override; verified against the real folders.
>
> Three durable rules came out of it:
> - **Never sort page images lexicographically** — `1, 10, 100, 2, …` silently
>   shuffles a book. Use `domain/naming.compareNatural`. The `.ts` lane hands the
>   runner `ItemRunRequest.pageImages` already ordered; the runner must not
>   re-sort. (`py/web.py` still sorts by plain filename — see docs/05.)
> - **Incoming scanner names ≠ our output convention.** `pageNumberOf` reads our
>   `<base>_<n>` outputs and rejects padding; `parseScanPageName` /
>   `detectPageSequence` read the scanner's padded/prefixed names. Don't conflate.
> - **A folder of images is ambiguous** — a book's pages or a standalone work —
>   and guessing wrong is damaging either way, so detection is always overridable.

- **`domain/naming.ts` is the single source of truth for the folder-derived
  naming convention** (Epic 10). Before it, the `_archive` / `_thumb` suffixes
  lived as string literals in `domain/files.ts` and `${folderName}.pdf` in
  `domain/pipeline.ts`; both now build on it. `extensionOf` / `baseNameOf` moved
  there from `domain/files.ts`. Anything that builds or parses an output filename
  goes through this module — including the Settings → Data reference screen, so
  the documented convention and the pipeline cannot drift.
- **Settings is a draft-and-Save form, not live write-through** (Epic 10).
  `stores/useSettings` keeps `config` (saved, what the app runs on) separate from
  `draft` (what is in the fields), with `dirty` / `canSave` / `validation` /
  `save()` / `revert()`. Test connection probes the **draft** through
  `services/backend.createApiClient()` — a throwaway client — so testing an
  unsaved URL never repoints the running app at an unverified host.

- **The typed contract lives in `src/services/api/dto.ts`** — mirror of §4.
  Every resource the archive needs is now built.
- **Epics 01–08 + 10 logic lanes are done.** Each task doc carries a
  "Progress — logic lane" section listing exactly what was built and what GUI and
  Arch still owe for that epic — read those before touching an epic's code.
- **Deferred by design:** most `composables/` (the Seam-1 view-models) land with
  the GUI, since a view-model with no view to bind is guesswork. The pattern is
  consistent across Epics 04/06/07/08/10.
- **`stores/useSettings` is the only store with unit tests** (25) — the draft-vs-
  saved ordering guarantees are the substance of Epic 10, so they are pinned.

> ### Three silent-failure bugs found by self-audit (2026-08-07) — all fixed
>
> Each produced a plausible-looking success, which is why none showed up in normal
> testing. Worth knowing because the *shapes* recur:
>
> 1. **Duplicate page numbers doubled the PDF.** A folder with two formats per page
>    (`1.jpg` **and** `1.png`) or mixed padding (`1` and `01`) parses to the same
>    page number, so the run silently contained every page twice.
>    `domain/naming.detectPageSequence` now reports `duplicates` and the plan warns.
>    Which copy to keep is a content decision, so it is flagged, not guessed.
> 2. **An empty folder was publishable.** With no assets, every stage is N/A →
>    recorded `skipped` → counts as satisfied, and `needsThumbnailChoice([])` is
>    false. So `processingComplete` was **true** and `uploadBlockers` was **empty**:
>    give it a title and it would publish a **record with no files** to the live
>    site. Added the `no-assets` blocker, and `planThumbnail` no longer reports an
>    `empty` folder's thumbnail as "resolved".
> 3. **`UPLOAD_MAX_FILES = 10` was declared but never enforced.** All WEB assets
>    went in one multipart request, so an item with >10 images `400`s the entire
>    upload. `domain/upload.uploadGroups` now chunks each role to
>    `MAX_FILES_PER_REQUEST`. This became reachable *at scale* by the new
>    `ContentKind: "graphical"` override — forcing a 260-page book to graphical
>    would have sent 260 files in one request.
>
> The lesson each time: **a rule stated only in a doc comment or a constant is not
> enforced.** `UPLOAD_MAX_FILES` sat in `dto.ts` for two epics with zero call sites.
- HTTP uses `@tauri-apps/plugin-http` (decision in `04-code-structure.md`).
- Deps added: `pinia`, `vue-router`, `@tauri-apps/plugin-http`, `@types/node`.
- Commands: `npm run dev`, `npm run build` (`vue-tsc --noEmit && vite build`),
  `npm test` / `npx vitest run`, `npm run tauri`.
- **TS target is below ES2022** — `Array.prototype.at()` is not available.

## 6. What each lane still owes

- **GUI:** everything `.vue`/`.css` — the 5 views + batch-work tabs, the rail /
  footer / toasts, and each epic's screen (see the per-epic "Owed by GUI"
  sections). Presentation imports composables + domain types only.
  **Flag, 2026-08-25:** this bullet and the composables list in §5/§7 read as
  if none of this exists yet. They're stale — a pass (commit `15511db`
  "Frontend v2, my TODO") already landed all 5 views, the three batch-work
  tabs (`SetupTab`/`MetadataTab`/`ProcessingTab.vue`), and most of the
  previously-"deferred" composables (`useProcessing`, `useMetadataForm`,
  `useBatchSetup`, `useSettingsScreen`, `useSyncScreen`, `useParentLinks`,
  `useConnection` all now exist under `src/composables/`). Verified for the
  Processing tab specifically this pass; the rest is reported from a directory
  listing, not individually audited — **treat this whole section as needing a
  real doc-vs-code pass**, the same kind §9/§10 did for the backend contract,
  before trusting its per-epic "Owed by GUI" detail.
- **Arch:** see [06-native-core-and-dev-setup](06-native-core-and-dev-setup.md)
  for the current, detailed state — this bullet is a stale high-level summary.
  As of 2026-08-24: `config_*`/`fs_*`/`index_*`/`batch_*`/`sync_*` are done;
  `jobs_*` runs for real across all six input shapes with genuine mid-process
  cancellation (`jobs_start`/`jobs_reprocess` moved off the main thread,
  `core::python` gained a real `Command::kill()` path); still owed there is the
  queue/OCR-aware concurrency cap and Epic 11 packaging. Also still owed:
  registering `tauri-plugin-http` with the backend host allow-listed (or client
  `fetch` is denied at runtime), and wiring `tauri-specta`. Two capability
  items are easy to
  miss because both fail *silently*: **`core:app:allow-version`** (or the Settings
  version line falls back to the compiled-in constant and drifts from the
  installed bundle) and the **`config_*_secret` commands** (or the Keycloak token
  lands in webview `localStorage` in plain text — the dev-only fallback).
- **Backend:** nothing required for any epic so far.

## 7. Roadmap / next work (logic lane)

Epics in [`tasks/`](tasks): 01 ✅ · 02 ✅ · 03 ✅ · 04 ✅ (store/composable
deferred) · 05 ✅ · 06 ✅ · 07 ✅ · 08 ✅ · 09 ✅ · 10 ✅ · 11 Packaging (Arch).

**The logic lane has no epic-sized work left.** What remains is the deferred
Seam-1 layer that lands alongside the GUI: `composables/useSettings`,
`useMetadataForm`, `useProcessing`, `useUpload`, `useSync`, `useBackendSearch`,
`useThumbnailPicker`, plus the Epic 04 metadata store. Each epic's task doc lists
its own deferred pieces under "Still owed by the logic lane".

**Two open decisions are blocking, and both are Jernej's**, not another lane's —
they are the only things in the logic lane waiting on a person rather than on the
GUI:

- [Cover shots & thumbnail choice](tasks/cover-shots-and-thumbnail-choice.md) —
  how a cover / non-page image is identified. Until it is answered, a book's
  open-binding shot is split down the middle and the title page is the thumbnail.
  It also decides where `BatchItemOverride` grows next.
- [Naming base §1](tasks/naming-base-and-unicode-filenames.md) — whether the
  operator may override the folder-derived naming base. `sa vodenim zigom`
  ("with a watermark", a scanning note) currently becomes an item's base name and
  its `metadata.json` key.

Neither is expensive to implement — `domain/naming` and `domain/batch` are
single-sourced — but guessing would bake in a transformation nobody asked for.

Two concrete follow-ups Epic 09 left behind, both in Epic 07's upload flow —
**resolved 2026-08-08:**

- ~~Re-read or invalidate a locally-tracked parent's `version` after
  `connectParents`~~ — **done.** `services/upload.applyParentStates` adopts the
  version the connect response already carries (no re-read; the relation edge is
  CDC-lagged independently of the item, so a read-back would not work anyway).
  Guarded by `domain/sync.resolveVersion` so a version never moves backwards.
- Filter the batch before any `transitionItems` call — **no call site exists.**
  Nothing in the archive calls `transitionItems`; publish target is chosen at
  create and a re-upload replaces. Wrapping it for zero callers would be
  speculative, so the trap stays documented at the call surface
  (`services/api/items.transitionItems`). **Whoever writes the first call must
  filter to ids currently in the *other* collection** — one already-transitioned
  id `400`s the whole batch.

## 8. Doc-vs-reality discrepancies (trust reality / this file)

1. **No identity/verify endpoint** — `docs` reference `GET /api/auth/verify` and
   `backend-archive-identity-verify.md`; neither exists. Not needed (see §3).
   Removed from the task docs.
2. **COBISS preview path** is `GET /api/import/cobiss/preview/:cobissId`, not
   `/api/cobiss/:id/preview`. A `404` = not-found **or** upstream-down.
3. **Schema already exposes** `parentInheritable` + `issueIdentifying` (docs said
   "needs adding"); it has **no `label`**.
4. **Optimistic concurrency already exists** — `expectedVersion` is required on
   `PATCH` (docs filed it as a future P3 task). Metadata is shallow-merged.
5. **File upload `role` is batch-wide, not per-file.** `replace-file` exists
   (`PUT /api/files/:fileId`).
6. **No collections endpoint** — parent list comes from search;
   `collectionType` is a **number** inside `metadata`.
7. **A search `404` is ambiguous** (see the box in §4) — the docs treated
   "tracked id 404s ⇒ orphaned" as straightforward; it is not, and a naive
   implementation would mass-flag drafts. Policy lives in `domain/sync`.
8. **`targetState` is not stored on the document** — it is the search index name.
9. **"Reachable" ≠ "the API is there"** — `/health` (wrong/empty prefix) is a
   `404` on the same host that serves `/api/health` as `200`, so a boolean
   transport check reports a misconfigured URL as Connected. See the box in §4.
10. ~~**The schema endpoint does not validate `level`**~~ — **FIXED 2026-08-07**:
    an unknown value is now a `400` (case-sensitive; `?level=` empty still means
    "all"). `services/api/schema` keeps its empty-field-list guard anyway, because
    a `200` with no fields is still possible from a transient fault and would
    silently empty the metadata form for 24h.
11. **`RootValidity` has a fourth state** (`unknown`) that Epic 10's spec does not
    list — there is no filesystem to probe outside Tauri, and both three-state
    answers would be wrong (see the Epic 10 doc).

Added by Epic 09 (2026-08-07), all verified against the backend source:

12. ~~**A no-op `PATCH` is not a version check.**~~ — **FIXED 2026-08-07**: the
    no-op return now sits *after* the existence and version guards, so a wrong
    `expectedVersion` is always a `409` and every success carries `{ version }`.
    Two things still hold: metadata of only-unknown keys sanitises to `{}` and
    counts as "nothing to write" (no `400` — validate keys against the schema),
    and `version` is a **write counter, not a change counter** (an identical
    re-write still bumps it — deliberate, documented backend-side).
13. **`POST /api/items/transition` is not idempotent** and fails as a batch: one
    id already in the target state `400`s the whole call.
14. ~~**`connect`/`disconnect` bump the parent's `version`** without reporting
    it~~ — **FIXED 2026-08-07**: both now return
    `{ parentId, version, childrenInDrafts, childrenInRecords }`, and `disconnect`
    is `200` (was `204`). `transition` likewise returns `{ id, version }[]`.
    Consumed as `ItemUploadResult.parentStates`. Still true: `updatedAt` does not
    move with the trigger, and children are CDC-lagged **independently** of the
    parent doc, so never read children back to confirm a connect.
15. **`jeGlavnoGradivo` is a dead constant** — hardcoded `true` on every create
    path, dropped by the PATCH sanitiser, never touched by a trigger, and never
    *read* by the website either (a type declaration in
    `nbcg/frontend/src/api/search.ts` and nothing more). It cannot be used to
    mark child/issue items — but nothing needs it to: **the archive's main-vs-
    child concept is local** (`ItemLevel` in `domain/item.ts`, driving
    `domain/metadata-form.fieldsForLevel` and `domain/provenance`). Backend tech
    debt, not an integration gap; no task filed.
16. **Replacing a file wipes its text unless `extractedText` is re-sent**, and an
    empty-string `extractedTexts` entry on upload does *not* suppress Tika.
17. **Schema `required` is a UI hint** — only a non-empty `title` is enforced.
```

---

## 9. The 2026-08-08 audit — what a live re-check found

Epics 01–11 were re-checked against the **running** backend and the actual code,
rather than against these notes. The contract held: **60/60 live checks passed**
(§4 is accurate as written, including all four 2026-08-07 backend fixes).

The code did not hold as well. **Five real defects**, four of them silent
successes — the shape this project keeps producing. Suite went 546 → 567 green.

| # | Defect | Why it was invisible |
|---|---|---|
| 1 | **Re-uploading Cyrillic files duplicated them.** `pushReplaceAssets` matched local↔backend files by **filename**, which the backend corrupts, so the match always missed and every re-upload added a second copy instead of replacing. | `201 Created`, both times. Live-verified: 2 attachments after 1 re-upload. |
| 2 | **A slow COBISS was reported as "Backend unreachable".** `previewCobiss` used the client's 30 s default; the backend's own upstream fetch also has 30 s, and our clock starts first — so the archive always aborted first. | The requirement was written in `dto.ts` **and** §4 here. Never implemented. |
| 3 | **A multi-PDF item could publish with an unresolved thumbnail.** The hard gate asked `files.needsThumbnailChoice`, which counts only images *already present*; a multi-PDF item's candidates are generated later, so it scored 0 and the gate never fired. | Epic 06's notes explicitly warned Epic 07 about this. The warning was not followed. |
| 4 | **The ContentKind override was inert.** `BuildRunOptions.contentKinds` said it was "sourced from `Batch.overrides`" — nothing did the sourcing, so every run planned `auto`. | A 260-page book misdetected as graphical still gets **no PDF and no OCR**; the override that exists to fix that did nothing. |
| 5 | **`Batch.stage` never advanced Setup → Metadata.** Only `initialStageFor` and `enterProcessing` ever wrote it. | Reopening a multi-item batch always landed on Setup, however much work was done. Added `enterMetadata`; the caller is a UI event, still owed by GUI. |

### The recurring shape, stated once

Every one of #2, #3 and #4 is the same failure: **a rule that existed only as
prose.** A doc comment saying "the timeout must exceed 30 s", a note saying "use
the plan's `needsChoice`", a field comment saying "sourced from
`Batch.overrides`". All three were correct, none was enforced, and nothing failed
until someone probed. This is the same lesson `UPLOAD_MAX_FILES` taught (declared
for two epics, never enforced).

> **If a rule matters, encode it where it is used** — a constant that is read, a
> function that is called, or a test that fails without it. If the object holding
> the data is already in scope, read it there rather than documenting that a
> caller should pass it. Prose is for *why*, never for *whether*.

Two more habits earned their keep:

- **Check that a new test fails without the fix.** Two of these fixes had tests
  that would have passed regardless; both were caught by reverting the fix and
  re-running.
- **Don't paste captured binary-ish strings into source.** The real mangled
  filename contains unprintable C1 bytes; a pasted copy silently lost six
  characters and the test passed for the wrong reason. `naming.test.ts` now
  *derives* it.

### Deliberately not done

- **Filtering before `transitionItems`** (long-standing §7 follow-up). There is
  **no call site** — nothing in the archive calls it. Wrapping it for zero callers
  is speculation; the trap stays documented at the call surface. Whoever writes
  the first call must filter to ids in the *other* collection.
- **A guard on "one item type per batch."** Enforced today by Overview's selection
  scoping only; a proper guard needs the item states at the call site. Recorded in
  [Epic 03](tasks/03-batches-and-lifecycle.md) as a decision, not an oversight.

---

## 10. The 2026-08-08 doc-vs-code review — reading the docs against the code

A pass over every `.md` in `docs/` against the code implementing it. The §9 fixes
all held up. Four new defects, three inert mechanisms, and a test gap. Suite
567 → **618**.

| # | Defect | Why it was invisible |
|---|---|---|
| 1 | **An empty OCR `.txt` still went into `extractedTexts`** — which stores `NO_TEXT` *and* enqueues Tika, overwriting it, for a file uploaded with `doOCR: false` precisely to avoid that. | `201 Created`. The rule was in `dto.ts` in capitals and enforced nowhere. |
| 2 | **`patchOnBackend` read `.version` off a possibly-empty PATCH body.** Against a pre-2026-08-07 backend that is a `TypeError` — not an `ApiError`, so it escapes the outcome mapping and reaches the operator raw. | Never hit, because the dev backend is current. `connectParents` twenty lines away guards the identical skew and explains why. |
| 3 | **`useSettings.save()` committed the config before the token write settled.** A failed token write left `config` naming the new host while the live client still called the old one — and `save()` returned `false`. | The only failure test covered the *other* branch. |
| 4 | **`useConnection.check()` did not join an in-flight probe**, so boot's fire-and-forget check and `useSync.initialise()`'s awaited one were two requests. | Both worked. It cost a round-trip, not correctness. |

### Three mechanisms that existed but were not connected

The §9 lesson, found three more times in one pass:

- **`enterMetadata` had no caller.** §9 recorded it as "fixed the half that is
  logic" and assigned the caller to GUI. But `useBatchWork.setTab` is a **Pinia
  store — `.ts`**, not GUI, so the fix was inert and the bug it addressed was
  still live. Now wired there.
- **`splitSpreads` had no `BatchItemOverride` field at all**, so every run
  hard-coded `false`. The one book that needs it (`ОКТОИХ петогласник 2`) could
  not be split by any code path. Field added; `buildRunRequest` sources it off the
  batch like `contentKinds`.
- **`primaryThumbnails`** — checked and left. Genuinely blocked on the Epic 04
  store, not overlooked.

> **A lane label is not an owner.** Twice now, work in the `.ts` lane has been
> parked on another lane by a doc note — `parentStates` ("the caller's job"),
> `enterMetadata` ("advancing on tab change is a UI event"). Both were sitting in
> stores, which are `.ts`. The GUI *triggers* these; it does not implement them.
> Before writing "owed by GUI", check which file the code would go in.

### The test gap this pass closed

**`services/api/client.ts` had no test file**, so nothing in the suite asserted
that the Bearer token reaches the wire — the single line every backend call in
the app depends on. The resource services do exercise the client through a fake
`fetchImpl`, but every one of their harnesses records `{method, url, body}` and
**drops headers**, so the gap was invisible from a coverage-by-proxy argument.
`client.test.ts` now covers auth, URL building, JSON/multipart bodies, the full
status→kind mapping, non-JSON error bodies, timeout vs. caller-abort, and the
`acceptStatuses`/304 path (36 cases).

### Doc repairs

- **Epic 05 had no `Progress — logic lane` section and every box unticked**, while
  the README and §7 both called it done and the code was fully built
  (`domain/parent`, `domain/provenance`, `services/api/{cobiss,collections}`). It
  also still cited `GET /api/cobiss/:id/preview` — the last file in the repo doing
  so — plus a "backend collections list" that does not exist and a
  "multiple records" error that was never a thing.
- **The suite total lived in four files with three values.** It is stated in §5
  only; epic docs say "suite green" and link there.
- **`[x]` meant two different things** (logic-lane done in 03/07/08/10, all-lanes
  done in 04/06). One convention, defined in
  [the roadmap](tasks/README.md#what-a-checkbox-means).
