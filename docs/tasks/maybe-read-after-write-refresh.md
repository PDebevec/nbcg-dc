# Maybe — Read-after-write on reopen (local-first refresh)

> Status: **MAYBE** — speculative, not scheduled. File it so it's not lost; if it
> never bites, we never build it.
> Relates to: [07 Upload & publish](07-upload-and-publish.md) ·
> [08 Sync & backend data](08-sync-and-backend-data.md)
> Last updated: 2026-07-25

## Is this even a problem?

We're not sure — that's why this is a "maybe". If it turns out to be a problem,
this is the plan; if not, we do nothing.

The concern is narrow. It is **not** an issue at upload: when we upload we get the
id back (maybe a URN) and store it in SQLite; the data we store is exactly what we
just sent, so there is nothing to re-read to be sure it's correct.

The only place it *could* show up is **reopening an already-uploaded item/batch** —
from the Overview table, or clicking off a done batch and back onto it — because on
load we want to show data **from the backend**, and the backend read-by-id
(`GET /api/search/:id`) is served from **OpenSearch**, fed asynchronously by the
pgsync CDC daemon. Right after an upload, that read can 404 or return stale data
until indexing catches up.

## Decision: no direct Postgres read

> **Adopted project-wide (2026-07-28):** 02/07/08/09 now route read-after-write
> through `GET /api/search/:id` + background refresh; the direct-read endpoint is
> dropped from the API contract.

We are **not** adding a Postgres read-by-id endpoint for this (i.e. we are choosing
**not** to build `nbcg/todo/backend-archive-direct-item-read.md`). It duplicates a
read path, adds surface area, and isn't needed. Instead:

**Treat the local copy as a cache, not as the source of truth** — and refresh in
the background.

## The approach (if we build it)

When reopening:

```
Open batch
  ↓
show local immediately
  ↓
background refresh
  ↓
backend succeeds
    replace local
  ↓
backend temporarily unavailable
    keep local
    show "Refreshing…"
  ↓
backend eventually succeeds
    update
  ↓
backend still fails after retries
    show warning
```

The difference that matters:

- The UI **never blocks** — the user always sees data immediately (the local
  mirror is a faithful write-through copy of the backend).
- But we're **never pretending everything is okay** — if the backend keeps failing
  after retries, we surface a warning rather than silently showing local as if it
  were confirmed.

## If/when it becomes a real problem

- **Distinguish transient lag from genuinely gone.** A 404 shortly after our own
  `uploadedAt` is almost certainly indexing lag → keep local, keep refreshing. A
  404 long after upload (or for an item we never marked uploaded) is the
  **orphaned** case → hand to [08 Sync](08-sync-and-backend-data.md).
- **Keep any warning / "orphaned" state soft and self-healing** — confirm over a
  couple of retries/syncs before alarming, and auto-clear on the next successful
  read, so a lag spike self-corrects instead of crying wolf.

## Tasks (only if picked up)

- [ ] On reopen (Overview open / re-enter batch), render from SQLite +
      `metadata.json` immediately — never block on the network.
- [ ] Kick off a **background** `GET /api/search/:id`; on success, reconcile and
      update the local mirror + the view.
- [ ] While the backend is unavailable/pending, keep showing local with a
      non-blocking **"Refreshing…"** indicator.
- [ ] After N retries with backoff still fail, show a **warning** (don't imply the
      data is confirmed fresh).
- [ ] Gate 404 handling on `uploadedAt` recency; a persistent 404 → soft
      **orphaned** (Epic 08), not a hard error.

## Trigger

Only pick this up if reopen-after-upload is actually observed showing stale or
missing data in practice. Until then: do nothing.
