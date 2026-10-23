// Trava o aluno estático (sem LLM): orquestra/estatico.js e as regras semente de orquestra/regras-estaticas.json.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RAIZ = path.resolve(__dirname, "..");
const E = require(path.join(RAIZ, "orquestra", "estatico.js"));
const { gerarPlano } = require(path.join(RAIZ, "orquestra", "sombra-plano", "gerar-plano.js"));
const { rodarSombra, relatorio } = require(path.join(RAIZ, "orquestra", "sombra.js"));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mixai-estatico-"));
const regra = (extra = {}) => ({ id: "r", quando: "dobro de (?<n>\\d+)", saida: "{n}{n}", exemplo: { entrada: "dobro de 7", saida: "77" }, ...extra });

test("as regras semente acertam os tipos de data, vogais e inverter do plano da sombra e não inventam regex", () => {
  const d = tmp();
  try {
    const plano = gerarPlano(60, 11, d);
    const regras = E.lerRegras();
    assert.ok(regras.length >= 3);
    for (const t of plano) {
      const r = E.resolver(regras, t.entrada);
      if (t.tipo === "regex-digitos") assert.strictEqual(r, null, "sem regra para regex: tem que dizer que não sabe");
      else assert.strictEqual(r?.saida, t.referencia, `errou ${t.id}: ${t.entrada}`);
    }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("o aluno estático entra na sombra como um modelo: acerta o que sabe e 'sem resposta' no resto", async () => {
  const d = tmp();
  try {
    const plano = gerarPlano(20, 5, d);
    const verificar = async (t, saida) => ({ ok: saida === t.referencia, motivo: "x" });
    const arquivo = path.join(d, "s.jsonl");
    const rs = await rodarSombra({ tarefas: plano, local: E.agenteEstatico(E.lerRegras()), verificar, modelo: "estatico", arquivo });
    assert.ok(rs.filter((r) => r.semResposta).length >= 1);
    const rel = relatorio(rs, { modelo: "estatico", janela: 50 });
    assert.ok(!rel["regex-digitos"], "tipo sem regra não conta contra ele");
    for (const [tipo, r] of Object.entries(rel)) assert.strictEqual(r.taxa, 1, `errou em ${tipo}`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("confirmar: exige exemplo, acerto em todos os casos e cobertura mínima; regra que erra é recusada", () => {
  assert.ok(E.confirmar(regra(), [{ entrada: "dobro de 12", esperado: "1212" }]).ok);
  const erra = E.confirmar(regra(), [{ entrada: "dobro de 12", esperado: "24" }]);
  assert.strictEqual(erra.ok, false);
  assert.match(erra.motivo, /erra o caso/);
  assert.match(E.confirmar(regra(), []).motivo, /só cobre 1/);
  assert.match(E.confirmar(regra({ exemplo: { entrada: "outra coisa", saida: "x" } }), [{ entrada: "dobro de 1", esperado: "11" }]).motivo, /não casa com o próprio exemplo/);
  assert.match(E.confirmar({ ...regra(), exemplo: undefined }, []).motivo, /sem exemplo/);
});

test("regra mal formada ou perigosa é recusada antes de rodar", () => {
  assert.match(E.confirmar(regra({ quando: "(a+)+b" }), []).motivo, /repetição dentro de repetição/);
  assert.match(E.confirmar(regra({ quando: "x".repeat(400) }), []).motivo, /grande demais/);
  assert.match(E.confirmar(regra({ quando: "(" }), []).motivo, /./);
  assert.match(E.confirmar(regra({ saida: "{n|apagar}" }), []).motivo, /filtro desconhecido/);
  assert.match(E.confirmar(regra({ id: "" }), []).motivo, /sem "id"/);
});

test("grupo que a regra não capturou invalida a saída, e entrada enorme nunca é processada", () => {
  assert.strictEqual(E.aplicar(regra({ saida: "{n}{x}" }), "dobro de 3"), null);
  assert.strictEqual(E.aplicar(regra(), "dobro de " + "9".repeat(5000)), null);
});

test("aprender grava só regra confirmada, sem duplicar o id, e a regra gravada passa a resolver", () => {
  const d = tmp();
  try {
    const arq = path.join(d, "regras.json");
    const casos = [{ entrada: "dobro de 12", esperado: "1212" }];
    assert.strictEqual(E.aprender({ candidata: regra(), casos: [{ entrada: "dobro de 1", esperado: "errado" }], arquivo: arq }).ok, false);
    assert.ok(!fs.existsSync(arq), "regra recusada não grava nada");
    const ok = E.aprender({ candidata: regra(), casos, arquivo: arq, origem: "claude", data: "2026-10-23" });
    assert.ok(ok.ok && ok.salvo);
    assert.strictEqual(E.resolver(E.lerRegras(arq), "dobro de 5").saida, "55");
    assert.match(E.aprender({ candidata: regra(), casos, arquivo: arq }).motivo, /já existe/);
    const guardada = JSON.parse(fs.readFileSync(arq, "utf8")).regras[0];
    assert.deepStrictEqual([guardada.status, guardada.origem], ["confirmada", "claude"]);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("filtros: inverter, vogais (com acento), tamanho e maiúsculas", () => {
  assert.strictEqual(E.FILTROS.inverter("abc"), "cba");
  assert.strictEqual(E.FILTROS.vogais("áÉxyz"), "2");
  assert.strictEqual(E.FILTROS.tamanho("ação"), "4");
  assert.strictEqual(E.FILTROS.maiusculas("a"), "A");
});
