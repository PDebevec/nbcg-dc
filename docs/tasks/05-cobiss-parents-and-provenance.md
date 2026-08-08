# Epic 05 — COBISS, parents & provenance

> Depends on: 03, 04, 08, 09 · Blocks: 07

Goal: the automation that makes the common cases near-zero-typing — the batch
**Setup tab**, COBISS prefill, parent linking, the serial-issue flow, and the
**provenance engine** that tracks where every field value came from. Implements
the four ingestion cases from [concept & UX](../01-concept-and-ux.md).

> **Status: logic lane (`.ts`) done.** See [Progress](#progress--logic-lane).
> This doc was left un-updated when the code landed and carried three stale
> contract claims until 2026-08-08 — see [Corrections](#corrections-2026-08-08).

**Lane legend:** `.ts` = Jernej (logic), `.vue` = GUI, `.rs`/`.py` = Arch.
✅ done · ◻ to do. Checkboxes track the **logic lane**, per the convention in
[the roadmap](README.md#what-a-checkbox-means).

## Provenance model

Every field value is `{ value, provenance ∈ {cobiss, parent, user}, sourceParentId }`.
Empty fields fill silently; a field the **user** already edited raises the
overwrite prompt. Provenance drives the coloured tags, the per-field source
picker, and conflict resolution.

## Tasks

### Setup tab (batch-wide defaults)

- [x] **Prefill from COBISS (batch)**: an optional batch COBISS ID that, on
      *Next → Metadata*, applies COBISS data to **all** items (provenance
      `cobiss`), overriding parent-inherited fields.
      — **`.ts` ✅** `applyCobiss` + `cobissValues` in `domain/provenance`; the
      batch `cobissId` field already lives on `domain/batch`. **◻ (logic)** the
      batch-wide "apply to all items" loop lands with the deferred metadata store.
      **`.vue` ◻** the field + Next action.
- [x] **Parent records (batch)**: search + link one or more parents (by id); a
      parent is **eligible to pass data** only if its `collectionType` is in the
      data-passing set (exact value(s) TBD, configurable). Among eligible parents,
      **exactly one passes data** at a time (toggle "can pass data" ↔ "passes
      data"); ineligible types link but never pass data.
      — **`.ts` ✅** `domain/parent`: `isDataPassingType` / `isEligibleParent` /
      `resolveLinkedParents` / `setDataPassingParent` / `toggleDataPassing` /
      `dataPassingParent` / `withDefaultPassing`, against
      `AppConfig.dataPassingCollectionTypes`. Search-backed lookup is
      `services/api/collections.searchParents` / `getParentById`.
      **`.vue` ◻** the picker + the toggle.
- [x] **Publish / Visibility controls** live here (Draft/Record ·
      Public/Private/Hidden) as **batch defaults** — each item can override them
      in its Metadata screen; semantics defined in
      [upload & publish](07-upload-and-publish.md).
      — **`.ts` ✅** `Batch.publish`/`visibility` + `resolveItemPublish/Visibility`
      (Epic 03). **`.vue` ◻** the two controls.
- [x] **Apply-to-all on Next**: copy the data-passing parent's shared fields into
      each item's **empty** matching fields (provenance `parent`), then, if a
      batch COBISS ID is set, apply COBISS to all fields (provenance `cobiss`);
      advance the batch to `metadata`.
      — **`.ts` ✅** the precedence rule (`fillValues` + `applyParentFields` +
      `applyCobiss`) and the stage advance (`domain/batch.enterMetadata`, wired
      through `stores/useBatchWork.setTab`). **◻ (logic)** the per-item loop, with
      the deferred metadata store. **`.vue` ◻** the Next action.

### Metadata tab (per item)

- [x] **COBISS per item**: enter a CG-ID → **Get data** calls the backend's
      synchronous preview and fills the fields **without persisting**. COBISS ids
      yield **deterministic** record ids, so the archive can compute the would-be
      id and detect "already imported" *before* creating.
      — **`.ts` ✅** `services/api/cobiss`: `previewCobiss` /
      `fetchCobissPreview` (failures folded into a branchable
      `CobissPreviewOutcome`) / `cobissCollision` / `cobissCollisionMessage`.
      **`.vue` ◻** the field + Get data button + the outcome messages.
- [x] **Overwrite prompt**: if a field already holds a **user** value, prompt
      **"Overwrite all"** vs **"Keep mine, fill empties"** before applying COBISS.
      — **`.ts` ✅** `CobissApplyMode` (`fill-empty` | `overwrite-all`) and the
      `OverwriteConflict[]` that `fillValues` returns, which is what the prompt
      is raised from. **`.vue` ◻** the prompt itself.
- [x] **Parent picker per item (many-to-many)**: link an arbitrary set of parents
      via `POST /api/relations/connect`; the graph may contain **cycles** (allowed
      by design) — don't assume a tree; guard local traversals against cycles.
      Linking a data-passing parent fills empty matching fields (provenance
      `parent`).
      — **`.ts` ✅** `domain/parent.collectAncestors` / `wouldCreateCycle` guard
      local traversal; `services/upload.connectParents` does the connect (one call
      per parent). **`.vue` ◻** the picker.
- [x] **One-parent-passes-data toggle** (per item, mirrors Setup): switching the
      source is one click; at most one parent passes data at a time.
      — **`.ts` ✅** `setDataPassingParent` / `toggleDataPassing` enforce the
      at-most-one invariant. **`.vue` ◻** the toggle.
- [x] **Per-field source picker**: when two or more linked parents could supply
      the same field, a picker lets the cataloguer choose **which parent**, or
      **Manual entry** (flips provenance to `user`).
      — **`.ts` ✅** `fieldSourceOptions` / `chooseFieldSource` in
      `domain/provenance`. **`.vue` ◻** the picker affordance.
- [x] **Serial/issue flow (case 4)**: on linking a serial parent, copy its shared
      fields into empty fields and flag the per-issue fields (volume/year, issue
      number, date) as **"Still to fill"**. Everything copied stays fully
      editable.
      — **`.ts` ✅** `applySerialParent` + `issueFields` + `stillToFill`, keyed off
      the schema's `issueIdentifying` flag (exactly two fields —
      `numberingAndDates`, `seriesVolume`; see [Epic 09](09-backend-api-contract.md)).
      **`.vue` ◻** the "Still to fill" markers.
- [x] **Case routing**: from level (main/child) + presence of COBISS ID + parents,
      drive the editor to the right behaviour per the four-cases table. COBISS and
      parents are **non-exclusive** prefillers; using one never blocks the other.
      — **`.ts` ✅** `routeCase` → `IngestionCase` (1–4) + `caseBehavior`.
      **`.vue` ◻** binding the behaviour to the form.

## Corrections, 2026-08-08

This doc kept three claims the verified contract had already overturned — it was
the last file in the repo still citing the first one as authoritative. Recorded
rather than silently deleted, because each was believed for a while:

| Was | Is |
|---|---|
| COBISS preview is `GET /api/cobiss/:id/preview` | `GET /api/import/cobiss/preview/:cobissId`. Corrected in [PROJECT-KNOWLEDGE §8.2](../PROJECT-KNOWLEDGE.md) and every other doc on 2026-08-07 |
| Parents come from "the backend collections list" | **There is no collections endpoint.** The picker is built on `GET /api/search`, and `collectionType` is a **number inside `metadata`**, not a column |
| Handle "not-found / **multiple** / upstream error" | There is **no multiple-records error** — `extractFirstRecordXml` takes the first hit. And a `404` conflates "no such record" with "COBISS upstream unreachable or timed out"; the client cannot tell them apart |

The third one has a consequence this epic's code has to live with: the "not
found" message must not promise the record does not exist. `fetchCobissPreview`
words it *"No COBISS record found for that ID (or COBISS is temporarily
unreachable)"* for exactly that reason.

## Progress — logic lane

**Status: done.** Typechecks (`vue-tsc`) + builds (`vite build`) clean; the pure
COBISS/parent/provenance rules are unit-tested (`domain/parent.test.ts` 22 cases,
`domain/provenance.test.ts` 24, `services/api/cobiss.test.ts` 14,
`services/api/collections.test.ts` 16).

- **`domain/parent.ts`** — the parent vocabulary + the two invariants:
  **eligibility** (`collectionType` ∈ the configured data-passing set) and
  **exactly one passes data**. Plus `collectAncestors`/`wouldCreateCycle`, because
  the relation graph is a **directed graph, not a tree** — the backend allows
  cycles, so any local traversal has to guard itself.
- **`domain/provenance.ts`** — the fill engine. One precedence rule expresses both
  flows the docs describe: empty fields fill silently; a `user` value is protected
  (and raises a conflict); a machine value is overwritten only when the incoming
  source outranks it (**COBISS beats a parent copy; a parent copy never clobbers**).
  On top of it: the source picker, the serial/issue split, and `routeCase`.
- **`services/api/cobiss.ts`** — the preview call and the branchable outcome. Its
  timeout is **45 s, deliberately above the backend's own 30 s upstream budget** —
  see [Epic 07 §Audit pass](07-upload-and-publish.md) for why equal budgets
  reported a slow COBISS as "backend unreachable".
- **`services/api/collections.ts`** — the parent lookup, delegating its HTTP to
  `services/api/search` so the deep-pagination guard, the `limit` clamp and the
  404 handling are shared. Its own job is the `hitToParent` projection.

### Still owed by the logic lane (`.ts`) — deferred with the frontend

The **metadata working-model store + `useMetadataForm` composable** (shared with
[Epic 04](04-metadata-editor-and-schema.md)) is what actually *drives* all of the
above: it holds the per-item values, runs the batch-wide apply-to-all loop, and
persists the resulting provenance map. Every pure piece it needs exists.

### Owed by GUI (`.vue` / `.css`)

The **Setup tab** (batch COBISS field, parent search + link list with the
eligibility/passes-data toggle, publish + visibility defaults, the Next action)
and the Metadata tab's per-item halves (COBISS field + Get data, the overwrite
prompt, the parent picker, the per-field source picker, provenance tags, and the
"Still to fill" issue markers). Binds composables only.

### Owed by Arch (`.rs`) / backend (`nbcg`)

**Nothing.** No IPC surface beyond the batch persistence Epic 03 already declared,
and no endpoint changes — `import:execute` on the static token is all the COBISS
preview needs.

## Acceptance

- Setup applies a batch COBISS ID and/or the data-passing parent's fields to all
  items on Next, with correct provenance.
- Typing a valid COBISS ID per item fills the form (cases 2 & 3); the overwrite
  prompt appears only when a user-edited field would be replaced.
- Linking a serial parent copies metadata and leaves only the issue fields to
  fill (case 4).
- With multiple linked parents, the per-field source picker chooses the parent
  (or Manual), and provenance tags reflect the choice.
