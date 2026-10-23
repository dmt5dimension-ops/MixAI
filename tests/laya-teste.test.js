// Trava o medidor do Laya (porteiro "cabe no local?"). O modelo real roda no PC do dono; aqui ele é simulado.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const raiz = path.resolve(__dirname, "..");
const laya = require(path.join(raiz, "orquestra", "laya-teste.js"));

function pastaTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "laya-"));
}
function jsonl(arquivo, linhas) {
  fs.writeFileSync(arquivo, linhas.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}

test("rotular: só o que o local resolveu vale 'local'; o resto é 'grande'", () => {
  assert.strictEqual(laya.rotular({ entrada: "x", resolvidoPor: "local" }), "local");
  assert.strictEqual(laya.rotular({ entrada: "x", resolvidoPor: "codex" }), "grande");
  assert.strictEqual(laya.rotular({ entrada: "x", resolvidoPor: "claude" }), "grande");
});

test("carregarCasos lê o casos.jsonl, ignora linha quebrada ou sem entrada e respeita o limite", () => {
  const arq = path.join(pastaTemp(), "casos.jsonl");
  jsonl(arq, [
    { entrada: "a", resolvidoPor: "local" },
    "{quebrada",
    { entrada: "", resolvidoPor: "local" },
    { entrada: "b", resolvidoPor: "codex" },
    { entrada: "c", resolvidoPor: "claude" },
  ]);
  const todos = laya.carregarCasos(arq);
  assert.deepStrictEqual(todos.map((c) => c.entrada), ["a", "b", "c"]);
  assert.deepStrictEqual(todos.map((c) => c.esperado), ["local", "grande", "grande"]);
  assert.strictEqual(laya.carregarCasos(arq, 2).length, 2);
});

test("medir: acerto, matriz de confusão e falso-local contados à mão", () => {
  const casos = [
    { entrada: "1", esperado: "local" },
    { entrada: "2", esperado: "local" },
    { entrada: "3", esperado: "grande" },
    { entrada: "4", esperado: "grande" },
  ];
  // prob >= 0.5 vira "local"
  const probs = [0.9, 0.2, 0.8, 0.1];
  const r = laya.medir(casos, probs, 0.5);
  assert.strictEqual(r.total, 4);
  assert.strictEqual(r.acertos, 2);
  assert.strictEqual(r.acerto, 0.5);
  assert.deepStrictEqual(r.matriz, { localComoLocal: 1, localComoGrande: 1, grandeComoLocal: 1, grandeComoGrande: 1 });
  assert.strictEqual(r.falsoLocal, 1);
  assert.strictEqual(r.linhaBase, 0.5);
});

test("medir: linha de base é o palpite 'sempre a maioria' e o veredito só aprova se passar dela e do mínimo", () => {
  const casos = [
    ...Array.from({ length: 24 }, (_, i) => ({ entrada: "g" + i, esperado: "grande" })),
    ...Array.from({ length: 6 }, (_, i) => ({ entrada: "l" + i, esperado: "local" })),
  ];
  const sempreGrande = laya.medir(casos, casos.map(() => 0.1), 0.5);
  assert.strictEqual(sempreGrande.linhaBase, 0.8);
  assert.strictEqual(sempreGrande.veredito.vale, false); // 80% só repete a maioria
  const perfeito = laya.medir(casos, casos.map((c) => (c.esperado === "local" ? 0.9 : 0.1)), 0.5);
  assert.strictEqual(perfeito.acerto, 1);
  assert.strictEqual(perfeito.veredito.vale, true);
  const poucos = laya.medir(casos.slice(0, 3), [0.1, 0.1, 0.1], 0.5);
  assert.strictEqual(poucos.veredito.vale, false);
  assert.match(poucos.veredito.motivo, /poucos casos/i);
});

test("medir recusa quando o modelo devolve menos respostas que casos", () => {
  assert.throws(() => laya.medir([{ entrada: "a", esperado: "local" }], [], 0.5), /respostas/);
});

test("chamarModelo conversa com um comando externo por linhas JSON (modelo simulado)", async () => {
  const dir = pastaTemp();
  const falso = path.join(dir, "falso.js");
  fs.writeFileSync(
    falso,
    `const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => { const c = JSON.parse(l); console.log(JSON.stringify({ id: c.id, probabilidade: /data/.test(c.entrada) ? 0.95 : 0.05 })); });`
  );
  const probs = await laya.chamarModelo(`node "${falso}"`, [
    { entrada: "converta a data" },
    { entrada: "refatore o sistema inteiro" },
  ]);
  assert.deepStrictEqual(probs, [0.95, 0.05]);
});

test("chamarModelo falha com mensagem clara se o comando sai com erro ou responde lixo", async () => {
  const dir = pastaTemp();
  const ruim = path.join(dir, "ruim.js");
  fs.writeFileSync(ruim, "console.log('nao sou json'); ");
  await assert.rejects(laya.chamarModelo(`node "${ruim}"`, [{ entrada: "x" }]), /resposta inválida|sem resposta/i);
  const erro = path.join(dir, "erro.js");
  fs.writeFileSync(erro, "console.error('sem memoria'); process.exit(3);");
  await assert.rejects(laya.chamarModelo(`node "${erro}"`, [{ entrada: "x" }]), /saiu com código 3/);
});

test("linha de comando: mede 50 casos com o modelo simulado e grava o relatório", () => {
  const dir = pastaTemp();
  const casos = path.join(dir, "casos.jsonl");
  const linhas = [];
  for (let i = 0; i < 50; i++) linhas.push({ entrada: i % 2 ? `tarefa mecanica ${i}` : `tarefa dificil ${i}`, resolvidoPor: i % 2 ? "local" : "codex" });
  jsonl(casos, linhas);
  const falso = path.join(dir, "falso.js");
  fs.writeFileSync(
    falso,
    `const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => { const c = JSON.parse(l); console.log(JSON.stringify({ id: c.id, probabilidade: /mecanica/.test(c.entrada) ? 0.9 : 0.1 })); });`
  );
  const saida = path.join(dir, "relatorio.json");
  const r = spawnSync(process.execPath, [path.join(raiz, "orquestra", "laya-teste.js"), "medir", casos, "--modelo", `node "${falso}"`, "--saida", saida], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  const rel = JSON.parse(fs.readFileSync(saida, "utf8"));
  assert.strictEqual(rel.total, 50);
  assert.strictEqual(rel.acerto, 1);
  assert.strictEqual(rel.veredito.vale, true);
  assert.match(r.stdout, /Acerto: 100%/);
});

test("linha de comando: sem arquivo de casos explica o que falta e sai com erro", () => {
  const r = spawnSync(process.execPath, [path.join(raiz, "orquestra", "laya-teste.js"), "medir", path.join(pastaTemp(), "nao-existe.jsonl"), "--modelo", "node -v"], { encoding: "utf8" });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /não encontrei/i);
});

test("a ponte em Python existe, faz a pergunta certa e usa o checkpoint multilíngue", () => {
  const py = fs.readFileSync(path.join(raiz, "orquestra", "laya-ponte.py"), "utf8");
  assert.match(py, /subfolder="multilingual"/);
  assert.match(py, /"type": "noul"/);
  assert.match(py, /probabilidade/);
});

// Revisão do Codex no PR #52: Number(x) || padrão trocava zero e lixo pelos padrões sem avisar.
function rodarCli(extras) {
  const dir = pastaTemp();
  const casos = path.join(dir, "casos.jsonl");
  jsonl(casos, Array.from({ length: 50 }, (_, i) => ({ entrada: `tarefa ${i}`, resolvidoPor: i % 2 ? "local" : "codex" })));
  const falso = path.join(dir, "falso.js");
  fs.writeFileSync(
    falso,
    `const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => { const c = JSON.parse(l); console.log(JSON.stringify({ id: c.id, probabilidade: 0.5 })); });`
  );
  const saida = path.join(dir, "relatorio.json");
  const r = spawnSync(process.execPath, [path.join(raiz, "orquestra", "laya-teste.js"), "medir", casos, "--modelo", `node "${falso}"`, "--saida", saida, ...extras], { encoding: "utf8" });
  return { r, relatorio: () => JSON.parse(fs.readFileSync(saida, "utf8")) };
}

test("CLI: --limite e --limiar explícitos valem de verdade, inclusive o limiar zero", () => {
  const { r, relatorio } = rodarCli(["--limite", "7", "--limiar", "0"]);
  assert.strictEqual(r.status, 0, r.stderr);
  const rel = relatorio();
  assert.strictEqual(rel.total, 7);
  assert.strictEqual(rel.limiar, 0);
  assert.strictEqual(rel.matriz.localComoGrande + rel.matriz.grandeComoGrande, 0); // limiar 0: tudo vira "local"
  const um = rodarCli(["--limiar", "1"]);
  assert.strictEqual(um.r.status, 0, um.r.stderr);
  assert.strictEqual(um.relatorio().limiar, 1);
  assert.strictEqual(um.relatorio().total, 50); // sem --limite usa o padrão de 50
});

test("CLI: --limite 0 não roda nada e explica; não vira 50 casos", () => {
  const { r } = rodarCli(["--limite", "0"]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /limite 0/i);
});

test("CLI: valores inválidos dão erro claro em vez de virar o padrão", () => {
  for (const extras of [["--limite", "abc"], ["--limite", "-3"], ["--limite", "2.5"], ["--limiar", "abc"], ["--limiar", "1.5"], ["--limiar", "-0.1"], ["--limite"], ["--limiar"]]) {
    const { r } = rodarCli(extras);
    assert.strictEqual(r.status, 2, `${extras.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /--limite|--limiar/);
  }
});

test("carregarCasos com limite 0 devolve lista vazia", () => {
  const arq = path.join(pastaTemp(), "casos.jsonl");
  jsonl(arq, [{ entrada: "a", resolvidoPor: "local" }]);
  assert.strictEqual(laya.carregarCasos(arq, 0).length, 0);
});
