# Prepara um repositorio para o orquestrador: regras dos agentes, CI de regressao,
# guarda de testes, trava de revisao cruzada e (opcional) protecao da branch principal.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\preparar-repo.ps1 -Repo C:\caminho\do\repo
#   ... -ComandoTeste "npm test"      define o comando da suite de regressao
#   ... -AplicarProtecao              liga a protecao de branch no GitHub (pede confirmacao)
#   ... -Sobrescrever                 substitui arquivos que ja existem no repo

param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [string]$ComandoTeste = '',
    [switch]$AplicarProtecao,
    [switch]$Sobrescrever
)

$ErrorActionPreference = 'Stop'
# A lista do que vai para o outro repo fica em kit-arquivos.json; os arquivos saem deste proprio repo.
$origem = Split-Path $PSScriptRoot
$kit = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'kit-arquivos.json')) | ConvertFrom-Json

function Write-Passo($texto) { Write-Host "`n==> $texto" -ForegroundColor Cyan }
function Write-Ok($texto)    { Write-Host "    ok: $texto" -ForegroundColor Green }
function Write-Aviso($texto) { Write-Host "    atencao: $texto" -ForegroundColor Yellow }

function Copiar-Arquivo($de, $relativo) {
    $destino = Join-Path $Repo $relativo
    New-Item -ItemType Directory -Force -Path (Split-Path $destino) | Out-Null
    if ((Test-Path $destino) -and -not $Sobrescrever) {
        $alternativo = [IO.Path]::Combine((Split-Path $destino), [IO.Path]::GetFileNameWithoutExtension($destino) + '.orquestrador' + [IO.Path]::GetExtension($destino))
        Copy-Item $de $alternativo -Force
        Write-Aviso "$relativo ja existia; a versao do kit foi salva ao lado como $(Split-Path $alternativo -Leaf). Junte os dois a mao."
    } else {
        Copy-Item $de $destino -Force
        Write-Ok $relativo
    }
}

$Repo = (Resolve-Path $Repo).Path
git -C $Repo rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) { throw "$Repo nao e um repositorio Git." }

Write-Passo "Copiando regras e portoes para $Repo"
foreach ($item in $kit.copiar) {
    $caminho = Join-Path $origem $item
    if (-not (Test-Path $caminho)) { throw "O kit manda copiar $item, mas ele nao existe em $origem." }
    if ($item.EndsWith('/')) {
        $base = (Resolve-Path $caminho).Path.TrimEnd('\', '/')
        foreach ($arq in Get-ChildItem $base -Recurse -File -Force) {
            Copiar-Arquivo $arq.FullName ($item + $arq.FullName.Substring($base.Length + 1).Replace('\', '/'))
        }
    } else {
        Copiar-Arquivo $caminho $item
    }
}
Copiar-Arquivo (Join-Path $origem $kit.memoriaVazia.de) $kit.memoriaVazia.para

if ($ComandoTeste) {
    $agents = Join-Path $Repo 'AGENTS.md'
    if (Test-Path $agents) {
        $texto = [IO.File]::ReadAllText($agents)
        $ancora = [regex]$kit.ancoraComandoTeste
        if ($ancora.IsMatch($texto)) {
            $texto = $ancora.Replace($texto, '${1}' + $ComandoTeste.Replace('$', '$$') + '${3}', 1)
            [IO.File]::WriteAllText($agents, $texto, (New-Object Text.UTF8Encoding $false))
            Write-Ok "comando de teste gravado no AGENTS.md: $ComandoTeste"
        } else {
            Write-Aviso 'nao achei a secao do comando de teste no AGENTS.md; grave o comando a mao.'
        }
    }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Aviso 'GitHub CLI (gh) nao encontrado; pulei labels, variavel e protecao. Rode instalar.ps1 e gh auth login.'
    return
}

Push-Location $Repo
try {
    gh repo view --json nameWithOwner *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Aviso 'este repo ainda nao esta no GitHub (ou o gh nao esta logado). Suba o repo e rode este script de novo.'
        return
    }

    Write-Passo 'Labels da revisao cruzada'
    $labels = @(
        @('feito-por:claude',  'D97757', 'Implementado pelo Claude Code'),
        @('feito-por:codex',   '10A37F', 'Implementado pelo Codex'),
        @('revisado-por:claude', 'F0B39B', 'Revisao adversaria feita pelo Claude Code'),
        @('revisado-por:codex',  '7FD1B9', 'Revisao adversaria feita pelo Codex'),
        @('permitir-remocao-de-teste', 'B60205', 'Libera apagar ou pular teste neste PR (so voce deve usar)'),
        @('permitir-fora-do-escopo', 'B60205', 'Libera mexer fora do escopo declarado neste PR (so voce deve usar)')
    )
    foreach ($l in $labels) {
        gh label create $l[0] --color $l[1] --description $l[2] --force | Out-Null
        Write-Ok $l[0]
    }

    if ($ComandoTeste) {
        Write-Passo 'Comando de regressao no CI'
        gh variable set REGRESSION_CMD --body $ComandoTeste
        Write-Ok "variavel REGRESSION_CMD = $ComandoTeste"
    }

    if ($AplicarProtecao) {
        Write-Passo 'Protecao da branch principal'
        $branch = gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
        Write-Host "    Vai exigir PR e os checks 'regressao', 'guarda-de-testes' e 'revisao-cruzada' verdes para qualquer merge em '$branch'."
        Write-Host '    Voce (admin) continua podendo forcar em emergencia.'
        $ok = Read-Host '    Aplicar agora? (s/N)'
        if ($ok -eq 's' -or $ok -eq 'S') {
            $corpo = @{
                required_status_checks        = @{ strict = $true; contexts = @('regressao', 'guarda-de-testes', 'revisao-cruzada') }
                enforce_admins                = $false
                required_pull_request_reviews = @{ required_approving_review_count = 0 }
                restrictions                  = $null
                allow_force_pushes            = $false
                allow_deletions               = $false
            } | ConvertTo-Json -Depth 5
            $tmp = New-TemporaryFile
            [IO.File]::WriteAllText($tmp.FullName, $corpo, (New-Object Text.UTF8Encoding $false))
            gh api -X PUT "repos/{owner}/{repo}/branches/$branch/protection" --input $tmp.FullName | Out-Null
            Remove-Item $tmp.FullName
            if ($LASTEXITCODE -eq 0) { Write-Ok "protecao aplicada em $branch" }
            else { Write-Aviso 'o GitHub recusou. Em repositorio privado, protecao de branch exige plano pago (GitHub Pro/Team).' }
        } else {
            Write-Aviso 'protecao nao aplicada.'
        }
    }
} finally {
    Pop-Location
}

Write-Passo 'Pronto'
Write-Host '  Revise os arquivos novos, faca commit e push numa branch, e abra um PR para o CI rodar a primeira vez.'
