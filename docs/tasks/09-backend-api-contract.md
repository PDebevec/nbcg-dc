# Epic 09 — Backend API contract

> Depends on: — · Blocks: 04, 05, 07, 08, 10 · **Start early (Phase 0)**

Goal: nail down the real API between the app and the website. The site is
**ours to change**, so this is two-way design. Backend changes the archive needs
are filed in the **`nbcg` repo** under
[`todo/backend-archive-*`](../../../nbcg/todo); this epic tracks them and turns
the API into a firm, versioned contract.

## Capabilities (client need → endpoint → backend task)

| Capability | Endpoint (proposed) | `nbcg/todo` task | Status |
|---|---|---|---|
| **Auth & identity** — verify token → email + access level (Test connection, write-gating) | `GET /api/auth/verify` (or `/me`) | `backend-archive-identity-verify.md` | **new — must add** |
| **Metadata schema** — main + child field defs incl. parent-inheritable / issue-identifying flags | `GET /api/schema/record` | `backend-archive-metadata-schema-endpoint.md` | needs flags added |
| **COBISS preview** — fetch + parse by CG-ID, no persist | `GET /api/cobiss/:id/preview` | `backend-archive-cobiss-preview.md` | ✅ backend done · archive wire-up TODO |
| **External full-text ingest** — store archive OCR text, skip Tika | `POST /api/files/upload/:id` (multipart `extractedTexts` map, `doOCR=false`) + `PUT /api/files/:fileId/text` to reset | `backend-archive-external-fulltext-ingest.md` | ✅ implemented |
| **Attachment roles** — `FileRole { SOURCE, ARCHIVAL, WEB, THUMBNAIL }` on each upload | upload DTO **per-file** role (one multipart request carries mixed roles) | `backend-archive-file-attachment-roles.md` | ✅ implemented |
| **Replace file** — atomic swap of PDF + full text (re-upload) | `PUT /api/files/:fileId` | `backend-archive-replace-file.md` | filed |
| ~~**Direct item read**~~ — decided **not to build** (use `GET /api/search/:id` + background refresh; see maybe-read-after-write) | ~~`GET /api/items/:id`~~ | `backend-archive-direct-item-read.md` | ❌ dropped |
| **Optimistic concurrency** — `version` + `If-Match` → 409 | `PATCH /api/items/:id` | `backend-archive-optimistic-concurrency.md` | filed (P3) |
| **Relations integrity** — clean dangling relations/counts on delete | (internal) | `backend-item-relations-integrity.md` | filed (P3) |
| **Ingest / publish** — create-or-update honouring targetState + **visibility** | `POST /api/items`, `PATCH`, `POST /api/items/transition`, `POST /api/relations/connect` | *(exists)* | ✅ incl. `visibilityStatus` |
| **Search / children** — discovery for sync + parent picker | `GET /api/search`, `/:id/children` | *(exists)* | ✅ (CDC-lagged) |
| **Sync source** — catalogue metadata for tracked records; incremental "changed since" is optional | `GET /api/search` + `GET /api/search/:id` | *(exists)* | ✅ full re-fetch accepted; incremental TBD |

> **Item inventory is NOT a backend capability** — the archive discovers items
> from the local filesystem; the backend owns catalogue metadata only. **Batches
> are local-only** and need no backend API. **Naming is folder-derived** and needs
> no backend step. (See [decisions](../03-open-questions.md).)

## Tasks

- [ ] Confirm the **identity/verify** endpoint shape (email + access level + 401)
      and land the backend task — this unblocks Settings → Test connection.
- [ ] Extend the **schema endpoint** to expose per field the
      `parent-inheritable` / `issue-identifying` flags and the main-vs-child
      distinction the editor needs; agree label/type/required/enum shape + ETag.
- [ ] Confirm the **COBISS preview** response shape and error responses
      (not-found / multiple / upstream).
- [ ] Confirm the **files** contract: OCR text supplied as the `extractedTexts`
      JSON map (PDF filename → text) on `POST …/upload` with `doOCR=false`
      (**implemented**), `PUT /api/files/:fileId/text` to reset text after the
      fact, per-file **role**, and the **replace** endpoint (stable attachment
      id) for re-upload.
- [ ] Confirm **create/publish** honours `targetState` + `visibilityStatus`, and
      that `PATCH` shallow-merges only sent metadata keys.
- [ ] Confirm the **collections / parent-list** endpoint used by the parent picker
      — returns `{ id, name, collectionType, … }`; agree which `collectionType`
      value(s) are **data-passing** (serial-type; exact value(s) TBD, extensible).
- [ ] Confirm the **read-after-write** handling: **no direct read** — trust
      write responses and treat `GET /api/search/:id` as CDC-lagged (show local,
      refresh in background).
- [ ] Decide the **sync source** shape: accept the current full re-fetch of
      tracked records (`GET /api/search` + `GET /api/search/:id`) or add an
      incremental "changed since `<timestamp>`" endpoint keyed by `backendId` if
      sync runs get slow (spec §12-G — "ideally incremental").
- [ ] Document the **record/draft data model** (main vs child, parent links,
      required fields) as the shared reference; keep endpoint names in
      [architecture](../02-architecture.md) in step.

## Acceptance

- A written, versioned API contract the app can build against, with every row
  above resolved to a real endpoint or an accepted `nbcg/todo` task.
- The identity endpoint and schema-flags additions are agreed and filed.
