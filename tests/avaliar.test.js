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

test("limite 0 avalia zero exemplos; negativo, fracionário e texto são recusados", async () => {
  let chamadas = 0;
  const agente = async () => { chamadas++; return "x"; };
  const ex = [{ entrada: "a", esperado: "x" }, { entrada: "b", esperado: "x" }];
  const r = await avaliar(ex, agente, { limite: 0 });
  assert.strictEqual(r.total, 0);
  assert.strictEqual(chamadas, 0);
  for (const ruim of [-1, 1.5, NaN, "2", null]) await assert.rejects(avaliar(ex, agente, { limite: ruim }), /limite inválido/);
  assert.strictEqual(chamadas, 0);
  assert.strictEqual((await avaliar(ex, agente, { limite: 1 })).total, 1);
});

test("a linha de comando recusa --limite inválido sem chamar o agente", () => {
  const arq = path.join(os.tmpdir(), `val-${process.pid}.jsonl`);
  fs.writeFileSync(arq, JSON.stringify({ messages: [{ content: "a" }, { content: "x" }] }) + "\n");
  for (const v of ["-1", "abc", "1.5"]) {
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "orquestra", "avaliar.js"), "rodar", "--comando", "node -e \"process.exit(7)\"", "--limite", v, "--arquivo", arq], { encoding: "utf8" });
    assert.strictEqual(r.status, 1, v);
    assert.match(r.stderr, /--limite/);
  }
});

test("estourou o prazo: o comando e os processos que ele criou morrem", async () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "prazo-"));
  const pidFile = path.join(pasta, "neto.pid");
  fs.writeFileSync(path.join(pasta, "neto.js"), `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  fs.writeFileSync(path.join(pasta, "pai.js"), `require('child_process').spawn(process.execPath, [${JSON.stringify(path.join(pasta, "neto.js"))}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`);
  await assert.rejects(agentePorComando(`node "${path.join(pasta, "pai.js")}"`, 1500)("x"), /tempo máximo/);
  await new Promise((r) => setTimeout(r, 500));
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  let vivo = true;
  try { process.kill(pid, 0); } catch { vivo = false; }
  // processo já morto mas ainda não recolhido (zumbi) não conta como vivo
  try { if (vivo && /^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"))) vivo = false; } catch { /* sem /proc (Windows/macOS) */ }
  if (vivo) { try { process.kill(pid, "SIGKILL"); } catch { /* limpa */ } }
  assert.strictEqual(vivo, false, "o processo neto sobreviveu ao prazo");
});
