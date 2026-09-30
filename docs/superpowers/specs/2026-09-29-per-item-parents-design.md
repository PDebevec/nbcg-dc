# Per-item parent links — design

_2026-09-29 · status: proposed_

## Goal

Parent links belong to **items**, not to batches. Each item keeps its own list
of parents, a later batch shows that list, and removing a parent from an item
that is already on the backend unlinks it there at the next upload.

What prompted it: `CERNAGORA` was uploaded from Batch #002 under parent
`c5u91tqfdyu5lzc8ltn17zpfp` (the backend has the `item_relations` row). A new
batch of the same item (#006) showed **no** parents, because today:

- links live only on the batch row (`Batch.parents`), and a new batch starts
  with `parents: []` (`domain/batch.newBatchFields`);
- nothing reads links back — `metadata.json` has no field for them, and
  `hitToRemote` drops the `parent_relations` that `GET /api/search/:id` returns;
- so the new batch also checks the item's rules as if it had no parent (the
  role pill says "Standalone record").

A batch-wide list also cannot hold a batch made of item 1 (parent P1) and
item 3 (parent P2). Links are per item on the backend; the app should match.

## Decisions (from the brainstorm)

| Question | Decision |
|---|---|
| Where do links live? | **Per item.** The batch-level picker becomes a bulk edit that writes to every item. |
| Removing a parent from an uploaded item | **Unlinks it on the backend** at the next upload. |
| What the app keeps about existing links | The last-known backend list, in the item's `metadata.json`. The backend stays the source of truth. |
| Where unsent changes live | On the batch, per item, as **add / remove** changes — next to the per-item publish/visibility overrides. |
| A link change fails at upload | The batch stays open so the change can be retried. The item itself still counts as uploaded. |

Rejected:

- **A batch-wide list filled from the items** at batch creation: still can't
  hold P1 for one item and P2 for another.
- **A full list per item** instead of add/remove changes: an upload would undo
  links someone added on the website since the last sync.
- **Unsent changes written into `metadata.json`**: for an uploaded item that
  file is the copy of the backend the re-upload compares against. Mixing
  changes into it loses track of what to unlink.
- **A new SQLite column** for links: lost with the index. `metadata.json`
  already rebuilds the index and moves with the folder.
- **Reading links live from search** on every open: fails offline and right
  after an upload (search lags), and new items still need somewhere to keep
  their links.

## Terms

- **Backend links** — the parent ids the backend is known to have for an item,
  kept in its `metadata.json` as `parentIds`.
- **Pending changes** — a batch's unsent changes for one item: parents to add,
  backend links to remove, and which parent passes data.
- **The item's parents** — backend links + pending adds − pending removes. What
  the card lists, what the form's rules check against, and what an upload makes
  true on the backend.

```
metadata.json (in the folder)        batch → overrides[itemId].parents
  parentIds: [P1]                      { add: [P9], remove: [P1], passing: null }
            └───────────────┬───────────────┘
        the item's parents = [P1] + [P9] − [P1] = [P9]
                            │
     parent card · form rules · upload (link P9, unlink P1)
```

## Data

### `metadata.json` gains `parentIds`

```jsonc
{
  "backendId": "c2q6ty86tpp6p2tc5wf7twhqh",
  "version": 0,
  "targetState": "DRAFT",
  "visibilityStatus": "PUBLIC",
  "parentIds": ["c5u91tqfdyu5lzc8ltn17zpfp"],
  "metadata": { … },
  "syncedAt": "…"
}
```

- absent or `null` — not known yet (a mirror written before this change);
- `[]` — known: no parents;
- ignored while `backendId` is null: an item that was never uploaded has no
  backend links.

It is written **only from backend answers**: the create response, successful
link and unlink calls, the sync, and the one-off read below. Never from an
edit.

### Batch overrides gain `parents`

```ts
/** One item's unsent link changes in a batch. */
interface ParentChanges {
  add: string[];           // parents to link that the item doesn't have yet
  remove: string[];        // backend links to unlink
  passing: string | null;  // which of the item's parents fills its empty shared fields
}
BatchItemOverride.parents?: ParentChanges | null
```

`overrides` is already a JSON column, so this needs no SQL change. A batch with
no changes for an item shows exactly the item's backend links — that is what
fixes the CERNAGORA case.

