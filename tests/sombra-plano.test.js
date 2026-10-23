// Trava o plano da fase 0/1 do Qwen: orquestra/sombra-plano (gerador e verificadores mecânicos).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RAIZ = path.resolve(__dirname, "..");
const { gerarPlano } = require(path.join(RAIZ, "orquestra", "sombra-plano", "gerar-plano.js"));
const { conferir, limpar } = require(path.join(RAIZ, "orquestra", "sombra-plano", "confere.js"));
const { validar } = require(path.join(RAIZ, "orquestra", "sombra.js"));

const dados = () => fs.mkdtempSync(path.join(os.tmpdir(), "mixai-plano-"));
const rodar = (cmd, resposta) => spawnSync(cmd, { shell: true, cwd: RAIZ, input: resposta, encoding: "utf8" }).status;

test("o plano é válido para a sombra, determinístico e cobre todos os tipos", () => {
  const d = dados();
  try {
    const a = gerarPlano(24, 7, d);
    assert.doesNotThrow(() => validar(a));
    assert.deepStrictEqual(a, gerarPlano(24, 7, d));
    assert.notDeepStrictEqual(a.map((t) => t.entrada), gerarPlano(24, 8, d).map((t) => t.entrada));
    assert.deepStrictEqual([...new Set(a.map((t) => t.tipo))].sort(), ["contar-vogais", "data-iso", "inverter-texto", "regex-digitos"]);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("a resposta de referência passa no verificador do próprio comando e a errada não", () => {
  const d = dados();
  try {
    for (const t of gerarPlano(12, 3, d)) {
      assert.strictEqual(rodar(t.verificar, t.referencia + "\n"), 0, `referência reprovada: ${t.id}`);
      assert.strictEqual(rodar(t.verificar, "resposta errada"), 1, `errada aprovada: ${t.id}`);
      assert.strictEqual(rodar(t.verificar, ""), 1, `vazia aprovada: ${t.id}`);
    }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("o verificador aceita crases e aspas em volta, e a regex que aceita tudo reprova", () => {
  assert.strictEqual(limpar("```\n2026-01-02\n```"), "2026-01-02");
  assert.ok(conferir("igual", "2026-01-02", "`2026-01-02`"));
  const d = dados();
  try {
    const arq = path.join(d, "r.json");
    fs.writeFileSync(arq, JSON.stringify({ bons: ["123"], ruins: ["12", "abc"] }));
    assert.ok(conferir("regex", arq, "\\d{3}"));
    assert.ok(!conferir("regex", arq, ".*"));
    assert.ok(!conferir("regex", arq, "(["));
    assert.throws(() => conferir("xyz", "a", "a"), /modo desconhecido/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("planos de sementes diferentes não se atropelam: gerar o B não muda o verificador do A, e nenhum arquivo é criado", () => {
  const antes = new Set(fs.readdirSync(os.tmpdir()));
  const a = gerarPlano(24, 1);
  const regexA = a.filter((t) => t.tipo === "regex-digitos");
  gerarPlano(24, 4); // plano B depois do A, antes de rodar o A
  for (const t of regexA) {
    assert.strictEqual(rodar(t.verificar, t.referencia + "\n"), 0, `referência do plano A reprovada depois de gerar B: ${t.id}`);
    assert.strictEqual(rodar(t.verificar, ".*"), 1);
  }
  assert.ok(regexA.length >= 2);
  assert.deepStrictEqual(a, gerarPlano(24, 1));
  assert.ok(!a.some((t) => t.verificar.includes(os.tmpdir())), "o verificador depende da pasta temporária");
  const novos = fs.readdirSync(os.tmpdir()).filter((n) => !antes.has(n) && /sombra-dados/.test(n));
  assert.deepStrictEqual(novos, []);
});
