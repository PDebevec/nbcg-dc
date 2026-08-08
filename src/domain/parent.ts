/**
 * The **Parent record** domain model + data-passing rules (Epic 05).
 *
 * A parent is a catalogue record an item is filed under. There is **no backend
 * collections endpoint** — parents are found via search (`services/api/collections`),
 * and each hit's `collectionType` (a NUMBER inside the record metadata) decides
 * whether it may pass its shared fields down to children (docs/tasks/05, and the
 * verified contract in docs/PROJECT-KNOWLEDGE.md §4).
 *
 * Two ideas live here:
 *  - **Eligibility** — a parent is *eligible to pass data* only when its
 *    `collectionType` is in the configured data-passing set
 *    (`AppConfig.dataPassingCollectionTypes`, TBD/configurable). Ineligible
 *    parents can still be linked; they just never copy fields down.
 *  - **"Exactly one passes data"** — among the eligible linked parents at most one
 *    actually passes data at a time; toggling the source is a single operation.
 *
 * The actual field-copying + provenance lives in `domain/provenance.ts`; this
 * module owns the parent vocabulary and the link/eligibility invariants. The
 * persisted per-parent state is the minimal `{ id, passesData }` ref the batch
 * stores (`BatchParentRef` in `domain/batch.ts`); the richer {@link LinkedParent}
 * here is the resolved runtime view (eligibility recomputed from config).
 *
 * Framework-free — imports only sibling domain types.
 */

import type { ItemLevel } from "./item";
import type { RecordMetadata } from "./metadata";

/**
 * A catalogue parent record an item can be filed under. Assembled from a search
 * hit by `services/api/collections`. `metadata` may be a partial projection (the
 * indexed doc), which is enough to copy shared fields down and read
 * `collectionType`.
 */
export interface ParentRecord {
  /** Backend `Draft`/`Record` id (immutable). */
  id: string;
  /** Display name — the record's `metadata.title` (falls back to the id). */
  title: string;
  /** `collectionType` from the record metadata (a number), or `null` when the
   * indexed doc carried none. Drives {@link isEligibleParent}. */
  collectionType: number | null;
  /** The record level, when known (parents are typically `main` serials). */
  level?: ItemLevel;
  /** The parent's metadata blob — the source of inheritable field values. */
  metadata: RecordMetadata;
}

/**
 * The minimal persisted link ref (structurally the batch's `BatchParentRef`).
 * Kept as a local shape so `domain/parent` does not depend on `domain/batch`.
 */
export interface ParentRef {
  id: string;
  passesData: boolean;
}

/**
 * A parent linked to an item/batch, resolved against the current config: whether
 * it *may* pass data (`eligible`) and whether it *currently* does (`passesData`,
 * ≤1 true across the set). The GUI binds this; it is derived, not persisted.
 */
export interface LinkedParent {
  parentId: string;
  /** The resolved record (present once fetched; the link can outlive a fetch). */
  record: ParentRecord | null;
  /** `collectionType` is in the data-passing set. */
  eligible: boolean;
  /** This parent currently passes its shared fields down (mutually exclusive). */
  passesData: boolean;
}

/**
 * Whether a `collectionType` makes a parent eligible to pass data. `null`/absent
 * types are never eligible.
 */
export function isDataPassingType(
  collectionType: number | null | undefined,
  dataPassingTypes: readonly number[],
): boolean {
  return collectionType != null && dataPassingTypes.includes(collectionType);
}

/** Whether a parent record is eligible to pass its shared fields down. */
export function isEligibleParent(
  parent: ParentRecord,
  dataPassingTypes: readonly number[],
): boolean {
  return isDataPassingType(parent.collectionType, dataPassingTypes);
}

/**
 * Resolve persisted link refs + fetched records into the runtime
 * {@link LinkedParent} view. Eligibility is recomputed from `dataPassingTypes`
 * (config can change); an ineligible parent is forced to `passesData: false`
 * regardless of a stale persisted flag; and the "≤1 passes data" invariant is
 * enforced (the first eligible ref flagged wins, the rest are cleared).
 */
