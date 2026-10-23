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
| Kit: o `AGENTS.md` e o `CODEX.md` copiados para o repo de outro app chamam os scripts pela pasta do MixAI (fonte única, sem copiar `orquestra/` nem `local/`): `node "<MixAI>/orquestra/..."`, `-File "<MixAI>/orquestra/..."` e menções soltas, sem duplicar ao rodar de novo (`ferramentas/caminhos-mixai.js`, chamado pelo `preparar-repo.ps1`; ainda não rodado num Windows real) | `tests/caminhos-mixai.test.js` |
| Travas do canal Claude↔Codex: hooks do Claude Code (`.claude/settings.json`, `.claude/hooks/canal.js`: SessionStart mostra o canal, Stop bloqueia se o Codex ficou sem resposta) e regra global do Codex (`ferramentas/codex-agents-global.md` → `~/.codex/AGENTS.md`) | `tests/hooks-canal.test.js` |
| Canal de coordenação Claude↔Codex fora do git (`D:\MixAI-coordenacao\coordenacao.md`), citado em `AGENTS.md`, `CODEX.md` e `CLAUDE.md`; `docs/memoria/coordenacao.md` é só um ponteiro (ponto único) | `tests/canal-coordenacao.test.js` |
| Regras que o Qwen aprendeu de verdade ficam em `orquestra/regras-locais.json` (só confirmadas, palavras-chave específicas); primeira: `teste-mesmo-arquivo` | `tests/regras-locais.test.js` |
| Preparação do repo para se o GitHub CLI falhar ao criar uma label ou definir `REGRESSION_CMD`; não anuncia sucesso falso | `tests/preparar-repo.test.js` |
| Escada do modelo local: tenta no local, sobe para Codex/Claude, vira regra, registra caso para treino (`orquestra/escada.js`) | `tests/escada.test.js` |
| Microtarefas em paralelo no Qwen, com escopo, verificador e limite de agentes (`escada.js lote`) | `tests/escada.test.js` |
| Loop de tentativas com reinstrução do modelo grande, checagem antagônica (também na regra aprendida) e falhas resolvidas viram regressão (`orquestra/falhas/`) | `tests/escada.test.js` e `tests/falhas-escada.test.js` |
| Paralelismo pelo uso do PC (etapa 5): 1 agente usando o PC, sobe um por vez parado até o teto (modo, placa 8 GB, memória), `--paralelo auto`, vaga só reaproveitada com o processo abortado morto, limite 0 aceito, `OLLAMA_NUM_PARALLEL` pelo modo (`orquestra/paralelismo.js`, `local/uso-windows.ps1`) | `tests/paralelismo.test.js` (leituras simuladas) |
| Coleta de uso do PC mais rigorosa (acompanhamento do #19): GPU pelo motor mais carregado, VRAM e RAM medidas, CPU inconsistente = null, cobertura e CIM de reserva, sessão do console, estado do controle atômico com modo, prompt em pasta privada, modo gravado conferido | `tests/paralelismo.test.js` |
| Acompanhamento do #19 (b, c, d), só com leituras simuladas: linha malformada de CIM/processos vira leitura indisponível (null), leitura atual que falha vale 1 agente, saída vazia da consulta ao Job é inconclusiva. Falta validar no PC (sem PowerShell na nuvem) | `tests/paralelismo.test.js` (testes "(b)", "(c)", "(d)") |
| Grafo persistente de tarefas (etapa 6): dependências, estados, tarefas prontas, travadas, validação de ciclo e escopo, gravação atômica (`orquestra/grafo.js`, `orquestra/grafo.json`) | `tests/grafo.test.js` |
| Supervisor do grafo (etapa 1): decide despertares, cobranças, escaladas e tarefas locais; registra início/fim dos lotes que ele próprio chama, respeita cota, frequência, escopo e trava única; revisão vinculada ao head do PR e CLI `.cmd` no Windows; simulação sem efeitos (`orquestra/fofoqueiro.js`) | `tests/fofoqueiro.test.js` |
| Supervisor do grafo (etapa 2): `escada.js lote plano.json --grafo <arquivo>` marca as microtarefas do grafo como em_andamento antes, e feita/falha depois; tudo ou nada no início, ignora ids fora do grafo, erro do lote deixa em_andamento (`orquestra/escada.js`, `ligarAoGrafo`) | `tests/escada-grafo.test.js` |
| Supervisor do grafo (etapa 3): tarefa `em_revisao` cujo PR (número em `resultado`, ex.: `PR #30`) fica com CI vermelho volta a `em_andamento` no grafo, o autor é acordado e a devolução não repete no mesmo head; conflito de escopo escala em vez de lançar (`orquestra/fofoqueiro.js`, `devolucoesPorCI`) | `tests/fofoqueiro-ci.test.js` |
| Supervisor do grafo (etapa 4): PR mesclado conclui a tarefa `em_revisao` que o cita em `resultado` (libera as dependentes); PR fechado sem mesclar escala no canal; falha ao listar PRs fechados é ignorada e registrada (`orquestra/fofoqueiro.js`, `fechamentosDePR`, `listarPRsFechados`, consulta cada PR citado pelo número) | `tests/fofoqueiro-merge.test.js` |
| Mapa do código e da memória (etapa 4): índice de funções por arquivo e linha e do que já foi feito, para os modelos grandes não relerem o projeto (`node orquestra/mapa.js gerar`, `conferir`, `buscar`; saída em `docs/memoria/mapa.json` e `mapa.md`) | `tests/mapa.test.js` (inclui conferir que o mapa real está em dia) |
| Aplicação de resposta limitada ao escopo: pasta exige `/` final, comparação de maiúsculas segue o sistema, e nomes com `:` ou reservados do Windows são recusados sem gravar | `tests/aplicar.test.js` |
| Reserva de vagas entre lotes: o lote guarda cada agente (Job, PID e data de criação) e, com o dono morto, só cai quando eles acabam; erro de leitura mantém a reserva (só JSON inválido descarta); nada lento roda com a trava segurada; consulta de Job só leitura; agente gravado na reserva antes de rodar (barreira no wrapper); saída com agente vivo vira retenção | `tests/paralelismo.test.js` ("reserva de lote cujo dono morreu...", "o lote escreve na reserva os Jobs...", "erro de LEITURA da reserva...", "a consulta ao Job... FORA da trava", "a consulta de Job é só leitura...", "saindo com agente vivo...", "se a reserva com o agente não pode ser gravada...", "barreira...") |
| Local sem resposta (memória/placa) não conta como falha do Qwen: não gasta tentativa nem vira regressão; a tarefa sobe direto | `tests/escada.test.js` |
| Aplicação de resposta limitada ao escopo: recusa caminhos fora da raiz ou do escopo sem gravar, e lista alterações fora do escopo | `tests/aplicar.test.js` |
| Mapa do código e da memória (etapa 4): índice de funções por arquivo e linha e do que já foi feito, gerado localmente e no CI, sem arquivos versionados (`node orquestra/mapa.js gerar`, `conferir`, `buscar`; saída em `docs/memoria/mapa.json` e `mapa.md`) | `tests/mapa.test.js` (geração determinística, busca atual e arquivos ignorados) |
| Preparo do material de treino do Qwen (frente do aprendizado local): limpa os casos da escada, tira segredo, repetido e caso grande, separa treino/validação de forma estável e gera relatório (`node orquestra/treino.js preparar`). O treino LoRA em si ainda não foi feito (roda no PC) | `tests/treino.test.js` |
| Avaliação do Qwen nos exemplos de validação (nota antes/depois do treino): `node orquestra/avaliar.js rodar --comando "..."`; falha do agente conta como erro | `tests/avaliar.test.js` |
| Treino sem supervisão do Qwen (Kaggle/Colab): gera tarefas conferíveis por máquina (data, regex, função Python), Qwen tenta, treina nos acertos e corrigidos, só promove o modelo se a nota da prova fixa subir, guarda estado e continua na sessão seguinte (`ferramentas/treino-kaggle/`). Só o laço e os verificadores estão provados; o código da GPU (`modelo_unsloth.py`) nunca rodou numa placa | `tests/treino-kaggle.test.js` |

## Em andamento

- Ligação do `escada.js lote` com as transições do grafo quando o lote é chamado diretamente (etapa 2, tarefa separada). O supervisor já registra o início e o resultado dos lotes que ele próprio dispara; o `escada.js` independente ainda não registra `iniciar/concluir/falhar` no grafo.

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
- Guarda de memória desconta o modelo já carregado (2026-10-23): o `rodar-local.js` soma à memória livre a RAM PRIVADA dos runners do Ollama que o MixAI iniciou (`local/ram-runner.ps1`, mesmo critério do `uso-windows.ps1`; sem registro do `modo.ps1` o crédito é 0), no máximo o `size` do `/api/ps`, com piso de 0,25 GB livres; antes, depois da 1ª chamada o modelo carregado deixava só ~0,5 GB livres e toda chamada seguinte era recusada (29 de 30 tarefas "sem resposta" na sombra). Sem modelo carregado ou com falha no `/api/ps`, nada é descontado. Travado em `tests/protecao-local.test.js` (3 testes novos).

## Ideias e problemas vistos (não consertar sem tarefa própria)

- `local/uso-windows.ps1` e o `OLLAMA_NUM_PARALLEL` pelo modo foram conferidos no PC do dono em 2026-10-22 (JSON com os campos, vídeo detectado, suíte verde). Falta conferir de novo a versão que veio depois da revisão: contadores que falham viram `null`, CPU do Ollama por processo, e o `taskkill` do `lote` ao reduzir agentes (rodar `node orquestra/paralelismo.js` e um lote com `--paralelo auto`, voltando a mexer no PC no meio).
- Acompanhamento após o #19: `orquestra/paralelismo.js` recebe o número de agentes do lote atual, sem uma contagem global entre lotes ou sessões do Ollama. Medir e testar dois lotes simultâneos antes de definir um limite global em PR próprio.
- Na nuvem (sem PowerShell) 3 testes ficam vermelhos por falta de `pwsh`: `modelo-local.test.js` (2 do `modo.ps1`) e `protecao-local.test.js` (num_gpu 99). Passam no PC do dono; na nuvem, comparar só com a `main`.
- O teste do acento na trava foi relatado como vermelho no Windows do dono, mas não se reproduziu quando o Codex rodou na `main` (57/57). A saída em UTF-8 é endurecimento: não se sabe de onde veio aquele vermelho. Se voltar, guardar o texto da falha antes de mexer.
- O `claude` do terminal não está logado ("Not logged in"). Sem isso o Claude não executa por `orquestra/chamar.js`. O dono precisa rodar `claude` uma vez e entrar com a conta.

- `tests/instalar.test.js` falha às vezes no PC do dono quando a memória está quase cheia (falhou 2 de 9 também na main). Não é falha do instalador; investigar numa tarefa própria.
- Acompanhamento do paralelismo (etapa 5): feito no PR da coleta de uso (`etapa5b-coleta-uso`). Fica ainda: medir no PC a VRAM sob carga real (KV por requisição paralela) e a detecção de vídeo por software.
- Últimos pontos do Codex no #19, deixados como tarefa de acompanhamento (o #19 está verde no PC e a decisão de parar as rodadas foi da coordenação): (a) [resolvido na rodada seguinte: a raiz é lida logo depois do spawn e o pid de hoje nunca é adotado como raiz]; (b) linhas malformadas da consulta CIM são descartadas em silêncio; (c) foto atual que falha é ignorada quando já existe foto antiga; (d) saída vazia de `processoVivoComCriacao` é tratada como "morto" (processo sumiu), e o Codex quer separar de "consulta falhou"; (e) os 60 s de espera no erro fatal não são o prazo total (cada chamada ainda pode demorar mais depois). Antes de tratar, medir no PC se algum deles acontece de verdade.
- Ligar o vigia e a `escada.js` ao grafo (`orquestra/grafo.js`): hoje só o planejador e o Codex o usam pela linha de comando. Tarefa própria, mexe em arquivos de outras etapas.
- Testar o qwen3.5:4b (modo dia) e o qwen3.5:9b (modo noite) quando houver espaço e tempo.
- Avaliar o local-delegate (segundo Claude Code rodando no modelo local, conferido por `npm test`) para o modo noite.
- O `preparar-repo.ps1` não foi rodado num Windows de verdade depois do conserto (a sessão na nuvem não tem PowerShell). Rodar uma vez numa pasta de teste antes de usar no LangGraphicus.
