// Regressão permanente da escada: cada falha que já aconteceu (orquestra/falhas/falhas.jsonl) guarda a resposta
// certa e o comando que confere. A resposta certa tem que continuar passando nesse comando, para sempre.
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { lerCasos } = require(path.resolve(__dirname, "..", "orquestra", "escada.js"));

const ARQUIVO = path.resolve(__dirname, "..", "orquestra", "falhas", "falhas.jsonl");

test("existe ao menos um caso permanente (senão este teste não confere nada)", () => {
  assert.ok(lerCasos(ARQUIVO).length >= 1);
});

test("toda falha registrada: a resposta certa passa no verificador e as erradas continuam reprovadas", () => {
  const rodar = (falha, saida) => spawnSync(falha.verificar, { shell: true, input: saida, encoding: "utf8", cwd: path.resolve(__dirname, "..") }).status;
  for (const falha of lerCasos(ARQUIVO)) {
    assert.ok(falha.verificar, `falha sem comando de verificação: ${falha.entrada}`);
    assert.strictEqual(rodar(falha, falha.saidaCerta), 0, `a resposta certa deixou de passar em "${falha.verificar}"`);
    for (const errada of falha.saidasErradas) assert.notStrictEqual(rodar(falha, errada), 0, `o verificador passou a aceitar a resposta errada "${errada}"`);
  }
});
