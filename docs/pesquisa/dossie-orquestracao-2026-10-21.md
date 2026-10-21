# Dossiê de orquestração: Claude Code, Codex e modelo local

**Data da pesquisa:** 21 de outubro de 2026. **Critério:** equilíbrio entre acerto, tempo e consumo das assinaturas. **Uso:** escolher quem recebe uma tarefa e como conferir o resultado. Neste texto, “Cloud” significa Claude Code; “LALA” é um futuro modelo local ainda não avaliado.

## Resposta prática

1. **Claude Code** começa pedidos ambíguos, delimita escopo e divide trabalho. No único comparativo controlado do MixAI, ele respeitou melhor o pedido; isso é uma preferência local provisória, não uma vitória universal. [L1]
2. **Codex** executa tarefas delimitadas e com prova objetiva, especialmente quando já existe uma skill especializada neste PC. Para interface, n8n e ESP32, a vantagem operacional atual é principalmente a disponibilidade dessas skills; ainda falta teste pareado que prove superioridade do modelo nessas áreas.
3. **Revisão:** o agente diferente daquele que implementou revisa. Testes, verificações automáticas e, em firmware, execução no dispositivo continuam necessários. Nenhum placar geral substitui essa regra.
4. **Modelo local atual:** `mixai-local` aponta para `qwen2.5-coder:7b`, com contexto de 4096 tokens de dia e 8192 à noite. Ele recebe somente trabalho mecânico e curto, e um agente principal confere a saída. O futuro LALA começa com o mesmo limite até passar por avaliação própria. [L2]

Estas são regras de **encaminhamento no MixAI**, não afirmações de que um modelo seja intrinsecamente melhor em toda tarefa. O modelo, a versão da ferramenta, o acesso a ferramentas, a skill e o teste disponível mudam o resultado. Um estudo da Hugging Face encontrou 94% de sucesso para Claude Code/Sonnet 4.6 e 93% para Codex/GPT-5.5 nas mesmas tarefas quando ambos usaram a CLI `hf`; com a skill dessa CLI, os dois fizeram cerca de 30% menos chamadas de ferramenta, sem ganho claro de acerto. Isso ilustra por que ferramenta e skill precisam aparecer junto do nome do agente. [S3]

## O que foi medido e o que ainda é hipótese

| Evidência | Resultado útil | Limite para esta decisão |
| --- | --- | --- |
| **MixAI, comparação local** [L1] | Em três tarefas de fila de e-mail, ambos passaram nos testes ocultos de conserto; Claude manteve melhor o escopo no caso médio e no plano. | Uma rodada por agente, mini-projeto, modelos e condições de execução diferentes. Não sustenta ranking por linguagem ou domínio. |
| **Hugging Face, 18 tarefas de Hub, cerca de mil execuções** [S3] | Com `hf` CLI, Claude/Sonnet 4.6 teve 94% e Codex/GPT-5.5 93%; sem CLI, 84% e 92%. A skill reduziu passos. | Testa operações no Hub, versões anteriores às disponíveis hoje; não mede qualidade de interface ou firmware. |
| **CCBench, 187 tarefas de programação** [S4] | Codex/GPT-5.2 teve 75,4%; Claude Code/Opus 4.6, 72,7%. | Fevereiro de 2026; tarefas pequenas e modelos antigos. A diferença não deve ser extrapolada para qualquer projeto. |
| **VISTA, 10 aplicações feitas a partir de Figma** [S5] | Codex/GPT-5.6 Sol marcou 0,507; Claude Code/Opus 4.7, 0,504: praticamente empate naquela configuração. | Não testa nossas skills, modelos atuais nem todos os estilos de front-end. |
| **Agent Security League, 200 tarefas Python** [S6] | Mesmo os melhores pares agente/modelo ficaram abaixo de 38% em código simultaneamente funcional e seguro. | Mede geração segura, não qualidade de uma revisão de PR específica. O resultado reforça conferência independente. |
| **Estudo de firmware ESP32, 420 execuções** [S7] | O fechamento do ciclo compilar → executar → observar → corrigir separou resultados; modelos locais menores perderam eficiência. | Não compara Claude Code com Codex; usa ESP32 simulado e cinco tarefas. Não autoriza declarar vencedor em firmware real. |
| **Documentação dos fornecedores** [S1][S2][S8] | Explica capacidades, modelos e quando carregar skills, subagentes e ferramentas. | É guia de produto, não teste imparcial de Claude contra Codex. |
| **Relatos de Reddit e GitHub** [C1][C2] | Trazem casos de uso e falhas percebidas, inclusive opiniões contraditórias sobre UI e planejamento. | Amostras escolhidas pelos autores, condições desiguais; servem para propor testes, não para fechar o ranking. |

