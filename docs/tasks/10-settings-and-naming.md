# Epic 10 — Settings & naming

> Depends on: 01, 09 · Blocks: 11 (first-run Test connection)

Goal: the **Settings** screen — Configure (folders, backend connection, theme,
schema, version) and Data (the read-only naming convention). Config plumbing
lives in [Epic 01](01-app-shell.md); this epic is the screen + the naming rules.

## Tasks

### Configure tab

- [x] **Folder locations**: `/unprocessed` and `/processed` roots, each with a
      **Browse…** picker (Tauri dialog) and a **validity** status (Valid / Not
      set / invalid path).
      — **`.ts` ✅** `RootValidity` + `RootStatus` + `describeRootValidity` /
      `isRootUsable` in `domain/config`; `services/config.probeRoot` / `probeRoots`
      (via `ipc.fs.pathExists`) and `pickDirectory`; `useSettings.roots` +
      `browseForRoot(key)` (picks into the **draft**, not the saved config).
      **`.vue` ◻** the two rows + Browse buttons + status pills.
      **`.rs` ◻** `fs_path_exists`, `fs_pick_directory`.
- [x] **Backend connection**: **API base URL** (default `https://api.nbcg.me`)
      and **API access token** — stored as a secret, **masked by default** with
      **Show/Hide** and **Paste**.
      — **`.ts` ✅** `normalizeBaseUrl` / `validateBaseUrl` / `normalizeApiPrefix` /
      `validateApiPrefix` / `validateConfig` / `normalizeConfig`, and
      `normalizeApiToken` / `looksLikeJwt` / `maskToken` / `summarizeToken` in
      `domain/config`; the draft/save buffer in `stores/useSettings`.
      **`.vue` ◻** the fields, the Show/Hide toggle, Paste, and the error/warning
      text (bind `validation.errors` / `.warnings` and `tokenDisplay.masked` —
      never the raw token).
- [x] **Test connection**: a reachability ping (`GET /api/health`) — show
      Reachable / Unreachable for the configured base URL. **No identity/verify**
      and no email/access-level: the app is single-workstation, single-user (no
      login), and the static token is authenticated by the backend on the first
      real write (`401`/`403`). (Add identity display only if multi-user login is
      ever introduced.)
      — **`.ts` ✅** `checkConnection` now classifies the outcome
      (`ReachabilityReason`) and `useSettings.testConnection()` probes the
      **draft** via a throwaway client. Still reachability-only — no token probe.
      **`.vue` ◻** the button + result line.
- [x] **Theme**: Light / Dark / **System**.
      — **`.ts` ✅** persisted `ThemePreference` + `useSettings.setTheme` (applies
      immediately, and mirrors into a dirty draft). **`.vue`/`.css` ◻** the
      control, the `prefers-color-scheme` listener, and applying the resolved
      theme to the document — presentation owns the DOM.
- [x] **Refresh metadata schema**: re-fetch `GET /api/schema/record` and update
      the cache (see [metadata & schema](04-metadata-editor-and-schema.md)).
      — **`.ts` ✅** `refreshRecordSchema()` (both levels, ETag revalidation) +
      `recordSchemaCacheInfo()`; `useSettings.refreshSchema()`.
      **`.vue` ◻** the button + per-level "41 fields, updated <time>" display.
- [x] **App version** display; **Save settings** persists config.
      — **`.ts` ✅** `services/config.getAppVersion()` (Tauri bundle version,
      falling back to the `APP_VERSION` constant) and the explicit
      `save()` / `revert()` / `dirty` / `canSave` form contract.
      **`.vue` ◻** the version line and the Save/Revert buttons.
      **`.rs` ◻** grant `core:app:allow-version` in the capability, or the version
      silently falls back to the compiled-in constant.

### Data tab — naming (read-only reference)

- [x] Show the **folder-derived naming convention** read-only (nothing editable):
      the item's **folder name is the base name** for the derived outputs (**for
      now**), so a folder `njegos_gorski_vijenac` yields `njegos_gorski_vijenac.pdf`,
      `njegos_gorski_vijenac_archive.pdf`, `njegos_gorski_vijenac_thumb.png`,
      `njegos_gorski_vijenac.txt`, `njegos_gorski_vijenac.json`.
      — **`.ts` ✅** `domain/naming.ts` — `derivedOutputNames` +
      `DERIVED_OUTPUT_ORDER` and the per-output builders. **`.vue` ◻** render it.
