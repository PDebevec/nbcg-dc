# Epic 11 — Packaging & distribution

> Depends on: 01, 06, 10 · Blocks: — (ship)

Goal: a Windows installer staff can run, with Python and its dependencies handled
so there is nothing to set up by hand.

## Tasks

- [ ] ⛔ Confirm **target OS** = Windows only (open question #1); scope
      macOS/Linux only if needed.
- [ ] **Bundle Python** per the chosen strategy (Epic 06): sidecar runtime +
      deps (PaddleOCR, Pillow, pdf2image/poppler, OpenCV) OR document a system
      install — sidecar strongly preferred for non-technical staff.
- [ ] Handle **OCR model assets** (PaddleOCR downloads models on first run):
      pre-bundle or manage a first-run download with progress.
- [ ] Configure **Tauri bundling** ([tauri.conf.json](../../src-tauri/tauri.conf.json)):
      app identity, icons, Windows installer (MSI/NSIS), signing if available.
- [ ] **Auto-update** strategy (Tauri updater) so fixes reach staff easily.
- [ ] **First-run setup** flow: point the app at the `/unprocessed` and
      `/processed` roots, the backend URL, and the static KC token; validate
      connectivity via Test connection (Epic 10).
- [ ] Smoke-test the packaged build on a clean Windows machine (no dev tools, no
      Python preinstalled).

## Logic lane (`.ts`) — nothing owed, checked 2026-08-08

This epic is **entirely Arch/DevOps**. Every checkbox above is `.rs` / CI / Python
packaging. The logic lane's only touchpoint is the **first-run setup flow**, and
the pieces it needs already exist from Epics 01 and 10:

| First-run needs | Already built |
|---|---|
| "Not configured yet" detection | `domain/config.isConfigured()` → `useSettings.configured` |
| Roots + base URL + token entry, with validation | `stores/useSettings` (draft/save/revert), `domain/config.validateConfig` |
| Folder picking + "is this a real folder?" | `services/config.pickDirectory` / `probeRoot` (`RootValidity`, incl. `unknown` when there is no filesystem to probe) |
| Test connection | `services/api/health.checkConnection` → classified `ok` / `not-nbcg-api` / `server-error` / `unreachable` |
| Installed app version for the Settings footer | `services/config.getAppVersion()` |

So first-run is a **GUI assembly job** over existing logic, not new logic.

**Two capability items that fail *silently* if missed** (repeated from Epic 01
because they only bite in a packaged build, which is this epic):

- **`core:app:allow-version`** — without it `getAppVersion()` falls back to the
  compiled-in constant, so the Settings version line drifts from the installed
  bundle and reports the wrong version after an update. No error, just a wrong
  number.
- **The `config_*_secret` commands** — without them the Keycloak token falls back
  to webview `localStorage` **in plain text**. That fallback exists for the `vite`
  dev session; shipping it would put a live credential on disk unencrypted.

Also still required from Epic 01: register `tauri-plugin-http` and allow-list the
backend host, or every backend call is denied at runtime.

## Acceptance

- A signed (if possible) Windows installer produces a working app on a clean
  machine with no manual Python setup.
- The full loop — batch → PDF/thumbnail/OCR → metadata → upload — works in the
  packaged build.