**Confiança da matriz:** **alta** quando há regra do projeto ou verificação direta da disponibilidade da ferramenta; **média** quando uma fonte independente mede tarefa semelhante; **baixa** quando a escolha depende de experiência local pequena, documentação de fornecedor ou julgamento operacional. “Inconclusivo” significa que nenhum vencedor foi demonstrado. Os números acima não comparam cotas de assinatura: preços por token publicados para API não medem o custo do plano já pago.

### Ferramentas e skills disponíveis neste ambiente

- **Claude Code 2.1.97:** no projeto há `/pedido` e `/integrar-app`, além dos agentes `explorador` e `revisor`. No perfil do usuário aparecem a skill `parametric-3d-printing` e o plugin Figma. O terminal `claude` consta como não autenticado na memória do projeto; uma recomendação que dependa dele só pode executar após o login. [L2]
- **Codex CLI 0.163.0:** a configuração local observada usa `gpt-6-sol` com esforço `high` por padrão. Estão instaladas skills como `frontend-design`, `code-review`, `react-native-best-practices`, as famílias `n8n-*` e `esp32-cyd-*`, `byd-cyd-can-copilot`, `esp32-cyd-firmware-copilot`, `fascilitando` e `parametric-3d-printing`. Disponibilidade **não** comprova vantagem; a skill deve ser carregada apenas quando seu assunto coincide com a tarefa. [L2]
- **Sem skill** é uma opção deliberada para mudanças simples com testes claros. Skills são instruções e recursos para um fluxo específico; sobrecarregar o agente com muitas delas pode consumir contexto e até criar orientações conflitantes. [S2][S8]
- Plugins e serviços externos dependem de conexão e permissões no momento de uso. Um nome instalado não garante que a ferramenta esteja acessível naquele turno.

## Matriz de tarefas

Em “primeiro” aparece quem recebe a tarefa **neste projeto**; o agente alternativo assume se houver falta de cota, falta de acesso ou reprovação num teste pareado. “Baixa” quer dizer preferência a validar, nunca licença para pular os testes. O esforço é o de raciocínio, não uma promessa de tempo.

### 1. Entender, planejar e organizar

| Tarefa | Primeiro; skill ou nenhuma | Alternativa | Como conferir; confiança |
| --- | --- | --- | --- |
| Entender pedido vago e separar o que foi pedido do que é apenas ideia | Claude/Opus; `/pedido` | Codex/alto, sem skill | Plano com objetivo, limites, critério de pronto e itens fora do pedido. **Média**, pelo caso local [L1]. |
| Descobrir arquivos e fluxo existente, só leitura | Claude/agente `explorador`; sem skill adicional | Codex/baixo, sem skill | Caminhos, linhas e testes existentes conferidos no repositório. **Alta** para o papel configurado; desempenho relativo não medido [L2]. |
| Desenhar arquitetura e comparar soluções | Claude/Opus; `/pedido` | Codex/alto como segunda opinião | Contratos, riscos, migração e cenário de falha explícitos; um segundo agente contesta as suposições. **Baixa**. |
| Dividir trabalho, definir escopo e ordem de PRs | Claude/Opus; `/pedido` | Codex/alto quando Claude indisponível | Cada tarefa tem arquivos permitidos, teste e dependências; nenhuma execução na `main`. **Média** [L1][L2]. |
| Pesquisar biblioteca, padrão ou documentação que mudou | Agente que vai implementar; sem skill genérica | Outro agente valida pontos críticos | Fonte primária, versão e data ligados a cada decisão. **Inconclusivo**; não há comparação controlada. |
| Estimar tamanho, risco e esforço | Claude/Opus; `/pedido` | Codex/alto | Comparar com diff, testes e tempo após algumas tarefas reais. **Baixa**; o modelo local está excluído por decisão do projeto [L2]. |
| Especificar UX ou fluxo clínico de app existente | Claude/Opus; `/pedido` | Codex/médio com `fascilitando` quando for esse app | Protótipo/critério observável e validação do dono sobre o fluxo, não sobre detalhe técnico. **Baixa**. |

