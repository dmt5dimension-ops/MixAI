// Trava as regras que o modelo local (Qwen) aprendeu de verdade: orquestra/regras-locais.json.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const RAIZ = path.resolve(__dirname, "..");
const { escolherRegras } = require(path.join(RAIZ, "orquestra", "escada.js"));
const regras = JSON.parse(fs.readFileSync(path.join(RAIZ, "orquestra", "regras-locais.json"), "utf8")).regras;

test("toda regra salva é bem formada e confirmada, com palavras-chave específicas", () => {
  for (const r of regras) {
    assert.ok(r.id && r.regra && r.exemplo && r.exemplo.entrada && r.exemplo.saida, `regra incompleta: ${r.id}`);
    assert.strictEqual(r.status, "confirmada", `só regra confirmada entra no arquivo: ${r.id}`);
    assert.ok(Array.isArray(r.palavras) && r.palavras.length >= 1, `sem palavras-chave: ${r.id}`);
    for (const p of r.palavras) assert.ok(String(p).length >= 8, `palavra-chave genérica demais em ${r.id}: "${p}"`);
  }
});

test("a regra teste-mesmo-arquivo só dispara para tarefas sobre caminhos que são o mesmo arquivo", () => {
  const regra = regras.find((r) => r.id === "teste-mesmo-arquivo");
  assert.ok(regra, "falta a regra teste-mesmo-arquivo (aprendida na rodada 2 do Qwen)");
  const ids = (tarefa) => escolherRegras(regras, tarefa).map((r) => r.id);
  // positivos: a tarefa em que ela foi aprendida e uma variação
  assert.deepStrictEqual(ids("Escreva UM bloco de teste. Caso: aplicarResposta aceita './src/A.js' (mesmo arquivo com ./ e maiúscula)."), ["teste-mesmo-arquivo"]);
  assert.deepStrictEqual(ids("Teste que dois caminhos equivalentes gravam no mesmo lugar."), ["teste-mesmo-arquivo"]);
  // negativos: tarefas de teste ou de aplicarResposta que NÃO são sobre o mesmo arquivo
  assert.deepStrictEqual(ids("Escreva um bloco de teste para converter datas."), []);
  assert.deepStrictEqual(ids("Implemente aplicarResposta."), []);
  assert.deepStrictEqual(ids("Converta a data 21/10/2026 para ISO."), []);
});
