// Evita conflito de mesclagem em listas que todo PR acrescenta (estado.md, ESCADA.md): merge=union mantém as duas metades.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const texto = fs.readFileSync(path.resolve(__dirname, "..", ".gitattributes"), "utf8");

test(".gitattributes usa merge=union nas listas que todo PR acrescenta", () => {
  for (const arq of ["docs/memoria/estado.md", "orquestra/ESCADA.md"]) {
    const linhas = texto.split(/\r?\n/).map((l) => l.trim().split(/\s+/));
    assert.ok(linhas.some((p) => p[0] === arq && p.includes("merge=union")), `${arq} sem merge=union`);
  }
});

test(".gitattributes NÃO usa union nos arquivos gerados (união de JSON corrompe o mapa)", () => {
  assert.ok(!/mapa\.(json|md)\s+merge=union/.test(texto));
});
