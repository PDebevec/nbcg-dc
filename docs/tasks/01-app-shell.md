# Epic 01 — App shell & navigation

> Depends on: — · Blocks: everything
> **Logic lane (Jernej, `.ts`): DONE — 2026-08-03.** GUI (`.vue`/`.css`) and
> Arch (`.rs`/`.py`) portions still open; backend needs one new endpoint (below).

Goal: a clean Tauri + Vue skeleton with the **four-destination rail**, the
screen router, and the plumbing every later epic needs. Matches the
[v1.4.0 design](../../desktop-app-interface-design/project) shell.

## Tasks

Each task is annotated by lane. `[x]` = the logic lane's part is done; the
bracketed tags mark what each lane still owes.

- [x] Strip the default template — **[logic ✓]** `main.ts` rewritten (Pinia +
      router + boot). **[GUI]** remove the `greet` demo from
      [App.vue](../../src/App.vue), add `<router-view/>`, replace logos.
      **[Arch]** remove `greet` from [lib.rs](../../src-tauri/src/lib.rs);
      replace README.
- [x] Frontend toolchain — **[logic ✓]** TypeScript path aliases
      (`@domain @services @ipc @stores @composables @ui @lib @app` in
      `tsconfig.json` + `vite.config.ts`), **Pinia**, and a **vue-router**
      screen router. **[GUI]** design tokens/components (IBM Plex, indigo
      palette).
- [x] **Left rail navigation** — **[logic ✓]** route destinations +
      `RAIL_DESTINATIONS` nav model + `meta.rail` for active state
      (`app/router.ts`). **[GUI]** `AppRail.vue` binding it; the Batches
      **badge** = count of unfinished batches (needs `useBatches`, Epic 03).
- [x] **Connection footer** — **[logic ✓]** backend **reachability** only
      (`stores/useConnection`, `services/api/health` → `GET /api/health`); no
      token/identity check (single-user, static token — see decisions).
      **[GUI]** `ConnectionFooter.vue` binding `useConnection` (`state`, `host`,
      `lastResult.message`).
- [x] **Screen shell** — **[logic ✓]** router swaps Overview / Batches /
      Batch-work / Sync / Settings; batch-work keeps the rail's **Batches**
      item active (`meta.rail: "batches"`). **[GUI]** `ScreenShell.vue` +
      `<router-view/>` layout.
- [x] **First-run empty state** — **[logic ✓]** `isConfigured()` +
      `useSettings.configured` drive it. **[GUI]** the welcome card with a CTA
      to Settings.
- [x] **Tauri command + event conventions** — **[logic ✓]** the typed bridge
      contract (`ipc/bindings.ts` commands registry + `ipc/events.ts`).
      **[Arch]** implement the commands in Rust + wire `tauri-specta` to
      regenerate `ipc/bindings.ts` (see Handoff).
- [x] **App configuration (persisted)** — **[logic ✓]** `AppConfig`
      (`domain/config`), `services/config` (secure-store adapter + dev
      localStorage fallback), `useSettings`. Roots, base URL, **static Keycloak
      token (secret)**, cached schema, theme. **[Arch]** the `core/config`
      secure store behind `config_*` commands. **[GUI]** the Settings screen
      (Epic 10).
