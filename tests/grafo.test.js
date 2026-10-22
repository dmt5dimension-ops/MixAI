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
// As travas são arquivos numerados ao lado do grafo: <grafo>.lock.00000001, 00000002...
const trava = (arq, n) => `${arq}.lock.${String(n).padStart(8, "0")}`;
const travas = (arq) => fs.readdirSync(path.dirname(arq)).filter((f) => f.startsWith(path.basename(arq) + ".lock.")).sort();
const soGrafo = (arq) => fs.readdirSync(path.dirname(arq)).filter((f) => !f.startsWith(path.basename(arq) + ".lock."));
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

test("processos simultâneos na linha de comando não perdem atualização", async () => {
  const arq = tmp();
  const { spawn } = require("node:child_process");
  const rodar = (id) => new Promise((ok) => spawn(process.execPath, [path.join(RAIZ, "orquestra", "grafo.js"), "add", id, "Tarefa " + id, "--arquivo", arq]).on("close", ok));
  await Promise.all(["t1", "t2", "t3", "t4", "t5", "t6"].map(rodar));
  assert.deepStrictEqual(Object.keys(grafo.carregar(arq).tarefas).sort(), ["t1", "t2", "t3", "t4", "t5", "t6"]);
});

test("atualizar trava o arquivo: gravações seguidas não perdem nenhuma, a trava é solta, e geração velha é apagada", () => {
  const arq = tmp();
  for (const id of ["a", "b", "c"]) grafo.atualizar(arq, (g) => grafo.adicionar(g, { id, titulo: id }, AGORA));
  assert.deepStrictEqual(Object.keys(grafo.carregar(arq).tarefas), ["a", "b", "c"]);
  assert.deepStrictEqual(travas(arq), ["grafo.json.lock.00000001", "grafo.json.lock.00000002", "grafo.json.lock.00000003"]);
  for (const f of travas(arq)) assert.strictEqual(fs.readFileSync(path.join(path.dirname(arq), f), "utf8"), "livre");
  for (let i = 0; i < 30; i++) grafo.atualizar(arq, (g) => g);
  assert.ok(travas(arq).length <= 22, `gerações antigas são apagadas (${travas(arq).length})`);
  assert.ok(travas(arq).includes("grafo.json.lock.00000033"));
  assert.throws(() => grafo.atualizar(arq, () => { throw new Error("falhou dentro"); }), /falhou dentro/);
  const ultima = travas(arq).pop();
  assert.strictEqual(fs.readFileSync(path.join(path.dirname(arq), ultima), "utf8"), "livre", "solta mesmo com erro");
});

test("trava de dono morto é superada por uma geração maior, sem apagar nada; texto estranho só depois de velhaMs", () => {
  const { spawnSync } = require("node:child_process");
  const arq = tmp();
  const pidMorto = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(trava(arq, 7), `${pidMorto}:x`);
  const t0 = Date.now();
  grafo.atualizar(arq, (g) => grafo.adicionar(g, { id: "a", titulo: "A" }, AGORA));
  assert.ok(Date.now() - t0 < 1500, "dono morto não faz esperar");
  assert.strictEqual(fs.readFileSync(trava(arq, 7), "utf8"), `${pidMorto}:x`, "a trava do morto continua lá, intacta");
  assert.strictEqual(fs.readFileSync(trava(arq, 8), "utf8"), "livre");
  // texto que não é de um processo (ou vazio): espera até passar de velhaMs
  fs.writeFileSync(trava(arq, 9), "99999");
  assert.throws(() => grafo.atualizar(arq, (g) => g, { esperaMs: 150 }), /travado/);
  const velho = new Date(Date.now() - 120000);
  fs.utimesSync(trava(arq, 9), velho, velho);
  grafo.atualizar(arq, (g) => grafo.adicionar(g, { id: "b", titulo: "B" }, AGORA));
  assert.deepStrictEqual(Object.keys(grafo.carregar(arq).tarefas), ["a", "b"]);
  fs.writeFileSync(trava(arq, 20), "");
  assert.throws(() => grafo.atualizar(arq, (g) => g, { esperaMs: 150 }), /travado/, "vazio e recente = dono acabou de criar");
});

