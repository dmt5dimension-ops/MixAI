# Skills (.md) como camada de habilidade do Qwen local

**Data:** 21/10/2026. **Pergunta:** dá para os modelos grandes condensarem skills validadas pela comunidade em receitas curtas para o Qwen 7B, e isso também servir aos grandes? **Não repete** o dossiê do Codex (`docs/pesquisa/dossie-orquestracao-2026-10-21.md`, PR #8), que mapeia o Qwen e o ciclo de receitas verificáveis.

## Opinião curta

**Viável, mas como receita curta por tipo de microtarefa, não como skill inteira.** Uma skill do tipo `SKILL.md` assume que o modelo lê um texto longo, escolhe a skill certa e segue um fluxo de vários passos. O Qwen 7B com 1500 caracteres de contexto não faz isso bem. O que funciona é a skill ser a **fonte** e a receita ser o **produto compilado**: o modelo grande lê a skill, extrai 3 a 6 linhas e 1 exemplo, e a escada só aceita a receita se o Qwen acertar com ela (já é a regra da escada).

Encaixe: a receita é uma **regra da escada** (`orquestra/regras-locais.json`: `id`, `regra`, `exemplo`, `palavras`, `status`) com origem registrada. Nenhum mecanismo novo de execução; muda só quem escreve a regra (grande, a partir de uma skill) e de onde ela vem (`origem: skill:<nome>@<versão>`).

## O que a pesquisa mostra

| Achado | Fonte | O que significa para o MixAI |
| --- | --- | --- |
| Skills **curadas** subiram o acerto em média 16,2 pontos (de +4,5 em engenharia de software a +51,9 em saúde); em 16 de 84 tarefas pioraram. | [SkillsBench](https://arxiv.org/abs/2602.12670) | Skill ajuda, mas não sempre. Cada receita precisa de teste antes/depois, como a escada já faz. |
| Skills **geradas pelo próprio modelo** não ajudaram (média −1,3 ponto). | SkillsBench | Qwen não deve escrever as próprias receitas. Quem escreve é o grande, e o Qwen só valida. |
| Skills **focadas** (2 a 3 módulos) deram +18,6; 4 ou mais, +5,9; documentação **abrangente** piorou (−2,9). Compactas e detalhadas foram as melhores. | SkillsBench | Confirma o limite de ~1500 caracteres: curta e específica ganha de completa. |
| Modelo menor com skill pode igualar um maior sem skill (Haiku 4.5: 11% → 27,7%). | SkillsBench | Sustenta a ideia, mas os modelos testados são da família grande; **nenhum é um 7B local**. |
| Modelos **muito pequenos** falham em achar/escolher a skill certa; o ganho grande aparece em 30B a 80B (testado de 270M a 80B, em duas tarefas de classificação). | [Agent Skill Framework, small models](https://arxiv.org/abs/2602.16653) | O Qwen 7B **não deve escolher** a skill. O orquestrador escolhe por tipo de microtarefa (já é assim: `escolherRegras` por palavra-chave). |
| Memória procedural construída por modelo forte, passada a um modelo fraco, deu ganho substancial. | [Memp](https://arxiv.org/abs/2508.06433) | É exatamente o fluxo grande → Qwen. Apoia a ideia. |
| Reaproveitar **trajetória bruta** frequentemente bateu a skill destilada, porque a abstração perde pistas. | [SkillEvolBench](https://benchmarklist.com/benchmarks/skillevolbench_benchmarking_the_evolution_from_episodic_experience_to_procedural_skills/) | A receita deve levar **exemplo real** (entrada → saída), não só regra abstrata. A escada já exige `exemplo`. |
| Guia da Anthropic: skill enxuta, exemplos concretos, scripts para o que é determinístico, **testar com Haiku, Sonnet e Opus** porque o que serve ao Opus pode precisar de mais detalhe para o Haiku, e criar avaliações antes de escrever. | [Boas práticas de skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) | Mesma disciplina da escada: o teste do Qwen é o árbitro. "Parte determinística vira script" bate com a regra do Fernando de que o que Python prova não vai para o modelo. |

**Limite honesto:** não achei benchmark de SKILL.md em um 7B local nem thread de Reddit/HF com playbook para Qwen2.5-Coder 7B; o que existe é indireto (estudos com modelos maiores ou memória procedural). A hipótese "receita curta ajuda o 7B" **precisa ser medida aqui**, e a escada já é o instrumento de medida.

### Skills mais citadas pela comunidade (para servir de matéria-prima)

Repositórios citados em listas e posts (contagem de estrelas **não verificada** no GitHub, vem de posts): `anthropics/skills` (oficial), superpowers, Awesome Claude Skills, Addy Osmani Agent Skills, alirezarezvani/claude-skills. Fonte: [Analytics Vidhya](https://www.analyticsvidhya.com/blog/2026/03/github-repositories-to-get-free-claude-code-skills/). Popularidade não é validação: SkillsBench mostra que o efeito varia muito por domínio. Usar como matéria-prima, nunca como receita pronta.

## O que existe no PC e é reaproveitável

Nada disso é do repositório MixAI; está em `E:\`. Só leitura, nada foi copiado ainda.

| Onde | O que é | Reaproveitar? |
| --- | --- | --- |
| `E:\HarnessLangGraph\worker_skills\` (6 arquivos de 1 a 2 KB: `coder`, `verifier`, `critic`, `general_worker`, `local_planner`, `cadquery`) | **Skills curtas feitas para modelo local 7B**: regras diretas, status fixos (`CANDIDATE/UNABLE/CONFLICT`), "nunca pense que passou sozinho". | **Sim, é o melhor achado.** Já têm o tamanho certo. Viram receitas-base por papel (programar, verificar, criticar, decompor). Cabem em ~1500 caracteres quase sem corte. |
| `E:\HarnessLangGraph\docs\ADR-0005-small-model-role-assignment.md` e `config\models.local.yaml` | Medição (`ollama show`) de 7 modelos locais: quais têm chamada de ferramenta nativa (6 de 7), papéis sugeridos (nuextract para extração, openfugu 3B para planejar, granite 2B como família alternativa, gemma 1B sem ferramentas). Campo `skills_compatible` por modelo. | **Sim.** Dá a lista de quais skills cada modelo local aceita. Também tem o aviso de um incidente: documentar papel ≠ ligar roteamento. |
| `E:\HarnessLangGraph\harness\context_router.py` | Roteador que entrega ao worker **só** o contexto que o nó cita; dentro do orçamento, solta o descritivo primeiro e **nunca** corta restrição. | **Sim, a ideia.** É a regra "máx. 1500 caracteres" bem feita: receita crítica nunca é cortada, texto descritivo vai primeiro. |
| `E:\HarnessLangGraph\harness\pattern_memory.py` e ADR-0004/0005 | Memória append-only de padrões promovidos (só depois de passar em gates) e plano adiado de LoRA no Qwen 1.5B. | **Ideia sim, código não.** É o mesmo ciclo recuperar → reusar → registrar da escada, ligado a CAD. |
| `E:\HarnessLangGraph\CLAUDE.md` | Invariantes: LLM não é verdade, worker não se aprova, o que Python prova não vai para o modelo, decomposição limitada. | **Sim**, já alinhado com o `AGENTS.md` do MixAI. |
| `E:\HarnessLangGraph\.claude\skills\orchestrate` e `evolve` (5 KB cada) | Skills do Claude Code para compilar dossiê em grafo e escalar. | Só como referência de desenho; são para o grande, não para o Qwen. |
| `E:\HarnessLangGraph-cad-learning\skills\langraphicus-cad\SKILL.md` e `C:\Users\Fe\.codex\skills\` (n8n-*, esp32-cyd-*, fascilitando, frontend-design, code-review…) | Skills de domínio já prontas do Fernando. | **Matéria-prima** para destilar por domínio (n8n, ESP32). Skills grandes: só o grande lê, o Qwen recebe receita. |
| `E:\langgraphos-v2\docs\REUSE_MAP.md`, `E:\harnessFork\OpenFugu_CANONICAL` (skills openspec) | Mapa de o que extrair/descartar do harness antigo; skills de fluxo OpenSpec. | Mapa de reuso: consultar antes de portar qualquer coisa. Não é prioridade para a escada. |
| `E:\HarnessLangGraph\.harness\checkpoints.sqlite` (288 MB) | Estado de execuções antigas. | Não reaproveitar; só pode servir de fonte de casos reais se o Fernando quiser. |

Não encontrei skills em `C:\Users\Fe\.qwen\skills` (vazio). Os discos `D:\` e `E:\` têm também projetos sem relação (3D, Android, jogos), ignorados.

## Como encaixar na escada (proposta, sem implementar)

1. **Receita = regra da escada com origem.** Acrescentar `origem` (skill e versão) e `tipo` (ex.: `extrair-campos`, `reformatar`, `classificar`, `rascunho-teste`) às regras. Sem formato novo.
2. **Compilador de skill (feito pelo grande).** Entrada: uma skill + tipo de microtarefa. Saída: no máximo ~800 caracteres de regra + 1 exemplo real + critério de verificação. Parte determinística (formatação, validação de JSON) vira script, não texto.
3. **Porta de entrada = a escada que já existe.** A receita nasce `candidata` e só vira `confirmada` quando o Qwen acerta com ela no verificador, e **não piora** o grupo de tarefas já aprovadas (regressão). Receita que não ajuda é descartada, como os 16 de 84 do SkillsBench.
4. **Seleção pelo orquestrador**, não pelo Qwen: por `tipo` e palavra-chave, no máximo 2 receitas por microtarefa (SkillsBench: 2 a 3 módulos ganha de 4 ou mais).
5. **Os grandes usam a mesma receita** como checklist curto: é a skill já condensada, com a vantagem de ter exemplo e verificador. Ganho menor para eles (Opus 4.6 ganhou 13,9 pontos com skills curadas), então não otimizar por aí.
6. **Estimativa de ganho a medir primeiro:** 1 tipo de microtarefa, 10 casos reais, Qwen sem receita × com receita do grande. Se não passar de empate, parar.

## Riscos

- Receita de skill popular pode ter efeito **negativo** no domínio do Fernando; só a medição decide.
- Receita escrita pelo próprio Qwen não presta (SkillsBench); manter o grande como autor.
- Skill de terceiros é texto não confiável: compilar e revisar antes de entrar em `regras-locais.json`; nunca copiar comando ou link de skill para dentro de receita.
- Licença das skills da comunidade: conferir antes de redistribuir; guardar só a destilação e a origem.

## Aviso ao Codex (evitar duplicação)

Esta pesquisa cobre: skills como camada do Qwen, estudos SkillsBench/Memp/SkillEvolBench, guia de autoria da Anthropic e o inventário de `E:\HarnessLangGraph` e afins. **Não cobre:** quem é melhor em quê, a matriz de tarefas, o piloto do Qwen e o ciclo LoRA (isso é o dossiê do PR #8). Se o Codex for medir receitas, o ponto de partida é o item 6 acima. Nenhum arquivo de `orquestra/` foi tocado.
