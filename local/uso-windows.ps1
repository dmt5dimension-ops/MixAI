# Lê o uso do Windows e imprime um JSON: tempo sem mexer no PC, uso de placa e processador por outros programas,
# motores de vídeo da placa (para saber se há vídeo tocando) e memória livre. Quem chama é orquestra/paralelismo.js; os testes usam leituras simuladas.
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File local\uso-windows.ps1
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MixaiOcioso {
  [StructLayout(LayoutKind.Sequential)] struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);
  public static uint Segundos() {
    LII i = new LII(); i.cbSize = (uint)Marshal.SizeOf(i);
    GetLastInputInfo(ref i);
    return ((uint)Environment.TickCount - i.dwTime) / 1000;
  }
}
'@

# Os processos do próprio modelo local não contam como "outros programas".
$meus = @('ollama', 'ollama app', 'llama-server', 'ollama_llama_server')
$pidsMeus = @(Get-Process | Where-Object { $meus -contains $_.ProcessName } | ForEach-Object { $_.Id })

$gpuOutros = 0
$amostras = (Get-Counter '\GPU Engine(*)\Utilization Percentage').CounterSamples
foreach ($a in $amostras) {
  if ($a.InstanceName -match 'pid_(\d+)_') {
    if ($pidsMeus -notcontains [int]$Matches[1]) { $gpuOutros += $a.CookedValue }
  }
}

$cpuTotal = (Get-Counter '\Processor(_Total)\% Processor Time').CounterSamples[0].CookedValue
$cpuMeu = 0
foreach ($p in (Get-Process | Where-Object { $pidsMeus -contains $_.Id })) {
  $c = Get-Counter "\Process($($p.ProcessName)*)\% Processor Time"
  foreach ($s in $c.CounterSamples) { $cpuMeu += $s.CookedValue }
}
$cpuOutros = [Math]::Max(0, $cpuTotal - ($cpuMeu / [Environment]::ProcessorCount))

# Vídeo tocando: motores de vídeo da placa usados por outros programas, 3 leituras com 1 s de intervalo.
# Só entrega os números crus (nome do motor e uso); orquestra/paralelismo.js decide o que é decodificação
# e tira a média. Não precisa de administrador. Sem nenhum motor de vídeo a lista vai vazia, e quem lê
# trata isso como "leitura indisponível" (na dúvida, usando o PC).
$videoAmostras = 0
$videoMotores = @()
$serie = Get-Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 1 -MaxSamples 3 -ErrorAction SilentlyContinue
if ($serie) {
  $i = 0
  foreach ($amostra in $serie) {
    foreach ($a in $amostra.CounterSamples) {
      if ($a.InstanceName -match 'video' -and $a.InstanceName -match 'pid_(\d+)_' -and $pidsMeus -notcontains [int]$Matches[1]) {
        $videoMotores += [pscustomobject]@{ i = $i; n = $a.InstanceName; v = [Math]::Round($a.CookedValue, 2) }
      }
    }
    $i++
  }
  $videoAmostras = $i
}

$livre = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB

[pscustomobject]@{
  ociosoSegundos = [int][MixaiOcioso]::Segundos()
  gpuOutrosPct   = [Math]::Round([Math]::Min(100, $gpuOutros), 1)
  cpuOutrosPct   = [Math]::Round([Math]::Min(100, $cpuOutros), 1)
  videoAmostras  = $videoAmostras
  videoMotores   = @($videoMotores)
  memoriaLivreGB = [Math]::Round($livre, 2)
} | ConvertTo-Json -Compress -Depth 4
