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
  [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
  // Sessão que está na frente do dono (0xFFFFFFFF = nenhuma).
  public static long SessaoDoConsole() { return (long)WTSGetActiveConsoleSessionId(); }
  // -1 quando o Windows não respondeu (não pode virar "parado há muito tempo").
  public static long Segundos() {
    LII i = new LII(); i.cbSize = (uint)Marshal.SizeOf(i);
    if (!GetLastInputInfo(ref i)) return -1;
    return (long)(((uint)Environment.TickCount - i.dwTime) / 1000);
  }
}
'@

# Número válido: tem que ser mesmo um número (não $null, não NaN, não negativo). Qualquer leitura que não for
# vira "inválida" e a medida inteira vira $null; nunca pode virar zero (= PC parado).
function Test-Numero($v) {
  return ($null -ne $v) -and ($v -is [ValueType]) -and ($v -isnot [bool]) -and (-not [double]::IsNaN([double]$v)) -and (-not [double]::IsInfinity([double]$v)) -and ([double]$v -ge 0)
}

# "Meu" = só o Ollama que o MixAI iniciou: o modo.ps1 registra o PID do cmd que sobe o servidor e meus são esse processo e
# todos os que descendem dele (pelo ParentProcessId). Um Ollama/llama-server independente (aberto pelo dono ou por outro
# programa) conta como uso do PC. Sem registro, ou se a lista de processos falhar, nada é "meu" (na dúvida, em uso).
$pidsMeus = @()
$ramMeuGB = 0 # memória privada dos runners do modelo do MixAI (0 = não há; $null = não deu para medir)
$arquivoOllama = Join-Path $env:TEMP 'mixai-ollama.pid'
if (Test-Path $arquivoOllama) {
  $partes = ((Get-Content $arquivoOllama -ErrorAction SilentlyContinue) -join '').Trim().Split('|')
  $raizMeu = 0
  if ($partes.Count -eq 2 -and [int]::TryParse($partes[0], [ref]$raizMeu) -and $raizMeu -gt 0) {
    $todos = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    if ($todos.Count -eq 0) { $ramMeuGB = $null } # a lista de processos falhou: não dá para dizer o que é meu
    # Linha malformada (sem número do processo, do pai ou nome) não é descartada em silêncio: não dá para saber se ela era filha
    # do MixAI, então a memória do MixAI fica desconhecida ($null) em vez de subcontada.
    $malformadas = @($todos | Where-Object { $null -eq $_.ProcessId -or $null -eq $_.ParentProcessId -or -not $_.Name })
    # O PID e a data de criação têm que bater: PID reaproveitado por outro processo faz o arquivo valer como ausente.
    $raizProc = $todos | Where-Object { $_.ProcessId -eq $raizMeu -and $_.Name -eq 'cmd.exe' -and $_.CreationDate -and $_.CreationDate.ToUniversalTime().ToString('o') -eq $partes[1] } | Select-Object -First 1
    if ($raizProc) {
      $pidsMeus = @($raizMeu)
      do {
        $novos = @($todos | Where-Object { $pidsMeus -contains [int]$_.ParentProcessId -and $pidsMeus -notcontains [int]$_.ProcessId } | ForEach-Object { [int]$_.ProcessId })
        $pidsMeus += $novos
      } while ($novos.Count -gt 0)
      # Só a parte RECUPERÁVEL conta: a memória PRIVADA dos runners do modelo (llama-server / ollama_llama_server / ollama-runner, nome exato; o ollama.exe do servidor fica de fora), que some quando eles
      # fecham. O working set inteiro do Ollama inclui o servidor e arquivos mapeados do modelo, que não voltam para os agentes.
      $runners = @($todos | Where-Object { $pidsMeus -contains [int]$_.ProcessId -and $_.Name -match '^(llama-server|ollama_llama_server|ollama-runner)(\.exe)?$' })
      if ($malformadas.Count -gt 0) { $ramMeuGB = $null }
      elseif ($runners.Count -eq 0) { $ramMeuGB = 0 }
      else {
        $somaRam = ($runners | Measure-Object PrivatePageCount -Sum).Sum
        $ramMeuGB = if (Test-Numero $somaRam) { [Math]::Round([double]$somaRam / 1GB, 2) } else { $null }
      }
    }
  }
}

