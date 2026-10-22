// Testa o grafo persistente de tarefas (orquestra/grafo.js): dependências, estado e gravação segura.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RAIZ = path.resolve(__dirname, "..");
const grafo = require(path.join(RAIZ, "orquestra", "grafo.js"));

const AGORA = "2026-10-22T12:00:00.000Z";
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grafo-")), "grafo.json");

function exemplo() {
  let g = grafo.novo();
  g = grafo.adicionar(g, { id: "a", titulo: "Escrever teste", agente: "codex", escopo: ["tests/x.test.js"], verificar: "npm test" }, AGORA);
  g = grafo.adicionar(g, { id: "b", titulo: "Implementar", agente: "codex", depende: ["a"] }, AGORA);
  g = grafo.adicionar(g, { id: "c", titulo: "Revisar", agente: "claude", depende: ["a", "b"] }, AGORA);
  return g;
}

test("tarefa nova começa pendente com campos padrão, e id repetido é recusado", () => {
  const g = exemplo();
  assert.deepStrictEqual(g.tarefas.a, { id: "a", titulo: "Escrever teste", estado: "pendente", depende: [], agente: "codex", escopo: ["tests/x.test.js"], verificar: "npm test", tentativas: 0, atualizado: AGORA, resultado: null });
  assert.throws(() => grafo.adicionar(g, { id: "a", titulo: "de novo" }, AGORA), /já existe/);
  assert.throws(() => grafo.adicionar(g, { titulo: "sem id" }, AGORA), /id/);
  assert.throws(() => grafo.adicionar(g, { id: "z", titulo: "x", agente: "gpt" }, AGORA), /agente/);
});

test("prontas: só tarefa pendente com todas as dependências feitas", () => {
  let g = exemplo();
  assert.deepStrictEqual(grafo.prontas(g).map((t) => t.id), ["a"]);
  g = grafo.iniciar(g, "a", "codex", AGORA);
  assert.deepStrictEqual(grafo.prontas(g), []);
  g = grafo.concluir(g, "a", { ok: true }, AGORA);
  assert.deepStrictEqual(grafo.prontas(g).map((t) => t.id), ["b"]);
  g = grafo.concluir(grafo.iniciar(g, "b", "codex", AGORA), "b", null, AGORA);
  assert.deepStrictEqual(grafo.prontas(g).map((t) => t.id), ["c"]);
});

test("falhar conta a tentativa e devolve a tarefa para a fila; ao passar do limite fica falhou e trava as dependentes", () => {
  let g = exemplo();
  g = grafo.falhar(grafo.iniciar(g, "a", "codex", AGORA), "a", "teste vermelho", AGORA, 2);
  assert.strictEqual(g.tarefas.a.estado, "pendente");
  assert.strictEqual(g.tarefas.a.tentativas, 1);
  assert.strictEqual(g.tarefas.a.resultado, "teste vermelho");
  g = grafo.falhar(grafo.iniciar(g, "a", "codex", AGORA), "a", "de novo", AGORA, 2);
  assert.strictEqual(g.tarefas.a.estado, "falhou");
  assert.deepStrictEqual(grafo.prontas(g), []);
  assert.deepStrictEqual(grafo.travadas(g).map((t) => t.id), ["b", "c"]);
});

test("transições inválidas são recusadas (concluir sem iniciar, iniciar tarefa não pronta)", () => {
  const g = exemplo();
  assert.throws(() => grafo.concluir(g, "a", null, AGORA), /em_andamento/);
  assert.throws(() => grafo.iniciar(g, "b", "codex", AGORA), /não está pronta/);
  assert.throws(() => grafo.iniciar(g, "nada", "codex", AGORA), /não existe/);
});

test("validar acusa dependência inexistente, ciclo e escopo sobreposto entre tarefas em andamento", () => {
  let g = exemplo();
  assert.deepStrictEqual(grafo.validar(g), []);
  const ruim = JSON.parse(JSON.stringify(g));
  ruim.tarefas.a.depende = ["c"];
  assert.ok(grafo.validar(ruim).some((e) => /ciclo/.test(e)));
  const solta = JSON.parse(JSON.stringify(g));
  solta.tarefas.b.depende = ["fantasma"];
  assert.ok(grafo.validar(solta).some((e) => /fantasma/.test(e)));
  const dupla = grafo.novo();
  let d = grafo.adicionar(dupla, { id: "x", titulo: "x", escopo: ["src/a.js"] }, AGORA);
  d = grafo.adicionar(d, { id: "y", titulo: "y", escopo: ["./src/a.js"] }, AGORA);
  d = grafo.iniciar(grafo.iniciar(d, "x", "codex", AGORA), "y", "claude", AGORA);
  assert.ok(grafo.validar(d).some((e) => /escopo/.test(e)));
});

test("adicionar recusa dependência que criaria ciclo", () => {
  let g = exemplo();
  assert.throws(() => grafo.adicionar(g, { id: "d", titulo: "x", depende: ["d"] }, AGORA), /ciclo/);
});

test("salvar é atômico e carregar devolve o mesmo grafo; arquivo corrompido dá erro e não é apagado", () => {
  const arq = tmp();
  assert.deepStrictEqual(grafo.carregar(arq), grafo.novo());
  const g = exemplo();
  grafo.salvar(arq, g);
  assert.deepStrictEqual(grafo.carregar(arq), g);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(arq)), ["grafo.json"]);
  fs.writeFileSync(arq, "{quebrado");
  assert.throws(() => grafo.carregar(arq), /corrompido/);
  assert.strictEqual(fs.readFileSync(arq, "utf8"), "{quebrado");
});

test("linha de comando: add, proximas, iniciar, concluir e status persistem no arquivo", () => {
  const arq = tmp();
  const cli = (...args) => spawnSync(process.execPath, [path.join(RAIZ, "orquestra", "grafo.js"), ...args, "--arquivo", arq], { encoding: "utf8" });
  assert.strictEqual(cli("add", "a", "Primeira", "--agente", "codex").status, 0);
  assert.strictEqual(cli("add", "b", "Segunda", "--depende", "a").status, 0);
  assert.match(cli("proximas").stdout, /^a\b/m);
  assert.strictEqual(cli("iniciar", "a", "codex").status, 0);
  assert.strictEqual(cli("concluir", "a").status, 0);
  assert.match(cli("proximas").stdout, /^b\b/m);
  assert.match(cli("status").stdout, /feita: 1/);
  assert.strictEqual(cli("iniciar", "b", "codex").status, 0);
  assert.notStrictEqual(cli("iniciar", "b", "codex").status, 0);
});

test("o grafo do repositório existe, é válido e está versionado", () => {
  const real = grafo.carregar(path.join(RAIZ, "orquestra", "grafo.json"));
  assert.strictEqual(real.versao, 1);
  assert.deepStrictEqual(grafo.validar(real), []);
});
