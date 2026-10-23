// Testa as proteções do modelo local: nunca cair para o processador, conferir a memória
// livre antes de carregar e gravar o log do servidor (local/rodar-local.js e local/*.ps1).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

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

// Servidor falso do Ollama. Opções: naPlaca (fração do modelo na placa), falhasCarga (quantas cargas
// falham por falta de espaço), psStatus (código HTTP do /api/ps), semModelo (/api/ps sem o mixai-local).
// Anota os pedidos feitos ao /api/generate (carregar e descarregar). Roda o rodar-local.js apontando para ele.
async function rodar(entrada, env, opcoes = {}) {
  const { naPlaca = 1, falhasCarga = 0, psStatus = 200, semModelo = false, tamanho = 1000 } = opcoes;
  const pedidos = [];
  const servidor = http.createServer((req, res) => {
    let corpo = "";
    req.on("data", (d) => (corpo += d)).on("end", () => {
      if (req.url === "/api/ps") {
        res.statusCode = psStatus;
        if (psStatus !== 200) return res.end(JSON.stringify({ error: "falha" }));
        const models = semModelo ? [] : [{ name: "mixai-local:latest", size: tamanho, size_vram: Math.round(tamanho * naPlaca) }];
        return res.end(JSON.stringify({ models }));
      }
      if (req.url === "/api/generate") {
        const pedido = JSON.parse(corpo);
        pedidos.push(pedido);
        const cargas = pedidos.filter((p) => p.keep_alive === undefined).length;
        if (pedido.keep_alive === undefined && cargas <= falhasCarga) {
          res.statusCode = 500;
          return res.end(JSON.stringify({ error: "llama-server reported out-of-memory during startup: failed to allocate Vulkan0 buffer" }));
        }
      }
      res.end("{}");
    });
  });
  await new Promise((ok) => servidor.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${servidor.address().port}`;
  try {
    return await new Promise((ok) => {
      const filho = spawn(process.execPath, [RODAR], { env: { ...process.env, MIXAI_OLLAMA_URL: url, MIXAI_ESPERA_MS: "10", ...env } });
      let stdout = "";
      let stderr = "";
      filho.stdout.on("data", (d) => (stdout += d));
      filho.stderr.on("data", (d) => (stderr += d));
      filho.on("close", (status) => ok({ status, stdout, stderr, pedidos }));
      filho.stdin.end(entrada);
    });
  } finally {
    servidor.close();
  }
}

const CARREGAR = { model: "mixai-local" };
const DESCARREGAR = { model: "mixai-local", keep_alive: 0 };

test("com pouca memória livre o modelo local nem é carregado e a tarefa sobe na escada", async () => {
  const dir = pastaTemporaria();
  const { comando, marca } = ollamaFalso(dir);
  const r = await rodar("tarefa", { MIXAI_OLLAMA: comando, MIXAI_MEMORIA_MINIMA_GB: "100000" });
  assert.notStrictEqual(r.status, 0, "a escada só passa adiante quando o local sai com erro");
  assert.match(r.stderr, /memória livre/i);
  assert.deepStrictEqual(r.pedidos, [], "nada pode ser carregado com a memória no limite");
  assert.ok(!fs.existsSync(marca), "o Ollama não pode ser chamado com a memória no limite");
});

test("modelo já carregado: a memória que ele mesmo ocupa é descontada e a chamada seguinte não é recusada", async () => {
  const dir = pastaTemporaria();
  const { comando } = ollamaFalso(dir);
  const r = await rodar("tarefa", { MIXAI_OLLAMA: comando, MIXAI_MEMORIA_MINIMA_GB: "2", MIXAI_MEMORIA_LIVRE_GB: "0.5" }, { tamanho: 4 * 1024 ** 3 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, "TAREFA");
});

test("sem modelo carregado nada é descontado: memória livre baixa continua recusando", async () => {
  const dir = pastaTemporaria();
  const { comando } = ollamaFalso(dir);
  const r = await rodar("tarefa", { MIXAI_OLLAMA: comando, MIXAI_MEMORIA_MINIMA_GB: "2", MIXAI_MEMORIA_LIVRE_GB: "0.5" }, { semModelo: true });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /memória livre/i);
  assert.deepStrictEqual(r.pedidos, []);
});

test("falha ao consultar o /api/ps não desconta nada e a memória baixa continua recusando", async () => {
  const dir = pastaTemporaria();
  const { comando } = ollamaFalso(dir);
  const r = await rodar("tarefa", { MIXAI_OLLAMA: comando, MIXAI_MEMORIA_MINIMA_GB: "2", MIXAI_MEMORIA_LIVRE_GB: "0.5" }, { psStatus: 500, tamanho: 4 * 1024 ** 3 });
  assert.notStrictEqual(r.status, 0);
  assert.deepStrictEqual(r.pedidos, []);
});
test("com memória suficiente o modelo carrega na placa, roda a tarefa e a resposta volta inteira", async () => {
  const dir = pastaTemporaria();
  const { comando, marca } = ollamaFalso(dir);
  const r = await rodar("tarefa curta", { MIXAI_OLLAMA: comando, MIXAI_MEMORIA_MINIMA_GB: "0" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, "TAREFA CURTA");
  assert.strictEqual(fs.readFileSync(marca, "utf8"), "run mixai-local");
  assert.deepStrictEqual(r.pedidos, [CARREGAR], "carrega uma vez e não descarrega");
});

test("se parte do modelo foi para o processador, descarrega ANTES de rodar a tarefa", async () => {
  // Revisão do Codex no PR #11: o num_gpu 99 pede a placa, mas sozinho não garante,
  // e conferir só depois deixava a tarefa rodar no processador.
  const dir = pastaTemporaria();
  const { comando, marca } = ollamaFalso(dir);
  const r = await rodar("tarefa", { MIXAI_OLLAMA: comando, MIXAI_MEMORIA_MINIMA_GB: "0" }, { naPlaca: 0.4 });
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(r.stdout, "");
  assert.match(r.stderr, /60% do modelo foi para o processador/);
  assert.ok(!fs.existsSync(marca), "a tarefa não pode rodar com o modelo fora da placa");
  assert.deepStrictEqual(r.pedidos, [CARREGAR, DESCARREGAR]);
});

test("se o /api/ps responder com erro, não confia e não roda a tarefa", async () => {
  // Revisão do Codex no PR #11: erro HTTP com JSON virava lista vazia e a resposta era entregue.
  const dir = pastaTemporaria();
  const { comando, marca } = ollamaFalso(dir);
  const r = await rodar("tarefa", { MIXAI_OLLAMA: comando, MIXAI_MEMORIA_MINIMA_GB: "0" }, { psStatus: 500 });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /não deu para conferir/);
  assert.ok(!fs.existsSync(marca));
  assert.deepStrictEqual(r.pedidos, [CARREGAR, DESCARREGAR]);
});

test("se o /api/ps não mostrar o mixai-local carregado, não roda a tarefa", async () => {
  const dir = pastaTemporaria();
  const { comando, marca } = ollamaFalso(dir);
  const r = await rodar("tarefa", { MIXAI_OLLAMA: comando, MIXAI_MEMORIA_MINIMA_GB: "0" }, { semModelo: true });
  assert.notStrictEqual(r.status, 0);
  assert.ok(!fs.existsSync(marca));
});

test("se o Ollama falhar ao rodar a tarefa, o rodar-local também falha", async () => {
  const dir = pastaTemporaria();
  const { comando } = ollamaFalso(dir, 1);
  const r = await rodar("tarefa", { MIXAI_OLLAMA: comando, MIXAI_MEMORIA_MINIMA_GB: "0" });
  assert.notStrictEqual(r.status, 0);
});

test("se a placa falhar por falta de espaço na primeira carga, tenta carregar mais uma vez", async () => {
  // Visto no PC: logo depois de reiniciar o Ollama, a primeira carga falhou e a segunda funcionou.
  const dir = pastaTemporaria();
  const { comando } = ollamaFalso(dir);
  const r = await rodar("tarefa", { MIXAI_OLLAMA: comando, MIXAI_MEMORIA_MINIMA_GB: "0" }, { falhasCarga: 1 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, "TAREFA");
  assert.deepStrictEqual(r.pedidos, [CARREGAR, CARREGAR]);
});

test("se a placa continuar sem espaço, desiste depois da segunda carga e não roda a tarefa", async () => {
  const dir = pastaTemporaria();
  const { comando, marca } = ollamaFalso(dir);
  const r = await rodar("tarefa", { MIXAI_OLLAMA: comando, MIXAI_MEMORIA_MINIMA_GB: "0" }, { falhasCarga: 5 });
  assert.notStrictEqual(r.status, 0);
  assert.deepStrictEqual(r.pedidos, [CARREGAR, CARREGAR]);
  assert.ok(!fs.existsSync(marca));
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
