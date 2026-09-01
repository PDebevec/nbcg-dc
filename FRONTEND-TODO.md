# Frontend TODO

> Stanje: **1. 9. 2026**. Nadomešča verzijo z 21. 8.
> Vir: pregled commitov `15511db..faa3ee0` (Arch: pipeline + Overview novosti) in posodobljenih `docs/tasks`.
> Legenda: 🟢 GUI (`.vue/.css`, jaz) · 🟡 `.ts` (Jernej) · 🔵 Arch (`.rs/.py`) · ⚙️ ekipa / odločitev

---

## 0. Novo od 21. 8. (Arch, commiti 26. 8.–1. 9.)

| Sprememba | Posledica za frontend |
|---|---|
| **Pipeline narejen**: `jobs_start/cancel/reprocess` implementirani + registrirani, `job://*` eventi se oddajajo, Cancel ubije Python proces; **vseh 26 IPC ukazov živih**. Python prenovljen (`py/nbcg_pipeline/`, `web.py`/`ocr.py`/`pdf_derive.py` + testi); `py-real-data-mismatches.md` = **done** | **Processing zdaj dejansko teče** — Start/Cancel/Rerun v Processing tabu delajo brez sprememb GUI kode. Testna bližnjica "derived datoteke + Rebuild index" ni več potrebna (ostane kot recovery pot). |
| **Python = sistemski interpreter** (`python`/`py` na PATH), poti do skript so vgrajene; **pred prvim runom `pip install -r py/requirements.txt`** (Pillow, pypdfium2; za OCR še paddleocr + **poppler**, ki ga pip ne namesti). OCR še ni bil pognan v živo | Brez pip installa "Start processing" pade ob prvem spawnu. ⚠️ `docs/06` §Developer setup tega koraka še ne omenja (→ Arch). |
| **Overview novosti** (Arch napisal tudi `.vue`): rekurzivno odkrivanje **gnezdenih map** (globina ≤32, zamik, `relativePath`, item id = hash relativne poti), **Hide/Unhide** + "Show hidden" toggle (persistiran, brez kaskade), **View contents** peek modal (`fs_peek_folder`) | Nič obveznega zame; opcijski "fast-follows" v §3E. `Item` je dobil `relativePath`/`hidden`. |
| **Processing limit**: `maxConcurrentItems`/`maxConcurrentOcr` (privzeto 3/1, max 8) — **samo config.json knob, docs izrecno: brez Settings UI** (`docs/03-open-questions.md` §"no Settings UI") | ❌ **Ne delati** Settings kontrole za limit. |
| **Re-upload granularity**: `Item.flags.reuploadTextOnly`; text-only re-upload pošlje samo `setFileText`, brez blobov | Brez UI sprememb; upload je pri tekst-only spremembi hitrejši. Znana luknja: text-only push ne sproži text-quality warninga (Jernej/Arch). |
| `services/indexing.toItem` zdaj kliče `markNonApplicableSkipped` → N/A stage-i so **`skipped` namesto `pending`** | Preveriti prikaz `skipped` pik v `StagePips` (§3A). |
| Arch je dodal **teste za moj `useProcessing` composable** (+ store/indexing/pipeline teste) — vsi zeleni | Stanje: `vue-tsc` čist; 675/689 testov zelenih, pada istih 14 (`schema.test.ts`, Node artefakt). Priporočilo za vse: **Node 22 LTS** (18/20.11 vitest ne požene, 25 podre schema teste). |
| Docs popravljeni: `ProcessingTab`/`useProcessing` nista več napačno "owed"; open question #3 (volumes) zaprt, #4 (Python invocation) de-facto "system Python, sidecar → Epic 11" | Preostale GUI obveznosti so samo še v §3A. |

---

## 1. FAZA 1 — ✅ končana (21. 8., commit `15511db` + Arch dopolnitve)

