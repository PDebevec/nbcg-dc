# Frontend TODO — plan v dveh fazah

> Stanje: **21. 8. 2026**. Nadomešča verzijo z 12. 8.
> Vir: audit `docs/tasks/01–11`, `docs/06-native-core-and-dev-setup.md` (Rust 23/26 ukazov),
> backend repo `nbcg` commiti 8.–17. 8. (`acaa293..d22440f`) + `nbcg/todo/`.
> Legenda: 🟢 čisto GUI (`.vue/.css`, jaz) · 🟡 `.ts` wiring (Jernej — ali jaz po dogovoru, vsa prava logika že obstaja) · 🔵 Arch (`.rs/.py`) · ⚙️ ekipa / odločitev

---

## 0. Kaj se je spremenilo od 12. 8. in kaj to pomeni

| Sprememba | Posledica za frontend |
|---|---|
| **Rust** (`7db5639`): `config_*/fs_*/index_*/batch_*/sync_*` = 23/26 ukazov **pravih**, SQLite indeks, `fs://changed` watcher, keyring | Overview, Batches, Sync, Settings **že tečejo na pravih podatkih** v `npm run tauri dev`. Nič več "Sync failed" zaradi manjkajočega IPC. |
| Rust: `jobs_start/cancel/reprocess` + `job://*` eventi **ne obstajajo**; `py/web.py` ne zna obdelati realne mape (`py-real-data-mismatches.md`) | Processing se **ne more** pognati. Za test brez pipeline-a glej §1D. |
| Backend: **UTF-8 imena datotek popravljena** (`defParamCharset: 'utf8'`, RFC 6266 download header); ključ v `extractedTexts`, ki ne ustreza nobeni datoteki → zdaj **400** (prej tiho 201) | "filename-mangled" opozorilo iz prejšnjega plana je **zastarelo** → briši. Namesto njega: prikaz novega 400. |
| Backend: **Tika odstranjen** — `doOCR` polje in `POST /files/:id/extract` **ne obstajata več**; klient je **edini vir fulltexta** (brez txt = `NOT_EXTRACTED` za vedno); garbage detekcija zdaj in-process (`EXTRACTED/GARBAGE/NO_TEXT`) | Prazen OCR ni več "backend bo izluščil" — soft warning mora reči: "brez fulltexta za vedno, poženi OCR". `doOCR:false` v `services/upload.ts` je mrtvo. |
| Backend/Keycloak: `nbcg-web` ima zdaj **`directAccessGrantsEnabled: false`** v realm configu (varnostni pregled); redirect URI-ji generirani iz `available_hostnames`; brute-force lock po 5 napakah; geslo ≥12 znakov | **Pot do tokena s password grantom pade** ob naslednjem svežem importu realma (živi dev KC dela, dokler se ne re-importa). Desktop rabi svojo pot do tokena → ⚙️ odločitev, §1C. |
| Backend prod topologija: samo nginx 80/443; API = `https://<host>/api`, Keycloak = `https://<host>/auth`; `KEYCLOAK_ISSUERS` = seznam hostnamov | Default `backendBaseUrl` (`api.nbcg.me`) in `http:default` allow-list v capabilities sta placeholderja → posodobiti, ko je prod hostname znan. Dev (`localhost:3000` / `:8082`) nespremenjen. |
| Backend: `GET /api/items/:id/history` (revizije; rabi hidden scope), stats/tasks/users endpointi, `createdByName/updatedByName` v search `_source` (staff-gated), `?fields=` allowlist (neznana polja **tiho** izpuščena) | Aditivno. Nič za fazo 1; history/attribution v fazi 2. Jernej naj preveri search projekcije proti allowlisti. |
| Backend: **shema nespremenjena** (`GET /api/schema/record?level=`, ETag/304); `relevantForTypes`/`typeProfiles` še TODO na backendu | Schema-driven form gradi na obstoječem; material-type visibility = faza 2. |
| Backend: **COBISS preview** (`GET /import/cobiss/preview/:id`) narejen — "archive still needs to wire Get data" | Faza 1: Setup/Metadata "Get data" na pravi endpoint (`services/api/cobiss.ts` že obstaja). |

---

## 1. Pregled narejenega — dummy podatki in zastarele stvari (čiščenje)

Stores, services in domain so **čisti** (brez mockov). Vsi izmišljeni podatki so v **treh stub composablih**, ki jih še vedno vežejo pravi tabi:

| Kje | Kaj je fake | Zamenjati z (vse že obstaja) |
|---|---|---|
| `composables/useBatchSetup.ts:27-32` | `SAMPLE_POOL` — 4 izmišljeni parent zapisi; "search" samo vzame naslednjega | `services/api/collections.ts` (`searchParents/getParentById/hitToParent`), `services/api/relations.ts` (`connectParent`), `domain/parent.ts` |
| `useBatchSetup.ts:37-43` | `itemCount=3`, `cobissId/publish/visibility` lokalni refi (nič se ne shrani), lowercase `"draft"/"public"` namesto enumov | `stores/useBatches.ts` (`batch.itemIds`, `update()`), `stores/useBatchWork.ts` (`readOnly`, `advanceStageFor`), `domain/enums.ts` (`PublishTarget`, `VisibilityStatus`) |
| `useBatchSetup.ts:81-84` | `applyAndContinue()` = prazen no-op | `domain/provenance.ts` (`applyParentFields/applySerialParent/applyCobiss`) + `advanceStageFor("metadata")` |
| `composables/useMetadataForm.ts:85-108` | hard-coded 9 polj (`title, author, year, lang, place, publisher, subject, phys, note`) + 5 jezikov — **ne ustrezajo backend ključem** (`authors`, `publication`, `collectionType`…) | `services/api/schema.ts` (`getRecordSchema(level)`) + `domain/metadata-form.ts` (`fieldsForLevel/buildFormModel/validate*/humanizeKey/optionLabel/itemReadiness/firstIncompleteIndex`) |
| `useMetadataForm.ts:110-146` | `COBISS_SAMPLE` (Njegoš), `makeStubItems()` (3× Pobjeda), fake COBISS fetch s `setTimeout` | `stores/useItems.ts` filtriran po `batch.itemIds`; `services/api/cobiss.ts fetchCobissPreview()` + `applyCobiss()` |
| `useMetadataForm.ts:196-203, 234, 270` | files strip z literalom "28 TIFF images"; `sourceOptions: []` (source picker se nikoli ne pokaže); `setFieldSource` no-op | `domain/files.ts` (`discoverAsset/classifyAsset`) + `domain/naming.ts`; `domain/provenance.ts` (`fieldSourceOptions/chooseFieldSource`) |
| `composables/useProcessing.ts` (cel) | 3 fake vrstice, `setInterval` simulacija, fake napaka "OCR engine crashed on page 9", `upload()` samo nastavi `uploaded=true` — **nič se ne naloži** | **`stores/useProcessing.ts` je popoln pravi store** (`launch/start/rerunItem/rerunFailed/reprocess/cancel`, job eventi) + `services/upload.ts uploadBatch()`. Stub je čist duplikat — najvišja vrednost brisanja. |
| `composables/useSettingsScreen.ts:42,143-156` | `NAMING_SAMPLE_BASE` podvaja `SAMPLE_FOLDER_NAME`; imena ročno sestavljena (`${base}_10.pdf`) | `domain/naming.ts buildNamingPreview()` (derived/pages/multiAsset) |
| `views/OverviewView.vue:29` | `stageColumns` literal seznam | izpelji iz `domain/pipeline.ts RUNNABLE_STAGES` / `StageName` (drobnarija) |
| Tipi: `ParentRecordsCard.vue`, `FilesStrip.vue`, `MetaField.vue` uvažajo `*View` tipe iz stubov | ob zamenjavi preseliti tipe v prave composable |

**Zastarelo zaradi backend sprememb (`.ts`, Jernej — za kontekst):**
- `domain/naming.ts` `decodeMojibakeFilename / isSameUploadedFilename / isMangledFilename`, `services/upload.ts:630-707` popravilo mojibake imen, `domain/upload.ts:77-85` Latin-1 opomba → backend zdaj ohrani UTF-8; namesto tega obravnava **400 "extractedTexts contains keys matching no uploaded file"** (ključi morajo biti == `originalname`, pazi NFC/NFD).
- `services/upload.ts:617` `doOCR: false` → polje ne obstaja (whitelist ga tiho odstrani); klici `/files/:id/extract` → 404.
- `services/upload.ts:725-743` `splitEmptyTexts` — preveriti, ali je workaround za backend truthiness še potreben.
- `domain/config.ts:41-44` `dataPassingCollectionTypes: []` → **noben parent ne more podati podatkov** (TBD vrednost) — rabi pravo vrednost za fazo 1.
- `docs/00` curl: `client_id=nbcg-api` → `nbcg-web` (in glej ⚙️ token spodaj).