`Batch.parents` is removed from the TS domain type, so the compiler lists every
place that still reads batch-wide parents. The SQLite column stays (dropping it
isn't worth a migration); after the v5 migration below it is always `[]`.

### Why add/remove and not a full list

The upload only touches what the operator changed. If someone adds P3 on the
website after the last sync, the item's parents become backend links (now with
P3) + adds − removes, and P3 survives. A stale backend list therefore never
causes a wrong write: linking a parent the item already has changes nothing on
the backend, and neither does unlinking one it no longer has.

## Keeping backend links current

- **Create** — the response's `parents[].parentId` become `parentIds` in the
  create's write-through.
- **Re-upload** — after the link calls, `parentIds` becomes the old list plus
  the links that succeeded, minus the unlinks that succeeded.
- **Sync** — `hitToRemote` reads `source.parent_relations`: pgsync writes `null`
  when there are none, so `null` → `[]`. A doc trimmed by `?fields=` lacks the
  key, so absent → unknown, and `projectMirror` keeps the previous list.
  `mirrorDiffers` compares the lists order-insensitively.
- **One-off read** — when the editor loads an uploaded item whose `parentIds`
  are unknown, `useMetadata.ensureItemLoaded` calls `GET /api/search/:backendId`
  once and writes the result into the mirror (re-read first; only that field
  changes). A `404` leaves it unknown; whether the record is gone stays the
  sync's call. This fills in items uploaded before this change; a sync run fills
  in all of them.
- **Search lag** — relation edges reach the index separately from the item doc,
  so a sync in the seconds after an upload can record a stale list. It corrects
  itself on the next sync. Given the add/remove model it can only mislabel the
  card for a while, never cause a wrong link or unlink. Accepted, as for the
  metadata today.

While an uploaded item's backend links are unknown (read still loading, or it
failed offline) the item is **not ready**, like a parent that hasn't loaded:
the rules need its parents, and the card can't offer removals. The existing
parents banner shows it with **Retry**.

## Upload

### New item

`POST /api/items` with `parentIds` = the item's parents (its adds). The backend
links and checks them in the create's transaction (B10). Unchanged: if the
response has no `parents` (an older backend), link afterwards as today and
record the ones that succeeded.

### Re-upload

1. `PATCH` the metadata — unchanged.
2. Write-through — unchanged.
3. Files — unchanged.
4. **Link** each pending add the backend links don't have yet.
5. **Unlink** each pending remove the backend links still have.
6. Adopt the parents' new versions: a disconnect bumps the parent's version
   exactly like a connect, and returns the same `RelationWriteResult`
   (`applyParentStates`, unchanged).
7. Write the new `parentIds`.

With no changes, no relation calls are made at all. Today every re-upload
re-connects every batch parent.

Details:

- **Link before unlink.** When an issue moves from one serial to another, the
  item never passes through a state with no serial, which the backend's re-check
  on each call could reject.
- **Unlink `404`** — the parent was deleted, and deleting an item deletes all
  its links (`items.service` delete). Counts as unlinked.
- **Unlink `403`** — no manage right on the parent's collection. A relation
  error, like a failed link.
- **`PARENT_NOT_FOUND` on a link** — still stops the batch (unchanged).
- **Backend-write mark** — `withBackendWriteMark` must also wrap the new
  `disconnectParent` dep. A run that only unlinks has changed the backend, so
  the batch must not be deletable afterwards.
- **Relation errors keep the batch open.** Today a failed link leaves the item
  `uploaded`, the batch archives, and the failure is only a line in the results.
  With removals that would silently drop an unlink the operator asked for. New
  rule: `allUploaded` also requires no `relationErrors`. The item stays
  `uploaded` (so close-time cleanup never deletes it), and the next upload
  retries only what didn't happen, because `parentIds` already includes the
  successes. `relationErrors` gain `action: "link" | "unlink"` for the message.

### Adopted record (create `409`)

The adopted record's own links come from the search hit it was resolved from
(`hitToExisting` carries `parent_relations`), and become its backend links. Then
pending adds are linked and **nothing is unlinked**: the operator never saw that
record's links, and it may be a librarian's own.

### Re-created orphan (`PATCH 404`)

Create with the item's parents (backend links + adds − removes). The old links
went with the deleted record.

### Known limit, and a backend follow-up

The backend checks a `PATCH` against the parents the item has **before** the
link changes, and each link or unlink against the fields **as already saved**.
The app checks the end state. So one rare edit can fail at the `PATCH` even
though the end state is valid: clearing a field that only the current parents
require while removing those parents (e.g. clearing an issue number and taking
the item out of its serial). The field error shows as usual. The workaround is
to upload the link change first, then the field change.

