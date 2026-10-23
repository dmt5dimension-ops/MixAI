// Trava o preparo do material de treino do Qwen: orquestra/treino.js.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RAIZ = path.resolve(__dirname, "..");
const { prepararDataset, preparar, temSegredo, ladoDe } = require(path.join(RAIZ, "orquestra", "treino.js"));

const caso = (n, extra = {}) => ({ entrada: `Tarefa número ${n}`, saida: `Resposta ${n}`, resolvidoPor: "codex", ...extra });

test("descarta caso sem entrada/saída, com segredo ou grande demais, e diz o motivo", () => {
  const r = prepararDataset([
    caso(1),
    { entrada: "x", saida: "" },
    caso(2, { saida: "use sk-abcdefghijklmnopqrstuvwxyz123456" }),
    caso(3, { entrada: "senha: hunter22222 faça isso" }),
    caso(4, { saida: "a".repeat(7000) }),
  ]);
  assert.strictEqual(r.resumo.aproveitados, 1);
  assert.strictEqual(r.resumo.descartados, 4);
  assert.deepStrictEqual(Object.keys(r.resumo.motivos).sort(), [
    "grande demais para o contexto do modelo local",
    "parece conter segredo",
    "sem entrada ou sem saída",
  ]);
});

test("detecta segredos comuns e não confunde texto normal", () => {
  assert.ok(temSegredo("ghp_abcdefghijklmnopqrstuvwxyz0123"));
  assert.ok(temSegredo("AKIAABCDEFGHIJKLMNOP"));
  assert.ok(temSegredo("-----BEGIN RSA PRIVATE KEY-----"));
  assert.ok(temSegredo("API_KEY=abcdef123456"));
  assert.ok(!temSegredo("Escreva um teste para a função de token de data"));
});

test("entrada repetida: igual vira 'repetido'; diferente fica com o caso mais novo", () => {
  const r = prepararDataset([
    caso(1), caso(1),
    caso(2, { saida: "velha" }), caso(2, { saida: "nova" }),
  ], { validacao: 0 });
  assert.strictEqual(r.resumo.aproveitados, 2);
  assert.strictEqual(r.resumo.motivos["repetido"], 1);
  assert.strictEqual(r.resumo.motivos["substituído por caso mais novo com a mesma entrada"], 1);
  const saidas = r.treino.map((t) => t.messages[1].content);
  assert.ok(saidas.includes("nova") && !saidas.includes("velha"));
});

test("a separação treino/validação é estável e respeita a fração", () => {
  const casos = Array.from({ length: 200 }, (_, i) => caso(i));
  const a = prepararDataset(casos, { validacao: 0.2 });
  const b = prepararDataset([...casos].reverse(), { validacao: 0.2 });
  assert.strictEqual(a.resumo.treino + a.resumo.validacao, 200);
  assert.ok(a.resumo.validacao > 20 && a.resumo.validacao < 60, `validação fora do esperado: ${a.resumo.validacao}`);
  assert.strictEqual(a.resumo.validacao, b.resumo.validacao, "a ordem dos casos não pode mudar o lado");
  assert.strictEqual(ladoDe("Tarefa número 7", 0.2), ladoDe("Tarefa número 7", 0.2));
  assert.strictEqual(prepararDataset(casos, { validacao: 0 }).resumo.validacao, 0);
});

test("o formato de saída é o de messages (usuário e assistente) e sem a regra", () => {
  const r = prepararDataset([caso(1, { regra: { id: "x", regra: "segredo da regra" } })], { validacao: 0 });
  assert.deepStrictEqual(r.treino[0], { messages: [{ role: "user", content: "Tarefa número 1" }, { role: "assistant", content: "Resposta 1" }] });
});

test("preparar grava treino, validação e relatório; poucos exemplos = não pronto", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mixai-treino-"));
  try {
    const arquivos = {
      casos: path.join(dir, "casos.jsonl"),
      treino: path.join(dir, "treino.jsonl"),
      validacao: path.join(dir, "validacao.jsonl"),
      relatorio: path.join(dir, "relatorio.json"),
    };
    fs.writeFileSync(arquivos.casos, [caso(1), caso(2), caso(3, { saida: "" })].map((c) => JSON.stringify(c)).join("\n") + "\n");
    const resumo = preparar(arquivos, { validacao: 0, minimo: 5 });
    assert.strictEqual(resumo.treino, 2);
    assert.strictEqual(resumo.pronto, false);
    assert.strictEqual(fs.readFileSync(arquivos.treino, "utf8").trim().split("\n").length, 2);
    assert.strictEqual(fs.readFileSync(arquivos.validacao, "utf8"), "");
    const rel = JSON.parse(fs.readFileSync(arquivos.relatorio, "utf8"));
    assert.strictEqual(rel.descartados.length, 1);
    assert.strictEqual(preparar(arquivos, { validacao: 0, minimo: 2 }).pronto, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a linha de comando recusa comando desconhecido", () => {
  const r = spawnSync(process.execPath, [path.join(RAIZ, "orquestra", "treino.js"), "xyz"], { encoding: "utf8" });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Uso: node orquestra\/treino\.js preparar/);
});
