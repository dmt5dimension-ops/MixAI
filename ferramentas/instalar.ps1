# Instala as ferramentas do orquestrador no Windows 11.
# Uso (PowerShell comum, nao precisa ser administrador):
#   powershell -ExecutionPolicy Bypass -File .\instalar.ps1
# Opcoes:
#   -PularOrchestrator   nao baixa o app Agent Orchestrator
#   -PularPlugins        nao tenta instalar os plugins do Claude Code

param(
    [switch]$PularOrchestrator,
    [switch]$PularPlugins
)

$ErrorActionPreference = 'Stop'

function Write-Passo($texto) { Write-Host "`n==> $texto" -ForegroundColor Cyan }
function Write-Ok($texto)    { Write-Host "    ok: $texto" -ForegroundColor Green }
function Write-Aviso($texto) { Write-Host "    atencao: $texto" -ForegroundColor Yellow }

function Test-Comando($nome) {
    return [bool](Get-Command $nome -ErrorAction SilentlyContinue)
}

function Update-Path {
    $maquina = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $usuario = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$maquina;$usuario"
}

function Install-ViaWinget($comando, $id) {
    if (Test-Comando $comando) {
        Write-Ok "$comando ja instalado"
        return
    }
    if (-not (Test-Comando 'winget')) {
        throw "winget nao encontrado. Instale o 'App Installer' pela Microsoft Store e rode de novo."
    }
    Write-Host "    instalando $id..."
    winget install -e --id $id --accept-source-agreements --accept-package-agreements --silent
    if ($LASTEXITCODE -ne 0) { throw "winget nao conseguiu instalar $id (codigo $LASTEXITCODE). Veja a mensagem acima e rode de novo." }
    Update-Path
    if (Test-Comando $comando) { Write-Ok "$comando instalado" }
    else { Write-Aviso "$comando instalado, mas so aparece no PATH depois de abrir um novo terminal" }
}

Write-Passo 'Conferindo que nada vai cobrar por API (so assinatura)'
$chavesApi = @('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY')
$achadas = @()
foreach ($nome in $chavesApi) {
    foreach ($escopo in @('User', 'Machine', 'Process')) {
        if ([Environment]::GetEnvironmentVariable($nome, $escopo)) { $achadas += "$nome ($escopo)" }
    }
}
if ($achadas.Count -gt 0) {
    Write-Aviso "estas variaveis fazem o Claude Code ou o Codex cobrarem por API em vez da assinatura: $($achadas -join ', ')"
    Write-Host  '    Para remover (variaveis de usuario), rode:'
    foreach ($nome in $chavesApi) { Write-Host "      [Environment]::SetEnvironmentVariable('$nome', `$null, 'User')" }
} else {
    Write-Ok 'nenhuma chave de API configurada'
}

Write-Passo 'Pre-requisitos (Git, Node.js LTS, GitHub CLI)'
Install-ViaWinget 'git' 'Git.Git'
Install-ViaWinget 'node' 'OpenJS.NodeJS.LTS'
Install-ViaWinget 'gh' 'GitHub.cli'

Write-Passo 'Claude Code'
if (Test-Comando 'claude') {
    Write-Ok 'claude ja instalado'
} else {
    Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
    Update-Path
    if (Test-Comando 'claude') { Write-Ok 'claude instalado' }
    else { Write-Aviso 'abra um novo terminal para o comando claude aparecer' }
}

Write-Passo 'Codex CLI'
if (Test-Comando 'codex') {
    Write-Ok 'codex ja instalado'
} elseif (Test-Comando 'npm') {
    npm install -g @openai/codex
    if ($LASTEXITCODE -ne 0) { throw "npm nao conseguiu instalar o Codex CLI (codigo $LASTEXITCODE). Veja a mensagem acima e rode de novo." }
    Update-Path
    Write-Ok 'codex instalado'
} else {
    Write-Aviso 'npm ainda nao esta no PATH. Abra um novo terminal e rode: npm install -g @openai/codex'
}

if (-not $PularPlugins -and (Test-Comando 'claude')) {
    Write-Passo 'Plugins do Claude Code (Superpowers e revisao do Codex)'
    $comandos = @(
        @('plugin', 'install', 'superpowers@claude-plugins-official'),
        @('plugin', 'marketplace', 'add', 'openai/codex-plugin-cc'),
        @('plugin', 'install', 'codex@openai-codex')
    )
    $falhou = $false
    foreach ($c in $comandos) {
        try {
            & claude @c
            if ($LASTEXITCODE -ne 0) { $falhou = $true }
        } catch {
            $falhou = $true
        }
    }
    if ($falhou) {
        Write-Aviso 'nao consegui instalar todos os plugins pela linha de comando.'
        Write-Host  '    Abra o Claude Code e rode manualmente:'
        Write-Host  '      /plugin install superpowers@claude-plugins-official'
        Write-Host  '      /plugin marketplace add openai/codex-plugin-cc'
        Write-Host  '      /plugin install codex@openai-codex'
    } else {
        Write-Ok 'plugins instalados'
    }
}

if (-not $PularOrchestrator) {
    Write-Passo 'Agent Orchestrator (Orchestrator.inc)'
    $paginaReleases = 'https://github.com/OrchestratorInc/agent-orchestrator/releases/latest'
    try {
        $release = Invoke-RestMethod 'https://api.github.com/repos/OrchestratorInc/agent-orchestrator/releases/latest' -Headers @{ 'User-Agent' = 'orquestrador-kit' }
        $asset = $release.assets |
            Where-Object { $_.name -match '\.exe$' -and $_.name -notmatch 'arm64' } |
            Select-Object -First 1
        if (-not $asset) { throw 'nenhum instalador .exe na ultima versao' }
        $destino = Join-Path $env:TEMP $asset.name
        Write-Host "    baixando $($asset.name) ($($release.tag_name))..."
        Invoke-WebRequest $asset.browser_download_url -OutFile $destino -UseBasicParsing
        Write-Ok "baixado em $destino"
        Write-Host '    abrindo o instalador...'
        Start-Process $destino
    } catch {
        Write-Aviso "nao consegui baixar automaticamente ($($_.Exception.Message))."
        Write-Host  "    Baixe o .exe para Windows x64 em: $paginaReleases"
        Start-Process $paginaReleases
    }
}

Write-Passo 'Falta voce fazer (uma vez so)'
Write-Host '  1. Login nas ferramentas, num terminal novo:'
Write-Host '       claude            (entre com a conta da assinatura Claude Pro/Max, NAO com chave de API)'
Write-Host '       codex login       (escolha "Sign in with ChatGPT", NAO "API key")'
Write-Host '       gh auth login'
Write-Host '  2. Superpowers no Codex: abra o Codex, digite /plugins, busque "superpowers" e escolha Install Plugin.'
Write-Host '  3. No Claude Code, rode /codex:setup para conferir a ponte com o Codex.'
Write-Host ''
