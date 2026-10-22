# Estado do projeto

Memória compartilhada entre Claude e Codex. Leia antes de começar e atualize ao terminar cada tarefa.
Regra: o que está em "Já funciona" não se mexe sem pedido explícito do dono.

## Já funciona (e o teste que trava)

| O quê | Teste que trava |
| --- | --- |
| Portões do CI: regressão, guarda de testes, revisão cruzada | `tests/smoke.test.js` e o próprio CI |
| Trava de escopo do PR | `tests/trava-de-escopo.test.js` |
| Trava e guarda escrevem a saída em UTF-8 (nomes com acento ficam certos mesmo com `PYTHONIOENCODING=cp1252`, o padrão do Windows) | `tests/trava-de-escopo.test.js` |
| Modelo local com modos dia/noite (`local/modo.ps1 dia` ou `noite`) | `tests/modelo-local.test.js` |
| O vigia de prioridade inicia mesmo quando a pasta do projeto tem espaços no caminho | `tests/modelo-local.test.js` |
| Papéis trocáveis quando a cota acaba (orquestra/trocar.ps1, orquestra/chamar.js) | tests/papeis.test.js |
| Regra de quando mandar tarefa para o modelo local (`AGENTS.md`) | `tests/regra-modelo-local.test.js` |
| Proteção do PC no modelo local: memória livre antes de carregar, `num_gpu 99` (nunca processador), log do servidor | `tests/protecao-local.test.js` |
| Kit que leva as regras para o repo de outro app (`ferramentas/preparar-repo.ps1` + `ferramentas/kit-arquivos.json`) | `tests/preparar-repo.test.js` |
| Travas do canal Claude↔Codex: hooks do Claude Code (`.claude/settings.json`, `.claude/hooks/canal.js`: SessionStart mostra o canal, Stop bloqueia se o Codex ficou sem resposta) e regra global do Codex (`ferramentas/codex-agents-global.md` → `~/.codex/AGENTS.md`) | `tests/hooks-canal.test.js` |
| Canal de coordenação Claude↔Codex fora do git (`D:\MixAI-coordenacao\coordenacao.md`), citado em `AGENTS.md`, `CODEX.md` e `CLAUDE.md`; `docs/memoria/coordenacao.md` é só um ponteiro (ponto único) | `tests/canal-coordenacao.test.js` |
| Regras que o Qwen aprendeu de verdade ficam em `orquestra/regras-locais.json` (só confirmadas, palavras-chave específicas); primeira: `teste-mesmo-arquivo` | `tests/regras-locais.test.js` |
| Preparação do repo para se o GitHub CLI falhar ao criar uma label ou definir `REGRESSION_CMD`; não anuncia sucesso falso | `tests/preparar-repo.test.js` |
| Escada do modelo local: tenta no local, sobe para Codex/Claude, vira regra, registra caso para treino (`orquestra/escada.js`) | `tests/escada.test.js` |
| Microtarefas em paralelo no Qwen, com escopo, verificador e limite de agentes (`escada.js lote`) | `tests/escada.test.js` |
| Loop de tentativas com reinstrução do modelo grande, checagem antagônica (também na regra aprendida) e falhas resolvidas viram regressão (`orquestra/falhas/`) | `tests/escada.test.js` e `tests/falhas-escada.test.js` |
| Grafo persistente de tarefas (etapa 6): dependências, estados, tarefas prontas, travadas, validação de ciclo e escopo, gravação atômica (`orquestra/grafo.js`, `orquestra/grafo.json`) | `tests/grafo.test.js` |
| Mapa do código e da memória (etapa 4): índice de funções por arquivo e linha e do que já foi feito, para os modelos grandes não relerem o projeto (`node orquestra/mapa.js gerar`, `conferir`, `buscar`; saída em `docs/memoria/mapa.json` e `mapa.md`) | `tests/mapa.test.js` (inclui conferir que o mapa real está em dia) |
| Aplicação de resposta limitada ao escopo: pasta exige `/` final, comparação de maiúsculas segue o sistema, e nomes com `:` ou reservados do Windows são recusados sem gravar | `tests/aplicar.test.js` |
| Local sem resposta (memória/placa) não conta como falha do Qwen: não gasta tentativa nem vira regressão; a tarefa sobe direto | `tests/escada.test.js` |
| Aplicação de resposta limitada ao escopo: recusa caminhos fora da raiz ou do escopo sem gravar, e lista alterações fora do escopo | `tests/aplicar.test.js` |
| Mapa do código e da memória (etapa 4): índice de funções por arquivo e linha e do que já foi feito, gerado localmente e no CI, sem arquivos versionados (`node orquestra/mapa.js gerar`, `conferir`, `buscar`; saída em `docs/memoria/mapa.json` e `mapa.md`) | `tests/mapa.test.js` (geração determinística, busca atual e arquivos ignorados) |