---

## FAZA 1 — delujoči prototip za dejanski test

**Cilj:** operater v `npm run tauri dev` lahko: nastavi app → vidi skenirane mape → naredi batch → Setup (parenti/COBISS/publish) → Metadata (prava shema, validacija, shranjevanje) → Processing (ali testna bližnjica §1D) → **Upload na backend** → Sync pokaže stanje. Brez izmišljenih podatkov.

> **Stanje 21. 8. 2026 (po implementaciji):** 1A in 1B sta **narejena** (vue-tsc čist, build OK, 604 testov zelenih + isti 14 pred-obstoječi padci v `schema.test.ts`). Kar še manjka za dejanski test, je zbrano v **§1C** — gre za odločitve/druge lane, ne za GUI kodo.

### 1A. 🟢 GUI — moja lane

- [x] **Setup tab** na pravi composable: iskanje parentov (backend search, "Linked" stanje, link po id-ju), publish/visibility shranjena v batch, COBISS id shranjen, **Apply & continue** kopira parent polja + COBISS na vse iteme; read-only onemogoči vnose.
- [x] **Metadata tab — schema-driven form**: polja iz `GET /schema/record` (main/child), skupine z naslovi, `humanizeKey()` labele, `allowedValues` v selectih (cnr label), **object** (sub-form) in **array-of-object** (ponovljivi vnosi), multi/multi-enum chipi, boolean/number; validacija (required / not_allowed / wrong_type), `issueIdentifying` → "Still to fill"; navigator iz pravih itemov + readiness; "Go to processing" blokiran → skok na prvi nepopoln + toast "N remaining".
- [x] **Metadata tab — per-item Publish + Visibility** (default iz batcha, override, reset na batch default).
- [x] **Metadata tab — files strip iz pravih assetov**, COBISS "Get data" (loading / not-found / forbidden / offline / "already imported" nota, overwrite prompt).
- [x] **Processing tab — run polovica** na `stores/useProcessing`: start/cancel, live progress iz `job://*`, run log, rerun item / rerun failed, lock "another batch is running". *(Runtime čaka na Arch `jobs_*`.)*
- [x] **Processing tab — upload polovica (minimalna)**: Upload → `uploadBatch()`, progress, per-item rezultat (uploaded / blocked / forbidden / duplicate / error), backend 400 → field errors, po uspehu batch `uploaded` + arhiviran + items refresh.
- [x] **Hard gates prikaz** pred uploadom (processing-failed, not-processed, no-assets, thumbnail-unresolved, metadata-invalid) + soft warningi; Upload gumb onemogočen, dokler so hard gate-i.
- [x] **Soft warning "prazen OCR"** s popravljenim besedilom (backend ne ekstrahira več).
- [x] **Batch header**: three-step indikator + progress.
- [x] **Rebuild index** gumb v Overview toolbaru (confirm + toast).
- [x] **Settings → "Parent data passing"** polje (`dataPassingCollectionTypes`, vejice) — da se parent prefill da testirati brez spremembe kode.
- [x] **Čiščenje**: stubi zamenjani s pravimi composabli (`*View` tipi ostajajo v composablih), `stageColumns` iz domene, "filename-mangled" ni več v GUI načrtih.

### 1B. 🟡 `.ts` wiring — narejeno (Jernej naj pregleda)

- [x] `composables/useParentLinks.ts` (nov, skupen Setup/Metadata), `useBatchSetup`, `useMetadataForm`, `useProcessing` — pravi
- [x] **nov store `stores/useMetadata.ts`** — delovne vrednosti po itemu (provenance), shema po levelu, autosave v `metadata.json` (samo za še ne naložene iteme; za povezane ostane mirror backend snapshot, delovne vrednosti gredo v upload kot `ctx.metadata`), COBISS/parent apply, cache parent zapisov
- [x] **nov store `stores/useUpload.ts`** — ovije `uploadBatch`, rezultati, arhiviranje
- [x] **nov `domain/metadata-wire.ts`** (+ testi) — pretvorba enum vrednosti: backend shranjuje `ResolvedCode {code,en,cnr}` objekte (preverjeno: `DomainRecord`, webapp admin editor), Jernejev `validateField` pa pričakuje gole kode → form dela s kodami, na meji (mirror/upload) pretvorimo. **Jernej: preveri, ali naj to živi v `metadata-form.ts`.**
- [ ] odstrani zastarelo (Jernej): mojibake/mangled helperji, `doOCR`, `/extract`; novi 400 za `extractedTexts` ključe trenutno pride kot generično sporočilo napake; preveri `?fields=` allowlist v search projekcijah; 14 padajočih testov `schema.test.ts` (Node 25 `localStorage` global brez `removeItem` — test setup rabi stub)

