// Regressão permanente da escada: cada falha que já aconteceu (orquestra/falhas/falhas.jsonl) guarda a resposta
// certa e o comando que confere. A resposta certa tem que continuar passando nesse comando, para sempre.
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { lerCasos } = require(path.resolve(__dirname, "..", "orquestra", "escada.js"));

const ARQUIVO = path.resolve(__dirname, "..", "orquestra", "falhas", "falhas.jsonl");

test("toda falha registrada continua tendo uma resposta certa que passa no verificador", () => {
  for (const falha of lerCasos(ARQUIVO)) {
    assert.ok(falha.verificar, `falha sem comando de verificação: ${falha.entrada}`);
    const r = spawnSync(falha.verificar, { shell: true, input: falha.saidaCerta, encoding: "utf8", cwd: path.resolve(__dirname, "..") });
    assert.strictEqual(r.status, 0, `a resposta certa deixou de passar em "${falha.verificar}" (${falha.entrada})`);
  }
});
