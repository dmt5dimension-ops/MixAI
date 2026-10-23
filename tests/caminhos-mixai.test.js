// O kit leva AGENTS.md/CODEX.md para o repo de outro app. Os scripts (orquestra/, local/) ficam só na pasta do MixAI,
// então os textos copiados passam a apontar para lá (ferramentas/caminhos-mixai.js).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RAIZ = path.resolve(__dirname, "..");
const { reescrever } = require(path.join(RAIZ, "ferramentas", "caminhos-mixai.js"));
const MIXAI = "D:\\MixAI";

test("comando node e -File ganham o caminho completo entre aspas", () => {
  const t = reescrever("Rode `node orquestra/chamar.js quem` e `powershell -ExecutionPolicy Bypass -File orquestra\\trocar.ps1 claude`.", MIXAI);
  assert.match(t, /`node "D:\/MixAI\/orquestra\/chamar\.js" quem`/);
  assert.match(t, /-File "D:\/MixAI\/orquestra\/trocar\.ps1" claude/);
  assert.doesNotMatch(t, /node orquestra/);
});

test("menções soltas a orquestra/ e local/ apontam para a pasta do MixAI, sem duplicar", () => {
  const t = reescrever("Veja `orquestra/papeis.json` e `local/modos.json`.", "D:/MixAI/");
  assert.strictEqual(t, "Veja `D:/MixAI/orquestra/papeis.json` e `D:/MixAI/local/modos.json`.");
  assert.strictEqual(reescrever(t, "D:/MixAI"), t, "rodar de novo não muda nada");
});

test("não mexe em palavras parecidas nem em caminhos de outra pasta", () => {
  const original = "A palavra local/ sozinha em 'o local/a' e docs/orquestra/x ou ferramentas/local/y ficam como estão? Não: só o início de caminho.";
  const t = reescrever("Use docs/orquestra/x e src/local/y.", MIXAI);
  assert.strictEqual(t, "Use docs/orquestra/x e src/local/y.");
  assert.ok(original.length > 0);
});

test("pasta com espaço fica entre aspas nos comandos e o texto continua legível", () => {
  const t = reescrever("`node orquestra/chamar.js quem`", "C:\\Meus Apps\\MixAI");
  assert.match(t, /node "C:\/Meus Apps\/MixAI\/orquestra\/chamar\.js" quem/);
});

test("o AGENTS.md e o CODEX.md reais ficam sem referência relativa a orquestra/ ou local/", () => {
  for (const nome of ["AGENTS.md", "CODEX.md"]) {
    const t = reescrever(fs.readFileSync(path.join(RAIZ, nome), "utf8"), MIXAI);
    const solto = t.match(/(?<![\w/\\.:"-])(?:orquestra|local)[/\\][\w.-]+/g);
    assert.strictEqual(solto, null, `${nome} ainda tem caminho relativo: ${solto}`);
  }
});

test("linha de comando regrava o arquivo e o preparar-repo.ps1 chama esse script", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caminhos-"));
  const arq = path.join(dir, "AGENTS.md");
  fs.writeFileSync(arq, "Use `node orquestra/chamar.js quem`.\n");
  const r = spawnSync(process.execPath, [path.join(RAIZ, "ferramentas", "caminhos-mixai.js"), arq, MIXAI], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(arq, "utf8"), /node "D:\/MixAI\/orquestra\/chamar\.js" quem/);
  const ps1 = fs.readFileSync(path.join(RAIZ, "ferramentas", "preparar-repo.ps1"), "utf8");
  assert.match(ps1, /caminhos-mixai\.js/);
});
