# Treino do Qwen sem supervisão no Kaggle (passo a passo)

O Kaggle empresta uma placa de vídeo grátis (cerca de 30 horas por semana, até 12 horas por sessão). O notebook roda sozinho: você aperta um botão e volta depois. Não usa API da Anthropic nem da OpenAI, e o Claude/Codex não participam do treino.

## O que ele faz (e o que não faz)
Em cada rodada: cria tarefas que um programa consegue conferir sozinho (converter data, escrever regex, escrever função Python com testes), o Qwen tenta, o programa corrige, o Qwen treina nos acertos e nos corrigidos e faz uma prova fixa. **Só guarda o modelo novo se a nota da prova subir.** Se nunca subir, não exporta nada.

**Limites honestos:** só aprende tarefas conferíveis por máquina. Não aprende a planejar, revisar nem julgar qualidade de código (não há juiz). Melhorar nesses tipos não prova que melhora no trabalho real do MixAI; por isso a nota final precisa ser conferida no PC com `orquestra/avaliar.js` antes de trocar o modelo.

## Uma vez só (preparar)
1. Crie conta em https://www.kaggle.com (pode entrar com a sua conta Google).
2. Em **Settings > Phone verification**, confirme o seu celular. Sem isso o Kaggle não libera GPU nem Internet.
3. Crie um Dataset: **Create > New Dataset**, nome `mixai-treino`, envie os 4 arquivos da pasta `ferramentas\treino-kaggle` (`geradores.py`, `ciclo.py`, `modelo_unsloth.py`, `loop_treino.py`; o Claude também deixa um `mixai-treino.zip` pronto). Clique em **Create**.
4. Crie o notebook: **Create > New Notebook > File > Import Notebook** e envie `treino-sem-supervisao.ipynb`.

## Toda vez que for rodar
1. No notebook, painel da direita: **Add Input** e escolha o Dataset `mixai-treino`. Na **segunda sessão em diante**, adicione também a *saída do notebook anterior* (Add Input > Notebook Output Files > o seu notebook): é assim que ele continua de onde parou.
2. Em **Session options**: **Accelerator: GPU T4 x2** (ou P100) e **Internet: On**.
3. Clique em **Save Version > Save & Run All (Commit)** e feche a janela. Leva até 11 horas e para sozinho antes do limite.
4. Quando terminar, abra o notebook > aba **Output**. Baixe a pasta `estado/ollama` (arquivo `.gguf` e `Modelfile`) e o `estado.json`.
5. Avise o Claude. No PC ele cria o modelo (`ollama create mixai-local-v2 -f Modelfile`), mede a nota com `orquestra/avaliar.js` e só troca se a nota subir.

## Se der erro
O código da GPU (`modelo_unsloth.py`) ainda **não foi rodado numa placa de verdade**. Na primeira vez, rode com poucas rodadas: troque `'--horas', '11'` por `'--horas', '0.3', '--lote', '4'` na última célula. Se aparecer erro, copie a mensagem para o Claude.
