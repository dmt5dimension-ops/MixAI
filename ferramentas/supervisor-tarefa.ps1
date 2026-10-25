# Registra (ou remove) a tarefa agendada do Windows que mantém o supervisor (orquestra/fofoqueiro.js) rodando.
# Inicia no login, reinicia se cair e grava a saída num log próprio em D:\MixAI-coordenacao (não é o canal).
# Uso: powershell -ExecutionPolicy Bypass -File ferramentas\supervisor-tarefa.ps1
#      powershell -ExecutionPolicy Bypass -File ferramentas\supervisor-tarefa.ps1 -Remover
param(
  [switch]$Remover,
  [string]$PastaLog = 'D:\MixAI-coordenacao'
)

$ErrorActionPreference = 'Stop'
$nome = 'MixAI-Supervisor'

if ($Remover) {
  if (Get-ScheduledTask -TaskName $nome -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $nome -Confirm:$false
    Write-Host "Tarefa $nome removida."
  } else {
    Write-Host "Tarefa $nome não existe."
  }
  exit 0
}

$node = (Get-Command node -ErrorAction Stop).Source
$raiz = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script = Join-Path $raiz 'orquestra\fofoqueiro.js'
if (-not (Test-Path $script)) { throw "Não achei $script" }
New-Item -ItemType Directory -Force -Path $PastaLog | Out-Null
$log = Join-Path $PastaLog 'supervisor-tarefa.log'

# cmd /c só para redirecionar a saída para o log; o código de saída do node é o da tarefa.
$argumentos = "/c `"`"$node`" `"$script`" >> `"$log`" 2>&1`""
$acao = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $argumentos -WorkingDirectory $raiz
$gatilho = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$config = New-ScheduledTaskSettingsSet `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $nome -Action $acao -Trigger $gatilho -Settings $config -Principal $principal -Force | Out-Null
Write-Host "Tarefa $nome registrada. Inicia no login, reinicia se cair. Log: $log"
Write-Host "Para iniciar agora: Start-ScheduledTask -TaskName $nome"
