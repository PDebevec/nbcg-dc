# Per-item Parents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parent links belong to items. Each item keeps its own parents, any later batch shows them, and removing a parent from an uploaded item unlinks it on the backend at the next upload.

**Architecture:** Two lists per item. The item's `metadata.json` gains `parentIds` — what the backend has, written only from backend answers (create, link/unlink calls, sync, a one-off read). The batch keeps each item's unsent changes in `overrides[itemId].parents = { add, remove, passing }`. The item's parents are backend links + adds − removes; the metadata store, both tabs and the upload all work from that per item. The batch-wide `Batch.parents` list is folded onto the items by a v5 migration and then removed.

**Tech Stack:** Rust (Tauri 2, rusqlite, serde), TypeScript + Vue 3 + Pinia, vitest (`vue/server-renderer` for component smoke tests).

**Spec:** `docs/superpowers/specs/2026-09-29-per-item-parents-design.md`

## Global Constraints

- Links are per item. The backend is the source of truth; `metadata.json` `parentIds` is written **only from backend answers**, never from an edit.
- `metadata.json`: `parentIds` absent or `null` = not known yet; `[]` = known, none. Ignored while `backendId` is null.
- Batch: `overrides[itemId].parents = { add: string[], remove: string[], passing: string | null }`; `null`/absent = no changes. An empty set is stored as `null`.
- The item's parents = backend links, then adds, minus removes (`itemParentIds`).
- Upload: a new item is created with `parentIds` = its adds. A re-upload links adds the backend lacks, **then** unlinks removes the backend has. An unlink answered `404` counts as done. Nothing is unlinked on a record taken over after a create `409`.
- A failed link or unlink leaves the item `uploaded` but makes `allUploaded` false, so the batch stays open.
- `withBackendWriteMark` wraps `disconnectParent` like every other backend write.
- A backend link never starts passing data on its own; a newly linked parent passes when it is the item's only eligible parent.
- UI copy, verbatim:
  - row tags: `New — links on upload`, `Unlinks on upload`, button `Undo`
  - Setup row count: `on all N items` / `on k of N items`
  - search result action: `Link to all N items` (only when the batch has more than one item)
  - Metadata card description: `This item's parents. Changes are sent to the backend when the batch uploads.`
  - Setup card description: `Link one or more parents to every item in the batch. Only one passes data at a time — its shared fields copy down to the items that have it. Click can pass data on another to switch the source.`
  - banner: `Couldn't read this item's parent links from the backend. Check the connection and retry.`
  - row message: `Uploaded, but N parent link change(s) failed — upload again to retry.`
  - toast: `N item(s) uploaded, but a parent link change failed — upload again to retry.`
- Lanes: Tasks 1–2 are `.rs` (Arch); Task 9 is `.vue` (GUI); the rest is `.ts` (Jernej).
- Commits: only when the user asks (session rule). Each task ends with a green test run instead of a commit.
- Commands (repo root): TS tests `npx vitest run [file]`, typecheck `npx vue-tsc --noEmit`; native `(cd src-tauri && cargo test)`, `(cd src-tauri && cargo clippy --all-targets)`. Use the subshell form so the shell's working directory stays at the repo root.

## File map

| File | Responsibility |
|---|---|
| `src-tauri/src/dto.rs` | `LocalMetadataFile.parent_ids`, `ParentChanges`, `BatchItemOverride.parents`, `#[serde(default)]` on batch `parents` |
| `src-tauri/src/core/db/mod.rs` | migration v4 → v5: fold live batches' parents onto their items |
| `src/domain/parent.ts` | `ParentChanges` + the per-item rules; later, drop the batch-list helpers |
| `src/domain/batch.ts` | `BatchItemOverride.parents`, `parentChangesOf`, `withParentChanges`; later, drop `Batch.parents` |
| `src/domain/metadata.ts` | `LocalMetadataFile.parentIds` |
| `src/services/api/search.ts`, `src/domain/sync.ts` | read `parent_relations`; the mirror projection and diff |
| `src/services/api/collections.ts` | `getItemParentIds` (the one-off read) |
| `src/services/api/relations.ts` | `disconnectParent` |
| `src/services/upload.ts` | create under the item's parents; link/unlink on re-upload; record links; batch-open rule |
| `src/stores/useMetadata.ts` | backend links per item, `parentsOf(item)`, one-off read, readiness |
| `src/composables/useParentLinks.ts` | rows / link / unlink / undo / toggle / link-to-all over target items |
| `src/composables/useMetadataForm.ts`, `useBatchSetup.ts`, `useProcessing.ts` | wiring per item |
| `src/services/batches.ts`, `src/ipc/bindings.ts` | stop mapping the batch-wide list |
| `src/components/batch/ParentRecordsCard.vue`, `src/views/batch/MetadataTab.vue`, `src/views/batch/SetupTab.vue` | pending tags, Undo, counts, Link to all |
| docs (this repo + `~/nbcg/docs/shared/plans/metadata-schema-v2-archive-app.md`) | say "the item's parents" |

---

### Task 1: Native — the new fields (Arch)

**Files:**
- Modify: `src-tauri/src/dto.rs` (`LocalMetadataFile` ~l.737, `BatchItemOverride` ~l.491, `BatchDto` ~l.518, `BatchCreateDto` ~l.543; new `ParentChanges`)
- Modify: `src-tauri/tests/common/mod.rs:131` (`metadata_mirror`), `src-tauri/tests/workflow.rs:129`, `src-tauri/tests/db_batches.rs:102`
- Test: `src-tauri/tests/fs_core.rs`, `src-tauri/tests/db_batches.rs`

**Interfaces:**
- Produces: `LocalMetadataFile.parent_ids: Option<Vec<String>>` (JSON `parentIds`); `pub struct ParentChanges { add: Vec<String>, remove: Vec<String>, passing: Option<String> }`; `BatchItemOverride.parents: Option<ParentChanges>`; `parents` on `BatchDto` / `BatchCreateDto` may be omitted by the caller.

- [ ] **Step 1: Write the failing tests**

Append to the "the mirror" section of `src-tauri/tests/fs_core.rs`:

```rust
#[test]
fn the_mirror_round_trips_its_parent_ids() {
    let root = TempDir::new().unwrap();
    let dir = make_item_dir(root.path(), "BOOK", &[]);
    let mirror = LocalMetadataFile {
        parent_ids: Some(vec!["c5u91tqfdyu5lzc8ltn17zpfp".into()]),
        ..metadata_mirror(Some("rec-1"), "A title")
    };

    fs::write_metadata(&dir, &mirror).unwrap();

    assert_eq!(fs::read_metadata(&dir).unwrap().expect("mirror"), mirror);
}

#[test]
fn a_mirror_written_before_parent_ids_still_reads() {
    let root = TempDir::new().unwrap();
    let dir = make_item_dir(root.path(), "BOOK", &[]);
    std::fs::write(
        dir.join("metadata.json"),
        r#"{"backendId":"rec-1","version":2,"metadata":{"title":"t"},"syncedAt":"2026-08-12T10:00:00.000Z"}"#,
    )
    .unwrap();

    let read = fs::read_metadata(&dir).unwrap().expect("mirror");

    assert_eq!(read.parent_ids, None);
    assert_eq!(read.backend_id.as_deref(), Some("rec-1"));
}
```

Append to `src-tauri/tests/db_batches.rs`:

```rust
#[test]
fn an_items_parent_changes_round_trip_through_the_overrides() {
    let db = db_with_items(&["A"]);
    let a = item_id_for("A");
    let changes = ParentChanges {
        add: vec!["p9".into()],
        remove: vec!["p1".into()],
        passing: Some("p9".into()),
    };
    let mut fields = batch_over(&[&a]);
    fields.overrides = HashMap::from([(
        a.clone(),
        BatchItemOverride {
            parents: Some(changes.clone()),
            ..Default::default()
        },
    )]);

    let created = db.transaction(|t| batches::create(t, &fields)).unwrap();
    let reread = db.with(|c| batches::get(c, &created.id)).unwrap();

    assert_eq!(reread.overrides[&a].parents, Some(changes));
}

#[test]
fn a_batch_payload_without_the_batch_wide_parents_still_parses() {
    let json = serde_json::json!({
        "type": "to-process",
        "itemIds": ["a"],
        "stage": "setup",
        "running": false,
        "proc": {},
        "cobissId": null,
        "publish": "DRAFT",
        "visibility": "PRIVATE",
        "overrides": { "a": { "parents": { "add": ["p1"], "remove": [], "passing": null } } }
    });

    let fields: BatchCreateDto = serde_json::from_value(json).expect("parse");

    assert!(fields.parents.is_empty());
    assert_eq!(fields.overrides["a"].parents.as_ref().map(|p| p.add.clone()), Some(vec!["p1".to_string()]));
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `(cd src-tauri && cargo test --test fs_core --test db_batches)`
Expected: compile errors — ``struct `LocalMetadataFile` has no field named `parent_ids` ``, ``cannot find struct `ParentChanges` ``.

- [ ] **Step 3: Implement**

In `src-tauri/src/dto.rs`, add above `BatchItemOverride`:

```rust
/// One item's unsent parent-link changes in a batch — links are per item
/// (docs/superpowers/specs/2026-09-29-per-item-parents-design.md). Passed
/// through opaquely: the TS side owns the rules.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentChanges {
    #[serde(default)]
    pub add: Vec<String>,
    #[serde(default)]
    pub remove: Vec<String>,
    #[serde(default)]
    pub passing: Option<String>,
}
```

Add a last field to `BatchItemOverride`:

```rust
    /// This item's unsent parent-link changes; `None` = none.
    #[serde(default)]
    pub parents: Option<ParentChanges>,
```

On `BatchDto.parents` and `BatchCreateDto.parents`, replace the bare field with:

```rust
    /// Legacy batch-wide parents: always empty since schema v5, which moved
    /// them onto each member's `overrides[item].parents`. Kept for the column.
    #[serde(default)]
    pub parents: Vec<BatchParentRef>,
```

In `LocalMetadataFile`, between `visibility_status` and `metadata`:

```rust
    /// The parent ids the backend is known to have for this item; `None` =
    /// not recorded yet (a mirror written before this field existed).
    #[serde(default)]
    pub parent_ids: Option<Vec<String>>,
