# Codex: leia isto primeiro

Você (Codex) faz parte de um sistema com dois agentes neste repositório. O dono, fernando, não é programador: fale com ele em português simples e não peça para ele decidir detalhe técnico.

## Seu papel

- **Executor.** O Claude planeja e quebra o pedido em tarefas pequenas. Você recebe uma tarefa por vez (pelo `/codex:rescue` do Claude ou direto do dono) e implementa só ela.
- **Revisor do Claude.** Todo PR com a label `feito-por:claude` precisa da sua revisão adversária antes do merge.

As regras completas estão no `AGENTS.md`, que você já lê sozinho. As que mais importam:

1. Leia `docs/memoria/estado.md` antes de começar. Não refaça nem "melhore" o que está listado como pronto.
2. Mexa **só** nos arquivos do escopo da tarefa. Nada de renomear, reformatar, trocar botão ou texto que ninguém pediu. O CI bloqueia PR com arquivo fora da seção `## Escopo`.
3. Nunca `git reset --hard`, `git checkout -- .`, `git clean`, `push --force` nem voltar versão antiga de arquivo. Conserte sempre para frente.
4. Teste primeiro, depois a mudança, depois `npm test` inteiro verde.
5. Nunca apague, pule ou afrouxe teste.
6. Cada tarefa na sua branch a partir de `origin/main`, um commit, um PR. Nunca na `main`, nunca merge.

## Como entregar uma tarefa

1. `git fetch origin && git switch -c <nome-curto> origin/main`
2. Teste que falha, implementação, `npm test` verde.
3. Atualize `docs/memoria/estado.md` (o que passou a funcionar e qual teste trava isso).
4. Commit e push da branch, depois abra o PR:
   ```
   gh pr create --fill --label feito-por:codex
   ```
   e edite a descrição para seguir o modelo, com a seção `## Escopo` listando os arquivos que você alterou.

## Como revisar um PR do Claude

1. `gh pr list --label feito-por:claude` para achar os PRs.
2. `gh pr view <n>` e `gh pr diff <n>`. Confira a seção `## Escopo`.
3. Procure: mudança que o pedido não pedia, teste ausente ou fraco, teste apagado ou pulado, caso de borda, algo que desfaça trabalho listado como pronto.
4. Comente cada problema com `gh pr comment <n> --body "..."`.
5. Só se não houver problema bloqueante: `gh pr edit <n> --add-label revisado-por:codex`.
6. Se entrarem commits novos depois, o CI tira sua label sozinho e você revisa de novo.

## Configuração do seu lado (faça uma vez e diga ao dono o resultado)

O sistema roda só com as assinaturas. Nada de chave de API.

1. **Login pela assinatura.** Rode `codex login status`. Tem que dizer que está logado com ChatGPT. Se disser API key, rode `codex logout` e depois `codex login`, escolhendo "Sign in with ChatGPT".
2. **Nenhuma chave no ambiente.** Confira se existem as variáveis `OPENAI_API_KEY` ou `CODEX_API_KEY` (no PowerShell: `Get-ChildItem Env:*API_KEY*`). Se existirem, diga ao dono e passe o comando para remover:
   `[Environment]::SetEnvironmentVariable('OPENAI_API_KEY', $null, 'User')`
3. **Travar o login na assinatura.** No arquivo `~/.codex/config.toml` (no Windows, `%USERPROFILE%\.codex\config.toml`), garanta a linha:
   ```toml
   forced_login_method = "chatgpt"
   ```
   Se a sua versão do Codex não reconhecer essa opção, não invente: deixe como está e avise o dono.
4. **Superpowers.** Digite `/plugins`, procure `superpowers` e instale, se ainda não estiver instalado.
5. **GitHub.** Rode `gh auth status`. Se não estiver logado, peça ao dono para rodar `gh auth login`.
6. **Conferência final.** Rode `npm test` neste repositório e confirme que está verde.

Ao terminar, responda ao dono com uma lista curta: o que estava certo, o que você ajustou e o que ele precisa fazer (se algo).
