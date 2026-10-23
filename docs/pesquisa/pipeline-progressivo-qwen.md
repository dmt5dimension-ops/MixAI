# Pipeline progressivo do Qwen local

Objetivo: o Qwen (`mixai-local`) passa a executar o trabalho do próprio MixAI, começando pelo mais simples, e cada erro dele vira ensino: regra, caso de regressão e, mais adiante, treino. O Claude e o Codex planejam, revisam e resolvem o que o Qwen não consegue. Regra de ouro: o Qwen nunca planeja, revisa nem decide tamanho de tarefa (AGENTS.md).

## O que já existe (peças prontas)

| Peça | Onde | Papel no pipeline |
| --- | --- | --- |
| Escada (local, depois Codex/Claude) | `orquestra/escada.js resolver` | Executa e sobe quando o Qwen erra |
| Regra aprendida | `orquestra/regras-locais.json` | Ensino imediato: entra no prompt, só se o Qwen acertou com ela |
| Lote paralelo com escopo e verificador | `escada.js lote` | Muitas microtarefas por vez |
| Loop com reinstrução e checagem antagônica | `escada.js lote --tentativas --antagonico` | Grande ensina o pequeno antes de assumir |
| Falhas resolvidas viram regressão | `orquestra/falhas/` | Erro não volta |
| Casos e exportação de treino | `orquestra/casos/casos.jsonl`, `escada.js exportar` | Matéria-prima do treino |
| Preparo do treino (#37) | `orquestra/treino.js preparar` | Limpa, tira segredo, separa treino/validação |
| Avaliação (#39) | `orquestra/avaliar.js rodar` | Nota do modelo antes/depois |
| Supervisor e grafo | `orquestra/fofoqueiro.js`, `grafo.js` | Quem faz o quê, quando |

## Fases (cada uma só começa quando a anterior passa no seu portão)

**Fase 0 — Linha de base.** Medir o Qwen como está.
- Fazer: conjunto fixo de tarefas mecânicas (datas, regex, bloco de teste, reformatar) com verificador. Rodar `avaliar.js` e guardar a nota inicial por tipo de tarefa.
- Portão: nota de base registrada em `estado.md`. (Precisa do PC.)

**Fase 1 — Sombra.** O Qwen tenta toda tarefa elegível, mas a resposta que vale é a do Codex/Claude. Só comparamos.
- Fazer: modo `--sombra` na escada: roda o Qwen, guarda a resposta e a nota, não usa. Gera casos e descobre onde ele erra sem risco.
- Portão: pelo menos 30 casos comparados e relatório por tipo de tarefa.

**Fase 2 — Mecânico supervisionado.** O Qwen executa de verdade só tipos em que a nota passou do corte (sugestão: 90% nos últimos 20), sempre com verificador (`npm test` ou comando da microtarefa).
- Fazer: tabela `tipo de tarefa → nota → liberado?` em arquivo versionado; a escada só manda ao Qwen o que está liberado. Erro sobe a escada e gera regra.
- Portão: 2 semanas sem regressão causada por resposta do Qwen.

**Fase 3 — Aprender as regras.** Cada subida vira regra confirmada (só se o Qwen acerta com ela), com revisão humana das regras novas no PR.
- Fazer: limite de regras por prompt (cabe em 4096/8192 tokens), fusão de regras parecidas, remoção de regra que deixou de ajudar (medida pelo `avaliar.js` com e sem a regra).
- Portão: regra nova não piora a nota dos outros tipos.

**Fase 4 — Treino LoRA.** Quando houver volume (sugestão: 200+ exemplos limpos), treinar no PC com `treino.jsonl`, avaliar em `validacao.jsonl`.
- Fazer: script de treino no PC (Windows, GPU de 8 GB), versão do modelo com nome (`mixai-local-v2`), troca só se a nota subir e nada piorar; volta fácil para a anterior.
- Portão: nota nova maior que a antiga em validação separada.

**Fase 5 — O Qwen executa o próprio desenvolvimento.** Tarefas do grafo do tipo "pequena e mecânica" são entregues ao Qwen pelo supervisor; o autor do PR é o Qwen mais verificador, e a revisão cruzada continua obrigatória (Claude ou Codex).
- Portão: nenhuma tarefa de lógica nova; só as liberadas na Fase 2/3.

## Trabalho que dá para fazer na nuvem, em ordem

1. Casos semente verificáveis (20–30) para ter volume e a linha de base.
2. Modo `--sombra` na escada e relatório por tipo de tarefa.
3. Tabela de tipos liberados + a escada respeitando a tabela.
4. Medir regra com/sem (`avaliar.js` com variante de prompt).
5. Ligar o resultado da escada ao grafo (depois dos PRs #30–#33).

## Só no PC do dono

Nota de base real, treino LoRA, troca de versão do modelo, medir VRAM sob carga.

## Riscos e travas

- Segredo no treino: `treino.js` descarta; revisar o relatório antes de treinar.
- Treinar com erro: só entram casos que alguém acertou e o verificador confirmou.
- Contexto pequeno: 4096 (dia) e 8192 (noite); regra e tarefa precisam caber.
- Nunca `num_gpu: 0`; sempre por `local/rodar-local.js`.
