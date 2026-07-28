
Functional & backend specification · Prototype v1.4.0
NBCG Archive — how it works & what the backend must provide
A complete read of the desktop client's behaviour, screen by screen and flow by flow, translated into the capabilities a backend has to expose. Every place the prototype currently fakes something, or where a real decision is still open, is flagged inline and collected at the end.

Product  NBCG Archive — digital-library client
Shell  Desktop app (Tauri)
Backend  api.nbcg.me · bearer token
Status  Clickable prototype (data & services mocked)
Contents
What the app is
Domain model (the objects)
Item lifecycle & states
End-to-end flow
Screen-by-screen behaviour
The processing pipeline
Metadata & cataloguing
Integrations: COBISS & Sync
Publishing & upload
Naming rules
Configuration & connection
Backend requirements (consolidated)
What is mocked vs. real
Open decisions
01What the app is
NBCG Archive is a desktop client for library digitisation. A scanning workstation drops folders of page scans (TIFF images) into a watched /unprocessed location. The app turns each folder into a finished, catalogued archive item — an archival PDF, a web PDF, a thumbnail, an OCR text layer and a metadata record — and then uploads that item to the library's catalogue backend, moving the source into /processed.

The app is the operator's cockpit around that pipeline: it lists what has arrived, groups items into batches, lets a cataloguer fill and enrich metadata (with help from COBISS and from parent serial/collection records), runs the conversion pipeline, uploads the results, and keeps the local archive's metadata in step with the backend via a periodic sync.

It talks to exactly one backend over HTTPS, authenticated with a bearer token, configured in Settings. All heavy files stay local; only derived outputs and metadata are pushed.

i
Reading the flags in this doc
Backend need a capability the server must expose  ·  Mocked faked in the prototype, needs building  ·  Decision an open choice for you to make.

02Domain model (the objects)
Four object types drive the whole app. A backend has to be able to represent, persist and/or serve each of these — even the ones that look local-only, because Sync and re-upload depend on stable identity.

Item
One digitised document (a book, a periodical issue, a calendar, etc.). Backed on disk by a single folder of source TIFFs.

Field	Meaning
id	Local identifier for the item within the app.
folder	Absolute-ish path, e.g. /unprocessed/njegos_gorski_vijenac. Moves to /processed/… on upload.
title	Human title shown in lists (working title until metadata is filled).
backendId	Catalogue ID assigned by the backend on upload, e.g. NB-10442. Empty until uploaded.
sources	Source count/summary, e.g. 24 TIFFs.
level	main (standalone record) or child (an issue that belongs to a parent serial). Determines which metadata schema applies.
stages	Per-stage pipeline status — see §06. Keys: pdf, thumb, ocr, meta, upload.
error	Failure message from the pipeline when a stage fails.
batchId	The batch this item currently belongs to (if any).
uploaded	True once published to the backend.
reupload	Flag: item is uploaded but its files/metadata changed and need re-pushing.
parents	Linked parent records (serials/collections) this item inherits fields from.
meta	The catalogue field values. Each field is { value, provenance, sourceParentId } — see §07.
Batch
A working set of items processed together. A batch groups one item type at a time, and only one batch runs the pipeline at any moment (a hard concurrency rule — see §06).

