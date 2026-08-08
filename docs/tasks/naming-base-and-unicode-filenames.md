# The naming base meets real folder names

> Lane: **logic (`.ts`)** + a decision from Jernej · Found: 2026-08-07
> §2 **confirmed live 2026-08-07** — see the reproduction below
> Data: [05-real-scan-data](../05-real-scan-data.md) · Relates to: Epics 06, 07, 10

The convention is "**the folder name is the base name** for the derived outputs",
adopted on the assumption folder names are correct and unique at scan time
(docs/01 §Naming, docs/03). Real folder names are:

```
CERNAGORA
Pisma iz Liona
sa vodenim zigom
ОКТОИХ петогласник 2
```

Two problems follow, one semantic and one mechanical. Neither is hypothetical —
these are the four folders we have.

## 1. Some folder names are not identifiers (decision)

`sa vodenim zigom` is Montenegrin for **"with a watermark"**. It is a note the
scanning operator left about the *state of the image*, not a name for the work —
the actual work is a map of Budva and Cetinje published in Vienna in 1886. Under
the convention it becomes `sa vodenim zigom.pdf`, `sa vodenim zigom_thumb.png`,
and a `metadata.json` keyed to a phrase that identifies nothing.

`ОКТОИХ петогласник 2` is a real title but carries a trailing volume digit with no
separator, so the "2" is indistinguishable from a page number to anything parsing
the stem.

The convention is not *wrong* — it is the cheapest thing that works, and 2 of 4
folders are fine. But it needs a stated fallback for when the folder name is
unusable.

- [ ] **Decide**: is the operator allowed to override the naming base? (An editable
      "base name" field in the Setup tab, defaulting to the folder name, is the
      obvious shape — and Settings → Data already renders a live preview from
      `buildNamingPreview(folderName)`, which would just take the override
      instead.)
- [ ] Or: accept folder-derived names as-is and treat the base name as an internal
      handle that no reader ever sees. Defensible — but then the **item title**
      must carry the real identity, and nothing currently guarantees the operator
      sets one that differs from the folder name.

## 2. Unicode filenames lose the full text — ✅ CONFIRMED, backend bug filed 🔴

**CONFIRMED 2026-08-07 — the text is silently lost.** Probed against the running
backend with a real token:

```
sent filename      : ОКТОИХ петогласник 2.pdf
extractedTexts key : "ОКТОИХ петогласник 2.pdf"
→ HTTP 201
returned filename  : "?????? ??????????? 2.pdf"     ← Cyrillic destroyed
textExtractionStatus: NOT_EXTRACTED
extractedText      : null                           ← full text GONE

ASCII control (same request shape, same item):
sent "ascii_name.pdf" → filename intact, EXTRACTED, text attached  ✅
```

So the prediction was right, and it is worse than "a display problem": because
`extractedTexts` is keyed **by filename**, the mangled name matches no key and the
OCR text is dropped without any error. `ОКТОИХ петогласник 2` — an actual folder in
the sample set — would publish with a corrupted filename and **no searchable full
text**, reported as a successful upload.

Root cause is backend-side (multipart `filename` decoded as latin1, not UTF-8) and
is filed as **P1** in
[`nbcg/todo/backend-multipart-filename-not-utf8.md`](../../../nbcg/todo/backend-multipart-filename-not-utf8.md).

**A workaround exists and is verified:** `PUT /api/files/:fileId/text` is keyed by
**fileId, not filename**, and works — it returned `{"updated":true}` and moved the
file to `EXTRACTED`. So the archive can detect the mangling (compare the returned
`filename` against what it sent) and re-attach the text by id.

Remaining checks:

- [x] **`PUT /api/files/:fileId` (replace)** — **confirmed 2026-08-08: same bug.**
      The stored filename is mangled identically. Damage is narrower, though:
      `extractedText` is *singular* on replace and not keyed by filename, so the
      text survives (`EXTRACTED`), and the attachment `id` and `role` stay stable.
      Only the stored name is corrupted.
- [x] **Spaces alone** are fine (`ascii_name.pdf` and the earlier `gorski.pdf`
      both round-tripped); it is specifically the non-ASCII bytes.
- [ ] **`Content-Disposition` on download** — needs the RFC 6266 `filename*` form
      for non-ASCII; still untested.
- [ ] Decide whether to **sanitise/transliterate** the base name for filenames
      while keeping the real name in metadata — a smaller surface than relying on
      every hop being UTF-8-correct, and it also fixes the `sa vodenim zigom`
      identifier problem in §1.

### Correction, 2026-08-08 — the mangling is *reversible*

The `??????` above is not the whole story. Re-run against the live backend with a
client that sends raw UTF-8 bytes (undici / Node `fetch`, and therefore Tauri's
`plugin-http`), the stored value is **mojibake**, not destruction:

```
sent   : ОКТОИХ петогласник 2.pdf
stored : ÐÐÐ¢ÐÐÐ¥ Ð¿ÐµÑÐ¾Ð³Ð»Ð°ÑÐ½Ð¸Ðº 2.pdf
         Buffer.from(stored,'latin1').toString('utf8') === sent   → true
```

Both shapes are reachable — which one you get depends on the HTTP stack that
built the multipart body — so the archive handles both
(`domain/naming.isSameUploadedFilename`).

### The third failure this caused: duplicate attachments

Detecting the mangling was not enough. `services/upload.pushReplaceAssets`
decided "replace this attachment" vs "upload a new one" by **matching filenames**
— the one thing that is broken. So on Cyrillic material the lookup always missed
and every re-upload **added a second copy** of the file instead of replacing it.
Live-verified: two attachments after one re-upload.

Fixed 2026-08-08; see [Epic 07 §Audit pass](07-upload-and-publish.md). The rule
that came out of it, and the reason it lives in `domain/naming`:

> **Never compare a backend-returned filename with `===`.** Go through
> `isSameUploadedFilename`. Anything keyed on a filename the backend gave back is
> suspect until the P1 is fixed.

## Status of each half

**§2 is confirmed and mitigated on both paths (updated 2026-08-08).**
`services/upload` detects the mangling on **first upload** — comparing each
returned attachment's `filename` against the one it sent, positionally — and
re-attaches any lost text via the fileId-keyed `PUT /api/files/:fileId/text`,
raising a warning so the operator knows the stored filename is corrupted. On
**re-upload** it now matches through `domain/naming.isSameUploadedFilename`, so a
changed file is replaced in place instead of duplicated, and the same warning
fires. That keeps the **full text and the attachment set** correct even against an
unfixed backend; the **stored filename** can only be fixed backend-side.

**§1 is still a product decision.** The logic lane's naming rules are
single-sourced in `domain/naming.ts`, so an operator override or a sanitising step
is a small change once the answer is known — guessing now would bake in a
transformation nobody asked for.

## Acceptance

- A folder whose name is unusable as an identifier has a defined path to a sensible
  base name.
- `ОКТОИХ петогласник 2` uploads, attaches its OCR text to the right file, and
  downloads with its filename intact — or the base name is deliberately sanitised
  and that is documented in `domain/naming.ts`.