- [x] **Global concerns** — **[logic ✓]** `lib/logger`, `stores/useToasts`,
      theme preference persisted in config. **[GUI]** `Toast.vue`, loading
      states, and applying the theme (Light/Dark/**System**) to the DOM.
- [x] **Auth** — **[logic ✓]** the configured static KC token is sent as
      `Authorization: Bearer` on every backend call (`services/api/client`).

## Logic lane — what was built (Jernej)

```
src/
  main.ts                       bootstrap: Pinia + router + boot()
  app/
    router.ts                   4 rail routes + batch-work; RAIL_DESTINATIONS; meta.rail
    config.ts                   APP_NAME/VERSION, poll interval
    boot.ts                     load config → configure client → initial connection check
  domain/                       framework-free vocabulary (imports nothing)
    enums.ts                    VisibilityStatus, ItemType, FileRole, FileType,
                                TextExtractionStatus, Scope (backend-mirrored)
    schema.ts                   FieldDescriptor, ResolvedCode, RecordSchema
    metadata.ts                 Provenance, MetadataFieldValue, RecordMetadata
    config.ts                   AppConfig, ThemePreference, DEFAULT_CONFIG, isConfigured()
    connection.ts               ConnectionState, ReachabilityResult
  services/
    api/
      client.ts                 base client: baseUrl+/api join, Bearer auth,
                                 typed ApiError, JSON/multipart/binary, timeout
      health.ts                 checkConnection() / checkReachable() (reachability)
      dto.ts                    the FULL verified backend contract (all resources)
      index.ts                  barrel
    config.ts                   load/save config + token (secure store ↔ localStorage)
    backend.ts                  the singleton ApiClient (reconfigured from settings)
  ipc/
    bindings.ts                 typed command wrappers + Commands registry (contract)
    events.ts                   typed event listeners (contract)
  stores/                       useSettings, useConnection, useToasts (Pinia)
  lib/logger.ts                 leveled logger
```

All of the above **typechecks (`vue-tsc`) and builds (`vite build`) clean** and
was reviewed adversarially (correctness, contract-fidelity, lane boundaries).

## Handoff — what the other lanes now need

### GUI dev (`.vue` / `.css`)
- `App.vue`: drop the `greet` demo; add `<router-view/>`; bind `useConnection`
  in the footer.
- Screens (bind the per-epic composable; a placeholder renders until authored):
  `OverviewView`, `BatchesView`, `BatchWorkView` (+ `SetupTab`/`MetadataTab`/
  `ProcessingTab`), `SyncView`, `SettingsView`.
- Components: `AppRail` (bind `RAIL_DESTINATIONS`, highlight `route.meta.rail`),
  `ConnectionFooter` (bind `useConnection`), `Toast` (bind `useToasts`),
  first-run welcome card (show when `!useSettings.configured`).
- Apply the theme: read `useSettings.config.theme` and set the DOM
  (`light`/`dark`/`system` → `prefers-color-scheme`).
- Rule: presentation imports **composables + domain types only** — never
  `services/`, `ipc/`, or `stores/` directly.

### Arch/DevOps dev (`.rs` / `.py` / CI)
- **Register `tauri-plugin-http`** and grant the capability `http:default` with
  the backend host allow-listed — otherwise the client's `fetch` is denied at
  runtime.
- Implement the IPC commands the contract in `src/ipc/bindings.ts` names
  (`commands/`):
  - `config_load`, `config_save`, `config_get_secret`, `config_set_secret`,
    `config_delete_secret` — `core/config` secure store; the **API token must
    be an OS secret** (key `apiToken`), non-secret config a plain store.
  - `fs_pick_directory`, `fs_path_exists` — `core/fs` (Settings → Browse).
  - `jobs_start`, `jobs_cancel` are stubs for Epic 06.
- Wire **`tauri-specta`** to generate `src/ipc/bindings.ts` from the Rust
  signatures (replacing the hand-authored wrappers); keep the `Commands` names +
  arg shapes in sync. Events to emit later: `job://progress`, `fs://changed`.
- Remove the `greet` command from `lib.rs`.

### Backend (`nbcg`) — nothing required
- **No identity/verify endpoint is needed.** The app is single-workstation,
  single-user (no login); the static Keycloak token is authenticated by the
  backend on the first real write (`401`/`403`). Test connection is just a
  reachability ping (`GET /api/health`). (If per-user login is ever added, an
  identity endpoint + display can follow then.)
- Only confirm the **base URL**: the backend serves under global prefix `/api`,
  so the client uses `<backendBaseUrl><apiPrefix>` (default `https://api.nbcg.me`
  + `/api`). Confirm whether the public host already includes `/api`, and adjust
  `apiPrefix` if a proxy rewrites it.

> Verified-contract corrections found during this epic (fold into
> [09 – API contract](09-backend-api-contract.md)): COBISS preview is
> `GET /api/import/cobiss/preview/:cobissId` (not `/api/cobiss/:id/preview`);
> the schema already exposes `parentInheritable`/`issueIdentifying` and has **no
> `label`**; optimistic concurrency already exists (`expectedVersion` required
> on `PATCH`, shallow-merge); file upload `role` is **batch-wide, not
> per-file**; `replace-file` exists (`PUT /api/files/:fileId`).

## Acceptance

- **[logic ✓]** Config (roots, backend URL, token, theme) is modelled +
  persisted with a secure-store adapter; first-run detection (`isConfigured`)
  and the connection state (Connected / Offline) is computed correctly; the
  Bearer token is sent on every call. Typechecks + builds.
- **[GUI, pending]** App launches to the rail + Overview with no template code;
  navigation works; the Batches badge reflects live unfinished-batch count; the
  footer shows Connected/Offline; first-run shows the welcome card.