```

Fix the three hand-built fixtures:
- `src-tauri/tests/common/mod.rs` `metadata_mirror`: add `parent_ids: None,` after `visibility_status`.
- `src-tauri/tests/workflow.rs:129`: add `parent_ids: None,` after `visibility_status`.
- `src-tauri/tests/db_batches.rs:102`: add `parents: None,` after `split_spreads: Some(true),`.

- [ ] **Step 4: Run the tests**

Run: `(cd src-tauri && cargo test)` then `(cd src-tauri && cargo clippy --all-targets)`
Expected: all tests PASS (the four new ones included); clippy clean.

---

### Task 2: Native — migration v5 folds batch parents onto items (Arch)

**Files:**
- Modify: `src-tauri/src/core/db/mod.rs` (`SCHEMA_VERSION`, `migrate`, new `fold_batch_parents_into_items`, tests)

**Interfaces:**
- Consumes: `ParentChanges`, `BatchItemOverride.parents` (Task 1).
- Produces: after v5, every unarchived batch has `parents = '[]'` and each member's `overrides[item].parents = { add: <the batch's ids>, remove: [], passing: <the one with passesData> }`. Archived batches are untouched.

- [ ] **Step 1: Write the failing test** — add to `mod tests` in `src-tauri/src/core/db/mod.rs`:

```rust
    #[test]
    fn migrating_to_v5_moves_a_live_batchs_parents_onto_its_items() {
        use crate::dto::{BatchItemOverride, ItemType, ParentChanges};
        use std::collections::HashMap;

        let conn = Connection::open_in_memory().expect("open");
        migrate(&conn).expect("migrate");
        conn.execute_batch(
            r#"
            INSERT INTO batches (id, batch_no, created_at, item_type, stage, publish, visibility, parents, overrides)
                VALUES ('live', 1, 'now', 'to-process', 'setup', 'DRAFT', 'PRIVATE',
                        '[{"id":"p1","passesData":true},{"id":"p2","passesData":false}]',
                        '{"a":{"publish":"RECORD"}}');
            INSERT INTO batches (id, batch_no, created_at, item_type, stage, publish, visibility, parents, archived_at)
                VALUES ('done', 2, 'now', 'to-process', 'uploaded', 'DRAFT', 'PRIVATE',
                        '[{"id":"p9","passesData":false}]', 'then');
            INSERT INTO batch_items (batch_id, item_id, position)
                VALUES ('live', 'a', 0), ('live', 'b', 1), ('done', 'c', 0);
            "#,
        )
        .expect("seed");
        conn.pragma_update(None, "user_version", 4i64).expect("rewind");

        migrate(&conn).expect("migrate to v5");

        let (parents, overrides): (String, String) = conn
            .query_row(
                "SELECT parents, overrides FROM batches WHERE id = 'live'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("live batch");
        assert_eq!(parents, "[]");
        let overrides: HashMap<String, BatchItemOverride> =
            serde_json::from_str(&overrides).expect("overrides json");
        let moved = ParentChanges {
            add: vec!["p1".into(), "p2".into()],
            remove: vec![],
            passing: Some("p1".into()),
        };
        assert_eq!(overrides["a"].parents.as_ref(), Some(&moved));
        assert_eq!(overrides["a"].publish, Some(ItemType::Record), "the item's other overrides stay");
        assert_eq!(overrides["b"].parents.as_ref(), Some(&moved));

        let archived: String = conn
            .query_row("SELECT parents FROM batches WHERE id = 'done'", [], |r| r.get(0))
            .expect("archived batch");
        assert_eq!(archived, r#"[{"id":"p9","passesData":false}]"#, "an archived batch keeps its history");
    }
```

- [ ] **Step 2: Run it to see it fail**

Run: `(cd src-tauri && cargo test --lib migrating_to_v5)`
Expected: FAIL — `parents` is still the two-parent JSON (no v5 step yet).

- [ ] **Step 3: Implement**

At the top of `src-tauri/src/core/db/mod.rs`, add:

```rust
use std::collections::HashMap;

use crate::dto::{BatchItemOverride, BatchParentRef, ParentChanges};
```

Change `const SCHEMA_VERSION: i64 = 4;` to `5`. In `migrate`, after the `if version < 4 { … }` block:

```rust
    if version < 5 {
        // Per-item parents (docs/superpowers/specs/2026-09-29-per-item-parents-design.md).
        fold_batch_parents_into_items(&tx)?;
    }
```

Below `column_exists`:

```rust
/// Schema v5: copy each live batch's batch-wide `parents` into every member's
/// `overrides[item].parents` as pending links — the data-passing one kept —
/// then empty the batch-wide list. Archived batches keep theirs as history.
fn fold_batch_parents_into_items(conn: &Connection) -> Result<()> {
    let batches: Vec<(String, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, parents, overrides FROM batches \
             WHERE archived_at IS NULL AND parents <> '[]'",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    for (batch_id, parents, overrides) in batches {
        let parents: Vec<BatchParentRef> = serde_json::from_str(&parents)?;
        let mut overrides: HashMap<String, BatchItemOverride> = serde_json::from_str(&overrides)?;
        let changes = ParentChanges {
            add: parents.iter().map(|p| p.id.clone()).collect(),
            remove: Vec::new(),
            passing: parents.iter().find(|p| p.passes_data).map(|p| p.id.clone()),
        };
        let members: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT item_id FROM batch_items WHERE batch_id = ?1 ORDER BY position",
            )?;
            let rows = stmt.query_map(rusqlite::params![batch_id], |r| r.get(0))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        for item_id in members {
            overrides.entry(item_id).or_default().parents = Some(changes.clone());
        }
        conn.execute(
            "UPDATE batches SET parents = '[]', overrides = ?2 WHERE id = ?1",
            rusqlite::params![batch_id, serde_json::to_string(&overrides)?],
        )?;
    }
    Ok(())
}
```

- [ ] **Step 4: Run the tests**

Run: `(cd src-tauri && cargo test)` then `(cd src-tauri && cargo clippy --all-targets)`
Expected: all PASS (`opens_and_migrates` now expects 5); clippy clean.

---

### Task 3: Domain — per-item changes and their rules

**Files:**
- Modify: `src/domain/parent.ts` (append a "per-item links" section)
- Modify: `src/domain/batch.ts` (`BatchItemOverride.parents`, `parentChangesOf`, `withParentChanges`)
- Modify: `src/domain/metadata.ts` (`LocalMetadataFile.parentIds`)
- Test: `src/domain/parent.test.ts`, `src/domain/batch.test.ts`

**Interfaces:**
- Produces (`@domain/parent`):
  - `interface ParentChanges { add: string[]; remove: string[]; passing: string | null }`, `const NO_PARENT_CHANGES: ParentChanges`
  - `itemParentIds(backend: readonly string[], changes: Pick<ParentChanges, "add" | "remove">): string[]`
  - `withParentLinked(changes: ParentChanges, backend: readonly string[], id: string): ParentChanges`
  - `withParentUnlinked(changes: ParentChanges, backend: readonly string[], id: string): ParentChanges`
  - `passingAfterLink(current: string | null, parentIds: readonly string[], linkedId: string, isEligible: (id: string) => boolean): string | null`
  - `linkChanges(backend: readonly string[] | null, changes: Pick<ParentChanges, "add" | "remove">): { connect: string[]; disconnect: string[] }`
  - `nextBackendLinks(before: readonly string[] | null, linked: readonly string[], unlinked: readonly string[]): string[] | null`
  - `sameParentIds(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean`
- Produces (`@domain/batch`): `BatchItemOverride.parents?: ParentChanges | null`, `parentChangesOf(batch: Batch, itemId: string): ParentChanges`, `withParentChanges(batch: Batch, itemId: string, changes: ParentChanges): Batch`
- Produces (`@domain/metadata`): `LocalMetadataFile.parentIds?: string[] | null`

- [ ] **Step 1: Write the failing tests**

Add to the import list in `src/domain/parent.test.ts`: `NO_PARENT_CHANGES, itemParentIds, withParentLinked, withParentUnlinked, passingAfterLink, linkChanges, nextBackendLinks, sameParentIds,`. Append:

```ts
describe("per-item parent changes", () => {
  it("lists the backend links, then pending links, without pending unlinks", () => {
    expect(itemParentIds(["p1", "p2"], { add: ["p9"], remove: ["p1"] })).toEqual(["p2", "p9"]);
  });

  it("never lists a parent twice", () => {
    expect(itemParentIds(["p1"], { add: ["p1"], remove: [] })).toEqual(["p1"]);
  });

  it("linking queues a parent the item doesn't have", () => {
    expect(withParentLinked(NO_PARENT_CHANGES, ["p1"], "p9")).toEqual({ add: ["p9"], remove: [], passing: null });
  });

  it("unlinking a backend link queues it; linking it again takes that back", () => {
    const removed = withParentUnlinked(NO_PARENT_CHANGES, ["p1"], "p1");
    expect(removed).toEqual({ add: [], remove: ["p1"], passing: null });
    expect(withParentLinked(removed, ["p1"], "p1")).toEqual(NO_PARENT_CHANGES);
  });

  it("unlinking a pending link just drops it", () => {
    const linked = withParentLinked(NO_PARENT_CHANGES, [], "p9");
    expect(withParentUnlinked(linked, [], "p9")).toEqual(NO_PARENT_CHANGES);
  });

  it("unlinking the passing parent stops it passing", () => {
    expect(withParentUnlinked({ add: ["p9"], remove: [], passing: "p9" }, [], "p9").passing).toBeNull();
  });
});

describe("passingAfterLink", () => {
  const eligible = (id: string) => id.startsWith("s");

  it("passes through a newly linked parent that is the item's only eligible one", () => {
    expect(passingAfterLink(null, ["c1", "s1"], "s1", eligible)).toBe("s1");
  });

  it("keeps an existing choice", () => {
    expect(passingAfterLink("s1", ["s1", "s2"], "s2", eligible)).toBe("s1");
  });

  it("leaves the choice open when the item then has two eligible parents", () => {
    expect(passingAfterLink(null, ["s1", "s2"], "s2", eligible)).toBeNull();
  });

  it("never starts a backend link passing when an ineligible parent is linked", () => {
    expect(passingAfterLink(null, ["s1", "c1"], "c1", eligible)).toBeNull();
  });
});

describe("linkChanges", () => {
  it("links only what the backend lacks and unlinks only what it has", () => {
    expect(linkChanges(["p1", "p2"], { add: ["p2", "p9"], remove: ["p1", "p5"] })).toEqual({
      connect: ["p9"],
      disconnect: ["p1"],
    });
  });

  it("sends every change when the backend links are not known", () => {
    expect(linkChanges(null, { add: ["p9"], remove: ["p1"] })).toEqual({ connect: ["p9"], disconnect: ["p1"] });
  });

  it("sends nothing without changes", () => {
    expect(linkChanges(["p1"], NO_PARENT_CHANGES)).toEqual({ connect: [], disconnect: [] });
  });
});

describe("nextBackendLinks", () => {
  it("adds what was linked and drops what was unlinked", () => {
    expect(nextBackendLinks(["p1", "p2"], ["p9"], ["p1"])).toEqual(["p2", "p9"]);
  });

  it("keeps an unknown list unknown", () => {
    expect(nextBackendLinks(null, ["p9"], [])).toBeNull();
  });
});

describe("sameParentIds", () => {
  it("ignores order", () => {
    expect(sameParentIds(["p1", "p2"], ["p2", "p1"])).toBe(true);
    expect(sameParentIds(["p1"], ["p2"])).toBe(false);
  });

  it("treats a missing list like an unknown one, and neither like an empty one", () => {
    expect(sameParentIds(undefined, null)).toBe(true);
    expect(sameParentIds(null, [])).toBe(false);
  });
});
```

In `src/domain/batch.test.ts`, add `parentChangesOf, withParentChanges,` to the `./batch` import, add `import { NO_PARENT_CHANGES } from "./parent";`, and append:

```ts
describe("per-item parent changes on the batch", () => {
  it("reads no changes for an item without any", () => {
    expect(parentChangesOf(makeBatch(), "i1")).toEqual(NO_PARENT_CHANGES);
  });

  it("stores an item's changes next to its other overrides", () => {
    const b = makeBatch({ overrides: { i1: { publish: PublishTarget.RECORD } } });
    const next = withParentChanges(b, "i1", { add: ["p9"], remove: [], passing: null });
    expect(next.overrides.i1).toEqual({
      publish: PublishTarget.RECORD,
      parents: { add: ["p9"], remove: [], passing: null },
    });
    expect(parentChangesOf(next, "i1").add).toEqual(["p9"]);
  });

  it("stores an empty set as null", () => {
    const b = withParentChanges(makeBatch(), "i1", { add: ["p9"], remove: [], passing: null });
    expect(withParentChanges(b, "i1", NO_PARENT_CHANGES).overrides.i1).toEqual({ parents: null });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/domain/parent.test.ts src/domain/batch.test.ts`
Expected: FAIL — `itemParentIds is not a function`, `parentChangesOf is not a function`.

- [ ] **Step 3: Implement**

Append to `src/domain/parent.ts`:

```ts
// ── per-item links (docs/superpowers/specs/2026-09-29-per-item-parents-design.md) ──

/**
 * One item's unsent parent-link changes in a batch (`BatchItemOverride.parents`).
 * The item's parents are its backend links + `add` − `remove`
 * ({@link itemParentIds}); an upload makes the backend match ({@link linkChanges}).
 * Kept as changes, not a full list, so an upload never undoes a link someone
 * made on the website since the last sync.
 */
export interface ParentChanges {
  /** Parents to link that the item doesn't have on the backend. */
  add: string[];
  /** Backend links to unlink. */
  remove: string[];
  /** Which of the item's parents fills its empty shared fields, or null. */
  passing: string | null;
}

/** An item with nothing to change. */
export const NO_PARENT_CHANGES: ParentChanges = { add: [], remove: [], passing: null };

/** The item's parents: its backend links, then pending links, minus pending unlinks. */
export function itemParentIds(
  backend: readonly string[],
  changes: Pick<ParentChanges, "add" | "remove">,
): string[] {
  const ids: string[] = [];
  for (const id of [...backend, ...changes.add]) {
    if (!changes.remove.includes(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Link `id` to an item: take back a pending unlink, else queue a link the
 * backend doesn't have yet. */
export function withParentLinked(
  changes: ParentChanges,
  backend: readonly string[],
  id: string,
): ParentChanges {
  const add = backend.includes(id) || changes.add.includes(id) ? changes.add : [...changes.add, id];
  return { ...changes, add, remove: changes.remove.filter((x) => x !== id) };
}

/** Unlink `id` from an item: drop a pending link, and queue an unlink when the
 * backend has it. It stops passing data. */
export function withParentUnlinked(
  changes: ParentChanges,
  backend: readonly string[],
  id: string,
): ParentChanges {
  const remove =
    backend.includes(id) && !changes.remove.includes(id) ? [...changes.remove, id] : changes.remove;
  return {
    add: changes.add.filter((x) => x !== id),
    remove,
    passing: changes.passing === id ? null : changes.passing,
  };
}

/**
 * Which parent passes data after `linkedId` was linked: an existing choice
 * stays; otherwise `linkedId`, when it is the item's only eligible parent. A
 * backend link never starts passing on its own — a re-work batch must not fill
 * an uploaded item's fields unasked.
 */
export function passingAfterLink(
  current: string | null,
  parentIds: readonly string[],
  linkedId: string,
  isEligible: (id: string) => boolean,
): string | null {
  if (current !== null) return current;
  if (!isEligible(linkedId)) return null;
  return parentIds.filter(isEligible).length === 1 ? linkedId : null;
}

/**
 * What an upload must call so the backend matches the item's parents: link the
 * adds the backend lacks, unlink the removes it still has. With the backend
 * links unknown (`null`) every change is sent — linking a parent twice and
 * unlinking one that's gone both change nothing.
 */
export function linkChanges(
  backend: readonly string[] | null,
  changes: Pick<ParentChanges, "add" | "remove">,
): { connect: string[]; disconnect: string[] } {
  return {
    connect: changes.add.filter((id) => !changes.remove.includes(id) && !(backend ?? []).includes(id)),
    disconnect: changes.remove.filter((id) => backend === null || backend.includes(id)),
  };
}

/** The backend links after an upload linked and unlinked some; unknown stays unknown. */
export function nextBackendLinks(
  before: readonly string[] | null,
  linked: readonly string[],
  unlinked: readonly string[],
): string[] | null {
  return before === null ? null : itemParentIds(before, { add: [...linked], remove: [...unlinked] });
}

/** Whether two parent-id lists hold the same ids (order ignored). A missing
 * list equals an unknown one; neither equals an empty one. */
export function sameParentIds(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  if (a == null || b == null) return a == null && b == null;
  return a.length === b.length && a.every((id) => b.includes(id));
}
```

In `src/domain/batch.ts`, add after the existing imports:

```ts
import { NO_PARENT_CHANGES, type ParentChanges } from "./parent";
```

Add a last field to `BatchItemOverride`:

```ts
  /**
   * This item's unsent parent-link changes — links are per item
   * (docs/superpowers/specs/2026-09-29-per-item-parents-design.md). Null or
   * absent: none; the item keeps its backend links.
   */
  parents?: ParentChanges | null;
```

Below `resolveItemVisibility`:

```ts
/** An item's unsent parent-link changes in this batch (none when absent). */
export function parentChangesOf(batch: Batch, itemId: string): ParentChanges {
  return batch.overrides[itemId]?.parents ?? NO_PARENT_CHANGES;
}

/** `batch` with one item's parent-link changes replaced; an empty set is stored as null. */
export function withParentChanges(batch: Batch, itemId: string, changes: ParentChanges): Batch {
  const none = changes.add.length === 0 && changes.remove.length === 0 && changes.passing === null;
  return {
    ...batch,
    overrides: {
      ...batch.overrides,
      [itemId]: { ...batch.overrides[itemId], parents: none ? null : changes },
    },
  };
}
```

In `src/domain/metadata.ts`, in `LocalMetadataFile` after `visibilityStatus`:

```ts
  /**
   * The parent ids the backend is known to have for this item — written only
   * from backend answers (create, link/unlink calls, sync, a one-off read).
   * Absent or null: not recorded yet (a mirror from before per-item parents).
   * Ignored while `backendId` is null.
   */
  parentIds?: string[] | null;
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run src/domain/parent.test.ts src/domain/batch.test.ts` then `npx vue-tsc --noEmit`
Expected: PASS; no type errors.

---

### Task 4: Reading links from the backend (search, sync, the one-off read)

**Files:**
- Modify: `src/services/api/search.ts` (`hitToRemote`)
- Modify: `src/domain/sync.ts` (`RemoteRecord`, `projectMirror`, `mirrorDiffers`)
- Modify: `src/services/api/collections.ts` (new `getItemParentIds`)
- Test: `src/services/sync.test.ts`, `src/domain/sync.test.ts`, `src/services/api/collections.test.ts`

**Interfaces:**
- Consumes: `sameParentIds` (Task 3).
- Produces: `RemoteRecord.parentIds?: string[] | null` (`undefined` when the doc lacked the key); `getItemParentIds(backendId: string, options?: SearchParentsOptions): Promise<string[] | null>` (`null` on 404). The sync now writes `parentIds` into mirrors.

- [ ] **Step 1: Write the failing tests**

In `src/services/sync.test.ts`, inside `describe("hitToRemote")`:

```ts
  it("reads the item's parent ids, with pgsync's null meaning none", () => {
    const linked = makeHit({ source: { parent_relations: [{ parentId: "p1", parentType: "RECORD" }] } });
    expect(hitToRemote(linked).parentIds).toEqual(["p1"]);
    expect(hitToRemote(makeHit({ source: { parent_relations: null } })).parentIds).toEqual([]);
  });

  it("leaves the parent ids unknown when a trimmed doc lacks them", () => {
    expect(hitToRemote(makeHit({ source: {} })).parentIds).toBeUndefined();
  });
```

and inside `describe("syncTracked — found records")`:

```ts
  it("records the item's parent ids from the read", async () => {
    const h = harness({
      items: [makeItem()],
      mirrors: { i1: makeMirror(ORPHAN_MIN_AGE_MS * 2) },
      fetch: () =>
        makeHit({
          source: {
            visibilityStatus: "PUBLIC",
            version: 3,
            metadata: { title: "Gorski vijenac" },
            parent_relations: [{ parentId: "p1", parentType: "RECORD" }],
          },
        }),
    });

    await syncTracked({ deps: h.deps });

    expect(h.writes[0].mirror.parentIds).toEqual(["p1"]);
  });
```

In `src/domain/sync.test.ts`, change the expected object in "builds a full mirror when there was none" to include `parentIds: null,` (after `visibilityStatus`), and add inside `describe("projectMirror")`:

```ts
  it("takes the item's parent ids from the read", () => {
    const next = projectMirror(mirror({ parentIds: ["old"] }), remote({ parentIds: ["p1"] }), "T");
    expect(next.parentIds).toEqual(["p1"]);
  });

  it("keeps the previous parent ids when the read didn't carry them", () => {
    expect(projectMirror(mirror({ parentIds: ["p1"] }), remote(), "T").parentIds).toEqual(["p1"]);
  });
```

and inside `describe("mirrorDiffers")`:

```ts
  it("detects a parent change, but not a reordering", () => {
    expect(mirrorDiffers(mirror({ parentIds: ["p1"] }), mirror({ parentIds: ["p2"] }))).toBe(true);
    expect(mirrorDiffers(mirror({ parentIds: ["p1", "p2"] }), mirror({ parentIds: ["p2", "p1"] }))).toBe(false);
  });

  it("does not count a missing list against an unknown one — or every old mirror is rewritten", () => {
    expect(mirrorDiffers(mirror(), mirror({ parentIds: null }))).toBe(false);
    expect(mirrorDiffers(mirror(), mirror({ parentIds: [] }))).toBe(true);
  });
```

In `src/services/api/collections.test.ts`, add `getItemParentIds` to the `./collections` import and append:

```ts
describe("getItemParentIds", () => {
  it("reads the item's parent ids from its indexed doc", async () => {
    const { client, calls } = harness(() =>
      json(hit({ id: "c2", index: "drafts", source: { parent_relations: [{ parentId: "p1", parentType: "RECORD" }] } })),
    );
    expect(await getItemParentIds("c2", { client })).toEqual(["p1"]);
    expect(calls[0].url).toBe("https://api.test/api/search/c2");
  });

  it("reads pgsync's null as no parents", async () => {
    const { client } = harness(() => json(hit({ id: "c2", source: { parent_relations: null } })));
    expect(await getItemParentIds("c2", { client })).toEqual([]);
  });

  it("is null when the backend says 404", async () => {
    const { client } = harness(() => json({ statusCode: 404, message: "Item with id \"c2\" not found" }, 404));
    expect(await getItemParentIds("c2", { client })).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/services/sync.test.ts src/domain/sync.test.ts src/services/api/collections.test.ts`
Expected: FAIL — `parentIds` undefined where ids are expected; `getItemParentIds is not a function`.

- [ ] **Step 3: Implement**

`src/services/api/search.ts`: add `type IndexedItemSource,` to the `./dto` import; in `hitToRemote`'s returned object add `parentIds: parentIdsOf(source),`; below it:

```ts
/** The item's parent ids from its indexed doc. pgsync writes `null` when it has
 * none; a doc trimmed by `?fields=` lacks the key — not known, so `undefined`. */
function parentIdsOf(source: IndexedItemSource): string[] | undefined {
  if (!("parent_relations" in source)) return undefined;
  return (source.parent_relations ?? []).map((r) => r.parentId);
}
```

`src/domain/sync.ts`: add `import { sameParentIds } from "./parent";`. In `RemoteRecord` add:

```ts
  /** The item's parent ids; `undefined`/`null` when the read didn't carry them. */
  parentIds?: string[] | null;
```

In `projectMirror`'s object, after `visibilityStatus`: `parentIds: remote.parentIds ?? previous?.parentIds ?? null,`. In `mirrorDiffers`, add to the `||` chain before the metadata check: `!sameParentIds(previous.parentIds, next.parentIds) ||`.

`src/services/api/collections.ts`: change the `./search` import to `import { findById, hitToRemote, searchItems } from "./search";` and append:

```ts
/**
 * An item's own parent ids on the backend (`GET /api/search/:id` →
 * `parent_relations`), or `null` on a `404`. Used once per item whose mirror
 * predates recording them. pgsync writes `null` for an item with no parents,
 * which reads as `[]`.
 */
export async function getItemParentIds(
  backendId: string,
  options: SearchParentsOptions = {},
): Promise<string[] | null> {
  const hit = await findById(backendId, { client: options.client, signal: options.signal });
  return hit ? (hitToRemote(hit).parentIds ?? []) : null;
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run src/services/sync.test.ts src/domain/sync.test.ts src/services/api/collections.test.ts` then `npx vue-tsc --noEmit`
Expected: PASS (the existing "tolerates a trimmed `_source`" still passes: `toEqual` ignores the `undefined` key); no type errors.

---

### Task 5: Metadata store — each item's own parents

**Files:**
- Modify: `src/stores/useMetadata.ts`
- Modify: `src/composables/useMetadataForm.ts` (`parentsBanner`, `retryParents`)
- Test: `src/stores/useMetadata.test.ts`, `src/composables/useMetadataForm.test.ts` (fake only)

**Interfaces:**
- Consumes: `itemParentIds`, `NO_PARENT_CHANGES` (Task 3), `parentChangesOf` (Task 3), `getItemParentIds` (Task 4).
- Produces (store): `interface ItemParents { records; gone; missing; failed; pending; linksUnknown: boolean }` (replaces `BatchParents`); `parentsOf(item): ItemParents` (replaces `batchParentsOf`); `parentIdsOf(item): string[] | null`; `backendLinks: Ref<Map<string, string[] | null>>`; `ensureItemParents(item): Promise<void>`; `retryItemParents(item): Promise<void>`. `isReady` is false while `linksUnknown`.

- [ ] **Step 1: Write the failing tests** in `src/stores/useMetadata.test.ts`

Replace the fake `batch` (and its `beforeEach` resets) — the batch-wide list goes, per-item changes live in `overrides`:

```ts
type Changes = { add: string[]; remove: string[]; passing: string | null };
const batch = {
  id: "b1",
  publish: "DRAFT" as "DRAFT" | "RECORD",
  overrides: {} as Record<string, { publish?: "DRAFT" | "RECORD" | null; parents?: Changes | null }>,
};
/** Each uploaded item's parent ids on the backend, by backend id (absent → 404). */
const itemLinks = new Map<string, string[]>();
/** Backend ids whose read throws (offline), as opposed to a 404. */
const unreachableItems = new Set<string>();
const getItemParentIds = vi.fn(async (backendId: string) => {
  if (unreachableItems.has(backendId)) throw new Error("Network error");
  return itemLinks.get(backendId) ?? null;
});

/** Give `itemId` pending parent links in the batch. */
function pendingLinks(itemId: string, ...add: string[]): void {
  batch.overrides = { ...batch.overrides, [itemId]: { parents: { add, remove: [], passing: null } } };
}
```

Add `getItemParentIds: (id: string) => getItemParentIds(id),` to the `@services/api/collections` mock. In `beforeEach`, drop `batch.parents = [];` and add `itemLinks.clear(); unreachableItems.clear(); getItemParentIds.mockClear();`.

In the five existing parent tests (`"is not ready while a batch parent is missing…"` through `"clears the failure when a retry loads the parent…"`), replace each `batch.parents = [{ id: X, passesData: false }];` with `pendingLinks("i1", X);` and each `store.batchParentsOf(` with `store.parentsOf(`. Rename two of them to match: `"is not ready while a batch parent is missing on the backend"` → `"is not ready while one of its parents is missing on the backend"`, and `"keeps the form open but not ready while a batch parent failed to load"` → `"keeps the form open but not ready while one of its parents failed to load"`.

Append:

```ts
describe("each item's own parents", () => {
  const SERIAL = { id: "s1", title: "Pobjeda", collectionType: 4, metadata: { title: "Pobjeda", collectionType: 4 } };

  function uploaded(parentIds?: string[]): LocalMetadataFile {
    return {
      backendId: "rec_1",
      version: 1,
      targetState: "DRAFT",
      visibilityStatus: "PUBLIC",
      ...(parentIds ? { parentIds } : {}),
      metadata: { title: "T", materialType: BOOK, collectionType: 0 },
      syncedAt: "2026-09-29T00:00:00.000Z",
    };
  }

  it("checks each item against its own parents", async () => {
    backendParents.set("s1", SERIAL);
    mirrors.set("i1", uploaded(["s1"]));
    const store = useMetadataStore();
    await store.ensureItemLoaded(item("i1"));
    await store.ensureItemLoaded(item("i2"));
    await store.ensureItemParents(item("i1"));

    expect(store.checkOf(item("i1"))?.context.parentCollectionType).toEqual([4]);
    expect(store.checkOf(item("i2"))?.context.parentCollectionType).toEqual([]);
  });

  it("adds the batch's pending links and drops its pending unlinks", async () => {
    mirrors.set("i1", uploaded(["p1"]));
    batch.overrides = { i1: { parents: { add: ["p9"], remove: ["p1"], passing: null } } };
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    expect(store.parentIdsOf(item())).toEqual(["p9"]);
  });

  it("reads an uploaded item's links once when its mirror has none, and records them", async () => {
    mirrors.set("i1", uploaded());
    itemLinks.set("rec_1", ["p1"]);
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    await store.ensureItemParents(item());

    expect(store.parentIdsOf(item())).toEqual(["p1"]);
    expect(mirrors.get("i1")?.parentIds).toEqual(["p1"]);
    expect(getItemParentIds).toHaveBeenCalledTimes(1);
  });

  it("is not ready while an uploaded item's links can't be read, until a retry reads them", async () => {
    mirrors.set("i1", uploaded());
    unreachableItems.add("rec_1");
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    await store.ensureItemParents(item());
    expect(store.parentsOf(item()).linksUnknown).toBe(true);
    expect(store.isReady(item())).toBe(false);

    unreachableItems.clear();
    itemLinks.set("rec_1", []);
    await store.retryItemParents(item());

    expect(store.parentsOf(item()).linksUnknown).toBe(false);
    expect(store.isReady(item())).toBe(true);
  });

  it("never asks the backend about an item that was never uploaded", async () => {
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    await store.ensureItemParents(item());
    expect(getItemParentIds).not.toHaveBeenCalled();
    expect(store.parentIdsOf(item())).toEqual([]);
  });
});
```

In `src/composables/useMetadataForm.test.ts`, rename the fake's `batchParentsOf: () => ({ records: [], missing: [], failed: [], pending: false })` to `parentsOf: () => ({ records: [], gone: [], missing: [], failed: [], pending: false, linksUnknown: false })`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/stores/useMetadata.test.ts`
Expected: FAIL — `store.parentsOf is not a function`, `store.ensureItemParents is not a function`.

- [ ] **Step 3: Implement** in `src/stores/useMetadata.ts`

Imports: `import { itemParentIds, NO_PARENT_CHANGES, type MissingParentNames, type ParentRecord } from "@domain/parent";`, `import { parentChangesOf, resolveItemPublish } from "@domain/batch";`, `import { getItemParentIds, getParentById, searchParents } from "@services/api/collections";`.

Replace `BatchParents` with:

```ts
/** An item's parents as far as this session knows them — its backend links
 * plus its batch's pending changes. */
export interface ItemParents {
  /** The parents whose records have loaded (and that are not gone). */
  records: ParentRecord[];
  /** Ids the backend refused on an upload (`PARENT_NOT_FOUND`) — authoritative,
   * even when the record had loaded before. */
  gone: string[];
  /** Ids search answered 404 for. */
  missing: string[];
  /** Ids whose fetch failed without proving they are gone (e.g. offline). */
  failed: string[];
  /** Something is still loading: a parent's record, or the item's own links. */
  pending: boolean;
  /** An uploaded item whose backend links couldn't be read (offline, a 404).
   * The rules run with its pending links only, and it is not ready. */
  linksUnknown: boolean;
}
```

Next to `backendStates`:

```ts
  /** Each loaded item's backend links, from its mirror: `[]` before its first
   * upload, `null` while not known (a mirror from before they were kept). */
  const backendLinks = ref<Map<string, string[] | null>>(new Map());
  /** Items whose backend links are being read / couldn't be read. */
  const linksLoading = ref<Set<string>>(new Set());
  const linksFailed = ref<Set<string>>(new Set());
  const linkPromises = new Map<string, Promise<void>>();
```

In `rememberMirror`, after `backendStates.value = map;`:

```ts
    const links = new Map(backendLinks.value);
    links.set(itemId, mirror?.backendId ? (mirror.parentIds ?? null) : []);
    backendLinks.value = links;
```

In `ensureItemLoaded`, replace `void ensureParents(batchParentIds(item));` with `void ensureItemParents(item);`.

Delete `batchParentIds` and `batchParentsOf`; add in their place:

```ts
  function changesOf(item: Item) {
    const b = batchOf(item);
    return b ? parentChangesOf(b, item.id) : NO_PARENT_CHANGES;
  }

  /** The item's parents (backend links + its batch's pending changes), or null
   * while its backend links are not known. */
  function parentIdsOf(item: Item): string[] | null {
    const backend = backendLinks.value.get(item.id);
    return backend == null ? null : itemParentIds(backend, changesOf(item));
  }

  /** The item's parents, as far as this session knows them. */
  function parentsOf(item: Item): ItemParents {
    const backend = backendLinks.value.get(item.id);
    const records: ParentRecord[] = [];
    const gone: string[] = [];
    const missing: string[] = [];
    const failed: string[] = [];
    let pending = backend === undefined || linksLoading.value.has(item.id);
    for (const id of itemParentIds(backend ?? [], changesOf(item))) {
      // Gone first: the record loaded when the editor opened stays cached.
      const record = parentRecords.value.get(id);
      if (parentGone.value.has(id)) gone.push(id);
      else if (record) records.push(record);
      else if (parentMissing.value.has(id)) missing.push(id);
      else if (parentFailed.value.has(id)) failed.push(id);
      else pending = true;
    }
    return { records, gone, missing, failed, pending, linksUnknown: !pending && backend === null };
  }

  /**
   * Read an uploaded item's backend links once when its mirror has none
   * (written before they were kept), and record them in its metadata.json —
   * re-read first, only that field changes. An upload awaits this for every
   * member before it starts, so the write never races the upload's own.
   */
  function ensureBackendLinks(item: Item): Promise<void> {
    const mirror = mirrors.get(item.id);
    if (!mirror?.backendId || mirror.parentIds != null) return Promise.resolve();
    const inFlight = linkPromises.get(item.id);
    if (inFlight) return inFlight;
    const backendId = mirror.backendId;
    const p = (async () => {
      linksLoading.value = new Set(linksLoading.value).add(item.id);
      try {
        const ids = await getItemParentIds(backendId);
        if (ids === null) {
          linksFailed.value = new Set(linksFailed.value).add(item.id);
          return;
        }
        const fresh = (await readItemMetadata(item)) ?? mirror;
        if (fresh.backendId !== backendId) {
          rememberMirror(item.id, fresh);
          return;
        }
        const next: LocalMetadataFile = { ...fresh, parentIds: ids };
        rememberMirror(item.id, next);
        linksFailed.value = without(linksFailed.value, item.id);
        try {
          await writeItemMetadata(item, next);
        } catch (err) {
          logger.warn("metadata", `Couldn't record the parent links of ${item.id}.`, err);
        }
      } catch (err) {
        logger.warn("metadata", `Couldn't read the parent links of ${item.id}.`, err);
        linksFailed.value = new Set(linksFailed.value).add(item.id);
      } finally {
        linksLoading.value = without(linksLoading.value, item.id);
        linkPromises.delete(item.id);
      }
    })();
    linkPromises.set(item.id, p);
    return p;
  }

  /** Load what the item's parents need: its backend links (once), then the
   * records of its parents. */
  async function ensureItemParents(item: Item): Promise<void> {
    await ensureBackendLinks(item);
    await ensureParents(itemParentIds(backendLinks.value.get(item.id) ?? [], changesOf(item)));
  }

  /** Try again after the item's links or one of its parents failed to load. */
  function retryItemParents(item: Item): Promise<void> {
    linksFailed.value = without(linksFailed.value, item.id);
    return ensureItemParents(item);
  }