test("vários processos partindo de uma trava morta não perdem atualização", async () => {
  const { spawnSync, spawn } = require("node:child_process");
  const arq = tmp();
  const pidMorto = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(trava(arq, 1), `${pidMorto}:x`);
  const ids = Array.from({ length: 8 }, (_, i) => "p" + i);
  const rodar = (id) => new Promise((ok) => spawn(process.execPath, [path.join(RAIZ, "orquestra", "grafo.js"), "add", id, "T " + id, "--arquivo", arq]).on("close", ok));
  assert.deepStrictEqual(await Promise.all(ids.map(rodar)), ids.map(() => 0));
  assert.deepStrictEqual(Object.keys(grafo.carregar(arq).tarefas).sort(), ids);
  assert.deepStrictEqual(soGrafo(arq), ["grafo.json"]);
});

test("quem perdeu a trava no meio da operação não grava por cima nem mexe na trava do outro", () => {
  const arq = tmp();
  grafo.atualizar(arq, (g) => grafo.adicionar(g, { id: "a", titulo: "A" }, AGORA));
  // outro processo supera a minha geração (aqui simulado criando uma maior) no meio da mudança
  assert.throws(() => grafo.atualizar(arq, (g) => {
    fs.writeFileSync(trava(arq, 50), "123456789:outro");
    return grafo.adicionar(g, { id: "b", titulo: "B" }, AGORA);
  }), /perdeu a trava/);
  assert.deepStrictEqual(Object.keys(grafo.carregar(arq).tarefas), ["a"]);
  assert.strictEqual(fs.readFileSync(trava(arq, 50), "utf8"), "123456789:outro");
  // e a trava do dono sobrescrita no meio também impede a gravação
  const arq2 = tmp();
  assert.throws(() => grafo.atualizar(arq2, (g) => {
    fs.writeFileSync(trava(arq2, 1), "outro-dono");
    return grafo.adicionar(g, { id: "c", titulo: "C" }, AGORA);
  }), /perdeu a trava/);
  assert.strictEqual(fs.readFileSync(trava(arq2, 1), "utf8"), "outro-dono", "não solta a trava que já não é dela");
  assert.ok(!fs.existsSync(arq2), "nada foi gravado");
});

test("o tempo de espera vale mesmo com a trava ocupada", () => {
  const arq = tmp();
  fs.writeFileSync(trava(arq, 1), `${process.pid}:vivo`);
  const t0 = Date.now();
  assert.throws(() => grafo.atualizar(arq, (g) => g, { esperaMs: 200 }), /travado/);
  assert.ok(Date.now() - t0 < 3000);
});

test("trava de dono vivo nunca é superada, mesmo com velhaMs minúsculo; o dono morrendo libera na hora", () => {
  const { spawnSync, spawn } = require("node:child_process");
  const arq = tmp();
  const script = (espera) => `const g=require(${JSON.stringify(path.join(RAIZ, "orquestra", "grafo.js"))});g.atualizar(${JSON.stringify(arq)},(x)=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${espera});return g.adicionar(x,{id:"lento",titulo:"L"})});`;
  return new Promise((ok, falha) => {
    const filho = spawn(process.execPath, ["-e", script(2000)]);
    const t0 = Date.now();
    const espera = setInterval(() => {
      if (!travas(arq).length && Date.now() - t0 < 5000) return;
      clearInterval(espera);
      try {
        grafo.atualizar(arq, (g) => grafo.adicionar(g, { id: "pai", titulo: "P" }, AGORA), { velhaMs: 1, esperaMs: 8000 });
        assert.ok(Date.now() - t0 >= 1500, "esperou o dono vivo terminar");
        assert.deepStrictEqual(Object.keys(grafo.carregar(arq).tarefas).sort(), ["lento", "pai"]);
        ok();
      } catch (erro) { falha(erro); }
    }, 20);
  });
});

