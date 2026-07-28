# Epic 05 — COBISS, parents & provenance

> Depends on: 03, 04, 08, 09 · Blocks: 07

Goal: the automation that makes the common cases near-zero-typing — the batch
**Setup tab**, COBISS prefill, parent linking, the serial-issue flow, and the
**provenance engine** that tracks where every field value came from. Implements
the four ingestion cases from [concept & UX](../01-concept-and-ux.md).

## Provenance model

Every field value is `{ value, provenance ∈ {cobiss, parent, user}, sourceParentId }`.
Empty fields fill silently; a field the **user** already edited raises the
overwrite prompt. Provenance drives the coloured tags, the per-field source
picker, and conflict resolution.

## Tasks

### Setup tab (batch-wide defaults)

- [ ] **Prefill from COBISS (batch)**: an optional batch COBISS ID that, on
      *Next → Metadata*, applies COBISS data to **all** items (provenance
      `cobiss`), overriding parent-inherited fields.
- [ ] **Parent records (batch)**: search + link one or more parents (by id) from
      the backend collections list; a parent is **eligible to pass data** only if
      its `collectionType` is in the data-passing set (serial-type; exact value(s)
      TBD, configurable). Among eligible parents, **exactly one passes data** at a
      time (toggle "can pass data" ↔ "passes data"); ineligible types link but
      never pass data.
- [ ] **Publish / Visibility controls** live here (Draft/Record ·
      Public/Private/Hidden) as **batch defaults** — each item can override them
      in its Metadata screen; semantics defined in
      [upload & publish](07-upload-and-publish.md).
- [ ] **Apply-to-all on Next**: copy the data-passing parent's shared fields into
      each item's **empty** matching fields (provenance `parent`), then, if a
      batch COBISS ID is set, apply COBISS to all fields (provenance `cobiss`);
      advance the batch to `metadata`.

### Metadata tab (per item)

- [ ] **COBISS per item**: enter a CG-ID → **Get data** calls the backend's
      synchronous **preview** (`GET /api/cobiss/:id/preview`, backend task
      `nbcg/todo/backend-archive-cobiss-preview.md`) and fills the fields
      **without persisting**. Handle not-found / multiple / upstream error.
      COBISS ids yield **deterministic** record ids (the backend computes
      `generateDeterministicId(cobissId)`), so the archive can compute the
      would-be id and detect "already imported" *before* creating — see the
      backend task file.
- [ ] **Overwrite prompt**: if a field already holds a **user** value, prompt
      **"Overwrite all"** vs **"Keep mine, fill empties"** before applying COBISS.
- [ ] **Parent picker per item (many-to-many)**: link an arbitrary set of parents
      via `POST /api/relations/connect`; the graph may contain **cycles** (allowed
      by design) — don't assume a tree; guard local traversals against cycles.
      Linking a data-passing parent fills empty matching fields (provenance
      `parent`).
- [ ] **One-parent-passes-data toggle** (per item, mirrors Setup): switching the
      source is one click; at most one parent passes data at a time.
- [ ] **Per-field source picker**: when two or more linked parents could supply
      the same field, a picker lets the cataloguer choose **which parent**, or
      **Manual entry** (flips provenance to `user`).
- [ ] **Serial/issue flow (case 4)**: on linking a serial parent, copy its shared
      fields into empty fields and flag the per-issue fields (volume/year, issue
      number, date) as **"Still to fill"**. Everything copied stays fully
      editable.
- [ ] **Case routing**: from level (main/child) + presence of COBISS ID + parents,
      drive the editor to the right behaviour per the four-cases table. COBISS and
      parents are **non-exclusive** prefillers; using one never blocks the other.

## Acceptance

- Setup applies a batch COBISS ID and/or the data-passing parent's fields to all
  items on Next, with correct provenance.
- Typing a valid COBISS ID per item fills the form (cases 2 & 3); the overwrite
  prompt appears only when a user-edited field would be replaced.
- Linking a serial parent copies metadata and leaves only the issue fields to
  fill (case 4).
- With multiple linked parents, the per-field source picker chooses the parent
  (or Manual), and provenance tags reflect the choice.