```

In `checkOf`, `isReady` and `missingParentNamesOf`, call `parentsOf(item)` instead of `batchParentsOf(item)`. In `isReady`, the last line becomes:

```ts
    return !parents.linksUnknown && parents.gone.length === 0 && parents.missing.length === 0 && parents.failed.length === 0;
```

In `forget`: add `linkPromises.delete(id);` in the loop, and after the other resets:

```ts
    backendLinks.value = keep(backendLinks.value);
    linksLoading.value = keepSet(linksLoading.value);
    linksFailed.value = keepSet(linksFailed.value);
```

In the returned object, replace `batchParentsOf,` with `parentsOf, parentIdsOf, ensureItemParents, retryItemParents,` and add `backendLinks,` under `// parents`. In the module doc, change "evaluated against the item's values, its batch's parents and its state" to "evaluated against the item's values, its own parents and its state".

In `src/composables/useMetadataForm.ts`, replace `parentsBanner` and `retryParents`:

```ts
  /** Why the current item's parents aren't usable yet, '' = they are: its own
   * links couldn't be read, or a parent's record failed to load (offline). The
   * form still works; the item is not ready until they load. */
  const parentsBanner = computed(() => {
    const c = current.value;
    if (!c) return "";
    const parents = metadata.parentsOf(c);
    if (parents.linksUnknown) {
      return "Couldn't read this item's parent links from the backend. Check the connection and retry.";
    }
    const names = parents.failed.map((id) => `'${id}'`);
    if (names.length === 0) return "";
    const list =
      names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    return `Couldn't load the parent${names.length === 1 ? "" : "s"} ${list}. Check the connection and retry.`;
  });

  /** Try the current item's parents again (after a failed load). */
  function retryParents(): Promise<void> {
    const c = current.value;
    return c ? metadata.retryItemParents(c) : Promise.resolve();
  }
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run src/stores/useMetadata.test.ts src/composables/useMetadataForm.test.ts` then `npx vue-tsc --noEmit`
Expected: PASS; no type errors.

---

### Task 6: `useParentLinks` works on items — Metadata and Setup

**Files:**
- Modify (rewrite): `src/composables/useParentLinks.ts`
- Modify: `src/composables/useMetadataForm.ts` (the `links` call, returned fields)
- Modify: `src/composables/useBatchSetup.ts` (targets, `applyAndContinue`, returned fields)
- Test: new `src/composables/useParentLinks.test.ts`, new `src/composables/useBatchSetup.test.ts`, `src/composables/useMetadataForm.test.ts`

**Interfaces:**
- Consumes: `withParentLinked`, `withParentUnlinked`, `passingAfterLink`, `itemParentIds`, `isEligibleParent` (Task 3); `parentChangesOf`, `withParentChanges` (Task 3); store `backendLinks`, `parentRecords`, `ensureParents`, `ensureParent`, `findParents` (Task 5).
- Produces:
  - `useParentLinks(batch: () => Batch | null, targets: () => Item[], options?: { members?: () => Item[]; onPassingChanged?: (changes: PassingChange[]) => void })`
  - returns `parents: ComputedRef<ParentRowView[]>`, `linkedRecords`, `passingParent`, `passingParentOf(itemId): ParentRecord | null`, search state (`parentQuery`, `setQuery`, `results`, `searching`, `searchError`, `search`, `clearSearch`), and `linkParent(id)`, `linkParentToAll(id)`, `removeParent(id)`, `restoreParent(id)`, `togglePassesData(id)`
  - `ParentRowView` gains `status: "linked" | "new" | "unlinking"` and `count: { on: number; of: number } | null`; `ParentSearchRow` gains `linkedAll: boolean`
  - `useMetadataForm` also returns `restoreParent`, `linkParentToAll`, `memberCount`; `useBatchSetup` also returns `restoreParent`

- [ ] **Step 1: Write the failing tests**

Create `src/composables/useParentLinks.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { BatchStage, ItemRunStatus, type Batch } from "@domain/batch";
import { DEFAULT_CONFIG } from "@domain/config";
import { PublishTarget, VisibilityStatus } from "@domain/enums";
import { ItemState, type Item } from "@domain/item";
import type { ParentRecord } from "@domain/parent";

