// Testa o grafo persistente de tarefas (orquestra/grafo.js): dependências, estado e gravação segura.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RAIZ = path.resolve(__dirname, "..");
const grafo = require(path.join(RAIZ, "orquestra", "grafo.js"));

const AGORA = "2026-10-22T12:00:00.000Z";
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grafo-")), "grafo.json");

function exemplo() {
  let g = grafo.novo();
  g = grafo.adicionar(g, { id: "a", titulo: "Escrever teste", agente: "codex", escopo: ["tests/x.test.js"], verificar: "npm test" }, AGORA);
  g = grafo.adicionar(g, { id: "b", titulo: "Implementar", agente: "codex", depende: ["a"] }, AGORA);
  g = grafo.adicionar(g, { id: "c", titulo: "Revisar", agente: "claude", depende: ["a", "b"] }, AGORA);
  return g;
}

test("tarefa nova começa pendente com campos padrão, e id repetido é recusado", () => {
  const g = exemplo();
  assert.deepStrictEqual(g.tarefas.a, { id: "a", titulo: "Escrever teste", estado: "pendente", depende: [], agente: "codex", escopo: ["tests/x.test.js"], verificar: "npm test", tentativas: 0, atualizado: AGORA, resultado: null });
  assert.throws(() => grafo.adicionar(g, { id: "a", titulo: "de novo" }, AGORA), /já existe/);
  assert.throws(() => grafo.adicionar(g, { titulo: "sem id" }, AGORA), /id/);
  assert.throws(() => grafo.adicionar(g, { id: "z", titulo: "x", agente: "gpt" }, AGORA), /agente/);
});

test("prontas: só tarefa pendente com todas as dependências feitas", () => {
  let g = exemplo();
  assert.deepStrictEqual(grafo.prontas(g).map((t) => t.id), ["a"]);
  g = grafo.iniciar(g, "a", "codex", AGORA);
  assert.deepStrictEqual(grafo.prontas(g), []);
  g = grafo.concluir(g, "a", { ok: true }, AGORA);
  assert.deepStrictEqual(grafo.prontas(g).map((t) => t.id), ["b"]);
  g = grafo.concluir(grafo.iniciar(g, "b", "codex", AGORA), "b", null, AGORA);
  assert.deepStrictEqual(grafo.prontas(g).map((t) => t.id), ["c"]);
});

test("falhar conta a tentativa e devolve a tarefa para a fila; ao passar do limite fica falhou e trava as dependentes", () => {
  let g = exemplo();
  g = grafo.falhar(grafo.iniciar(g, "a", "codex", AGORA), "a", "teste vermelho", AGORA, 2);
  assert.strictEqual(g.tarefas.a.estado, "pendente");
  assert.strictEqual(g.tarefas.a.tentativas, 1);
  assert.strictEqual(g.tarefas.a.resultado, "teste vermelho");
  g = grafo.falhar(grafo.iniciar(g, "a", "codex", AGORA), "a", "de novo", AGORA, 2);
  assert.strictEqual(g.tarefas.a.estado, "falhou");
  assert.deepStrictEqual(grafo.prontas(g), []);
  assert.deepStrictEqual(grafo.travadas(g).map((t) => t.id), ["b", "c"]);
});

test("transições inválidas são recusadas (concluir sem iniciar, iniciar tarefa não pronta)", () => {
  const g = exemplo();
  assert.throws(() => grafo.concluir(g, "a", null, AGORA), /em_andamento/);
  assert.throws(() => grafo.iniciar(g, "b", "codex", AGORA), /não está pronta/);
  assert.throws(() => grafo.iniciar(g, "nada", "codex", AGORA), /não existe/);
});

test("validar acusa dependência inexistente, ciclo e escopo sobreposto entre tarefas em andamento", () => {
  let g = exemplo();
  assert.deepStrictEqual(grafo.validar(g), []);
  const ruim = JSON.parse(JSON.stringify(g));
  ruim.tarefas.a.depende = ["c"];
  assert.ok(grafo.validar(ruim).some((e) => /ciclo/.test(e)));
  const solta = JSON.parse(JSON.stringify(g));
  solta.tarefas.b.depende = ["fantasma"];
  assert.ok(grafo.validar(solta).some((e) => /fantasma/.test(e)));
  const dupla = grafo.novo();
  let d = grafo.adicionar(dupla, { id: "x", titulo: "x", escopo: ["src/a.js"] }, AGORA);
  d = grafo.adicionar(d, { id: "y", titulo: "y", escopo: ["./src/a.js"] }, AGORA);
  d = grafo.iniciar(grafo.iniciar(d, "x", "codex", AGORA), "y", "claude", AGORA);
  assert.ok(grafo.validar(d).some((e) => /escopo/.test(e)));
});

