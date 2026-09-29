# Delete batch — design

_2026-09-29 · status: implemented (plan: `docs/superpowers/plans/2026-09-29-delete-batch.md`)_

## Goal

An operator can **delete** a batch they have decided not to go through with.
Deleting puts every item back exactly as it was before the batch was created:

- an existing item (Done, Stopped, Needs re-upload) gets back its previous
  files, `metadata.json` and index state;
- a new item (Unprocessed) loses everything the batch produced — generated
  PDFs, thumbnail, OCR text, `metadata.json`, a supplied PDF filed into
  `source/` goes back where it was — so the folder is as it was scanned.

Two entry points, both behind a confirmation: a delete button on each card in
the **Batches** list, and **Delete batch** at the top right of the batch
workspace.

## Decisions (from the brainstorm)

| Question | Decision |
|---|---|
| How far does the undo reach? | **Local only.** Delete is offered only while the batch has sent nothing to the backend. After that it is disabled with a reason; **Close batch** remains the way out. |
| Which folder changes are undone? | **Exact pre-batch folder.** Every file the item folder had when the batch was created comes back; every file added since is removed — whether the app made it or the operator dropped it in by hand. The confirmation lists all of it first. |
| How is the pre-batch state kept? | **Hard-link snapshot beside the archive** (approach A), with a per-file copy fallback where the drive can't hard-link. |

Rejected: a full copy into AppData (GBs per batch, slow create, fills C:), and a
back-up-just-before-writing journal (can't restore a file removed by hand, and
every write path would have to remember to journal).

## Terms

- **Item scope** — what one item owns inside its folder: the folder's direct
  files, plus the `source/` subfolder (`core::fs::SOURCE_SUBFOLDER`, where a
  supplied PDF is filed). Other subfolders are separate items (nested records)
  and are never touched. `.nbcg-tmp-*` staging folders are the app's scratch
  space: never snapshotted, always removed on restore.
- **Snapshot** — the item scope as it was at batch creation (as hard links or
  copies), plus the item's index state.
- **Legacy batch** — a batch created before this feature, so it has no snapshot.

## What a snapshot holds

Per member item, taken at batch creation:

1. **Files** — every file in the item scope, hard-linked into
   `<item's root>/.nbcg-snapshots/<batchId>/<itemId>/` (with `source/` kept as a
   subfolder there). If `std::fs::hard_link` fails for a file (FAT/exFAT, some
   network shares), that file is copied instead.
   - The snapshot lives **under the item's own scan root** so it is always on
     the same volume as the folder, which is what makes hard links possible.
     Roots may be on different drives; each item uses its own root.
   - Keyed by item id, not relative path, so a nested item's snapshot never
     sits inside its parent's.
   - The scanner already skips dot-folders at every depth, so `.nbcg-snapshots`
     never shows up as an item.
2. **Index state** — in a new table `batch_snapshots`, two JSON copies of the
   same moment: `item_row`, the raw `items` row as a column → value map (so a
   delete restores every column, including ones `IndexedItemDto` doesn't
   carry), and `item_dto`, the `IndexedItemDto` with its stages and assets
   (what the preview shows as "returns to", and where the stages and assets
   are restored from).

Why hard links are safe here: every write the app makes replaces a file through
temp-file + rename (`write_metadata`, `finalize_staged_output`), and renames
over a hard-linked file leave the snapshot's copy untouched. The same holds for
a file deleted by hand. **Known limit:** a program that edits a file *in place*
(rather than writing a new one and renaming) changes the snapshot too. The app
never does this; most editors don't.

The snapshot costs no disk space while nothing changes. Once a file is replaced
or deleted, the old version's space stays in use until the batch ends — the
price of being able to bring it back.

## Lifecycle

- **Created** in `batch_create`, *before* the DB transaction: snapshot every
  member, then run the existing create transaction plus the `batch_snapshots`
  inserts. If snapshotting fails, no batch is created and the partial snapshot
  folder is removed. If the transaction fails, the snapshot folder is removed.
  `batch_create` runs off the UI thread (async command / `spawn_blocking`) so a
  copy fallback on a slow drive doesn't freeze the window; **Create batch**
  shows a busy state until it returns.
- **Dropped** when the batch is archived (`batch_archive` — a finished upload or
  **Close batch**): from then on Delete is impossible, so the snapshot only
  holds disk space. Removes the `batch_snapshots` rows and the snapshot folders.
- **Dropped** when the batch is deleted (below).
- **Swept** at startup: any `.nbcg-snapshots/<batchId>` whose batch is missing or
  archived is removed (covers a crash between a DB commit and a folder delete).