### 2. Interfaces, web, mobile e desktop

| Tarefa | Primeiro; skill ou nenhuma | Alternativa | Como conferir; confiança |
| --- | --- | --- | --- |
| Criar página web ou componente visual | Codex/médio; `frontend-design` | Claude/Opus, sem skill de front-end verificada neste perfil | Abrir no navegador, comparar capturas em larguras diferentes, testar interações. **Baixa**: VISTA mostrou resultado próximo com versões antigas e sem esta skill [S5]. |
| Ajustar CSS, responsividade e tema claro/escuro | Codex/médio; `frontend-design` | Claude/Sonnet, sem skill específica | Capturas mobile/desktop, contraste, quebra de texto e ausência de regressão visual. **Baixa**. |
| Acessibilidade de formulário e navegação por teclado | Codex/médio; `frontend-design` | Claude/Sonnet | Teclado, foco visível, rótulos e verificador automático; conferir casos manualmente. **Baixa**. |
| Traduzir um desenho Figma em código | **Inconclusivo**; usar o agente com acesso confirmado ao arquivo e à ferramenta Figma | O outro agente, se tiver o mesmo acesso | Comparação visual e funcional tela a tela; benchmark VISTA é contexto, não teste das conexões locais [S5]. |
| Estado de UI, formulários e regras de interação | Codex/médio; `frontend-design` se houver interface visual; nenhuma se for lógica isolada | Claude/Sonnet | Testes de transição, erros, teclado e regressão visual. **Baixa**. |
| Aplicativo React Native, lentidão e animação | Codex/médio; `react-native-best-practices` | Claude/Opus | Medir FPS, travamentos, memória e tempo de abertura em dispositivo. **Baixa**; escolha motivada pela skill instalada. |
| Electron e fluxo do Fascilitando | Codex/médio; `fascilitando` | Claude/Opus | Teste do fluxo clínico afetado, build e conferência da interface no app. **Baixa**; restrita a esse produto. |
| Jogo pequeno em ESP32 CYD: tela, HUD e movimento | Codex/médio; skill `esp32-cyd-game-*` correspondente à etapa | Claude/Opus | Compilação, FPS/legibilidade em 320×240 e teste na placa. **Baixa**; não extrapolar para qualquer game engine. |

### 3. Aplicação, dados e IA

| Tarefa | Primeiro; skill ou nenhuma | Alternativa | Como conferir; confiança |
| --- | --- | --- | --- |
| API, backend e regra de negócio bem especificada | Codex/médio; nenhuma | Claude/Sonnet | Contrato, testes de sucesso/erro e compatibilidade com clientes. **Baixa**; CCBench só dá contexto geral [S4]. |
| Serviço distribuído, fila e idempotência | Claude/Opus planeja com `/pedido`; Codex/alto implementa parte delimitada, sem skill | Inverter execução e revisão se houver cota | Testes de duplicação, perda de confirmação, concorrência e reinício. **Média** para a cautela de escopo no exemplo local [L1]. |
| Banco de dados, consultas e migração de esquema | **Inconclusivo**; Codex/médio, sem skill, como executor padrão | Claude/Opus | Migração em cópia, rollback planejado, índice e compatibilidade de dados. Piloto pareado necessário. |
| Processamento de dados, ETL e planilhas | Codex/médio; skill de planilha se estiver acessível, senão nenhuma | Claude/Sonnet | Totais, linhas de borda, esquema e amostra conferida por cálculo independente. **Baixa**. |
| Integração HTTP, webhook e autenticação | Codex/médio; nenhuma | Claude/Sonnet | Testes com timeout, 429, credencial ausente, repetição e resposta inválida. **Baixa**. |
| Fluxo n8n | Codex/médio; `n8n-workflow-patterns` e a skill específica de nó/expressão/código | Claude/Sonnet | Validação do fluxo e execução com dados de exemplo e erros. **Baixa**; vantagem operacional é o material instalado. |
| Aplicação com OpenAI API ou agentes OpenAI | Codex/médio; `openai-docs` | Claude/Opus, usando documentação oficial | Exemplo executável, contrato da API, falhas e avaliação de saída. **Baixa** para superioridade relativa; **alta** para adequação da documentação [S1][S8]. |
| Aplicação com Claude API | Claude/Sonnet ou Opus; nenhuma skill local específica verificada | Codex/médio com docs oficiais Anthropic | Exemplo executável, contrato, limites e avaliação. **Baixa**. |
| RAG, busca semântica e avaliação de respostas | **Inconclusivo**; Claude/Opus define avaliação, Codex/médio implementa componentes | Inverter as funções num piloto | Conjunto de perguntas ocultas, citações corretas, latência e falhas. Não medir por “parece bom”. |
| Hugging Face Hub e modelos abertos | **Inconclusivo**; agente com `hf` CLI disponível, sem presumir skill instalada | Outro agente com a mesma CLI | Conferir o estado real no Hub; o estudo mostrou quase empate com CLI [S3]. |
| Pesquisa de modelo local e quantização | Codex/alto; nenhuma skill genérica | Claude/Opus | Rodar tarefa igual no hardware real, medir acerto, VRAM, latência e contexto. **Baixa**; estudos com modelos maiores não cabem automaticamente neste PC [S7][L2]. |

