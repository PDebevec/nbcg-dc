# NBCG-DC — Task Roadmap

> Status: planning — aligned to the **v1.4.0 design**
> Last updated: 2026-08-08 · suite **618 green**

> ### Doc-vs-code review, 2026-08-08 (second pass)
>
> A review of every `.md` against the code that implements it. The five audit
> fixes below are all genuinely present. Four **new** defects and three inert
> mechanisms were found; all fixed in-lane. Suite 567 → **618**.
>
> - **07** — an **empty OCR `.txt` still went into `extractedTexts`**, which
>   stores `NO_TEXT` *and* enqueues the Tika run the upload exists to avoid. The
>   rule was in `dto.ts` and nowhere else. Also: `patchOnBackend` read `.version`
>   off a possibly-empty PATCH body, where `connectParents` beside it already
>   guarded the same deployment skew.
> - **10** — `useSettings.save()` committed the config before the token write
>   settled, so a failed token write left the UI naming the new host while every
>   call still went to the old one.
> - **08/01** — `useConnection.check()` did not join an in-flight probe, so every
>   launch spent two health requests learning one fact.
> - **Inert mechanisms** — `enterMetadata` had **no caller** (the doc assigned it
>   to GUI; the only sensible caller, `useBatchWork.setTab`, is `.ts`), and
>   `splitSpreads` had **no `BatchItemOverride` field at all**, so every run
>   hard-coded `false` and a landscape 2-up scan could never be split.
> - **Docs** — Epic 05 had no progress section and three overturned contract
>   claims; test counts disagreed across four files; `[x]` meant two different
>   things depending on the epic.
>
> `services/api/client.ts` also had **no test file**, so nothing in the suite ever
> asserted that the Bearer token reaches the wire. It does now (36 cases).

> ### Audit pass, 2026-08-08 — epics 01–11, logic lane
>
> All eleven epics were re-checked against the **running** backend and the actual
> code. The wire contract held (**60/60 live checks**); the code did not — **five
> real defects**, four of them silent successes. Fixed in-lane; suite 546 → 567.
> Per-epic detail is in each doc's *Audit pass* section; the cross-cutting lesson
> is in [PROJECT-KNOWLEDGE §9](../PROJECT-KNOWLEDGE.md).
>
> - **07** — Cyrillic re-uploads **duplicated** attachments (filename-keyed match
>   against a name the backend corrupts); COBISS preview timed out *before* the
>   backend's own 30 s budget and blamed the network; a multi-PDF item could
>   publish with an **unresolved thumbnail**.
> - **06** — the operator's **ContentKind override was inert**; every run planned
>   `auto`.
> - **03** — `Batch.stage` never advanced Setup → Metadata (the reducer landed;
>   its caller did not — see the second pass above).
>
> Three of these were rules that existed **only as prose** in a doc comment. See
> §9 for why that keeps happening and what to do instead.

Phased task breakdown for building the app, restructured around the
**batch-centric** v1.4.0 design. Tasks are at "epic" altitude — each will be
split into finer steps when we pick it up. Tasks blocked on an answer in
[open questions](../03-open-questions.md) are marked ⛔.

## What a checkbox means

**`[x]` means the logic lane (`.ts`) is done for that task**, not that the task
ships. Each ticked item carries per-lane annotations (`.ts ✅` / `.vue ◻` /
`.rs ◻`) naming what the other lanes still owe, and each epic repeats the totals
under *Owed by GUI* / *Owed by Arch*.

Two corollaries: a task with a `◻ (logic)` note left in it stays **unticked** —
the deferred store/composable pieces are logic-lane work, not someone else's — and
a task with **no logic-lane component at all** (Arch's atomic writes, the Python
invocation strategy) stays unticked until its owning lane finishes it.

This is stated here because the epics used to disagree: 03/07/08/10 ticked on
logic-lane completion while 04/06 held out for all-lanes completion, so `[x]`
meant two different things and Epics 04 and 06 read as unstarted when their
logic lanes were finished. One convention, defined once, at the cost of the
roadmap not doubling as a shipping tracker — which the per-lane annotations
cover better anyway.

## Reading order

Start with [00-project-overview](../00-project-overview.md) →
[01-concept-and-ux](../01-concept-and-ux.md) →
[02-architecture](../02-architecture.md) →
[03-open-questions](../03-open-questions.md) →
[04-code-structure](../04-code-structure.md) →
[05-real-scan-data](../05-real-scan-data.md), then the epics below.

> [05-real-scan-data](../05-real-scan-data.md) is measured from **actual scanner
> output** and overrides the earlier docs' assumptions about folder contents —
> notably that scans are JPG, not TIFF, which invalidated Epic 06's input
> classification until it was fixed on 2026-08-07.

