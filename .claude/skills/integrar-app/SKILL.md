---
name: integrar-app
description: Coloca um aplicativo existente e inacabado do dono (por exemplo o 3D Maker, o atendimento ou o fluxo de e-mail) dentro das regras deste sistema, travando o que já funciona antes de qualquer mudança. Use quando o dono quiser trazer um app para cá.
---
# /integrar-app

Objetivo: o app passa a só avançar. Antes de consertar qualquer coisa, a gente descobre e trava o que já funciona.

1. **Onde o app fica.** Se o app tem repositório próprio, trabalhe nele e copie para lá: `AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `.github/` (workflows, scripts e modelo de PR), `.claude/` e `docs/memoria/estado.md` (vazio). Se não tem, crie uma pasta `apps/<nome>/` neste repositório. Ajuste o comando da suíte no `AGENTS.md` (`npm test`, `pytest` etc.).
2. **Raio-X, só leitura.** Com o subagente `explorador`, descubra: como roda, quais partes existem, o que já tem teste. Não altere nada nesta etapa.
3. **Inventário com o dono.** Liste em português simples o que parece funcionar e o que parece quebrado, e pergunte só o que não dá para descobrir no código ("o envio de e-mail chega a sair?").
4. **Travar o que funciona.** Para cada coisa que funciona, uma tarefa pequena que só adiciona teste (escopo: só a pasta de testes). Nenhum código do app muda aqui. No fim desta etapa, `npm test` verde cobre o que já existe.
5. **Registrar.** Preencha `docs/memoria/estado.md`: o que funciona e qual teste trava, o que está quebrado, decisões.
6. **Só então consertar e avançar**, pelo `/pedido`, uma tarefa por vez, começando pelo que mais atrapalha o dono.
