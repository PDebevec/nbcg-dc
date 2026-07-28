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

## Acceptance

- A signed (if possible) Windows installer produces a working app on a clean
  machine with no manual Python setup.
- The full loop — batch → PDF/thumbnail/OCR → metadata → upload — works in the
  packaged build.
