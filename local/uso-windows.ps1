# Lê o uso do Windows e imprime um JSON: tempo sem mexer no PC, uso de placa e processador por outros programas,
# motores de vídeo da placa (para saber se há vídeo tocando) e memória livre.
# Regra de ouro: leitura que falha vira $null (null no JSON), nunca zero. Quem lê (orquestra/paralelismo.js)
# trata null como "PC em uso". Os testes usam leituras simuladas; aqui só se coleta.
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File local\uso-windows.ps1
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MixaiOcioso {
  [StructLayout(LayoutKind.Sequential)] struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);
  // -1 quando o Windows não respondeu (não pode virar "parado há muito tempo").
  public static long Segundos() {
    LII i = new LII(); i.cbSize = (uint)Marshal.SizeOf(i);
    if (!GetLastInputInfo(ref i)) return -1;
    return (long)(((uint)Environment.TickCount - i.dwTime) / 1000);
  }
}
'@

# "Meu" = só o Ollama que o MixAI iniciou: o modo.ps1 registra o PID do cmd que sobe o servidor e meus são esse processo e
# todos os que descendem dele (pelo ParentProcessId). Um Ollama/llama-server independente (aberto pelo dono ou por outro
# programa) conta como uso do PC. Sem registro, ou se a lista de processos falhar, nada é "meu" (na dúvida, em uso).
$pidsMeus = @()
$arquivoOllama = Join-Path $env:TEMP 'mixai-ollama.pid'
if (Test-Path $arquivoOllama) {
  $partes = ((Get-Content $arquivoOllama -ErrorAction SilentlyContinue) -join '').Trim().Split('|')
  $raizMeu = 0
  if ($partes.Count -eq 2 -and [int]::TryParse($partes[0], [ref]$raizMeu) -and $raizMeu -gt 0) {
    $todos = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    # O PID e a data de criação têm que bater: PID reaproveitado por outro processo faz o arquivo valer como ausente.
    $raizProc = $todos | Where-Object { $_.ProcessId -eq $raizMeu -and $_.Name -eq 'cmd.exe' -and $_.CreationDate -and $_.CreationDate.ToUniversalTime().ToString('o') -eq $partes[1] } | Select-Object -First 1
    if ($raizProc) {
      $pidsMeus = @($raizMeu)
      do {
        $novos = @($todos | Where-Object { $pidsMeus -contains [int]$_.ParentProcessId -and $pidsMeus -notcontains [int]$_.ProcessId } | ForEach-Object { [int]$_.ProcessId })
        $pidsMeus += $novos
      } while ($novos.Count -gt 0)
    }
  }
}

$ocioso = [MixaiOcioso]::Segundos()
if ($ocioso -lt 0) { $ocioso = $null }

# Número válido: tem que ser mesmo um número (não $null, não NaN, não negativo). Qualquer leitura que não for
# vira "inválida" e a medida inteira vira $null; nunca pode virar zero (= PC parado).
function Test-Numero($v) {
  return ($null -ne $v) -and ($v -is [ValueType]) -and ($v -isnot [bool]) -and (-not [double]::IsNaN([double]$v)) -and (-not [double]::IsInfinity([double]$v)) -and ([double]$v -ge 0)
}

# Placa e vídeo: 3 leituras de todos os motores da placa (1 s entre elas).
# Primeiro pelo contador de desempenho (nome em inglês, que já funcionou aqui); se não vier, pela classe CIM
# Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine, que não muda com o idioma do Windows.
# gpuOutrosPct = média das leituras da soma dos motores de outros programas.
# Dos motores de vídeo só entrega os números crus; orquestra/paralelismo.js decide o que é decodificação.
function Ler-MotoresGpu {
  $leituras = @()
  $contador = Get-Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 1 -MaxSamples 3 -ErrorAction SilentlyContinue
  if ($contador) {
    $i = 0
    foreach ($amostra in $contador) {
      foreach ($a in $amostra.CounterSamples) {
        # Status 0 (dado válido) e 1 (dado novo) valem; qualquer outro, mesmo com valor 0, é amostra inválida ($null).
        $valor = if ($a.Status -eq 0 -or $a.Status -eq 1) { $a.CookedValue } else { $null }
        $leituras += [pscustomobject]@{ i = $i; n = $a.InstanceName; v = $valor }
      }
      $i++
    }
    return @{ amostras = $i; leituras = $leituras }
  }
  $n = 0
  for ($i = 0; $i -lt 3; $i++) {
    $cim = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue
    if (-not $cim) { return $null }
    foreach ($a in $cim) { $leituras += [pscustomobject]@{ i = $i; n = $a.Name; v = $a.UtilizationPercentage } }
    $n++
    if ($i -lt 2) { Start-Sleep -Seconds 1 }
  }
  return @{ amostras = $n; leituras = $leituras }
}

