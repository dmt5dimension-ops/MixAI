// Testa as proteções do modelo local: nunca cair para o processador, conferir a memória
// livre antes de carregar e gravar o log do servidor (local/rodar-local.js e local/*.ps1).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RAIZ = path.resolve(__dirname, "..");
const PASTA = path.join(RAIZ, "local");
const RODAR = path.join(PASTA, "rodar-local.js");
const POWERSHELL = process.platform === "win32" ? "powershell" : "pwsh";

function pastaTemporaria() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "protecao-local-"));
}

// Um "ollama" falso em Node: grava que foi chamado e devolve a entrada em maiúsculas.
function ollamaFalso(dir, codigo = 0) {
  const marca = path.join(dir, "chamado.txt");
  const falso = path.join(dir, "ollama-falso.js");
  fs.writeFileSync(falso, `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(marca)}, process.argv.slice(2).join(" "));
    let e = ""; process.stdin.on("data", (d) => (e += d)).on("end", () => { process.stdout.write(e.toUpperCase()); process.exit(${codigo}); });
  `);
  return { comando: `node "${falso}"`, marca };
}

function rodar(entrada, env) {
  return spawnSync(process.execPath, [RODAR], { input: entrada, encoding: "utf8", env: { ...process.env, ...env } });
}

test("com pouca memória livre o modelo local nem é chamado e a tarefa sobe na escada", () => {
  const dir = pastaTemporaria();
  const { comando, marca } = ollamaFalso(dir);
  const r = rodar("tarefa", { MIXAI_OLLAMA: comando, MIXAI_MEMORIA_MINIMA_GB: "100000" });
  assert.notStrictEqual(r.status, 0, "a escada só passa adiante quando o local sai com erro");
  assert.match(r.stderr, /memória livre/i);
  assert.ok(!fs.existsSync(marca), "o Ollama não pode ser chamado com a memória no limite");
});

