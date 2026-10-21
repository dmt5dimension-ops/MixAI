# Regras para agentes deste repositório

Este arquivo vale para todos os agentes (Claude Code, Codex e qualquer outro). O Codex lê este arquivo diretamente; o Claude Code lê através do `CLAUDE.md`.

## Comando da suíte de regressão

```
npm test
```

Rode a suíte inteira antes de dizer que uma tarefa está pronta. Tarefa com teste vermelho não está pronta.

## Como trabalhar

1. **Uma tarefa por vez, pequena.** Se a tarefa toca mais de uns 5 arquivos ou mistura assuntos, divida antes de começar.
2. **Teste primeiro.** Escreva o teste que prova a tarefa, veja ele falhar, implemente, veja passar (fluxo TDD do Superpowers).
3. **Rode a regressão inteira**, não só o teste novo.
4. **Um commit por tarefa**, com mensagem que diga o que mudou e por quê.
5. **Nunca trabalhe na branch principal.** Cada tarefa vive na sua branch/worktree e chega na principal só por PR.

## Revisão cruzada (obrigatória)

Quem implementa nunca aprova o próprio trabalho.

- Ao abrir o PR, quem implementou coloca a label `feito-por:claude` ou `feito-por:codex`.
- O **outro** agente faz a revisão adversária: procura suposições erradas, casos de borda, teste fraco ou ausente, e mudança fora do escopo da tarefa. O Claude pode usar `/codex:adversarial-review`, e o Codex pode revisar o diff do PR diretamente.
- O revisor comenta os problemas no PR. Se não houver problema bloqueante, ele coloca a label `revisado-por:claude` ou `revisado-por:codex` (a do próprio revisor).
- O CI (`revisao-cruzada`) só fica verde quando as duas labels existem e são de agentes diferentes.

## O que nenhum agente pode fazer

- Apagar, enfraquecer ou pular teste (`skip`, `xfail`, `.only`, comentar asserção) para ficar verde. Se um teste estiver errado, explique no PR e deixe a decisão para o humano. O CI (`guarda-de-testes`) bloqueia isso.
- Colocar label `permitir-remocao-de-teste`. Essa label é só do humano.
- Dar push direto na branch principal, forçar push ou reescrever histórico compartilhado.
- Fazer merge do próprio PR.
- Colocar segredo, token ou senha em código, log ou commit.

## Definição de pronto

- Teste novo cobrindo a tarefa.
- Suíte de regressão inteira verde.
- PR com as labels `feito-por:*` e `revisado-por:*` de agentes diferentes.
- Descrição do PR dizendo o que mudou, como foi testado e o que ficou de fora.
