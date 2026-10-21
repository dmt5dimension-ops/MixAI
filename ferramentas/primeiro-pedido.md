# Primeiro pedido ao coordenador

Cole isto no chat do coordenador do Agent Orchestrator, trocando o objetivo:

```
Objetivo: <descreva aqui o que você quer pronto>

Regras deste projeto (estão no AGENTS.md do repo, siga sempre):
1. Antes de qualquer código, quebre o objetivo em tarefas pequenas, cada uma com critério de pronto e o teste que prova. Me mostre a lista e espere meu ok.
2. Cada tarefa vai para um worker próprio, na sua branch e worktree, com só o contexto daquela tarefa.
3. Alterne quem implementa: tarefas de arquitetura e lógica mais delicada com o Claude Code, tarefas mecânicas e volume com o Codex.
4. Todo worker usa o fluxo do Superpowers: plano, teste primeiro, implementação, suíte de regressão inteira, verificação antes de dizer "pronto".
5. Quem implementou coloca a label feito-por:<agente> no PR. Abra um worker do OUTRO agente para fazer a revisão adversária do PR. Só ele coloca revisado-por:<agente>.
6. Se o CI (regressao, guarda-de-testes, revisao-cruzada) ficar vermelho, devolva para o dono da tarefa corrigir. Nunca apague nem pule teste.
7. Ninguém faz merge. Quando um PR estiver com os três checks verdes, me avise que eu faço o merge.
```

Comece com um objetivo pequeno (uma tarefa ou duas) para conferir o consumo das assinaturas antes de soltar trabalho grande.