test("com memória suficiente a tarefa vai para o mixai-local e a resposta volta inteira", () => {
  const dir = pastaTemporaria();
  const { comando, marca } = ollamaFalso(dir);
  const r = rodar("tarefa curta", { MIXAI_OLLAMA: comando, MIXAI_MEMORIA_MINIMA_GB: "0" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, "TAREFA CURTA");
  assert.strictEqual(fs.readFileSync(marca, "utf8"), "run mixai-local");
});

test("se o Ollama falhar, o rodar-local também falha", () => {
  const dir = pastaTemporaria();
  const { comando } = ollamaFalso(dir, 1);
  const r = rodar("tarefa", { MIXAI_OLLAMA: comando, MIXAI_MEMORIA_MINIMA_GB: "0" });
  assert.notStrictEqual(r.status, 0);
});

// Um "ollama" falso que falha por falta de espaço na placa nas primeiras `falhas` chamadas.
function ollamaQueFalhaAntes(dir, falhas) {
  const contador = path.join(dir, "vezes.txt");
  const falso = path.join(dir, "ollama-instavel.js");
  fs.writeFileSync(falso, `
    const fs = require("node:fs");
    const n = (fs.existsSync(${JSON.stringify(contador)}) ? Number(fs.readFileSync(${JSON.stringify(contador)}, "utf8")) : 0) + 1;
    fs.writeFileSync(${JSON.stringify(contador)}, String(n));
    let e = ""; process.stdin.on("data", (d) => (e += d)).on("end", () => {
      if (n <= ${falhas}) { process.stderr.write("Error: llama-server reported out-of-memory during startup: failed to allocate Vulkan0 buffer"); process.exit(1); }
      process.stdout.write("ok"); process.exit(0);
    });
  `);
  return { comando: `node "${falso}"`, vezes: () => Number(fs.readFileSync(contador, "utf8")) };
}

test("se a placa falhar por falta de espaço na primeira carga, tenta mais uma vez", () => {
  // Visto no PC: logo depois de reiniciar o Ollama, a primeira carga falhou e a segunda funcionou.
  const dir = pastaTemporaria();
  const o = ollamaQueFalhaAntes(dir, 1);
  const r = rodar("tarefa", { MIXAI_OLLAMA: o.comando, MIXAI_MEMORIA_MINIMA_GB: "0", MIXAI_ESPERA_MS: "10" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, "ok");
  assert.strictEqual(o.vezes(), 2);
});

test("se a placa continuar sem espaço, desiste depois da segunda tentativa", () => {
  const dir = pastaTemporaria();
  const o = ollamaQueFalhaAntes(dir, 5);
  const r = rodar("tarefa", { MIXAI_OLLAMA: o.comando, MIXAI_MEMORIA_MINIMA_GB: "0", MIXAI_ESPERA_MS: "10" });
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(o.vezes(), 2);
});

test("o mínimo de memória livre padrão fica em local/protecao.json", () => {
  const protecao = JSON.parse(fs.readFileSync(path.join(PASTA, "protecao.json"), "utf8"));
  assert.ok(protecao.memoriaLivreMinimaGB >= 1 && protecao.memoriaLivreMinimaGB <= 8);
});

test("a escada e o chamar.js usam o rodar-local, nunca o ollama direto", () => {
  for (const arquivo of ["escada.js", "chamar.js"]) {
    const texto = fs.readFileSync(path.join(RAIZ, "orquestra", arquivo), "utf8");
    assert.match(texto, /rodar-local\.js/, arquivo);
    assert.doesNotMatch(texto, /ollama run mixai-local/, arquivo);
  }
});

test("o mixai-local é criado com num_gpu 99, para falhar em vez de cair para o processador", () => {
  // Bug visto: com a memória do Windows cheia, o modelo caiu para o processador e ocupou 8,2 GB de RAM.
  const dir = pastaTemporaria();
  const falso = path.join(dir, "ollama-falso.ps1");
  const copia = path.join(dir, "modelfile.txt");
  fs.writeFileSync(falso, `Copy-Item $args[3] '${copia}'\nexit 0\n`);
  const r = spawnSync(POWERSHELL, [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(PASTA, "criar-apelido.ps1"),
    "-Modelo", "qwen2.5-coder:7b", "-Contexto", "4096", "-Nucleos", "4", "-Ollama", falso,
  ], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(fs.readFileSync(copia, "utf8"), /^PARAMETER num_gpu 99\s*$/m);
});

test("nenhum código do projeto manda o modelo local rodar no processador (num_gpu 0)", () => {
  const proibido = /num_gpu["']?\s*[:=]?\s*0\b/;
  for (const pasta of ["orquestra", "local"]) {
    for (const nome of fs.readdirSync(path.join(RAIZ, pasta))) {
      const arquivo = path.join(RAIZ, pasta, nome);
      if (!fs.statSync(arquivo).isFile() || !/\.(js|ps1|json)$/.test(nome)) continue;
      assert.doesNotMatch(fs.readFileSync(arquivo, "utf8"), proibido, `${pasta}/${nome}`);
    }
  }
});

test("a proibição do num_gpu 0 está escrita na ESCADA.md", () => {
  const texto = fs.readFileSync(path.join(RAIZ, "orquestra", "ESCADA.md"), "utf8");
  assert.match(texto, /num_gpu/);
  assert.match(texto, /proibido/i);
});

test("o servidor do Ollama grava log em arquivo", () => {
  const script = fs.readFileSync(path.join(PASTA, "modo.ps1"), "utf8");
  const inicio = script.split("\n").find((l) => l.startsWith("Start-Process") && l.includes("Ollama"));
  assert.match(inicio, /2> `"\$log`"/);
  assert.match(script, /^\$log = .*mixai-servidor\.log"$/m);
  // Bug visto: com -RedirectStandardError o servidor herdava a saída do script e quem rodava o modo.ps1 ficava preso.
  assert.doesNotMatch(inicio, /-RedirectStandard/);
});