Optional backend follow-up: let `PATCH /api/items/:id` take `addParentIds` /
`removeParentIds`, apply them in the same transaction as the metadata, check the
end state once, and return each touched parent's state, as `POST /items` does
with `parentIds`. The app would use it when the response reports `parents` and
fall back to link/unlink otherwise, the same pattern as `linkedByCreate`.

## Editing

One composable drives both tabs: `useParentLinks(batch, targets)`, where
`targets` is the current item (Metadata) or every member (Setup). Link, unlink
and the passes-data toggle apply to each target.

### Metadata tab (per item)

- The card lists the **current item's** parents. A pending add shows **New —
  links on upload**. A pending remove stays in the list struck through, marked
  **Unlinks on upload**, with **Undo**. The destructive part is visible before
  anything is sent.
- The description changes from "Linked parents apply to the whole batch…" to
  "This item's parents. Changes are sent to the backend when the batch
  uploads."
- With more than one item in the batch, each search result also offers **Link
  to all N items**. Re-work batches have no Setup tab, so this is their bulk
  action. When that parent passes data, it fills each item's empty shared fields,
  as a single link does for one item today.

### Setup tab (fresh multi-item batches)

- The list shows every parent any member has, with **on all N items** or **on
  k of N items**.
- Link = every item. Unlink = every item. The passes-data toggle sets `passing`
  on every item that has that parent.
- It uses the same change rules, so a parent an item already has on the backend
  would become a pending unlink (visible on that item in Metadata). A fresh
  batch of new items has nothing on the backend to unlink.
- **Apply & continue** fills each item from its own passing parent.

### Data passing (per item)

`passing` lives in the item's pending changes. Linking a parent that is the
item's only data-passing-eligible one makes it pass (`passingAfterLink`).
Backend links never start as passing, so a
re-work batch doesn't fill an uploaded item's fields on its own. Unlinking the
passing parent clears `passing`.

### Rules and readiness (per item)

`useMetadata.checkOf(item)` uses the item's own parents. The navigator's role
pill (Standalone / In a collection / Issue of a serial), required fields,
"Still to fill" and the per-field source picker all follow the item. In a mixed
batch, items can differ. `batchParentsOf` becomes `parentsOf(item)`, which
`isReady` and `missingParentNamesOf` then use. The upload waits for each item's
parents (`useProcessing.upload`).

## Existing data

- **Items uploaded before this change**: `parentIds` unknown. Filled in by the
  one-off read on load, or by the next sync.
- **Live batches with batch-wide parents**: migration v4 → v5 copies each
  batch's `parents` into every member's `overrides[item].parents`
  (`add` = the ids, `passing` = the one with `passesData`) and sets `parents`
  to `[]`. Archived batches are left as they are.
- **An older app build** reading a new mirror: its Rust struct doesn't know
  `parentIds` and drops it on its next write. The new build then sees "unknown"
  and reads it again. Nothing breaks.

## Changes by lane

### Native (`.rs`) — Arch

- `dto.rs`:
  - `LocalMetadataFile.parent_ids: Option<Vec<String>>`, `#[serde(default)]`.
    **Required:** the struct is typed, and serde silently drops unknown fields,
    so a TS-only change would appear to save and then lose the ids.
  - New `ParentChanges { add, remove, passing }`, fields `#[serde(default)]`.
  - `BatchItemOverride.parents: Option<ParentChanges>`, `#[serde(default)]`.
  - `parents` on `BatchDto` and on the create payload gets `#[serde(default)]`,
    so the TS side can stop sending it.
- `core/db/mod.rs`: migration v4 → v5 (the fold above), `SCHEMA_VERSION = 5`,
  same guarded single-transaction style as the existing steps.
- No new commands and no new SQL columns.

### Logic (`.ts`) — Jernej

- `domain/metadata.ts`: `LocalMetadataFile.parentIds?: string[] | null`.
- `domain/parent.ts`: `ParentChanges`; `itemParentIds(backend, changes)`;
  `withParentLinked` / `withParentUnlinked` (link drops a pending remove, unlink
  drops a pending add or queues a remove, both keep `passing` valid);
  `linkChanges(backend, changes) → { connect, disconnect }`; `passingAfterLink`
  (which parent passes after a link — replaces `withDefaultPassing`, which would
  start a backend link passing on its own).
