// No Windows, processo criado pelos testes sem `windowsHide: true` abre uma janela do Terminal a cada `npm test`
// (o `detached: true` cria console novo). Este teste lê o código de tests/paralelismo.test.js e exige a opção em todo spawn.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

test("todo spawn/spawnSync de tests/paralelismo.test.js esconde a janela no Windows", () => {
  const linhas = fs.readFileSync(path.join(__dirname, "paralelismo.test.js"), "utf8").split(/\r?\n/);
  const sem = [];
  linhas.forEach((l, i) => { if (/\bspawn(Sync)?\(/.test(l) && !l.includes("windowsHide")) sem.push(`${i + 1}: ${l.trim().slice(0, 100)}`); });
  assert.deepStrictEqual(sem, [], `spawn sem windowsHide:\n${sem.join("\n")}`);
});