### 4. Qualidade, manutenção e entrega

| Tarefa | Primeiro; skill ou nenhuma | Alternativa | Como conferir; confiança |
| --- | --- | --- | --- |
| Bug isolado com teste que reproduz | Codex/médio; nenhuma | Claude/Sonnet | Teste falha antes, passa depois e suíte inteira continua verde. **Média**: empate no caso pequeno local [L1]. |
| Bug difícil que atravessa várias peças | Claude/Opus delimita hipóteses; Codex/alto executa conserto em partes | Codex/alto investiga e Claude revisa | Reprodução, causa demonstrada, teste de regressão e diff dentro do escopo. **Baixa**. |
| Teste unitário e de regressão | Codex/baixo ou médio; nenhuma | Claude/Sonnet | Falha sem o conserto e cobre comportamento observável, não só texto no arquivo. **Baixa**. |
| Teste de integração, E2E e contrato | **Inconclusivo**; Codex/médio, sem skill, como executor padrão | Claude/Sonnet | Serviço real ou substituto fiel, cenário de erro e execução em CI. |
| Refatoração grande e migração de código | Claude/Opus planeja com `/pedido`; Codex/alto executa lotes pequenos | Claude implementa e Codex revisa | Testes de comportamento, compatibilidade e comparação de desempenho. **Baixa**; alegações de fornecedor não são teste local [S9]. |
| Revisar PR e procurar regressões | **Sempre o outro agente**: Claude com `revisor` quando Codex fez; Codex com `code-review` quando Claude fez | Se só o autor tem cota, aguardar | Revisão do diff, escopo, teste, casos de borda e CI; proibição de autoaprovação é regra do projeto. **Alta** [L2]. |
| Segurança de código e dados sensíveis | Agente diferente do implementador; `code-review` no Codex ou `revisor` no Claude | Segunda revisão e ferramenta de análise estática | Testes negativos, análise de dependências, segredo e configuração; benchmark mostra falhas frequentes em ambos [S6]. **Alta** para exigir verificação, **inconclusivo** para vencedor. |
| Desempenho e uso de memória | Claude/Opus formula hipótese; Codex/médio implementa mudança medida, sem skill genérica | Inverter num teste pareado | Perfil antes/depois na mesma carga, sem perder correção. **Baixa**. |
| CI, scripts, build e automação | Codex/médio; nenhuma | Claude/Sonnet | Executar no sistema-alvo e em caso de falha; teste que só lê o script não prova que ele roda. **Baixa**. |
| Dependências e atualização de biblioteca | Codex/médio; nenhuma | Claude/Sonnet | Documentação da versão, build, regressão e incompatibilidade conhecida. **Baixa**. |
| Operação, deploy e observabilidade | Claude/Opus planeja risco; Codex/médio executa procedimento validado, sem skill genérica | Inverter se o executor já conhece o ambiente | Ensaio, rollback, sinais de saúde e monitoramento. **Baixa**. |
| Documentação técnica e texto para o dono | Claude/Sonnet; nenhuma | Codex/médio | Exemplo verificável, link funcionando e leitura clara por pessoa não técnica. **Baixa**; preferência editorial, sem benchmark comparável. |

### 5. Firmware, hardware e ferramentas físicas

