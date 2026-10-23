// Trava a medida de regras com/sem: orquestra/medir-regras.js.
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const RAIZ = path.resolve(__dirname, "..");
const { medirRegras, veredito } = require(path.join(RAIZ, "orquestra", "medir-regras.js"));

const regra = (id, palavras) => ({ id, palavras, regra: `regra ${id}`, exemplo: { entrada: "e", saida: "s" }, status: "confirmada" });
const exemplos = (n, marca) => Array.from({ length: n }, (_, i) => ({ entrada: `tarefa ${marca} ${i}`, esperado: `ok ${i}` }));
// agente de mentira: só acerta quando o prompt traz a regra pedida
const respostaDe = (prompt) => `ok ${prompt.match(/tarefa \S+ (\d+)/)[1]}`;

test("regra que melhora o acerto é 'ajuda'; a que não muda é 'neutra'; a que piora é 'piora'", async () => {
  const regras = [regra("boa", ["alfa"]), regra("inutil", ["beta"]), regra("ruim", ["gama"])];
  const ex = [...exemplos(6, "alfa"), ...exemplos(6, "beta"), ...exemplos(6, "gama")];
  const agente = async (prompt) => {
    const certa = respostaDe(prompt);
    if (prompt.includes("regra boa")) return certa;            // só acerta com a regra
    if (prompt.includes("alfa")) return "errado";
    if (prompt.includes("regra ruim")) return "errado";        // com a regra erra
    return certa;                                              // gama sem regra acerta; beta sempre acerta
  };
  const r = await medirRegras({ regras, exemplos: ex, agente });
  const por = Object.fromEntries(r.map((i) => [i.id, i]));
  assert.strictEqual(por.boa.veredito, "ajuda");
  assert.deepStrictEqual([por.boa.sem, por.boa.com], [0, 6]);
  assert.strictEqual(por.inutil.veredito, "neutra");
  assert.strictEqual(por.ruim.veredito, "piora");
});

test("poucos exemplos para a regra: não conclui nada", async () => {
  const r = await medirRegras({ regras: [regra("boa", ["alfa"])], exemplos: exemplos(3, "alfa"), agente: async () => "x" });
  assert.strictEqual(r[0].veredito, "sem exemplos suficientes");
  assert.strictEqual(r[0].exemplos, 3);
});

test("só mede regra confirmada, e exemplo de outro assunto não entra na conta", async () => {
  const descartada = { ...regra("d", ["alfa"]), status: "descartada" };
  const r = await medirRegras({ regras: [descartada, regra("boa", ["alfa"])], exemplos: [...exemplos(5, "alfa"), ...exemplos(9, "zeta")], agente: async (p) => respostaDe(p) });
  assert.deepStrictEqual(r.map((i) => i.id), ["boa"]);
  assert.strictEqual(r[0].exemplos, 5);
});

test("veredito compara só os acertos", () => {
  assert.strictEqual(veredito({ acertos: 1 }, { acertos: 2 }), "ajuda");
  assert.strictEqual(veredito({ acertos: 2 }, { acertos: 2 }), "neutra");
  assert.strictEqual(veredito({ acertos: 3 }, { acertos: 2 }), "piora");
});

test("a medida usa as OUTRAS regras que disparam junto: A+B interferem, A não 'ajuda' e B 'piora'", async () => {
  const regras = [regra("A", ["alfa"]), regra("B", ["alfa"])];
  const ex = exemplos(6, "alfa");
  // acerta só com A sozinha no prompt; com A e B juntas (o que a escada realmente monta) erra
  const agente = async (prompt) => (prompt.includes("regra A") && !prompt.includes("regra B") ? respostaDe(prompt) : "errado");
  const por = Object.fromEntries((await medirRegras({ regras, exemplos: ex, agente })).map((i) => [i.id, i]));
  assert.strictEqual(por.A.veredito, "neutra");
  assert.deepStrictEqual([por.A.sem, por.A.com], [0, 0]);
  assert.strictEqual(por.B.veredito, "piora");
  assert.deepStrictEqual([por.B.sem, por.B.com], [6, 0]);
});

test("agente que falha (memória/placa) deixa a regra 'sem medida', nunca 'piora'", async () => {
  const regras = [regra("boa", ["alfa"])];
  let n = 0;
  const agente = async (prompt) => {
    if (++n > 8) throw new Error("sem memória");
    return prompt.includes("regra boa") ? respostaDe(prompt) : "errado";
  };
  const [item] = await medirRegras({ regras, exemplos: exemplos(6, "alfa"), agente });
  assert.strictEqual(item.veredito, "sem medida");
  assert.ok(item.falhas > 0);
  assert.strictEqual(item.sem, undefined);
});