Membership is fixed at creation today (nothing in the UI adds items to an
existing batch). `batch_update` therefore refuses to **add** a member that has
no snapshot, so a future "add items" feature can't silently create an item that
Delete wouldn't restore. Removing a member keeps today's behaviour (the item is
released, its changes kept) and drops its snapshot.

## "Has this batch reached the backend?"

A re-work batch of Done items is made of items that are already uploaded, so
item state can't answer this. Instead the batch gets a persisted mark:

- New column `batches.backend_touched_at` (null until set).
- `useUpload.run` passes `uploadBatch` a deps override built by a new
  `withBackendWriteMark(deps, mark)`. It wraps every backend-**mutating** dep
  (`createItem`, `updateItem`, `uploadFiles`, `replaceFile`, `setFileText`,
  `connectParent`). The first such call in the run awaits `mark()`, which
  persists `backend_touched_at` through a new `batch_mark_backend_touched`
  command, and only then makes the request. Reads (`listFiles`, schema,
  search) never mark.
- **Fails closed:** if the mark can't be saved, the write is not attempted and
  that item's upload fails with the error. Better a failed upload than a
  batch that claims to be deletable after it touched the backend.
- An upload that fails before any write (e.g. 401) leaves the batch deletable.

## When Delete is allowed

A pure `deleteBlockedReason(batch, { uploading })` in `domain/batch.ts`, used by
both buttons (disabled + the reason as tooltip) and re-checked natively by
`batch_delete`:

| Condition | Reason shown |
|---|---|
| `batch.running` | "Stop the processing run before deleting this batch." |
| its upload is running | "Wait for the upload to finish." |
| `archivedAt` set | "Uploaded batches can't be deleted." |
| `backendTouchedAt` set | "This batch has already sent changes to the backend, so it can't be undone. Use Close batch instead." |
| otherwise | allowed |

## Preview (the confirmation's content)

`batch_delete_preview(batchId)` → `BatchDeletePlanDto`, read-only:

```
{ batchId, hasSnapshot, blockedReason: string | null,
  items: [{ itemId, folderName,
            before: IndexedItemDto | null,   // the snapshot's index state
            remove: [{ path, generated }], restore: [path] }] }
```

- `remove` — files in the item scope now that aren't in the snapshot, plus any
  `.nbcg-tmp-*` folder. `generated` is true when the name matches the app's own
  outputs (`<name>.pdf`, `<name>_archive.pdf`, `<name>_thumb.png`, `<name>.txt`,
  `metadata.json`, page-numbered variants), so the dialog can mark everything
  else as **"not made by the app"** — a hand-added file is never removed
  without being named.
- `restore` — snapshot files that are missing now or differ (size or modified
  time) from the file in the folder.
- `before` is the snapshot's index state in the same shape `index_list` returns
  (null for a legacy batch). The TS side maps it with `toItem` and runs
  `deriveItemState`, so the dialog can say "returns to Unprocessed" using the
  same rule as the Overview.

## Delete

`batch_delete(batchId)`:

1. Re-check eligibility natively (running, archived, `backend_touched_at`);
   refuse with the reason otherwise.
2. **Files, per item** — make the item scope match its snapshot:
   recreate the folder if it's gone; delete every file not in the snapshot;
   remove `.nbcg-tmp-*`; for each snapshot file that is missing or differs,
   hard-link (or copy) it to a temp name and rename it into place; remove
   `source/` if the snapshot has none. Idempotent — running it twice is safe.
   Every item is attempted; failures are collected.
3. If any item failed → return an error naming each item and why (e.g. a file
   open in another program). **The DB is not touched**, the batch stays, and a
   retry finishes the job (step 2 is idempotent).
4. One transaction: write each item's snapshot index state back (UPDATE the row,
   or INSERT it if a rescan dropped it; replace its stages and assets). The
   batch's claim is cleared in the same UPDATE, and only if the item is still
   claimed by this batch, so `updated_at` stays the snapshot's. Then delete the
   `batch_snapshots`, `batch_items` and `batches` rows. For a **legacy batch**
   this step only releases the items (`batch_id = NULL`) and deletes the batch
   rows.
5. Remove the snapshot folders — best effort; the startup sweep catches leftovers.

**Batch numbers are never reused.** Today the next number is
`MAX(batch_no) + 1`, so deleting the newest batch would hand its number to the
next one. Numbering moves to a stored counter (new `counters` table, seeded
from the current `MAX(batch_no)` by the migration).

## Schema migration (v3 → v4)

