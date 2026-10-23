// Testa a ligação do `escada.js lote` com o grafo: quem chama o lote direto também registra iniciar/concluir/falhar.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RAIZ = path.resolve(__dirname, "..");
const escada = require(path.join(RAIZ, "orquestra", "escada.js"));
const grafo = require(path.join(RAIZ, "orquestra", "grafo.js"));

const AGORA = "2026-10-23T12:00:00.000Z";

function arquivoComTarefas() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escada-grafo-"));
  const arq = path.join(dir, "grafo.json");
  let g = grafo.novo();
  g = grafo.adicionar(g, { id: "a", titulo: "A", agente: "local", escopo: ["t/a"] }, AGORA);
  g = grafo.adicionar(g, { id: "b", titulo: "B", agente: "local", escopo: ["t/b"] }, AGORA);
  g = grafo.adicionar(g, { id: "c", titulo: "C", agente: "local", escopo: ["t/c"], depende: ["a"] }, AGORA);
  grafo.salvar(arq, g);
  return arq;
}
const estado = (arq, id) => grafo.carregar(arq).tarefas[id].estado;

test("ligarAoGrafo: início marca em_andamento, fim conclui os ok e falha os que não deram certo", () => {
  const arq = arquivoComTarefas();
  const lig = escada.ligarAoGrafo(arq, [{ id: "a" }, { id: "b" }]);
  lig.iniciar();
  assert.equal(estado(arq, "a"), "em_andamento");
  assert.equal(estado(arq, "b"), "em_andamento");
  lig.terminar([{ id: "a", ok: true, resolvidoPor: "local" }, { id: "b", ok: false }]);
  assert.equal(estado(arq, "a"), "feita");
  assert.equal(estado(arq, "b"), "pendente"); // primeira falha ainda volta à fila
  assert.equal(grafo.carregar(arq).tarefas.b.tentativas, 1);
});

test("ligarAoGrafo: microtarefa que não está no grafo é ignorada", () => {
  const arq = arquivoComTarefas();
  const lig = escada.ligarAoGrafo(arq, [{ id: "a" }, { id: "solta" }]);
  lig.iniciar();
  lig.terminar([{ id: "a", ok: true }, { id: "solta", ok: true }]);
  assert.equal(estado(arq, "a"), "feita");
});

test("ligarAoGrafo: tarefa que não está pronta recusa o início sem mexer em nenhuma", () => {
  const arq = arquivoComTarefas();
  const lig = escada.ligarAoGrafo(arq, [{ id: "a" }, { id: "c" }]); // c depende de a, que ainda não está feita
  assert.throws(() => lig.iniciar(), /não está pronta/);
  assert.equal(estado(arq, "a"), "pendente");
});

test("ligarAoGrafo: terminar só mexe no que ainda está em_andamento", () => {
  const arq = arquivoComTarefas();
  const lig = escada.ligarAoGrafo(arq, [{ id: "a" }]);
  lig.iniciar();
  grafo.atualizar(arq, (x) => grafo.concluir(x, "a", "por outro caminho"));
  lig.terminar([{ id: "a", ok: false }]);
  assert.equal(estado(arq, "a"), "feita");
});

test("linha de comando: --grafo com tarefa que não está pronta para antes de rodar o lote", () => {
  const arq = arquivoComTarefas();
  const plano = path.join(path.dirname(arq), "plano.json");
  fs.writeFileSync(plano, JSON.stringify([{ id: "c", instrucao: "x", verificar: "node -e 0", escopo: ["t/c"] }]));
  const r = spawnSync(process.execPath, [path.join(RAIZ, "orquestra", "escada.js"), "lote", plano, "--grafo", arq], { encoding: "utf8", timeout: 30000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /não está pronta/);
  assert.equal(estado(arq, "c"), "pendente");
});
