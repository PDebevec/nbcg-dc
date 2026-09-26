# Metadata schema v2 in the archive app: what changed

> Implemented 2026-09-25/26 on branch `schema-v2`.
> Design: [`docs/superpowers/specs/2026-09-25-metadata-schema-v2-design.md`](../superpowers/specs/2026-09-25-metadata-schema-v2-design.md).
> Plan: [`docs/superpowers/plans/2026-09-25-metadata-schema-v2.md`](../superpowers/plans/2026-09-25-metadata-schema-v2.md).
> Backend contract and migration guide: nbcg `docs/shared/plans/metadata-schema-v2.md` and `…-archive-app.md`.

The app used to read `GET /api/schema/record` (v1) and let the operator pick a
"main" or "child" level by hand. It now reads `GET /api/schema/v2/record`: one
schema for every item. The schema's rules decide which fields show and which
are required, from the item's material type, collection type, its batch's
parents, and whether it is going to be a Draft or a Record. The backend runs the
same rules on every write, so the app checks an item the same way before it
uploads it.

## What the operator sees

**Metadata tab**
- The form is built from the schema's groups and fields. Field captions, help
  text and code-list labels are in Montenegrin (`cnr`); the app's own buttons and
  messages stay English.
- Fields appear, disappear and become required as the item changes:
  - A **Draft** needs a title, a material type and a collection type, plus a
    name for each corporate body and a URL for each electronic location entered.
  - A **Record** also needs its extent (text, video and sound items with collection type 0),
    a map's scale, and an issue's number and date under a serial.
  - Under a Serial parent, authors, ISBN and collection type are hidden.
- A note says how many more fields a Draft needs before it could be published
  as a Record.
- **Typeahead:**
  - Free hints (authors, edition, keywords, …) fill the box and can still be
    edited. Picking an author hint fills the first and family name.
  - Large code lists (language, relator, content type) are searched. There,
    picking a hint is the only way to add a value.
  - Lookups wait 250 ms and need the backend.
- **Other fields.** Fields the rules hide but that hold a value, such as COBISS
  data, sit in a collapsed "Other fields" section. They stay editable and still
  upload. The section opens by itself when one of its fields has an error.
- **Main/child switch removed.** The navigator pill shows "Standalone record",
  "In a collection" or "Issue of a serial", worked out from the batch's parents.
- **Draft/Record lock.** Once an item is on the backend, its Draft/Record
  switch is locked to the backend's state.
- The tab is read-only while its batch is uploading.
- **Parent banners:**
  - "can't be found": the search answered 404. This can be temporary, because
    search lags the database.
  - "no longer exists": the backend refused the parent during an upload with
    `PARENT_NOT_FOUND`. That stops the run and blocks the batch.
  - "couldn't load, check the connection", with a Retry button.

**Processing & Upload tab**
- "Go to processing" and the upload gate use the same check as the form.
- If the backend refuses an item with `METADATA_VALIDATION_FAILED`, the row
  lists one line per field, with its label (e.g. "Broj strana — required.").
  An **Edit metadata** button opens that item on the Metadata tab with
  validation shown.
- A new item is created together with its parents (`parentIds`). There is no
  separate connect call, and the parents' new versions are stored right away.
- **Clearing fields.** Emptying a field on an uploaded item and re-uploading
  clears it on the website: the PATCH sends `null`. Only fields the editor held
  and the operator emptied are cleared. Fields someone added on the website are
  never touched, and a taken-over (adopted) record never has fields cleared.

**Settings**
- "Refresh schema" now says so when the refresh failed or the backend sent an
  empty schema. Before, it always claimed success.

## How it works

