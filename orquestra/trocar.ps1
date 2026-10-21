# Troca manualmente quem está sem cota.
# Uso: powershell -ExecutionPolicy Bypass -File orquestra\trocar.ps1 claude
#      powershell -ExecutionPolicy Bypass -File orquestra\trocar.ps1 normal
param([Parameter(Mandatory)][ValidateSet('claude', 'codex', 'local', 'normal')][string]$Quem)

$ErrorActionPreference = 'Stop'
$chamar = Join-Path $PSScriptRoot 'chamar.js'
if ($Quem -eq 'normal') {
  & node $chamar normal
} else {
  & node $chamar sem-cota $Quem
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node $chamar quem
exit $LASTEXITCODE
