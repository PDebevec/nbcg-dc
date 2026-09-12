# NBCG-DC — Refactor & de-slop plan

> Working document. This file is the single source of truth for what has been
> cleaned, what is next, and *why* each call was made.
> Started 2026-09-10. Update **Status** and the **Log** as you go.

## Why this exists

The codebase is architecturally sound — the three lanes of
[04 – Code structure](04-code-structure.md) are real and, verified by import
scan, **not violated once**: no `.vue` imports a service, no `domain/` module
imports outward, no service imports a store. That part needs no work.

What it carries instead is *volume*: ~40k lines in which a large fraction is
narration, duplication, and pass-through. The job is to cut that without
changing behaviour.

## Ground rules

1. **763 frontend tests + 73 native tests are green right now.** They stay green
   after every section. `npx vitest run` before and after; a section is not done
   until it is.
2. **Behaviour does not change.** This is deletion and consolidation, not
   redesign. Any change that alters behaviour gets called out in the Log with a
   reason.
3. **Delete beats rewrite.** The cheapest win is removing code nobody calls.
4. **`vue-tsc --noEmit` stays clean** (`noUnusedLocals`/`noUnusedParameters` are
   on, so dead locals surface at build).
5. **In-flight work is off-limits until it lands.** 15 files are uncommitted
   (the upload/processing work). Sections touching them come last — see
   §Sequencing.

## What counts as slop here

Concrete and measured — not a matter of taste:

| # | Pattern | Evidence |
|---|---|---|
| S1 | **Doc-comment bloat** — 30–50 % of non-test lines are comments; every constant narrated; epic/doc paths inline | 5 190 comment lines / 16 948 non-test TS. `dto.ts` 50 %, `pipeline.ts` 41 %, `batch.ts` 42 %, `naming.ts` 41 % |
| S2 | **Identity & pass-through code** — mappers that copy a struct field-for-field, wrappers that only forward | `toBatchDto()` is a field-for-field identity; `toCreateDto()` is `return fields` |
| S3 | **Dead exports** — exported, referenced nowhere outside their own file | ~60 symbols; worst in `services/api/dto.ts` (the whole COBISS-import DTO group), `domain/sync.ts`, `app/config.ts` |
| S4 | **CSS copy-paste** — every component re-invents the same primitives | 4 114 lines of scoped CSS vs a 226-line design system. `.pill` ×17, `.card` ×10, `.spinner` ×9, `.btn-primary` ×8 |
| S5 | **Missing token scale** — `tokens.css` has ~110 colour tokens but *no spacing or type scale*, so components hardcode and drift | `font-size: 13px` ×47, `12px` ×35, `12.5px` ×31, `11.5px` ×19; `gap: 9px`, `gap: 10px`, `margin-bottom: 14px` |
| S6 | **God files** | `core/jobs/mod.rs` 1 880, `services/upload.ts` 1 167, `OverviewView.vue` 1 033 (634 of them CSS), `ProcessingTab.vue` 972 (654 CSS) |

### What is *not* slop — do not "clean" these

- **Comments that carry a decision or a backend quirk.** `dto.ts` explaining that
  omitting `extractedText` *wipes* the stored text, or that `{"x.pdf": ""}`
  writes NO_TEXT *and* enqueues an overwrite, is hard-won knowledge about someone
  else's API. Keep every one of those. Cut the ones restating the signature.
- **The mojibake / mangled-filename helpers.** `FRONTEND-TODO.md` §1 lists them
  as obsolete. They are not — `repairMangledText` is live in `services/upload.ts`
  and covered by tests. The TODO is stale; fix the TODO, keep the code.
- **`domain/*` functions exported only for their own unit test.** That is the
  deliberate cost of keeping domain rules pure and directly testable. Only the
  *zero*-reference exports go.
- **The `\x00` composite map key in `naming.ts`.** It makes `grep` report the
  file as binary, which looks alarming; it is a normal and correct separator.

## Baseline (2026-09-10, commit `0687dbb`)

