// Testa a trava de escopo (.github/scripts/trava_de_escopo.py) num repositório git temporário.
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.resolve(__dirname, "..", ".github", "scripts", "trava_de_escopo.py");
const PYTHON = process.platform === "win32" ? "python" : "python3";

function repoCom(arquivosAlterados) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escopo-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "base.txt"), "x");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").toString().trim();
  for (const arquivo of arquivosAlterados) {
    fs.mkdirSync(path.join(dir, path.dirname(arquivo)), { recursive: true });
    fs.writeFileSync(path.join(dir, arquivo), "y");
  }
  git("add", ".");
  git("commit", "-qm", "mudanca");
  const head = git("rev-parse", "HEAD").toString().trim();
  return { dir, base, head };
}

function rodar(arquivosAlterados, corpo, labels = []) {
  const { dir, base, head } = repoCom(arquivosAlterados);
  const evento = path.join(dir, "..", path.basename(dir) + "-evento.json");
  fs.writeFileSync(evento, JSON.stringify({ pull_request: { body: corpo, labels: labels.map((name) => ({ name })) } }));
  const r = spawnSync(PYTHON, [SCRIPT, base, head], {
    cwd: dir,
    env: { ...process.env, GITHUB_EVENT_PATH: evento },
    encoding: "utf8",
  });
  return { codigo: r.status, saida: r.stdout + r.stderr };
}

const escopo = (...itens) => "## O que mudou\nx\n\n## Escopo\n" + itens.map((i) => `- ${i}`).join("\n") + "\n\n## Como foi testado\n- ok";

test("passa quando todos os arquivos estao no escopo", () => {
  const r = rodar(["src/tela/menu.css"], escopo("src/tela/menu.css"));
  assert.strictEqual(r.codigo, 0, r.saida);
});

test("bloqueia arquivo fora do escopo e diz qual e", () => {
  const r = rodar(["src/tela/menu.css", "src/tela/botao.js"], escopo("src/tela/menu.css"));
  assert.strictEqual(r.codigo, 1, r.saida);
  assert.match(r.saida, /src\/tela\/botao\.js/);
});

test("pasta terminada em / libera tudo dentro dela", () => {
  const r = rodar(["src/email/envio.js", "src/email/fila/retry.js"], escopo("src/email/"));
  assert.strictEqual(r.codigo, 0, r.saida);
});

test("padrao com * funciona", () => {
  const r = rodar(["src/a.css", "src/b.css"], escopo("src/*.css"));
  assert.strictEqual(r.codigo, 0, r.saida);
});

test("item com ponto no inicio (.github/) nao perde o ponto", () => {
  const r = rodar([".github/workflows/x.yml"], escopo(".github/"));
  assert.strictEqual(r.codigo, 0, r.saida);
});

test("testes e docs/memoria sempre podem mudar", () => {
  const r = rodar(["src/a.js", "tests/a.test.js", "docs/memoria/estado.md"], escopo("src/a.js"));
  assert.strictEqual(r.codigo, 0, r.saida);
});

test("lockfile acompanha o package.json listado", () => {
  const r = rodar(["package.json", "package-lock.json"], escopo("package.json"));
  assert.strictEqual(r.codigo, 0, r.saida);
});

test("sem secao Escopo o PR e bloqueado", () => {
  const r = rodar(["src/a.js"], "## O que mudou\nqualquer coisa");
  assert.strictEqual(r.codigo, 1, r.saida);
});

test("item de exemplo do modelo (<...>) nao conta como escopo", () => {
  const r = rodar(["src/a.js"], escopo("<arquivo ou pasta>"));
  assert.strictEqual(r.codigo, 1, r.saida);
});

test("label permitir-fora-do-escopo libera", () => {
  const r = rodar(["src/a.js", "src/b.js"], escopo("src/a.js"), ["permitir-fora-do-escopo"]);
  assert.strictEqual(r.codigo, 0, r.saida);
});

test("* nao entra em subpasta (src/*.css nao libera src/privado/segredo.css)", () => {
  const r = rodar(["src/a.css", "src/privado/segredo.css"], escopo("src/*.css"));
  assert.strictEqual(r.codigo, 1, r.saida);
  assert.match(r.saida, /src\/privado\/segredo\.css/);
});

test("** entra em subpastas", () => {
  const r = rodar(["src/a.css", "src/privado/segredo.css"], escopo("src/**/*.css"));
  assert.strictEqual(r.codigo, 0, r.saida);
});

test("testes *Tests.cs, *Tests.java e *Test.kt sempre podem mudar", () => {
  const r = rodar(["src/a.js", "App/CalculoTests.cs", "src/CalculoTests.java", "src/CalculoTest.kt"], escopo("src/a.js"));
  assert.strictEqual(r.codigo, 0, r.saida);
});

