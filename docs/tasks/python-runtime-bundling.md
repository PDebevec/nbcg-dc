# Python runtime bundling — design notes for Epic 11's "Bundle Python" item

> Design only — nothing here is implemented. This is the write-up for
> [11-packaging-and-distribution.md](11-packaging-and-distribution.md)'s
> **Bundle Python** checklist line, expanded because that epic is currently
> unstarted (every box unchecked) and "sidecar strongly preferred" by itself
> isn't enough to build from. Written 2026-09-01, prompted by a real local
> `ModuleNotFoundError: No module named 'numpy'` — see "What this session
> found" below, all of it verified against the machine and PyPI, not assumed.

## Problem statement

Today, per `core::python`'s own doc comment
([`src-tauri/src/core/python/mod.rs:1-15`](../../src-tauri/src/core/python/mod.rs)):

> "Python invocation strategy (Epic 06, dev slice): system Python on `PATH`.
> No sidecar bundling... The script paths below are resolved at *compile*
> time via `CARGO_MANIFEST_DIR`... explicitly not relocatable/packageable."

`spawn_python` (lines 200-211) tries the bare command names `python` then
`py`, relying entirely on whatever the OS resolves them to. That's a
reasonable dev-phase choice — running from source, on a machine someone just
set up, PATH-based lookup is simplest. It falls apart the moment this ships
as an installer for library staff: nothing guarantees Python is present at
all, that it's a compatible version, or that `py/requirements.txt` is
installed. The `numpy` error this doc grew out of is exactly that failure
mode, just hit early (a dev machine) and for a shallow reason (Python was
there, one pip install was missing) rather than the way it'll hit a staff
machine (no Python at all).

## What this session found (verified, not assumed)

Fixing this dev machine's `numpy` gap surfaced two things worth recording
here because they constrain any future bundling design, not just this one
install:

1. **`paddlepaddle` has no Windows wheel for Python 3.14.** Checked directly
   against PyPI: `paddlepaddle` 3.3.1's release files
   (`pypi.org/pypi/paddlepaddle/3.3.1/json`) are `cp39`/`cp310`/`cp311`/
   `cp312`/`cp313` only, on Windows and every other platform — no `cp314`
   wheel exists at all. This machine's default `python` (the one `spawn_python`
   resolves to) is 3.14.2, so `pip install paddlepaddle` fails outright
   there (`ERROR: Could not find a version that satisfies the requirement
   paddlepaddle (from versions: none)`) — not a version pin issue, a real
   "doesn't exist yet" gap. **Whatever Python version Epic 11 vendors for
   the bundled runtime must be ≤3.13** until PaddlePaddle publishes a 3.14
   build (worth re-checking `pypi.org/pypi/paddlepaddle/json` when this epic
   actually starts — it may have caught up by then).
2. **`paddleocr` itself does *not* hard-require `paddlepaddle` at import
   time.** `from paddleocr import PaddleOCR` imports cleanly with `paddleocr`
   + its declared deps (`paddlex`, `aiohttp`, `PyYAML`, `requests`,
   `typing-extensions`) installed and `paddlepaddle` absent — confirmed
   directly on this machine, and it's why `py/tests/test_ocr_platform.py`'s
   `test_ocr_module_requires_paddleocr` (`py/tests/test_ocr_platform.py:43-48`)
   now passes here even without `paddlepaddle`. The actual inference call
   (`PaddleOCR(...)` → `.predict()`/`.ocr()`) is where the `paddle` backend
   would actually be needed — untested here, since that also needs Poppler
   (below). Don't mistake "the script imports" for "OCR runs."
