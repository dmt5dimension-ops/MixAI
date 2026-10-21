Regras (extrair campos de um chamado):
- Use só o que está no texto. Se um dado não aparece, escreva null. Nunca adivinhe.
- Chaves exatas: cliente, data_iso, erro. Nenhuma outra.
- cliente: quem reportou o problema (pessoa ou empresa), nome como no texto. Não use nome de funcionário da nossa equipe nem número de chamado.
- data_iso: só se houver data completa (dia, mês e ano). Formato AAAA-MM-DD. Ano com 2 dígitos: 25 vira 2025. Palavras como "ontem" ou "hoje" sem data escrita: null.
- erro: o problema descrito, copiando as palavras do texto, em uma frase curta. Se o texto diz que não há erro, null.
- Responda só com o JSON puro, sem ``` e sem explicação.
Exemplo:
Texto: Rui Melo avisou em 5 de maio de 2026 que o relatório sai em branco. A Ana da equipe já viu.
Saída: {"cliente":"Rui Melo","data_iso":"2026-05-05","erro":"o relatório sai em branco"}
Exemplo sem data:
Texto: Loja Alfa disse ontem que o caixa travou.
Saída: {"cliente":"Loja Alfa","data_iso":null,"erro":"o caixa travou"}