function makeBatch(itemIds: string[], over: Partial<Batch> = {}): Batch {
  const proc: Record<string, ItemRunStatus> = {};
  for (const id of itemIds) proc[id] = ItemRunStatus.Idle;
  return {
    id: "b1",
    no: 1,
    createdAt: "2026-09-29T00:00:00.000Z",
    type: ItemState.ToProcess,
    itemIds,
    stage: BatchStage.Metadata,
    running: false,
    proc,
    cobissId: null,
    parents: [],
    publish: PublishTarget.DRAFT,
    visibility: VisibilityStatus.PRIVATE,
    overrides: {},
    archivedAt: null,
    backendTouchedAt: null,
    ...over,
  };
}

function item(id: string): Item {
  return { id, batchId: "b1", folderName: id, folderPath: `/p/${id}`, title: null } as unknown as Item;
}

function record(id: string, collectionType: number | null = null): ParentRecord {
  return { id, title: `Parent ${id}`, collectionType, metadata: { collectionType } };
}

vi.mock("@services/batches", () => ({
  listBatches: async () => [] as Batch[],
  createBatch: async (f: unknown) => f as Batch,
  updateBatch: async (b: unknown) => b as Batch,
  archiveBatch: async (b: unknown) => b as Batch,
}));

const metadataFake = {
  parentRecords: ref(new Map<string, ParentRecord>()),
  parentLoading: ref(new Set<string>()),
  parentGone: ref(new Set<string>()),
  parentMissing: ref(new Set<string>()),
  parentFailed: ref(new Set<string>()),
  backendLinks: ref(new Map<string, string[] | null>()),
  ensureParents: async () => {},
  ensureParent: async () => {},
  findParents: async () => [] as ParentRecord[],
};
vi.mock("@stores/useMetadata", () => ({ useMetadataStore: () => metadataFake }));

const { useParentLinks } = await import("./useParentLinks");
const { useBatchesStore } = await import("@stores/useBatches");
const { useSettingsStore } = await import("@stores/useSettings");

const SERIAL = 4;

function setup(opts: {
  targets: string[];
  members?: string[];
  backend?: Record<string, string[]>;
  changes?: Batch["overrides"];
}) {
  const batches = useBatchesStore();
  const members = opts.members ?? opts.targets;
  batches.batches = [makeBatch(members, { overrides: opts.changes ?? {} })];
  metadataFake.backendLinks.value = new Map(members.map((id) => [id, opts.backend?.[id] ?? []]));
  const passing: Array<{ itemId: string; parent: ParentRecord | null }> = [];
  const links = useParentLinks(
    () => batches.get("b1"),
    () => opts.targets.map(item),
    { members: () => members.map(item), onPassingChanged: (changes) => passing.push(...changes) },
  );
  const changesOf = (id: string) => batches.get("b1")?.overrides[id]?.parents ?? null;
  return { links, passing, changesOf };
}

beforeEach(() => {
  setActivePinia(createPinia());
  metadataFake.parentRecords.value = new Map();
  metadataFake.parentGone.value = new Set();
  metadataFake.parentMissing.value = new Set();
  metadataFake.parentFailed.value = new Set();
  useSettingsStore().config = { ...DEFAULT_CONFIG, dataPassingCollectionTypes: [SERIAL] };
});

describe("rows for one item (Metadata)", () => {
  it("lists the item's backend links, then its pending ones", () => {
    const { links } = setup({
      targets: ["i1"],
      backend: { i1: ["p1"] },
      changes: { i1: { parents: { add: ["p9"], remove: [], passing: null } } },
    });
    expect(links.parents.value.map((p) => [p.id, p.status, p.count])).toEqual([
      ["p1", "linked", null],
      ["p9", "new", null],
    ]);
  });

  it("keeps a pending unlink in the list, marked", () => {
    const { links } = setup({
      targets: ["i1"],
      backend: { i1: ["p1"] },
      changes: { i1: { parents: { add: [], remove: ["p1"], passing: null } } },
    });
    expect(links.parents.value.map((p) => [p.id, p.status])).toEqual([["p1", "unlinking"]]);
  });
});

describe("editing one item", () => {
  it("links a parent to the item only, and saves it on the batch", async () => {
    const { links, changesOf } = setup({ targets: ["i1"], members: ["i1", "i2"] });
    await links.linkParent("p9");
    expect(changesOf("i1")).toEqual({ add: ["p9"], remove: [], passing: null });
    expect(changesOf("i2")).toBeNull();
  });

  it("queues an unlink of a backend link, and Undo takes it back", async () => {
    const { links, changesOf } = setup({ targets: ["i1"], backend: { i1: ["p1"] } });
    await links.removeParent("p1");
    expect(changesOf("i1")).toEqual({ add: [], remove: ["p1"], passing: null });
    await links.restoreParent("p1");
    expect(changesOf("i1")).toBeNull();
  });

  it("Link to all reaches every item in the batch", async () => {
    const { links, changesOf } = setup({ targets: ["i1"], members: ["i1", "i2"], backend: { i2: ["p9"] } });
    await links.linkParentToAll("p9");
    expect(changesOf("i1")).toEqual({ add: ["p9"], remove: [], passing: null });
    expect(changesOf("i2")).toBeNull(); // it already has p9 on the backend
  });
});

describe("rows for several items (Setup)", () => {
  it("counts how many items have each parent", () => {
    const { links } = setup({ targets: ["i1", "i2"], backend: { i1: ["p1"] } });
    expect(links.parents.value.map((p) => [p.id, p.count])).toEqual([["p1", { on: 1, of: 2 }]]);
  });

  it("links and unlinks for every item", async () => {
    const { links, changesOf } = setup({ targets: ["i1", "i2"] });
    await links.linkParent("p9");
    expect(links.parents.value.map((p) => [p.id, p.count])).toEqual([["p9", { on: 2, of: 2 }]]);
    await links.removeParent("p9");
    expect(changesOf("i1")).toBeNull();
    expect(changesOf("i2")).toBeNull();
  });
});

describe("passing data", () => {
  it("passes through a newly linked serial that is the item's only one, and reports it once", async () => {
    metadataFake.parentRecords.value = new Map([["s1", record("s1", SERIAL)]]);
    const { links, changesOf, passing } = setup({ targets: ["i1"] });
    await links.linkParent("s1");
    expect(changesOf("i1")?.passing).toBe("s1");
    expect(passing).toEqual([{ itemId: "i1", parent: record("s1", SERIAL) }]);
  });

  it("never starts passing through a backend link on its own", async () => {
    metadataFake.parentRecords.value = new Map([
      ["s1", record("s1", SERIAL)],
      ["c1", record("c1")],
    ]);
    const { links, changesOf, passing } = setup({ targets: ["i1"], backend: { i1: ["s1"] } });
    await links.linkParent("c1");
    expect(changesOf("i1")?.passing).toBeNull();
    expect(passing).toEqual([]);
  });

  it("toggles passing on and off for the items that have the parent", async () => {
    metadataFake.parentRecords.value = new Map([["s1", record("s1", SERIAL)]]);
    const { links, changesOf } = setup({ targets: ["i1", "i2"], backend: { i1: ["s1"] } });
    await links.togglePassesData("s1");
    expect(changesOf("i1")?.passing).toBe("s1");
    expect(changesOf("i2")).toBeNull();
    await links.togglePassesData("s1");
    expect(changesOf("i1")).toBeNull();
  });
});
```

Create `src/composables/useBatchSetup.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { BatchStage, ItemRunStatus, type Batch } from "@domain/batch";
import { DEFAULT_CONFIG } from "@domain/config";
import { PublishTarget, VisibilityStatus } from "@domain/enums";
import { ItemState, type Item } from "@domain/item";
import type { ParentRecord } from "@domain/parent";

function makeBatch(itemIds: string[], over: Partial<Batch> = {}): Batch {
  const proc: Record<string, ItemRunStatus> = {};
  for (const id of itemIds) proc[id] = ItemRunStatus.Idle;
  return {
    id: "b1",
    no: 1,
    createdAt: "2026-09-29T00:00:00.000Z",
    type: ItemState.ToProcess,
    itemIds,
    stage: BatchStage.Setup,
    running: false,
    proc,
    cobissId: null,
    parents: [],
    publish: PublishTarget.DRAFT,
    visibility: VisibilityStatus.PRIVATE,
    overrides: {},
    archivedAt: null,
    backendTouchedAt: null,
    ...over,
  };
}

function item(id: string): Item {
  return { id, batchId: "b1", folderName: id, folderPath: `/p/${id}`, title: null } as unknown as Item;
}

function serial(id: string): ParentRecord {
  return { id, title: `Serial ${id}`, collectionType: 4, metadata: { collectionType: 4 } };
}

vi.mock("@services/batches", () => ({
  listBatches: async () => [] as Batch[],
  createBatch: async (f: unknown) => f as Batch,
  updateBatch: async (b: unknown) => b as Batch,
  archiveBatch: async (b: unknown) => b as Batch,
}));

const itemsFake = { items: [] as Item[], loaded: true, load: async () => {} };
vi.mock("@stores/useItems", () => ({ useItemsStore: () => itemsFake }));

const metadataFake = {
  parentRecords: ref(new Map<string, ParentRecord>()),
  parentLoading: ref(new Set<string>()),
  parentGone: ref(new Set<string>()),
  parentMissing: ref(new Set<string>()),
  parentFailed: ref(new Set<string>()),
  backendLinks: ref(new Map<string, string[] | null>()),
  ensureParents: async () => {},
  ensureParent: async () => {},
  findParents: async () => [] as ParentRecord[],
  ensureItemLoaded: async () => {},
  applyParentTo: vi.fn((_itemId: string, _parent: ParentRecord) => ({
    values: {},
    conflicts: [],
    applied: [],
    skipped: [],
    stillToFill: [],
  })),
  applyCobissTo: vi.fn(),
  flush: async () => {},
};
vi.mock("@stores/useMetadata", () => ({ useMetadataStore: () => metadataFake }));

const { useBatchSetup } = await import("./useBatchSetup");
const { useBatchesStore } = await import("@stores/useBatches");
const { useSettingsStore } = await import("@stores/useSettings");

beforeEach(() => {
  setActivePinia(createPinia());
  metadataFake.applyParentTo.mockClear();
  useSettingsStore().config = { ...DEFAULT_CONFIG, dataPassingCollectionTypes: [4] };
});

describe("Apply & continue", () => {
  it("fills each item from its own passing parent", async () => {
    metadataFake.parentRecords.value = new Map([
      ["s1", serial("s1")],
      ["s2", serial("s2")],
    ]);
    metadataFake.backendLinks.value = new Map([
      ["i1", []],
      ["i2", []],
    ]);
    useBatchesStore().batches = [
      makeBatch(["i1", "i2"], {
        overrides: {
          i1: { parents: { add: ["s1"], remove: [], passing: "s1" } },
          i2: { parents: { add: ["s2"], remove: [], passing: "s2" } },
        },
      }),
    ];
    itemsFake.items = [item("i1"), item("i2")];
    const setup = useBatchSetup(() => "b1");

    expect(await setup.applyAndContinue()).toBe(true);

    expect(metadataFake.applyParentTo.mock.calls.map(([id, p]) => [id, p.id])).toEqual([
      ["i1", "s1"],
      ["i2", "s2"],
    ]);
  });
});
```

In `src/composables/useMetadataForm.test.ts`:
- add `import type { Item } from "@domain/item";`
- replace the `@stores/useItems` mock with a module-level fake:

```ts
const itemsFake = { items: [] as Item[], loaded: true, load: async () => {} };
vi.mock("@stores/useItems", () => ({ useItemsStore: () => itemsFake }));
```

- add to `metadataFake`: `backendLinks: ref(new Map<string, string[] | null>()),` and `missingParentNamesOf: () => ({ gone: [], notFound: [] }),`
- in `beforeEach` add `itemsFake.items = []; metadataFake.backendLinks.value = new Map();`
- replace the body of "say why a parent is missing before its cached record's own type" up to `const view = …`:

```ts
    const batches = useBatchesStore();
    batches.batches = [
      makeBatch(["i1"], {
        overrides: { i1: { parents: { add: ["gone", "notFound", "failed", "ok"], remove: [], passing: null } } },
      }),
    ];
    itemsFake.items = [{ id: "i1", batchId: "b1", folderName: "i1", folderPath: "/p/i1", title: null } as unknown as Item];
    metadataFake.backendLinks.value = new Map([["i1", []]]);
```

(the record/gone/missing/failed seeding and the `typeLabel` assertion stay as they are).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/composables/useParentLinks.test.ts src/composables/useBatchSetup.test.ts src/composables/useMetadataForm.test.ts`
Expected: FAIL — the old composable reads `batch.parents` (rows empty), `restoreParent`/`linkParentToAll`/`passingParentOf` are not functions.

- [ ] **Step 3: Implement**

Replace `src/composables/useParentLinks.ts` with:

