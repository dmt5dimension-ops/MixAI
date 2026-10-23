// Confere o instalador do Windows (ferramentas/instalar.ps1) sem precisar do PowerShell:
// o script tem que ser ASCII puro (o PowerShell 5.1 le arquivo sem BOM como ANSI), avisar
// de chaves de API, nunca criar uma, e nao apontar para scripts que nao existem.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const pasta = path.resolve(__dirname, "..", "ferramentas");
const instalar = fs.readFileSync(path.join(pasta, "instalar.ps1"), "utf8");

test("instalar.ps1 e ASCII puro", () => {
  assert.doesNotMatch(instalar, /[^\x00-\x7F]/);
});

test("instalar.ps1 avisa das 4 variaveis de chave de API", () => {
  for (const nome of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"]) {
    assert.ok(instalar.includes(nome), `nao confere ${nome}`);
  }
});

test("instalar.ps1 nunca define uma chave de API", () => {
  assert.doesNotMatch(instalar, /SetEnvironmentVariable\('(ANTHROPIC|OPENAI|CODEX)[A-Z_]*',\s*'/);
  assert.doesNotMatch(instalar, /\$env:(ANTHROPIC|OPENAI|CODEX)[A-Z_]*\s*=/i);
  assert.doesNotMatch(instalar, /sk-[A-Za-z0-9]{10,}/);
});

test("instalar.ps1 orienta login por assinatura", () => {
  assert.match(instalar, /Sign in with ChatGPT/);
  assert.match(instalar, /NAO com chave de API/);
});

test("todo script .ps1 citado nas instrucoes existe na pasta", () => {
  const textos = [instalar, fs.readFileSync(path.join(pasta, "README.md"), "utf8")];
  for (const texto of textos) {
    for (const [, nome] of texto.matchAll(/(?<![/\w-])([A-Za-z0-9_-]+\.ps1)/g)) {
      assert.ok(fs.existsSync(path.join(pasta, nome)), `${nome} e citado mas nao existe`);
    }
  }
});

test("primeiro-pedido.md proibe merge e apagar teste", () => {
  const texto = fs.readFileSync(path.join(pasta, "primeiro-pedido.md"), "utf8");
  assert.match(texto, /Ninguém faz merge/);
  assert.match(texto, /Nunca apague nem pule teste/);
});

// Roda o instalador de verdade com winget/npm falsos que falham, em Linux, macOS e Windows
// (no Windows os falsos sao .cmd). Precisa de PowerShell: o ubuntu-latest do CI e o Windows tem.
// Sem PowerShell na maquina (ex.: sessao na nuvem sem pwsh) devolve null e valem so os testes estaticos.
function achar(comando) {
  const { spawnSync } = require("node:child_process");
  const r = spawnSync(process.platform === "win32" ? "where" : "sh", process.platform === "win32" ? [comando] : ["-c", `command -v ${comando}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function rodarComFalsos(falsos, args) {
  const { spawnSync } = require("node:child_process");
  const os = require("node:os");
  const ps = (process.platform === "win32" ? ["pwsh", "powershell"] : ["pwsh"]).map(achar).find(Boolean);
  if (!ps) return null;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "falsos-"));
  for (const [nome, codigo] of Object.entries(falsos)) {
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(bin, `${nome}.cmd`), `@echo off\r\nexit /b ${codigo}\r\n`);
    } else {
      const arq = path.join(bin, nome);
      fs.writeFileSync(arq, `#!/bin/sh\nexit ${codigo}\n`);
      fs.chmodSync(arq, 0o755);
    }
  }
  const env = { ...process.env, PATH: bin, Path: bin };
  return comTentativas(() => spawnSync(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(pasta, "instalar.ps1"), ...args], { encoding: "utf8", env, timeout: 120000, windowsHide: true }));
}

// Com a memoria do PC cheia o sistema as vezes nao consegue nem iniciar o PowerShell (spawn com erro, morto por sinal,
// estouro de tempo ou saida vazia). Isso e falha da maquina, nao do instalador: repete a execucao em vez de julgar o instalador
// com uma saida que ele nem chegou a produzir. Se o instalador rodou e deu resposta errada, nao repete: o teste falha de verdade.
function naoIniciou(r) {
  return Boolean(r.error) || r.status === null || (r.status !== 0 && !r.stdout && !r.stderr);
}
function comTentativas(executar, maximo = 3) {
  let r;
  for (let i = 0; i < maximo; i++) {
    r = executar();
    if (!naoIniciou(r)) return r;
  }
  return r;
}

test("se o winget falha, o instalador para e nao anuncia sucesso", () => {
  const r = rodarComFalsos({ winget: 1 }, ["-PularOrchestrator", "-PularPlugins"]);
  if (!r) return;
  assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /winget nao conseguiu instalar/);
  assert.doesNotMatch(r.stdout, /ok: git instalado|Falta voce fazer/);
});

test("se o npm falha ao instalar o Codex, o instalador para e nao anuncia sucesso", () => {
  const r = rodarComFalsos({ winget: 0, git: 0, node: 0, gh: 0, claude: 0, npm: 1 }, ["-PularOrchestrator", "-PularPlugins"]);
  if (!r) return;
  assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /npm nao conseguiu instalar o Codex/);
  assert.doesNotMatch(r.stdout, /ok: codex instalado|Falta voce fazer/);
});

test("o instalador confere o codigo de saida do winget e do npm", () => {
  assert.match(instalar, /winget install[^\n]*\n\s*if \(\$LASTEXITCODE -ne 0\)/);
  assert.match(instalar, /npm install -g @openai\/codex\s*\n\s*if \(\$LASTEXITCODE -ne 0\)/);
});

test("falha de iniciar o PowerShell (memoria cheia) e repetida, mas resposta errada do instalador nao", () => {
  let chamadas = 0;
  const r = comTentativas(() => (++chamadas < 3 ? { status: null, error: new Error("spawn ENOMEM"), stdout: "", stderr: "" } : { status: 1, stdout: "x", stderr: "" }));
  assert.strictEqual(chamadas, 3);
  assert.strictEqual(r.status, 1);

  chamadas = 0;
  comTentativas(() => (++chamadas, { status: 1, stdout: "erro do instalador", stderr: "" }));
  assert.strictEqual(chamadas, 1, "saida real do instalador nao pode ser repetida");

  chamadas = 0;
  const sempre = comTentativas(() => (++chamadas, { status: null, signal: "SIGKILL", stdout: "", stderr: "" }));
  assert.strictEqual(chamadas, 3);
  assert.strictEqual(sempre.status, null);
});
