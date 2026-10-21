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

// Roda o instalador de verdade com winget/npm falsos que falham. Precisa de PowerShell (o ubuntu-latest
// do CI tem) e de Linux/macOS, onde um script com shebang vira "comando" para o Get-Command.
function rodarComFalsos(falsos, args) {
  const { spawnSync } = require("node:child_process");
  const os = require("node:os");
  if (process.platform === "win32") return null;
  const ps = ["pwsh"].find((c) => spawnSync(c, ["-NoProfile", "-Command", "exit 0"]).status === 0);
  if (!ps) return null;
  const quem = spawnSync("sh", ["-c", `command -v ${ps}`], { encoding: "utf8" }).stdout.trim();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "falsos-"));
  for (const [nome, codigo] of Object.entries(falsos)) {
    const arq = path.join(bin, nome);
    fs.writeFileSync(arq, `#!/bin/sh\nexit ${codigo}\n`);
    fs.chmodSync(arq, 0o755);
  }
  const limpo = { PATH: bin, HOME: os.tmpdir() };
  return spawnSync(quem, ["-NoProfile", "-File", path.join(pasta, "instalar.ps1"), ...args], { encoding: "utf8", env: limpo });
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