```
src/**       .ts non-test  16 948      .test.ts  10 359      .vue   6 602
             scoped CSS inside .vue     4 114
src-tauri/   .rs                       10 353
py/          .py                       ~4 200
tests         763 frontend (36 files) · 73 native — all green
```

---

## Sections

Ordered by dependency, not by size. Each is independently shippable and leaves
the suite green.

### A — Repo hygiene & config

**Files:** `.gitignore`, `.env`, `vite.config.ts`, `vitest.config.ts`,
`tsconfig.json`, `FRONTEND-TODO.md`, `docs/`

**Findings**
- `.env` is untracked **and not ignored** — one `git add -A` commits it.
- `FRONTEND-TODO.md` §1 marks live code obsolete (mojibake helpers, `doOCR`,
  `/extract`); acting on it would break the upload path.
- `@ui` alias exists but every `.vue` uses relative `../components/…`.
- `docs/04` describes `design/theme.ts` and a dark theme. No such file, and no
  dark palette — though a light/dark/system switch does exist in Settings,
  wired to nothing.

**Actions** — [x] ignore `.env` · [x] correct the stale TODO entries · [x] switch
`.vue` imports to `@ui` · [x] reconcile docs with what is actually built.

**Done**
- `.gitignore`: `.env` / `.env.*` ignored (`!.env.example` kept as the escape
  hatch). The file itself is left on disk — it is a scratch note (`9847056`, a
  bare value with no `KEY=`, read by nothing), not app config, and it is not
  mine to delete.
- All 17 component imports across 9 `.vue` files now use `@ui/…`; zero relative
  `../components/` paths remain.
- `FRONTEND-TODO.md` §1: struck the "remove obsolete" item and recorded why it is
  wrong — acting on it would have deleted `repairMangledText` and the
  `doOCR: false` upload flag, both live.
- `docs/04`: frontend tree replaced with the real one + an "As built" note naming
  the 12 components the draft invented.
- `README.md`: test count 618 → 763; `REFACTOR.md` linked from the doc table.

**Status:** ✅ done

---

### B — Dead-export sweep (frontend-wide)

**Files:** all of `src/**/*.ts`

**Findings** ~60 exports with zero references outside their own file. Largest
cluster is `services/api/dto.ts`: `CobissImportDto`, `CobissImportResult`,
`ImportJobProgress`, `ImportJobStatus`, `CobissAuthor`, `CobissCorporateBody`,
`CobissPublication`, `CobissTextualMaterialCodes`, `SuggestField`, `SuggestItem`,
`MatchedFile`, `IndexedFileAttachment`, `IndexedParentRelation`,
`IndexedItemSource`, `UpdateItemResult`, `RecordSchemaResponse`,
`UPLOAD_MAX_FILE_BYTES`, `SearchSort` — an import feature that was never built.
Then `domain/sync.ts` (`tally`, `SYNC_STAGES`, `MatchedRecord`,
`SUSPICIOUS_MISS_RATIO`, `SUSPICIOUS_MIN_SAMPLE`), `domain/pipeline.ts`
(`sourceTiffs`, `DERIVED_STAGES`), `app/config.ts` (`APP_NAME`,
`CONNECTION_POLL_INTERVAL_MS`), `services/upload.ts` (`splitEmptyTexts`).

**Actions** — [x] delete the truly unreferenced · [x] judge the over-exported ·
[x] re-run the scan to confirm zero regressions.

**Rule:** a DTO type documenting a *live* endpoint's response stays even if
unused today — it is the contract. A DTO for an endpoint this app never calls goes.

**Done**

The naive scan's ~60 "unused" exports were mostly false. Re-ran it counting
same-file use and doing transitive elimination (a cluster that only references
itself falls out whole). Real total: **11 dead symbols + 3 dead files.**

- Deleted `src/domain/index.ts`, `src/stores/index.ts`, `src/ipc/index.ts` —
  three barrels nothing imported. They were also *unreachable*: the aliases are
  `@domain/*` → `src/domain/*`, so a bare `@domain` never resolved. Only
  `@services/api` (2 importers) is a live barrel and it stays.