Celoten tok Settings → scan → batch → Setup → Metadata → Processing → Upload teče na pravih podatkih; dummy podatkov ni več. Podrobnosti v git zgodovini in prejšnji verziji tega dokumenta.

**Ostanki iz faze 1 (ne-GUI):**
- [ ] 🟡 Jernej: pregled mojih datotek (`useParentLinks`, `useBatchSetup`, `useMetadataForm`, `useProcessing`, `stores/useMetadata`, `stores/useUpload`, `domain/metadata-wire` — kam spada?); odstranitev zastarelega (mojibake/mangled helperji, `doOCR`, `/extract`); lepši prikaz novega 400 za `extractedTexts` ključe; `?fields=` allowlist v search projekcijah; 14 padajočih `schema.test.ts` (Node ≥24 `localStorage` global — test setup rabi stub); text-only re-upload brez quality warninga
- [ ] ⚙️ **Token za desktop**: `nbcg-web` ima DAG izklopljen v realm configu (živi dev KC dela do re-importa). Dev: DAG pustiti + podaljšan Access Token Lifespan (privzeto 5 min!). Prod: ločen `nbcg-desktop` klient (PKCE + loopback redirect) ali service account — odločitev ekipe.
- [ ] ⚙️ **Prod base URL / capability allow-list**: `domain/config.ts` default in `src-tauri/capabilities/default.json` imata placeholder `api.nbcg.me`; prod bo `https://<host>/api`, KC hostname mora biti v `KEYCLOAK_ISSUERS`.
- [ ] ⚙️ `dataPassingCollectionTypes` — prave številke (vnos v Settings → "Parent data passing" obstaja, vrednosti še ni).
- [ ] Jernej/docs: curl v `docs/00` → `nbcg-web`; Arch/docs: pip/poppler korak v `docs/06` §Developer setup.

## 2. Checklist za test (stanje 1. 9.)

1. **Enkratno**: Python na PATH + `pip install -r py/requirements.txt` (za OCR še poppler; OCR lahko sprva izpustiš). Node 22 LTS za teste.
2. `npm run tauri dev` (Rust + VS Build Tools; `npm run dev` nima podatkov).
3. Settings: roots, API URL `http://localhost:3000`, token (password grant na `nbcg-web`; podaljšaj lifespan v realmu), "Parent data passing" številke.
4. Scan → Create batch → Setup → Metadata → **Start processing** (zdaj pravi pipeline) → Upload (token z `drafts:manage`/`records:manage`, + `import:execute` za COBISS) → Sync.
5. Recovery/fallback: derived datoteke ročno v mapo + **Rebuild index** še vedno deluje (stage-i iz datotek).

---

## 3. FAZA 2 — aktivno delo

### 3A. 🟢 Naslednje po docs (edine še "owed by GUI" — Epic 06)

- [ ] **book/graphical toggle** na Setup tabu (auto/book/graphical → `overrides[itemId].contentKind`) — runner ga že upošteva, nihče ga ne nastavi (`docs/tasks/06` §"Still owed by GUI")
- [ ] **splitSpreads toggle** per item, poleg book/graphical — ista situacija
- [ ] **ThumbnailPicker**: grid kandidatov (samostojne slike + first-page), klik = primary, "needs choice" marker; 1 kandidat/`thumbnail` → auto; hard gate `thumbnail-unresolved` ga že zahteva (Epic 04/06 + `cover-shots-…md`)
- [ ] **Re-process kontrola**: eksplicitni rebuild izbranih stage-ov (`useProcessing`/store `reprocess()` že obstaja); auto-detect predlog še ni niti Arch-side
- [ ] **`skipped` stage pike**: preveriti/dodati vizualni stil v `StagePips`/legendi (N/A stage-i zdaj prihajajo kot `skipped`)
- [ ] ❌ **NE delati**: Settings UI za processing limit (config.json-only, izrecno v docs)

### 3B. 🟢 Polish (kot prej)

