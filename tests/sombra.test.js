// Trava o modo sombra (fase 1) e a tabela de tipos liberados (fase 2): orquestra/sombra.js.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RAIZ = path.resolve(__dirname, "..");
const { rodarSombra, relatorio, liberados, liberadosDeTodos, comparar, gravarLiberados, tipoLiberado, lerRegistros, validar, MODELO_PADRAO } = require(path.join(RAIZ, "orquestra", "sombra.js"));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mixai-sombra-"));
const tarefa = (id, tipo = "data") => ({ id, tipo, entrada: `faça ${id}` });

test("registra acerto, erro e 'sem resposta' sem usar a resposta do Qwen", async () => {
  const dir = tmp();
  try {
    const arquivo = path.join(dir, "s.jsonl");
    const local = async (p) => { if (p.endsWith("c3")) throw new Error("sem memória"); return p.endsWith("a1") ? "certo" : "errado"; };
    const verificar = async (t, saida) => ({ ok: saida === "certo", motivo: "diferente" });
    const rs = await rodarSombra({ tarefas: [tarefa("a1"), tarefa("b2"), tarefa("c3")], local, verificar, arquivo, agora: () => "2026-10-23" });
    assert.deepStrictEqual(rs.map((r) => [r.acertou, r.semResposta]), [[true, undefined], [false, undefined], [undefined, true]]);
    assert.strictEqual(lerRegistros(arquivo).length, 3);
    assert.ok(rs.every((r) => !("saida" in r)), "a resposta do Qwen não é guardada nem usada");
    const rel = relatorio(lerRegistros(arquivo));
    assert.deepStrictEqual(rel.data, { total: 2, amostra: 2, acertos: 1, taxa: 0.5 }, "sem resposta não conta contra o Qwen");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("plano mal formado é recusado antes de chamar o Qwen", () => {
  assert.throws(() => validar([]), /plano vazio/);
  assert.throws(() => validar([{ id: "a", tipo: "x" }]), /sem "entrada"/);
  assert.throws(() => validar([tarefa("a"), tarefa("a")]), /id repetido/);
});

const regs = (tipo, certas, erradas) => [...Array(certas).fill({ tipo, acertou: true }), ...Array(erradas).fill({ tipo, acertou: false })];

test("só libera com amostra completa e taxa no corte; só olha as últimas tentativas", () => {
  assert.strictEqual(liberados(regs("a", 19, 0)).a.liberado, false, "amostra pequena não libera");
  assert.strictEqual(liberados(regs("a", 17, 3)).a.liberado, false, "85% < 90%");
  assert.strictEqual(liberados(regs("a", 18, 2)).a.liberado, true, "90% com 20 tentativas libera");
  const antigaRuim = [...regs("a", 0, 30), ...regs("a", 20, 0)];
  assert.strictEqual(liberados(antigaRuim).a.liberado, true, "erros antigos saem da janela");
  const recenteRuim = [...regs("a", 30, 0), ...regs("a", 0, 5)];
  assert.strictEqual(liberados(recenteRuim).a.liberado, false, "erros recentes tiram a liberação");
  assert.strictEqual(liberados(regs("a", 20, 0), { corte: 1 }).a.liberado, true);
  assert.deepStrictEqual(liberados([]), {});
});

test("tipoLiberado: tipo ausente, arquivo ausente ou corrompido nunca libera", () => {
  const dir = tmp();
  try {
    const arq = path.join(dir, "l.json");
    assert.strictEqual(tipoLiberado("a", MODELO_PADRAO, arq), false);
    gravarLiberados(arq, liberadosDeTodos([...regs("a", 20, 0), ...regs("b", 5, 5)]));
    assert.strictEqual(tipoLiberado("a", MODELO_PADRAO, arq), true);
    assert.strictEqual(tipoLiberado("b", MODELO_PADRAO, arq), false);
    assert.strictEqual(tipoLiberado("c", MODELO_PADRAO, arq), false);
    assert.strictEqual(tipoLiberado("a", "outro-modelo", arq), false, "modelo sem dados nunca libera");
    fs.writeFileSync(arq, "{lixo");
    assert.strictEqual(tipoLiberado("a", MODELO_PADRAO, arq), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const doModelo = (modelo, lista) => lista.map((r) => ({ ...r, modelo }));

test("cada modelo tem a sua nota e a sua liberação; registro antigo sem modelo é do Qwen", async () => {
  const dir = tmp();
  try {
    const arquivo = path.join(dir, "s.jsonl");
    const verificar = async (t, saida) => ({ ok: saida === "certo", motivo: "x" });
    await rodarSombra({ tarefas: [tarefa("a1")], local: async () => "certo", verificar, arquivo });
    await rodarSombra({ tarefas: [tarefa("a1")], local: async () => "errado", verificar, arquivo, modelo: "gemma3:1b" });
    const reg = lerRegistros(arquivo);
    assert.deepStrictEqual(reg.map((r) => [r.modelo, r.acertou]), [[MODELO_PADRAO, true], ["gemma3:1b", false]]);
    assert.strictEqual(relatorio(reg).data.acertos, 1);
    assert.strictEqual(relatorio(reg, { modelo: "gemma3:1b" }).data.acertos, 0);
    assert.deepStrictEqual(relatorio([{ tipo: "t", acertou: true }]).t.acertos, 1, "sem campo modelo conta para o Qwen");
    await assert.rejects(rodarSombra({ tarefas: [tarefa("x")], local: async () => "", verificar, arquivo, modelo: " " }), /modelo sem nome/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a tabela de liberados é por modelo: um modelo bom não libera o outro", () => {
  const reg = [...doModelo("qwen", regs("data", 20, 0)), ...doModelo("gemma", regs("data", 10, 10))];
  const tabela = liberadosDeTodos(reg);
  assert.strictEqual(tabela.qwen.data.liberado, true);
  assert.strictEqual(tabela.gemma.data.liberado, false);
  assert.deepStrictEqual(Object.keys(tabela).sort(), ["gemma", "qwen"]);
});

test("comparar mostra tipo x modelo", () => {
  const reg = [...doModelo("qwen", regs("data", 9, 1)), ...doModelo("gemma", regs("data", 5, 5)), ...doModelo("gemma", regs("regex", 3, 0))];
  const c = comparar(reg);
  assert.strictEqual(c.data.qwen.taxa, 0.9);
  assert.strictEqual(c.data.gemma.taxa, 0.5);
  assert.deepStrictEqual(Object.keys(c.regex), ["gemma"], "modelo sem tentativas do tipo não aparece");
});

test("a linha de comando recusa comando desconhecido", () => {
  const r = spawnSync(process.execPath, [path.join(RAIZ, "orquestra", "sombra.js"), "xyz"], { encoding: "utf8" });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Uso: node orquestra\/sombra\.js/);
  const outro = spawnSync(process.execPath, [path.join(RAIZ, "orquestra", "sombra.js"), "rodar", "plano-que-nao-existe.json", "--modelo", "gemma3:1b"], { encoding: "utf8" });
  assert.strictEqual(outro.status, 1);
  assert.match(outro.stderr, /precisa de --comando/);
});