| File | Role |
|---|---|
| `scripts/sync-schema-rules.ps1` | Copies the backend's `evaluate.ts` and `conformance.json`, and snapshots the live schema. Re-run it whenever the backend's rules change. |
| `src/domain/schemaRules.ts` (+ `.conformance.json`, `.schema.json`) | The backend's rule evaluator, byte for byte, with its test fixture and a schema snapshot. **Never edit by hand.** |
| `src/domain/schema.ts`, `schema.fixture.ts` | v2 types, `LABEL_LANGUAGE`, `labelText`; test builders `fieldV2`, `schemaV2`, `SNAPSHOT`. |
| `src/domain/schema-values.ts` | Values in the stored shape: normalise on the way in, prune on the way out, the local format check (numbers, partial dates, quantities), path helpers. |
| `src/domain/schema-form.ts` | Field kind, order, options, the shown/"other" split, path → field. |
| `src/domain/schema-check.ts` | `checkItem` (the save check), `publishNote`, `itemRole`, `violationMessage`. |
| `src/services/api/schemaV2.ts` | Fetches the schema (ETag, one check per session, a copy kept in `localStorage` under `nbcg-dc.schema.v2` for offline use). |
| `src/services/api/hints.ts` | Typeahead calls to `suggest.path` / vocabulary `search.path`. |
| `src/composables/metadataFieldViews.ts` | Pure builder of the form's field views and hint views. |
| `src/stores/useMetadata.ts` | Working values, per-item check and readiness, backend states, parents (loaded / search 404 / gone / failed), autosave, mirror reloads. |
| `src/services/upload.ts`, `src/domain/upload.ts` | Prune on v2, create with `parentIds`, `PARENT_NOT_FOUND`, validation errors by field, clearing emptied keys. |

**How a value moves through the app:**
1. COBISS, parent and file values are normalised once, when they enter the
   editor. The editor holds them in the backend's stored shape: codes or
   `{ code, en, cnr }` by `storeAs`, `{ value, unit }` for quantities, numbers
   as numbers.
2. Autosave writes the pruned values to `metadata.json`. That is exactly what
   an upload sends.
3. `checkItem` runs the vendored `checkMetadata` on those values, plus the
   local format check. It uses the batch's parents and the item's backend state
   (or its Draft/Record choice before the first upload).
4. An item is ready when nothing is missing or invalid and every batch parent
   has loaded and exists.

**Keeping `metadata.json` (the mirror) correct**
- The store re-reads each item's mirror after an upload run (in `finally`) and
  after a sync.
- Before every autosave, it re-reads the file on disk. It never writes over a
  mirror that already has a `backendId`, and skips the write if the item's
  folder has moved.
- After a run, an item that took over an existing record reloads its values
  from the new mirror, so a later retry can't clear that record's fields.
- A re-upload keeps the mirror's backend state; a PATCH never changes it.

**Level removal.** `level` is gone from the TypeScript side and from Rust:
Rust no longer reads `_level` or writes the column. The SQLite `level` column
stays, since it is nullable and dropping it would need a migration for no
benefit.

## Tests and checks

**Test suites**
- `npx vitest run`: 48 files, **1007 tests** passing. The baseline was 824;
  v1's test files were deleted.
- `npx vue-tsc --noEmit`: clean.
- `cargo test`: 149 passed, 1 ignored (unchanged by this work apart from the
  level removal).
- The vendored evaluator passes the backend's conformance fixture: 70 cases,
  including its `record` and `check` cases, which run against the live field
  list.

**Live check against the dev backend (2026-09-26, read-only)**
- The live schema equals the vendored snapshot.
- A refresh sends `If-None-Match` and gets `304`.
- A language search for "crn" returns Crnogorski as `{ code, en, cnr }`.
- The author suggest returns `{ firstName, familyName }`.
- A map (`em`) as a Record in a Collection needs its scale.

**Reviews**
- Each task was reviewed on its own.
- A final review of the whole branch found five cross-task problems, all fixed:
  1. A parent refused at upload didn't block the batch.
  2. A re-upload could store the batch's Draft choice over a Record's real
     state.
  3. The Setup tab could still autosave `backendId: null` during an upload.
  4. An adopted record could have fields cleared on a retry.
  5. There were test gaps on the clearing and stop paths.

## Still to do by hand

