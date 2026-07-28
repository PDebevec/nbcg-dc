# Epic 01 — App shell & navigation

> Depends on: — · Blocks: everything

Goal: a clean Tauri + Vue skeleton with the **four-destination rail**, the
screen router, and the plumbing every later epic needs. Matches the
[v1.4.0 design](../../desktop-app-interface-design/project) shell.

## Tasks

- [ ] Strip the default template (remove `greet` demo from
      [App.vue](../../src/App.vue) and [lib.rs](../../src-tauri/src/lib.rs),
      replace README/logos).
- [ ] Frontend toolchain: TypeScript, design tokens/components from the
      prototype (IBM Plex Sans/Mono, the indigo palette), **Pinia** for state,
      and a lightweight screen router.
- [ ] **Left rail navigation** — four destinations: **Overview**, **Batches**
      (badge = count of unfinished batches), **Sync**, **Settings**. Active
      state, icons, and the app identity block.
- [ ] **Connection footer** in the rail — backend host + **Connected / Offline**
      dot. This reflects **backend reachability only**, independent of item
      state (see [sync](08-sync-and-backend-data.md) for the reachability check).
- [ ] **Screen shell** — the main area swaps between Overview / Batches /
      Batch-work / Sync / Settings; batch-work is reachable from Overview and
      Batches, and the rail's Batches item stays active while in batch-work.
- [ ] **First-run empty state** — a welcome card prompting folder + backend
      setup when nothing is configured; CTA jumps to Settings.
- [ ] Establish the **Tauri command + event** conventions the core will expose
      (fs, jobs, http) — a thin, typed bridge between Vue and Rust.
- [ ] App configuration (persisted): `/unprocessed` + `/processed` roots,
      backend base URL, the **static Keycloak API token** (stored as a secret),
      cached schema, theme. Editable in [Settings](10-settings-and-naming.md).
- [ ] Global concerns: **toast** system, loading states, logging, and a
      **theme** (Light / Dark / **System**) matching the design.
- [ ] **Auth**: send the configured static KC token as `Authorization: Bearer`
      on all backend calls.

## Acceptance

- App launches to the rail + Overview, no template code left.
- Navigating between the four destinations works; the Batches badge reflects the
  live count of unfinished batches.
- The connection footer shows Connected/Offline correctly.
- Config (roots, backend URL, token, theme) is editable and persisted; first-run
  shows the welcome card.
