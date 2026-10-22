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

# Os processos do próprio modelo local não contam como "outros programas".
$meus = @('ollama', 'ollama app', 'llama-server', 'ollama_llama_server')
$pidsMeus = @(Get-Process | Where-Object { $meus -contains $_.ProcessName } | ForEach-Object { $_.Id })

$ocioso = [MixaiOcioso]::Segundos()
if ($ocioso -lt 0) { $ocioso = $null }

# Placa e vídeo: 3 leituras com 1 s de intervalo de todos os motores da placa.
# gpuOutrosPct = média das leituras da soma dos motores de outros programas (nenhuma leitura = $null).
# Dos motores de vídeo só entrega os números crus; orquestra/paralelismo.js decide o que é decodificação.
$gpuOutros = $null
$videoAmostras = 0
$videoMotores = @()
$serie = Get-Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 1 -MaxSamples 3 -ErrorAction SilentlyContinue
if ($serie) {
  $i = 0
  $somas = @()
  foreach ($amostra in $serie) {
    $soma = 0
    foreach ($a in $amostra.CounterSamples) {
      if ($a.InstanceName -match 'pid_(\d+)_' -and $pidsMeus -notcontains [int]$Matches[1]) {
        $soma += $a.CookedValue
        if ($a.InstanceName -match 'video') {
          $videoMotores += [pscustomobject]@{ i = $i; n = $a.InstanceName; v = [Math]::Round($a.CookedValue, 2) }
        }
      }
    }
    $somas += $soma
    $i++
  }
  $videoAmostras = $i
  if ($somas.Count -gt 0) { $gpuOutros = [Math]::Round([Math]::Min(100, ($somas | Measure-Object -Average).Average), 1) }
}

# Processador: total da máquina e quanto é do Ollama. Cada processo (instância do contador) entra UMA vez:
# nada de curinga por nome, que contava o mesmo processo mais de uma vez. O contador por processo vai de 0 a
# 100 por núcleo, então quem lê divide pelo número de núcleos.
$cpuTotal = $null
$cpuMeu = $null
$total = (Get-Counter '\Processor(_Total)\% Processor Time' -ErrorAction SilentlyContinue).CounterSamples
if ($total) { $cpuTotal = [Math]::Round($total[0].CookedValue, 1) }
$porProcesso = (Get-Counter '\Process(*)\% Processor Time' -ErrorAction SilentlyContinue).CounterSamples
if ($porProcesso) {
  $cpuMeu = 0
  foreach ($s in $porProcesso) {
    $nome = $s.InstanceName -replace '#\d+$', ''
    if ($meus -contains $nome) { $cpuMeu += $s.CookedValue }
  }
  $cpuMeu = [Math]::Round($cpuMeu, 1)
}

$livre = $null
$so = Get-CimInstance Win32_OperatingSystem
if ($so -and $so.FreePhysicalMemory) { $livre = [Math]::Round($so.FreePhysicalMemory / 1MB, 2) }

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