### 1C. Brez tega faza 1 ni testabilna (druge lane / odločitve)

> **Checklist za test (stanje 21. 8.):**
> 1. `npm run tauri dev` (Rust + Build Tools) — `npm run dev` nima podatkov.
> 2. Settings: roots, API URL `http://localhost:3000`, token (password grant na `nbcg-web` še dela na živem dev Keycloaku; pade, ko se realm re-importa), **Parent data passing** = prave `collectionType` številke (sicer parent ne prefilla).
> 3. Scan → Overview → Create batch → Setup → Metadata → Processing: **Start processing pade** (`jobs_*` ni v Rustu) → testna bližnjica §1D: derived datoteke v mapo + **Rebuild index** → batch sam preide v Ready → Upload.
> 4. Upload rabi token z `drafts:manage`/`records:manage` (+ `import:execute` za COBISS).

- 🔵 **Arch**: `jobs_start/cancel/reprocess` + `job://progress|stage-changed|done`; Python popravki (`web.py` leksikografsko sortiranje → naravno, brez `jpg/`+`tif/` podmap, UTF-8 stdout, `ocr.py setrlimit` na Windows). Do takrat: §1D.
- ⚙️ **Token za desktop** (blokira vsak upload, ko se realm re-importa): `nbcg-web` ima DAG izklopljen. Možnosti: (a) ločen Keycloak klient `nbcg-desktop` (public, Authorization Code + PKCE z loopback redirectom `http://127.0.0.1:<port>` — Tauri lahko; rabi registriran redirect URI in audience mapper na `nbcg-api`), (b) dedicated confidential klient / service account za delovno postajo, (c) začasno za **dev**: DAG pustiti vklopljen na živem dev KC. **Priporočilo:** za fazo 1 (c) + podaljšan `access token lifespan` v dev realmu (privzeto 5 min; app računa na statičen token), za prod (a) kot ločena naloga.
- ⚙️ **Prod base URL / capability allow-list**: `https://<host>/api` → posodobiti default v `domain/config.ts` in `src-tauri/capabilities/default.json` (trenutno `api.nbcg.me` placeholder), ko je hostname znan. Keycloak hostname mora biti v `KEYCLOAK_ISSUERS`.
- ⚙️ `dataPassingCollectionTypes` — katere collectionType vrednosti prenašajo podatke na child (sicer parent linking v Setupu nič ne naredi).
- Jernej/docs: curl v `docs/00` → `nbcg-web` + opomba o DAG.

### 1D. Testna pot brez pipeline-a (dokler Arch ne odda jobs + py)

Rust ob **`index_rebuild`** (in samo takrat — navaden scan tega ne dela) sklepa stage-e iz obstoječih derived datotek v mapi:
`<mapa>.pdf` (web) · `<mapa>_archive.pdf` · `<mapa>_thumb.png` · `<mapa>.txt` (OCR).
Postopek: v `/unprocessed/<mapa>/` ročno podstavi te datoteke → **Rebuild index** (zato gumb v 1A) → stage-i PDF/Thumbnail/OCR = done → batch lahko postane Ready → Metadata → Upload. Batchi rebuild preživijo (id-ji so hash imena mape). Preveriti, da `batch.proc`/readiness v TS res sledi stage-em iz indeksa.

### 1E. Definition of done za fazo 1 (test scenarij)

1. Svež zagon → Settings: roots, URL, token → Test connection OK → Refresh schema OK.
2. Mapa s skeni v `/unprocessed` se pojavi v Overview (watcher), pravilni stage-i.
3. Izberi → Create batch → Setup: poišči parent, COBISS Get data, publish/visibility → Continue.
4. Metadata: prava polja iz sheme, validacija, shrani (`metadata.json` v mapi), navigator med itemi.
5. Processing: run (ali §1D) → Ready → Upload → backend ima record + datoteke + fulltext; Overview kaže Uploaded, mapa v `/processed`; Sync pokaže zadnji run.
6. Re-open uploaded batcha je read-only; Edit/re-process odklene.

