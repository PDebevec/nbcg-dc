/**
 * The backend's item-id derivation, ported.
 *
 * `POST /api/items` sets an explicit id — and can therefore collide with a
 * `409` — only when the metadata carries a `cobissId`
 * (`backend/src/modules/items/items.service.ts:94-106`). That id is a pure
 * function of the COBISS id
 * (`backend/src/shared/util/generateUuidFromCobissId.ts`):
 *
 * ```ts
 * const hash = createHash('sha256').update(`cobiss:${cobissId}`).digest('hex');
 * const base36 = BigInt('0x' + hash).toString(36);
 * return ('c' + base36).substring(0, 25);
 * ```
 *
 * Computing it here rather than asking the backend is what keeps collision
 * recovery working when COBISS itself is down: the alternative,
 * `previewCobiss`, blocks on a 30-second upstream fetch to `ws.cobiss.net`.
 *
 * This duplicates a backend invariant, which is a real coupling risk, so no
 * caller may trust the result blindly. `upload.resolveExistingRecord` reads
 * the record back and adopts it only when its `metadata.cobissId` matches the
 * item's `catalogueId`, so a drift in the backend's algorithm degrades to
 * "not resolved" instead of "adopted the wrong record".
 *
 * Async because `crypto.subtle.digest` is — which is also why this lives in
 * `services/`, not the sync, dependency-free `domain/` lane.
 */
export async function deterministicItemId(cobissId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`cobiss:${cobissId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const base36 = BigInt("0x" + hex).toString(36);
  return ("c" + base36).substring(0, 25);
}
