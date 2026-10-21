# Estado do projeto

Memória compartilhada entre Claude e Codex. Leia antes de começar e atualize ao terminar cada tarefa.
Regra: o que está em "Já funciona" não se mexe sem pedido explícito do dono.

## Já funciona (e o teste que trava)

| O quê | Teste que trava |
| --- | --- |
| Portões do CI: regressão, guarda de testes, revisão cruzada | `tests/smoke.test.js` e o próprio CI |
| Trava de escopo do PR | `tests/trava-de-escopo.test.js` |
| Modelo local com modos dia/noite (`local/modo.ps1 dia` ou `noite`) | `tests/modelo-local.test.js` |

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
- Modelo local (2026-10-21): qwen2.5-coder:7b no Ollama, chamado sempre pelo nome `mixai-local`. O Claude usa pelas ferramentas do MCP `local-llm` (mcp-local-llm, instalado em `D:\MixAI-ferramentas\mcp-local-llm`, registrado no escopo de usuário do Claude Code). Modelos ficam em `D:\OllamaModels`.
- Uso do modelo local: só tarefa mecânica e bem empacotada (rascunho de teste, extrair dados, resumir, reformatar). Teste com 5 tarefas reais: acertou 4. Errou classificar tamanho de tarefa (chamou tudo de "pequena"), então não usar para classificar nem decidir.
- PC: RX 6600M 8 GB e 16 GB de RAM quase cheios. Acima de contexto 8192 o 7B não cabe.

## Ideias e problemas vistos (não consertar sem tarefa própria)

- Testar o qwen3.5:4b (modo dia) e o qwen3.5:9b (modo noite) quando houver espaço e tempo.
- Avaliar o local-delegate (segundo Claude Code rodando no modelo local, conferido por `npm test`) para o modo noite.
- Ainda não existe regra no `AGENTS.md` dizendo quando o planejador manda tarefa para o modelo local.