---

## FAZA 2 — vse ostalo

### 2A. 🟢 GUI polish in preostali epici

- [ ] **First-run welcome card** na Overview (`!useSettings.configured`, CTA na Settings) — Epic 01/11
- [ ] **Tema**: `data-theme` na `<html>`, `prefers-color-scheme` pri "system", `[data-theme="dark"]` blok v `tokens.css` — Epic 01/10
- [ ] **Settings Configure**: Revert gumb, unsaved-changes prompt (`onBeforeRouteLeave` + `dirty`), Paste gumb za token, prikaz cache sheme po levelih ("41 fields, updated <čas>", `stale` vs ok), Test connection kaže na krivo polje (`not-nbcg-api` → base URL) — Epic 10
- [ ] **Settings Data tab**: live preview z vnosom imena mape (prazno → `SAMPLE_FOLDER_NAME`), render `buildNamingPreview()` (derived/pages/multiAsset), multi-asset izjema — Epic 10
- [ ] **ThumbnailPicker**: grid kandidatov (samostojne slike + first-page), klik = primary, "needs choice" marker, 1 kandidat/`thumbnail` slika → auto; Thumbnail stage ne sme kazati done, dokler ni izbran — Epic 04/06 + `cover-shots-…md`
- [ ] **Upload polovica — polna**: include/exclude set po datoteki (marker za primary), ostali soft warningi (GARBAGE/NO_TEXT pred uploadom, podvojene številke strani), re-upload pot (Needs re-upload zamenja na mestu; metadata-only = PATCH z `expectedVersion`) — Epic 07
- [ ] **Setup tab kontroli**: book/graphical content-kind toggle (auto/book/graphical) + **splitSpreads** toggle per item — Epic 05/06 ("still owed by GUI")
- [ ] **Re-process UI**: eksplicitni rebuild poljubnega stage-a + auto-detect predlog ("nove/spremenjene slike → re-process") — Epic 06
- [ ] **Backend search / browse UI** (`useBackendSearch`): filtri, paging, vrstice "already local" vs "web-only" — Epic 08
- [ ] **Orphaned badge** na Overview (brez resolve akcije) — Epic 08
- [ ] Provenance **source picker** polno (per-field vir: COBISS / parent / ročno) — Epic 05, če v fazi 1 ostane minimalen

### 2B. Novosti na backendu (ko/če pridejo)

- [ ] **Material-type field visibility**: `relevantForTypes` + `typeProfiles` iz sheme → primarna polja glede na `materialType`, ostala v zložljivi "Additional fields" sekciji (backend TODO `backend-archive-material-type-field-visibility.md`)
- [ ] **Zgodovina zapisa**: `GET /items/:id/history` (rabi `records:view:hidden` + `drafts:view:hidden` → samo za staff token) — opcijski tab
- [ ] `createdByName/updatedByName` v search rezultatih (staff-gated) — prikaz v backend search UI
- [ ] Token: Authorization Code + PKCE flow v Tauri (`nbcg-desktop` klient), refresh tokena, obvestilo ob potekli seji — če ekipa izbere možnost (a) iz §1C

### 2C. 🔴 Blokirano na produktnih odločitvah — NE gradi še

- [ ] **Cover / "not a page" kontrola** (`cover-shots-and-thumbnail-choice.md`)
- [ ] **Editable "base name"** v Setup tabu (`naming-base-and-unicode-filenames.md` §1)

### Čakajoče na druge lane (po fazi 1)

- 🔵 Arch: per-file re-upload granularnost (07, optimizacija), packaging/installer + Python bundling (11), `cargo audit` v CI, pregled http capability scope
- 🟡 Jernej: `useSync`/`useBackendSearch`/`useNaming` composabli za 2A postavke
- ⚙️ ekipa: `.npmrc` `min-release-age=7`; odločitvi za 2C; prod hostname

---

## Opombe

- `maybe-read-after-write-refresh.md` — backlog MAYBE, ne gradi.
- Prototype `NBCG Archive.dc.html` ostaja vizualna referenca; naming picker (prefix/base) iz prototipa je namerno opuščen.
- `npm run dev` (brez Rusta) = samo styling; za karkoli s podatki `npm run tauri dev` (Rust + VS Build Tools, glej `docs/06`).
- Backend untracked `nbcg/docs/keycloak-frontend-auth.md` opisuje SPA PKCE flow in porte iz dev obdobja — za prod so porti zastareli.
