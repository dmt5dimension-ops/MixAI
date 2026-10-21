// Testa o guarda de testes (.github/scripts/guarda_testes.py) num repositório git temporário.
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.resolve(__dirname, "..", ".github", "scripts", "guarda_testes.py");
const PYTHON = process.platform === "win32" ? "python" : "python3";

function rodar(arquivosBase, mudar, labels = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guarda-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  for (const [nome, conteudo] of Object.entries(arquivosBase)) {
    fs.mkdirSync(path.join(dir, path.dirname(nome)), { recursive: true });
    fs.writeFileSync(path.join(dir, nome), conteudo);
  }
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").toString().trim();
  mudar(dir, git);
  git("add", "-A");
  git("commit", "-qm", "mudanca");
  const head = git("rev-parse", "HEAD").toString().trim();
  const evento = path.join(dir, "..", path.basename(dir) + "-evento.json");
  fs.writeFileSync(evento, JSON.stringify({ pull_request: { labels: labels.map((name) => ({ name })) } }));
  const r = spawnSync(PYTHON, [SCRIPT, base, head], {
    cwd: dir,
    env: { ...process.env, GITHUB_EVENT_PATH: evento },
    encoding: "utf8",
  });
  return { codigo: r.status, saida: r.stdout + r.stderr };
}

test("bloqueia teste apagado", () => {
  const r = rodar({ "tests/a.test.js": "x" }, (d) => fs.rmSync(path.join(d, "tests/a.test.js")));
  assert.strictEqual(r.codigo, 1, r.saida);
});

test("bloqueia teste apagado com acento no nome (git não pode esconder o nome entre aspas)", () => {
  const nome = "tests/ação.test.js";
  const r = rodar({ [nome]: "x" }, (d) => fs.rmSync(path.join(d, nome)));
  assert.strictEqual(r.codigo, 1, r.saida);
});

test("bloqueia skip adicionado e a label libera", () => {
  const base = { "tests/a.test.js": "test('a', () => {});\n" };
  const mudar = (d) => fs.writeFileSync(path.join(d, "tests/a.test.js"), "test.skip('a', () => {});\n");
  assert.strictEqual(rodar(base, mudar).codigo, 1);
  assert.strictEqual(rodar(base, mudar, ["permitir-remocao-de-teste"]).codigo, 0);
});

test("passa quando só se adiciona teste", () => {
  const r = rodar({ "tests/a.test.js": "x" }, (d) => fs.writeFileSync(path.join(d, "tests/b.test.js"), "y"));
  assert.strictEqual(r.codigo, 0, r.saida);
});
