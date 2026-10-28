# Plano pequeno da rodada em sombra do Qwen

Regra da sombra: um tipo só é liberado com pelo menos 20 tentativas nas últimas 20 e 90% de acerto (`PADRAO` em `orquestra/sombra.js`). Por isso o plano tem 80 tarefas: 20 por tipo, o mínimo para algum tipo poder ser liberado.

Objetivo: medir, com tarefas que uma máquina confere, em quais tipos de tarefa o Qwen local (`mixai-local`) já acerta o suficiente para ser liberado. Na rodada o Qwen só responde e é conferido; nada sobe para Claude/Codex, não gasta cota e não mexe no código do projeto.

Precisa do PC ligado (Ollama + GPU). Nada disso roda na nuvem.

## Material pronto

- `docs/planos/sombra-plano-80.json`: 80 tarefas (20 de cada tipo: `data-iso`, `contar-vogais`, `inverter-texto`, `regex-digitos`), semente 7, cada uma com o comando `verificar` embutido.
- Para gerar outro plano: `node orquestra/sombra-plano/gerar-plano.js <quantidade> <semente> > plano.json`.

## Passo a passo (na raiz do repositório, no PC)

1. `npm test` — confirma a linha de base verde (no PC, sem as 3 falhas da nuvem).
2. `node orquestra/sombra.js rodar docs/planos/sombra-plano-80.json` — roda o Qwen nas 80 tarefas e grava cada tentativa no registro da sombra. Esperado: "N certas, M erradas, K sem resposta".
3. `node orquestra/sombra.js relatorio` — taxa de acerto por tipo.
4. `node orquestra/sombra.js liberar` — grava a tabela de liberação (quais tipos o Qwen pode assumir).
5. Opcional, para comparar outro aluno: `node orquestra/sombra.js rodar <plano> --modelo <nome> --comando "<comando>"` e depois `node orquestra/sombra.js comparar`.
6. Se um tipo ficar perto de 90%, gerar um plano novo com outra semente e rodar esse arquivo novo (rodar o mesmo arquivo de novo repete as mesmas tarefas e infla a taxa): `node orquestra/sombra-plano/gerar-plano.js 80 8 > docs/planos/sombra-plano-80-s8.json`, depois `node orquestra/sombra.js rodar docs/planos/sombra-plano-80-s8.json`, e repetir 3 e 4. A janela considera as últimas 20 tentativas por tipo.
7. Se a GPU estiver lenta, não divida o arquivo à mão: gere planos menores com sementes diferentes (`gerar-plano.js 40 9 > plano-40-s9.json`, depois `gerar-plano.js 40 10 > plano-40-s10.json`) e rode cada arquivo uma vez; as tentativas somam no mesmo registro. Nunca rode o mesmo arquivo duas vezes para o mesmo fim.

## Como ler o resultado

- Tipo `LIBERADO`: o lote pode deixar o Qwen resolver sozinho, com `lote ... --liberacao`.
- Tipo `não liberado`: continua subindo a escada normal (regra, Claude/Codex). Não é falha, só falta de dados ou de acerto.
- "Sem resposta" alto indica problema de GPU/Ollama, não do modelo; resolver antes de interpretar as taxas.

## Depois da rodada

- `node orquestra/escada.js lote <arquivo> --estatico --liberacao` usa a tabela gerada.
- Registrar em `docs/memoria/estado.md` as taxas por tipo e quais tipos foram liberados.

## O que fica de fora

- Tarefas de código real do projeto (a sombra só mede tipos conferíveis por máquina).
- Qualquer chamada de API paga.