$ocioso = [MixaiOcioso]::Segundos()
if ($ocioso -lt 0) { $ocioso = $null }
# O tempo sem mexer só vale na sessão que está na frente do dono: se este script roda em outra sessão (serviço, tarefa agendada,
# outro usuário), o relógio dela não diz nada sobre o dono e vira indisponível ($null).
if ($null -ne $ocioso -and ((Get-Process -Id $PID).SessionId -ne [MixaiOcioso]::SessaoDoConsole())) { $ocioso = $null }

# Placa e vídeo: 3 leituras de todos os motores da placa (1 s entre elas).
# Primeiro pelo contador de desempenho (nome em inglês, que já funcionou aqui); se ele falhar, vier parcial ou com instâncias
# diferentes entre as amostras, tenta a classe CIM Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine, que não muda com
# o idioma do Windows; se as duas fontes forem inválidas, a placa fica indisponível ($null).
# A ocupação da placa por outros programas (antes gpuOutrosPct aqui) agora é calculada em orquestra/paralelismo.js
# (gpuOutrosDe, o motor mais carregado de cada amostra) a partir das somas por amostra e por MOTOR (adaptador + engine) que
# este script entrega em gpuPorTipo (o campo `t` é o identificador do motor).
# Dos motores de vídeo só entrega os números crus; orquestra/paralelismo.js decide o que é decodificação.
# Cobertura: o conjunto de instâncias de motor tem que ser o MESMO em todas as amostras, e erro parcial da coleta (algumas
# instâncias leram, outras falharam) não é silenciado: qualquer um dos dois devolve $null (leitura indisponível).
function Conjuntos-Iguais($leituras) {
  $conjuntos = @($leituras | Group-Object i | ForEach-Object { (@($_.Group | ForEach-Object { $_.n } | Sort-Object) -join '|') })
  return (@($conjuntos | Select-Object -Unique).Count -eq 1)
}

function Ler-Contador {
  $leituras = @()
  $contador = Get-Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 1 -MaxSamples 3 -ErrorAction SilentlyContinue -ErrorVariable errosContador
  if (-not $contador) { return $null }
  if (@($errosContador).Count -gt 0) { return $null }
  $i = 0
  foreach ($amostra in $contador) {
    foreach ($a in $amostra.CounterSamples) {
      # Status 0 (dado válido) e 1 (dado novo) valem; qualquer outro, mesmo com valor 0, é amostra inválida ($null).
      $valor = if ($a.Status -eq 0 -or $a.Status -eq 1) { $a.CookedValue } else { $null }
      $leituras += [pscustomobject]@{ i = $i; n = $a.InstanceName; v = $valor }
    }
    $i++
  }
  if (-not (Conjuntos-Iguais $leituras)) { return $null }
  return @{ amostras = $i; leituras = $leituras }
}

function Ler-Cim {
  $leituras = @()
  $n = 0
  for ($i = 0; $i -lt 3; $i++) {
    $cim = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue -ErrorVariable errosCim
    if (-not $cim -or @($errosCim).Count -gt 0) { return $null }
    foreach ($a in $cim) {
      # Linha sem nome ou sem valor numérico invalida a leitura inteira (null); não entra como "motor parado".
      if (-not $a.Name -or -not (Test-Numero $a.UtilizationPercentage)) { return $null }
      $leituras += [pscustomobject]@{ i = $i; n = $a.Name; v = $a.UtilizationPercentage }
    }
    $n++
    if ($i -lt 2) { Start-Sleep -Seconds 1 }
  }
  if (-not (Conjuntos-Iguais $leituras)) { return $null }
  return @{ amostras = $n; leituras = $leituras }
}

function Ler-MotoresGpu {
  $r = Ler-Contador
  if ($null -eq $r) { $r = Ler-Cim }
  return $r
}

