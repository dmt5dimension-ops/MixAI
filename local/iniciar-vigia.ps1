# Inicia o vigia sem perder o caminho do script quando a pasta do projeto tem espacos.
param(
  [Parameter(Mandatory)][string]$ScriptVigia,
  [Parameter(Mandatory)][ValidateSet('BelowNormal', 'Normal')][string]$Prioridade
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ScriptVigia -PathType Leaf)) { throw "Vigia nao encontrado: $ScriptVigia" }
$argumentos = "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptVigia`" -Prioridade $Prioridade"
Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList $argumentos