- [x] Note the **multi-asset exception**: when a folder holds **several PDFs or
      images**, those discovered files keep their **own filenames** (that's how a
      PDF's full text is matched to it — `foo.pdf` ↔ `foo.txt`); only the
      single-item derived outputs use the folder name.
      — **`.ts` ✅** `ocrTextNameFor` / `isOcrTextFor`, and
      `NamingPreview.multiAsset` for the worked example.
- [x] Show the **multi-page numbering** rule: items with several pages append a
      running, **unpadded** page number after an underscore (`…_1.pdf`,
      `…_2.pdf`, … `…_10.pdf`).
      — **`.ts` ✅** `pageName` / `pageNames` / `pageNumberOf` (padded names are
      deliberately *not* page numbers, and `pageName` throws rather than pad).
- [x] A **live preview** built from a sample folder name, matching the reference
      convention.
      — **`.ts` ✅** `buildNamingPreview(folderName)` → `NamingPreview`
      (`derived` + `pages` + `multiAsset`), blank input falling back to
      `SAMPLE_FOLDER_NAME`. **`.vue` ◻** the input + the three preview blocks.

> This drops the prototype's prefix / base-identifier picker
> (COBISS/Signature/Accession/Title) and its `NBCG_` prefix. Naming is derived
> from the scanner's folder name, on the assumption folder names are
> correct/unique at scan time. There is no backend naming step. See
> [decisions](../03-open-questions.md) and the shared implementation in
> [processing](06-processing-pipeline-and-jobs.md).

## Progress — logic lane (`.ts`) pass, 2026-08-07

Verified against the running backend on `http://localhost:3000` (health, schema,
ETag/`304`, and the failure modes below). Typechecks (`vue-tsc`) clean; suite
green (total in [PROJECT-KNOWLEDGE §5](../PROJECT-KNOWLEDGE.md)).

### Three backend facts this epic turned up

All three were found by probing the live backend, and each changed the code:

1. **`GET /api/health` is `200 {"status":"ok","timestamp":…}` but `GET /health`
   is `404`.** So a wrong `apiPrefix` — or an `/api` accidentally left on the base
   URL, which produces `/api/api/health` — still *reaches a live host*. The old
   `checkReachable` returned `true` for any non-transport error, so Test
   connection reported **Reachable** for a misconfiguration it exists to catch,
   sending the operator after a phantom network fault. Reachability now
   classifies the outcome (`ReachabilityReason`) and `validateBaseUrl` rejects a
   trailing `/api` outright.
2. **A `200` with a non-JSON body was misreported as "unreachable".** Decoding
   the health response as JSON throws a `SyntaxError`, which is not an `ApiError`,
   so a proxy landing page or SPA `index.html` fallback fell through to the
   transport branch. The probe now fetches the body as **text** and parses it
   itself, so "answered, but not the nbcg API" is classified correctly.
3. **`GET /api/schema/record?level=bogus` returned `200 { fields: [] }`, not a
   `400`.** An empty field list was therefore cacheable — and would persist for
   24h *including the offline copy*, rendering the metadata editor as a form with
   no fields. The cache refuses to let an empty schema replace a non-empty one.
   **Reported and fixed backend-side 2026-08-07** (`?level` is now validated →
   `400`); the client-side guard stays, because a `200` with no fields is still
   reachable from a transient fault.

### What was built (logic lane `.ts`)

- **`domain/naming.ts` (new)** — the whole Data tab, and the **single source of
  truth** for the convention. It was previously implicit in three places: the
  `_archive` / `_thumb` string literals in `domain/files.ts` and the
  `${folderName}.pdf` literal in `domain/pipeline.ts`. Both now build on this
  module, so the read-only reference screen and the pipeline cannot drift apart.
  `extensionOf` / `baseNameOf` moved here from `domain/files.ts` (they are naming
  primitives, and keeping them in `files` would have made the import circular).
- **`domain/config.ts`** — grew the validation/masking vocabulary:
  `RootValidity` (with a fourth `unknown` state — see below) / `RootStatus`,
  base-URL and prefix normalisation + validation, and token handling.
  `normalizeApiToken` unwraps the **whole Keycloak JSON envelope**, because the
  `curl` in [the overview](../00-project-overview.md) prints
  `{"access_token":"…","expires_in":300,…}` and pasting that verbatim is at least
  as likely as pasting the bare token; it also strips quotes and a `Bearer `
  prefix. `validateConfig` splits **errors** (block Save — only a malformed URL
  qualifies) from **warnings** (an odd-looking token is shown, not blocked, since
  the app never verifies the token itself).
- **`domain/connection.ts`** — `ReachabilityReason` (`ok` / `not-nbcg-api` /
  `server-error` / `unreachable`), `status` on `ReachabilityResult`, and
  `isConfigurationFault()` so Settings can point at the field rather than showing
  a generic "Unreachable". `ConnectionState` is unchanged, so the footer contract
  the GUI was given still holds.
- **`services/api/health.ts`** — the classifying probe (see facts 1 & 2).
  `checkReachable` is now true **only** for the nbcg API; `checkConnection` takes
  an options object and names the tested host in its message.
- **`services/api/schema.ts`** — `refreshRecordSchema()` + `recordSchemaCacheInfo()`.
  It force-**revalidates** rather than clearing first, so a failed refresh leaves
  the previous schema intact instead of leaving the app with no field definitions.
  It also reports `stale` separately from `ok`: a read degrades to cache when
  offline (by design, for the editor), which would otherwise make a refresh that
  did nothing report success. That distinction is carried by a new internal
  `SchemaFetchOutcome` — the first attempt compared `fetchedAt` timestamps and
  broke on a `304` served inside the same millisecond.
- **`services/backend.ts`** — `createApiClient()`, a throwaway client that does
  **not** touch the singleton, so Test connection can probe unsaved values
  without repointing the whole app at an unverified host (and leaving it there
  when the test fails).
- **`services/config.ts`** — `probeRoot` / `probeRoots`, `pickDirectory`,
  `getAppVersion()`, and `saveConfig` now returns the **canonical** config it
  persisted, so what is stored, displayed, and requested are one string.
- **`stores/useSettings.ts`** — reworked into the Settings form's thin target: a
  **draft** buffer alongside the saved config, with `dirty` / `canSave` /
  `validation` / `save()` / `revert()`, plus `roots`, `testConnection()`,
  `refreshSchema()`, and `appVersion`. `update()` / `setTheme()` / `updateToken()`
  remain as immediate writes for single-setting changes. **First store with unit
  tests** (25) — the ordering guarantees are the substance of this epic.

### A deliberate deviation: `RootValidity.unknown`

The spec lists three states (Valid / Not set / invalid path). There is a fourth
in the code, because outside Tauri (a plain `vite` session, or before Arch
implements `fs_path_exists`) there is **no filesystem to ask**. The two available
answers were both wrong: claiming Valid is a lie the operator could act on, and
`invalid` flags every correctly-configured root as broken. `unknown` is the honest
answer, and `isRootUsable()` treats it as usable so a dev run is not blocked.

### Owed by GUI (`.vue` / `.css`)

The whole **Settings screen**, both tabs. Configure: the two folder rows (path +
Browse… + status pill), the base-URL field with its inline error, the token field
**masked by default** with Show/Hide + Paste, Test connection (button, spinner,
result line), the theme control, Refresh metadata schema (button + per-level
cache line), the app-version line, and **Save / Revert** wired to `canSave` /
`dirty` — including an unsaved-changes prompt when navigating away. Data: the
read-only convention, the multi-asset and multi-page notes, and the live preview
input. Two rules for this screen specifically:

- **Never bind the raw token.** Use `tokenDisplay.masked`; reveal only on an
  explicit Show, from the draft value.
- **Do not restate the naming convention in markup.** Render `buildNamingPreview()`
  — a hand-written copy in the template is exactly the drift this epic removed.

Presentation also owns **applying** the theme (the `prefers-color-scheme`
listener and the `data-theme` attribute); the store only persists the preference.

### Owed by Arch (`.rs`) — no new commands

Every command this epic needs is already declared in `src/ipc/bindings.ts`:
`config_load` / `config_save` / `config_get_secret` / `config_set_secret` /
`config_delete_secret`, `fs_path_exists`, `fs_pick_directory`. Two notes:

- **`core:app:allow-version`** must be granted in the capability, or
  `getAppVersion()` silently falls back to the compiled-in `APP_VERSION` constant
  — which drifts from the installed bundle and makes a version line untrustworthy
  for support.
- The **token must live in the OS secret store**. `services/config` falls back to
  `localStorage` when the IPC commands are missing, which is plain-text and
  DEV-ONLY; shipping without `config_*_secret` would put the Keycloak token in
  webview storage on a library workstation.

### Backend (`nbcg`) — nothing required

No endpoint changes. One note for the backend team, not an ask:
`GET /api/schema/record?level=<anything>` returns `200 { fields: [] }` for an
unrecognised level rather than a `400`. The archive guards against it, but
validating `level` (or defaulting to the unfiltered set) would turn a silent
empty form into an obvious error for any future client.

### Still owed by the logic lane (`.ts`) — deferred with the frontend

- `composables/useSettings.ts` — the Seam-1 view-model the screen binds (same
  deferral as Epics 04/06/07/08; `stores/useSettings` is designed as its thin
  target).
- `composables/useNaming.ts` — trivial wrapper over `buildNamingPreview` for the
  Data tab; fold into `useSettings` if it stays this thin.
- **Theme resolution** (`prefers-color-scheme` → effective theme) is left to
  presentation on purpose: it is DOM work, and `design/theme.ts` sits in the GUI
  lane per [code structure](../04-code-structure.md).

### Doc-vs-code review, 2026-08-08 — `save()` could half-apply

`save()` persisted the config, committed it to `config.value`, and *then* wrote
the token. If the token write failed (a locked keyring, a missing
`config_set_secret`), the store was left in a state it has no name for:
`config.value` — what `useConnection.host` and `useSync.host` display — named the
**new** backend, while `applyClient()` had never run so every actual request
still went to the **old** one, and `save()` returned `false` as though nothing had
happened.

The existing failure test only covered `saveConfig` throwing, which is the branch
that was already correct.

**Fixed** by staging: both writes complete before *either* is committed to
reactive state, so the app either moved to the new backend or did not. A partial
write can still reach disk (config persisted, token not); the next `load()`
reconciles that, and the operator sees an unsaved-looking form rather than a
silently half-applied one. Test confirmed to fail against the old ordering.

This is the epic's own stated substance — "the draft-vs-saved **ordering
guarantees**" — so it is worth being precise about what the guarantee is: *the
running client never disagrees with `config`.*

### Not yet built (noted)

- **No token probe.** Test connection stays reachability-only, per this epic's
  spec. `GET /api/items/stats` is the one scoped GET that would reveal a bad
  token at Settings time instead of at the first upload — worth revisiting if
  operators hit `401`s during upload, but it needs
  `records:view:hidden` + `drafts:view:hidden`, so a `403` there would have to be
  reported as "token valid, scopes narrow" rather than a failure.
- **No folder-name validation.** The convention assumes folder names are correct
  and unique at scan time; nothing warns about spaces, diacritics, or collisions.
  Deliberate for now (docs/03), but it is where the naming assumption will break
  first.
- **`apiPrefix` has no UI in the spec.** It is validated and saved, and the
  Configure tab only exposes the base URL. If a reverse proxy ever rewrites the
  prefix, the field needs surfacing.

## Acceptance

- Configure persists roots (with validity), backend URL, and the masked token;
  Test connection reports backend reachability (Reachable / Unreachable).
- Refresh schema updates the cached field defs; theme switches Light/Dark/System.
- The Data tab shows the folder-derived naming + multi-page rule read-only, with
  a correct live preview, and nothing there is editable.
