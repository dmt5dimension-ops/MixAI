# Plano: trazer o LangGraphicus para o sistema com `/integrar-app`

Data: 2026-10-23. Só plano, nenhum código do app entra aqui.

## O que se sabe (e o que não)

- O LangGraphicus é o primeiro da fila de apps (decisão do dono em 2026-10-21): cria sólidos 3D conversando e permite editar. Fonte: `docs/memoria/estado.md`, seção "Apps a trazer".
- O código está só no PC do dono. Nada dele está no GitHub, então a nuvem não consegue ler nem testar o app. Todo o trabalho com o código roda no PC.
- Não sabemos ainda: linguagem, como roda, se há testes, onde fica a pasta. Isso sai do raio-X (passo 2).
- Pendências já registradas no estado: (a) o `preparar-repo.ps1` nunca rodou num Windows real; (b) o `AGENTS.md` copiado cita `orquestra/` e `local/`, que só existem no MixAI.

## Decisões deste plano

1. **Repositório próprio** para o app (o `/integrar-app` prefere isso quando o app já tem pasta). Se a pasta ainda não for um repo git, `git init` e criar o repo no GitHub vem antes de tudo.
2. **Sobre o `orquestra/` e `local/`:** o kit passa a levar só as regras; no repo do app, os comandos de troca de papel são chamados pela pasta do MixAI (`node D:\MixAI\orquestra\chamar.js ...`). Evita duas cópias para manter. Se isso atrapalhar, vira tarefa própria.
3. Nenhuma API paga: só Claude Code e Codex CLI pelas assinaturas.

## Checklist

### A. Preparação (no PC)
- [ ] Ensaio do kit: rodar `ferramentas\preparar-repo.ps1 -Repo <pasta de teste vazia>` e conferir os arquivos copiados (fecha a pendência do estado.md).
- [ ] Anotar onde está a pasta do LangGraphicus e se já é repo git; se não, criar o repo no GitHub.
- [ ] Descobrir o comando de teste do app (`npm test`, `pytest`...) ou registrar que não existe.
- [ ] Rodar `preparar-repo.ps1 -Repo <pasta do LangGraphicus> -ComandoTeste "<comando>"`. Se já existir `AGENTS.md`, juntar com a versão `.orquestrador` à mão.
- [ ] Abrir um PR só com os arquivos do kit; revisão cruzada (`feito-por:*`/`revisado-por:*`); só o dono liga a proteção da branch.

### B. Raio-X (só leitura, passo 2 do `/integrar-app`)
- [ ] `explorador` descreve: como roda, quais partes existem (conversa, geração do sólido, edição, exportação), o que tem de teste.
- [ ] Nada é alterado nesta etapa.

### C. Inventário com o dono (passo 3)
- [ ] Lista em português simples: o que parece funcionar e o que parece quebrado.
- [ ] Perguntas só do que o código não responde (ex.: "o sólido gerado abre no slicer?", "a edição por conversa mantém o que já estava certo?"). Perguntas passam pelo chat principal.

### D. Travar o que funciona (passo 4, só testes)
- [ ] Uma tarefa pequena por funcionalidade que funciona, escopo = só a pasta de testes.
- [ ] Testes sem depender de modelo ao vivo: entradas fixas e saída conferida (ex.: dimensões, volume ou arquivo exportado válido).
- [ ] Fim da etapa: `npm test` (ou equivalente) verde cobrindo o que existe, e o CI de regressão verde no PR.

### E. Registrar (passo 5)
- [ ] `docs/memoria/estado.md` do app: o que funciona e o teste que trava, o que está quebrado, decisões.
- [ ] No MixAI: mover o LangGraphicus de "a trazer" para "integrado" em `docs/memoria/estado.md`.

### F. Avançar (passo 6, via `/pedido`)
- [ ] Uma tarefa por vez, começando pelo que mais atrapalha o dono, cada uma com teste que falha antes e passa depois.

## Riscos

- Sem teste prévio, qualquer conserto pode quebrar o que funciona; por isso D vem antes de F.
- Teste que dependa de resposta de modelo de linguagem fica instável; usar saídas gravadas.
- Regra de escopo do CI vale no repo novo; o `AGENTS.md` copiado precisa estar com o comando de teste certo.

## Pronto quando

Repo do app com o kit, CI verde, testes travando o que funciona, estado.md preenchido, e a primeira tarefa de avanço aberta por `/pedido`.
