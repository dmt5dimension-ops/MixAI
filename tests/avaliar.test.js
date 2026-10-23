// Trava a avaliação do modelo nos exemplos de validação: orquestra/avaliar.js.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RAIZ = path.resolve(__dirname, "..");
const { avaliar, lerValidacao, normalizar, agentePorComando } = require(path.join(RAIZ, "orquestra", "avaliar.js"));

const ex = (n) => ({ entrada: `pergunta ${n}`, esperado: `resposta ${n}` });

test("conta acertos, ignora espaço no fim e quebra de linha do Windows, e lista os erros", async () => {
  const respostas = { "pergunta 1": "resposta 1  \r\n", "pergunta 2": "errada", "pergunta 3": "resposta 3" };
  const r = await avaliar([ex(1), ex(2), ex(3)], async (p) => respostas[p]);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.acertos, 2);
  assert.ok(Math.abs(r.taxa - 2 / 3) < 1e-9);
  assert.deepStrictEqual(r.erros.map((e) => e.entrada), ["pergunta 2"]);
  assert.strictEqual(normalizar("a \r\nb  \n"), "a\nb");
});

test("agente que falha conta como erro, não derruba a avaliação", async () => {
  const r = await avaliar([ex(1), ex(2)], async (p) => { if (p === "pergunta 1") throw new Error("sem memória"); return "resposta 2"; });
  assert.strictEqual(r.acertos, 1);
  assert.strictEqual(r.erros[0].erro, "sem memória");
});

test("diferença que importa (maiúscula, linha a mais no meio) não passa", async () => {
  const r = await avaliar([{ entrada: "q", esperado: "a\nb" }], async () => "A\nb");
  assert.strictEqual(r.acertos, 0);
  const s = await avaliar([{ entrada: "q", esperado: "a\nb" }], async () => "a\n\nb");
  assert.strictEqual(s.acertos, 0);
});

test("limite avalia só os primeiros; lista vazia dá taxa nula", async () => {
  const r = await avaliar([ex(1), ex(2), ex(3)], async (p) => p.replace("pergunta", "resposta"), { limite: 2 });
  assert.strictEqual(r.total, 2);
  assert.strictEqual((await avaliar([], async () => "")).taxa, null);
});

test("lê o formato messages do treino.js e o agente por comando usa entrada/saída padrão", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mixai-aval-"));
  try {
    const arq = path.join(dir, "validacao.jsonl");
    fs.writeFileSync(arq, JSON.stringify({ messages: [{ role: "user", content: "oi" }, { role: "assistant", content: "OI" }] }) + "\n");
    assert.deepStrictEqual(lerValidacao(arq), [{ entrada: "oi", esperado: "OI" }]);
    assert.deepStrictEqual(lerValidacao(path.join(dir, "nao-existe.jsonl")), []);
    const cmd = `"${process.execPath}" -e "process.stdin.on('data',d=>process.stdout.write(String(d).toUpperCase()))"`;
    const r = await avaliar(lerValidacao(arq), agentePorComando(cmd));
    assert.strictEqual(r.acertos, 1);
    const ruim = await avaliar(lerValidacao(arq), agentePorComando(`"${process.execPath}" -e "process.exit(3)"`));
    assert.match(ruim.erros[0].erro, /saiu com 3/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a linha de comando pede o comando e avisa quando não há validação", () => {
  const sem = spawnSync(process.execPath, [path.join(RAIZ, "orquestra", "avaliar.js"), "rodar"], { encoding: "utf8" });
  assert.strictEqual(sem.status, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mixai-aval-"));
  try {
    const r = spawnSync(process.execPath, [path.join(RAIZ, "orquestra", "avaliar.js"), "rodar", "--comando", "x", "--arquivo", path.join(dir, "nada.jsonl")], { encoding: "utf8" });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /Sem exemplos de validação/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