- `app/config.ts`: `APP_NAME` (the brand string is inlined in `AppRail.vue` and
  `SettingsView.vue`, which cannot import `@app` under the seam rules anyway) and
  `CONNECTION_POLL_INTERVAL_MS`, which claimed "footer polls at this cadence" and
  said 60 s — the footer actually polls at `useConnection`'s own 30 s. A constant
  documenting behaviour it does not control.
- `domain/naming.ts`: `METADATA_MIRROR_FILENAME` — a second source of truth for a
  filename Rust owns (`core::fs::METADATA_FILENAME`) and only Rust reads or writes.
- `ipc/bindings.ts`: `API_TOKEN_SECRET_KEY`, left from the pre-Keycloak auth
  (commit `94a43a3`). Its comment argued it was kept "so any leftover stored
  value is inert" — an unused TS constant does nothing of the sort.
- `domain/connection.ts`: `isConfigurationFault`. **Dropped intention:** it
  existed so Settings could point at the offending field instead of a generic
  "Unreachable". Nothing ever called it. Removed rather than left as a decoy —
  if that affordance is wanted, it is four lines and a deliberate decision.
- `lib/logger.ts`: `setLogLevel` — no caller, and not reachable from a console
  either (never attached to `window`).
- `services/api/dto.ts`: the async COBISS-import group (`CobissImportDto`,
  `CobissImportResult`, `ImportJobProgress`, `ImportJobStatus`) — a feature never
  built, as its own comment concedes ("the archive prefers preview + POST
  /api/items"). Plus the `RecordSchemaResponse = RecordSchema` alias. **Its
  40-line doc comment — live-verified schema/ETag behaviour — was kept** and
  re-homed onto the schema section header.
- `domain/pipeline.ts`: `DERIVED_STAGES` was a second name for `RUNNABLE_STAGES`,
  read once through a cast. Folded into `dirtiesUpload`, keeping the rule it
  documented.
- Un-exported three internal helpers with no vocabulary role (`sourceTiffs`,
  `tally`, `allFieldsEmpty`).

**Deliberately not done:** the other ~120 "used only in its own file" exports.
Nearly all are a module's public type vocabulary (`RequestOptions`, `Commands`,
the `naming.ts` suffix/extension constants that `py/` mirrors by contract).
Un-exporting them is churn with no benefit — types cost nothing at runtime — and
would fight the deliberate "exported so the rule is directly testable" pattern.

**Result:** -98 lines, dead exports 11 → **0** on re-scan.

**Status:** ✅ done

---

### C — Design system & CSS consolidation

**Files:** `src/design/tokens.css`, `global.css`, every `.vue` `<style>` block

**Findings** — *corrected after measuring.* My first estimate treated all 4 114
CSS lines as recoverable. They are not. Parsing every rule and grouping identical
bodies: only ~378 lines are exact cross-file duplicates. The real problem is
**drift**, which is worse than duplication because it is invisible:

| Selector | Definitions | How they differ |
|---|---|---|
| `.spinner` | 7 | same 7 properties; size 11/13/14 px, 3 unrelated track colours, 0.7 s vs 0.8 s |
| `.card` | 6 | 3 byte-identical, 3 drifted |
| `.btn-primary` | 4 | all indigo/white/600; height 34 vs 42 px, radius 8 vs 10 px |
| `.pill` | 3 | same 8 properties; 11 / 11.5 / 12 px |

Plus 18 distinct `font-size` px values, and 23 raw `#fff` / `rgba(255,255,255,…)`
literals bypassing the palette entirely.

**Actions** — [x] type + weight + on-primary tokens · [x] extract `Spinner` ·
[x] extract `Pill` · [x] drop the dark-theme claim · [ ] `Card` + `Button` ·
[ ] `.u-flex-text` utility.