test("a trava e o guarda de testes reconhecem os mesmos arquivos de teste", () => {
  const scripts = path.resolve(__dirname, "..", ".github", "scripts");
  const padroes = (arquivo, nome) => {
    const texto = fs.readFileSync(path.join(scripts, arquivo), "utf8");
    const bloco = texto.slice(texto.indexOf(nome), texto.indexOf("\n)", texto.indexOf(nome)));
    return [...bloco.matchAll(/^\s*r"\|?(.*?)"$/gm)].map((m) => m[1]).filter((p) => p !== "^docs/memoria/").sort();
  };
  const guarda = padroes("guarda_testes.py", "ARQUIVO_DE_TESTE");
  const trava = padroes("trava_de_escopo.py", "SEMPRE_PERMITIDO");
  assert.ok(guarda.length >= 5, "nao achei os padroes do guarda de testes");
  assert.deepStrictEqual(trava, guarda);
});

test("lockfile em subpasta acompanha o package.json da mesma subpasta", () => {
  const r = rodar(["app/package.json", "app/package-lock.json"], escopo("app/package.json"));
  assert.strictEqual(r.codigo, 0, r.saida);
});

test("lockfile de outra pasta NAO acompanha o package.json listado", () => {
  const r = rodar(["app/package.json", "outro/package-lock.json"], escopo("app/package.json"));
  assert.strictEqual(r.codigo, 1, r.saida);
  assert.match(r.saida, /outro\/package-lock\.json/);
});

test("lockfile na raiz nao entra por causa de package.json em subpasta", () => {
  const r = rodar(["app/package.json", "package-lock.json"], escopo("app/package.json"));
  assert.strictEqual(r.codigo, 1, r.saida);
});

test("arquivo com acento no nome é comparado pelo nome real, não por \\303\\247 entre aspas", () => {
  const r = rodar(["src/ação.js"], escopo("src/ação.js"));
  assert.strictEqual(r.codigo, 0, r.saida);
  const fora = rodar(["src/ação.js"], escopo("src/outro.js"));
  assert.strictEqual(fora.codigo, 1, fora.saida);
  assert.match(fora.saida, /src\/ação\.js/);
});

test("mover arquivo de fora do escopo para dentro do escopo é barrado (confere a origem)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escopo-mv-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.mkdirSync(path.join(dir, "privado"));
  fs.writeFileSync(path.join(dir, "privado", "segredo.txt"), "conteudo bem longo para o git reconhecer a renomeacao\n".repeat(5));
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").toString().trim();
  fs.mkdirSync(path.join(dir, "src"));
  git("mv", "privado/segredo.txt", "src/segredo.txt");
  git("commit", "-qm", "mover");
  const head = git("rev-parse", "HEAD").toString().trim();
  const evento = path.join(dir, "..", path.basename(dir) + "-evento.json");
  fs.writeFileSync(evento, JSON.stringify({ pull_request: { body: escopo("src/"), labels: [] } }));
  const r = spawnSync(PYTHON, [SCRIPT, base, head], { cwd: dir, env: { ...process.env, GITHUB_EVENT_PATH: evento }, encoding: "utf8" });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /privado\/segredo\.txt/);
});

test("CODEX.md confere as chaves de API sem mostrar o valor", () => {
  const texto = fs.readFileSync(path.resolve(__dirname, "..", "CODEX.md"), "utf8");
  assert.doesNotMatch(texto, /Get-ChildItem\s+Env:/i);
  assert.doesNotMatch(texto, /\b(printenv|Get-Item\s+Env:|\$env:\w*KEY)/i);
  assert.match(texto, /Test-Path "Env:\$n"/);
});

test("com a saída padrão em cp1252 (Windows), a trava e o guarda ainda imprimem o nome com acento em UTF-8", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escopo-enc-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.mkdirSync(path.join(dir, "tests"));
  fs.writeFileSync(path.join(dir, "tests", "ação.test.js"), "x");
  fs.writeFileSync(path.join(dir, "base.txt"), "x");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").toString().trim();
  fs.rmSync(path.join(dir, "tests", "ação.test.js"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "ação.js"), "y");
  git("add", "-A");
  git("commit", "-qm", "mudanca");
  const head = git("rev-parse", "HEAD").toString().trim();
  const evento = path.join(dir, "..", path.basename(dir) + "-evento.json");
  fs.writeFileSync(evento, JSON.stringify({ pull_request: { body: escopo("outro/"), labels: [] } }));
  const env = { ...process.env, GITHUB_EVENT_PATH: evento, PYTHONIOENCODING: "cp1252", PYTHONUTF8: "0" };
  const scripts = path.resolve(__dirname, "..", ".github", "scripts");
  const trava = spawnSync(PYTHON, [path.join(scripts, "trava_de_escopo.py"), base, head], { cwd: dir, env, encoding: "buffer" });
  assert.strictEqual(trava.status, 1);
  assert.ok(trava.stdout.toString("utf8").includes("src/ação.js"), trava.stdout.toString("utf8"));
  const guarda = spawnSync(PYTHON, [path.join(scripts, "guarda_testes.py"), base, head], { cwd: dir, env, encoding: "buffer" });
  assert.strictEqual(guarda.status, 1);
  assert.ok(guarda.stdout.toString("utf8").includes("tests/ação.test.js"), guarda.stdout.toString("utf8"));
});
