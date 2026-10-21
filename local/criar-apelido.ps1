# Aponta o nome fixo "mixai-local" para o modelo do modo (não baixa nem copia nada).
# Se o Ollama falhar, para com erro: o modo não pode ser anunciado como ligado.
param(
  [Parameter(Mandatory)][string]$Modelo,
  [Parameter(Mandatory)][int]$Contexto,
  [Parameter(Mandatory)][int]$Nucleos,
  [string]$Ollama = 'ollama'
)

$modelfile = Join-Path ([IO.Path]::GetTempPath()) "mixai-local-$PID.Modelfile"
@"
FROM $Modelo
PARAMETER num_ctx $Contexto
PARAMETER num_thread $Nucleos
"@ | Set-Content $modelfile -Encoding ascii
try {
  & $Ollama create mixai-local -f $modelfile | Out-Null
  $codigo = $LASTEXITCODE
} finally {
  Remove-Item $modelfile -ErrorAction SilentlyContinue
}
if ($codigo -ne 0) {
  $mensagem = "O Ollama nao conseguiu criar o mixai-local (codigo $codigo). O modo NAO foi ligado."
  # Linha simples primeiro: a caixa de erro do PowerShell quebra o texto conforme a largura da tela.
  [Console]::Error.WriteLine($mensagem)
  throw $mensagem
}
