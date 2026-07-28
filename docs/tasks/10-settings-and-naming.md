# Epic 10 — Settings & naming

> Depends on: 01, 09 · Blocks: 11 (first-run Test connection)

Goal: the **Settings** screen — Configure (folders, backend connection, theme,
schema, version) and Data (the read-only naming convention). Config plumbing
lives in [Epic 01](01-app-shell.md); this epic is the screen + the naming rules.

## Tasks

### Configure tab

- [ ] **Folder locations**: `/unprocessed` and `/processed` roots, each with a
      **Browse…** picker (Tauri dialog) and a **validity** status (Valid / Not
      set / invalid path).
- [ ] **Backend connection**: **API base URL** (default `https://api.nbcg.me`)
      and **API access token** — stored as a secret, **masked by default** with
      **Show/Hide** and **Paste**.
- [ ] **Test connection**: call the backend **identity/verify** endpoint (backend
      task `nbcg/todo/backend-archive-identity-verify.md`); on success show the
      authenticated identity (email) + access level, on failure show the 401
      ("token rejected"). Also drives write-gating.
- [ ] **Theme**: Light / Dark / **System**.
- [ ] **Refresh metadata schema**: re-fetch `GET /api/schema/record` and update
      the cache (see [metadata & schema](04-metadata-editor-and-schema.md)).
- [ ] **App version** display; **Save settings** persists config.

### Data tab — naming (read-only reference)

- [ ] Show the **folder-derived naming convention** read-only (nothing editable):
      the item's **folder name is the base name** for the derived outputs (**for
      now**), so a folder `njegos_gorski_vijenac` yields `njegos_gorski_vijenac.pdf`,
      `njegos_gorski_vijenac_archive.pdf`, `njegos_gorski_vijenac_thumb.png`,
      `njegos_gorski_vijenac.txt`, `njegos_gorski_vijenac.json`.
- [ ] Note the **multi-asset exception**: when a folder holds **several PDFs or
      images**, those discovered files keep their **own filenames** (that's how a
      PDF's full text is matched to it — `foo.pdf` ↔ `foo.txt`); only the
      single-item derived outputs use the folder name.
- [ ] Show the **multi-page numbering** rule: items with several pages append a
      running, **unpadded** page number after an underscore (`…_1.pdf`,
      `…_2.pdf`, … `…_10.pdf`).
- [ ] A **live preview** built from a sample folder name, matching the reference
      convention.

> This drops the prototype's prefix / base-identifier picker
> (COBISS/Signature/Accession/Title) and its `NBCG_` prefix. Naming is derived
> from the scanner's folder name, on the assumption folder names are
> correct/unique at scan time. There is no backend naming step. See
> [decisions](../03-open-questions.md) and the shared implementation in
> [processing](06-processing-pipeline-and-jobs.md).

## Acceptance

- Configure persists roots (with validity), backend URL, and the masked token;
  Test connection reports the authenticated identity or a clear 401.
- Refresh schema updates the cached field defs; theme switches Light/Dark/System.
- The Data tab shows the folder-derived naming + multi-page rule read-only, with
  a correct live preview, and nothing there is editable.