$gpuOutros = $null
$videoAmostras = 0
$videoMotores = @()
$motores = Ler-MotoresGpu
if ($motores -and $motores.amostras -ge 1) {
  $somas = New-Object 'double[]' $motores.amostras
  $valido = $true
  $video = @()
  $amostrasComPid = @{}
  foreach ($l in $motores.leituras) {
    # Qualquer motor de GPU fora do formato pid_<n>_ invalida a medida inteira (null): não dá para saber de quem ele é.
    if ($l.n -notmatch 'pid_(\d+)_') { $valido = $false; continue }
    $amostrasComPid[[int]$l.i] = $true
    if ($l.n -match 'pid_(\d+)_' -and $pidsMeus -notcontains [int]$Matches[1]) {
      if (-not (Test-Numero $l.v)) { $valido = $false; continue }
      $somas[$l.i] += [double]$l.v
      if ($l.n -match 'video') { $video += [pscustomobject]@{ i = $l.i; n = $l.n; v = [Math]::Round([double]$l.v, 2) } }
    }
  }
  # Qualquer amostra sem motor no formato pid_<n>_ (ou nenhuma) não prova que a placa está livre: leitura indisponível ($null), nunca 0.
  if ($valido -and $amostrasComPid.Count -eq $motores.amostras) {
    $gpuOutros = [Math]::Round([Math]::Min(100, ($somas | Measure-Object -Average).Average), 1)
    $videoAmostras = $motores.amostras
    $videoMotores = $video
  }
}

# Processador: pelas classes CIM Win32_PerfFormattedData_*, que têm o mesmo nome em qualquer idioma do Windows
# (os caminhos de Get-Counter como "\Processor(_Total)" são traduzidos e falhavam em português).
# Total da máquina e soma dos processos do Ollama, cada processo UMA vez, achado pelo número (IDProcess), nunca
# pelo nome. O valor por processo vai de 0 a 100 por núcleo, então quem lê divide pelo número de núcleos.
$cpuTotal = $null
$cpuMeu = $null
$cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction SilentlyContinue
if ($cpu -and (Test-Numero $cpu.PercentProcessorTime)) { $cpuTotal = [Math]::Round([double]$cpu.PercentProcessorTime, 1) }
$processos = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction SilentlyContinue
if ($processos) {
  $soma = 0
  $valido = $true
  foreach ($p in $processos) {
    if ($pidsMeus -contains [int]$p.IDProcess) {
      if (Test-Numero $p.PercentProcessorTime) { $soma += [double]$p.PercentProcessorTime } else { $valido = $false }
    }
  }
  if ($valido) { $cpuMeu = [Math]::Round($soma, 1) }
}

$livre = $null
$so = Get-CimInstance Win32_OperatingSystem
if ($so -and (Test-Numero $so.FreePhysicalMemory) -and $so.FreePhysicalMemory -gt 0) { $livre = [Math]::Round($so.FreePhysicalMemory / 1MB, 2) }

[pscustomobject]@{
  ociosoSegundos = $ocioso
  gpuOutrosPct   = $gpuOutros
  cpuTotalPct    = $cpuTotal
  cpuMeuPct      = $cpuMeu
  nucleos        = [Environment]::ProcessorCount
  videoAmostras  = $videoAmostras
  videoMotores   = @($videoMotores)
  memoriaLivreGB = $livre
} | ConvertTo-Json -Compress -Depth 4
