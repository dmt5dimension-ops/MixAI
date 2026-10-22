# Escada do modelo local

Ideia: tarefa bem delimitada tenta primeiro o modelo local (`mixai-local`, grátis). Se errar, sobe para o Codex ou o Claude. A solução vira uma regra com exemplo, o local tenta de novo com a regra, e se acertar a regra fica salva para as próximas vezes.

## Quem decide o quê

- **O Claude (planejador) decide se a tarefa cabe no local.** O teste de 2026-10-21 mostrou que o 7B erra ao julgar o tamanho da tarefa, então ele nunca decide isso.
- Cabe no local: tarefa mecânica, com entrada e saída pequenas e uma forma automática de conferir (um comando que sai com 0 se a resposta está certa). Não cabe: planejar, revisar, mexer em vários arquivos, lógica nova.
- Sem `--cabe-no-local`, o local nem é chamado e a tarefa vai direto para o Codex (e depois o Claude, se o Codex estiver sem cota). A ordem está em `orquestra/escada.json`.

## Como usar

```
node orquestra/escada.js resolver tarefa.txt --cabe-no-local --verificar "node confere.js"   # --verificar é obrigatório
node orquestra/escada.js regras      # lista as regras salvas
node orquestra/escada.js exportar    # gera orquestra/casos/treino.jsonl
```

## Proteção do PC

- O modelo local é chamado sempre por `node local/rodar-local.js` (a escada e o `chamar.js` já fazem isso). Ele confere a memória livre do Windows antes de carregar o modelo. Abaixo do mínimo de `local/protecao.json` (2 GB), ele não chama o Ollama e sai com erro, e a tarefa sobe para o Codex.
- O `mixai-local` é criado com `num_gpu 99`, que pede o modelo inteiro na placa de vídeo. Como isso sozinho não garante, o `rodar-local.js` primeiro carrega o modelo sem tarefa e confere onde ele ficou (`/api/ps`). Se parte do modelo foi para o processador, ou se não der para conferir, ele descarrega na hora e sai com erro sem rodar a tarefa. No processador o modelo ocupou 8,2 GB de RAM e travou o PC.
- **O MCP `local-llm` não tem essas proteções.** Ele chama o Ollama direto, sem conferir a memória e sem conferir a placa; vale só o `num_gpu 99`. Use o MCP só para pedido avulso e curto, e o `rodar-local.js` (escada) para trabalho em série.
- **Proibido** mandar `num_gpu: 0` (ou qualquer opção que tire o modelo da placa) pela API do Ollama ou no Modelfile. Um teste (`tests/protecao-local.test.js`) recusa isso em `orquestra/` e `local/`.
- O log do servidor fica em `%LOCALAPPDATA%\Ollama\mixai-servidor.log` (recriado a cada `local\modo.ps1`). Procure `offloaded` para ver se o modelo foi para a placa.

## O que fica guardado

- `orquestra/regras-locais.json`: regras confirmadas. Só entra aqui a regra com a qual o local **realmente acertou**; regra que não funcionou é descartada. Cada regra tem palavras-chave, texto, exemplo, quem escreveu e quando.
- `orquestra/casos/casos.jsonl`: um caso por linha, com entrada, regra, saída certa, quem resolveu (`local`, `codex` ou `claude`) e data. Tarefa que ninguém acertou não é registrada, para não ensinar erro.
- `orquestra/casos/treino.jsonl`: exportação em pares `messages` (usuário e assistente) pronta para um treino LoRA do Qwen. O treino em si ainda não foi feito.

Sobre a pausa por falta de cota (`orquestra/chamar.js`, PR dos papéis trocáveis): a escada ainda só pula o agente que falhar na hora; ligar as duas coisas fica para depois que aquele PR entrar.

## Lote de microtarefas (etapa 1)

O Qwen nunca assume a produção. O Claude ou o Codex quebra o trabalho num plano (`plano.json`, uma lista) e o Qwen executa uma microtarefa por vez, várias ao mesmo tempo:

```
[{"id":"botao-1","instrucao":"Devolva só o novo texto do botão: Salvar.","contexto":"trecho mínimo, até 1500 caracteres","escopo":["src/botao.js"],"verificar":"node confere-botao.js"}]
node orquestra/escada.js lote plano.json --paralelo 2
```

