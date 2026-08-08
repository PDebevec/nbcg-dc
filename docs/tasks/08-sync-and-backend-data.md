# Epic 08 — Sync & backend data

> Depends on: 01, 02, 09 · Blocks: 05 (parent-picker data) · (keeps the archive current)

Goal: the **Sync** screen and the one-way **backend → archive** refresh — pull
the newest catalogue metadata into the local archive, search backend records,
match them to local folders, and keep each folder's `metadata.json` fresh.
Backend is the single source of truth, so sync never pushes.

## Tasks

- [x] **Sync screen**: header with source host (`api.nbcg.me`), **last-synced**
      and **next auto-sync** (every 6 h), and a **Sync now** action with a live
      progress bar + stage text ("Contacting…", "Requesting catalog metadata…",
      "Matching against archive records…", "Writing updated metadata…").
- [x] **Four stat tiles** from the last run: records checked, metadata updated,
      up-to-date, missed.
- [x] **Recent-syncs log**: per-run summary + detail + time, with a status dot
      (ok / warning) — warnings surface issues like a backend timeout ("2 missed
      — backend timeout").
- [x] **Auto-sync scheduler**: run automatically every 6 h; the manual **Sync
      now** runs on demand; reflect running state (spinner, disabled button).
- [x] **On-launch fetch**: query the backend so the archive opens with current
      catalog state (auth: static Keycloak bearer token from config).
- [x] **Search UI**: browse/search backend records & drafts (`GET /api/search`,
      `GET /api/search/:id/children`) with filters, from inside the archive.
- [x] **Match search results to local folders** by connected `backendId`; show
      which results are already local and which are web-only.
- [x] **Refresh-local-only**: for records the archive already tracks, re-fetch
      backend metadata and **rewrite each folder's `metadata.json`** + the SQLite
      index. Does **not** create folders for web-only records.
- [x] Respect **read-after-write lag**: treat `GET /api/search/:id` as
      eventually-consistent (CDC-fed); after our own writes trust the write
      response and refresh the local mirror in the background rather than assuming
      search is current (see [architecture](../02-architecture.md)).
- [x] **Parent picker data**: search-backed selection of parents for linking —
      flag which parents are **data-passing-eligible** by `collectionType` (feeds
      [Epic 05](05-cobiss-parents-and-provenance.md)). *(Correction: there is no
      backend collections endpoint; the list comes from `GET /api/search` and
      `collectionType` is a **number inside `metadata`** — see
      [PROJECT-KNOWLEDGE §4](../PROJECT-KNOWLEDGE.md).)*
- [x] Handle **orphaned** items: if a tracked id 404s on refresh, flag the local
      folder "orphaned" (files kept; never auto-resurrect or merge).
- [x] Clear **online/offline** indication (drives the rail footer); disable
      backend-dependent actions when offline.

## Progress — logic lane (`.ts`) pass, 2026-08-07

The Sync **backend connection + functionality** (Jernej's `.ts` lane) is built.
Typechecks (`vue-tsc`) + builds (`vite build`) clean; 102 new unit tests (409
green total). As in Epic 07, the checkboxes above reflect the **logic-lane**
work — the screen that renders it and the native commands behind it are the
handoffs below.

### The finding that shaped this epic

`GET /api/search/:id` is the archive's **only** way to read an item back (there
is deliberately no `GET /api/items/:id`). Reading the backend source
(`search.service.ts` + `resource-access.service.ts`) turned up the constraint
everything else had to be built around:

> **A 404 does not mean the record was deleted.**

The backend returns 404 for four indistinguishable situations — and that is
intentional, so a visibility miss cannot leak an item's existence:

1. **CDC lag** — pgsync has not indexed a just-written item yet;
2. **Visibility scope** — `PUBLIC` records are the baseline for everyone, but
   PRIVATE/HIDDEN need `records:view:private`/`:hidden`, and **drafts are
   invisible without an explicit `drafts:view:*` scope**;
3. **Infrastructure** — OpenSearch down or the index missing;
4. Actually deleted on the website.

Only (4) is an orphan. The naive reading — "404 ⇒ orphaned" — means an API token
without `drafts:view:*` would silently flag **every draft the archive ever
uploaded** as orphaned on the first sync. So orphaning is deliberately hard to
reach (see below), and this is the single most important thing to preserve if
this code is changed.

**Confirmed against the running backend + OpenSearch on 2026-08-07.** This is not
a hypothetical risk on this deployment — it is the current state:

| Probe | Result |
|---|---|
| OpenSearch `records` index | **9 records — all `PRIVATE`** |
| OpenSearch `drafts` index | **5 drafts — 3 `PUBLIC`, 2 `PRIVATE`** |
| `GET /api/search` anonymous | `total: 0` |
| `GET /api/search?type=drafts` anonymous | `total: 0` (a `200`, not a `401`) |

All 14 items are invisible without view scopes — including the three **PUBLIC**
drafts, which proves the draft rule independently of visibility status. A token
holding only `records:manage`/`drafts:manage` is fine (manage implies view), but
one narrowed to write-only scopes would 404 on **every item in this archive**, and
the naive policy would orphan all 14 on the first sync. `isRunSuspicious` turns
exactly that into a logged warning with no streaks advanced.

Other live probes, all matching what was built:

| Probe | Result |
|---|---|
| `?page=100&limit=100` | `400` "Page out of range: … from + size < 10000" — the client-side boundary is exact |
| `?page=99&limit=100` | `200` — confirms the boundary is not off by one |
| `?limit=500` | `400` "limit must not be greater than 100" — hence the client clamp |
| `GET /api/search/:id` (bogus) | `404` → `findById` returns `null` |
| `GET /api/search/:id/children` (bogus) | **`200` with an empty envelope, NOT a 404** |
| `GET /api/search/suggest?field=bogus` | `400` listing exactly the 15 allowlisted fields — matches `SUGGEST_FIELDS` |
| `GET /api/items/stats` (no token / garbage token) | `401` |
| `GET /api/search` (garbage token) | `200` — unauthenticated-OK routes never reject a bad token |

**Two corrections this shook out**, both now fixed in `dto.ts`:

- **`parent_relations` / `file_attachments` are `null`, not absent,** when empty —
  pgsync writes an explicit null. They were typed optional-only; they are now
  `| null`, and there is a regression test.
- **`version` starts at `0`**, which is falsy. Confirmed on a live record. Any
  truthiness check would silently drop it; the code uses `typeof`, and there are
  now tests at both the domain and service level pinning it.

The live document also carries a `_meta` key (pgsync bookkeeping) that the
schema file does not show; it is documented and ignored.

**Also verified from the backend source** (worth knowing, all now in `dto.ts`):

- the indexed document's exact shape, from
  `nbcg/infrastructure/docker/pgsync/schema.json` — the record/draft columns plus
  two pgsync joins (`file_attachments`, and `item_relations` **relabelled
  `parent_relations`**). **`version` IS indexed**, so a sync read can refresh the
  mirror's optimistic-concurrency counter;
- `_source` never includes `extractedText` on either search path (it can be
  megabytes), so per-item sync reads are cheap;
- an item's **`targetState` is not a field** — it is the index the hit came from
  (`records` / `drafts`), which is how sync detects a DRAFT↔RECORD transition
  made on the website;
- `GET /api/search/:id` ignores `?fields` and returns a constant `score: 1`;
- the deep-pagination wall is `from + limit >= 10000` → `400`;
- `GET /api/search/suggest` exists with a 15-field allowlist (bonus typeahead).

### What was built (logic lane `.ts`)

- **`domain/sync.ts`** (new, fully unit-tested) — the pure sync **policy**:
  - **orphan safety.** `nextMissStreak` advances a miss counter only for an
    *unambiguous* miss, and `isOrphaned` needs `ORPHAN_CONFIRMATIONS` (2) of them.
    Three independent guards must all pass: the item must be older than
    `ORPHAN_MIN_AGE_MS` (1 h, so CDC lag can never count), the run must not look
    systemically broken (`isRunSuspicious` — ≥50% of a run missing at once is a
    token/index problem, not deletions), and the miss must be a clean 404 rather
    than a transport failure. A confirmed orphan is a **flag only**: files are
    kept, never auto-resurrected or merged;
  - **the CDC-lag version guard.** `acceptRemoteVersion`/`resolveVersion` never
    let a version move *backwards*. Search lags writes, so a read can legitimately
    return an older `version` than the archive already knows; storing it would
    make the next `PATCH`'s `expectedVersion` stale and 409;
  - `projectMirror` (replaces the metadata blob **wholesale** — merging would
    resurrect fields deleted on the website) and `mirrorDiffers` (order-insensitive
    deep compare that **excludes `syncedAt`**, or every run would rewrite every
    folder and report everything as "updated");
  - `tally` + `summariseRun` → the four stat tiles, the ok/warning/error dot, and
    the operator summary; `nextSyncAt`/`isSyncDue` (6 h); the stage labels;
    `matchHitsToItems` + `syncableItems`.
- **`services/api/search.ts`** (new, tested) — `searchItems`, `findById`
  (404 → `null`, never an exception), `searchChildren`, `suggest`, and the
  bounded `searchAllPages`. Clamps `limit` to the backend's 100, and raises
  `DeepPaginationError` **before** issuing a request that could only 400.
  `searchIndexToItemType` recovers `targetState` from the index name.
- **`services/sync.ts`** (new, tested; **store-free + fully injectable** via
  `SyncDeps`, like `services/upload`) — `syncTracked()`, the run itself. It is
  **two-phase on purpose**: fetch everything, *then* interpret, because the
  meaning of one 404 depends on the whole run (a one-pass loop would have written
  the damage before it could tell). Bounded concurrency (4), and it **stops
  asking after 3 consecutive transport failures** — otherwise an unreachable host
  turns a 40-item sync into 20 minutes of certain 30 s timeouts. A failed run
  *resolves* as a recorded `warning`/`error` run rather than throwing.
- **`stores/useSync.ts`** (new) — live progress/stage, run history, the stat
  tiles, `syncNow`/`cancel`, and the scheduler. The scheduler is a **1-minute
  tick that asks whether a sync is due**, not a 6-hour timer: a long timer
  silently loses time across sleep/hibernate, so a suspended workstation would
  wake believing it had just synced. Due-ness is measured from the last
  **successful** run (an errored run must not push the next attempt 6 h out),
  with a 15-minute retry floor so an unreachable backend cannot be retried every
  minute forever. Concurrent calls join the in-flight run instead of racing.
- **`app/boot.ts`** — on-launch: load history → start scheduler → **await
  reachability** (the boot connection check is fire-and-forget, so reading
  `isOnline` immediately would always see "unknown" and skip the launch fetch) →
  sync if due.
  — **Corrected 2026-08-08:** awaiting it meant *opening a second probe*, because
  `useConnection.check()` did not join one already in flight — it only superseded
  it by generation. Every launch spent two health requests to learn one fact.
  `check()` now returns the in-flight promise, so this awaits **boot's** probe.
  Pinned by `stores/useConnection.test.ts` (the store's first tests).
- **`services/api/collections.ts`** — now delegates its HTTP to
  `services/api/search`, so the parent picker shares the pagination guard, the
  `limit` clamp, and the 404 handling. Its own job is just the `hitToParent`
  projection.
- **`domain/item.ts`** — `Item` gained `syncMissStreak`; "orphaned" is **derived**
  from it (`domain/sync.isOrphaned`), never stored, so a record that reappears
  stops being orphaned automatically.
- **`services/api/dto.ts`** — `IndexedItemSource` (the indexed doc, previously
  an untyped `Record<string, unknown>`), `IndexedFileAttachment`,
  `IndexedParentRelation`, the suggest types, and the two pagination constants.

### Owed by Arch (`.rs`) — three new IPC commands

All three are declared in `src/ipc/bindings.ts` with full doc comments:

- **`index_record_sync(itemId, SyncRecordDto) → IndexedItemDto`** — fold a sync
  read onto the item's row: `version`, `targetState`, `visibilityStatus`,
  `title`, `missStreak`, `syncedAt`. **Critical: it must NOT touch `uploaded`,
  `reupload`, or any stage status.** Sync is a read; changing those would move
  the item's derived state and, e.g., silently clear a pending re-upload. Null
  fields mean "leave unchanged" (notably a null `version` must not clear the
  stored one — it gates `PATCH expectedVersion`).
- **`sync_log_append(SyncRunCreateDto) → SyncRunDto`** and
  **`sync_log_list(limit?) → SyncRunDto[]`** (newest first) — the durable
  recent-syncs history. One small table; cap the retained rows natively.
- **`IndexedItemDto` gained `missStreak?: number | null`** (reads as `0`). One
  integer column. It is persisted rather than derived because orphaning must be
  confirmed *across* runs that are hours apart — an in-memory counter would reset
  on every relaunch and could never confirm.

### Owed by GUI (`.vue` / `.css`)

The whole **Sync screen**: the header (source host, last-synced, next auto-sync),
the **Sync now** button with its running/disabled state, the live progress bar +
stage text, the four stat tiles, and the recent-syncs log (status dot, summary,
expandable detail, time). Plus the **backend search/browse UI** (filters, result
rows, "already local" vs "web-only" markers from `matchHitsToItems`), the
**orphaned** badge on Overview rows, and disabling backend-dependent actions when
`useSync.canSync` is false. Binds a `composables/useSync` view-model only.

### Still owed by the logic lane (`.ts`) — deferred with the frontend

- `composables/useSync.ts` — the Seam-1 view-model the Sync screen binds
  (mirrors how Epics 04/06/07 deferred their composables with the GUI).
  `stores/useSync` is designed to be its thin target.
- `composables/useBackendSearch.ts` — the browse/search view-model over
  `services/api/search` + `matchHitsToItems` (filters, paging, local/web-only).

### Backend (`nbcg`) — nothing required

No endpoint changes are needed for sync. Two notes for the backend team rather
than asks:

- **The archive's token needs view scopes, not just write scopes.** With
  `records:manage` + `drafts:manage` alone the archive can upload but sees
  everything it uploaded as 404 on read-back — `*:manage` does grant full
  visibility per `visibilityFilter`, so this is fine today, but a token narrowed
  to write-only scopes later would break sync. The suspicious-run guard turns
  that into a visible warning instead of mass orphaning, but it is worth knowing.
- **Incremental sync is still not needed.** The full re-fetch is one
  `GET /api/search/:id` per tracked item at concurrency 4. If run times become a
  problem, a "changed since `<timestamp>`" query is the cheapest fix
  ([Epic 09](09-backend-api-contract.md) §sync source).

### Not yet built (noted)

- **Backfill of `metadata.json` for web-only records** — by design: sync never
  creates a folder for a record the archive does not track.
- **A "resolve orphan" action** (re-link to a different id, or forget the
  connection). Today an orphan is flagged and left alone, which is the safe
  default; add a deliberate operator action if it turns out to be needed.

## Acceptance

- The Sync screen shows source, last/next sync, live progress + stage, the four
  stat tiles, and the recent-syncs log with warnings.
- Auto-sync fires every 6 h and Sync now works on demand; both refresh
  `metadata.json` for tracked records without touching web-only ones.
- Search results are matched to local folders by id; a deleted-on-web record is
  flagged orphaned locally, not re-created.
