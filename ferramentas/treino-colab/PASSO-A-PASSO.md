# Treinar o Qwen no Google Colab (passo a passo)

O Colab é um computador do Google, de graça, com placa de vídeo. Você só precisa da sua conta Google. Não usa API da Anthropic nem da OpenAI.

**Só faça quando o Claude avisar que há exemplos suficientes** (mínimo 20 de treino; o ideal é mais de 200).

1. No PC, abra a pasta do MixAI e rode `node orquestra/treino.js preparar`. Ele cria `treino.jsonl` e `validacao.jsonl` em `orquestra\casos`.
2. Entre em https://colab.research.google.com com a sua conta Google e escolha **Arquivo > Fazer upload do notebook**. Envie `ferramentas\treino-colab\treino-qwen.ipynb`.
3. Menu **Ambiente de execução > Alterar o tipo de ambiente de execução**, marque **GPU T4** e salve.
4. Clique no ▶ de cada bloco, de cima para baixo, esperando cada um terminar. No bloco 3 escolha os dois arquivos do passo 1.
5. No fim o navegador baixa um arquivo `.gguf`. Guarde-o em `D:\OllamaModels`.
6. Avise o Claude. Ele cria o `mixai-local-v2` no Ollama, mede a nota com `orquestra/avaliar.js` e só troca se a nota subir.

Se aparecer erro de memória, reinicie o ambiente (Ambiente de execução > Reiniciar sessão) e rode de novo desde o bloco 1. O notebook ainda não foi rodado de verdade: na primeira vez, se algo falhar, copie a mensagem de erro para o Claude.
