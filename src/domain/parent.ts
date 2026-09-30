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
  /** The parent's metadata blob — the source of inheritable field values. */
  metadata: RecordMetadata;
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
 * The one message for parents that are not on the backend. `gone`: the
 * backend said so on a write (`PARENT_NOT_FOUND`). Otherwise search could not
 * find it — which can also be the search index lagging behind a new record.
 */
export function missingParentMessage(names: readonly string[], gone: boolean): string {
  const one = names.length === 1;
  const subject = `${one ? "The parent" : "The parents"} ${names.map((n) => `'${n}'`).join(", ")}`;
  const it = one ? "it" : "them";
  if (gone) {
    return `${subject} no longer ${one ? "exists" : "exist"}. Change or remove ${it} in this batch, then upload again.`;
  }
  return `${subject} can't be found on the backend. Change or remove ${it} in this batch — if ${one ? "it was" : "they were"} only just created, try again in a minute.`;
}

/** The names of an item's parents that are not on the backend, by how the app knows. */
export interface MissingParentNames {
  /** The backend refused them on a write (`PARENT_NOT_FOUND`) — authoritative. */
  gone: string[];
  /** Search answered 404 — possibly only the index lagging. */
  notFound: string[];
}

/** {@link missingParentMessage} for both kinds, each in its own wording; '' when none is missing. */
export function missingParentNote(names: MissingParentNames): string {
  const parts: string[] = [];
  if (names.gone.length > 0) parts.push(missingParentMessage(names.gone, true));
  if (names.notFound.length > 0) parts.push(missingParentMessage(names.notFound, false));
  return parts.join(" ");
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