test("escopo sobreposto: pasta contra arquivo, barra final, ./, maiúsculas e curinga contam como conflito", () => {
  const conflita = (a, b) => {
    let g = grafo.novo();
    g = grafo.adicionar(g, { id: "x", titulo: "x", escopo: [a] }, AGORA);
    g = grafo.adicionar(g, { id: "y", titulo: "y", escopo: [b] }, AGORA);
    g = grafo.iniciar(grafo.iniciar(g, "x", "codex", AGORA), "y", "claude", AGORA);
    return grafo.validar(g).some((e) => /escopo/.test(e));
  };
  assert.ok(conflita("src", "src/a.js"));
  assert.ok(conflita("src/", "src/sub/a.js"));
  assert.ok(conflita("src/a.js", "./src/A.js"));
  assert.ok(conflita("src\\a.js", "src/a.js"));
  assert.ok(conflita("src/*.css", "src/a.css"));
  assert.ok(conflita("docs/memoria/", "docs/memoria/estado.md"));
  assert.ok(!conflita("src/a.js", "src/ab.js"));
  assert.ok(!conflita("src", "srcx/a.js"));
  assert.ok(!conflita("tests/", "docs/"));
});

test("atualizar trava o arquivo: duas gravações seguidas não perdem nenhuma, e trava velha é ignorada", () => {
  const arq = tmp();
  grafo.atualizar(arq, (g) => grafo.adicionar(g, { id: "a", titulo: "A" }, AGORA));
  grafo.atualizar(arq, (g) => grafo.adicionar(g, { id: "b", titulo: "B" }, AGORA));
  assert.deepStrictEqual(Object.keys(grafo.carregar(arq).tarefas), ["a", "b"]);
  assert.ok(!fs.existsSync(arq + ".lock"));
  fs.writeFileSync(arq + ".lock", "99999");
  const velho = new Date(Date.now() - 120000);
  fs.utimesSync(arq + ".lock", velho, velho);
  grafo.atualizar(arq, (g) => grafo.adicionar(g, { id: "c", titulo: "C" }, AGORA));
  assert.strictEqual(Object.keys(grafo.carregar(arq).tarefas).length, 3);
  fs.writeFileSync(arq + ".lock", "99999");
  assert.throws(() => grafo.atualizar(arq, (g) => g, { esperaMs: 150 }), /travado/);
  fs.rmSync(arq + ".lock");
  assert.throws(() => grafo.atualizar(arq, () => { throw new Error("falhou dentro"); }), /falhou dentro/);
  assert.ok(!fs.existsSync(arq + ".lock"), "a trava tem que ser solta mesmo com erro");
});

test("processos simultâneos na linha de comando não perdem atualização", async () => {
  const arq = tmp();
  const { spawn } = require("node:child_process");
  const rodar = (id) => new Promise((ok) => spawn(process.execPath, [path.join(RAIZ, "orquestra", "grafo.js"), "add", id, "Tarefa " + id, "--arquivo", arq]).on("close", ok));
  await Promise.all(["t1", "t2", "t3", "t4", "t5", "t6"].map(rodar));
  assert.deepStrictEqual(Object.keys(grafo.carregar(arq).tarefas).sort(), ["t1", "t2", "t3", "t4", "t5", "t6"]);
});

test("vários processos partindo de uma trava velha não perdem atualização nem apagam a trava um do outro", async () => {
  const arq = tmp();
  fs.writeFileSync(arq + ".lock", "morto");
  const velho = new Date(Date.now() - 120000);
  fs.utimesSync(arq + ".lock", velho, velho);
  const { spawn } = require("node:child_process");
  const ids = Array.from({ length: 8 }, (_, i) => "p" + i);
  const rodar = (id) => new Promise((ok) => {
    const f = spawn(process.execPath, [path.join(RAIZ, "orquestra", "grafo.js"), "add", id, "T " + id, "--arquivo", arq]);
    f.on("close", (codigo) => ok(codigo));
  });
  const codigos = await Promise.all(ids.map(rodar));
  assert.deepStrictEqual(codigos, ids.map(() => 0));
  assert.deepStrictEqual(Object.keys(grafo.carregar(arq).tarefas).sort(), ids);
  assert.ok(!fs.existsSync(arq + ".lock") && !fs.existsSync(arq + ".limpeza"));
});

test("quem perdeu a trava no meio da operação não grava por cima", () => {
  const arq = tmp();
  grafo.atualizar(arq, (g) => grafo.adicionar(g, { id: "a", titulo: "A" }, AGORA));
  assert.throws(() => grafo.atualizar(arq, (g) => {
    fs.rmSync(arq + ".lock");
    fs.writeFileSync(arq + ".lock", "outro-dono");
    return grafo.adicionar(g, { id: "b", titulo: "B" }, AGORA);
  }), /perdeu a trava/);
  assert.deepStrictEqual(Object.keys(grafo.carregar(arq).tarefas), ["a"]);
  assert.strictEqual(fs.readFileSync(arq + ".lock", "utf8"), "outro-dono", "não pode apagar a trava do outro dono");
});

