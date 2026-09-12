# NBCG-DC — Outstanding work

> Written 2026-09-10, after a full read of the repo (`.ts`, `.vue`, `.rs`, `.py`,
> docs). Everything here is either **not tracked anywhere else**, or tracked
> somewhere that is now **wrong**.

## What this is not

The project already has three backlogs and this does not duplicate them:

| Where | What it holds | Open items |
|---|---|---|
| [`FRONTEND-TODO.md`](../FRONTEND-TODO.md) | the GUI/logic lane's running list | 30 |
| [`docs/tasks/`](tasks/README.md) | the epic roadmap + spike notes | 29 |
| [`REFACTOR.md`](REFACTOR.md) | the de-slop plan, §A–K, with per-section status | see §1 |

This file covers what a full read turned up that **none** of them record.

---

## 1. Carried over from the refactor

Full reasoning and evidence per item is in [`REFACTOR.md`](REFACTOR.md); this is
the short list so nothing gets lost between documents.

- **§C** — `Card.vue` and `Button.vue` still to extract (details in §3 below).
- **§F** — the metadata module split needs an **owner decision**, not a refactor.
- **§G/§H** — pipeline and upload/sync, blocked on the in-flight diff landing.
- **§K** — `ocr.py` / `web.py` restructuring, blocked on a Python environment.

---

## 2. Tooling that `docs/04` specifies and the repo does not have

`docs/04` §"Making the boundaries mechanical" opens with *"Convention alone
drifts. Enforce the lanes in the repo."* None of what it then prescribes exists:

| Prescribed | Present? |
|---|---|
| `CODEOWNERS` mapping folders to owners | ✗ |
| `eslint-plugin-boundaries` failing the build on a cross-lane import | ✗ |
| `tauri-specta` generating `src/ipc/bindings.ts` | ✗ |
| Path aliases | ✓ (the one that was done) |

There is **no ESLint config, no Prettier config, no `.github/`, no CI at all.**

This matters more than it looks: I verified the three lanes are honoured
**without a single violation** across 127 frontend files — no `.vue` imports a
service, no `domain/` module imports outward, no service imports a store. That is
holding on discipline alone, with nothing to catch the first slip.

**Worth doing, cheapest first:**

- [ ] A CI workflow running what already passes locally: `vue-tsc --noEmit`,
      `vitest run`, `cargo test`, `cargo clippy`. Everything is green today, so
      this locks in a known-good state rather than opening a cleanup job.
- [ ] `eslint-plugin-boundaries` (or `import/no-restricted-paths`) encoding
      seam 1. The rule would pass on day one.
- [ ] `CODEOWNERS` — trivial, and the lane ownership is already documented.

### 2a. `bindings.ts` is hand-written, and `docs/04` says otherwise in four places

`docs/04` states as fact: *"**`tauri-specta` generates `src/ipc/bindings.ts`**, so
the bridge is typed end-to-end and any change on the Rust side surfaces as a
TypeScript compile error."* (lines 73, 160, 203, 234).

`bindings.ts` itself is honest about it: *"Eventually `tauri-specta` **will**
GENERATE typed wrappers … until then these wrappers document the surface both
lanes agree on."* There is no `specta` dependency in `Cargo.toml`.

So seam 2 — the Jernej↔Arch contract — is **two hand-maintained files that must
be kept in agreement by hand**, and a Rust signature change does *not* surface as
a TS compile error the way the doc promises.

- [ ] Either adopt `tauri-specta`, or correct `docs/04` to describe the manual
      contract and say what keeps the two sides honest. Right now a new developer
      would trust a guarantee that does not exist.

### 2b. The path-alias list is maintained in three places

`vite.config.ts`, `vitest.config.ts` and `tsconfig.json` each carry their own
copy of the same eight aliases. `vite.config.ts` has a comment saying *"keep in
sync with tsconfig.json"* — which is the tell.

- [ ] Single-source it (`vite-tsconfig-paths`, or have the vite configs read
      `tsconfig.json`). Low priority: a drift here fails loudly and immediately.

---

## 3. Design-system work, with the evidence

Measured by parsing every rule in every `<style>` block.

### `.card` — 8 definitions, 3 properties agreed

`components/batch/BatchCard.vue`, `components/batch/ParentRecordsCard.vue`,
`components/metadata/FilesStrip.vue`, `views/SettingsView.vue`,
`views/SyncView.vue`, `views/batch/MetadataTab.vue`,
`views/batch/ProcessingTab.vue`, `views/batch/SetupTab.vue`.