- `domain/batch.ts`: `BatchItemOverride.parents`; drop `Batch.parents`.
- `services/batches.ts`: stop mapping `parents`.
- `services/api/search.ts`: `hitToRemote` → `parentIds`.
- `services/api/relations.ts`: `disconnectParent(parentId, childId)`.
- `domain/sync.ts`: `RemoteRecord.parentIds`, `projectMirror`, `mirrorDiffers`.
- `services/upload.ts`:
  - ctx `parentIds` → `parentChanges`; create sends the item's parents;
    re-upload links/unlinks per `linkChanges`; unlink `404` = done; write
    `parentIds`.
  - adoption carries the hit's links and never unlinks.
  - `withBackendWriteMark` wraps `disconnectParent`; `allUploaded` requires no
    `relationErrors`; `relationErrors` gain `action`.
- `stores/useMetadata.ts`: backend links from the mirrors; `parentsOf(item)`;
  the one-off read in `ensureItemLoaded`; not ready while unknown.
- `composables/useParentLinks.ts`: `targets`; `ParentRowView` gains
  `status: "linked" | "new" | "unlinking"` and `count: { on, of } | null`.
- `composables/useMetadataForm.ts`, `useBatchSetup.ts`, `useProcessing.ts`: per
  item.

### GUI (`.vue`) — GUI dev

- `components/batch/ParentRecordsCard.vue`: the pending states (New / Unlinks on
  upload + Undo), the "on k of N items" count, and **Link to all N items** in the
  search results.
- `views/batch/MetadataTab.vue`: the new description.
- `views/batch/SetupTab.vue`: bind the counts.
- Where the upload results list relation errors: word them as link / unlink.

### Docs

- This repo: `docs/01-concept-and-ux.md` (Setup → Parent records),
  `docs/tasks/05-cobiss-parents-and-provenance.md`,
  `docs/tasks/07-upload-and-publish.md`, `docs/tasks/metadata-schema-v2.md`
  (lines 40, 92, 174), `docs/PROJECT-KNOWLEDGE.md` (line 685).
- `~/nbcg/docs/shared/plans/metadata-schema-v2-archive-app.md`: the "Order of
  calls" row ("Every item of a batch gets the batch's parents"), §3
  (`batchParentsMetadata`), §4 ("for the archive app, the batch's parents"), §8
  (upload with the batch's parents). No backend change is required.

## Testing

TypeScript (vitest):

- `domain/parent`:
  - the item's parents from backend links + changes;
  - link/unlink round trips (unlink a backend link → pending remove; link it
    again → nothing pending; unlink a pending add → gone);
  - `linkChanges` returns only real changes;
  - `passing` cleared when its parent goes, and defaulted on link.
- `domain/sync`: `parent_relations: null` → `[]`; a missing key keeps the
  previous list; `mirrorDiffers` ignores order.
- `services/upload`:
  - create sends the item's parents and records `created.parents`;
  - re-upload order PATCH → files → link → unlink;
  - no relation calls without changes;
  - unlink `404` counts as done;
  - a failed link keeps the item `uploaded` and `allUploaded` false;
    `parentIds` only gains the successes;
  - adoption records the hit's links and never unlinks;
  - a run that only unlinks sets the backend-write mark;
  - unlink states reach `applyParentStates`.
- `stores/useMetadata`:
  - a mixed batch checks each item against its own parents (roles differ);
  - the one-off read fills an unknown list and writes it; offline → not ready,
    then **Retry**.
- Composables: Setup link / unlink / passing across all members; Metadata per
  item; **Link to all N items**.

Rust:

- `LocalMetadataFile` and `BatchItemOverride` round-trip the new fields; files
  and rows without them still parse.
- v5 folds a live batch's parents into its members, leaves an archived batch
  alone, and is idempotent.

By hand, against the dev backend:

- The CERNAGORA re-work batch shows "Informacioni sistem u funkciji revizije".
  Remove it and upload: the `item_relations` row is gone and the mirror says
  `parentIds: []`.
- Batches of items 1–2 under P1 and items 3–4 under P2, then a batch of items 1
  and 3: each shows its own parent. **Link to all** P9, upload: both gain P9,
  nothing else changes.

## Out of scope

- A bulk unlink in the Metadata tab (Setup has it for fresh batches).
- Stopping only the affected items on `PARENT_NOT_FOUND` — the batch still
  stops.
- Showing or editing an item's children.
- The atomic backend `PATCH` (the follow-up above).
