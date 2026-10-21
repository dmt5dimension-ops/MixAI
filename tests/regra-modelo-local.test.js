// Trava a regra do AGENTS.md que diz quando o planejador pode mandar tarefa para o modelo local.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const agents = fs.readFileSync(path.resolve(__dirname, "..", "AGENTS.md"), "utf8");

function secao(titulo) {
  const inicio = agents.indexOf(titulo);
  assert.ok(inicio >= 0, `falta a seção "${titulo}" no AGENTS.md`);
  const resto = agents.slice(inicio + titulo.length);
  const fim = resto.search(/\n#{2,3} /);
  return fim >= 0 ? resto.slice(0, fim) : resto;
}

const regra = secao("### Quando mandar para o modelo local");

test("a regra lista as tarefas que o modelo local pode fazer", () => {
  for (const tarefa of [/rascunho de teste/i, /extrair dados/i, /resumir/i, /reformatar/i]) {
    assert.match(regra, tarefa);
  }
});

test("a regra proíbe planejar, revisar, classificar e decidir", () => {
  // No teste com 5 tarefas reais ele chamou tudo de "pequena": não serve para classificar.
  for (const proibido of [/planejar/i, /revisar/i, /classificar/i, /decidir/i]) {
    assert.match(regra, proibido);
  }
});

test("a regra exige tarefa pequena o bastante para caber no contexto do PC", () => {
  assert.match(regra, /8192/);
  assert.match(regra, /modo\.ps1|modos\.json/);
});

test("a regra manda conferir o resultado antes de usar", () => {
  assert.match(regra, /npm test/);
  assert.match(regra, /confer/i);
});

test("a regra diz o que fazer quando o modelo local erra", () => {
  assert.match(regra, /errar|errou|falhar/i);
  assert.match(regra, /executor-leve|Codex/);
});

test("a regra usa o nome fixo do modelo local", () => {
  assert.match(regra, /mixai-local/);
});
