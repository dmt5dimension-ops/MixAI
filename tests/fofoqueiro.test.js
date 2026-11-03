// Testa o fofoqueiro: o que ele detecta no canal, nos PRs e no grafo, e as travas contra disparo duplicado/infinito.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

process.env.MIXAI_CANAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fofo-"));
const f = require("../orquestra/fofoqueiro.js");

const CANAL = `# Canal

### 2026-10-21 — Claude → Codex (revisão)

Revise o PR 12.

### 2026-10-21 — Codex → Claude (veredito)

BLOQUEADO, corrija.
`;

test("canal: a última mensagem dirigida ao outro vira pendência para o destinatário", () => {
  const p = f.pendenciasDoCanal(CANAL);
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].agente, "claude");
  assert.ok(p[0].id.startsWith("canal:"));
});

test("canal: mensagem para o Fernando ou sem destinatário de agente não acorda ninguém", () => {
  assert.deepStrictEqual(f.pendenciasDoCanal("### 2026-10-21 — Claude → Fernando\n\noi"), []);
  assert.deepStrictEqual(f.pendenciasDoCanal(""), []);
});

test("PR feito pelo claude sem revisão do codex pede revisão ao codex; com a label, nada", () => {
  const pr = { number: 7, title: "x", headRefOid: "abcdef123456", labels: [{ name: "feito-por:claude" }], statusCheckRollup: [] };
  const p = f.pendenciasDosPRs([pr]);
  assert.strictEqual(p[0].agente, "codex");
  const revisado = { ...pr, labels: [...pr.labels, { name: "revisado-por:codex" }] };
  assert.deepStrictEqual(f.pendenciasDosPRs([revisado]), []);
});

test("PR com check vermelho volta para quem fez", () => {
  const pr = { number: 7, title: "x", headRefOid: "abcdef123456", labels: [{ name: "feito-por:codex" }], statusCheckRollup: [{ conclusion: "FAILURE" }] };
  assert.strictEqual(f.pendenciasDosPRs([pr])[0].agente, "codex");
});

test("grafo: tarefa com dependências feitas é liberada; sem elas, não; qwen não é acordado", () => {
  const agora = new Date("2026-10-21T12:00:00Z");
  const grafo = { tarefas: [
    { id: "a", descricao: "A", dono: "codex", depende: [], estado: "feita" },
    { id: "b", descricao: "B", dono: "codex", depende: ["a"], estado: "pendente" },
    { id: "c", descricao: "C", dono: "claude", depende: ["b"], estado: "pendente" },
    { id: "d", descricao: "D", dono: "qwen:1", depende: ["a"], estado: "pendente" },
  ] };
  const p = f.pendenciasDoGrafo(grafo, agora);
  assert.deepStrictEqual(p.map((x) => x.id), ["grafo:b:liberada"]);
});

test("grafo: tarefa em andamento parada há mais de 30 min é cobrada; recente, não", () => {
  const agora = new Date("2026-10-21T12:00:00Z");
  const t = (min) => ({ tarefas: [{ id: "a", descricao: "A", dono: "claude", depende: [], estado: "em-andamento", atualizadoEm: new Date(agora - min * 60e3).toISOString() }] });
  assert.strictEqual(f.pendenciasDoGrafo(t(45), agora).length, 1);
  assert.strictEqual(f.pendenciasDoGrafo(t(5), agora).length, 0);
});

test("travas: não repete a mesma mudança, respeita espera mínima e teto por hora", () => {
  const cfg = { maxDisparosPorHora: 2, esperaMinimaMinutos: 3 };
  const agora = new Date("2026-10-21T12:00:00Z");
  const p = { agente: "codex", id: "x" };
  assert.strictEqual(f.decidir([p], {}, agora, cfg).length, 1);
  assert.strictEqual(f.decidir([p], { visto: { x: "t" } }, agora, cfg).length, 0);
  const um = f.registrar({}, p, new Date(agora - 60e3));
  assert.strictEqual(f.decidir([{ agente: "codex", id: "y" }], um, agora, cfg).length, 0);
  const dois = f.registrar(f.registrar({}, p, new Date(agora - 20 * 60e3)), { agente: "codex", id: "z" }, new Date(agora - 10 * 60e3));
  assert.strictEqual(f.decidir([{ agente: "codex", id: "y" }], dois, agora, cfg).length, 0);
  assert.strictEqual(f.decidir([{ agente: "claude", id: "y" }], dois, agora, cfg).length, 1);
});

test("travas: agente sem cota não é acordado", () => {
  const agora = new Date("2026-10-21T12:00:00Z");
  assert.strictEqual(f.decidir([{ agente: "codex", id: "x" }], {}, agora, { maxDisparosPorHora: 4, esperaMinimaMinutos: 3 }, () => true).length, 0);
});

test("modo noite: das 22h às 7h", () => {
  assert.ok(f.ehNoite(new Date(2026, 9, 21, 23), { inicio: 22, fim: 7 }));
  assert.ok(f.ehNoite(new Date(2026, 9, 21, 3), { inicio: 22, fim: 7 }));
  assert.ok(!f.ehNoite(new Date(2026, 9, 21, 14), { inicio: 22, fim: 7 }));
});

test("passo: acorda uma vez só para a mesma mensagem, mesmo repetindo o passo", () => {
  let estado = {};
  const acordados = [];
  const deps = {
    agora: () => new Date("2026-10-21T12:00:00Z"),
    lerEstado: () => estado,
    salvarEstado: (e) => { estado = e; },
    lerCanal: () => CANAL,
    lerGrafo: () => ({ tarefas: [] }),
    verPRs: () => false,
    listarPRs: () => [],
    acordar: (a) => { acordados.push(a); return { status: 0, limite: false, fim: "" }; },
    pausado: () => false,
    semCota: () => {},
  };
  f.passo(deps);
  f.passo(deps);
  assert.deepStrictEqual(acordados, ["claude"]);
});

test("passo: limite de cota na resposta marca o agente sem cota", () => {
  let estado = {};
  const marcados = [];
  f.passo({
    agora: () => new Date("2026-10-21T12:00:00Z"),
    lerEstado: () => estado, salvarEstado: (e) => { estado = e; },
    lerCanal: () => CANAL, lerGrafo: () => ({ tarefas: [] }), verPRs: () => false, listarPRs: () => [],
    acordar: () => ({ status: 1, limite: true, fim: "" }), pausado: () => false, semCota: (a) => marcados.push(a),
  });
  assert.deepStrictEqual(marcados, ["claude"]);
});

test("o script de ligar/desligar existe e usa janela escondida e prioridade baixa", () => {
  const ps = fs.readFileSync(path.join(__dirname, "..", "orquestra", "fofoqueiro.ps1"), "utf8");
  assert.match(ps, /-WindowStyle Hidden/);
  assert.match(ps, /BelowNormal/);
});