```ts
/**
 * `useParentLinks` (Epic 05) — the parent-link slice shared by the Setup and
 * Metadata tabs: the rows, the search box, link / unlink / undo, the
 * passes-data toggle and link-to-all.
 *
 * Links are per item (docs/superpowers/specs/2026-09-29-per-item-parents-design.md).
 * An item's parents are its backend links — its `metadata.json`, held by the
 * metadata store — plus the batch's pending changes for it
 * (`overrides[item].parents`). `targets` are the items an action applies to:
 * the current item in Metadata, every member in Setup. Changes persist through
 * `useBatches.update`; the upload makes the backend match.
 */

import { computed, onUnmounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { parentChangesOf, withParentChanges, type Batch } from "@domain/batch";
import type { Item } from "@domain/item";
import {
  isEligibleParent,
  itemParentIds,
  passingAfterLink,
  withParentLinked,
  withParentUnlinked,
  type ParentChanges,
  type ParentRecord,
} from "@domain/parent";
import { useBatchesStore } from "@stores/useBatches";
import { useMetadataStore } from "@stores/useMetadata";
import { useSettingsStore } from "@stores/useSettings";
import { useToastsStore } from "@stores/useToasts";
import { logger } from "@lib/logger";

/** Where a row's parent stands: on the backend, linked on upload, or unlinked on upload. */
export type ParentRowStatus = "linked" | "new" | "unlinking";

/** A parent of the targets, as the Setup/Metadata parent lists render it. */
export interface ParentRowView {
  id: string;
  name: string;
  /** "Serial" (data-passing type) / "Record", or why it isn't usable. */
  typeLabel: string;
  /** Eligible to pass data (serial-type collectionType). */
  canPassData: boolean;
  /** Passing its shared fields down to every target that has it. */
  passesData: boolean;
  status: ParentRowStatus;
  /** With several targets (Setup): how many of them have it; null for one item. */
  count: { on: number; of: number } | null;
}

/** One search hit in the parent picker. */
export interface ParentSearchRow {
  id: string;
  title: string;
  /** "Serial · can pass data" / "Record". */
  meta: string;
  /** Already a parent of every target. */
  linked: boolean;
  /** Already a parent of every item in the batch — Link to all has nothing to do. */
  linkedAll: boolean;
}

/** An item whose passing parent an action changed, and the parent now passing. */
export interface PassingChange {
  itemId: string;
  parent: ParentRecord | null;
}

const SEARCH_DEBOUNCE_MS = 350;

export interface UseParentLinksOptions {
  /** Every item in the batch, for {@link linkParentToAll}; defaults to the targets. */
  members?: () => Item[];
  /** After an action changed which parent passes data to some items — once per
   * action, so the caller can fill their empty fields and say so once. */
  onPassingChanged?: (changes: PassingChange[]) => void;
}

/** One item's side: backend links ([] while unknown), pending changes, and the parents they make. */
interface ItemLinks {
  backend: string[];
  changes: ParentChanges;
  ids: string[];
}

type Saved = Map<string, { before: ParentChanges; after: ParentChanges }>;

export function useParentLinks(
  batch: () => Batch | null,
  targets: () => Item[],
  options: UseParentLinksOptions = {},
) {
  const batches = useBatchesStore();
  const metadata = useMetadataStore();
  const settings = useSettingsStore();
  const toasts = useToastsStore();
  const { parentRecords, parentLoading, parentGone, parentMissing, parentFailed, backendLinks } =
    storeToRefs(metadata);
  const { config } = storeToRefs(settings);

  const dataPassingTypes = computed(() => config.value.dataPassingCollectionTypes);
  const members = (): Item[] => options.members?.() ?? targets();

  function isEligible(id: string): boolean {
    const record = parentRecords.value.get(id);
    return record != null && isEligibleParent(record, dataPassingTypes.value);
  }

  function linksOf(b: Batch, itemId: string): ItemLinks {
    const backend = backendLinks.value.get(itemId) ?? [];
    const changes = parentChangesOf(b, itemId);
    return { backend, changes, ids: itemParentIds(backend, changes) };
  }

  /** What a row list shows for one item: its parents, then its pending unlinks. */
  function shownIds(l: ItemLinks): string[] {
    return [...l.ids, ...l.changes.remove.filter((id) => l.backend.includes(id))];
  }

  const targetLinks = computed<ItemLinks[]>(() => {
    const b = batch();
    return b ? targets().map((t) => linksOf(b, t.id)) : [];
  });

  // Fetch the record of every parent the rows show (on open / after an edit).
  watch(
    () => [...new Set(targetLinks.value.flatMap(shownIds))].sort().join("|"),
    (key) => {
      if (key) void metadata.ensureParents(key.split("|"));
    },
    { immediate: true },
  );

  /** Why a parent is not usable comes first: a parent the upload was refused
   * for keeps its cached record, which would otherwise read as fine. */
  function typeLabelFor(id: string): string {
    if (parentGone.value.has(id)) return "No longer exists";
    if (parentMissing.value.has(id)) return "Not found on backend";
    if (parentFailed.value.has(id)) return "Couldn't load";
    if (parentRecords.value.has(id)) return isEligible(id) ? "Serial" : "Record";
    return parentLoading.value.has(id) ? "Loading…" : "Not found on backend";
  }

  const parents = computed<ParentRowView[]>(() => {
    const all = targetLinks.value;
    const order: string[] = [];
    for (const l of all) for (const id of shownIds(l)) if (!order.includes(id)) order.push(id);
    return order.map((id) => {
      const having = all.filter((l) => l.ids.includes(id));
      const status: ParentRowStatus =
        having.length === 0 ? "unlinking" : having.some((l) => l.backend.includes(id)) ? "linked" : "new";
      return {
        id,
        name: parentRecords.value.get(id)?.title ?? id,
        typeLabel: typeLabelFor(id),
        canPassData: isEligible(id),
        passesData: having.length > 0 && having.every((l) => l.changes.passing === id),
        status,
        count: all.length > 1 ? { on: having.length, of: all.length } : null,
      };
    });
  });

  /** The parent passing data to `itemId`, with its record, or null. */
  function passingParentOf(itemId: string): ParentRecord | null {
    const b = batch();
    if (!b) return null;
    const l = linksOf(b, itemId);
    const id = l.changes.passing;
    if (id === null || !l.ids.includes(id) || !isEligible(id)) return null;
    return parentRecords.value.get(id) ?? null;
  }

  /** The first target's passing parent (the Metadata tab's current item). */
  const passingParent = computed<ParentRecord | null>(() => {
    const first = targets()[0];
    return first ? passingParentOf(first.id) : null;
  });

  /** The first target's parents whose records we hold (the per-field source picker). */
  const linkedRecords = computed<ParentRecord[]>(() =>
    (targetLinks.value[0]?.ids ?? [])
      .map((id) => parentRecords.value.get(id))
      .filter((r): r is ParentRecord => r != null),
  );

  // ── persistence ──────────────────────────────────────────────────────────

  /** Apply `change` to each of `items`' pending changes and save the batch once. */
  async function apply(items: Item[], change: (l: ItemLinks) => ParentChanges): Promise<Saved | null> {
    const b = batch();
    if (!b || items.length === 0) return null;
    let next = b;
    const saved: Saved = new Map();
    for (const item of items) {
      const l = linksOf(b, item.id);
      const after = change(l);
      saved.set(item.id, { before: l.changes, after });
      next = withParentChanges(next, item.id, after);
    }
    try {
      await batches.update(next);
      return saved;
    } catch (err) {
      logger.error("parents", "Couldn't save the parent links.", err);
      toasts.push("Couldn't save the parent links.", "error");
      return null;
    }
  }

  /** Tell the caller which items' passing parent the action changed. */
  function reportPassing(saved: Saved): void {
    const changes: PassingChange[] = [];
    for (const [itemId, { before, after }] of saved) {
      if (before.passing === after.passing) continue;
      changes.push({ itemId, parent: after.passing ? (parentRecords.value.get(after.passing) ?? null) : null });
    }
    if (changes.length > 0) options.onPassingChanged?.(changes);
  }

  // ── search ───────────────────────────────────────────────────────────────

  const parentQuery = ref("");
  const searchResults = ref<ParentRecord[]>([]);
  const searching = ref(false);
  const searchError = ref<string | null>(null);
  let abort: AbortController | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const results = computed<ParentSearchRow[]>(() => {
    const b = batch();
    const onAll = (items: Item[], id: string) =>
      b != null && items.length > 0 && items.every((t) => linksOf(b, t.id).ids.includes(id));
    return searchResults.value.map((r) => {
      const eligible = r.collectionType != null && dataPassingTypes.value.includes(r.collectionType);
      return {
        id: r.id,
        title: r.title,
        meta: eligible ? "Serial · can pass data" : "Record",
        linked: onAll(targets(), r.id),
        linkedAll: onAll(members(), r.id),
      };
    });
  });

  async function search(): Promise<void> {
    const q = parentQuery.value.trim();
    abort?.abort();
    if (!q) {
      searchResults.value = [];
      searchError.value = null;
      return;
    }
    const controller = new AbortController();
    abort = controller;
    searching.value = true;
    try {
      const hits = await metadata.findParents(q, controller.signal);
      if (controller.signal.aborted) return;
      searchResults.value = hits;
      searchError.value = null;
    } catch (err) {
      if (controller.signal.aborted) return;
      searchError.value = (err as Error)?.message ?? "Search failed.";
      searchResults.value = [];
    } finally {
      if (abort === controller) searching.value = false;
    }
  }

  function setQuery(value: string): void {
    parentQuery.value = value;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void search();
    }, SEARCH_DEBOUNCE_MS);
  }

  function clearSearch(): void {
    abort?.abort();
    parentQuery.value = "";
    searchResults.value = [];
    searchError.value = null;
  }

  // ── link / unlink / undo / toggle ────────────────────────────────────────

  async function linkTo(items: Item[], id: string): Promise<void> {
    await metadata.ensureParent(id);
    const saved = await apply(items, (l) => {
      const linked = withParentLinked(l.changes, l.backend, id);
      const ids = itemParentIds(l.backend, linked);
      return { ...linked, passing: passingAfterLink(linked.passing, ids, id, isEligible) };
    });
    if (!saved) return;
    clearSearch();
    reportPassing(saved);
  }

  /** Link a parent to the targets. */
  function linkParent(id: string): Promise<void> {
    return linkTo(targets(), id);
  }

  /** Link a parent to every item in the batch (the Metadata tab's Link to all). */
  function linkParentToAll(id: string): Promise<void> {
    return linkTo(members(), id);
  }

  /** Unlink a parent from the targets: a pending link is dropped, a backend
   * link unlinks at the next upload. */
  async function removeParent(id: string): Promise<void> {
    const saved = await apply(targets(), (l) => withParentUnlinked(l.changes, l.backend, id));
    if (saved) reportPassing(saved);
  }

  /** Take back a pending unlink (the struck-through row's Undo). */
  async function restoreParent(id: string): Promise<void> {
    await apply(targets(), (l) =>
      l.changes.remove.includes(id) ? withParentLinked(l.changes, l.backend, id) : l.changes,
    );
  }

  /** Toggle whether a parent passes data, for the targets that have it. */
  async function togglePassesData(id: string): Promise<void> {
    const b = batch();
    if (!b) return;
    const having = targets().filter((t) => linksOf(b, t.id).ids.includes(id));
    const on = having.length > 0 && having.every((t) => linksOf(b, t.id).changes.passing === id);
    if (!on && !isEligible(id)) return;
    const saved = await apply(having, (l) => ({ ...l.changes, passing: on ? null : id }));
    if (saved) reportPassing(saved);
  }

  onUnmounted(() => {
    abort?.abort();
    if (debounce) clearTimeout(debounce);
  });

  return {
    parents,
    linkedRecords,
    passingParent,
    passingParentOf,
    // search
    parentQuery,
    setQuery,
    results,
    searching,
    searchError,
    search,
    clearSearch,
    // actions
    linkParent,
    linkParentToAll,
    removeParent,
    restoreParent,
    togglePassesData,
  };
}
```

In `src/composables/useMetadataForm.ts`, replace the `// ── parents …` block (the `useParentLinks(…)` call) with:

```ts
  // ── parents (the current item's own links; Link to all reaches every item) ──

  const links = useParentLinks(
    () => batch.value,
    () => (current.value ? [current.value] : []),
    {
      members: () => items.value,
      onPassingChanged: (changes) => {
        if (!editable.value) return;
        let fields = 0;
        let filled = 0;
        for (const { itemId, parent } of changes) {
          if (!parent) continue;
          const applied = metadata.applyParentTo(itemId, parent).applied.length;
          fields += applied;
          if (applied > 0) filled += 1;
        }
        if (fields === 0) return;
        toasts.push(
          filled === 1
            ? `Filled ${fields} field${fields === 1 ? "" : "s"} from the parent.`
            : `Filled ${fields} fields in ${filled} items from the parent.`,
          "success",
        );
      },
    },
  );
```

and add to the returned object under `// parents`: `restoreParent: links.restoreParent, linkParentToAll: links.linkParentToAll, memberCount: computed(() => items.value.length),`.

In `src/composables/useBatchSetup.ts`:
- move the `memberItems` computed above the `links` line, and change that line to `const links = useParentLinks(() => batch.value, () => memberItems.value);`
- in `applyAndContinue`:
  - delete the line `const passing = links.passingParent.value;` — the COBISS `preview` fetch right below it stays where it is;
  - replace the `let parentApplied = 0;` / `let cobissApplied = 0;` lines and the `for (const m of members) { … }` loop that follow the preview fetch with:

```ts
      let parentApplied = 0;
      let cobissApplied = 0;
      let fromParent = false;
      for (const m of members) {
        // Each item's own passing parent — items may have different ones.
        const passing = links.passingParentOf(m.id);
        if (passing) {
          fromParent = true;
          parentApplied += metadata.applyParentTo(m.id, passing).applied.length;
        }
        if (preview) cobissApplied += metadata.applyCobissTo(m.id, preview).applied.length;
      }
```

  - in the success toast's `sources` list, `passing ? "the parent" : null` becomes `fromParent ? "the parent" : null`.
- add `restoreParent: links.restoreParent,` to the returned object under `// parents`.
- update the module doc's first sentence: "Batch-wide defaults: … the linked parent records (+ which one passes data) — linked to every member item —, the publish target and visibility".

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run src/composables` then `npx vue-tsc --noEmit`
Expected: PASS; no type errors (the `.vue` files still bind the same names).

---

### Task 7: Upload — link and unlink per item

**Files:**
- Modify: `src/services/api/relations.ts` (`disconnectParent`)
- Modify: `src/services/upload.ts`
- Modify: `src/composables/useProcessing.ts` (context, waiting, messages)
- Modify: `src/domain/upload.ts:147` (doc wording)
- Test: `src/services/api/relations.test.ts`, `src/services/upload.test.ts`, `src/composables/useProcessing.test.ts`, `src/stores/useUpload.test.ts`

**Interfaces:**
- Consumes: `itemParentIds`, `linkChanges`, `nextBackendLinks`, `sameParentIds`, `ParentChanges` (Task 3); `RemoteRecord.parentIds` (Task 4); `parentChangesOf` (Task 3); store `ensureItemParents` (Task 5).
- Produces:
  - `disconnectParent(parentId, childId, options?): Promise<RelationWriteResult>`
  - `UploadDeps.disconnectParent`
  - `UploadItemContext.parentChanges: Pick<ParentChanges, "add" | "remove">` (replaces `parentIds`)
  - `export interface RelationError { parentId: string; message: string; action: "link" | "unlink" }`; `ItemUploadResult.relationErrors: RelationError[]`
  - `ExistingRecord.parentIds?: string[] | null`
  - `BatchUploadResult.allUploaded` also requires no `relationErrors`

- [ ] **Step 1: Write the failing tests**

`src/services/api/relations.test.ts`: add `disconnectParent,` to the import and, inside `describe("disconnectRelations")`:

```ts
  it("disconnectParent wraps a single child", async () => {
    const { client, calls } = harness(() => json(STATE, 200));
    await disconnectParent("par_1", "c1", { client });
    expect(calls[0].url).toBe("https://api.test/api/relations/disconnect");
    expect(JSON.parse(calls[0].body!)).toEqual({ parentId: "par_1", childIds: ["c1"] });
  });
```

`src/services/upload.test.ts`:
- in `fakeDeps`, after `connectParent`, add:

```ts
    disconnectParent: vi.fn(async (parentId: string) => ({
      parentId,
      version: 8,
      childrenInDrafts: 0,
      childrenInRecords: 0,
    })),
```

- in `CTX`, replace `parentIds: ["par1"],` with `parentChanges: { add: ["par1"], remove: [] },`
- in the first create test, add `parentIds: [],` to the expected `writeMirror` object (after `visibilityStatus`), and after it:

```ts
    // …then the link the connect made is recorded.
    expect((deps.writeMirror as any).mock.calls.at(-1)[1].parentIds).toEqual(["par1"]);
```

- in "collects parent states per parent, skipping the ones that failed", the context becomes `{ ...CTX, parentChanges: { add: ["par1", "bad", "par2"], remove: [] } }`
- in "records a parent-link failure without failing the upload", add `expect(res.relationErrors[0].action).toBe("link");`
- rename "creates a new item under the batch's parents and does not connect it afterwards" → "creates a new item under its parents and does not connect it afterwards"
- add inside `describe("uploadItem — create")`:

```ts
  it("records the links the create made, without a second write", async () => {
    const linked = [{ parentId: "par1", version: 9, childrenInDrafts: 1, childrenInRecords: 0 }];
    const deps = fakeDeps({ createItem: vi.fn(async () => ({ ...ENTITY, parents: linked })) });
    await uploadItem(makeItem(), CTX, deps);
    expect((deps.writeMirror as any).mock.calls[0][1].parentIds).toEqual(["par1"]);
    expect(deps.writeMirror).toHaveBeenCalledTimes(1);
  });
```

- add inside `describe("create collision — adoption")`:

```ts
  it("records the adopted record's own links and never unlinks one", async () => {
    const writeMirror = vi.fn(async () => {});
    const deps = fakeDeps({
      createItem: vi.fn(async () => conflict()),
      resolveExistingRecord: vi.fn(async () => ({ ...existing, parentIds: ["p_old"] })),
      updateItem: vi.fn(async () => ({ version: 8 })),
      writeMirror,
    });

    await uploadItem(makeItem(), { ...CTX, parentChanges: { add: ["par1"], remove: ["p_old"] } }, deps);

    expect(deps.connectParent).toHaveBeenCalledWith("par1", existing.id);
    expect(deps.disconnectParent).not.toHaveBeenCalled();
    const last = (writeMirror as any).mock.calls.at(-1)[1] as LocalMetadataFile;
    expect(last.parentIds).toEqual(["p_old", "par1"]);
  });
