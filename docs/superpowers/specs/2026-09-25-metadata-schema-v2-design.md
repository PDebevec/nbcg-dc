# Metadata schema v2 in the archive app: design

Date: 2026-09-25 · Status: implemented on branch `schema-v2` (2026-09-26) — what was built, the checks run and the follow-ups are in [`docs/tasks/metadata-schema-v2.md`](../../tasks/metadata-schema-v2.md)

## Source of truth

The contract and the migration guide live in the backend repo (WSL `~/nbcg`,
from Windows `\\wsl.localhost\Ubuntu\home\jernej\nbcg`):

| File | What it holds |
|---|---|
| `docs/shared/plans/metadata-schema-v2.md` | The JSON contract, the rule language, validation on save |
| `docs/shared/plans/metadata-schema-v2-archive-app.md` | What this app must change: steps 1–11 and a checklist |
| `backend/src/modules/schema/rules/evaluate.ts` and `conformance.json` | The rule evaluator and its test fixture |

Backend phases B1–B12 are on dev as of 2026-09-25. The backend serves
`GET /api/schema/v2/record` at `http://localhost:3000/api`.

This document records how the app carries out the guide, and the choices
the guide leaves open. Where the two disagree, the guide wins.

## Decisions (app side)

| # | Question | Decision |
|---|---|---|
| 1 | Where the evaluator lives | `scripts/sync-schema-rules.ps1` copies `evaluate.ts` unchanged to `src/domain/schemaRules.ts`, together with `conformance.json` and a snapshot of `GET /api/schema/v2/record`. The snapshot is needed because the fixture's `record` and `check` cases run against the live field list. None of the three is edited by hand. It compiles under the app's `strict` and `noUnused*` settings (checked 2026-09-25). |
| 2 | What shape the editor holds values in | The shape the backend stores: an enum as the stored code or `{ code, en, cnr }`, depending on `storeAs`; a quantity as `{ value, unit }`; numbers as numbers. What autosaves to `metadata.json` is exactly what uploads. `metadata-wire.ts` (the conversion between bare codes and the stored shape) goes away. Values that arrive from COBISS, from a parent, or from an older file are normalised once, when they enter the editor. |
| 3 | Language for captions | Field captions and code-list labels are in `cnr`, because the app's code lists were already Montenegrin. The app's own buttons and messages stay English. One constant controls it: `LABEL_LANGUAGE`. |
| 4 | Caching the schema | The first read in a session sends `If-None-Match`. Later reads in the same session use memory. Settings → Refresh forces a new check. If the network fails, the app uses the copy it kept, so an open editor keeps working. The localStorage key is `nbcg-dc.schema.v2`. |
| 5 | What blocks an item | `checkItem` runs `checkMetadata` on the values an upload would send, plus a local format check for numbers, dates and quantities. `checkMetadata` does not check types; the backend's own format check does. The rules see the batch's parents, and either the item's backend state or, before its first upload, its Draft/Record choice. An item is ready when nothing is missing, nothing is invalid, and every batch parent has loaded with none missing. The same check runs at "Go to processing" and in the upload gate (`metadataReady`). |
| 6 | Draft/Record after upload | Locked to the state recorded in `metadata.json` (`targetState`). The metadata store re-reads an item's `metadata.json` after an upload and after a sync. This also fixes an existing bug: the store kept its pre-upload copy, so an edit after a partial upload could write `backendId: null` back to disk. |
| 7 | Hidden fields that hold a value | Shown in a collapsed "Other fields" section. They stay editable and upload as they are. |
| 8 | Typeahead | One hint list is open at a time; lookups wait 250 ms after typing, and only start after the schema's `minChars`. A free hint fills the box and can still be edited. For a strict (vocabulary) field, picking a hint is the only way to add a value. A hint on `authors` fills that author's sub-fields. Hints need the backend; there is no offline lookup. |
| 9 | Missing parent | If `GET /api/search/:id` returns 404 for a batch parent, every item gets a "can't be found" blocker. The wording is "can't be found", not "deleted", because the search index lags the database. If a create or connect returns `400 PARENT_NOT_FOUND`, the parent "no longer exists" and the upload run stops. Parent names come from the parent cache, or fall back to the id. |
| 10 | Upload | A new item is sent to `POST /api/items` with `parentIds`. The app adopts the `parents[]` versions straight after the create, before the files upload, and does not call connect. Re-uploads and taken-over records work as today: PATCH, then connect. |
| 11 | Validation errors | `METADATA_VALIDATION_FAILED` (and the older `PUBLISH_VALIDATION_FAILED`) show one line per field, with its label. The processing row gets an "Edit metadata" button, which opens the Metadata tab on that item with validation shown. |
| 12 | Clearing a field before a re-upload | The PATCH sends `null` for schema keys that the item had and the editor no longer holds; the local copy drops them too. Today a cleared field silently stays on the backend. |
| 13 | Main/child level | Removed from the TypeScript side: `Item`, the bindings type, the store, the form and `provenance`. The navigator pill shows "Standalone record", "In a collection" or "Issue of a serial", worked out from the batch's parents; `routeCase` reads the parents too. Rust stops reading `_level` and stops writing the column. The SQLite column itself stays, since dropping it would need a migration for no benefit. |
| 14 | Schema v1 | Deleted once everything above runs on v2: its types, its service, `metadata-form.ts`, `metadata-wire.ts` and their tests. After that the backend can remove v1 (their phase B7). |

## Accepted behaviour (not changed here)

- **Closing a batch after a failed upload changes its parents.** Closing the
  batch deletes the items this run created. Those items were linked to their
  parents when they were created, so each parent's version goes up. If the app
  keeps a local copy of that parent, the parent's next PATCH gets a 409, and
  the operator has to run Sync.
- **A mismatch on a taken-over record only shows up as a backend 400.** When
  an upload hits an existing record with the same COBISS id, the app only
  learns that record's state during the upload. Its own check had treated the
  item as new, so the backend's 400 is the expected way to find a mismatch.
- **"Can't be found" can be temporary.** Because search lags, a parent created
  moments ago may briefly show as "can't be found".

## Out of scope

- Looking up values offline (the app is always connected).
- Anything the backend or the library still has to decide: checking the
  Montenegrin captions, the library's review of the rule table, and
  `collectionType` values 2 and 5+.