All eight agree on `background` / `border` / `border-radius`; three are
byte-identical (`ParentRecordsCard`, `MetadataTab`, `SetupTab`), the rest have
drifted on padding and margin.

- [ ] `Card.vue`, following the `Spinner`/`Pill` pattern already established.

### `.btn-primary` — 4 definitions

`views/OverviewView.vue`, `views/SettingsView.vue`, `views/batch/MetadataTab.vue`,
`views/batch/SetupTab.vue`. All four agree on indigo fill, white text and
weight 600; they differ on `height` (34 vs 42 px) and `border-radius` (8 vs 10 px).

- [ ] `Button.vue` with a size variant. **Note:** unifying the heights is a real
      visual change — it needs the GUI owner's eye, not a script.

### Type scale — 9 of 18 sizes tokenised

`tokens.css` now names the nine sizes that cover ~90 % of use. The stragglers are
`9px`, `9.5px`, `10px`, `14.5px`, `16px`, `20px`, `22px`, `26px`.

- [ ] Decide per case: fold into a token, or promote to a display token. Several
      are almost certainly accidental (`9` vs `9.5`, `14` vs `14.5`).

### Smaller items

- [ ] `flex: 1; min-width: 0` — the truncating-flex-child idiom — appears **10
      times across 6 files** under 10 different class names. One utility class.
- [ ] `ProcessingTab.vue` still carries 3 `.spinner` rules (`.spinner`,
      `.spinner.dark`, `.spinner.small`); left alone because the file is
      in-flight. Migrate to `<Spinner>` once that lands.
- [ ] **The theme setting is inert.** Settings offers light/dark/system and
      persists it (`ThemePreference` → `stores/useSettings`), but nothing reads
      the choice back out: no dark palette in `tokens.css`, and no `data-theme`
      or `prefers-color-scheme` anywhere. The control looks live and does
      nothing. Either finish it (a second `:root` block plus something that
      stamps the preference onto the document — no component changes) or hide
      the control until it works.

---

## 4. Stale entries in the existing docs

Found by checking claims against the code. Each of these would mislead somebody.

- [x] **`FRONTEND-TODO.md` §1 marked live code obsolete** — "remove the
      mojibake/mangled helpers, `doOCR`, `/extract`". `repairMangledText` is live
      in `services/upload.ts` and covered by tests; `doOCR: false` is deliberate
      on every upload (OCR runs locally). Acting on it would have broken the
      upload path. **Corrected in place 2026-09-10.**
- [ ] **`FRONTEND-TODO.md` §1: "14 failing `schema.test.ts` (Node ≥24
      `localStorage` global — test setup needs a stub)".** No longer true —
      `schema.test.ts` is **14/14 green on Node v24.21.0**, and the whole suite is
      763/763. The recommendation to pin Node 22 appears to be obsolete too.
      Someone who knows what changed should strike it.
- [x] **`docs/04` frontend tree listed 12 components that were never written** —
      `ScreenShell`, `ArrivalsTable`, `ItemRow`, `ProvenanceTag`, `SourcePicker`,
      `ThumbnailPicker`, `Button`, `TextField`, `EmptyState`, `Toast`,
      `design/theme.ts`, and a light/dark/system switch. **Replaced with the real
      tree 2026-09-10.**
- [x] **`README.md` test counts** were 618 frontend / 73 native; actual 771 /
      149 (+1 needing a real Python). **Corrected** — and see §2, a CI run would
      keep them honest. They had already drifted twice before this; the number
      belongs in CI output, not in prose.
- [ ] **`docs/04` on `tauri-specta`** — see §2a above. Not yet corrected, because
      the fix depends on which way the team decides to go.

---

## 5. Dropped intentions

Things the code was built *toward* that were never wired up. None of these are
bugs; all of them are decisions somebody made and then lost track of. Recording
them so they are chosen deliberately rather than rediscovered.

- **Settings cannot point at the offending field.** `domain/connection.ts` had an
  `isConfigurationFault()` distinguishing "you typed the URL wrong" (fixable in
  Settings) from "the network is down" (wait). Nothing ever called it, so a
  misconfigured host and an offline backend both surface as a generic
  "Unreachable". I removed the dead function; **the missing affordance is the
  real item.**
  - [ ] Decide whether Settings should call out the bad field. It is a few lines
        plus a place to show it.