```

- add after `describe("uploadItem — replace")`:

```ts
describe("uploadItem — parent links on a re-upload", () => {
  const MIRROR: LocalMetadataFile = {
    backendId: "rec_1",
    version: 3,
    targetState: "RECORD",
    visibilityStatus: "PUBLIC",
    parentIds: ["p1", "p2"],
    metadata: { title: "Gorski vijenac", year: "2020" },
    syncedAt: "2026-08-01T00:00:00.000Z",
  };
  const reupload = () =>
    makeItem({ root: "processed", backendId: "rec_1", flags: { uploaded: true, reupload: false, reuploadTextOnly: false } });
  const ctx = (add: string[], remove: string[]): UploadItemContext => ({
    ...CTX,
    metadata: { title: "Gorski vijenac", year: "2020" },
    parentChanges: { add, remove },
  });

  it("links what was added and unlinks what was removed — nothing else", async () => {
    const deps = fakeDeps({ readMirror: vi.fn(async () => MIRROR) });
    const res = await uploadItem(reupload(), ctx(["p2", "p9"], ["p1"]), deps);

    expect(res.status).toBe("uploaded");
    expect(deps.connectParent).toHaveBeenCalledTimes(1);
    expect(deps.connectParent).toHaveBeenCalledWith("p9", "rec_1");
    expect(deps.disconnectParent).toHaveBeenCalledTimes(1);
    expect(deps.disconnectParent).toHaveBeenCalledWith("p1", "rec_1");
  });

  it("links before it unlinks", async () => {
    const order: string[] = [];
    const deps = fakeDeps({
      readMirror: vi.fn(async () => MIRROR),
      connectParent: vi.fn(async (parentId: string) => {
        order.push(`link ${parentId}`);
        return { parentId, version: 7, childrenInDrafts: 1, childrenInRecords: 0 };
      }),
      disconnectParent: vi.fn(async (parentId: string) => {
        order.push(`unlink ${parentId}`);
        return { parentId, version: 8, childrenInDrafts: 0, childrenInRecords: 0 };
      }),
    });
    await uploadItem(reupload(), ctx(["p9"], ["p1"]), deps);
    expect(order).toEqual(["link p9", "unlink p1"]);
  });

  it("makes no relation calls when the links didn't change", async () => {
    const deps = fakeDeps({ readMirror: vi.fn(async () => MIRROR) });
    await uploadItem(reupload(), ctx([], []), deps);
    expect(deps.connectParent).not.toHaveBeenCalled();
    expect(deps.disconnectParent).not.toHaveBeenCalled();
  });

  it("records the links the backend now has in the mirror", async () => {
    const deps = fakeDeps({ readMirror: vi.fn(async () => MIRROR) });
    await uploadItem(reupload(), ctx(["p9"], ["p1"]), deps);
    const last = (deps.writeMirror as any).mock.calls.at(-1)[1] as LocalMetadataFile;
    expect(last.parentIds).toEqual(["p2", "p9"]);
  });

  it("counts an unlink answered 404 as done — deleting the parent deleted its links", async () => {
    const deps = fakeDeps({
      readMirror: vi.fn(async () => MIRROR),
      disconnectParent: vi.fn(async () => {
        throw apiError("not_found", 404);
      }),
    });
    const res = await uploadItem(reupload(), ctx([], ["p1"]), deps);
    expect(res.relationErrors).toEqual([]);
    const last = (deps.writeMirror as any).mock.calls.at(-1)[1] as LocalMetadataFile;
    expect(last.parentIds).toEqual(["p2"]);
  });

  it("reports a failed unlink and records nothing, so the next upload retries it", async () => {
    const deps = fakeDeps({
      readMirror: vi.fn(async () => MIRROR),
      disconnectParent: vi.fn(async () => {
        throw apiError("forbidden", 403);
      }),
    });
    const res = await uploadItem(reupload(), ctx([], ["p1"]), deps);
    expect(res.status).toBe("uploaded");
    expect(res.relationErrors).toEqual([{ parentId: "p1", message: expect.any(String), action: "unlink" }]);
    const recorded = (deps.writeMirror as any).mock.calls.map((c: any[]) => c[1].parentIds);
    expect(recorded.every((ids: string[] | null) => ids?.includes("p1"))).toBe(true);
  });

  it("adopts an unlinked parent's new version", async () => {
    const parentItem = makeItem({ id: "parent-item", folderPath: "/parent", backendId: "p1" });
    const parentMirror: LocalMetadataFile = { ...MIRROR, backendId: "p1", version: 3, parentIds: [] };
    const deps = fakeDeps({
      readMirror: vi.fn(async (target: Item) => (target.id === "parent-item" ? parentMirror : MIRROR)),
      listItems: vi.fn(async () => [parentItem]),
    });
    await uploadItem(reupload(), ctx([], ["p1"]), deps);
    const write = (deps.writeMirror as any).mock.calls.find((c: any[]) => c[0].id === "parent-item");
    expect(write[1].version).toBe(8);
  });
});
```

- add inside `describe("orphan recovery")`:

```ts
  it("re-creates the record under its links: old ones kept, removed ones dropped, added ones added", async () => {
    const createItem = vi.fn(async () => ({ ...ENTITY, id: "new_rec", version: 0, metadata: {} }));
    const deps = fakeDeps({
      readMirror: vi.fn(async () => ({ ...ORPHAN_MIRROR, parentIds: ["p1", "p2"] })),
      updateItem: vi.fn(async () => {
        throw apiError("not_found", 404);
      }),
      createItem,
    });
    const item = { ...makeItem(), backendId: "cbwkbr9guqs3w11xylpri1ylw" };

    await uploadItem(item, { ...CTX, parentChanges: { add: ["p9"], remove: ["p1"] } }, deps);

    expect((createItem as any).mock.calls[0][0].parentIds).toEqual(["p2", "p9"]);
    expect(deps.disconnectParent).not.toHaveBeenCalled();
  });
```

- add inside `describe("uploadBatch")`:

```ts
  it("keeps the batch open when a parent link change failed", async () => {
    const deps = fakeDeps({
      connectParent: vi.fn(async () => {
        throw apiError("forbidden", 403);
      }),
    });
    const out = await uploadBatch([makeItem()], { resolveContext: () => CTX, deps });
    expect(out.results[0].status).toBe("uploaded");
    expect(out.allUploaded).toBe(false);
  });
```

- add inside `describe("resolveExistingRecord (default dep)")`:

```ts
  it("carries the record's own parent links", async () => {
    const hit: SearchHit = {
      id: "cbwkbr9guqs3w11xylpri1ylw",
      index: "records",
      score: 1,
      source: {
        version: 7,
        visibilityStatus: "PUBLIC",
        metadata: { cobissId: "12345" },
        parent_relations: [{ parentId: "p1", parentType: "RECORD" }],
      },
    };
    const found = await resolveExistingRecordWith("12345", { findById: vi.fn(async () => hit), previewCobiss: vi.fn() });
    expect(found?.parentIds).toEqual(["p1"]);
  });
```

- add inside `describe("withBackendWriteMark")`:

```ts
  it("marks before an unlink too — a run that only unlinks has changed the backend", async () => {
    const mark = vi.fn(async () => {});
    const disconnectParent = vi.fn(async () => ({}) as never);
    const deps = withBackendWriteMark(mark, { disconnectParent });
    await deps.disconnectParent!("p1", "c1");
    expect(mark).toHaveBeenCalledOnce();
    expect(disconnectParent).toHaveBeenCalledOnce();
  });
```

`src/stores/useUpload.test.ts:201`: replace `parentIds: ["p1"],` with `parentChanges: { add: ["p1"], remove: [] },`.

`src/composables/useProcessing.test.ts`:
- in `metadataFake`, replace `async ensureParents(_ids: readonly string[]) {},` with `async ensureItemParents(_item: Item) {},`; in `beforeEach`, replace `metadataFake.ensureParents = async () => {};` with `metadataFake.ensureItemParents = async () => {};` and add `uploadFake.resultsFor = () => new Map();`
- replace the test "waits for the batch's parents before building the upload contexts" with:

```ts
  it("waits for each item's parents before building the upload contexts", async () => {
    const item = makeItem({
      id: "nb",
      folderName: "nb",
      assets: [asset("nb", "nb.pdf"), asset("nb", "cover.jpg")],
      stages: stagesWith({ pdf: "done", thumbnail: "done", ocr: "done" }),
    });
    seed(makeBatch(["nb"], { stage: BatchStage.Processing, proc: { nb: ItemRunStatus.Done } }), [item]);
    const events: string[] = [];
    metadataFake.ensureItemParents = async (i: Item) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      events.push(`parents loaded: ${i.id}`);
    };
    uploadFake.run = async (_batchId, members, resolveContext) => {
      members.forEach(resolveContext);
      events.push("contexts built");
      return true;
    };
    const view = useProcessing(() => "b1");

    await view.upload();

    expect(events).toEqual(["parents loaded: nb", "contexts built"]);
  });

  it("hands each item its own pending parent-link changes", async () => {
    const done = { stages: stagesWith({ pdf: "done", thumbnail: "done", ocr: "done" }) };
    const a = makeItem({ id: "a", folderName: "a", assets: [asset("a", "a.pdf")], ...done });
    const b = makeItem({ id: "b", folderName: "b", assets: [asset("b", "b.pdf")], ...done });
    seed(
      makeBatch(["a", "b"], {
        stage: BatchStage.Processing,
        proc: { a: ItemRunStatus.Done, b: ItemRunStatus.Done },
        overrides: { a: { parents: { add: ["p9"], remove: ["p1"], passing: null } } },
      }),
      [a, b],
    );
    const seen: Record<string, unknown> = {};
    uploadFake.run = async (_batchId, members, resolveContext) => {
      for (const m of members) seen[m.id] = resolveContext(m).parentChanges;
      return true;
    };
    const view = useProcessing(() => "b1");

    await view.upload();

    expect(seen).toEqual({ a: { add: ["p9"], remove: ["p1"] }, b: { add: [], remove: [] } });
  });

  it("says the items uploaded but a link change failed, when that is all that went wrong", async () => {
    const item = makeItem({
      id: "nb",
      folderName: "nb",
      assets: [asset("nb", "nb.pdf")],
      stages: stagesWith({ pdf: "done", thumbnail: "done", ocr: "done" }),
    });
    seed(makeBatch(["nb"], { stage: BatchStage.Processing, proc: { nb: ItemRunStatus.Done } }), [item]);
    uploadFake.run = async () => false;
    uploadFake.resultsFor = () =>
      new Map([
        [
          "nb",
          {
            itemId: "nb",
            status: "uploaded" as const,
            backendId: "rec_1",
            created: false,
            blockers: [],
            warnings: [],
            fieldErrors: [],
            metadataRejected: false,
            relationErrors: [{ parentId: "p1", message: "Missing scope", action: "unlink" as const }],
            parentStates: [],
            missingParentIds: [],
            message: null,
          },
        ],
      ]);
    const toasts = useToastsStore();
    const view = useProcessing(() => "b1");

    await view.upload();

    expect(
      toasts.toasts.some(
        (t) =>
          t.message === "1 item uploaded, but a parent link change failed — upload again to retry." &&
          t.kind === "warning",
      ),
    ).toBe(true);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/services/api/relations.test.ts src/services/upload.test.ts src/composables/useProcessing.test.ts src/stores/useUpload.test.ts`
Expected: FAIL — `disconnectParent is not a function`; unlink/record/allUploaded expectations fail; `ensureItemParents` never called.

- [ ] **Step 3: Implement**

`src/services/api/relations.ts`, after `disconnectRelations`:

```ts
/** Convenience: unlink one child from one parent. */
export function disconnectParent(
  parentId: string,
  childId: string,
  options?: RelationsServiceOptions,
): Promise<RelationWriteResult> {
  return disconnectRelations({ parentId, childIds: [childId] }, options);
}
```

`src/services/upload.ts`:

1. Imports: `import { connectParent as apiConnectParent, disconnectParent as apiDisconnectParent } from "./api/relations";` and add to the `@domain/parent` import: `itemParentIds, linkChanges, nextBackendLinks, sameParentIds, type ParentChanges`. In the module header, replace the two flow lines with:

```ts
 *   new item:  preflight → create with its `parentIds` → write-through
 *              (`metadata.json` + SQLite) → adopt the parents' new versions
 *              → upload assets (roles + OCR text) → move folder to /processed
 *   re-upload: preflight → PATCH (changed keys, `null` for emptied ones)
 *              → write-through → replace / add assets → link added parents,
 *              then unlink removed ones → adopt the parents' new versions
 *              → record the item's links in its mirror
```

2. `UploadDeps`, after `connectParent`:

```ts
  /** Unlink one child from one parent (`POST /api/relations/disconnect`).
   * Resolves to the parent's post-write state, like {@link connectParent}. */
  disconnectParent: (parentId: string, childId: string) => Promise<RelationWriteResult>;
```

   `defaultDeps`: `disconnectParent: (parentId, childId) => apiDisconnectParent(parentId, childId),`. `withBackendWriteMark`, after the `connectParent` wrapper:

```ts
    disconnectParent: async (...args) => {
      await beforeWrite();
      return deps.disconnectParent(...args);
    },
```

3. `UploadItemContext`: replace `parentIds` with:

```ts
  /** This item's pending parent-link changes in the batch. A new item is
   * created under its adds; a re-upload links the adds the backend lacks and
   * unlinks the removes it has (`domain/parent.linkChanges`). */
  parentChanges: Pick<ParentChanges, "add" | "remove">;
```

   and change the `missingParents` doc to "Names of the item's parents that are not on the backend (a blocker)."

4. Above `ItemUploadResult`:

```ts
/** A parent link or unlink that failed; the record itself still uploaded. */
export interface RelationError {
  parentId: string;
  message: string;
  action: "link" | "unlink";
}
```

   and in `ItemUploadResult`: `/** Per-parent link/unlink failures (the record still uploaded; the batch stays open so the next upload retries them). */ relationErrors: RelationError[];`

5. `writeThrough`: add `parentIds: string[] | null;` to `facts`, `parentIds: facts.parentIds,` to the mirror (after `visibilityStatus`), change the return type to `Promise<LocalMetadataFile>` and end with `return mirror;`. Doc: "…after a successful upload, and return the mirror written."

6. Replace `linkedByCreate`:

```ts
/** The links a create made through `parentIds`, or null when the response does
 * not report them (an older backend) and `finishUpload` has to link. */
function linkedByCreate(created: CreatedItemEntity, parentIds: readonly string[]): RelationWriteResult[] | null {
  if (created.parents) return created.parents;
  return parentIds.length === 0 ? [] : null;
}
```

7. Replace `finishUpload` with:

```ts
/** The item's link state as this upload left it, for {@link finishUpload}. */
interface LinkState {
  /** The mirror this upload last wrote for the item. */
  mirror: LocalMetadataFile;
  /** The links a create made itself (`parentIds`), already adopted. */
  created: RelationWriteResult[];
  /** False on a record taken over after a create `409` (the operator never saw
   * its links) and on a brand-new record: nothing is unlinked. */
  mayUnlink: boolean;
}

/**
 * Finish an upload once the record and its assets are on the backend: link and
 * unlink parents so the backend matches the item's parents, adopt the parents'
 * bumped versions, record the item's links in its mirror, reposition the folder
 * to `/processed`, and build the `"uploaded"` result.
 *
 * Shared tail for the create branch of {@link uploadItem}, {@link replaceOnBackend}
 * and {@link recreateOrphaned}. Links before unlinks: an issue moved from one
 * serial to another never passes through a state with no serial, which the
 * backend's re-check on each call could refuse.
 */
async function finishUpload(
  item: Item,
  backendId: string,
  ctx: UploadItemContext,
  deps: UploadDeps,
  warnings: UploadWarning[],
  run: RunCreation,
  links: LinkState,
): Promise<ItemUploadResult> {
  const before = links.mirror.parentIds ?? null;
  const plan = linkChanges(before, ctx.parentChanges);
  // A per-parent failure doesn't undo the upload: it is reported, and keeps the
  // batch open so the next upload retries it (`uploadBatch`).
  const connected = await connectParents(backendId, plan.connect, deps);
  const disconnected = links.mayUnlink
    ? await disconnectParents(backendId, plan.disconnect, deps)
    : { errors: [] as RelationError[], states: [] as RelationWriteResult[], unlinked: [] as string[] };
  const states = [...connected.states, ...disconnected.states];
  // Each link and unlink bumped the parent's version; adopt it now or the
  // parent's next PATCH 409s. Never throws — see `applyParentStates`.
  await applyParentStates(states, deps);

  const after = nextBackendLinks(before, connected.linked, disconnected.unlinked);
  if (!sameParentIds(before, after)) {
    await deps.writeMirror(item, { ...links.mirror, parentIds: after, syncedAt: deps.now() });
  }

  // Reposition to `/processed` on first upload (a replace already lives there).
  if (item.root === "unprocessed") {
    try {
      await deps.moveToProcessed(item);
    } catch (err) {
      logger.warn("upload", `Uploaded ${item.id} but failed to move to /processed.`, err);
    }
  }

  // `created` is carried onto the success result too. `removableBackendIds`
  // drops `uploaded` before it ever looks at the flag, so nothing depends on
  // it here — but a field documented as "this run created this record" must
  // not quietly read `false` on the one outcome where it is most obviously
  // true.
  return result(item.id, "uploaded", {
    backendId,
    created: run.created,
    warnings,
    relationErrors: [...connected.errors, ...disconnected.errors],
    parentStates: [...links.created, ...states],
  });
}
```

8. In `uploadItem`:
   - delete the three hoisted declarations: `let linked: RelationWriteResult[] | null = null;` (and its two-line comment, above the `try`), `let version: number | null;` and `let mirrorMetadata: RecordMetadata;`;
   - above `let created: CreatedItemEntity;` add `const parentIds = itemParentIds([], ctx.parentChanges);`, and in the `createOnBackend({ … })` call replace `parentIds: ctx.parentIds,` with `parentIds,`;
   - in the adoption `catch`, the last argument of `return await replaceOnBackend(…)` becomes:

```ts
          { suppressVisibility: true, keepEmptied: true, keepLinks: true },
```

   - replace everything from `backendId = created.id;` to the end of the `try` block — through `return await finishUpload(item, backendId, ctx, deps, warnings, run, linked);`, which takes the `} else { … replaceOnBackend … }` with it — by:

```ts
      backendId = created.id;
      // The create site. From here on this run owns the record: if anything
      // below fails, close-time cleanup may delete it.
      run.created = true;
      run.backendId = created.id;
      // The links the create made itself — null when the response doesn't say
      // (an older backend); `finishUpload` then links as before.
      const linked = linkedByCreate(created, parentIds);

      // Persist the connection + mirror BEFORE the assets, so a mid-flight
      // failure (or crash) leaves a recoverable link — a retry then REPLACEs
      // (never double-creates). The item reads `uploaded` briefly while assets
      // are still pending, but the batch only archives on an all-`uploaded` run,
      // so it stays In progress until the assets land.
      const written = await writeThrough(item, deps, {
        backendId,
        version: created.version,
        targetState: ctx.targetState,
        visibility: ctx.visibility,
        metadata: created.metadata,
        parentIds: linked ? linked.map((s) => s.parentId) : [],
      });

      // The create linked the parents and bumped their versions: adopt them now,
      // before the files — if an asset fails, the links still exist.
      if (linked) await applyParentStates(linked, deps);

      const attachments = await uploadCreateAssets(backendId, plan, deps, warnings);
      warnings.push(...textQualityWarnings(attachments));
      return await finishUpload(item, backendId, ctx, deps, warnings, run, {
        mirror: written,
        created: linked ?? [],
        mayUnlink: false,
      });
    }
    // Replace (re-upload) — stable id, stays in `/processed`.
    return await replaceOnBackend(item, ctx, plan, pruned, mirror, deps, warnings, run);
