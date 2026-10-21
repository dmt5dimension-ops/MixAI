// Trava a regra do canal de coordenação entre Claude e Codex: os dois arquivos de regras precisam apontar para o mesmo canal.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CANAL = ["D:", "MixAI-coordenacao", "coordenacao.md"].join(String.fromCharCode(92));
const ler = (nome) => fs.readFileSync(path.resolve(__dirname, "..", nome), "utf8");

test("AGENTS.md e CODEX.md mandam usar o mesmo canal fora do git, antes e depois de cada etapa", () => {
  for (const nome of ["AGENTS.md", "CODEX.md"]) {
    const texto = ler(nome);
    assert.ok(texto.includes(CANAL), `${nome} não cita o canal ${CANAL}`);
    assert.ok(/fora do git/i.test(texto), `${nome} não diz que o canal fica fora do git`);
  }
  assert.ok(/antes e depois/i.test(ler("AGENTS.md")));
});
