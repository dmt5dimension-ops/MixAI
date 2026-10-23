# Plano: trazer o LangGraphicus para o sistema com `/integrar-app`

Data: 2026-10-23. Só plano, nenhum código do app entra aqui.

## O que se sabe (e o que não)

- O LangGraphicus é o primeiro da fila de apps (decisão do dono em 2026-10-21): cria sólidos 3D conversando e permite editar. Fonte: `docs/memoria/estado.md`, seção "Apps a trazer".
- O código está só no PC do dono. Nada dele está no GitHub, então a nuvem não consegue ler nem testar o app. Todo o trabalho com o código roda no PC.
- Não sabemos ainda: linguagem, como roda, se há testes, onde fica a pasta, se já é um repo git. Isso sai do raio-X (passo 2).
- Já resolvido: o kit copia o `AGENTS.md`/`CODEX.md` com os scripts chamados pela pasta do MixAI (`tests/caminhos-mixai.test.js`), e o `preparar-repo.ps1` já foi exercitado no Windows numa pasta Git temporária. Não precisa repetir. O que continua pendente no estado.md é só rodar o caminho dos scripts num Windows real.

## Decisões deste plano

1. **Onde o app fica segue o passo 1 do `/integrar-app`:** se a pasta do LangGraphicus já for um repositório Git, trabalha nele e copia o kit para lá; se não for, o app entra em `apps/langgraphicus/` neste repositório. Criar um repo novo no GitHub só se o dono pedir, e aí é mudança de regra em tarefa própria.
2. **Sobre o `orquestra/` e `local/`:** já resolvido pelo kit, que aponta os scripts para a pasta do MixAI. Nada a decidir aqui.
3. Nenhuma API paga: só Claude Code e Codex CLI pelas assinaturas.

## Checklist

### A. Preparação (no PC)
- [ ] Ensaio opcional do kit: o script exige que o destino já seja um repo Git, então crie uma pasta temporária e rode `git init` nela antes de `ferramentas\preparar-repo.ps1 -Repo <essa pasta>`; confira os arquivos copiados.
- [ ] Anotar onde está a pasta do LangGraphicus e se já é repo Git. Se for, usar essa pasta. Se não, colocar o app em `apps/langgraphicus/` no MixAI (regra do `/integrar-app`); o `preparar-repo.ps1` só é preciso para repo externo.
- [ ] Descobrir o comando de teste do app (`npm test`, `pytest`...) ou registrar que não existe.
- [ ] Se o app tem repo próprio: rodar `preparar-repo.ps1 -Repo <pasta do LangGraphicus> -ComandoTeste "<comando>"`. Se já existir `AGENTS.md`, juntar com a versão `.orquestrador` à mão.
- [ ] Só no caminho de repo externo: o repo precisa ter remoto no GitHub antes dos portões. Sem remoto, o `preparar-repo.ps1` copia os arquivos mas para em `gh repo view`, sem labels nem variável do CI. Então subir o repo (decisão do dono, fora deste plano) e rodar o script de novo. Enquanto não houver remoto, esse caminho fica **pendente**, sem declarar "pronto".
- [ ] Caminho de repo externo: abrir um PR só com os arquivos do kit; revisão cruzada (`feito-por:*`/`revisado-por:*`); só o dono liga a proteção da branch.
- [ ] Caminho `apps/langgraphicus/` no MixAI: não há kit a copiar; valem o PR, o CI (`regressao`, `guarda-de-testes`, `revisao-cruzada`) e as labels do próprio MixAI, com o escopo declarado em `apps/langgraphicus/` e na pasta de testes.

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

No caminho de repo externo: repo com remoto e o kit; no caminho interno: pasta `apps/langgraphicus/` no MixAI. Em ambos: CI verde, testes travando o que funciona, estado.md preenchido, e a primeira tarefa de avanço aberta por `/pedido`.
