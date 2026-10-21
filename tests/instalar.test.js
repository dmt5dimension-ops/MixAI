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
