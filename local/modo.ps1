# Troca o modelo local entre o modo dia (pouco uso do PC) e o modo noite (força total).
# Uso: powershell -ExecutionPolicy Bypass -File local\modo.ps1 dia
#      powershell -ExecutionPolicy Bypass -File local\modo.ps1 noite
# O Claude sempre chama o modelo pelo nome "mixai-local"; este script só muda o que está por trás dele.
param([Parameter(Mandatory)][ValidateSet('dia', 'noite')][string]$Modo)

$ErrorActionPreference = 'Stop'
$config = (Get-Content (Join-Path $PSScriptRoot 'modos.json') -Raw | ConvertFrom-Json).$Modo

# Limites do Ollama (valem depois de reiniciar).
$variaveis = @{
  OLLAMA_CONTEXT_LENGTH    = "$($config.contexto)"
  OLLAMA_KEEP_ALIVE        = $config.manterNaMemoria
  OLLAMA_MAX_LOADED_MODELS = '1'
  OLLAMA_NUM_PARALLEL      = "$($config.agentesMax)"
}
foreach ($v in $variaveis.GetEnumerator()) {
  [Environment]::SetEnvironmentVariable($v.Key, $v.Value, 'User')
  Set-Item "env:$($v.Key)" $v.Value
}

# Reinicia o Ollama para ele ler os limites novos.
# O llama-server sobra aberto segurando a placa de vídeo se não for fechado junto.
Stop-Process -Name 'ollama app', 'ollama', 'llama-server' -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
# Sobe só o servidor, escondido. O "ollama app" abriria uma janela na tela do dono.
# O log vai para mixai-servidor.log (o Ollama escreve o log na saída de erro), para dar para ver se o modelo foi para a placa.
# O desvio do log é feito pelo cmd: com -RedirectStandardError o servidor herda a saída deste script
# e quem roda o modo.ps1 esperando a saída fica preso para sempre.
$log = "$env:LOCALAPPDATA\Ollama\mixai-servidor.log"
Start-Process cmd -ArgumentList '/c', "`"`"$env:LOCALAPPDATA\Programs\Ollama\ollama.exe`"", 'serve', "2> `"$log`"`"" -WindowStyle Hidden
for ($i = 0; $i -lt 30 -and -not (Get-Process ollama -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
Start-Sleep -Seconds 3

# Prioridade: no modo dia o Windows dá preferência para os seus programas.
# O Ollama sobe a prioridade do modelo a cada carga, então um vigia escondido corrige sempre.
$arquivoVigia = Join-Path $env:TEMP 'mixai-vigia.pid'
if (Test-Path $arquivoVigia) {
  Stop-Process -Id (Get-Content $arquivoVigia) -Force -ErrorAction SilentlyContinue
}
$vigia = Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'vigia-prioridade.ps1'),
  '-Prioridade', $config.prioridade)
Set-Content $arquivoVigia $vigia.Id
Get-Process 'ollama', 'ollama app' -ErrorAction SilentlyContinue | ForEach-Object { $_.PriorityClass = $config.prioridade }

# Nome fixo "mixai-local" apontando para o modelo do modo. Para com erro se o Ollama falhar.
& (Join-Path $PSScriptRoot 'criar-apelido.ps1') -Modelo $config.modelo -Contexto $config.contexto -Nucleos $config.nucleos

# Guarda o modo ligado, para orquestra/paralelismo.js saber o teto de agentes.
Set-Content (Join-Path $env:LOCALAPPDATA 'Ollama\mixai-modo.txt') $Modo

Write-Host "Modo $Modo ligado: $($config.modelo), $($config.nucleos) nucleos, contexto $($config.contexto), prioridade $($config.prioridade)."