**Done**
- **`tokens.css`**: added `--fs-tiny` / `--fs-small` / `--fw-semibold`, *named
  from the sizes already in use* — renaming is safe, resizing is not. Only the
  three a shared component actually consumes: a fuller scale was drafted and
  cut, because nine tokens serving two call sites is a scale nobody adopted.
  Added `--c-on-primary` / `--c-on-primary-track` for the raw whites. The
  header's dark-theme promise is corrected rather than dropped: the *switch*
  exists in Settings and is persisted, but nothing applies it — see
  `OUTSTANDING.md`.
- **`components/common/Spinner.vue`** — replaces 7 hand-rolled rules across 7
  files with `size` / `weight` / `tone` props. Every call site keeps its size.
- **`components/common/Pill.vue`** — replaces 3 `.pill` implementations and their
  6 tone rules each. `StatePill.vue` is now a 20-line `ItemState → tone` map over
  it, down from 55.
- **A latent bug fixed on the way.** `BatchCard` and `BatchWorkView` both picked
  the pill colour by `switch`-ing on the *label copy* (`case "Ready to upload"`),
  which is `BATCH_STAGE_LABELS` output — so editing a label string would have
  silently changed a pill's colour, with nothing to catch it. Replaced by
  `BATCH_STAGE_TONES` in `domain/batch.ts`, keyed on the stage, surfaced as
  `tone` on `BatchCardView` / `BatchHeaderView`. The duplicated `pillClass`
  computed is gone from both files.

**Two deliberate visual changes** (both unifying accidental drift onto a token —
called out because ground rule 2 says behaviour does not change):
1. `StagePips`' spinner ran at 0.8 s where all six others run at 0.7 s; and
   `BatchCard` / `BatchWorkView` used a bespoke `rgba(47,111,237,.35)` track
   where `--c-spinner-track` already existed. Both unified.
2. Pill type was 11 / 11.5 / 12 px in three files; now `--fs-small` (11.5 px),
   with a `dense` variant (11 px) kept for the workspace header so its row does
   not reflow.

**Result:** scoped CSS 4 114 → 4 005, `.vue` total 6 602 → 6 536 — while *adding*
133 lines of reusable component, so ~200 lines of duplication removed. Build and
all 763 tests green.

**Remaining** (deliberately left — they are the GUI owner's call on convention,
and the evidence is above): a `Card.vue` for the 6 `.card` variants, a `Button.vue`
for the 4 `.btn-primary` variants — both were in the original `docs/04` plan — and
a `.u-flex-text` utility for the `flex: 1; min-width: 0` idiom repeated 10 times
in 6 files. `ProcessingTab.vue` keeps its 3 spinner rules until its in-flight
diff lands (§G).

**Status:** ◧ primitives done, `Card`/`Button` deferred

---

### D — Backend API layer

**Files:** `src/services/api/*` (11 modules + `dto.ts` 746 lines, 50 % comments),
`services/backend.ts`

**Findings — my premise was wrong, and I am recording that rather than acting on
it.** I opened this section to "cut `dto.ts` narration". Reading it, almost none
of it is narration. It is a live-verified record of a third-party API behaving
badly, and it is the most valuable thing in the file:

- `PATCH` metadata is *shallow*-merged and unknown keys are silently dropped, so
  a typo'd field key looks like a successful no-change;
- `version` is a **write counter, not a change counter** — re-sending an
  identical value still bumps it;
- `POST /items/transition` is **not idempotent**: one already-published id fails
  the transition of every other id in the same call;
- omitting `extractedText` on a replace *wipes* the stored text.

None of that is inferable from the types. Deleting it to hit a comment-ratio
target would be the actual vandalism. It stays, verbatim.

I measured the whole frontend instead of trusting the ratio: of **4 583 JSDoc
lines, 42 are trivial one-liners** that restate their declaration — and most of
even those earn their place (`/** 1-based page number. */` settles a real
off-by-one question). There is no comment-bloat problem to fix here.

**Done** — the dead DTO group went with §B (−35 lines). Nothing else was cut.

**Status:** ✅ done — closed as "not slop"

---

### E — Domain core

