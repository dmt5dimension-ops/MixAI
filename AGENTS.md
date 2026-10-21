# Regras para agentes deste repositório

Este arquivo vale para todos os agentes (Claude Code, Codex e qualquer outro). O Codex lê este arquivo diretamente; o Claude Code lê através do `CLAUDE.md`.

O dono do projeto não é programador. Fale com ele em português simples, sem jargão, e nunca peça para ele decidir detalhe técnico: decida, explique em uma frase e siga.

## Comando da suíte de regressão

```
npm test
```

Rode a suíte inteira antes de dizer que uma tarefa está pronta. Tarefa com teste vermelho não está pronta.

## Antes de começar qualquer sessão

1. Leia `docs/memoria/estado.md`. Ele diz o que já funciona, o que está em andamento e o que foi decidido. Não refaça nem "melhore" o que está listado como pronto.
2. Rode `npm test` e confirme que está tudo verde antes de mexer em qualquer coisa. Se já estiver vermelho, avise e conserte isso primeiro, numa tarefa própria.

## Só mexer no que foi pedido (trava de escopo)

Esta é a regra mais importante. O projeto já perdeu trabalho porque agentes mexeram no que ninguém pediu.

- Toda tarefa começa declarando o **escopo**: a lista de arquivos ou pastas que ela pode alterar. Essa lista vai na seção `## Escopo` da descrição do PR.
- Não mude nada fora dessa lista. Isso inclui: renomear, reformatar, reorganizar imports, "aproveitar para arrumar", trocar texto ou cor de botão, atualizar dependência.
- Se descobrir que precisa mexer em outro arquivo, pare e explique o motivo. A tarefa é refeita com o escopo certo, ou o humano coloca a label `permitir-fora-do-escopo`.
- Achou um problema fora do escopo? Anote em `docs/memoria/estado.md`, na seção "Ideias e problemas vistos", e não conserte agora.
- O CI (`guarda-de-testes`) confere a lista e bloqueia o PR que mexe em arquivo fora dela. Arquivos de teste e `docs/memoria/` sempre podem mudar.

## Só avançar, nunca voltar

- Nunca use `git reset --hard`, `git revert` de trabalho dos outros, `git checkout -- .`, `git clean`, `git push --force` nem reescreva histórico compartilhado.
- Nunca restaure versão antiga de arquivo "porque estava melhor". Se algo quebrou, conserte para frente, com um teste que prove o conserto.
- Comece toda tarefa de uma branch nova criada a partir da principal atualizada (`git fetch` e branch a partir de `origin/main`).

## Travar o que funciona

- Toda funcionalidade que fica pronta ganha pelo menos um teste permanente que prova que ela funciona. Esse teste vira parte da regressão para sempre.
- Bug consertado ganha um teste que falhava antes do conserto. Assim o bug não volta.
- Ao fechar a tarefa, atualize `docs/memoria/estado.md`: o que passou a funcionar e qual teste trava isso.

## Como trabalhar

1. **Uma tarefa por vez, pequena.** Se a tarefa toca mais de uns 5 arquivos ou mistura assuntos, divida antes de começar.
2. **Teste primeiro.** Escreva o teste que prova a tarefa, veja ele falhar, implemente, veja passar (fluxo TDD do Superpowers).
3. **Rode a regressão inteira**, não só o teste novo.
4. **Um commit por tarefa**, com mensagem que diga o que mudou e por quê.
5. **Nunca trabalhe na branch principal.** Cada tarefa vive na sua branch/worktree e chega na principal só por PR.

## Quem faz o quê (economia de tokens)

Tudo roda pelas CLIs logadas nas assinaturas (Claude Pro/Max e ChatGPT). Nunca configure chave de API.

| Papel | Quem | Quando |
| --- | --- | --- |
| Planejar e dividir o pedido em tarefas | Claude, modelo maior (Opus), sessão interativa | Começo de cada pedido |
| Executar tarefa grande ou delicada (lógica, várias peças, bug difícil) | Codex via `/codex:rescue --effort high` | Tarefas marcadas como **grande** no plano |
| Executar tarefa média | Codex via `/codex:rescue --effort medium` | Tarefas **média** |
| Executar tarefa pequena e mecânica (texto, estilo, um teste) | Codex via `/codex:rescue --effort low`, ou o subagente `executor-leve` | Tarefas **pequena** |
| Achar arquivos e entender o código antes de planejar | subagente `explorador` (modelo menor, só leitura) | Antes do plano |
| Revisão adversária | O agente que **não** implementou: Claude com `/codex:adversarial-review` ou o subagente `revisor`, Codex revisando o diff | Todo PR |

Regras de economia:
- Cada executor recebe só o necessário: a tarefa, o escopo, o critério de pronto e o teste. Nada de despejar o projeto inteiro no contexto.
- Quem planeja não implementa e quem implementa não planeja de novo.
- Se uma tarefa falhar duas vezes, pare e devolva para o planejador quebrar em pedaços menores, em vez de insistir.

## Revisão cruzada (obrigatória)

Quem implementa nunca aprova o próprio trabalho.

- Ao abrir o PR, quem implementou coloca a label `feito-por:claude` ou `feito-por:codex`.
- O **outro** agente faz a revisão adversária: procura suposições erradas, casos de borda, teste fraco ou ausente, e mudança fora do escopo da tarefa. O Claude pode usar `/codex:adversarial-review`, e o Codex pode revisar o diff do PR diretamente.
- O revisor comenta os problemas no PR. Se não houver problema bloqueante, ele coloca a label `revisado-por:claude` ou `revisado-por:codex` (a do próprio revisor).
- O CI (`revisao-cruzada`) só fica verde quando as duas labels existem e são de agentes diferentes.

## O que nenhum agente pode fazer

- Apagar, enfraquecer ou pular teste (`skip`, `xfail`, `.only`, comentar asserção) para ficar verde. Se um teste estiver errado, explique no PR e deixe a decisão para o humano. O CI (`guarda-de-testes`) bloqueia isso.
- Colocar as labels `permitir-remocao-de-teste` ou `permitir-fora-do-escopo`. Essas labels são só do humano.
- Mexer em arquivo fora do escopo declarado da tarefa.
- Dar push direto na branch principal, forçar push, dar reset ou reescrever histórico compartilhado.
- Fazer merge do próprio PR.
- Colocar segredo, token ou senha em código, log ou commit.

## Definição de pronto

- Teste novo cobrindo a tarefa.
- Suíte de regressão inteira verde.
- Só arquivos do escopo alterados (CI verde no `guarda-de-testes`).
- `docs/memoria/estado.md` atualizado.
- PR com as labels `feito-por:*` e `revisado-por:*` de agentes diferentes.
- Descrição do PR dizendo o que mudou, o escopo, como foi testado e o que ficou de fora.