- **`reextractFile()` has no caller.** `services/api/files.ts` wraps
  `POST /api/files/:fileId/extract` and it is tested, but nothing in the app
  invokes it. It is not dead by accident: `dto.ts` documents it as the recovery
  path when an upload returns `201` and extraction must be re-triggered. I kept
  it for that reason.
  - [ ] Either wire it into that recovery path, or record that recovery is
        manual. Right now the path is documented but not reachable.
- **The brand string is duplicated.** `APP_NAME` was unused and I deleted it;
  `"NBCG Archive"` is inlined in `AppRail.vue` and `SettingsView.vue`. Under
  seam 1 a `.vue` cannot import `@app/config`, so sharing it needs a composable —
  probably not worth it for two occurrences, but it should be a decision.
- **No barrel convention.** I deleted `domain/index.ts`, `stores/index.ts` and
  `ipc/index.ts` — all three were unreachable (`@domain/*` never resolves a bare
  `@domain`) and unimported. `services/api/index.ts` survives and is genuinely
  used by 2 files.
  - [ ] Pick one: barrels everywhere with aliases that resolve them, or no
        barrels. The current state is one barrel by accident.

---

## 6. Python lane

Blocked, but recorded so it is not lost.

- **The tests cannot run in the current environment.** Nothing from
  `py/requirements.txt` is installed — no `pytest`, Pillow, pypdfium2 or
  paddleocr — and there is no venv in the repo. Every `py/` change is therefore
  unverifiable right now.
  - [ ] Stand up a venv (`py/.venv`) and document it in
        `docs/06-native-core-and-dev-setup.md`. `FRONTEND-TODO.md` already notes
        that doc omits the `pip install` step.
- [ ] `ocr.py main()` is **142 lines** and `web.py main()` is **145 lines** —
      argument parsing, orchestration and reporting run together. The rest of the
      lane is already well factored (`nbcg_pipeline/` is 12 modules of 13–249
      lines), which is what makes these two stand out.
- **Do not "clean" `_OCR_ENGINES` / `_ENGINE_OPTIONS`.** They look like stray
  module-level mutable globals; they are a deliberate lazy engine cache, and
  `requirements.txt` documents at length how an unpinned recogniser once cost a
  large silent regression.

- [ ] **OCR runs with PaddlePaddle's optimised CPU backend switched off, and it
      does not have to.** `enable_mkldnn=False` is there because the *detector*
      crashes under oneDNN; the recogniser, which is ~95% of the runtime, does
      not. Measured 11.1x on a lone map, 2.2-2.6x on a book, and slightly *more*
      accurate. See `docs/OCR-PERFORMANCE.md` for the measurements and the exact
      changes - it also records why PP-OCRv6 and an engine swap were rejected,
      and what an ONNX Runtime move would buy (924 MB -> ~60 MB, and GPU support
      on non-NVIDIA machines).

---

## 7. Deliberately not doing

Recorded so nobody re-opens them expecting a win.

- **Trimming comments.** The comment ratio (30–50 % in places) looks like bloat
  and is not: of 4 583 JSDoc lines, **42** are trivial. The rest documents a
  backend that silently drops unknown metadata keys, bumps `version` on no-op
  writes, and fails a whole batch transition because one id was already
  published. It is the most valuable text in the repo.
- **Un-exporting the ~120 "used only in their own file" symbols.** Nearly all are
  a module's public type vocabulary, or are exported so a domain rule stays
  directly testable. Churn with no benefit.
- **Moving `core/python/mod.rs`'s 558 test lines out of the file.** Inline
  `#[cfg(test)]` is idiomatic Rust and is what lets those tests reach private
  functions.
- **Folding the thin composables** (`useToasts` is `storeToRefs` plus two
  forwarders). The pass-through *is* seam 1, and seam 1 is honoured perfectly.

---

## Suggested order

1. **CI** (§2) — everything is green today; lock it in before anything else moves.
2. **§2a, the `tauri-specta` decision** — it is a correctness guarantee the docs
   claim and the repo does not provide.
3. **`Card.vue` / `Button.vue`** (§3) — the pattern is established, the evidence
   is measured.
4. **§5 dropped intentions** — cheap decisions, each currently invisible.
5. **Python env** (§6) — unblocks a whole lane.
6. **§1 §F/§G/§H** — once the in-flight diff lands.