test("o tempo de espera vale mesmo com a trava sumindo e voltando", () => {
  const arq = tmp();
  fs.writeFileSync(arq + ".lock", "vivo");
  const t0 = Date.now();
  assert.throws(() => grafo.atualizar(arq, (g) => g, { esperaMs: 200 }), /travado/);
  assert.ok(Date.now() - t0 < 3000);
});

test("trava de dono vivo nunca é tirada, mesmo velha; a de dono morto cai na hora", () => {
  const { spawnSync, spawn } = require("node:child_process");
  const arq = tmp();
  const script = (espera) => `const g=require(${JSON.stringify(path.join(RAIZ, "orquestra", "grafo.js"))});g.atualizar(${JSON.stringify(arq)},(x)=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${espera});return g.adicionar(x,{id:"lento",titulo:"L"})});`;
  return new Promise((ok, falha) => {
    const filho = spawn(process.execPath, ["-e", script(2000)]);
    const t0 = Date.now();
    const espera = setInterval(() => {
      if (!fs.existsSync(arq + ".lock") && Date.now() - t0 < 5000) return;
      clearInterval(espera);
      try {
        // trava do filho (vivo) é considerada velha demais (1 ms), e mesmo assim não pode ser tirada
        grafo.atualizar(arq, (g) => grafo.adicionar(g, { id: "pai", titulo: "P" }, AGORA), { velhaMs: 1, esperaMs: 8000 });
        assert.ok(Date.now() - t0 >= 1500, "esperou o dono vivo terminar");
        assert.deepStrictEqual(Object.keys(grafo.carregar(arq).tarefas).sort(), ["lento", "pai"]);
        // dono morto: o pid de um processo que já terminou
        const pidMorto = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim();
        fs.writeFileSync(arq + ".lock", `${pidMorto}:abc`);
        const t1 = Date.now();
        grafo.atualizar(arq, (g) => grafo.adicionar(g, { id: "depois", titulo: "D" }, AGORA), { esperaMs: 3000 });
        assert.ok(Date.now() - t1 < 2000, "trava de dono morto cai na hora, sem esperar a idade");
        assert.ok("depois" in grafo.carregar(arq).tarefas);
        ok();
      } catch (erro) { falha(erro); }
    }, 20);
  });
});

test("adicionar recusa dependência que criaria ciclo", () => {
  let g = exemplo();
  assert.throws(() => grafo.adicionar(g, { id: "d", titulo: "x", depende: ["d"] }, AGORA), /ciclo/);
});

test("salvar é atômico e carregar devolve o mesmo grafo; arquivo corrompido dá erro e não é apagado", () => {
  const arq = tmp();
  assert.deepStrictEqual(grafo.carregar(arq), grafo.novo());
  const g = exemplo();
  grafo.salvar(arq, g);
  assert.deepStrictEqual(grafo.carregar(arq), g);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(arq)), ["grafo.json"]);
  fs.writeFileSync(arq, "{quebrado");
  assert.throws(() => grafo.carregar(arq), /corrompido/);
  assert.strictEqual(fs.readFileSync(arq, "utf8"), "{quebrado");
});

test("linha de comando: add, proximas, iniciar, concluir e status persistem no arquivo", () => {
  const arq = tmp();
  const cli = (...args) => spawnSync(process.execPath, [path.join(RAIZ, "orquestra", "grafo.js"), ...args, "--arquivo", arq], { encoding: "utf8" });
  assert.strictEqual(cli("add", "a", "Primeira", "--agente", "codex").status, 0);
  assert.strictEqual(cli("add", "b", "Segunda", "--depende", "a").status, 0);
  assert.match(cli("proximas").stdout, /^a\b/m);
  assert.strictEqual(cli("iniciar", "a", "codex").status, 0);
  assert.strictEqual(cli("concluir", "a").status, 0);
  assert.match(cli("proximas").stdout, /^b\b/m);
  assert.match(cli("status").stdout, /feita: 1/);
  assert.strictEqual(cli("iniciar", "b", "codex").status, 0);
  assert.notStrictEqual(cli("iniciar", "b", "codex").status, 0);
});

test("o grafo do repositório existe, é válido e está versionado", () => {
  const real = grafo.carregar(path.join(RAIZ, "orquestra", "grafo.json"));
  assert.strictEqual(real.versao, 1);
  assert.deepStrictEqual(grafo.validar(real), []);
});
