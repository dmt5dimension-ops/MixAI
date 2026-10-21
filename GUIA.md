# Guia do dono (sem programação)

Você conversa com o Claude. Ele planeja, manda o Codex fazer e confere. Você só diz o que quer e aprova o resultado.

## Para pedir uma coisa

No Claude Code, dentro da pasta do projeto, escreva:

```
/pedido o botão de enviar e-mail trava quando tem anexo
```

Fale do jeito que falaria com uma pessoa. O Claude devolve uma lista curta de tarefas e vai fazendo uma por vez.

## Para trazer um app seu para o sistema

```
/integrar-app o meu app de atendimento, que está na pasta C:\projetos\atendimento
```

Antes de consertar qualquer coisa, o sistema descobre o que já funciona e cria testes que travam isso. Daí em diante, o que funciona não volta a quebrar sem o CI apitar.

## Para ligar o Codex no sistema

Abra o Codex na pasta do MixAI e cole o prompt que o Claude te passou. Ele lê o `CODEX.md`, confere o login e se configura sozinho.

## O que te protege

- **Só muda o que foi pedido.** Todo pedido vira uma lista de arquivos que podem mudar. Se o agente mexer em outro (aquele botão que você não pediu), o GitHub bloqueia.
- **Não volta para trás.** Os agentes são proibidos de desfazer trabalho, e a branch principal não aceita push direto nem força.
- **Teste para sempre.** Cada coisa pronta ganha um teste. Se algo que funcionava quebrar, o PR fica vermelho e não entra.
- **Um faz, o outro confere.** O que o Codex fez o Claude revisa, e o contrário.
- **Memória.** O arquivo `docs/memoria/estado.md` guarda o que já funciona e o que foi decidido, para a próxima conversa não começar do zero.

## O que é seu

- Dizer o que quer.
- Clicar em **Merge** no PR quando o Claude avisar que está tudo verde.
- Colocar as labels `permitir-fora-do-escopo` ou `permitir-remocao-de-teste`, só se o Claude explicar por que precisa e você concordar. Nenhum agente pode colocar essas.

## Custos

Só as duas assinaturas que você já paga. Nada de chave de API. Use o Claude Code no modo normal (você digitando), que gasta do limite da assinatura.
