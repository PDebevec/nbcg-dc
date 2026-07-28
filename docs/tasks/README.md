# NBCG-DC — Task Roadmap

> Status: planning — aligned to the **v1.4.0 design**
> Last updated: 2026-07-23

Phased task breakdown for building the app, restructured around the
**batch-centric** v1.4.0 design. Tasks are at "epic" altitude — each will be
split into finer steps when we pick it up. Checkboxes track progress; tasks
blocked on an answer in [open questions](../03-open-questions.md) are marked ⛔.

## Reading order

Start with [00-project-overview](../00-project-overview.md) →
[01-concept-and-ux](../01-concept-and-ux.md) →
[02-architecture](../02-architecture.md) →
[03-open-questions](../03-open-questions.md) →
[04-code-structure](../04-code-structure.md), then the epics below.

## Epics

| # | Epic | Area | Depends on |
|---|------|------|------------|
| 01 | [App shell & navigation](01-app-shell.md) | Tauri/Vue skeleton, 4-destination rail, router, config, auth | — |
| 02 | [Overview & local index](02-overview-and-index.md) | Arrivals table, filters, selection scoping, state machine, SQLite index | 01 |
| 03 | [Batches & lifecycle](03-batches-and-lifecycle.md) | Batch model (local), Batches list, create/open, 3-tab shell, single-run lock | 01, 02 |
| 04 | [Metadata editor & schema](04-metadata-editor-and-schema.md) | Metadata tab, dynamic form, main/child schema, navigator, validation, files strip | 01, 03, 09 |
| 05 | [COBISS, parents & provenance](05-cobiss-parents-and-provenance.md) | Setup tab, COBISS prefill, parent linking, provenance + per-field source | 03, 04, 08, 09 |
| 06 | [Processing pipeline & jobs](06-processing-pipeline-and-jobs.md) | 5-stage pipeline, job runner, Processing tab, rerun, dirty flag | 01, 02, 03, 04 |
| 07 | [Upload & publish](07-upload-and-publish.md) | Upload tab, create+assets+parents, visibility, write-through, re-upload | 02, 03, 04, 05, 06, 09 |
| 08 | [Sync & backend data](08-sync-and-backend-data.md) | Sync screen (6h auto, tiles, log), search, match, refresh-local | 01, 02, 09 |
| 09 | [Backend API contract](09-backend-api-contract.md) | Confirm/extend endpoints (see `nbcg/todo/backend-archive-*`) | — |
| 10 | [Settings & naming](10-settings-and-naming.md) | Settings screen (Configure + Data), Test connection, folder-derived naming | 01, 09 |
| 11 | [Packaging & distribution](11-packaging-and-distribution.md) | Windows build, Python bundling, updater, first-run | 01, 06, 10 |

> Backend changes the archive needs live in the **`nbcg` repo** under
> [`todo/backend-archive-*`](../../../nbcg/todo): identity/verify (new), schema
> endpoint (+ inheritable/issue flags), COBISS preview, external full-text
> ingest, replace-file, optimistic concurrency, attachment roles,
> relations integrity. Visibility already exists in the backend.

## Suggested phasing

- **Phase 0 — Foundations:** Epic 01; Epic 09 kickoff (the
  `nbcg/todo/backend-archive-*` changes, esp. **identity/verify** + the schema
  endpoint + external full-text ingest).
- **Phase 1 — Arrivals & batches:** Epics 02, 03. See the arrivals table with
  derived state; create/open batches.
- **Phase 2 — Processing (works offline):** Epic 06 — the PDF / OCR /
  thumbnail-generation stages, job runner, and single-run lock, tracked in SQLite.
  (Epic 06's Metadata-completion gate and multi-image thumbnail picker depend on
  Epic 04, so those slices land with Phase 3 — 06 is split across the two phases.)
- **Phase 3 — Describe:** Epics 04, 05, 08. Schema-driven editor, COBISS/parent
  prefill + provenance, live search + sync.
- **Phase 4 — Upload:** Epic 07. Closes the loop: batch → process → describe →
  upload → write-through → move to `/processed`.
- **Phase 5 — Ship:** Epics 10, 11. Settings/naming polish; packaged Windows
  installer for staff.

## Backlog (maybe)

Speculative items we've captured but not scheduled — build only if they turn out
to matter:

- [Read-after-write on reopen](maybe-read-after-write-refresh.md) — local-first
  cache + background refresh for reopening just-uploaded items (instead of a
  direct Postgres read). **MAYBE** — fix later only if it's a real problem.

The design lives in
[`desktop-app-interface-design/`](../../desktop-app-interface-design) (the
v1.4.0 prototype + its
[functional spec](../../desktop-app-interface-design-requirements.md)).
