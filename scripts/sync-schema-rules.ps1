<#
.SYNOPSIS
    Copies the backend's metadata-schema-v2 rule evaluator, its conformance
    fixture and a snapshot of GET /api/schema/v2/record into src/domain.

.DESCRIPTION
    src/domain/schemaRules.ts is a VERBATIM copy of
    backend/src/modules/schema/rules/evaluate.ts — never edit it here. Change
    the backend file, then re-run this script. The schema snapshot is only
    used by src/domain/schemaRules.test.ts (the fixture's `record` and `check`
    cases run against the live field list) and by the test builders in
    src/domain/schema.fixture.ts.

.PARAMETER Backend
    The nbcg repo. Defaults to the WSL working copy.

.PARAMETER ApiBase
    The backend the schema snapshot is fetched from.
#>
param(
    [string]$Backend = "\\wsl.localhost\Ubuntu\home\jernej\nbcg",
    [string]$ApiBase = "http://localhost:3000/api"
)

$ErrorActionPreference = "Stop"

$rules = Join-Path $Backend "backend\src\modules\schema\rules"
$domain = Join-Path $PSScriptRoot "..\src\domain"

Copy-Item (Join-Path $rules "evaluate.ts") (Join-Path $domain "schemaRules.ts") -Force
Copy-Item (Join-Path $rules "conformance.json") (Join-Path $domain "schemaRules.conformance.json") -Force
Invoke-WebRequest "$ApiBase/schema/v2/record" -UseBasicParsing -OutFile (Join-Path $domain "schemaRules.schema.json")

Write-Host "Copied evaluate.ts, conformance.json and the v2 schema snapshot into src/domain."