3. **This machine already has a `paddlepaddle`-compatible Python.** Python
   3.13 is installed at `C:\Python313\python.exe`, registered with the `py`
   launcher (itself present at
   `%LOCALAPPDATA%\Programs\Python\Launcher\py.exe` but not on `PATH`) —
   confirmed via `py -0p`. Nobody wired anything to it; it's just there. Two
   different uses for this fact:
   - **Per-developer workaround**, if someone needs a real OCR run before
     Epic 11 ships: `C:\Python313\python.exe -m pip install -r
     py\requirements.txt` (this *does* find a `paddlepaddle` wheel), then
     either add the `py` launcher to `PATH` and change `spawn_python` to
     call `py -3.13` for `ocr.py` specifically, or point a project-local
     venv (see below) at that interpreter. Not done in this session — it's
     a real code change (see "Interpreter selection" below), not a pip
     install, and wasn't the agreed scope.
   - **Confidence for the bundling design**: a Python 3.13 build genuinely
     works with the full stack on Windows today — the vendoring strategy
     below isn't picking an untested version number, it's picking the one
     already proven to resolve on this exact machine.
4. **Poppler remains untouched, deliberately.** `pdf2image` needs Poppler's
   binaries on `PATH` for real PDF→image conversion; that's a system binary,
   not pip-installable (`py/requirements.txt:24-28`, `py/README.md:36-38`).
   Left as a manual step here rather than editing this machine's `PATH` —
   see "Manual Poppler setup," a few sections down, for the exact steps
   whenever someone wants a live OCR run locally.

None of this blocks writing the bundling design below — if anything it
sharpens it: the design needs an explicit Python-version pin (≤3.13, subject
to re-checking PaddlePaddle's releases) and Poppler bundling was already
going to be needed regardless.

## Architectural constraint to respect

`core/` is deliberately Tauri-free — `docs/06-native-core-and-dev-setup.md:154`:
*"`core/` contains **no Tauri types**, which is the only reason it can be
unit-tested without a webview."* Resolving a bundled resource directory at
runtime needs `tauri::Manager::path().resource_dir()`, which is a Tauri
type — so that resolution cannot move into `core::python` itself without
breaking the exact property that keeps `core::jobs`/`core::python` testable
by direct call (`src-tauri/tests/core_jobs.rs`) instead of through Tauri's
webview-dependent test harness (which `docs/06-native-core-and-dev-setup.md:138-141`
records was tried and abandoned here).

The fix is the same shape as `config_dir` today: `commands/` (which already
has `AppHandle`/`state` access) resolves the path and hands it down as
plain data. Concretely: `spawn_python` and its callers
(`run_web`/`run_ocr`/`run_split_spreads`/`run_pdf_derive`, all in
`core/python/mod.rs`) gain an optional runtime override — an interpreter
path plus extra `PATH`/env entries (for the vendored Poppler `bin/`) — that
`commands/jobs.rs` builds once from `app.path().resource_dir()` and threads
through, alongside the `cancel: &CancelToken` parameter already threaded
everywhere. When the override is `None` (every existing test), behavior is
exactly what it is today — bare `python`/`py` on `PATH` — so none of the 24
tests in `core_jobs.rs` or `python`'s own unit tests need to change for this
alone.

## Recommended distribution strategy

A portable/embeddable Python build — **`python-build-standalone`**
(indygreg's, the build `uv`/`rye`/`pdm` all use for exactly this: fully
self-contained, includes pip, no installer/registry side effects, real
Windows `.zip` releases per version) — pinned to **3.13** per the
`paddlepaddle` constraint above, vendored under `src-tauri/binaries/python/`.
`py/requirements.txt` gets installed into *that* build's site-packages at
vendor/build time, not on each staff machine — staff never run `pip`.

Rejected alternative: python.org's own "embeddable package" zip. It's
smaller, but ships with `site-packages` disabled by default (needs editing
its `._pth` file) and no `pip` — extra steps `python-build-standalone`
already solves.

### Vendoring step

A build script — e.g. `scripts/vendor-python.ps1` — that:

1. Downloads the pinned `python-build-standalone` 3.13 Windows release into
   `src-tauri/binaries/python/`.
2. Runs `<vendored>\python.exe -m pip install -r py\requirements.txt
   --target <vendored>\Lib\site-packages`.
3. Downloads a portable Poppler-for-Windows release (the same one
   `py/requirements.txt:26-27` already points a human at) into
   `src-tauri/binaries/poppler/`.

Hooked into `beforeBuildCommand` (or a dedicated release step once CI
exists — see below), and **never committed to git**: `paddlepaddle` alone is
hundreds of MB, and the whole point is this gets fetched at build time, not
carried in the repo. `.gitignore` should gain `src-tauri/binaries/` (mirrors
the existing `.venv/`/`venv/` entries already there for the same reason —
this repo already treats "a real Python install" as something that doesn't
belong in git).

### Tauri wiring

`tauri.conf.json`'s `bundle.resources` ships `src-tauri/binaries/python/` +
`src-tauri/binaries/poppler/` + `py/` inside the installer (today's
`bundle` block has none of `resources`/`externalBin` set — this is new).
`commands/jobs.rs` resolves `app.path().resource_dir()` at startup and
builds the runtime override described above: interpreter =
`<resource_dir>/binaries/python/python.exe`, extra `PATH` entry =
`<resource_dir>/binaries/poppler/bin`. The Poppler `PATH` entry is added to
the **spawned child process's** environment only (`Command::envs`, already
how `spawn_and_wait` builds its `Command`) — never the user's persistent
system `PATH`. That's a deliberate improvement over what dev setup asks a
person to do by hand today, and it's the reason this session didn't edit
this machine's `PATH` for Poppler either — the shipped app should need
neither a bundled-Python PATH entry nor a Poppler one.