test("exclusão mútua provada: 8 processos fazem ler-esperar-gravar no mesmo contador e nenhum incremento se perde", async () => {
  const arq = tmp();
  const { spawn } = require("node:child_process");
  const alvo = JSON.stringify(arq);
  const mod = JSON.stringify(path.join(RAIZ, "orquestra", "grafo.js"));
  // Cada incremento dentro da trava lê o contador, espera um tempo aleatório (abre a janela da corrida) e grava.
  const codigo = `const g=require(${mod});for(let i=0;i<6;i++)g.atualizar(${alvo},(x)=>{const n=(x.contador||0);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.floor(Math.random()*4));return {...x,contador:n+1}});`;
  const rodar = () => new Promise((ok) => {
    const f = spawn(process.execPath, ["-e", codigo]);
    let erro = "";
    f.stderr.on("data", (d) => { erro += d; });
    f.on("close", (c) => ok({ c, erro }));
  });
  const r = await Promise.all(Array.from({ length: 8 }, rodar));
  assert.deepStrictEqual(r.filter((x) => x.c !== 0), []);
  assert.strictEqual(grafo.carregar(arq).contador, 48);
});

test("pid reaproveitado depois de uma queda: trava de dono 'vivo' mais velha que vivoMaxMs é superada; mais nova, não", () => {
  const { spawn } = require("node:child_process");
  const arq = tmp();
  const vivo = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"]);
  try {
    fs.writeFileSync(trava(arq, 1), `${vivo.pid}:x`);
    assert.throws(() => grafo.atualizar(arq, (g) => g, { esperaMs: 200 }), /travado/, "dono vivo e recente: espera");
    const velha = new Date(Date.now() - 3600000);
    fs.utimesSync(trava(arq, 1), velha, velha);
    grafo.atualizar(arq, (g) => grafo.adicionar(g, { id: "a", titulo: "A" }, AGORA), { esperaMs: 2000 });
    assert.ok("a" in grafo.carregar(arq).tarefas);
  } finally { vivo.kill(); }
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
  assert.deepStrictEqual(soGrafo(arq), ["grafo.json"]);
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

test("em_revisao: trabalho pronto esperando revisão não conta no escopo; devolver volta a contar e recusa conflito", () => {
  let g = grafo.novo();
  g = grafo.adicionar(g, { id: "x", titulo: "x", escopo: ["src/a.js"] }, AGORA);
  g = grafo.adicionar(g, { id: "y", titulo: "y", escopo: ["src/"] }, AGORA);
  g = grafo.iniciar(g, "x", "codex", AGORA);
  g = grafo.revisar(g, "x", "PR #1", AGORA);
  assert.strictEqual(g.tarefas.x.estado, "em_revisao");
  g = grafo.iniciar(g, "y", "claude", AGORA);
  assert.deepStrictEqual(grafo.validar(g), [], "x está em revisão, não conta");
  assert.throws(() => grafo.devolver(g, "x", "ajustar", AGORA), /se sobrepõe ao de y/);
  assert.throws(() => grafo.revisar(grafo.novo(), "z", null, AGORA), /não existe/);
  assert.throws(() => grafo.devolver(g, "y", null, AGORA), /em_revisao/);
  const livre = grafo.revisar(g, "y", "PR #2", AGORA);
  const volta = grafo.devolver(livre, "x", "ajustar", AGORA);
  assert.strictEqual(volta.tarefas.x.estado, "em_andamento");
  assert.strictEqual(grafo.concluir(livre, "x", "merge", AGORA).tarefas.x.estado, "feita");
  assert.strictEqual(grafo.concluir(grafo.concluir(livre, "x", null, AGORA), "y", null, AGORA).tarefas.y.estado, "feita");
});

test("erros transitórios do Windows (EPERM/EBUSY/EACCES) ao criar a trava, ler e trocar de nome o arquivo são repetidos; outros erros não", () => {
  const arq = tmp();
  grafo.atualizar(arq, (g) => grafo.adicionar(g, { id: "a", titulo: "A" }, AGORA));
  const originais = { rename: fs.renameSync, rm: fs.rmSync, write: fs.writeFileSync, read: fs.readFileSync };
  const falhas = { rename: 3, write: 3, read: 3 };
  const erro = (code) => Object.assign(new Error(code), { code });
  fs.renameSync = (...a) => { if (falhas.rename-- > 0) throw erro("EPERM"); return originais.rename(...a); };
  fs.writeFileSync = (...a) => { if (/\.lock\.\d+$/.test(String(a[0])) && falhas.write-- > 0) throw erro("EACCES"); return originais.write(...a); };
  fs.readFileSync = (...a) => { if (String(a[0]).endsWith(arq) && falhas.read-- > 0) throw erro("EPERM"); return originais.read(...a); };
  try {
    grafo.atualizar(arq, (g) => grafo.adicionar(g, { id: "b", titulo: "B" }, AGORA));
  } finally {
    Object.assign(fs, { renameSync: originais.rename, writeFileSync: originais.write, readFileSync: originais.read });
  }
  assert.deepStrictEqual(Object.keys(grafo.carregar(arq).tarefas), ["a", "b"]);
  assert.deepStrictEqual(soGrafo(arq), ["grafo.json"], "sem temporário sobrando");
  assert.ok(Object.values(falhas).every((n) => n < 0), `cada erro injetado foi encontrado e repetido: ${JSON.stringify(falhas)}`);
  // erro que não é transitório sobe na hora, sem repetir
  let chamadas = 0;
  assert.throws(() => grafo.comRetentativa(() => { chamadas += 1; throw erro("ENOSPC"); }), /ENOSPC/);
  assert.strictEqual(chamadas, 1);
  // transitório que nunca passa: desiste depois de repetir
  chamadas = 0;
  assert.throws(() => grafo.comRetentativa(() => { chamadas += 1; throw erro("EPERM"); }, 3), /EPERM/);
  assert.strictEqual(chamadas, 4);
});

test("estresse: 10 processos, 3 tarefas cada, todos ao mesmo tempo, nenhuma se perde", async () => {
  const arq = tmp();
  const { spawn } = require("node:child_process");
  const rodar = (n) => new Promise((ok) => {
    const filho = spawn(process.execPath, ["-e", `const g=require(${JSON.stringify(path.join(RAIZ, "orquestra", "grafo.js"))});for(let i=0;i<3;i++)g.atualizar(${JSON.stringify(arq)},(x)=>g.adicionar(x,{id:"p${n}_"+i,titulo:"T"}));`]);
    let erro = "";
    filho.stderr.on("data", (d) => { erro += d; });
    filho.on("close", (codigo) => ok({ codigo, erro }));
  });
  const r = await Promise.all(Array.from({ length: 10 }, (_, n) => rodar(n)));
  assert.deepStrictEqual(r.filter((x) => x.codigo !== 0), []);
  assert.strictEqual(Object.keys(grafo.carregar(arq).tarefas).length, 30);
  assert.deepStrictEqual(soGrafo(arq), ["grafo.json"]);
});

test("o grafo do repositório existe, é válido e está versionado", () => {
  const real = grafo.carregar(path.join(RAIZ, "orquestra", "grafo.json"));
  assert.strictEqual(real.versao, 1);
  assert.deepStrictEqual(grafo.validar(real), []);
  // tarefa que ainda não terminou precisa declarar o escopo inteiro, senão o conflito de escopo não enxerga
  for (const t of Object.values(real.tarefas)) {
    if (t.estado === "em_andamento" || t.estado === "em_revisao") assert.ok(t.escopo.length > 0, `${t.id} sem escopo`);
  }
});
