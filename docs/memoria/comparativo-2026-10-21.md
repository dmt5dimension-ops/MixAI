# Comparativo Claude x Codex (2026-10-21)

Mini-projeto de fila de e-mail com 3 defeitos plantados (anexo vazio trava; configuração relida e conexão aberta a cada e-mail; reenvio quando a confirmação se perde manda duplicado). Uma rodada de cada, mesmo texto, cópia limpa, testes de nota escondidos.

| Tarefa | Claude | Codex |
| --- | --- | --- |
| 1. Consertar trava (pequena) | 4/4 testes escondidos, conserto de 1 linha | 4/4, mesmo conserto |
| 2. Não mandar duplicado (média) | 6/6, 7 testes próprios, não mexeu em mais nada | 6/6, mas **apagou as novas tentativas de envio** sem ninguém pedir |
| 3. Planejar "lento e manda duplicado" | Achou as 2 causas; deixou o defeito do anexo como "visto, não consertar"; explicação simples | Achou as 2 causas e o defeito do anexo (incluiu como tarefa sem ser pedido); conserto do duplicado mais robusto (reconhecer pelo id) |

Tempo parecido (40 a 65 s por rodada). Tokens não dão para comparar: o Claude rodou como subagente desta sessão (o `claude` do terminal não está logado) e isso soma o contexto do sistema.

Leitura: empate na execução quando o teste cobre tudo; o Codex saiu do pedido na tarefa média, o Claude não. No planejamento os dois foram bons; o Claude seguiu melhor as regras do MixAI. Mantida a ordem de `orquestra/papeis.json` (Claude planeja e revisa, Codex executa), com revisão cruzada atenta a "mudou o que não foi pedido". Amostra de 1 rodada: não é prova.