### OCR model assets

PaddleOCR downloads its detection/recognition models on first real run.
Needs a product decision, not just engineering: pre-bundle the model cache
as another resource (bigger installer, works offline immediately) vs. a
first-run download-with-progress UI (smaller installer, needs a network
connection and UI work). Flagged here, not decided — `docs/tasks/11-packaging-and-distribution.md:15-16`
already lists this as its own checklist line.

### CI / reproducible builds

No CI exists in this repo today (no `.github/workflows` or equivalent) —
confirmed, not assumed. Whatever eventually produces a signed release build
(a future CI pipeline, or a documented manual release runbook in the
meantime) has to run the vendoring step first. Since nothing automated
exists yet, this is worth deciding alongside — not necessarily before —
the rest of this epic.

### Manual Poppler setup (for a live OCR run before any of this exists)

Unrelated to the bundling design above, but the concrete steps for anyone
who wants `ocr.py` to actually run against a PDF today, per
`py/requirements.txt:24-28`:

1. Download a Windows Poppler build — the community releases at
   <https://github.com/oschwartz10612/poppler-windows> (the same link
   `requirements.txt` already cites).
2. Extract it anywhere; note the extracted `Library/bin` (or `bin`,
   depending on the release layout) folder.
3. Add that folder to `PATH` (user or system) and open a new shell.
4. `pdf2image.convert_from_path(...)` (and therefore `ocr.py`) can then find
   `pdftoppm`/`pdftocairo` at runtime.

This is a genuine, persistent system-PATH change — which is exactly why it
wasn't done automatically this session; do it deliberately, on a machine
where you actually intend to run OCR by hand.

## Definition of done

Epic 11's own existing acceptance bullet
(`docs/tasks/11-packaging-and-distribution.md:58-59`) is the real test:
*"A signed (if possible) Windows installer produces a working app on a
clean machine with no manual Python setup... the full loop — batch →
PDF/thumbnail/OCR → metadata → upload — works in the packaged build."* A
clean VM with no Python, no Poppler, and no PaddlePaddle-compatible
interpreter preinstalled is the actual proof, not a dev machine that
happens to already have most of the stack (like this one did).

## Out of scope for this doc

Everything above is design. None of it is implemented — no
`scripts/vendor-python.ps1`, no `tauri.conf.json` resources/`externalBin`
entries, no `core::python` interpreter-override parameter, no
`src-tauri/binaries/` `.gitignore` entry. That's Epic 11 execution.