- Nesta etapa o Qwen só devolve texto e o `verificar` recebe essa resposta; aplicar a resposta nos arquivos (sempre dentro do `escopo`) vem na etapa 3.
- Plano mal delimitado é recusado: cada microtarefa precisa de instrução, escopo (arquivos que pode tocar), comando de verificação e contexto pequeno.
- Cada agente local recebe só a sua microtarefa. Microtarefas com escopo que se sobrepõe nunca rodam juntas.
- Uma que falha sobe a escada normal (Codex, depois Claude) e não derruba as outras.
- Paralelismo padrão 1 (`paralelismoPadrao` em `escada.json`). Com 8 GB de placa, o `OLLAMA_NUM_PARALLEL` do modo dia está em 1, então mais agentes só enfileiram no Ollama; subir isso e ajustar pelo uso do PC é a etapa 5.

## Loop de tentativas (etapa 2)

`node orquestra/escada.js lote plano.json --tentativas 3 --antagonico`

- O Qwen tenta. Se o verificador reprova, o modelo grande recebe a tarefa e o erro, descobre a causa e escreve uma instrução nova (alternando Codex e Claude; se um está sem cota, vai o outro). O Qwen tenta de novo com a instrução.
- Estourou o limite de tentativas: o grande resolve direto.
- Cada falha que acabou resolvida vira um caso de regressão em `orquestra/falhas/falhas.jsonl` (resposta certa e o comando que confere). `tests/falhas-escada.test.js` confere para sempre que a resposta certa continua passando. Falha que ninguém resolveu vai para `orquestra/falhas/pendentes.jsonl`, que não entra nos testes.
- Com `--antagonico`, a resposta só vale se outro agente grande (nunca o que produziu) não achar defeito. O modelo local nunca faz esse papel. Se nenhum outro grande puder conferir (sem cota), a resposta não vale e a tarefa fica em `pendentes.jsonl`.

## Grafo persistente de tarefas (etapa 6)

`orquestra/grafo.json` guarda as tarefas, quem depende de quem e em que estado cada uma está. `orquestra/grafo.js` é a biblioteca e a linha de comando; o supervisor (vigia) e a escada leem e gravam o mesmo arquivo.

- Tarefa: `id`, `titulo`, `estado` (`pendente`, `em_andamento`, `feita`, `falhou`), `depende` (ids), `agente` (`claude`, `codex`, `local`), `escopo`, `verificar`, `tentativas`, `atualizado`, `resultado`.
- "Pronta" não é um estado gravado: é a tarefa `pendente` cujas dependências estão todas `feita`. `node orquestra/grafo.js proximas` lista as prontas, e é isso que o supervisor usa para mandar o agente da tarefa seguinte começar.
- `iniciar <id> <agente>` só aceita tarefa pronta; `concluir` e `falhar` só aceitam tarefa `em_andamento`. `falhar` devolve a tarefa à fila; na 3ª falha ela vira `falhou` e as dependentes aparecem como `travada` no `status`.
- Todo comando que grava valida o grafo antes: recusa dependência que não existe, ciclo e duas tarefas `em_andamento` com o mesmo arquivo no escopo. A gravação é atômica (arquivo temporário e troca), e arquivo corrompido dá erro sem ser apagado.
- Exemplos: `node orquestra/grafo.js add t1 "Título" --agente codex --depende t0 --escopo src/a.js`, `iniciar t1 codex`, `concluir t1 "PR #20"`, `status`.

## Mapa do código e da memória (etapa 4)

`node orquestra/mapa.js gerar` cria `docs/memoria/mapa.json` e `mapa.md`: cada arquivo `.js`/`.ps1` com a descrição (primeira linha de comentário), as funções com a linha, e a lista do que já funciona e qual teste trava (lida do `estado.md`).

- Modelo grande: antes de ler arquivos, rode `node orquestra/mapa.js buscar <termo>` e abra só o trecho indicado.
- Mudou código ou `estado.md`? Rode `gerar` de novo. `node orquestra/mapa.js conferir` sai com 1 se o mapa está velho, e `tests/mapa.test.js` faz a mesma conferência.
- Quem altera o grafo usa sempre `atualizar` (a linha de comando já usa): ele tranca o arquivo (`grafo.json.lock`), relê, muda, valida e grava. Trava de processo morto (mais de 60 s) é removida por um só processo de cada vez; quem perder a trava no meio da operação não grava. `salvar` é só a gravação atômica de baixo nível, sem trava.
