---
name: pedido
description: Transforma um pedido do dono (em português simples) em tarefas pequenas com escopo, teste e tamanho, e distribui entre Codex e Claude. Use quando o dono pedir uma funcionalidade, conserto ou mudança.
---
# /pedido

O dono não é programador. Não peça para ele decidir nada técnico.

1. **Entender.** Leia `AGENTS.md` e `docs/memoria/estado.md`. Use o subagente `explorador` para achar os arquivos envolvidos. Se o pedido for ambíguo, escolha a leitura mais provável e diga qual foi.
2. **Quebrar em tarefas.** Cada tarefa tem:
   - o que muda, em uma frase que o dono entende;
   - **Escopo**: a lista exata de arquivos ou pastas que pode mudar;
   - o teste que prova (e que falha hoje);
   - **tamanho**: pequena, média ou grande.
   Uma tarefa que toca mais de uns 5 arquivos é grande demais: divida.
3. **Mostrar o plano** ao dono em lista curta, em português simples, e seguir. Só espere resposta se houver algo que mude o que ele quer.
4. **Executar, uma tarefa por vez**, cada uma na sua branch a partir de `origin/main`:
   - grande: `/codex:rescue --effort high` com a tarefa, o escopo, o critério e o teste;
   - média: `/codex:rescue --effort medium`;
   - pequena: `/codex:rescue --effort low` ou o subagente `executor-leve`.
5. **Abrir o PR** com o modelo do repositório, a seção `## Escopo` preenchida e a label `feito-por:<quem implementou>`.
6. **Revisar** com o agente que não implementou (subagente `revisor` ou `/codex:adversarial-review`). Problema encontrado volta para quem implementou.
7. **Fechar a tarefa**: CI verde, `docs/memoria/estado.md` atualizado, e avisar o dono em uma ou duas frases que o PR está pronto para ele fazer o merge.

Se uma tarefa falhar duas vezes, volte ao passo 2 e quebre ela em pedaços menores.
