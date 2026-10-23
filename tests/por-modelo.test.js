// Trava regras e casos por modelo: orquestra/por-modelo.js, e seu uso no treino e na medida de regras.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RAIZ = path.resolve(__dirname, "..");
const M = require(path.join(RAIZ, "orquestra", "por-modelo.js"));
const { preparar } = require(path.join(RAIZ, "orquestra", "treino.js"));
const { medirRegras } = require(path.join(RAIZ, "orquestra", "medir-regras.js"));

test("regra sem 'modelos' vale para todos; com 'modelos' só para os listados; campo estranho nunca vale", () => {
  assert.ok(M.regraVale({ id: "a" }, "qualquer"));
  assert.ok(M.regraVale({ id: "b", modelos: ["gemma3:1b"] }, "gemma3:1b"));
  assert.ok(!M.regraVale({ id: "b", modelos: ["gemma3:1b"] }, "mixai-local"));
  assert.ok(!M.regraVale({ id: "c", modelos: "gemma3:1b" }, "gemma3:1b"), "texto no lugar de lista não vaza a regra");
  assert.ok(!M.regraVale({ id: "d", modelos: [] }, "mixai-local"));
  assert.deepStrictEqual(M.regrasDoModelo([{ id: "a" }, { id: "b", modelos: ["x"] }], "mixai-local").map((r) => r.id), ["a"]);
  assert.throws(() => M.regraVale({ id: "a" }, " "), /modelo sem nome/);
});

test("caso sem 'modelo' é do Qwen; cada modelo vê só os seus", () => {
  const casos = [{ n: 1 }, { n: 2, modelo: "gemma3:1b" }, { n: 3, modelo: "mixai-local" }];
  assert.deepStrictEqual(M.casosDoModelo(casos, M.MODELO_PADRAO).map((c) => c.n), [1, 3]);
  assert.deepStrictEqual(M.casosDoModelo(casos, "gemma3:1b").map((c) => c.n), [2]);
  assert.deepStrictEqual(M.casosDoModelo(casos, "outro"), []);
});

test("nome de arquivo por modelo: sem sufixo para o Qwen e sem caractere perigoso para os outros", () => {
  assert.strictEqual(M.sufixoDeArquivo(M.MODELO_PADRAO), "");
  assert.match(M.sufixoDeArquivo("gemma3:1b"), /^\.gemma3_1b-[0-9a-f]{8}$/);
  assert.ok(!/[\\/]/.test(M.sufixoDeArquivo("../../x")), "sem barra: não sai da pasta");
  assert.ok(!M.sufixoDeArquivo("a/b\\c").includes("/") && !M.sufixoDeArquivo("a/b\\c").includes("\\"));
});

test("treino por modelo: separa os casos e grava arquivos com o nome do modelo, sem mexer nos do Qwen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mixai-pormodelo-"));
  try {
    const arq = { casos: path.join(dir, "casos.jsonl"), treino: path.join(dir, "treino.jsonl"), validacao: path.join(dir, "validacao.jsonl"), relatorio: path.join(dir, "relatorio.json") };
    const caso = (n, modelo) => ({ entrada: `tarefa ${n}`, saida: `resp ${n}`, resolvidoPor: "codex", ...(modelo ? { modelo } : {}) });
    fs.writeFileSync(arq.casos, [caso(1), caso(2), caso(3, "gemma3:1b"), caso(4, "gemma3:1b"), caso(5, "gemma3:1b")].map((c) => JSON.stringify(c)).join("\n") + "\n");
    assert.strictEqual(preparar(arq, { validacao: 0, minimo: 1 }).treino, 2);
    assert.strictEqual(preparar(arq, { validacao: 0, minimo: 1, modelo: "gemma3:1b" }).treino, 3);
    assert.strictEqual(fs.readFileSync(arq.treino, "utf8").trim().split("\n").length, 2, "o treino do Qwen não foi sobrescrito");
    assert.strictEqual(fs.readFileSync(path.join(dir, `treino${M.sufixoDeArquivo("gemma3:1b")}.jsonl`), "utf8").trim().split("\n").length, 3);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, `relatorio${M.sufixoDeArquivo("gemma3:1b")}.json`), "utf8")).modelo, "gemma3:1b");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("medir regras por modelo: regra de outro modelo não é medida", async () => {
  const regra = (id, modelos) => ({ id, palavras: ["alfa"], regra: `regra ${id}`, exemplo: { entrada: "e", saida: "s" }, status: "confirmada", ...(modelos ? { modelos } : {}) });
  const ex = Array.from({ length: 6 }, (_, i) => ({ entrada: `tarefa alfa ${i}`, esperado: `ok ${i}` }));
  const agente = async (p) => `ok ${p.match(/alfa (\d+)/)[1]}`;
  const r = await medirRegras({ regras: [regra("todos"), regra("so-gemma", ["gemma3:1b"])], exemplos: ex, agente });
  assert.deepStrictEqual(r.map((i) => i.id), ["todos"]);
  const g = await medirRegras({ regras: [regra("todos"), regra("so-gemma", ["gemma3:1b"])], exemplos: ex, agente, modelo: "gemma3:1b" });
  assert.deepStrictEqual(g.map((i) => i.id), ["todos", "so-gemma"]);
});

test("nomes de modelo diferentes nunca dividem o mesmo sufixo (inclui troca de símbolo e só caixa)", () => {
  const nomes = ["gemma3:1b", "gemma3/1b", "gemma3_1b", "Gemma3:1b", "gemma3:1B", "MIXAI-LOCAL", "mixai-local-2"];
  const sufixos = nomes.map((n) => M.sufixoDeArquivo(n));
  assert.strictEqual(new Set(sufixos).size, nomes.length);
  assert.strictEqual(new Set(sufixos.map((x) => x.toLowerCase())).size, nomes.length, "colide num sistema sem diferença de caixa");
  assert.strictEqual(M.sufixoDeArquivo("gemma3:1b"), M.sufixoDeArquivo("gemma3:1b"), "estável");
});

test("treino de dois modelos de nome parecido grava arquivos e dados separados", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mixai-colide-"));
  try {
    const arq = { casos: path.join(dir, "casos.jsonl"), treino: path.join(dir, "treino.jsonl"), validacao: path.join(dir, "validacao.jsonl"), relatorio: path.join(dir, "relatorio.json") };
    const caso = (n, modelo) => ({ entrada: `tarefa ${modelo} ${n}`, saida: `resp ${modelo} ${n}`, resolvidoPor: "codex", modelo });
    const a = "gemma3:1b";
    const b = "gemma3/1b";
    fs.writeFileSync(arq.casos, [caso(1, a), caso(2, a), caso(1, b), caso(2, b), caso(3, b)].map((c) => JSON.stringify(c)).join("\n") + "\n");
    assert.strictEqual(preparar(arq, { validacao: 0, minimo: 1, modelo: a }).treino, 2);
    assert.strictEqual(preparar(arq, { validacao: 0, minimo: 1, modelo: b }).treino, 3);
    const lerTreino = (m) => fs.readFileSync(path.join(dir, `treino${M.sufixoDeArquivo(m)}.jsonl`), "utf8").trim().split("\n");
    assert.strictEqual(lerTreino(a).length, 2, "o treino do primeiro modelo foi sobrescrito");
    assert.strictEqual(lerTreino(b).length, 3);
    assert.ok(lerTreino(a).every((l) => l.includes("gemma3:1b")) && lerTreino(b).every((l) => l.includes("gemma3/1b")));
    assert.notStrictEqual(M.sufixoDeArquivo(a), M.sufixoDeArquivo(b));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