## Em andamento

- (nada)

## Apps a trazer para o sistema (`/integrar-app`)

- **LangGraphicus** (primeiro da fila, decidido pelo dono em 2026-10-21): app de criar sólidos conversando e poder editar. O código está só no PC do dono; nada dele está no GitHub ainda. Primeiro passo em casa: `ferramentas\preparar-repo.ps1 -Repo <pasta do LangGraphicus>`, depois `/integrar-app`.
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

- Após o #19, abrir PR próprio para a coleta de uso: a capacidade deve considerar outros lotes e sessões do Ollama (`orquestra/paralelismo.js`); ausência da instância de decodificação de vídeo não pode significar "em uso" para sempre (`orquestra/paralelismo.js`, `local/uso-windows.ps1`); leitura de GPU sem `pid_` não pode virar uso zero (`local/uso-windows.ps1`). Cobrir os três casos com testes antes da correção.
- Na nuvem (sem PowerShell) 3 testes ficam vermelhos por falta de `pwsh`: `modelo-local.test.js` (2 do `modo.ps1`) e `protecao-local.test.js` (num_gpu 99). Passam no PC do dono; na nuvem, comparar só com a `main`.
- O texto de `orquestra/ESCADA.md` ainda diz que `tests/mapa.test.js` confere se o arquivo salvo está em dia; atualizar essa frase numa tarefa que inclua o arquivo no escopo.
- O teste do acento na trava foi relatado como vermelho no Windows do dono, mas não se reproduziu quando o Codex rodou na `main` (57/57). A saída em UTF-8 é endurecimento: não se sabe de onde veio aquele vermelho. Se voltar, guardar o texto da falha antes de mexer.
- O `claude` do terminal não está logado ("Not logged in"). Sem isso o Claude não executa por `orquestra/chamar.js`. O dono precisa rodar `claude` uma vez e entrar com a conta.

- `tests/instalar.test.js` falha às vezes no PC do dono quando a memória está quase cheia (falhou 2 de 9 também na main). Não é falha do instalador; investigar numa tarefa própria.
- Ligar o vigia e a `escada.js` ao grafo (`orquestra/grafo.js`): hoje só o planejador e o Codex o usam pela linha de comando. Tarefa própria, mexe em arquivos de outras etapas.
- Testar o qwen3.5:4b (modo dia) e o qwen3.5:9b (modo noite) quando houver espaço e tempo.
- Avaliar o local-delegate (segundo Claude Code rodando no modelo local, conferido por `npm test`) para o modo noite.
- O `AGENTS.md` copiado pelo kit cita `orquestra/` e `local/`, que só existem no MixAI. No repo de outro app esses comandos não existem; falta decidir se ele chama os scripts pela pasta do MixAI ou se o kit passa a levar essas pastas.
- O `preparar-repo.ps1` não foi rodado num Windows de verdade depois do conserto (a sessão na nuvem não tem PowerShell). Rodar uma vez numa pasta de teste antes de usar no LangGraphicus.