- `ALTER TABLE batches ADD COLUMN backend_touched_at TEXT`
- `CREATE TABLE batch_snapshots (batch_id TEXT NOT NULL REFERENCES batches(id)
  ON DELETE CASCADE, item_id TEXT NOT NULL, snapshot_dir TEXT NOT NULL,
  item_row TEXT NOT NULL, item_dto TEXT NOT NULL, taken_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, item_id))`
- `CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)` +
  seed `('batch_no', COALESCE(MAX(batch_no), 0))`
- Same guarded, single-transaction style as the existing steps.

## Frontend

- **IPC / service:** `batch.deletePreview`, `batch.delete`,
  `batch.markBackendTouched` in `ipc/bindings.ts`; `BatchDto` gains
  `backendTouchedAt`; wrappers in `services/batches.ts`.
- **Domain:** `deleteBlockedReason`, the plan types, and "state after delete"
  in `domain/batch.ts`.
- **Store (`useBatches`):** `remove(batchId)` calls `batch_delete`, drops the
  batch from the collection and rescans (`useItems.refresh`).
- **Delete action (`useDeleteBatch.confirm`):** first tells `useMetadata` to
  `forget` the members — cancelling pending autosaves, which would otherwise
  write the deleted batch's edits back into the restored folders, and dropping
  their in-memory values so a later batch re-reads `metadata.json` — then
  calls `remove`, then clears the batch's `useUpload` results. (`useProcessing`
  holds nothing batch-keyed to clear; its only per-batch state is the running
  batch, which can't be deleted.)
- **Dialog:** a new `components/batch/DeleteBatchDialog.vue` bound to a small
  `useDeleteBatch` composable (open → load preview → confirm → delete, with
  busy and error states), following the Close-batch dialog pattern in
  `ProcessingTab.vue`. Content: "Delete Batch #003?", per item the files to be
  removed (hand-added ones flagged) and restored and the state it returns to,
  "This can't be undone.", then **Cancel** / **Delete batch** (danger). A
  legacy batch instead says the items are only unlocked and folder changes
  stay.
- **Batches list:** a trash button in each card's header (`@click.stop` so the
  card doesn't open), disabled with the reason as tooltip.
- **Workspace:** **Delete batch** at the right of the header row, same
  disabled rule; after a delete the app returns to the Batches list.

## Native side

- New module `core/snapshot` (take, preview, restore, drop, sweep) — pure file
  operations on paths, no DB, so it is testable with temp dirs.
- `core/db/batches.rs`: counter-based numbering, `delete`, snapshot row
  insert/read/drop, `mark_backend_touched`; `archive` drops snapshot rows.
- `commands/batch.rs`: `batch_create` becomes snapshot-then-transaction and
  runs off the UI thread; new `batch_delete_preview`, `batch_delete`,
  `batch_mark_backend_touched`.
- Watcher: ignore events whose path goes through `.nbcg-snapshots`, so taking
  or dropping a snapshot doesn't trigger a rescan.
- Startup: run the sweep after `Db::open`.

## Testing

Rust (temp dirs + in-memory DB):
- Take → restore round trips: a generated PDF/thumb/txt is removed; an
  overwritten `metadata.json` comes back; a supplied PDF moved into `source/`
  goes back and `source/` disappears; a TIFF deleted by hand comes back; a
  file added by hand is removed; a nested item's subfolder is untouched;
  `.nbcg-tmp-*` is removed; a deleted item folder is recreated.
- Restore is idempotent; a failure on one item leaves the DB untouched.
- The copy fallback produces the same result as hard links (call it directly).
- DB: delete restores rows/stages/assets and removes batch rows; a legacy
  delete only releases; numbers aren't reused after deleting the newest batch;
  archive drops snapshot rows; `batch_update` refuses an unsnapshotted new
  member; migration v3 → v4 seeds the counter.
- Watcher ignores `.nbcg-snapshots` paths.

TypeScript (vitest):
- `deleteBlockedReason` for each row of the table above.
- `withBackendWriteMark`: marks once, before the first mutating call; reads
  never mark; a failing mark stops the write.
- `useBatches.remove`: native delete, collection, items refresh; a failed
  delete keeps the batch.
- `useMetadata.forget`: a pending autosave never lands; the next load re-reads
  the disk.
- `useDeleteBatch`: preview → confirm → done (autosaves stopped *before* the
  delete, upload results cleared after), and the error path keeps the dialog
  open with the message.

## Out of scope

- Any backend undo (deleting created records, reverting PATCHes, restoring
  replaced files).
- Deleting archived (uploaded) batches.
- Restoring a legacy batch's folders — it has no snapshot to restore from.