| Tarefa | Primeiro; skill ou nenhuma | Alternativa | Como conferir; confiança |
| --- | --- | --- | --- |
| ESP32/CYD: build, flash, boot e recuperação | Codex/médio; `esp32-cyd-firmware-copilot` | Claude/Opus | Compilar, gravar, reiniciar e ler serial na placa específica. **Baixa** para vencedor; skill local é específica [S7]. |
| Display, touch, SPI e desempenho gráfico CYD | Codex/médio; `esp32-cyd-game-hardware` ou `esp32-cyd-game-integration` | Claude/Opus | Tela real, toque, memória, FPS e reinício repetido. **Baixa**. |
| CAN/TWAI/OBD no BYD | Codex/alto; `byd-cyd-can-copilot` | Claude/Opus | Captura autorizada e somente leitura, documentação do sinal e comparação de logs. **Baixa**; não inferir sinal por semelhança. |
| Firmware de laboratório Bruce/Marauder/GhostESP | Codex/médio; `cyd-firmware-lab` | Claude/Opus | Build/flash e teste apenas no laboratório autorizado. **Baixa**. |
| Protocolo, temporização e controle embarcado | **Inconclusivo**; Claude/Opus especifica invariantes; Codex/alto implementa com skill ESP32 quando aplicável | Inverter em piloto pareado | Simulador, logs, timeout, falha de sensor e placa real. O estudo reforça ciclo fechado, sem comparar estes dois agentes [S7]. |
| CAD/peça para periférico do projeto | Codex/médio; `parametric-3d-printing` ou `langraphicus-cad` quando o fluxo pedir | Claude com `parametric-3d-printing` | Medidas, encaixe, exportação e teste físico. **Inconclusivo** entre agentes. |

## Regras para o orquestrador

1. **Começar pelo contrato:** pedido em português simples → critério observável → escopo de arquivos → teste que deve falhar hoje → executor. O planejador não implementa a própria tarefa. [L2]
2. **Escolher pelo risco e pelo acesso real:** se a tarefa é curta, testável e não precisa de conhecimento específico, usar Codex com esforço baixo/médio e nenhuma skill. Se precisa de domínio instalado, usar a skill correspondente. Se é ambígua ou atravessa decisões, começar com Claude/Opus e um plano curto.
3. **Não somar skills por assunto parecido:** usar somente a skill que muda a forma de executar ou conferir a tarefa. Skills de front-end não ajudam numa função de fila; skill de ESP32 não substitui uma leitura de serial. [S2][S8]
4. **Conferir de modo independente:** primeiro o executor roda a prova, depois o outro agente revisa diff e escopo. A ausência de acesso ao serviço, navegador ou placa vira limitação explícita, nunca “testado” por suposição.
5. **Troca por falta de cota:** seguir `orquestra/papeis.json`. O modelo local só produz rascunho mecânico curto, e o principal valida; ele nunca decide escopo, planeja ou revisa. Nenhum agente aprova o próprio PR. [L2]
6. **Não automatizar vitória por categoria ainda:** esta matriz é um ponto de partida. Só alterar a ordem fixa dos papéis depois de pilotos locais com tarefas representativas, repetidas e avaliadas sem mostrar os testes de nota ao agente.

## Experimentos que podem mudar a matriz

Executar cada candidato na **mesma revisão inicial**, com **mesmo enunciado e acesso**, em cópias isoladas. Fazer pelo menos três rodadas por tarefa, incluir falhas e anotar versão do modelo, CLI, esforço, skills e ferramentas. Um teste oculto ou uma verificação externa deve avaliar a entrega; a frase “terminei” do agente não é prova. Esta separação é usada no estudo da Hugging Face e em um benchmark aberto de contexto entre Claude Code e Codex. [S3][S10]

| Piloto | Cenário e critério de nota |
| --- | --- |
| Interface visual | Mesmo Figma/brief, versão com e sem `frontend-design`; comparar responsividade, acessibilidade, aparência e funcionamento por captura e navegador. |
| Backend e dados | Bug de fila/idempotência, migração de banco e integração com timeout; medir testes ocultos, regressões e mudanças fora do escopo. |
| Segurança | Mesma tarefa com entrada maliciosa e segredo falso; medir vulnerabilidade, falso positivo e qualidade da revisão cruzada. |
| Firmware | Mesmo projeto ESP32, simulador e placa; medir build, boot, serial, timing, memória e recuperação de falha. Não pontuar só compilação. |
| Uso de skills | Mesmo agente e tarefa com/sem a skill correta; medir acerto, chamadas de ferramenta, tempo e correções manuais. |