## Epics

| # | Epic | Area | Depends on |
|---|------|------|------------|
| 01 | [App shell & navigation](01-app-shell.md) | Tauri/Vue skeleton, 4-destination rail, router, config, auth | — |
| 02 | [Overview & local index](02-overview-and-index.md) | Arrivals table, filters, selection scoping, state machine, SQLite index | 01 |
| 03 | [Batches & lifecycle](03-batches-and-lifecycle.md) | Batch model (local), Batches list, create/open, 3-tab shell, single-run lock | 01, 02 |
| 04 | [Metadata editor & schema](04-metadata-editor-and-schema.md) | Metadata tab, dynamic form, main/child schema, navigator, validation, files strip | 01, 03, 09 |
| 05 | [COBISS, parents & provenance](05-cobiss-parents-and-provenance.md) ✅ *(logic lane)* | Setup tab, COBISS prefill, parent linking, provenance + per-field source | 03, 04, 08, 09 |
| 06 | [Processing pipeline & jobs](06-processing-pipeline-and-jobs.md) | 5-stage pipeline, job runner, Processing tab, rerun, dirty flag | 01, 02, 03, 04 |
| 07 | [Upload & publish](07-upload-and-publish.md) | Upload tab, create+assets+parents, visibility, write-through, re-upload | 02, 03, 04, 05, 06, 09 |
| 08 | [Sync & backend data](08-sync-and-backend-data.md) ✅ *(logic lane)* | Sync screen (6h auto, tiles, log), search, match, refresh-local | 01, 02, 09 |
| 09 | [Backend API contract](09-backend-api-contract.md) ✅ *(logic lane)* | Contract verified live end-to-end; data model documented; 1 P3 backend gap filed in `nbcg/todo` | — |
| 10 | [Settings & naming](10-settings-and-naming.md) ✅ *(logic lane)* | Settings screen (Configure + Data), Test connection, folder-derived naming | 01, 09 |
| 11 | [Packaging & distribution](11-packaging-and-distribution.md) | Windows build, Python bundling, updater, first-run | 01, 06, 10 |

> Backend changes the archive needs live in the **`nbcg` repo** under
> [`todo/backend-archive-*`](../../../nbcg/todo). Most are already done: schema
> endpoint (inheritable/issue flags **present**), COBISS preview, external
> full-text ingest, replace-file, optimistic concurrency (**`expectedVersion`
> present**), attachment roles, and visibility all exist. **No identity/verify
> endpoint** is needed (single-user, static token — verified on use). See the
> verified contract in [`PROJECT-KNOWLEDGE.md`](../PROJECT-KNOWLEDGE.md).

## Suggested phasing

- **Phase 0 — Foundations:** Epic 01; Epic 09 kickoff (confirm the
  `nbcg/todo/backend-archive-*` changes, esp. the schema endpoint + external
  full-text ingest). Auth is a static token — no identity endpoint.
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
  installer for staff. Epic 10's logic lane is **done**; Epic 11 is Arch's.

## Follow-ups from the first real scan data (2026-08-07)

Not epics — findings from running the pipeline against actual scanner output
([05-real-scan-data](../05-real-scan-data.md)). Both are real work with owners.

| Task | Lane | Why it matters |
|------|------|----------------|
| [`py/` vs real scanner output](py-real-data-mismatches.md) | **Arch** (`.py`) | Five mismatches, three of them silent: `web.py` sorts pages lexicographically (**shuffles a 260-page book**), requires `jpg/`+`tif/` subfolders that no real folder has, and its output names mean the *opposite* of the convention for `<name>.pdf`. Plus UTF-8 stdout (a verified crash on Cyrillic folders) and `ocr.py`'s Linux-only `setrlimit`. **Epic 06 cannot run on real data until these are fixed.** |
| [Cover shots & thumbnail choice](cover-shots-and-thumbnail-choice.md) | logic (`.ts`) + **decision** | A scan folder is not homogeneous: front matter, text spreads, and a photograph of the open binding all sit together. The cover is the only badly-split image (0.76 balance vs 0.96 median) *and* is probably the best thumbnail — and it is last, not first. Needs a call on how non-page images are identified. |
| [Naming base & unicode filenames](naming-base-and-unicode-filenames.md) | logic (`.ts`) + **decision** | `sa vodenim zigom` ("with a watermark") is a scanning note, not an identifier, yet becomes the base name. And `ОКТОИХ петогласник 2.pdf` — Cyrillic **with spaces** — now goes through multipart upload, SeaweedFS, and download, none of it ever tested with a non-ASCII filename. `extractedTexts` is keyed **by filename**, so a mangled name loses the OCR text silently. |

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
