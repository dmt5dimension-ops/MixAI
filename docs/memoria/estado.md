# Estado do projeto

Memória compartilhada entre Claude e Codex. Leia antes de começar e atualize ao terminar cada tarefa.
Regra: o que está em "Já funciona" não se mexe sem pedido explícito do dono.

## Já funciona (e o teste que trava)

| O quê | Teste que trava |
| --- | --- |
| Portões do CI: regressão, guarda de testes, revisão cruzada | `tests/smoke.test.js` e o próprio CI |
| Trava de escopo do PR | `tests/trava-de-escopo.test.js` |
| Modelo local com modos dia/noite (`local/modo.ps1 dia` ou `noite`) | `tests/modelo-local.test.js` |
| Papéis trocáveis quando a cota acaba (orquestra/trocar.ps1, orquestra/chamar.js) | tests/papeis.test.js |
| Regra de quando mandar tarefa para o modelo local (`AGENTS.md`) | `tests/regra-modelo-local.test.js` |
| Proteção do PC no modelo local: memória livre antes de carregar, `num_gpu 99` (nunca processador), log do servidor | `tests/protecao-local.test.js` |

## Em andamento

- (nada)

## Apps a trazer para o sistema (`/integrar-app`)

- 3D Maker / criador de sólidos e gráficos paramétricos mecânicos
- App de atendimento
- Fluxo de e-mail (hoje com bugs e lento)

## Decisões

- Dossiê de orquestração (2026-10-21, `docs/pesquisa/dossie-orquestracao-2026-10-21.md`): matriz provisória por tipo de tarefa, com fonte, verificação e confiança. Inclui o Qwen2.5-Coder 7B local e uma proposta de receitas verificáveis, escalada e treino posterior; não altera `orquestra/papeis.json`. Decisões de promoção dependem de pilotos locais e revisão cruzada.
- Comparativo Claude x Codex (2026-10-21, `docs/memoria/comparativo-2026-10-21.md`): ordem dos papéis mantida; quem revisa o Codex procura mudança de comportamento que ninguém pediu.
- Papéis trocáveis (2026-10-21): detectar falta de cota pelo texto da mensagem de limite; pausar por 5 horas; o modelo local nunca planeja nem revisa.
- Claude planeja e revisa; Codex executa. Tamanho da tarefa define o esforço (`--effort low/medium/high`).
- Só assinaturas (Claude Pro/Max e ChatGPT) pelas CLIs. Nenhuma chave de API.
- Todo PR declara o escopo; o CI bloqueia arquivo fora dele.
- Modelo local (2026-10-21): qwen2.5-coder:7b no Ollama, chamado sempre pelo nome `mixai-local`. O Claude usa pelas ferramentas do MCP `local-llm` (mcp-local-llm, instalado em `D:\MixAI-ferramentas\mcp-local-llm`, registrado no escopo de usuário do Claude Code). Modelos ficam em `D:\OllamaModels`.
- Uso do modelo local: só tarefa mecânica e bem empacotada (rascunho de teste, extrair dados, resumir, reformatar). Teste com 5 tarefas reais: acertou 4. Errou classificar tamanho de tarefa (chamou tudo de "pequena"), então não usar para classificar nem decidir.
- PC: RX 6600M 8 GB e 16 GB de RAM quase cheios. Acima de contexto 8192 o 7B não cabe.
- Modelo local nunca no processador (2026-10-21): com a memória do Windows cheia, a placa não reservava espaço e o Ollama jogava o modelo no processador (8,2 GB de RAM, PC travado). Agora tudo passa por `local/rodar-local.js` (mínimo de 2 GB livres, em `local/protecao.json`), o `mixai-local` tem `num_gpu 99`, o `rodar-local.js` descarrega o modelo se parte dele foi para o processador, e `num_gpu: 0` é proibido. O MCP `local-llm` não passa por essas proteções (só o `num_gpu 99`); ver `orquestra/ESCADA.md`.

## Ideias e problemas vistos (não consertar sem tarefa própria)

- O `claude` do terminal não está logado ("Not logged in"). Sem isso o Claude não executa por `orquestra/chamar.js`. O dono precisa rodar `claude` uma vez e entrar com a conta.

- `tests/instalar.test.js` falha às vezes no PC do dono quando a memória está quase cheia (falhou 2 de 9 também na main). Não é falha do instalador; investigar numa tarefa própria.
- Testar o qwen3.5:4b (modo dia) e o qwen3.5:9b (modo noite) quando houver espaço e tempo.
- Avaliar o local-delegate (segundo Claude Code rodando no modelo local, conferido por `npm test`) para o modo noite.