```

9. `ReplaceOnBackendOptions`: add `/** Never unlink (a taken-over record: the operator never saw its links). */ keepLinks?: boolean;`. In `replaceOnBackend`, the write-through becomes `const written = await writeThrough(item, deps, { …existing facts…, parentIds: mirror.parentIds ?? null });` and the tail call:

```ts
  return await finishUpload(item, backendId, ctx, deps, warnings, run, {
    mirror: written,
    created: [],
    mayUnlink: !options.keepLinks,
  });
```

10. `ExistingRecord`: add `/** The record's own parent ids, when the read carried them. */ parentIds?: string[] | null;`. In `hitToExisting`'s returned object add `parentIds: remote.parentIds,`. Replace the body of `adoptExistingRecord` after the `visibilityStatus` line with:

```ts
  return writeThrough(item, deps, {
    backendId: existing.id,
    version: existing.version,
    targetState: existing.targetState,
    visibility: visibilityStatus,
    metadata: existing.metadata,
    parentIds: existing.parentIds ?? null,
  });
```

11. `recreateOrphaned`, from the create call to the end:

```ts
  // The old links went with the deleted record: re-create it under the item's
  // parents — the ones it had, minus the removed, plus the added.
  const parentIds = itemParentIds(mirror.parentIds ?? [], ctx.parentChanges);
  const created = await createOnBackend(
    { targetState, visibilityStatus: visibility, metadata: pruned, parentIds },
    deps,
  );
  // The second (and last) create site. The old link was authoritatively 404'd
  // and this record is brand new, so if the assets below fail there is nothing
  // here but a record this run stranded.
  run.created = true;
  run.backendId = created.id;
  const linked = linkedByCreate(created, parentIds);
  const written = await writeThrough(item, deps, {
    backendId: created.id,
    version: created.version,
    targetState,
    visibility,
    metadata: created.metadata,
    parentIds: linked ? linked.map((s) => s.parentId) : [],
  });
  if (linked) await applyParentStates(linked, deps);
  const attachments = await uploadCreateAssets(
    created.id,
    { ...plan, backendId: created.id },
    deps,
    warnings,
  );
  warnings.push(...textQualityWarnings(attachments));
  return await finishUpload(
    item,
    created.id,
    { ...ctx, parentChanges: { add: parentIds, remove: [] } },
    deps,
    warnings,
    run,
    { mirror: written, created: linked ?? [], mayUnlink: false },
  );
```

12. `connectParents` returns `{ errors: RelationError[]; states: RelationWriteResult[]; linked: string[] }`: push `parentId` onto `linked` right after the awaited connect succeeds, and push errors as `{ parentId, message, action: "link" }`. Below it add:

```ts
/**
 * Unlink the item from each parent (one call each). A `404` means the parent
 * itself is gone — deleting an item deletes its links — so it counts as
 * unlinked. Other failures are collected like {@link connectParents}'.
 */
async function disconnectParents(
  childId: string,
  parentIds: string[],
  deps: UploadDeps,
): Promise<{ errors: RelationError[]; states: RelationWriteResult[]; unlinked: string[] }> {
  const errors: RelationError[] = [];
  const states: RelationWriteResult[] = [];
  const unlinked: string[] = [];
  for (const parentId of parentIds) {
    try {
      const state = await withRetry(() => deps.disconnectParent(parentId, childId), deps);
      unlinked.push(parentId);
      if (state && typeof state.version === "number") states.push(state);
    } catch (err) {
      if (err instanceof ApiError && err.kind === "not_found") {
        unlinked.push(parentId);
        continue;
      }
      logger.warn("upload", `Failed to unlink ${childId} from parent ${parentId}.`, err);
      errors.push({ parentId, message: err instanceof Error ? err.message : String(err), action: "unlink" });
    }
  }
  return { errors, states, unlinked };
}
```

13. `uploadBatch`'s last line: `return { results, allUploaded: results.every((r) => r.status === "uploaded" && r.relationErrors.length === 0), missingParentIds: [] };`. `BatchUploadResult.allUploaded` doc: "True when every attempted item reached `uploaded` with all its link changes made — the caller then archives the batch. A failed link or unlink keeps the batch open so the next upload retries it."

`src/domain/upload.ts:147`: "Names of the batch's parents that are not on the backend" → "Names of the item's parents that are not on the backend".

`src/composables/useProcessing.ts`:
- add `parentChangesOf,` to the `@domain/batch` import (after `isArchived,`)
- in `upload()`, replace the `ensureParents` line and `resolveContext` with:

```ts
    // The gate reads each item's parents: wait for its links and their records.
    await Promise.all(members.map((m) => metadata.ensureItemParents(m)));
    await metadata.flush();
    const resolveContext = (item: Item): UploadItemContext => {
      const changes = parentChangesOf(b, item.id);
      return {
        // An uploaded item keeps its backend state; the batch's choice is for new ones.
        targetState: metadata.backendStates.get(item.id) ?? resolveItemPublish(b, item.id),
        visibility: resolveItemVisibility(b, item.id),
        parentChanges: { add: changes.add, remove: changes.remove },
        metadata: metadata.wireMetadata(item.id),
        metadataReady: metadata.isReady(item),
        primaryThumbnail: null,
        missingParents: metadata.missingParentNamesOf(item),
        emptied: metadata.emptiedKeys(item.id),
      };
    };
```

- replace the final `else` branch of the upload toast with:

```ts
    } else {
      const res = Array.from(uploadStore.resultsFor(b.id).values());
      const failed = res.filter((r) => r.status !== "uploaded").length;
      const linkFailed = res.filter((r) => r.status === "uploaded" && r.relationErrors.length > 0).length;
      if (failed === 0 && linkFailed > 0) {
        toasts.push(
          `${linkFailed} item${linkFailed === 1 ? "" : "s"} uploaded, but a parent link change failed — upload again to retry.`,
          "warning",
        );
      } else {
        toasts.push(`${failed} item${failed === 1 ? "" : "s"} did not upload — see the list.`, "warning");
      }
    }
```

- in `uploadViewFor`, the relation-error message becomes:

```ts
              ? `Uploaded, but ${r.relationErrors.length} parent link change${r.relationErrors.length === 1 ? "" : "s"} failed — upload again to retry.`
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run` then `npx vue-tsc --noEmit`
Expected: the whole suite PASSES; no type errors.

---

### Task 8: Remove the batch-wide list

**Files:**
- Modify: `src/domain/batch.ts` (`Batch.parents`, `BatchParentRef` doc, `newBatchFields`)
- Modify: `src/services/batches.ts` (`toBatch`)
- Modify: `src/ipc/bindings.ts` (`BatchDto.parents` optional)
- Modify: `src/domain/parent.ts` (drop the batch-list helpers, new module doc)
- Modify (fixtures): `src/domain/batch.test.ts:57,424`, `src/composables/useMetadataForm.test.ts:29`, `src/composables/useProcessing.test.ts:65`, `src/composables/useParentLinks.test.ts`, `src/composables/useBatchSetup.test.ts`, `src/services/pipeline.test.ts:67`, `src/stores/useProcessing.test.ts:60`, `src/domain/parent.test.ts`
- Modify (comments and test names that still say "the batch's parents"): `src/composables/useMetadataForm.ts`, `src/domain/parent.ts`, `src/domain/provenance.ts`, `src/domain/schema-check.ts`, `src/domain/upload.ts`, `src/stores/useMetadata.ts`, `src/domain/schema-check.test.ts`, `src/domain/upload.test.ts`

**Interfaces:**
- Produces: `Batch` without `parents`; `BatchDto.parents?: BatchParentRef[]` (legacy); `@domain/parent` without `ParentRef`, `LinkedParent`, `resolveLinkedParents`, `toParentRefs`, `setDataPassingParent`, `toggleDataPassing`, `dataPassingParentId`, `dataPassingParent`, `eligibleParents`, `withDefaultPassing`.

- [ ] **Step 1: Write the failing test** — in `src/domain/batch.test.ts` "newBatchFields — create defaults", replace `expect(f.parents).toEqual([]);` with:

```ts
    expect(f).not.toHaveProperty("parents"); // parents are per item now (overrides[item].parents)
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/domain/batch.test.ts`
Expected: FAIL — `newBatchFields` still sets `parents: []`.

- [ ] **Step 3: Implement**

- `src/domain/batch.ts`: delete `parents: BatchParentRef[];` (and its doc line) from `Batch`; delete `parents: [],` from `newBatchFields`, and change its doc "no parents/overrides" to "no overrides"; replace `BatchParentRef`'s doc with "Legacy: the batch-wide parent list before per-item links. Schema v5 moved it onto each item (`BatchItemOverride.parents`); kept only for the IPC shape of the old column."
- `src/services/batches.ts`: delete `parents: dto.parents ?? [],` from `toBatch`.
- `src/ipc/bindings.ts`: make it `parents?: BatchParentRef[];` with the doc "Legacy batch-wide parents — always `[]` since schema v5 (per-item links live in `overrides[item].parents`). Nothing reads it; the native side defaults it."
- `src/domain/parent.ts`: delete `ParentRef`, `LinkedParent`, `resolveLinkedParents`, `toParentRefs`, `setDataPassingParent`, `toggleDataPassing`, `dataPassingParentId`, `dataPassingParent`, `eligibleParents`, `withDefaultPassing`. Replace the module doc with:

```ts
/**
 * The **Parent record** domain model + the per-item link rules (Epic 05).
 *
 * A parent is a catalogue record an item is filed under. There is **no backend
 * collections endpoint** — parents are found via search (`services/api/collections`),
 * and each hit's `collectionType` (a NUMBER inside the record metadata) decides
 * whether it may pass its shared fields down to children (docs/tasks/05, and the
 * verified contract in docs/PROJECT-KNOWLEDGE.md §4).
 *
 * Links are per item (docs/superpowers/specs/2026-09-29-per-item-parents-design.md):
 *  - an item's **backend links** are kept in its `metadata.json` (`parentIds`);
 *  - a batch holds each item's **pending changes** ({@link ParentChanges});
 *  - the item's parents are backend links + adds − removes ({@link itemParentIds}),
 *    and an upload makes the backend match ({@link linkChanges}).
 *
 * **Eligibility** — a parent may pass data only when its `collectionType` is in
 * the configured data-passing set (`AppConfig.dataPassingCollectionTypes`); at
 * most one of an item's parents passes data (`ParentChanges.passing`).
 *
 * Framework-free — imports only sibling domain types.
 */
