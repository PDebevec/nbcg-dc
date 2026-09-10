<#
.SYNOPSIS
    Vendors a self-contained Python 3.13 runtime + py/requirements.txt into
    src-tauri/binaries/python/, so the packaged app needs no system Python
    (Epic 11, docs/tasks/python-runtime-bundling.md).

.DESCRIPTION
    Fetches a python-build-standalone "install_only" build (the same one
    uv/rye/pdm use: self-contained, includes pip, no installer/registry side
    effects - see https://github.com/astral-sh/python-build-standalone),
    extracts it, and pip-installs py/requirements.txt into its own
    site-packages. Run by Tauri's `beforeBundleCommand` before every real
    `tauri build`; safe to run by hand too.

    No Poppler step: ocr.py moved to pypdfium2 (self-contained, no system
    dependency) for PDF rasterization, so nothing in py/ needs Poppler
    anymore.

.PARAMETER Force
    Re-fetch and re-extract even if src-tauri/binaries/python/python.exe
    already exists.
#>
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# Pinned deliberately, not "latest" - a vendoring script that silently
# tracks a moving release could ship a different Python build on every run.
# python-build-standalone tags releases by date; bump this (and
# $PythonVersion if it changed) after checking
# https://github.com/astral-sh/python-build-standalone/releases for a
# current 3.13.x build. Must stay <=3.13: paddlepaddle (py/requirements.txt)
# has no Windows wheel for 3.14 as of this writing - re-check
# https://pypi.org/pypi/paddlepaddle/json before ever bumping the minor
# version.
$PythonVersion = "3.13.15"
$PythonBuildTag = "20260901"
$PythonAsset = "cpython-$PythonVersion+$PythonBuildTag-x86_64-pc-windows-msvc-install_only.tar.gz"
$PythonUrl = "https://github.com/astral-sh/python-build-standalone/releases/download/$PythonBuildTag/$PythonAsset"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BinariesDir = Join-Path $RepoRoot "src-tauri/binaries"
$VendorDir = Join-Path $BinariesDir "python"
$PythonExe = Join-Path $VendorDir "python.exe"
$RequirementsPath = Join-Path $RepoRoot "py/requirements.txt"

if ((Test-Path $PythonExe) -and -not $Force) {
    Write-Host "vendor-python: $PythonExe already exists, skipping (use -Force to re-fetch)."
    exit 0
}

if ($Force -and (Test-Path $VendorDir)) {
    Remove-Item -Recurse -Force $VendorDir
}
New-Item -ItemType Directory -Force -Path $BinariesDir | Out-Null

Write-Host "vendor-python: downloading $PythonAsset ..."
Write-Host "vendor-python: this needs real network access and can take a while - not hung, just slow."
$archivePath = Join-Path $env:TEMP "$PythonAsset"
Invoke-WebRequest -Uri $PythonUrl -OutFile $archivePath

Write-Host "vendor-python: extracting into $BinariesDir ..."
# Explicit path to Windows' own bsdtar (System32\tar.exe, shipped since
# Windows 10 1803), not a bare `tar` call: on a machine with Git for Windows
# installed, its bundled Unix `tar` (usr\bin\tar.exe) can resolve first on
# PATH - and GNU tar parses a leading "C:" as a "user@host:path" remote-tar
# spec, not a Windows drive letter, so it tries to open an SSH connection to
# a host named "C" instead of reading the local file. Confirmed the hard way.
$nativeTar = Join-Path $env:SystemRoot "System32\tar.exe"
# The install_only tarball's top-level entry is already named "python/", so
# extracting straight into src-tauri/binaries/ lands it at .../binaries/python/.
& $nativeTar -xzf $archivePath -C $BinariesDir
if (-not (Test-Path $PythonExe)) {
    throw "vendor-python: expected $PythonExe after extraction but it isn't there - " +
          "the archive's layout may not match what this script assumes; inspect $BinariesDir by hand."
}
Remove-Item $archivePath

Write-Host "vendor-python: sanity-checking the interpreter ..."
$reportedVersion = (& $PythonExe --version) -replace "^Python\s+", ""
if ($reportedVersion.Trim() -ne $PythonVersion) {
    throw "vendor-python: expected Python $PythonVersion but got '$reportedVersion' - bad download/extraction?"
}

Write-Host "vendor-python: installing py/requirements.txt into the vendored interpreter ..."
Write-Host "vendor-python: paddlepaddle alone is hundreds of MB - this step is genuinely slow, not stuck."
& $PythonExe -m pip install --quiet -r $RequirementsPath
if ($LASTEXITCODE -ne 0) {
    throw "vendor-python: pip install -r py/requirements.txt failed (exit $LASTEXITCODE)"
}

Write-Host "vendor-python: done. Vendored interpreter: $PythonExe"
