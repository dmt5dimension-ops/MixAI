# Roda escondido, aberto pelo modo.ps1. O Ollama abre o processo do modelo (llama-server)
# com prioridade alta toda vez que carrega um modelo; este vigia devolve para a prioridade do modo.
param([Parameter(Mandatory)][string]$Prioridade)

while ($true) {
  Get-Process 'llama-server', 'ollama', 'ollama app' -ErrorAction SilentlyContinue |
    Where-Object { $_.PriorityClass -ne $Prioridade } |
    ForEach-Object { try { $_.PriorityClass = $Prioridade } catch {} }
  Start-Sleep -Seconds 5
}
