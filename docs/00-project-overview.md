# NBCG-DC — Project Overview

> Status: understanding / planning
> Last updated: 2026-08-07

## What this is

**NBCG-DC** is a small desktop helper application (Vue 3 + Tauri, with Python
scripts doing the heavy file work) built for the **National Library of
Montenegro (Nacionalna biblioteka Crne Gore — NBCG)**.

Its job is to make it **fast and easy for library staff to upload scanned
records / drafts** into the library's website (a new site already built by our
team), correctly and with minimal manual effort.

## The problem we are solving

Today the library's workflow for getting scanned material online is painful:

- Staff scan documents.
- They then **type all metadata by hand** into a JSON / XML / Excel file.
- That file is somehow imported into their site.

This is slow, error-prone, and unpleasant. The core pain point is **inputting
records/drafts correctly**.

## The context we already have

- Our team has already built the library a **new website** that supports
  **ingestion** and a lot of related functionality.
- That website is **ours to change** — we can add or adjust endpoints and
  features as needed to support this application.
- We already have two working Python prototypes in [`py/`](../py):
  - [`ocr.py`](../py/ocr.py) — OCR for Montenegrin documents (Latin +
    Cyrillic), image or PDF → text.
  - [`web.py`](../py/web.py) — builds archival PDF, web-preview PDF, and a
    thumbnail from paired `jpg`/`tif` image folders.

## The solution we envision

A **small, simple desktop application** that:

1. **Connects to the user's local file system** — reads the folders of scans
   the library produces.
2. **Uses Python scripts to transform files** into the correct formats the
   site expects (archival/web PDFs, thumbnails, OCR text, correctly shaped
   metadata records).
3. **Talks to our website's API** — pulls existing data where helpful and
   **uploads records/drafts correctly**.

The guiding principle is **simplicity and speed for the user**: the fewest
clicks possible to go from "folder of scans" to "correctly uploaded record".

## Tech stack

| Layer            | Technology                                  |
| ---------------- | ------------------------------------------- |
| Desktop shell    | Tauri 2 (Rust)                              |
| Frontend UI      | Vue 3 + TypeScript + Vite                   |
| Local index      | SQLite (folders, processing & upload state) |
| Heavy file work  | Python scripts (PaddleOCR, Pillow, etc.)    |
| Backend / target | `nbcg` website API (NestJS/Prisma/Postgres) |

## Endpoints

Where the archive points. The two the app itself configures are
`backendBaseUrl` + `apiPrefix` (Settings → Configure; defaults in
`src/domain/config.ts`).

| What | Local dev | Production |
| ---- | --------- | ---------- |
| **`nbcg` API** | `http://localhost:3000` — also reachable on the LAN at `http://172.21.221.80:3000` | `https://api.nbcg.me` |
| **Keycloak** | `http://localhost:8082` (realm `nbcg`) | *(TBD)* |
| Keycloak admin console | `http://localhost:8082/admin/master/console/#/nbcg` | — |
| OpenSearch (backend-internal) | `http://localhost:9200` | — |

**The host does NOT include `/api`** — the backend sets a global `/api` prefix,
so the full URL is `<backendBaseUrl>` + `/api` + `<path>`, e.g.
`http://localhost:3000/api/health`. This resolves the open question flagged in
[PROJECT-KNOWLEDGE §4](PROJECT-KNOWLEDGE.md) (verified against the running
backend on 2026-08-07); keep `apiPrefix` at its `/api` default unless a reverse
proxy rewrites it.

**Auth** is a Keycloak bearer token — no login, no identity endpoint (see
[PROJECT-KNOWLEDGE §3](PROJECT-KNOWLEDGE.md)). Settings takes a Keycloak
**username + password** and the app mints/refreshes the token itself
(`services/keycloakAuth.ts`, 2026-09-02) — nothing to curl or re-paste by
hand anymore. The equivalent manual mint, useful for debugging outside the
app:

```bash
curl -s -d 'client_id=nbcg-web' -d 'grant_type=password' \
     -d 'username=<user>' -d 'password=<password>' \
     http://localhost:8082/realms/nbcg/protocol/openid-connect/token
```

> The account needs **view** scopes, not just `records:manage`/`drafts:manage`.
> `*:manage` implies view so a normal account is fine, but a write-only one
> makes every uploaded item read back as `404` — which breaks sync. See
> [Epic 08](tasks/08-sync-and-backend-data.md).

## Success criteria (draft)

- A staff member can point the app at a folder of scans and, in a few guided
  steps, produce a **correct record/draft uploaded to the site**.
- Manual metadata typing is **drastically reduced** (ideally near zero for the
  mechanical parts).
- The transformation steps (PDF building, OCR, formatting) run reliably from
  inside the app instead of being run by hand.

## Decisions so far

- **Connection model:** The `nbcg` backend is the **single source of truth**;
  the archive is a **thick client** + downstream local storage (SQLite index +
  per-folder `metadata.json`). Writes are write-through (backend first, then
  local); sync is one-way backend → archive. See [architecture](02-architecture.md).
- **OCR:** runs **on the archive** (PaddleOCR); the web PDF is uploaded with
  `doOCR=false` and the OCR text is pushed to the backend as an `extractedTexts`
  map (**implemented** — see
  `nbcg/todo/backend-archive-external-fulltext-ingest.md`).
- **Backend mapped:** the real `nbcg` API/data model has been surveyed (see
  [architecture](02-architecture.md)); required backend additions are filed in
  `nbcg/todo/backend-archive-*`.
- **Python invocation from Tauri:** _Decided later_ (sidecar / system / native).
  [`py/ocr.py`](../py/ocr.py) uses Linux-only `resource.setrlimit` — must be
  made Windows-safe.

## Interface model

The app is organised around **batches** and a four-destination rail
(Overview · Batches · Sync · Settings), per the **v1.4.0 design prototype** in
[`desktop-app-interface-design/`](../desktop-app-interface-design). Operators
group scans into batches, describe them (COBISS + parents), run the local
pipeline, and upload — one batch processing at a time. See
[concept & UX](01-concept-and-ux.md).

## Open questions (to resolve as planning continues)

See [03-open-questions.md](03-open-questions.md) — the batch model, batches being
local-only, per-workstation concurrency, folder-derived naming, visibility, and
the re-run/`/processed` lifecycle are now **decided**. Remaining items: target OS
(Windows-only confirmation), the exact field set (formalised by the backend
schema endpoint), and expected volumes/file sizes.

## Planning docs

Numbered docs in this `docs/` folder capture the plan. This file (`00`) is the
shared understanding; later docs break the work into TODO task lists.