- [ ] **First-run welcome card** na Overview (`!useSettings.configured`, CTA na Settings) — Epic 01/11
- [ ] **Tema**: `data-theme` na `<html>`, `prefers-color-scheme` pri "system", `[data-theme="dark"]` blok v `tokens.css` — Epic 01/10
- [ ] **Settings Configure**: Revert gumb, unsaved-changes prompt, Paste gumb za token, prikaz cache sheme po levelih ("41 fields, updated <čas>", `stale` vs ok), Test connection kaže na krivo polje — Epic 10
- [ ] **Settings Data tab**: live preview z vnosom imena mape, render `buildNamingPreview()` (derived/pages/multiAsset), odstranitev podvojene `NAMING_SAMPLE_BASE` — Epic 10
- [ ] **Upload polovica — polna**: include/exclude set po datoteki (marker za primary), GARBAGE/NO_TEXT pred uploadom, podvojene številke strani — Epic 07
- [ ] **Backend search / browse UI** (`useBackendSearch` — rabi Jerneja): filtri, paging, "already local" vs "web-only" — Epic 08
- [ ] **Orphaned badge** na Overview (brez resolve akcije) — Epic 08
- [ ] Provenance **source picker** — narejen v fazi 1, po testu po potrebi doplirati UX — Epic 05

### 3C. Novosti na backendu (ko/če pridejo)

- [ ] **Material-type field visibility** (`relevantForTypes` + `typeProfiles` — backend TODO)
- [ ] **Zgodovina zapisa** `GET /items/:id/history` (hidden scope) — opcijski tab
- [ ] `createdByName/updatedByName` v backend search UI (staff-gated)
- [ ] Token: PKCE flow v Tauri (`nbcg-desktop`), refresh, obvestilo ob potekli seji — če ekipa izbere to pot

### 3D. 🔴 Blokirano na produktnih odločitvah — NE gradi še

- [ ] **Cover / "not a page" kontrola** (`cover-shots-and-thumbnail-choice.md`; tudi docs/05 #5 cover-shot exclusion)
- [ ] **Editable "base name"** v Setup tabu (`naming-base-and-unicode-filenames.md` §1)
- [ ] Avtomatska detekcija spreadov (docs/05 #4) — zaenkrat ročni `splitSpreads` toggle (§3A)

### 3E. 🟢 Opcijski "fast-follows" za nove Overview funkcije (docs jih izrecno odlagajo)

- [ ] pravi expand/collapse drevesa gnezdenih map (zdaj samo zamik)
- [ ] bulk hide poddrevesa / bulk unhide
- [ ] sličice (thumbnails) v peek modalu
- [ ] virtualizacija tabele pri velikem številu vrstic

### Čakajoče na druge lane

- 🔵 Arch: OCR prvi živi zagon + poppler navodila; pip korak v `docs/06`; packaging/installer + Python bundling/sidecar (Epic 11); `cargo audit` v CI; pregled http capability scope
- 🟡 Jernej: postavke v §1 "Ostanki"; `useSync`/`useBackendSearch`/`useNaming` za §3B
- ⚙️ ekipa: token (§1), prod hostname, `dataPassingCollectionTypes`, `.npmrc` `min-release-age=7`, odločitvi §3D

---

## Opombe

- `maybe-read-after-write-refresh.md` — backlog MAYBE, ne gradi.
- Prototype `NBCG Archive.dc.html` ostaja vizualna referenca; naming picker (prefix/base) iz prototipa je namerno opuščen.
- `npm run dev` (brez Rusta) = samo styling; za karkoli s podatki `npm run tauri dev`.
- Supply-chain: zadnji pregled 1. 9. čist (npm + crate-i, vklj. `arrayref` incident 20. 8. — ni v lockfile-u niti v lokalnem cargo cache-u).
- Varnostna opomba iz backend repoja: `nbcg/docs/keycloak-frontend-auth.md` (PKCE flow, dev porti).