$gpuAmostras = 0
$gpuPorTipo = @()
$videoAmostras = 0
$videoMotores = @()
$motores = Ler-MotoresGpu
if ($motores -and $motores.amostras -ge 1) {
  $porTipo = @{}
  $valido = $true
  $video = @()
  $amostrasComPid = @{}
  foreach ($l in $motores.leituras) {
    # Qualquer motor de GPU fora do formato pid_<n>_ invalida a medida inteira (null): não dá para saber de quem ele é.
    if ($l.n -notmatch 'pid_(\d+)_') { $valido = $false; continue }
    $amostrasComPid[[int]$l.i] = $true
    # Toda linha de motor tem que ter valor válido (e Status válido, já tratado na leitura), seja de quem for, inclusive do
    # próprio Ollama: uma linha inválida invalida a medida inteira antes de qualquer filtro por dono.
    if (-not (Test-Numero $l.v)) { $valido = $false; continue }
    $pidDono = [int][regex]::Match($l.n, 'pid_(\d+)_').Groups[1].Value
    if ($pidsMeus -notcontains $pidDono) {
      # A chave é o MOTOR (adaptador + engine + tipo, tudo depois de pid_<n>_), não só o tipo: dois motores do mesmo tipo em
      # adaptadores diferentes não se somam. Os processos que usam o mesmo motor sim (é o mesmo motor ocupado).
      $tipo = [regex]::Match($l.n, 'pid_\d+_(.+)$').Groups[1].Value
      if (-not $tipo) { $valido = $false; continue } # motor sem identificação
      $chave = "$($l.i)|$tipo"
      $porTipo[$chave] = [double]$porTipo[$chave] + [double]$l.v
      if ($l.n -match 'video') { $video += [pscustomobject]@{ i = $l.i; n = $l.n; v = [Math]::Round([double]$l.v, 2) } }
    }
  }
  # Qualquer amostra sem motor no formato pid_<n>_ (ou nenhuma) não prova que a placa está livre: leitura indisponível ($null), nunca 0.
  if ($valido -and $amostrasComPid.Count -eq $motores.amostras) {
    $gpuAmostras = $motores.amostras
    $gpuPorTipo = @($porTipo.GetEnumerator() | ForEach-Object { $c = $_.Key.Split('|', 2); [pscustomobject]@{ i = [int]$c[0]; t = $c[1]; v = [Math]::Round([double]$_.Value, 2) } })
    $videoAmostras = $motores.amostras
    $videoMotores = $video
  }
}