**Files:** `domain/{item,batch,enums,files,schema,config,connection,overview,naming,parent,provenance}.ts`

**Findings** Same correction as §D. The 40 % figure is real but it is not slop;
the domain rules are subtle (cycle detection in the parent graph, exactly one
data-passing parent, mojibake-vs-lossy filename damage) and the comments explain
*why*, not *what*.

The one thing worth checking was **rot**, since these comments cite doc paths and
epic numbers that drift. So I resolved all 30 distinct `docs/...` references
found in `.ts`, `.vue`, `.rs` and `.py` comments against the tree:

- **29 of 30 resolve**, including the shorthand form (`docs/01` →
  `docs/01-concept-and-ux.md`).
- **1 was broken**: `domain/pipeline.ts` cited `docs/10 §Naming`, which does not
  exist — fixed to `docs/tasks/10`.

141 inline `Epic NN` mentions were left alone: the epic numbering in
`docs/tasks/` is stable and they are how the roadmap and the code cross-reference
each other.

**Done** — one broken doc reference fixed. The `DERIVED_STAGES` fold and the
`BATCH_STAGE_TONES` fix (§C) were the real domain-layer wins.

**Status:** ✅ done — closed as "not slop", one rot fix

---

### F — Metadata & forms slice

**Files:** `domain/{metadata,metadata-form,metadata-wire}.ts`,
`composables/useMetadataForm.ts` (703), `stores/useMetadata.ts`,
`views/batch/MetadataTab.vue` (816 — 492 CSS), `components/metadata/*`

**Findings** Three domain modules for one concept. `useMetadataForm` is the one
genuinely under-commented file (8 %) and the longest composable.
`FRONTEND-TODO.md` itself asks where `domain/metadata-wire` belongs.

**Actions** — [ ] decide the metadata module split · [ ] CSS to §C · [ ] add the
few comments `useMetadataForm` needs.

**Not started — deferred with §G and §H.** `MetadataTab.vue` was touched only to
adopt `Spinner` and `@ui`. The module-split question (`metadata` vs
`metadata-form` vs `metadata-wire`) is a design decision, not a cleanup, and
`FRONTEND-TODO.md` §1 has it queued as an open question for its owner — it should
be answered by them, not settled by a de-slop pass.

**Status:** ⏸ deferred — needs an owner decision, not a refactor

---

### G — Pipeline & processing slice

**Files:** `domain/pipeline.ts` (575), `domain/steps.ts` (300, **untracked**),
`services/pipeline.ts`, `stores/useProcessing.ts`, `composables/useProcessing.ts`,
`views/batch/ProcessingTab.vue` (972 — 654 CSS)

**Findings** ~1 700 lines across five layers for one feature. `domain/steps.ts`
is new and overlaps `domain/pipeline.ts` — both model stage progression.

**Actions** — [ ] settle `steps.ts` vs `pipeline.ts` (they should not both own
stage state) · [ ] collapse the pass-throughs · [ ] CSS to §C.

**⚠ Blocked:** `useProcessing.{ts,test.ts}` and `ProcessingTab.vue` are
uncommitted in-flight work. Do not touch until it lands.

**Status:** blocked

---

### H — Upload & sync slices

**Files:** `domain/upload.ts`, `services/upload.ts` (1 167), `domain/sync.ts`,
`services/sync.ts`, `services/indexing.ts`, `stores/useSync.ts`,
`composables/useSyncScreen.ts`, `views/SyncView.vue`

**Findings** `services/upload.ts` is the largest TS file and the most
comment-heavy that *earns* it — the backend quirks documented there are real.
`domain/sync.ts` carries the dead-export cluster from §B.

**Actions** — [ ] split `services/upload.ts` along its natural seams (gate →
assets → relations → write-through) · [ ] dead exports with §B · [ ] keep the
backend-quirk comments verbatim.

**⚠ Blocked:** `services/upload.ts`, `domain/upload.ts` and their tests are
uncommitted. Last.

**Status:** blocked

---

