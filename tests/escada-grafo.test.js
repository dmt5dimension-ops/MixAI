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
const planoDe = (m) => ({ id: "a", instrucao: "faça", verificar: "node -e 0", escopo: ["t/a"], ...m });
const estado = (arq, id) => grafo.carregar(arq).tarefas[id].estado;

test("ligarAoGrafo: início marca em_andamento, fim conclui os ok e falha os que não deram certo", () => {
  const arq = arquivoComTarefas();
  const lig = escada.ligarAoGrafo(arq, [planoDe({ id: "a", escopo: ["t/a"] }), planoDe({ id: "b", escopo: ["t/b"] })]);
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
  const lig = escada.ligarAoGrafo(arq, [planoDe({ id: "a", escopo: ["t/a"] }), planoDe({ id: "solta", escopo: ["t/solta"] })]);
  lig.iniciar();
  lig.terminar([{ id: "a", ok: true }, { id: "solta", ok: true }]);
  assert.equal(estado(arq, "a"), "feita");
});

test("ligarAoGrafo: tarefa que não está pronta recusa o início sem mexer em nenhuma", () => {
  const arq = arquivoComTarefas();
  const lig = escada.ligarAoGrafo(arq, [planoDe({ id: "a", escopo: ["t/a"] }), planoDe({ id: "c", escopo: ["t/c"] })]); // c depende de a, que ainda não está feita
  assert.throws(() => lig.iniciar(), /não está pronta/);
  assert.equal(estado(arq, "a"), "pendente");
});

test("ligarAoGrafo: terminar só mexe no que ainda está em_andamento", () => {
  const arq = arquivoComTarefas();
  const lig = escada.ligarAoGrafo(arq, [planoDe({ id: "a", escopo: ["t/a"] })]);
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


test("ligarAoGrafo: plano inválido recusa antes de mexer no grafo (tarefa não fica presa em_andamento)", () => {
  const arq = arquivoComTarefas();
  const lig = escada.ligarAoGrafo(arq, [planoDe({ instrucao: "" })]);
  assert.throws(() => lig.iniciar(), /falta a instrução/);
  assert.equal(estado(arq, "a"), "pendente");
});

test("ligarAoGrafo: escopo do plano fora do escopo da tarefa no grafo é recusado sem mexer no grafo", () => {
  const arq = arquivoComTarefas();
  assert.throws(() => escada.ligarAoGrafo(arq, [planoDe({ escopo: ["t/fora"] })]).iniciar(), /fora do escopo/);
  assert.throws(() => escada.ligarAoGrafo(arq, [planoDe({ escopo: ["t/a", "t/fora"] })]).iniciar(), /fora do escopo/);
  assert.throws(() => escada.ligarAoGrafo(arq, [planoDe({ escopo: ["t/"] })]).iniciar(), /fora do escopo/, "pasta mais larga que a da tarefa");
  assert.equal(estado(arq, "a"), "pendente");
  // dentro do escopo (arquivo ou pasta abaixo da tarefa) passa
  escada.ligarAoGrafo(arq, [planoDe({ escopo: ["t/a/x.js"] })]).iniciar();
  assert.equal(estado(arq, "a"), "em_andamento");
});