1. **Walk the cases in the app** (`npm run tauri dev`). First wipe the
   backend's test data and import the examples from the backend plan's deploy
   notes. The table below is from the plan's Task 18.

   | Case | Expected |
   |---|---|
   | A book, no parent, Draft: title + material type | Ready. The note says "1 more field needed to publish as a record." Upload creates a draft. |
   | The same, Record, no page count | Blocked at "Go to processing", with "Broj strana" marked required. |
   | An issue of *Pobjeda* (batch parent: Serial collection), Record | Authors, ISBN and collection type hidden; issue number and date required. Upload creates it under the serial with no separate connect. |
   | A map in "Old maps of Montenegro" (Collection) | Full form, including author and scale; scale required as Record. |
   | "Get data" on a book with COBISS 215 | Page count, keywords and summary filled; hidden-but-filled fields under "Other fields". |
   | Languages: type "crn" | Crnogorski offered; picking it adds a chip. |
   | Upload an item, then reopen it | Draft/Record switch locked, showing its backend state. |
   | Empty a field on an uploaded item and re-upload | The field is gone on the website. |
   | Remove a batch parent on the website, then upload | The batch stops with "The parent '…' no longer exists…"; the Metadata tab then shows that banner and the upload stays blocked. |
   | Force a backend refusal | The processing row lists the field with its label; "Edit metadata" opens that item with validation shown. |

2. **Tell the backend side** that v1 (`GET /api/schema/record`) can be removed
   (their phase B7), and tick the checklist in
   `nbcg/docs/shared/plans/metadata-schema-v2-archive-app.md`.
3. **When the backend's rules change:** run
   `powershell -ExecutionPolicy Bypass -File scripts/sync-schema-rules.ps1`,
   then `npx vitest run src/domain/schemaRules.test.ts`, and commit the three
   files if they changed.

## Decisions made during implementation

These go beyond the design doc; each was made while building and reviewing.

- **A parent that fails to load for a network reason:** the editor stays open
  with the parents that did load, the item is not ready, and a banner offers
  Retry. The upload waits for the batch's parents before it checks readiness.
- **A parent the backend refuses with `PARENT_NOT_FOUND`** is marked "gone" for
  the rest of the session, even if search still returns it. It blocks the batch
  until the app restarts.
- **The Metadata tab is read-only while its batch uploads.** On top of that, the
  store's autosave re-reads `metadata.json`, which protects every other path,
  such as the Setup tab.
- **Commit trailers** name the model that wrote each commit.
- The one-line hint list markup repeated in `MetaInput.vue` was left as is.

## Known follow-ups (not fixed)

- **The autosave guard is two steps.** Reading `metadata.json` and then writing
  it are separate calls. An upload's write landing exactly between them could
  still be overwritten. Only a conditional write in Rust ("never replace a
  mirror that has a `backendId` with one that has none") closes it fully. If it
  happens, SQLite keeps the link and a Sync repairs it.
- **The values reload after an adoption is unconditional.** An edit made in the
  Setup tab during that run is dropped, and a mirror that re-reads as nothing
  resets the editor to defaults. Nothing is written in either case. Suggested
  guard: take the values only when the re-read mirror has a `backendId`.
- A "gone" parent still counts as a linked, data-passing parent for prefill.
  Only its label and the upload gate change.
- Errors inside repeatable fields can show on the wrong entry when an earlier
  entry is empty, because the check runs on pruned lists.
- The single `authors[].role` value can't be cleared, only replaced.
- Settings → Refresh schema doesn't reach an already-open editor; the schema is
  loaded once per session.
- **Hint list polish:**
  - it flickers while typing;
  - it is mouse-only (no arrow keys, no listbox roles).
- A decimal can't be typed character by character into a quantity box ("90."
  snaps back to "90"). Extent is whole pages or minutes today.
- After a schema load failure, the fields card says "Loading…" under the error
  banner.
- A parent that failed to load is named by its id: a batch only stores parent
  ids.
- An item under a missing parent shows two blockers: the parent one and
  "metadata incomplete".
- **Test gaps:**
  - the composable's `setField` conversions;
  - the typeahead debounce/abort;
  - the "Edit metadata" focus jump;
  - event forwarding in `OtherFields`.
- `sync-schema-rules.ps1` copies the files before it fetches the snapshot, so a
  failed fetch leaves a new evaluator with an old snapshot. Re-run it.
- `useBatchWork.close()` doesn't clear a pending "Edit metadata" focus.
- `cargo fmt --check` reports older formatting drift in
  `src-tauri/tests/fs_core.rs`. That predates this work.