```

- Tests: delete the `parents: [],` line from the `makeBatch` fixtures in `batch.test.ts`, `useMetadataForm.test.ts`, `useProcessing.test.ts`, `useParentLinks.test.ts`, `useBatchSetup.test.ts`, `services/pipeline.test.ts` and `stores/useProcessing.test.ts`. In `parent.test.ts`, delete the `describe` blocks "resolveLinkedParents", "the one-passes-data invariant" and "withDefaultPassing", and drop the deleted names (and `type ParentRef`) from its imports.

- [ ] **Step 4: Reword what still says "the batch's parents"**

Tasks 5–7 already rewrote most of these; the rest (current wording → new wording):

| File | Now | Becomes |
|---|---|---|
| `src/composables/useMetadataForm.ts` (the `check` doc) | "null while the schema or the batch's parents are still loading" | "null while the schema or the item's parents are still loading" |
| `src/composables/useMetadataForm.ts` (the `parentBanner` doc) | "One banner when a batch parent is not on the backend (it blocks every item): …" | "One banner when one of the item's parents is not on the backend (it blocks the upload): …" |
| `src/domain/parent.ts` (`missingParentMessage` doc) | "The one message for batch parents that are not on the backend." | "The one message for parents that are not on the backend." |
| `src/domain/parent.ts` (`MissingParentNames` doc) | "The names of a batch's parents that are not on the backend, …" | "The names of an item's parents that are not on the backend, …" |
| `src/domain/provenance.ts` | "`collectionType` of each of the batch's parents ([] when it has none)." | "`collectionType` of each of the item's parents ([] when it has none)." |
| `src/domain/provenance.ts` | "Route to the ingestion case from the batch's parents + COBISS presence:" | "Route to the ingestion case from the item's parents + COBISS presence:" |
| `src/domain/schema-check.ts` (module doc) | "The rules see the item's batch's parents and whose rules apply:" | "The rules see the item's parents and whose rules apply:" |
| `src/domain/schema-check.ts` | "The metadata of the batch's parents." | "The metadata of the item's parents." |
| `src/domain/schema-check.ts` (`itemRole` doc) | "What the batch's parents make the item — shown in the navigator." | "What the item's parents make it — shown in the navigator." |
| `src/domain/upload.ts` | "A batch parent is not on the backend (search 404, or refused on upload)." | "One of the item's parents is not on the backend (search 404, or refused on upload)." |
| `src/stores/useMetadata.ts` (`checkOf` doc) | "null while the schema or a batch parent is still loading." | "null while the schema or one of the item's parents is still loading." |
| `src/stores/useMetadata.ts` (`isReady` doc) | "Ready to upload: the check passes and every batch parent loaded." | "Ready to upload: the check passes and every one of the item's parents loaded — its own links too." |
| `src/stores/useMetadata.ts` (`missingParentNamesOf` doc) | "Names of the item's batch parents that are not on the backend: …" | "Names of the item's parents that are not on the backend: …" |

Test names:
- `src/domain/schema-check.test.ts`: "reads what the batch's parents make the item" → "reads what the item's parents make it"
- `src/domain/upload.test.ts`: "blocks every item while a batch parent can't be found" → "blocks an item while one of its parents can't be found"

Run: `grep -rn -i "batch's parents\|batch parent" src`
Expected: no output.

- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `npx vitest run` then `npx vue-tsc --noEmit`
Expected: PASS; no type errors — `vue-tsc` confirms nothing reads `Batch.parents` any more.

---

### Task 9: The parent card — pending tags, Undo, counts, Link to all (GUI)

**Files:**
- Modify: `src/components/batch/ParentRecordsCard.vue`
- Modify: `src/views/batch/MetadataTab.vue`, `src/views/batch/SetupTab.vue`
- Test: new `src/components/batch/ParentRecordsCard.test.ts`

**Interfaces:**
- Consumes: `ParentRowView.status/count`, `ParentSearchRow.linkedAll` (Task 6); `useMetadataForm` `restoreParent`, `linkParentToAll`, `memberCount`; `useBatchSetup` `restoreParent` (Task 6).
- Produces: `ParentRecordsCard` prop `linkAllCount?: number`; events `restore: [id]`, `linkAll: [id]`.

- [ ] **Step 1: Write the failing test** — create `src/components/batch/ParentRecordsCard.test.ts`:

```ts
/**
 * Render smoke tests for the parent card: the pending link states and the
 * bulk actions must actually reach the operator (see ProcessingTab.test.ts).
 */

import { describe, it, expect } from "vitest";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import type { ParentRowView, ParentSearchRow } from "@composables/useParentLinks";
import ParentRecordsCard from "./ParentRecordsCard.vue";

function row(over: Partial<ParentRowView> & { id: string }): ParentRowView {
  return {
    name: `Parent ${over.id}`,
    typeLabel: "Record",
    canPassData: false,
    passesData: false,
    status: "linked",
    count: null,
    ...over,
  };
}

function render(props: {
  parents?: ParentRowView[];
  results?: ParentSearchRow[];
  query?: string;
  linkAllCount?: number;
}): Promise<string> {
  return renderToString(
    createSSRApp(ParentRecordsCard, {
      parents: [],
      editable: true,
      query: "",
      results: [],
      searching: false,
      searchError: null,
      ...props,
    }),
  );
}

describe("ParentRecordsCard", () => {
  it("marks a parent that links on upload", async () => {
    expect(await render({ parents: [row({ id: "p9", status: "new" })] })).toContain("New — links on upload");
  });

  it("strikes through a parent that unlinks on upload and offers Undo instead of Unlink", async () => {
    const html = await render({ parents: [row({ id: "p1", status: "unlinking" })] });
    expect(html).toContain('class="parent-row unlinking"');
    expect(html).toContain("Unlinks on upload");
    expect(html).toContain("Undo");
    expect(html).not.toContain('title="Unlink"');
  });

  it("says how many items have each parent in Setup", async () => {
    const html = await render({
      parents: [row({ id: "p1", count: { on: 2, of: 4 } }), row({ id: "p2", count: { on: 4, of: 4 } })],
    });
    expect(html).toContain("on 2 of 4 items");
    expect(html).toContain("on all 4 items");
  });

  it("offers Link to all only when the batch has more than one item", async () => {
    const results: ParentSearchRow[] = [
      { id: "p9", title: "Pobjeda", meta: "Record", linked: false, linkedAll: false },
    ];
    expect(await render({ query: "pob", results, linkAllCount: 3 })).toContain("Link to all 3 items");
    expect(await render({ query: "pob", results, linkAllCount: 1 })).not.toContain("Link to all");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/components/batch/ParentRecordsCard.test.ts`
Expected: FAIL — none of the new strings are rendered.

- [ ] **Step 3: Implement**

`src/components/batch/ParentRecordsCard.vue` — in the script, replace `defineProps` and `defineEmits` with the following, and add `offerLinkAll` and `countLabel` below `noMatches` (`trimmedQuery`, `showResults`, `noMatches` and `onInput` stay as they are):

```ts
const props = defineProps<{
  parents: ParentRowView[];
  editable: boolean;
  /** Card description under the heading. */
  description?: string;
  /** Parent search box state (owned by the composable). */
  query: string;
  results: ParentSearchRow[];
  searching: boolean;
  searchError: string | null;
  /** Items "Link to all" reaches; below 2 it isn't offered. */
  linkAllCount?: number;
}>();

const emit = defineEmits<{
  updateQuery: [value: string];
  link: [id: string];
  linkAll: [id: string];
  remove: [id: string];
  restore: [id: string];
  togglePass: [id: string];
}>();

const offerLinkAll = computed(() => (props.linkAllCount ?? 0) > 1);

/** " · on all 4 items" / " · on 2 of 4 items" in Setup; "" for one item. */
function countLabel(p: ParentRowView): string {
  if (!p.count) return "";
  return p.count.on === p.count.of
    ? ` · on all ${p.count.of} items`
    : ` · on ${p.count.on} of ${p.count.of} items`;
}
```

Template — the row becomes:

```vue
      <div
        v-for="p in parents"
        :key="p.id"
        class="parent-row"
        :class="{ unlinking: p.status === 'unlinking' }"
      >
        <span class="type-chip">{{ p.typeLabel.charAt(0) }}</span>
        <div class="parent-text">
          <div class="parent-name">{{ p.name }}</div>
          <div class="parent-meta">{{ p.typeLabel }} · {{ p.id }}{{ countLabel(p) }}</div>
        </div>
        <template v-if="p.status === 'unlinking'">
          <span class="status-tag unlinking">Unlinks on upload</span>
          <button v-if="editable" class="undo-btn" @click="emit('restore', p.id)">Undo</button>
        </template>
        <template v-else>
          <span v-if="p.status === 'new'" class="status-tag new">New — links on upload</span>
          <button
            v-if="p.canPassData && editable"
            class="pass-btn"
            :class="{ passing: p.passesData }"
            :title="
              p.passesData
                ? 'Passing its shared fields down — click to stop'
                : 'Click to make this the data-passing parent'
            "
            @click="emit('togglePass', p.id)"
          >
            {{ p.passesData ? "↧ passes data" : "○ can pass data" }}
          </button>
          <span v-else-if="p.passesData" class="pass-btn passing static">↧ passes data</span>
          <button v-if="editable" class="remove-btn" title="Unlink" @click="emit('remove', p.id)">
            <svg
              viewBox="0 0 20 20"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
            >
              <line x1="5" y1="5" x2="15" y2="15" />
              <line x1="15" y1="5" x2="5" y2="15" />
            </svg>
          </button>
        </template>
      </div>
```

and each search result becomes:

```vue
        <div v-for="r in results" :key="r.id" class="result-line">
          <button class="result-row" :disabled="r.linked" @click="emit('link', r.id)">
            <span class="result-text">
              <span class="result-title">{{ r.title }}</span>
              <span class="result-meta">{{ r.meta }} · {{ r.id }}</span>
            </span>
            <span class="result-action">{{ r.linked ? "Linked" : "+ Link" }}</span>
          </button>
          <button
            v-if="offerLinkAll"
            class="link-all"
            :disabled="r.linkedAll"
            @click="emit('linkAll', r.id)"
          >
            Link to all {{ linkAllCount }} items
          </button>
        </div>
```

Styles to add:

```css
.parent-row.unlinking {
  opacity: 0.7;
}

.parent-row.unlinking .parent-name {
  text-decoration: line-through;
}

.status-tag {
  font-size: 11px;
  font-weight: 600;
  padding: 4px 8px;
  border-radius: var(--r-sm);
  white-space: nowrap;
  flex: none;
}

.status-tag.new {
  color: var(--c-primary);
  background: var(--c-primary-soft);
}

.status-tag.unlinking {
  color: var(--c-danger-text);
  background: var(--c-danger-bg);
}

.undo-btn {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-parent-btn);
  padding: 4px 8px;
  flex: none;
}

.result-line {
  display: flex;
  align-items: center;
  gap: 6px;
}

.result-line .result-row {
  flex: 1;
  min-width: 0;
}

.link-all {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-parent-btn);
  white-space: nowrap;
  padding: 8px 10px;
  border-radius: 8px;
}

.link-all:hover:not(:disabled) {
  background: var(--c-parent-card);
}

.link-all:disabled {
  opacity: 0.6;
  cursor: default;
}
```

`src/views/batch/MetadataTab.vue`: destructure `restoreParent, linkParentToAll, memberCount` from `useMetadataForm`, and change the card to:

```vue
      <ParentRecordsCard
        :parents="parents"
        :editable="editable"
        :query="parentQuery"
        :results="parentResults"
        :searching="parentSearching"
        :search-error="parentSearchError"
        :link-all-count="memberCount"
        description="This item's parents. Changes are sent to the backend when the batch uploads."
        @update-query="setParentQuery($event)"
        @link="linkParent($event)"
        @link-all="linkParentToAll($event)"
        @remove="removeParent($event)"
        @restore="restoreParent($event)"
        @toggle-pass="togglePassesData($event)"
      />
```

`src/views/batch/SetupTab.vue`: destructure `restoreParent`, add `@restore="restoreParent($event)"` to the card, and set its description to `Link one or more parents to every item in the batch. Only one passes data at a time — its shared fields copy down to the items that have it. Click can pass data on another to switch the source.`

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run src/components/batch/ParentRecordsCard.test.ts src/views` then `npx vue-tsc --noEmit`
Expected: PASS; no type errors.

---

### Task 10: Docs

**Files:**
- Modify: `docs/01-concept-and-ux.md`, `docs/tasks/05-cobiss-parents-and-provenance.md`, `docs/tasks/07-upload-and-publish.md`, `docs/tasks/metadata-schema-v2.md`, `docs/PROJECT-KNOWLEDGE.md`, `docs/superpowers/specs/2026-09-29-per-item-parents-design.md`
- Modify (WSL): `~/nbcg/docs/shared/plans/metadata-schema-v2-archive-app.md`

- [ ] **Step 1: This repo**

- `docs/01-concept-and-ux.md`, the Setup "Parent records" bullet becomes:

```md
   - **Parent records** — link one or more parents (by id) to every item in the
     batch. Links belong to each item, not the batch: an item keeps its parents
     in its `metadata.json` and shows them in any later batch; removing one from
     an uploaded item unlinks it at the next upload. A parent is **eligible to
     pass data** only if its `collectionType` is in the data-passing set
     (serial-type; exact value TBD). Among an item's eligible parents, at most
     **one passes data** (its shared fields copy down); ineligible types can be
     linked but never pass data.
```

- `docs/tasks/05-cobiss-parents-and-provenance.md`: in the schema v2 note, "batch's parents" → "item's parents"; below that note add:

```md
>
> **Per-item parents, 2026-09-29.** Parent links belong to items: each keeps its
> parents in `metadata.json` (`parentIds`), a batch holds only pending changes per
> item, and a re-upload unlinks removed parents. See
> [the design](../superpowers/specs/2026-09-29-per-item-parents-design.md).
```

- `docs/tasks/07-upload-and-publish.md`, below the schema v2 note:

```md
>
> **Per-item parents, 2026-09-29.** A new item is created under its own parents; a
> re-upload links added parents, then unlinks removed ones
> (`POST /api/relations/disconnect`, a `404` counts as done), records the item's
> links in `metadata.json`, and a failed link change keeps the batch open. See
> [the design](../superpowers/specs/2026-09-29-per-item-parents-design.md).
```

- `docs/tasks/metadata-schema-v2.md`: "worked out from the batch's parents" → "worked out from the item's parents"; "It uses the batch's parents and the item's backend state" → "It uses the item's parents and its backend state"; "every batch parent" → "every one of its parents"; "The upload waits for the batch's parents before it checks readiness." → "The upload waits for each item's parents before it checks readiness."; and in the "Still to do by hand" table, "(batch parent: Serial collection)" → "(parent: Serial collection)" and "Remove a batch parent on the website, then upload" → "Remove an item's parent on the website, then upload".
- `docs/PROJECT-KNOWLEDGE.md:685`: "is derived from its batch's parents'" → "is derived from its parents'".
- The spec's status line: `_2026-09-29 · status: implemented (plan: \`docs/superpowers/plans/2026-09-29-per-item-parents.md\`)_`.

- [ ] **Step 2: The shared plan in WSL** — `~/nbcg/docs/shared/plans/metadata-schema-v2-archive-app.md` gets a note under its `## Status:` line. Edit the WSL clone (the Windows clone can lag behind it); run from the repo root in Git Bash:

```bash
wsl.exe -e bash -s <<'EOF'
cd ~/nbcg/docs/shared/plans
python3 - <<'PY'
from pathlib import Path

path = Path("metadata-schema-v2-archive-app.md")
text = path.read_text(encoding="utf-8")
note = """
> **2026-09-29 — per-item parents.** The archive app now keeps parent links per
> item (nbcg-dc `docs/superpowers/specs/2026-09-29-per-item-parents-design.md`).
> Wherever this plan says "the batch's parents", read "the item's parents": the
> rules run with each item's own parents, a new item is created with its own
> `parentIds`, and a re-upload links added parents and unlinks removed ones
> (`POST /api/relations/disconnect`). No backend change."""
if "per-item parents" not in text:
    lines = text.split("\n")
    at = next((i for i, line in enumerate(lines) if line.startswith("## Status")), 0)
    lines.insert(at + 1, note)
    path.write_text("\n".join(lines), encoding="utf-8")
PY
git diff -- metadata-schema-v2-archive-app.md
EOF
```

Expected: the diff adds only the note, right under the `## Status: DONE …` line, with one blank line on each side. Running it again changes nothing.

- [ ] **Step 3: Check nothing still says otherwise**

Run: `grep -rn -i "batch's parents\|batch parent" docs src --include=*.md --include=*.ts | grep -v "docs/superpowers/"`
Expected: one hit only — `docs/PROJECT-KNOWLEDGE.md:445`, a list of module names (`batch`, `parent`). The specs and plans under `docs/superpowers/` quote the old wording on purpose.

---

### Task 11: Check it against the dev backend

Nothing to write; this proves the fix on the case that started it. Needs the backend on `http://localhost:3000` and `npm run tauri dev`.

- [ ] **Step 1: The full native + TS suites**

Run: `npx vitest run`, `npx vue-tsc --noEmit`, `(cd src-tauri && cargo test)`
Expected: all green.

- [ ] **Step 2: CERNAGORA shows its parent**

Open Batch #006 (CERNAGORA, re-work) → Metadata. Expected: the parent card lists **Informacioni sistem u funkciji revizije** · Record · `c5u91tqfdyu5lzc8ltn17zpfp`, and the pill reads **In a collection**. The item's `metadata.json` now contains `"parentIds": ["c5u91tqfdyu5lzc8ltn17zpfp"]`.

- [ ] **Step 3: Unlink, then link it back**

Edit / re-process → Unlink the parent. Expected: the row is struck through, **Unlinks on upload**, with **Undo**. Upload. Expected: the item uploads, the batch archives, and the link is gone:

```bash
wsl.exe -e bash -lc 'curl -s "http://localhost:9200/drafts/_doc/c2q6ty86tpp6p2tc5wf7twhqh?_source_includes=parent_relations"'
```

(`parent_relations` null after the index catches up; or check `item_relations` in Postgres.) Then make a new batch of CERNAGORA, link the parent again and upload, so the dev data ends as it started.

- [ ] **Step 4: Mixed parents**

Batch A (two items) → link P1 → upload; Batch B (two other items) → link P2 → upload. New batch with one item from each: expected each item shows only its own parent. **Link to all** a third parent P3 → upload: expected both gain P3 and keep their own.