### I — State plumbing (stores + composables)

**Files:** `src/stores/*` (16), `src/composables/*` (12), `services/batches.ts`

**Findings** The S2 cluster. `services/batches.ts` holds a field-for-field
identity mapper (`toBatchDto`) and `toCreateDto = (fields) => fields`. Several
composables are a `storeToRefs` re-export plus a toast wrapper.

**Actions** — [x] delete identity mappers · [x] judge the thin composables ·
[x] **keep** the composable seam itself.

**Done**
- `services/batches.ts`: removed `toBatchDto`, a field-for-field copy of all 14
  fields, and `toCreateDto`, which was `return fields`. `Batch` and `BatchDto`
  are structurally identical, so the compiler already catches a divergence at
  the call site — the mappers just restated the shape a third time. Their doc
  comment claimed to exist "so a future DTO/domain divergence is caught here",
  which TypeScript does for free. `toBatch` **stays** and is now module-private:
  it does real work (defaults every member item's `proc` entry to `idle`).
  −32 lines.

**Deliberately not done: folding the thin composables.** `composables/useToasts`
is the clearest case — it is `storeToRefs` plus two one-line forwarders, and by
any local measure it earns nothing. But `ToastHost.vue` is a `.vue` file, and
seam 1 forbids presentation importing a store. The pass-through *is* the
architecture, and that architecture is honoured without a single violation in
127 files. Collapsing it to save 20 lines would trade a working boundary for a
rounding error.

**Status:** ✅ done

---

### J — Rust native core

**Files:** `src-tauri/src/core/jobs/mod.rs` (1 880), `core/python/mod.rs` (825),
`dto.rs` (785), `core/db/items.rs` (600), `core/fs/mod.rs` (511)

**Findings** `jobs/mod.rs` is one file with ~35 free functions and six
near-parallel `run_*` shape handlers (`run_supplied_pdf`, `run_pdf_thumbnail_ocr`,
`run_images_only`, `run_multiple_pdfs`, `run_unsupported`,
`run_supplied_pdf_stage`) — the clearest split in the repo. `core/python/mod.rs`
is 558 lines of tests sitting on 267 lines of implementation.

**Actions** — [x] split `jobs/mod.rs` · [x] move the limits tests beside their code ·
[x] `cargo test` green.

**Done**

`core/jobs/mod.rs` 1 880 lines → five modules, cut along the section dividers the
file already had:

| Module | Lines | Owns |
|---|---|---|
| `lock.rs` | 78 | the single-run lock |
| `limits.rs` | 248 | the counting semaphore + where the caps come from |
| `stages.rs` | 649 | per-stage execution (`web`, `ocr`) + progress bookkeeping |
| `shapes.rs` | 465 | the six `InputShape` handlers |
| `mod.rs` | 505 | module doc, `JobEvent`, the batch runner |

- `settle_web_stages` moved from the shapes group into `stages.rs`: it settles
  stage statuses after a web run, was called from both, and leaving it in
  `shapes` would have made the two modules mutually dependent.
- The three `Semaphore`/`JobLimits` tests moved into `limits.rs` beside the code
  they exercise; the three `reupload_kind_for` tests stayed with the runner.
- Cross-module items are `pub(super)`; only `JobLimits`, `JobRunLock`,
  `JobRunGuard`, `try_acquire` and `request_cancel` are re-exported, which is
  exactly what `commands/jobs.rs` consumes. `cargo fix` cleared the replayed
  imports; the crate builds with **0 warnings, 0 errors**.
- Verified no tests were lost: 6 `#[test]` in the original file, 6 after
  (3 + 3). Full suite **150 native tests, 149 passing + 1 ignored** — unchanged.
  One timing-sensitive semaphore test flaked once mid-refactor and passes
  consistently since; it is inherently a race test, not a regression.

Total went 1 880 → 1 945 lines, +65 for module headers and per-module imports —
the right trade for five navigable files.

**Deliberately not done:** moving `core/python/mod.rs`'s 558 test lines out. My
plan called it lopsided against 267 lines of implementation, but inline
`#[cfg(test)]` is idiomatic Rust and is what lets those tests reach private
functions. Moving them would fight the language for a ratio.

**Also fixed:** `README.md` said 73 native tests. The real number is 150 — the
count had not been touched in a long time.

**Status:** ✅ done

---

### K — Python pipeline

**Files:** `py/ocr.py` (875), `py/web.py` (544), `py/split_spreads.py` (445),
`py/pdf_derive.py` (267), `py/nbcg_pipeline/*` (12 modules),
`py/tools/bench_ocr.py`

**Findings** Recently reworked (commit `0687dbb`) and in the best shape of the
three lanes — `nbcg_pipeline/` is already factored into small focused modules.
`ocr.py` is the one file still doing engine config, worker pooling, page
resolution and CLI in one place.

**Actions** — [x] static audit · [x] remove the one dead function ·
[–] `pytest` — **cannot run here** (see below).

**⚠ The Python tests could not be run.** Nothing from `py/requirements.txt` is
installed in this environment — no `pytest`, no Pillow, no pypdfium2, no
paddleocr, and no venv in the repo. Ground rule 1 says a section is not done
until the suite is green, so I did **not** restructure Python. Installing the
pipeline's dependencies (paddlepaddle alone is hundreds of MB) is not a call to
make unasked on someone's machine.

What I did instead is a static audit using `ast`, which needs no dependencies.

**Done**
- Audited every `py/` module for functions and classes with zero references
  anywhere, tests included. **Exactly one**: `_raw_lines_to_recognized` in
  `ocr.py`. Confirmed there is no dynamic lookup in the file (`getattr`,
  `globals()`, `eval`) that could reach it, then removed it. All modules still
  `py_compile` cleanly, and a re-run of the audit reports **0 dead**.

**Findings, for whoever has the environment**

This lane is the healthiest of the three — `nbcg_pipeline/` is already twelve
small focused modules (13–249 lines). The one real shape problem is the CLI
entry points:

| | lines | longest function |
|---|---|---|
| `ocr.py` | 875 | `main()` at **142 lines** |
| `web.py` | 545 | `main()` at **145 lines** |
| `split_spreads.py` | 446 | `process_folder()` at 71 |
| `tools/bench_ocr.py` | 328 | `main()` at 83 |

Two 140-line `main()`s are where argument parsing, orchestration and reporting
have run together. That is the split worth making — with the tests running.

`ocr.py` also carries four module-level mutable globals (`_OCR_ENGINES`,
`_ENGINE_OPTIONS`, `REC_MODELS`, `PADDLE_LANGS`). The first two are a lazily
built engine cache, which is deliberate and load-bearing for performance — see
the pinning rationale in `requirements.txt`, where an unpinned recogniser
silently cost a large regression. Leave them alone.

**Status:** ◧ audited + 1 deletion; restructuring blocked on a working env

---

## Sequencing

```
A ─ hygiene; unblocks nothing but is cheap and removes a real .env risk
│
B ─ dead-export sweep      ← do early: shrinks D, E, H before they are read
│
├── C ─ CSS               (GUI lane, zero logic risk, biggest line win)
├── D ─ API layer         (depends on B)
├── E ─ domain core       (depends on B)
├── I ─ state plumbing
│
├── J ─ Rust              (independent lane, any time)
├── K ─ Python            (independent lane, lowest priority)
│
└── then, once the working tree is committed:
    F ─ metadata   ·   G ─ pipeline   ·   H ─ upload & sync
```

**A → B first.** B is what makes D, E and H smaller before anyone reads them;
the other order means trimming comments off code that is about to be deleted.

**F, G, H last** because 15 files are uncommitted right now. Refactoring under an
unlanded diff means resolving conflicts against work whose intent is not in git yet.

---

## Where it landed

| | before | after | |
|---|---|---|---|
| `src/**` non-test `.ts` | 16 948 | 16 911 | net of the `BATCH_STAGE_TONES` map added |
| `.vue` | 6 602 | 6 560 | while *adding* 133 lines of shared component |
| scoped CSS inside `.vue` | 4 114 | 3 982 | |
| `src-tauri/**` `.rs` | 10 353 | 10 452 | +99: module headers and per-file imports, buying five navigable files in place of one 1 880-line one |
| dead frontend exports | 11 | **0** | |
| dead `py/` functions | 1 | **0** | |
| `.vue` files re-declaring a spinner | 7 | **1** | |
| `.vue` files re-declaring a pill | 3 | **1** | |
| broken `docs/` references | 1 | **0** | |
| frontend tests | 763 | **763** | all green |
| native tests | 150 | **150** | 149 pass + 1 ignored, all green |

`vue-tsc --noEmit` clean, `vite build` clean, `cargo check --tests` at **0
warnings, 0 errors**.

## What this exercise actually found

Worth saying plainly, because two of my four opening assumptions were wrong.

**Right:** there was real dead code (11 exports, 3 unreachable barrels, 1 Python
function), real duplication (a spinner written 7 times, a pill 3 times), and one
genuine god file (`jobs/mod.rs`).

**Wrong — the comment-density hypothesis.** "30–50 % of lines are comments"
looked damning and is not. Measured across 4 583 JSDoc lines, **42** are trivial.
The rest document a third-party API that silently drops unknown keys, bumps a
version counter on no-op writes, and fails a whole batch transition because one
id was already published. That is the most valuable text in the repo. Sections D
and E were opened to cut it and closed without cutting a line.

**Wrong — the CSS volume.** 4 114 lines of scoped CSS is not 4 114 lines of
duplication; only ~378 lines were exact cross-file copies. The real defect was
*drift* — `.spinner` in seven files agreeing on all seven properties and
disagreeing on three of the values.

**The most valuable single change was not a deletion.** `BatchCard` and
`BatchWorkView` both chose a pill colour by `switch`-ing on the label *copy*
(`case "Ready to upload"`), so renaming a label would have silently changed a
colour with no test to catch it. Keying the tone off the stage removed the
duplication *and* the trap.

**A codebase can be over-documented and still be well-engineered.** The lanes in
`docs/04` are honoured without a single violation across 127 frontend files —
that is rarer than clean comment ratios, and it is why the refactors above were
safe to make at all.

---

## Log

| Date | Section | What changed | Tests |
|---|---|---|---|
| 2026-09-10 | — | Survey: measured the slop, verified the lanes are un-violated, wrote this plan. Baseline 763 + 73 green. | ✅ |
| 2026-09-10 | A | Hygiene: `.env` ignored, `@ui` alias adopted in all 9 `.vue` files, stale "remove obsolete" TODO corrected, `docs/04` tree reconciled, README counts fixed. | ✅ 763 |
| 2026-09-10 | B | Dead code: 3 unreachable barrels + 11 dead symbols removed; `DERIVED_STAGES` folded into its one caller. Dead exports 11 → 0. −98 lines. | ✅ 763 |
| 2026-09-10 | C | Design system: type/weight/on-primary tokens; `Spinner` (7→1) and `Pill` (3→1) extracted; pill colour re-keyed off the label copy onto the stage, fixing a latent bug. −200 lines of duplication. | ✅ 763 |
| 2026-09-10 | D+E | Closed as **not slop** after measuring: 42 of 4 583 JSDoc lines are trivial. Fixed the 1 broken doc reference of 30. | ✅ 763 |
| 2026-09-10 | I | `services/batches.ts`: deleted the field-for-field `toBatchDto` identity and `toCreateDto = fields`. −32 lines. | ✅ 763 |
| 2026-09-10 | J | `core/jobs/mod.rs` 1 880 → 5 modules (78/248/465/505/649). 0 warnings. README native count 73 → 150. | ✅ 150 native |
| 2026-09-10 | K | Static audit of `py/` (no deps installed → no pytest). 1 dead function removed, now 0. Restructuring deferred. | ◧ py_compile |
