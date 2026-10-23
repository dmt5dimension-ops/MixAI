// Trava o treino sem supervisão (ferramentas/treino-kaggle): geradores/verificadores mecânicos e o laço de rodadas,
// com um modelo de mentira. O código que usa a placa de vídeo (modelo_unsloth.py) não é coberto aqui.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PASTA = path.resolve(__dirname, "..", "ferramentas", "treino-kaggle");

test("geradores, verificadores e laço de rodadas passam (python)", { timeout: 300000 }, () => {
  const r = spawnSync("python3", ["-W", "error::ResourceWarning", path.join(PASTA, "test_ciclo.py")], { encoding: "utf8", timeout: 280000 });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

test("o notebook é um JSON válido e chama o laço com continuação e limite de horas", () => {
  const nb = JSON.parse(fs.readFileSync(path.join(PASTA, "treino-sem-supervisao.ipynb"), "utf8"));
  const codigo = nb.cells.filter((c) => c.cell_type === "code").map((c) => c.source.join("")).join("\n");
  assert.match(codigo, /loop_treino\.principal/);
  assert.match(codigo, /--anterior/);
  assert.match(codigo, /--horas/);
  assert.doesNotMatch(codigo, /anthropic|openai/i, "nada de API de terceiros");
});

test("o passo a passo avisa os limites (só tarefa conferível por máquina, GPU nunca testada)", () => {
  const txt = fs.readFileSync(path.join(PASTA, "PASSO-A-PASSO.md"), "utf8");
  assert.match(txt, /só aprende tarefas conferíveis por máquina/);
  assert.match(txt, /não foi rodado numa placa de verdade/);
});