**Ficha do futuro LALA:** nome e tamanho do modelo; versão/quantização; RAM/VRAM; contexto efetivo dia/noite; ferramenta usada; conjunto de tarefas; acerto em teste oculto; violações de escopo; tempo; necessidade de intervenção; falhas perigosas. Só ampliar seu papel quando ele igualar a qualidade exigida nas tarefas correspondentes. Até lá, manter rascunhos e extração curta. Um modelo local de 27B ter bom resultado em pesquisa de ESP32 não implica que caiba ou se comporte igual ao 7B deste PC. [S7][L2]

## Fontes e rastreabilidade

**Do projeto**

- [L1] [Comparativo MixAI, commit de 21/10/2026](https://github.com/dmt5dimension-ops/MixAI/blob/4ad493c/docs/memoria/comparativo-2026-10-21.md): uma rodada por agente, com testes ocultos; relato local, não publicação externa.
- [L2] [Estado e regras da branch `sistema/papeis-trocaveis`](https://github.com/dmt5dimension-ops/MixAI/blob/4ad493c/docs/memoria/estado.md), `AGENTS.md`, `orquestra/papeis.json`, `local/modos.json` e inventário local de skills/CLIs consultado em 21/10/2026. O estado pode mudar antes do merge deste dossiê.

**Documentação oficial e estudos**

- [S1] [OpenAI, seleção de modelos](https://developers.openai.com/api/docs/guides/model-selection): orienta escolha por complexidade e esforço; não compara diretamente com Claude.
- [S2] [Anthropic, extensões do Claude Code](https://code.claude.com/docs/en/features-overview): funções distintas de skills, subagentes, MCP e hooks.
- [S3] [Hugging Face, `hf` CLI para agentes](https://huggingface.co/blog/hf-cli-for-agents): 18 tarefas, repetições, resultado verificado no Hub; Claude Code/Sonnet 4.6 e Codex/GPT-5.5, estudo de 2026.
- [S4] [CodeCrafters CCBench](https://github.com/codecrafters-io/ccbench): 187 tarefas e logs publicados; placar de fevereiro de 2026 com modelos daquela época.
- [S5] [VISTA, aplicações web a partir de especificação visual](https://vista-benchmark.org/): 10 aplicações, 128 páginas e 458 pontos visuais; versões e esforço registrados no placar.
- [S6] [Endor Labs, Agent Security League](https://www.endorlabs.com/research/ai-code-security-benchmark): 200 tarefas Python com testes funcionais e de segurança; combinações agente/modelo datadas.
- [S7] [García-Carrasco et al., avaliação de firmware ESP32 em ciclo fechado](https://arxiv.org/abs/2610.11447): 5 tarefas, 4 regimes de feedback, 7 modelos, 3 repetições, 420 execuções; não inclui confronto Claude/Codex.
- [S8] [OpenAI, skills e prompts para GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra): limites de excesso de instruções e uso de skills específicas.
- [S9] [Anthropic, Claude Opus 5.5](https://www.anthropic.com/claude-opus-5-5): resultados e casos publicados pelo próprio fornecedor; tratar como evidência de menor independência.
- [S10] [Benchmark aberto de ciclo de contexto Claude/Codex](https://github.com/iannuttall/agent-context-benchmark): protocolo com avaliadores externos e três rodadas recomendado; não fornece vencedor universal.

**Comunidade: hipóteses, não placar**

- [C1] [Relato de desenvolvedor no r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/comments/1w6109q/claude_code_vs_codex/): favorece Codex em UI; experiência pessoal de dois apps.
- [C2] [Discussão no r/codex sobre planejamento e revisão](https://www.reddit.com/r/codex/comments/1td4gr9/codex_vs_claude_code/): percepção pessoal divergente do papel fixo do MixAI. Relatos não controlam modelo, esforço nem ferramentas.

**Revisão recomendada:** quando mudar um modelo principal, uma skill usada com frequência ou a forma de medir cota. Atualizar linhas afetadas e registrar novo teste local; não reescrever a matriz inteira por um relato isolado.