# Memória de vídeo (VRAM dedicada) ocupada por OUTROS programas, SÓ no adaptador que o Ollama do MixAI usa (o luid do adaptador
# aparece no nome da instância tanto do contador do adaptador quanto do contador de memória por processo): uso dedicado do
# adaptador menos a parte dos processos do MixAI nele. Sem processo do MixAI na placa (modelo ainda não carregado), usa o
# adaptador com mais memória dedicada ocupada (a placa de vídeo dedicada, não a integrada). Qualquer erro, valor inválido, lista
# de adaptadores VAZIA ou resultado impossível (a parte do MixAI maior que o total) deixa $null; sem medida o paralelismo.js usa
# só a reserva fixa da placa.
$vramOutrosGB = $null
$cAdaptador = Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage' -ErrorAction SilentlyContinue -ErrorVariable errosAdaptador
$cProcesso = Get-Counter '\GPU Process Memory(*)\Dedicated Usage' -ErrorAction SilentlyContinue -ErrorVariable errosProcessoVram
if ($cAdaptador -and $cProcesso -and @($errosAdaptador).Count -eq 0 -and @($errosProcessoVram).Count -eq 0) {
  $valido = $true
  $porAdaptador = @{}
  $meuPorAdaptador = @{}
  $amostrasAdaptador = @($cAdaptador.CounterSamples)
  if ($amostrasAdaptador.Count -eq 0) { $valido = $false } # sem nenhum adaptador listado não há medida: null, não zero
  foreach ($a in $amostrasAdaptador) {
    if (($a.Status -ne 0 -and $a.Status -ne 1) -or -not (Test-Numero $a.CookedValue)) { $valido = $false; continue }
    $luid = [regex]::Match($a.InstanceName, 'luid_0x[0-9a-fA-F]+_0x[0-9a-fA-F]+').Value
    if (-not $luid) { $valido = $false; continue }
    $porAdaptador[$luid] = [double]$porAdaptador[$luid] + [double]$a.CookedValue
  }
  foreach ($a in @($cProcesso.CounterSamples)) {
    if (($a.Status -ne 0 -and $a.Status -ne 1) -or -not (Test-Numero $a.CookedValue)) { $valido = $false; continue }
    $m = [regex]::Match($a.InstanceName, 'pid_(\d+)_(luid_0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)')
    if ($m.Success -and $pidsMeus -contains [int]$m.Groups[1].Value) {
      $luidMeu = $m.Groups[2].Value
      $meuPorAdaptador[$luidMeu] = [double]$meuPorAdaptador[$luidMeu] + [double]$a.CookedValue
    }
  }
  if ($valido -and $porAdaptador.Count -gt 0) {
    $usado = $porAdaptador.GetEnumerator() | Where-Object { $meuPorAdaptador.Count -eq 0 -or $meuPorAdaptador.ContainsKey($_.Key) }
    $escolha = if ($meuPorAdaptador.Count -gt 0) { $usado | Sort-Object { [double]$meuPorAdaptador[$_.Key] } -Descending | Select-Object -First 1 } else { $usado | Sort-Object Value -Descending | Select-Object -First 1 }
    if ($escolha) {
      $totalVram = [double]$escolha.Value
      $meuVram = [double]$meuPorAdaptador[$escolha.Key]
      if ($totalVram -ge $meuVram) { $vramOutrosGB = [Math]::Round(($totalVram - $meuVram) / 1GB, 2) }
    }
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
  $vistosCpu = @{}
  foreach ($p in $processos) {
    # Linha sem número de processo não prova que não era do MixAI: CPU do MixAI desconhecida ($null).
    if ($null -eq $p.IDProcess) { $valido = $false; continue }
    if ($pidsMeus -contains [int]$p.IDProcess) {
      $vistosCpu[[int]$p.IDProcess] = $true
      if (Test-Numero $p.PercentProcessorTime) { $soma += [double]$p.PercentProcessorTime } else { $valido = $false }
    }
  }
  # Cobertura: todo processo "meu" tem que aparecer na lista de contadores. Se o Ollama do MixAI sumiu da lista, a parte dele
  # não é zero: é desconhecida ($null).
  if ($vistosCpu.Count -ne $pidsMeus.Count) { $valido = $false }
  if ($valido) { $cpuMeu = [Math]::Round($soma, 1) }
}

# Vídeo por SOFTWARE (o decodificador da placa não mexe): CPU somada de players de vídeo conhecidos (pontos de um núcleo). Só
# esses processos entram: navegador tocando vídeo NÃO é detectado. Falha ou valor inválido deixa $null (indisponível).
$playersCpu = $null
if ($processos) {
  $somaPlayers = 0
  $validoPlayers = $true
  foreach ($p in $processos) {
    if ($p.Name -match '^(vlc|mpv|mpc-hc|mpc-hc64|mpc-be|mpc-be64|potplayer|potplayermini|potplayermini64|ffplay|wmplayer|video\.ui|microsoft\.media\.player)(#\d+)?$') {
      if (Test-Numero $p.PercentProcessorTime) { $somaPlayers += [double]$p.PercentProcessorTime } else { $validoPlayers = $false }
    }
  }
  if ($validoPlayers) { $playersCpu = [Math]::Round($somaPlayers, 1) }
}

$livre = $null
$so = Get-CimInstance Win32_OperatingSystem
if ($so -and (Test-Numero $so.FreePhysicalMemory) -and $so.FreePhysicalMemory -gt 0) { $livre = [Math]::Round($so.FreePhysicalMemory / 1MB, 2) }

# Tempo sem mexer maior que o tempo ligado é impossível (relógio de entrada estranho): indisponível, não "parado há muito".
if ($null -ne $ocioso) {
  if ($so -and $so.LastBootUpTime) { if ($ocioso -gt ((Get-Date) - $so.LastBootUpTime).TotalSeconds + 60) { $ocioso = $null } } else { $ocioso = $null }
}

[pscustomobject]@{
  ociosoSegundos = $ocioso
  gpuAmostras    = $gpuAmostras
  gpuPorTipo     = @($gpuPorTipo)
  cpuTotalPct    = $cpuTotal
  cpuMeuPct      = $cpuMeu
  nucleos        = [Environment]::ProcessorCount
  videoAmostras  = $videoAmostras
  videoMotores   = @($videoMotores)
  memoriaLivreGB = $livre
  vramOutrosGB   = $vramOutrosGB
  ramMeuGB       = $ramMeuGB
  playersCpuPct  = $playersCpu
} | ConvertTo-Json -Compress -Depth 4
