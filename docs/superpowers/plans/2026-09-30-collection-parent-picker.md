# Collections-only Parent Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The parent picker asks the backend for collections only, and lists the newest collections as soon as its empty search box gets focus.

**Architecture:**
- **The search call** (`services/api/collections.searchParents`):
  - it always sends `collectionType=>0`;
  - it adds `sort=newest` when nothing is typed;
  - it drops any hit that isn't a collection, for a backend that ignores the filter.
- **The picker:** focusing the empty search box runs that search with no text. Clearing the text, or `×`, closes the list at once. Nothing else changes: `fields` stays `metadata`, and linking works as before.

**Tech Stack:** TypeScript, Vue 3 (`<script setup>`), Pinia, vitest (`vue/server-renderer` for the card's render test).

**Spec:** the backend contract row `GET /api/search…` in `~/nbcg/docs/shared/archive-app.md` (WSL), plus the backend note "Search change: impact on the archive app" (pasted 2026-09-30). Their binding parts are copied below.

## Global Constraints

**The search call**
- The picker call becomes `GET <apiUrl>/api/search?q=<typed text>&type=all&limit=20&collectionType=>0&fields=metadata`. With nothing typed it sends no `q` and adds `sort=newest`. The HTTP client encodes `>` as `%3E`; tests read params back with `new URL(...).searchParams`, never by substring.
- `>0` is every collection, including types added later. The app does not read codes from the schema.
- The backend silently drops a param it doesn't know. Against a backend without the filter (production until it is deployed), the query runs unfiltered, so the app also drops every hit whose `collectionType` is not a number above 0.
- **`fields` stays `metadata`.** The metadata store caches each hit as the parent's record (`findParents` → `rememberParent`). Data passing, the per-field source picker and the upload check read that record's fields.

**The picker**
- Focusing the search box with nothing typed lists the newest collections. It does nothing while text is typed, a list shows or a search runs.
- Clearing the typed text closes the list at once, not after the 350 ms debounce, because `×` sends an empty query too. Linking closes it, as today.
- No UI copy changes.

**Process**
- Lanes: Task 2 touches `.vue` (the GUI lane); the rest is `.ts` (Jernej's).
- Commands (repo root): `npx vitest run [file]`, `npx vue-tsc --noEmit`. Suite before this plan: 1083 passed.
- One commit per task on the feature branch. Each message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Task |
|---|---|
| `src/services/api/dto.ts` | 1 `SearchQuery.collectionType` |
| `src/services/api/collections.ts` | 1 `collectionType=>0`, `sort=newest` with nothing typed, drop non-collections |
| `docs/PROJECT-KNOWLEDGE.md` | 1 the search params and the picker call |
| `src/composables/useParentLinks.ts` | 2 `openPicker`, `search(listNewest)`, an empty query clears at once |
| `src/components/batch/ParentRecordsCard.vue` | 2 `open` on focus; the list shows with nothing typed |
| `src/composables/useMetadataForm.ts`, `src/composables/useBatchSetup.ts` | 2 `openParentPicker` |
| `src/views/batch/MetadataTab.vue`, `src/views/batch/SetupTab.vue` | 2 `@open` |
| Tests | `src/services/api/collections.test.ts` (1), `src/composables/useParentLinks.test.ts` (2), `src/components/batch/ParentRecordsCard.test.ts` (2) |

---

### Task 1: Ask for collections only, newest first when nothing is typed

**Files:**
- Modify: `src/services/api/dto.ts` (`SearchQuery`, ~line 390)
- Modify: `src/services/api/collections.ts:64-94`
- Modify: `docs/PROJECT-KNOWLEDGE.md:181-195`
- Test: `src/services/api/collections.test.ts`

**Interfaces:**
- Produces: `SearchQuery.collectionType?: string`. `searchParents(query, options): Promise<ParentRecord[]>` keeps its signature. It now returns collections only, and `searchParents("")` lists the newest ones.

- [ ] **Step 1: Write the failing tests**

In `src/services/api/collections.test.ts`, inside `describe("searchParents", …)`, after the existing two tests, add:

```ts
  it("asks for collections only, ranking a typed query by relevance", async () => {
    const { client, calls } = harness(() => json(RESULT));
    await searchParents("dan", { client });
    const params = new URL(calls[0].url).searchParams;
    expect(params.get("q")).toBe("dan");
    expect(params.get("collectionType")).toBe(">0");
    expect(params.has("sort")).toBe(false);
  });

  it("lists the newest collections when nothing is typed", async () => {
    const { client, calls } = harness(() => json(RESULT));
    await searchParents("", { client });
    const params = new URL(calls[0].url).searchParams;
    expect(params.has("q")).toBe(false);
    expect(params.get("sort")).toBe("newest");
    expect(params.get("collectionType")).toBe(">0");
  });

  it("drops hits that aren't collections, which a backend without the filter returns", async () => {
    const { client } = harness(() =>
      json({
        ...RESULT,
        total: 3,
        hits: [
          hit({ id: "plain", source: { metadata: { title: "An item", collectionType: 0 } } }),
          hit({ id: "untyped", source: { metadata: { title: "No type" } } }),
          hit({ id: "fond", source: { metadata: { title: "A fond", collectionType: 3 } } }),
        ],
      }),
    );
    expect((await searchParents("x", { client })).map((p) => p.id)).toEqual(["fond"]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/services/api/collections.test.ts`
Expected: 3 failed.
- The first fails because `collectionType` is `null`.
- The second fails because there is no `sort`.
- The third gets all three ids.

- [ ] **Step 3: Implement**

`src/services/api/dto.ts`: in `SearchQuery`, after `cobissId?: string;` add:

```ts
  /** Collection types: comma-separated codes (`1,3`) or one comparison (`>0`,
   * `>=1`, `<5`, `<=4`), never both. `>0` = every collection, `0` = everything
   * that isn't one. A backend without the filter drops it silently; a bad value
   * is a `400`. */
  collectionType?: string;
```

`src/services/api/collections.ts`:

(a) Replace `parentSearchQuery` and its comment (lines 64-78) with:

```ts
/** Every collection type, including ones added later. */
const COLLECTIONS_ONLY = ">0";

/** Build the `/api/search` query for the parent picker: collections only, and
 * with nothing typed, the newest first (an empty `q` is dropped and lists all). */
function parentSearchQuery(
  query: string,
  options: SearchParentsOptions,
): SearchQuery {
  return {
    q: query,
    type: options.type ?? "all",
    limit: options.limit ?? 20,
    page: options.page,
    collectionType: COLLECTIONS_ONLY,
    sort: query.trim() === "" ? "newest" : undefined,
    // Keep the payload small but ensure `metadata` (→ collectionType/title) is
    // included; `id` is always added server-side.
    fields: "metadata",
  };
}
```

(b) Replace `searchParents` and its doc comment (lines 80-94) with:

```ts
/**
 * Search backend records/drafts for collections to offer as parents; with
 * nothing typed, the newest ones. Returns domain {@link ParentRecord}s; the
 * caller applies eligibility with the configured data-passing set.
 * CDC-lagged (search lags writes).
 */
export async function searchParents(
  query: string,
  options: SearchParentsOptions = {},
): Promise<ParentRecord[]> {
  const result = await searchItems(parentSearchQuery(query, options), {
    client: options.client,
    signal: options.signal,
  });
  // A backend without the `collectionType` filter drops it silently and
  // returns every item, so keep only collections here too.
  return result.hits
    .map(hitToParent)
    .filter((p) => p.collectionType != null && p.collectionType > 0);
}
```

`docs/PROJECT-KNOWLEDGE.md`:

(a) Replace the `GET /api/search` bullet (lines 181-185) with:

```md
- `GET /api/search` — query params `q, type(all|records|drafts), page, limit(≤100),
  title, author, fullText, publisher, language, materialType, yearFrom, yearTo,
  isbn, issn, cobissId, collectionType, fields, sort(relevance|newest)` →
  `{ total, page, limit, pages, hits[] }`. `hits[]` = `{ id, index, score, source,
  matchedFiles?, highlights? }` (`source` = indexed doc; `extractedText` always
  excluded). `collectionType` (dev since 2026-09-29; also on `/:id/children`)
  takes comma-separated codes (`1,3`) or one comparison (`>0`, `>=1`, `<5`,
  `<=4`), never both; a bad value is a `400`. **A param the backend doesn't know
  is dropped without an error**, so against an older backend the filter is
  silently not applied.
```

(b) Replace the last bullet (lines 193-195, `- Deep pagination past ~10k … hit's source.metadata.collectionType.`) with:

```md
- Deep pagination past ~10k (`from+size ≥ 10000`) → `400`.
- No collections endpoint — the **parent picker uses search** with
  `collectionType=>0` (every collection, including types added later); with
  nothing typed it sends no `q` and `sort=newest`. `collectionType` comes from a
  hit's `source.metadata.collectionType`, and the app drops hits whose type isn't
  above 0, for a backend without the filter.
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run src/services/api/collections.test.ts`
Expected: PASS.

Run: `npx vitest run`
Expected: 1086 passed, 0 failed.

Run: `npx vue-tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add src/services/api/dto.ts src/services/api/collections.ts src/services/api/collections.test.ts docs/PROJECT-KNOWLEDGE.md
git commit -m "Ask search for collections only, newest first when nothing is typed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: List the newest collections when the empty search box gets focus

**Files:**
- Modify: `src/composables/useParentLinks.ts` (`search`, `setQuery`, a new `openPicker`, the return)
- Modify: `src/components/batch/ParentRecordsCard.vue`
- Modify: `src/composables/useMetadataForm.ts`, `src/composables/useBatchSetup.ts` (return, `// parents`)
- Modify: `src/views/batch/MetadataTab.vue`, `src/views/batch/SetupTab.vue`
- Test: `src/composables/useParentLinks.test.ts`, `src/components/batch/ParentRecordsCard.test.ts`

**Interfaces:**
- Consumes: `metadata.findParents("")` → `searchParents("")`, the newest collections (Task 1).
- Produces:
  - `useParentLinks().openPicker(): Promise<void>`;
  - the card emits `open`;
  - `openParentPicker` on both `useMetadataForm` and `useBatchSetup`.

- [ ] **Step 1: Write the failing tests**

`src/composables/useParentLinks.test.ts`:

(a) In `metadataFake`, replace `findParents: async () => [] as ParentRecord[],` with:

```ts
  findParents: async (_q: string, _signal?: AbortSignal) => [] as ParentRecord[],
```

(b) In `beforeEach`, add:

```ts
  metadataFake.findParents = async () => [];
```

(c) Append at the end of the file:

```ts
describe("the picker's list", () => {
  it("lists the newest collections when opened with nothing typed, once", async () => {
    const asked: string[] = [];
    metadataFake.findParents = async (q: string) => {
      asked.push(q);
      return [record("c1", 3)];
    };
    const { links } = setup({ targets: ["i1"] });
    await links.openPicker();
    await links.openPicker(); // already listed: no second request
    expect(asked).toEqual([""]);
    expect(links.results.value.map((r) => r.id)).toEqual(["c1"]);
  });

  it("closes the list at once when the typed text is cleared, as × does", async () => {
    metadataFake.findParents = async () => [record("c1", 3)];
    const { links } = setup({ targets: ["i1"] });
    await links.openPicker();
    links.setQuery("");
    expect(links.results.value).toEqual([]);
  });
});
```

`src/components/batch/ParentRecordsCard.test.ts`: inside `describe("ParentRecordsCard", …)` add:

```ts
  it("shows the listed collections while nothing is typed", async () => {
    const results: ParentSearchRow[] = [
      { id: "c1", title: "Zbirka A", meta: "Record", linked: false, linkedAll: false },
    ];
    const html = await render({ query: "", results });
    expect(html).toContain("Zbirka A");
    expect(html).not.toContain("No matches");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/composables/useParentLinks.test.ts src/components/batch/ParentRecordsCard.test.ts`
Expected: 3 failed.
- Both composable tests fail because `links.openPicker` is not a function.
- The card test fails because nothing shows with an empty query.

- [ ] **Step 3: Implement the composable**

`src/composables/useParentLinks.ts`:

(a) Replace the first lines of `search` (the signature through the empty-query `return`):

```ts
  async function search(): Promise<void> {
    const q = parentQuery.value.trim();
    abort?.abort();
    if (!q) {
      searchResults.value = [];
      searchError.value = null;
      return;
    }
```

with:

```ts
  /** Search the typed text. With nothing typed, clear the list, or with
   * `listNewest`, list the newest collections instead. */
  async function search(listNewest = false): Promise<void> {
    const q = parentQuery.value.trim();
    abort?.abort();
    if (!q && !listNewest) {
      searchResults.value = [];
      searchError.value = null;
      return;
    }
```

(b) Replace `setQuery` with:

```ts
  function setQuery(value: string): void {
    parentQuery.value = value;
    if (debounce) clearTimeout(debounce);
    debounce = null;
    // Clearing the text closes the list at once (× sends an empty query too).
    if (value.trim() === "") {
      void search();
      return;
    }
    debounce = setTimeout(() => {
      debounce = null;
      void search();
    }, SEARCH_DEBOUNCE_MS);
  }

  /** The search box got focus: with nothing typed, list the newest collections.
   * Nothing to do while text is typed, a list shows or a search runs. */
  function openPicker(): Promise<void> {
    if (parentQuery.value.trim() !== "" || searchResults.value.length > 0 || searching.value) {
      return Promise.resolve();
    }
    return search(true);
  }
```

(c) In the returned object, under `// search`, add `openPicker,` after `search,`.

- [ ] **Step 4: Implement the card, the form composables and the views**

`src/components/batch/ParentRecordsCard.vue`:

(a) In `defineEmits`, after `updateQuery: [value: string];` add:

```ts
  /** The search box got focus: list the newest collections if nothing is typed. */
  open: [];
```

(b) Replace the `showResults` and `noMatches` computeds with:

```ts
/** Typed text searches; with nothing typed, the newest collections show once listed. */
const showResults = computed(
  () => trimmedQuery.value.length > 0 || props.results.length > 0 || props.searchError != null,
);
const noMatches = computed(
  () =>
    trimmedQuery.value.length > 0 &&
    !props.searching &&
    !props.searchError &&
    props.results.length === 0,
);
```

(c) On the search `<input>`, after `@input="onInput"` add:

```vue
            @focus="emit('open')"
```

(d) On the clear button, `v-else-if="query"` becomes `v-else-if="query || showResults"`, so `×` also closes a list shown with nothing typed.

`src/composables/useMetadataForm.ts` and `src/composables/useBatchSetup.ts`: in the returned object's `// parents` block, after `setParentQuery: links.setQuery,` add:

```ts
    openParentPicker: links.openPicker,
```

`src/views/batch/MetadataTab.vue` and `src/views/batch/SetupTab.vue`:
- Add `openParentPicker,` to the destructured names after `setParentQuery,`.
- On `<ParentRecordsCard`, after `@update-query="setParentQuery($event)"` add `@open="openParentPicker()"`, matching that attribute's indentation.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run src/composables/useParentLinks.test.ts src/components/batch/ParentRecordsCard.test.ts`
Expected: PASS.

Run: `npx vitest run`
Expected: 1089 passed, 0 failed.

Run: `npx vue-tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add src/composables/useParentLinks.ts src/composables/useParentLinks.test.ts src/components/batch/ParentRecordsCard.vue src/components/batch/ParentRecordsCard.test.ts src/composables/useMetadataForm.ts src/composables/useBatchSetup.ts src/views/batch/MetadataTab.vue src/views/batch/SetupTab.vue
git commit -m "List the newest collections when the parent search box gets focus" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Manual check (the user, against dev)

1. Dev has one collection, "Informacioni sistem u funkciji revizije" (type 1). Give one or two more items a collection type of 3 or 4.
2. On a batch's Metadata tab, click into the parent search without typing. The collections are listed, newest first.
3. Type part of a non-collection's title. It isn't offered.
4. `×` closes the list. Linking a collection closes it too, and the link works as before (including passes data). Do steps 2–4 once on the Setup tab too.
5. Optional, in DevTools → Network: the request carries `collectionType=%3E0`, plus `sort=newest` and no `q` when nothing is typed.

Until production has the filter, the app drops non-collections itself. With nothing typed, the list there may be short or empty, because the newest 20 items are mostly not collections.