Field	Meaning
id / no	Identity and human number (Batch #017).
created	Creation timestamp.
itemIds	Ordered list of member items.
type	The single item state this batch was created from (e.g. unprocessed).
stage	Batch progress: setup → metadata → processing → ready → uploaded.
running	Whether the pipeline is actively churning.
progress	0–100 % across the batch's items.
proc	Per-item pipeline outcome during a run: queued / running / done / failed.
failSet	Items that failed the current run (targets for rerun).
cobissId	Optional batch-wide COBISS prefill ID.
parents	Batch-level parent links applied to all items at setup.
publish	draft or record — how items are published.
visibility	public, private, or hidden.
?
Decision · where batches live
Batches read as local, operator-side working state (a grouping the cataloguer manages), not catalogue objects. Decide whether the backend needs to persist batches at all, or only receive the final per-item uploads. This affects multi-machine and crash-recovery behaviour.

Parent record (serial / collection)
A catalogue record an item can be filed under — a Serial (e.g. the newspaper Prosvjeta) or a Collection. Parents carry shared bibliographic fields that copy down into their child items.

Field	Meaning
id / name	e.g. NB-9021 · "Prosvjeta (serial)".
type	Serial or Collection.
canPassData	Whether it holds inheritable shared fields (Serials do; the sample Collection does not).
passesData	Whether it is currently the field source. At most one linked parent passes data at a time.
inherit	The shared field values pushed to children: e.g. serialTitle, publisher, place, lang, subject.
Metadata field value
Every catalogue field on an item stores not just a value but where it came from (its provenance), so the UI can label it and resolve conflicts. Values: value (string, array for multi-value, or date), provenance ∈ {COBISS parent user}, and sourceParentId when it came from a specific parent.

03Item lifecycle & states
An item's state is derived, not stored — computed from its flags and stage statuses every render. The backend does not need to store the state name, but it must store the underlying facts (uploaded, reupload, stage outcomes, batch membership) so the same state can be recomputed. Derivation order (first match wins):

State	Condition	Meaning to operator
Uploaded	uploaded flag set, or the upload stage is done	Published to catalogue; source moved to /processed.
In progress	Belongs to a batch that is not yet uploaded	Locked to that batch; open the batch to work on it.
Needs re-upload	reupload flag set	Already published but changed since; must be pushed again.
Stopped	Any pipeline stage is failed	Processing halted on an error; needs a rerun/fix.
To process	none of the above	Fresh scan waiting to be batched.
The left-rail connection dot mirrors a separate axis entirely — backend reachability (Connected / Offline), independent of any item state.

04End-to-end flow
The happy path from a scanned folder to a published catalogue record:

00
First run
Set the two folder roots and connect the backend.
01
Scans arrive
TIFF folders land in /unprocessed; appear in Overview as To process.
02
Select & batch
Pick items of one state, Create batch → moves to In progress.
03
Setup
Batch-wide COBISS, parents, publish & visibility.
04
Metadata
Per-item fields; validate required fields.
05
Process
Run PDF · Thumbnail · OCR · Metadata per item.
06
Upload
Publish the batch; assign catalogue IDs; move to /processed.
07
Sync
Periodically pull catalogue metadata back into the archive.
Single items short-circuit: opening one To process item creates a one-item batch and drops straight into Metadata (no Setup step). Multi-item batches start at Setup.

05Screen-by-screen behaviour
Left rail (always present)
Four destinations — Overview, Batches (badge = count of unfinished batches), Sync, Settings — plus a live connection status footer showing the backend host and Connected/Offline.

Overview
The arrivals table and the entry point to batching.

Segmented filter with live counts: All · Unprocessed · In progress · Stopped · Needs re-upload · Done.
Selection is state-scoped. Only Unprocessed, Stopped, Needs re-upload, and Done filters allow row selection (because a batch groups one type). All and In progress are non-selectable; an info line explains why, and In progress rows show a lock icon.
Search filters by title, folder, or catalogue ID.
Per-stage indicators per row: five dots/spinners for PDF, Thumbnail, OCR, Metadata, Uploaded, plus a coloured state pill.
Row click toggles selection (selectable filters) or opens the item (otherwise). The ⋯ menu offers Open (as) batch and Open in Explorer (opens the local folder in the OS file manager).
Create batch appears when items are selected: it creates a batch and moves the selection to In progress.
First-run empty state: a welcome card prompting folder + backend setup when nothing is configured.
↦
Backend need · item inventory
The Overview needs a source of truth for the item list, each with folder, source count, level, per-stage status, backend ID and flags. See §12 (A). Ingestion itself (watching /unprocessed) is a client/Tauri job — see the Decision in §06.

Batches
Cards for every unfinished batch (the badge count). Each card shows the batch number, status pill (Setup/Metadata/Processing/Ready/Uploaded — with a spinner while running), created time, item count, a three-step indicator (Setup → Metadata → Process) and a progress bar. Clicking opens the batch at the right tab for its stage. A + New from Overview shortcut and a no-batches empty state round it out.

Batch work — three tabs
A batch header (number, status, READ-ONLY badge once uploaded, "all changes saved" indicator) sits above three tabs whose availability tracks the batch stage: Setup (always), Metadata (once past setup), Processing & Upload (once processing has begun / is ready / uploaded).

Tab 1 · Setup (multi-item batches)
Batch-wide defaults applied to all items, each still overridable later:

Prefill from COBISS — a batch COBISS ID that prefills every item, overriding parent-inherited fields.
Parent records — link one or more serials/collections; choose which one passes data (the single source whose shared fields copy down). Collections can be linked but do not pass data.
Publish as — Draft / Record.  Visibility — Public / Private / Hidden.
Next: Metadata applies the chosen parent's shared fields to empty item fields (provenance parent) and, if a batch COBISS ID is set, applies COBISS to all fields (provenance COBISS), then advances the batch to the metadata stage.
Tab 2 · Metadata (per item)
Item navigator — dropdown + progress ("Item 2 of 5 · 3/5 ready"), per-item ready/incomplete/untouched status, with a level pill (Main vs Child record).
Files strip — the six files per item and their live state: source TIFFs (kept local), document_archive.pdf, document.pdf, thumbnail.png, ocr.txt, metadata.json.
Prefill from COBISS per item — enter a CG-ID, Get data fills the fields. If a field already holds a user value, an overwrite prompt offers "Overwrite all" vs "Keep mine, fill empties".
Parent records per item — link parents; empty fields fill from the data-passing parent.
Fields — the catalogue form for this item's schema (Main vs Child). Each field shows required markers, a provenance tag, and — when more than one linked parent could supply it — a per-field source picker (choose which parent, or Manual entry). Validation blocks Next / Go to processing until required fields are filled.
Tab 3 · Processing & Upload
Control strip — a summary line, the batch progress bar, and the primary action that changes with stage: Start processing → (while running) live counts → Rerun all failed if any failed → Upload batch when ready.
Per-item list — each item's live pipeline status (queued/running/done/failed) with its error message and a per-item Rerun on failure.
Start is blocked if another batch is already processing (only one at a time).
Upload summary — the batch's publish target, visibility, and the file set that will be pushed (source TIFFs stay local).
After upload the batch is READ-ONLY and shows a published confirmation.
Sync
Pulls catalogue metadata from the backend into the local archive (keeps already-archived records current). Shows source host, last-synced and next auto-sync time (every 6 h), a Sync now action with live progress and stage text, four stat tiles (records checked, metadata updated, up-to-date, missed) and a recent-syncs log with per-run status (including warnings like a backend timeout).

Settings — Configure
Folder locations — /unprocessed and /processed roots, each with Browse and a validity status.
Backend connection — API base URL (default https://api.nbcg.me) and API access token (stored as a secret, masked by default, Show/Hide + Paste).
Test connection — verifies the token and reports the authenticated identity and access level, or a 401.
Theme (Light/Dark/System), Refresh metadata schema from the backend, and the app version.
Settings — Data (naming rules, read-only)
Reference-only display of the fixed filename convention — see §10. Nothing here is editable; it documents how the backend/app name archive PDFs.

06The processing pipeline
The core of what a backend (or local worker) must actually do. For each item, five stages run in order; each has status pending → running → done | failed (plus queued while a batch run is scheduled).

Stage	Input → output	Notes
PDF	Source TIFFs → document_archive.pdf (archival master) and document.pdf (web-ready)	Two derivatives from one source set. Sample failure: "source resolution too low (72 dpi)".
Thumbnail	First page → thumbnail.png	Cover/first-page preview.
OCR	Pages → ocr.txt (full text)	Sample failure: "OCR engine crashed on page 14 — corrupt image stream". Language likely relevant (Cyrillic/Latin).
Metadata	Catalogue fields → metadata.json	Only "done" once required fields validate.
Uploaded	All outputs → backend	Publishes; assigns backendId; moves folder to /processed.
Source TIFFs stay local — they are never uploaded. Only the four derivatives + metadata are pushed.

Concurrency: a global rule enforces one batch processing at a time. Starting or rerunning while another batch runs is blocked with a message. Rerun exists at two grains: a single failed item, or all failed items in the batch.

?
Decision · where the pipeline runs
The UI (files kept local, "Open in Explorer", per-file generation, one-at-a-time) reads like local processing on the workstation (Tauri invoking local tools for TIFF→PDF, thumbnailing, OCR), with the backend involved only at upload. But it could equally be server-side jobs the client submits and polls. This is the single biggest architecture decision. It determines whether the backend needs a job runner + status API, or just an ingest/upload API.

↦
Backend need · if server-side processing
Then required: submit-processing for a batch/item, per-item/stage status polling (or push), retrieval of generated derivatives, rerun endpoints, and a server-side single-flight lock so only one batch runs. If client-side, the backend only needs the upload of §09.

07Metadata & cataloguing
The schema is backend-driven
Field definitions come from the backend and are refreshable in Settings. The app renders whatever the schema says; it must not hard-code fields long-term. Two schemas exist, chosen by item level:

Main record	Child record (serial issue)	Notes
Title req	Serial title req · parent	Child titles come from the parent serial.
Author	Publisher · parent	"parent" fields are the ones a parent can pass down. "issue" fields identify the specific issue.
Publication year	Place of publication · parent
Language (enum)	Language · parent (enum)
Place of publication	Subject · parent (multi)
Publisher	Volume / Year req · issue
Subject (multi)	Issue number req · issue	
Physical description	Issue date req · issue (date)	
Note		
Field types: text, enum (single choice), multi (tag list), date. The language enum currently offers: Montenegrin, Serbian, Church Slavonic, Italian, Russian.

Provenance & conflict
Each field remembers whether its value came from COBISS, a parent, or the user. This drives the coloured tags, the per-field source picker, and the COBISS overwrite prompt. When applying COBISS or parent data, empty fields fill silently; user-entered fields prompt before overwrite.

Parent inheritance & per-field source
Linking a parent that "passes data" copies its inherit fields into the item's empty matching fields, tagged parent.
Only one parent passes data at a time; switching the source is a one-click toggle.
When two or more linked parents could supply the same field, a per-field picker lets the cataloguer choose which parent's value to use, or switch that field to Manual.
Validation
Required fields (marked above) must be non-empty (a multi-value field must have ≥1 tag) before the item counts as "ready". The batch cannot move to processing until every item is ready; the UI jumps to the first incomplete item and names how many remain.

↦
Backend need · schema service
Serve the field schema for main and child levels: field key, label, type, enum options, required flag, and which fields are parent-inheritable / issue-identifying. Versioned, so "Refresh schema" is meaningful. The archived metadata.json shape follows from this schema.

08Integrations: COBISS & Sync
COBISS prefill
COBISS is the shared Montenegrin union bibliographic system. Given a COBISS.CG-ID (e.g. 24512006) the app fetches a bibliographic record and maps it onto the schema fields (title, author, year, language, place, publisher, subject, physical description, note). Used two ways: batch-level (prefill all items at Setup) and per-item (Get data in Metadata). Conflicts with user-entered values raise the overwrite prompt.

↦
Backend need · COBISS lookup
A lookup by CG-ID returning a record mapped to the archive schema. Decision whether the client calls COBISS directly or proxies through api.nbcg.me (proxy is cleaner for auth, rate limits, and field mapping).

Metadata Sync
A pull from the backend into the local archive that refreshes catalogue metadata on already-archived records. Runs on demand and automatically (every 6 h). Reports records checked, updated, up-to-date and missed, and logs each run with a status and duration (warnings surface e.g. backend timeouts).

↦
Backend need · sync source
An endpoint returning catalogue metadata for the archive's records — ideally incremental ("changed since <timestamp>") to keep runs fast — keyed by the catalogue backendId. Sync must reconcile against local records and report counts + per-run outcome.

09Publishing & upload
Upload is only available when a batch is Ready (all items processed, no failures). Uploading:

Pushes each item's four derivatives + metadata to the backend.
Publishes according to the batch's publish target — draft (saved, not live) or record (a live catalogue record) — and visibility — public / private / hidden.
Assigns each item a catalogue backendId (e.g. NB-10442) if it doesn't have one.
Moves the source folder from /unprocessed to /processed, marks the item Uploaded, clears any re-upload flag.
Re-upload: a published item can be flagged Needs re-upload (files/metadata changed after publishing) and pushed again — so upload must be idempotent/updating against an existing backendId.

↦
Backend need · ingest / publish
Create-or-update a catalogue item from the derivatives + metadata, honouring publish target, visibility and parent links, and returning the assigned catalogue ID. Must support updating an existing record for re-upload. Parent links must resolve to real catalogue parents.

10Naming rules (fixed)
Every archive PDF is named by a fixed convention, shown read-only in Settings → Data:

Pattern: PREFIX _ BASE [ _ SUFFIX ] .pdf, parts joined by underscore.
Prefix: NBCG. Base identifier, one of: COBISS ID, Signature, Accession no., or Title slug. Suffix: optional.
Example: NBCG_124357888.pdf.
Multi-page items append a running, unpadded page number: …_1.pdf, …_2.pdf, … _10.pdf.
?
Decision · who owns naming
Confirm whether the app or the backend generates the canonical filename, and which base identifier is authoritative when e.g. no COBISS ID exists. The rule is fixed but its inputs (COBISS/signature/accession/title) must be reliably available at upload.

11Configuration & connection
Setting	Behaviour / backend touchpoint
Folder roots	Local paths for /unprocessed and /processed, with a validity check. Client/Tauri concern; backend not involved unless ingestion moves server-side.
API base URL	Backend host, default https://api.nbcg.me.
Access token	Bearer secret, stored securely, masked in UI. Sent on every backend call.
Test connection	Validates token → returns authenticated identity (email) and access level (write), or 401.
Refresh schema	Re-fetches the metadata schema (§07).
Theme / version	Local only.
↦
Backend need · auth & identity
Token-based auth on every endpoint; a verify/identity endpoint returning the caller's email and access level (to power Test connection and to gate write actions like upload).

12Backend requirements (consolidated)
Everything the client needs from the server, grouped. Endpoint names are proposals to react to, not a fixed contract.

#	Capability	What it must do
A	Item inventory	List/serve items with folder, source count, level, per-stage status, backend ID and flags — or confirm this is purely local and only §H matters. Stable IDs for Sync + re-upload.
B	Auth & identity	Bearer-token auth on all calls; verify endpoint → email + access level. Powers Test connection and write gating.
C	Metadata schema	Versioned field definitions for main + child levels (key, label, type, enum options, required, parent-inheritable, issue-identifying). Refreshable.
D	Parent search	Search serials & collections; return id, name, type, and inheritable shared fields. Feeds parent linking + per-field source.
E	COBISS lookup	Fetch a bibliographic record by CG-ID, mapped to the schema. Direct or proxied (decision).
F	Processing	If server-side: submit a batch/item for processing, poll per-item/stage status, fetch derivatives, rerun, and enforce one-run-at-a-time. If client-side: not needed.
G	Sync source	Return catalogue metadata for archive records, incrementally ("changed since"), keyed by backend ID; report counts.
H	Ingest / publish	Create-or-update a catalogue item from derivatives + metadata + parent links, honouring publish target & visibility, returning the catalogue ID. Idempotent for re-upload.
13What is mocked vs. real
So you know exactly what still needs building — the prototype fakes all of the following:

Area	Currently faked as…
Item list	A fixed seed of ~17 sample items; no folder watching or real ingestion.
Processing	A timer advances one item every ~0.6 s; the last item of a multi-item batch is deliberately failed to demo errors. No real TIFF→PDF / OCR / thumbnailing.
COBISS	Returns one hard-coded record (Njegoš, Gorski vijenac) after a fake 0.9 s delay, regardless of the ID entered.
Parents	A small sample pool of serials/collections with canned inherit fields; "search" doesn't query anything.
Upload	Flips flags locally and assigns a random NB-### ID; nothing is transmitted.
Sync	A progress timer with static stat tiles and a canned log.
Auth	Token is hard-coded; Test connection returns success unless in first-run state (then a canned 401).
Folders / schema refresh / Open in Explorer	Browse, Refresh schema and Paste are inert; Explorer just shows a toast.
14Open decisions
The prototype is intentionally silent on these — resolve them before backend build:

Where does the pipeline run — local workstation (Tauri) or server-side jobs? (§06) Biggest determinant of the API surface.
Are batches server-persisted or local-only working state? (§02) Affects recovery and multi-machine use.
Does the backend own the item inventory, or does the client discover items purely from the local filesystem and only push at upload? (§05/§12-A)
COBISS access — direct from client, or proxied through the backend? (§08)
Concurrency scope — is "one batch at a time" per workstation, per user, or global across the institution? (§06)
Catalogue ID scheme — who mints NB-… IDs, and the exact format/uniqueness guarantees. (§09)
Re-upload semantics — full replace vs. metadata-only update of a published record. (§09)
Derivative storage — where the archival + web PDFs, thumbnails and OCR text physically live, and whether the archival master is ever transmitted. (§06/§09)
Schema authority & naming inputs — versioning of the field schema, and guaranteeing a base identifier for filenames when no COBISS ID exists. (§07/§10)
NBCG Archive — functional & backend specification · derived from prototype v1.4.0 · for backend scoping
