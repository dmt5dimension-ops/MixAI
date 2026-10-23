# Imprime a RAM PRIVADA, em bytes, dos runners do modelo do Ollama que o MixAI iniciou (o mesmo critério do uso-windows.ps1):
# o modo.ps1 registra "PID|data de criação" do cmd que sobe o servidor; meus são esse cmd e os que descendem dele, e só
# contam os runners de nome exato. Imprime 0 se não houver registro, se o PID/data não baterem ou se algo falhar:
# sem certeza de quem é o processo, não há crédito. Working set não serve (inclui páginas mapeadas e compartilhadas).
$ErrorActionPreference = 'SilentlyContinue'
$arquivo = if ($env:MIXAI_PID_OLLAMA) { $env:MIXAI_PID_OLLAMA } else { Join-Path $env:TEMP 'mixai-ollama.pid' }
$saida = 0
if (Test-Path $arquivo) {
  $partes = ((Get-Content $arquivo) -join '').Trim().Split('|')
  $raiz = 0
  if ($partes.Count -eq 2 -and [int]::TryParse($partes[0], [ref]$raiz) -and $raiz -gt 0) {
    $todos = @(Get-CimInstance Win32_Process)
    $r = $todos | Where-Object { $_.ProcessId -eq $raiz -and $_.Name -eq 'cmd.exe' -and $_.CreationDate -and $_.CreationDate.ToUniversalTime().ToString('o') -eq $partes[1] } | Select-Object -First 1
    if ($r) {
      $meus = @($raiz)
      do {
        $novos = @($todos | Where-Object { $meus -contains [int]$_.ParentProcessId -and $meus -notcontains [int]$_.ProcessId } | ForEach-Object { [int]$_.ProcessId })
        $meus += $novos
      } while ($novos.Count -gt 0)
      $runners = @($todos | Where-Object { $meus -contains [int]$_.ProcessId -and $_.Name -match '^(llama-server|ollama_llama_server|ollama-runner)(\.exe)?$' })
      $soma = ($runners | Measure-Object PrivatePageCount -Sum).Sum
      if ($runners.Count -gt 0 -and $null -ne $soma -and [double]$soma -gt 0) { $saida = [double]$soma }
    }
  }
}
[Console]::Out.Write([string][long]$saida)