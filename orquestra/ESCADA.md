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
- Paralelismo padrão 1 (`paralelismoPadrao` em `escada.json`). O `OLLAMA_NUM_PARALLEL` vem do modo (dia 2, noite 3, em `local/modos.json`) e o número de agentes é ajustado pelo uso do PC na etapa 5 (abaixo).

## Loop de tentativas (etapa 2)

`node orquestra/escada.js lote plano.json --tentativas 3 --antagonico`

- O Qwen tenta. Se o verificador reprova, o modelo grande recebe a tarefa e o erro, descobre a causa e escreve uma instrução nova (alternando Codex e Claude; se um está sem cota, vai o outro). O Qwen tenta de novo com a instrução.
- Estourou o limite de tentativas: o grande resolve direto.
- Cada falha que acabou resolvida vira um caso de regressão em `orquestra/falhas/falhas.jsonl` (resposta certa e o comando que confere). `tests/falhas-escada.test.js` confere para sempre que a resposta certa continua passando. Falha que ninguém resolveu vai para `orquestra/falhas/pendentes.jsonl`, que não entra nos testes.
- Com `--antagonico`, a resposta só vale se outro agente grande (nunca o que produziu) não achar defeito. O modelo local nunca faz esse papel. Se nenhum outro grande puder conferir (sem cota), a resposta não vale e a tarefa fica em `pendentes.jsonl`.

## Paralelismo pelo uso do PC (etapa 5)

`node orquestra/escada.js lote plano.json --paralelo auto` deixa o número de agentes locais por conta de `orquestra/paralelismo.js`:

- **Usando o PC: 1 agente.** Conta como "usando": mexeu no teclado ou mouse há menos de 90 s, outro programa usa mais de 30% da placa ou 60% do processador (o próprio Ollama não conta), vídeo tocando (média de 3 leituras dos motores de decodificação da placa, `VideoDecode`, `video decode` ou `video codec`, acima de 1%; `video jpeg` e `video enhance` não contam; funciona sem administrador), ou a leitura do Windows falhou, inclusive se o contador de vídeo não existir (na dúvida, 1). Volta a 1 na hora.
- **Parado: sobe um por vez**, no mínimo 60 s entre uma subida e outra, até o teto. Na primeira chamada, o tempo que o PC já está parado conta como subida (parado há horas começa direto no teto; parado há pouco começa em 1). `node orquestra/paralelismo.js` mostra o alvo agora, o `regime` (onde chega se o PC continuar parado) e o motivo.
- **Teto = o menor de**: `agentesMax` do modo em `local/modos.json` (dia 2, noite 3), o que cabe na placa (8 GB menos pesos do modelo, reserva do Windows e cache de contexto de cada agente, números em `orquestra/paralelismo.json`), a memória livre acima do mínimo de `local/protecao.json` (0,5 GB por agente) e `maximoAbsoluto`.
- `local/modo.ps1` agora liga `OLLAMA_NUM_PARALLEL` com o `agentesMax` do modo (antes era sempre 1, então mais agentes só enfileiravam) e grava o modo ligado em `%LOCALAPPDATA%\Ollama\mixai-modo.txt`; sem esse arquivo o paralelismo assume o dia. Para ver o que ele decidiria agora: `node orquestra/paralelismo.js`.
- A proteção de `local/rodar-local.js` continua valendo por cima: memória livre abaixo do mínimo ou modelo fora da placa recusa a chamada, e a tarefa sobe na escada.
- A leitura do Windows (`local/uso-windows.ps1`) fica atrás de um leitor (`{ ler() }`); os testes usam leituras simuladas. O script foi rodado no PC do dono (2026-10-22): imprimiu o JSON, a detecção de vídeo funcionou (0% sem vídeo, 4,6% com o ffplay; na placa AMD o motor que mexe é `video codec 0`) e a suíte deu verde. Depois disso mudaram o formato (contadores que falham viram `null`, CPU por processo, `taskkill` ao reduzir agentes): rodar `node orquestra/paralelismo.js` e um lote com `--paralelo auto` de novo antes de confiar.
- **Reduzir em andamento:** quando o limite cai (o dono voltou ao PC), o `lote` tira os agentes locais que estão esperando o modelo, os mais novos primeiro, mata o comando e todos os processos que ele criou e devolve a microtarefa ao começo da fila. Isso não conta como falha: nada sobe para o Codex. Quem já passou para o Codex/Claude ou para a conferência termina. Só ocupa vaga quem está esperando o modelo local; quem subiu para o Codex/Claude ou está só conferindo a resposta não ocupa. O tempo máximo de uma chamada (10 min) também mata a árvore pelo mesmo caminho; aborto e tempo máximo juntos usam uma só rotina de parada. Ao voltar para o local (por exemplo depois de uma dica do Codex) a microtarefa espera haver vaga dentro do limite. A conta de memória soma de volta a parte dos agentes que já rodam (a memória livre já vem reduzida por eles), para o teto não despencar a cada agente aberto. Se a parada for recusada de vez, a chamada termina com erro `naoConfirmado` e o **lote inteiro para** com mensagem clara (encerre os processos do modelo local à mão e rode de novo): não dá para saber se os descendentes morreram. No erro fatal o lote interrompe os outros agentes locais e **espera a morte confirmada de cada um** (até 60 s) antes de lançar o erro, listando os que não foram confirmados. A redução acontece na próxima reavaliação, no máximo `reavaliarMs` (15 s) depois do limite cair, e não "na hora". **Um PC, um lote:** dois lotes ao mesmo tempo aplicam o teto cada um por conta própria (o arquivo de estado não reserva vagas), então o total pode passar do teto; rode um `lote` por vez. **A vaga e o escopo da tirada só são liberados quando o processo confirma que morreu** (o fim da chamada), então o número de processos vivos, inclusive os morrendo, nunca passa do limite. Cada chamada ao local (1ª tentativa, 2ª, correção) é acompanhada separadamente, e o lote reavalia o limite mesmo com uma só microtarefa rodando. O estado do controle (`mixai-paralelismo.json`) expira em `validadeEstadoSegundos` (300 s): um lote novo não herda o alvo de uma execução antiga. Leitura de CPU impossível (total ou Ollama acima de 100%) vale como leitura quebrada, isto é, "usando o PC". O limite pode ser **0** (memória ou placa sem espaço): o lote não inicia nada e espera abrir vaga; limite fixo precisa ser 1 ou mais.
- **Como a árvore de processos morre (Windows: Job Object):** nada de ler PID. O comando roda por `orquestra/job-windows.ps1`, que cria um Job Object com `KILL_ON_JOB_CLOSE` (sem permissão de escapar) e **coloca a si mesmo no job antes de iniciar o comando**, então todo descendente nasce dentro dele. Abortar é matar esse wrapper pela alça que o próprio Node guarda: o Windows fecha o job e mata o grupo inteiro, inclusive órfãos de intermediários que já saíram. Não existe PID reaproveitado nem corrida entre conferir e matar. Se o job não puder ser criado o wrapper sai com 125 sem rodar o comando. O prompt vai ao comando por **arquivo temporário como stdin** (sem pipe de entrada, que no Windows segurava o Node vivo), com permissão só do dono, e é apagado também quando o `spawn` falha. Custo: o wrapper abre um PowerShell por chamada (alguns segundos a mais no início, medir no PC). Outros sistemas: grupo de processos próprio, `SIGKILL` no grupo. A leitura de CPU/placa (`local/uso-windows.ps1`) não tem relação com isso. Limite do Windows: um processo que o próprio comando crie com `Win32_Process.Create` (WMI) nasce fora do job; os agentes do projeto não fazem isso.
- **Falha de leitura = em uso:** `local/uso-windows.ps1` devolve `null` (nunca zero) para qualquer contador que falhar, inclusive o tempo parado, e `paralelismo.js` trata número ausente, texto, negativo ou fora de faixa como "leitura indisponível" (alvo 1). A CPU de outros programas é o total menos a parte do Ollama, cada processo do Ollama contado uma vez e dividido pelos núcleos.
- **Windows em português:** os caminhos de `Get-Counter` para processador (`\\Processor`, `\\Process`) são traduzidos e falhavam, deixando a leitura sempre "indisponível". A CPU agora vem das classes CIM `Win32_PerfFormattedData_PerfOS_Processor` e `..._PerfProc_Process` (mesmo nome em qualquer idioma), achando o Ollama pelo número do processo. A placa usa o contador em inglês e, se ele não vier, a classe CIM `..._GPUEngine`. Qualquer valor que não for número válido (nulo, NaN, negativo) invalida a medida inteira em vez de virar zero.
