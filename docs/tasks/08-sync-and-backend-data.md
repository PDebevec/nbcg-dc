# Epic 08 — Sync & backend data

> Depends on: 01, 02, 09 · Blocks: 05 (parent-picker data) · (keeps the archive current)

Goal: the **Sync** screen and the one-way **backend → archive** refresh — pull
the newest catalogue metadata into the local archive, search backend records,
match them to local folders, and keep each folder's `metadata.json` fresh.
Backend is the single source of truth, so sync never pushes.

## Tasks

- [ ] **Sync screen**: header with source host (`api.nbcg.me`), **last-synced**
      and **next auto-sync** (every 6 h), and a **Sync now** action with a live
      progress bar + stage text ("Contacting…", "Requesting catalog metadata…",
      "Matching against archive records…", "Writing updated metadata…").
- [ ] **Four stat tiles** from the last run: records checked, metadata updated,
      up-to-date, missed.
- [ ] **Recent-syncs log**: per-run summary + detail + time, with a status dot
      (ok / warning) — warnings surface issues like a backend timeout ("2 missed
      — backend timeout").
- [ ] **Auto-sync scheduler**: run automatically every 6 h; the manual **Sync
      now** runs on demand; reflect running state (spinner, disabled button).
- [ ] **On-launch fetch**: query the backend so the archive opens with current
      catalog state (auth: static Keycloak bearer token from config).
- [ ] **Search UI**: browse/search backend records & drafts (`GET /api/search`,
      `GET /api/search/:id/children`) with filters, from inside the archive.
- [ ] **Match search results to local folders** by connected `backendId`; show
      which results are already local and which are web-only.
- [ ] **Refresh-local-only**: for records the archive already tracks, re-fetch
      backend metadata and **rewrite each folder's `metadata.json`** + the SQLite
      index. Does **not** create folders for web-only records.
- [ ] Respect **read-after-write lag**: treat `GET /api/search/:id` as
      eventually-consistent (CDC-fed); after our own writes trust the write
      response and refresh the local mirror in the background rather than assuming
      search is current (see [architecture](../02-architecture.md)).
- [ ] **Parent picker data**: search-backed selection of parents for linking,
      from the backend collections list (`{ id, name, collectionType, … }`) — flag
      which parents are **data-passing-eligible** by `collectionType` (feeds
      [Epic 05](05-cobiss-parents-and-provenance.md)).
- [ ] Handle **orphaned** items: if a tracked id 404s on refresh, flag the local
      folder "orphaned" (files kept; never auto-resurrect or merge).
- [ ] Clear **online/offline** indication (drives the rail footer); disable
      backend-dependent actions when offline.

## Acceptance

- The Sync screen shows source, last/next sync, live progress + stage, the four
  stat tiles, and the recent-syncs log with warnings.
- Auto-sync fires every 6 h and Sync now works on demand; both refresh
  `metadata.json` for tracked records without touching web-only ones.
- Search results are matched to local folders by id; a deleted-on-web record is
  flagged orphaned locally, not re-created.
