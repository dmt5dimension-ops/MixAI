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
- O `mixai-local` é criado com `num_gpu 99`, que pede o modelo inteiro na placa de vídeo. Como isso sozinho não garante, o `rodar-local.js` confere depois de cada resposta (`/api/ps`). Se parte do modelo foi para o processador, ele descarrega na hora, não entrega a resposta e sai com erro. No processador o modelo ocupou 8,2 GB de RAM e travou o PC.
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