export function resolveLinkedParents(
  refs: readonly ParentRef[],
  records: ReadonlyMap<string, ParentRecord>,
  dataPassingTypes: readonly number[],
): LinkedParent[] {
  let passingClaimed = false;
  return refs.map((ref) => {
    const record = records.get(ref.id) ?? null;
    const eligible = record
      ? isEligibleParent(record, dataPassingTypes)
      : false;
    const passesData = eligible && ref.passesData && !passingClaimed;
    if (passesData) passingClaimed = true;
    return { parentId: ref.id, record, eligible, passesData };
  });
}

/** Project the runtime links back to the persisted `{ id, passesData }` refs. */
export function toParentRefs(links: readonly LinkedParent[]): ParentRef[] {
  return links.map((l) => ({ id: l.parentId, passesData: l.passesData }));
}

/**
 * Set which linked parent passes data — mutually exclusive. Passing `null`
 * clears it on all. An id that is not eligible (or not linked) clears the flag
 * everywhere: ineligible parents can never pass data.
 */
export function setDataPassingParent(
  links: readonly LinkedParent[],
  parentId: string | null,
): LinkedParent[] {
  return links.map((l) => ({
    ...l,
    passesData: l.eligible && l.parentId === parentId,
  }));
}

/**
 * Toggle a parent's "passes data" flag: if it is already passing, clear it (no
 * one passes); otherwise make it the sole passer (only when eligible). Mirrors
 * the "can pass data ↔ passes data" toggle in the Setup + Metadata tabs.
 */
export function toggleDataPassing(
  links: readonly LinkedParent[],
  parentId: string,
): LinkedParent[] {
  const current = links.find((l) => l.parentId === parentId);
  if (current?.passesData) return setDataPassingParent(links, null);
  return setDataPassingParent(links, parentId);
}

/** The id of the linked parent currently passing data, or `null`. */
export function dataPassingParentId(links: readonly LinkedParent[]): string | null {
  return links.find((l) => l.passesData)?.parentId ?? null;
}

/** The linked parent currently passing data (with its record), or `null`. */
export function dataPassingParent(
  links: readonly LinkedParent[],
): LinkedParent | null {
  return links.find((l) => l.passesData) ?? null;
}

/** The eligible-but-not-yet-chosen parents (candidates for "passes data"). */
export function eligibleParents(
  links: readonly LinkedParent[],
): LinkedParent[] {
  return links.filter((l) => l.eligible);
}

/**
 * Pick a sensible default data-passing parent when none is chosen yet: if
 * exactly one linked parent is eligible, it passes data; otherwise leave the
 * choice to the operator (returns the input unchanged). Used on link / on Setup
 * so the common single-serial case needs zero clicks.
 */
export function withDefaultPassing(
  links: readonly LinkedParent[],
): LinkedParent[] {
  if (dataPassingParentId(links) !== null) return [...links];
  const eligible = eligibleParents(links);
  if (eligible.length === 1) return setDataPassingParent(links, eligible[0].parentId);
  return [...links];
}

/**
 * Cycle-safe ancestor walk over the (possibly cyclic) parent graph. The
 * relation graph may contain cycles by design (docs/tasks/05), so any local
 * traversal must guard against revisits or it can loop forever.
 *
 * `getParentIds` returns the direct parents of an id; traversal stops on
 * revisits. Returns the set of reachable ancestor ids (a start id appears only
 * if it is reachable from itself through a cycle).
 */
export function collectAncestors(
  startIds: readonly string[],
  getParentIds: (id: string) => readonly string[],
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...startIds];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) break;
    for (const parent of getParentIds(id)) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      stack.push(parent);
    }
  }
  return seen;
}

/**
 * Whether linking `childId` under `parentId` would create a cycle — i.e. the
 * proposed parent is already a descendant of (reachable from) the child. The
 * backend rejects cycles on connect; this lets the archive pre-empt the error.
 * `getParentIds` walks the existing edges (parents-of an id).
 */
export function wouldCreateCycle(
  childId: string,
  parentId: string,
  getParentIds: (id: string) => readonly string[],
): boolean {
  if (childId === parentId) return true;
  // A cycle forms iff the child is already an ancestor of the proposed parent.
  return collectAncestors([parentId], getParentIds).has(childId);
}
