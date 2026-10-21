# Estado do projeto

Memória compartilhada entre Claude e Codex. Leia antes de começar e atualize ao terminar cada tarefa.
Regra: o que está em "Já funciona" não se mexe sem pedido explícito do dono.

## Já funciona (e o teste que trava)

| O quê | Teste que trava |
| --- | --- |
| Portões do CI: regressão, guarda de testes, revisão cruzada | `tests/smoke.test.js` e o próprio CI |
| Trava de escopo do PR | `tests/trava-de-escopo.test.js` |

## Em andamento

- (nada)

## Apps a trazer para o sistema (`/integrar-app`)

- 3D Maker / criador de sólidos e gráficos paramétricos mecânicos
- App de atendimento
- Fluxo de e-mail (hoje com bugs e lento)

## Decisões

- Claude planeja e revisa; Codex executa. Tamanho da tarefa define o esforço (`--effort low/medium/high`).
- Só assinaturas (Claude Pro/Max e ChatGPT) pelas CLIs. Nenhuma chave de API.
- Todo PR declara o escopo; o CI bloqueia arquivo fora dele.

## Ideias e problemas vistos (não consertar sem tarefa própria)

- (nada)
