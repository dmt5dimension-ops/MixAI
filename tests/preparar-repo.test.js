// Testa o kit que leva as regras do MixAI para o repositório de outro app (ferramentas/preparar-repo.ps1).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const RAIZ = path.resolve(__dirname, "..");
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), "utf8");
const kit = JSON.parse(ler("ferramentas/kit-arquivos.json"));
const script = ler("ferramentas/preparar-repo.ps1");

test("tudo que o kit copia existe neste repositório", () => {
  // Bug visto: o script copiava de ferramentas/modelos/, pasta que nunca existiu, e quebrava no primeiro passo.
  for (const item of kit.copiar) {
    assert.ok(fs.existsSync(path.join(RAIZ, item)), `o kit manda copiar ${item}, que não existe`);
  }
  assert.ok(fs.existsSync(path.join(RAIZ, kit.memoriaVazia.de)), "falta o modelo da memória vazia");
});

test("o kit leva as regras, os portões do CI e os comandos dos agentes", () => {
  // Lista do passo 1 do /integrar-app.
  const cobre = (alvo) =>
    kit.copiar.some((item) => item === alvo || (item.endsWith("/") && alvo.startsWith(item)));
  for (const alvo of [
    "AGENTS.md",
    "CLAUDE.md",
    "CODEX.md",
    ".claude/skills/integrar-app/SKILL.md",
    ".claude/agents/revisor.md",
    ".github/workflows/regressao.yml",
    ".github/workflows/portoes-do-pr.yml",
    ".github/scripts/trava_de_escopo.py",
    ".github/scripts/guarda_testes.py",
    ".github/scripts/revisao_cruzada.py",
    ".github/pull_request_template.md",
  ]) {
    assert.ok(cobre(alvo), `o kit não leva ${alvo}`);
  }
  assert.strictEqual(kit.memoriaVazia.para, "docs/memoria/estado.md");
});

test("o app novo começa com a memória vazia, sem o estado do MixAI", () => {
  const vazia = ler(kit.memoriaVazia.de);
  const titulos = (t) => t.split("\n").filter((l) => l.startsWith("## "));
  assert.deepStrictEqual(titulos(vazia), titulos(ler("docs/memoria/estado.md")));
  assert.doesNotMatch(vazia, /Papéis trocáveis|mixai-local|qwen/);
});

test("o script usa a lista do kit, não a pasta antiga", () => {
  assert.match(script, /kit-arquivos\.json/);
  assert.doesNotMatch(script, /'modelos'/);
});

test("o script acha onde gravar o comando de teste no AGENTS.md", () => {
  const ancora = new RegExp(kit.ancoraComandoTeste);
  const achado = ler("AGENTS.md").match(ancora);
  assert.ok(achado, "a âncora do comando de teste não acha nada no AGENTS.md");
  assert.strictEqual(achado[2], "npm test");
  assert.match(script, /ancoraComandoTeste/);
});

test("o script cria todas as labels que o AGENTS.md usa", () => {
  const usadas = new Set(ler("AGENTS.md").match(/(feito-por|revisado-por):(claude|codex)|permitir-[a-z-]+/g));
  for (const label of usadas) {
    assert.match(script, new RegExp(`'${label}'`), `o script não cria a label ${label}`);
  }
});

test("o script troca o comando de teste em todo texto copiado, não só no AGENTS.md", () => {
  // Achado da revisão: executor-leve.md e CODEX.md continuavam mandando rodar `npm test`.
  assert.match(script, /function Aplicar-ComandoTeste/);
  const chamadas = script.match(/Aplicar-ComandoTeste \$/g) || [];
  assert.ok(chamadas.length >= 2, "o comando precisa ser aplicado na cópia normal e na cópia ao lado (.orquestrador)");
  // Se um texto copiado deixar de citar `npm test` literalmente, a troca não pega: este teste avisa.
  for (const rel of ["CODEX.md", ".claude/agents/executor-leve.md"]) {
    assert.ok(ler(rel).includes("npm test"), `${rel} não cita npm test; a troca do comando não o alcança`);
  }
});

test("o CI instala as dependências antes de rodar o REGRESSION_CMD", () => {
  // Achado da revisão: com REGRESSION_CMD definido o comando rodava sem npm ci/pip install antes.
  const yml = ler(".github/workflows/regressao.yml");
  const instalar = yml.indexOf("Instalar dependencias");
  const rodar = yml.indexOf('bash -c "$REGRESSION_CMD"');
  assert.ok(instalar > 0 && rodar > 0, "faltam os passos no workflow");
  assert.ok(instalar < rodar, "as dependências precisam ser instaladas antes do REGRESSION_CMD");
  assert.match(yml.slice(instalar, rodar), /npm ci/);
  assert.match(yml.slice(instalar, rodar), /pip install/);
});

test("rodando o script de verdade num repositório temporário, o comando chega em todos os textos", () => {
  // O PowerShell vem instalado no ubuntu-latest do CI. Sem ele (ex.: máquina sem pwsh), os testes
  // estáticos acima continuam valendo e este caminho é conferido pelo CI.
  const { spawnSync, execFileSync } = require("node:child_process");
  const os = require("node:os");
  const ps = ["pwsh", "powershell"].find((c) => spawnSync(c, ["-NoProfile", "-Command", "exit 0"]).status === 0);
  if (!ps) return;
  const destino = fs.mkdtempSync(path.join(os.tmpdir(), "prep-"));
  execFileSync("git", ["init", "-q"], { cwd: destino });
  const r = spawnSync(
    ps,
    ["-NoProfile", "-File", path.join(RAIZ, "ferramentas", "preparar-repo.ps1"), "-Repo", destino, "-ComandoTeste", "pytest -q"],
    { encoding: "utf8", env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" } },
  );
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  for (const rel of ["AGENTS.md", "CODEX.md", ".claude/agents/executor-leve.md"]) {
    const texto = fs.readFileSync(path.join(destino, rel), "utf8");
    assert.ok(texto.includes("pytest -q"), `${rel} não recebeu o comando`);
    assert.ok(!texto.includes("npm test"), `${rel} ainda manda rodar npm test`);
  }
  assert.ok(fs.existsSync(path.join(destino, "docs", "memoria", "estado.md")));
});

test("um AGENTS.md que já existe fica intacto; a versão do kit vai ao lado, com o comando", () => {
  // Achado da revisão: com -ComandoTeste o script alterava o AGENTS.md do dono mesmo sem -Sobrescrever.
  assert.match(script, /\$agentsDoKit/);
  assert.doesNotMatch(script, /\$agents\s*=\s*Join-Path \$Repo/);
  const { spawnSync, execFileSync } = require("node:child_process");
  const os = require("node:os");
  const ps = ["pwsh", "powershell"].find((c) => spawnSync(c, ["-NoProfile", "-Command", "exit 0"]).status === 0);
  if (!ps) return;
  const destino = fs.mkdtempSync(path.join(os.tmpdir(), "prep-agents-"));
  execFileSync("git", ["init", "-q"], { cwd: destino });
  const original = "# AGENTS do dono\n\n## Comando da suíte de regressão\n\n```\nnpm test\n```\n";
  fs.writeFileSync(path.join(destino, "AGENTS.md"), original);
  const r = spawnSync(
    ps,
    ["-NoProfile", "-File", path.join(RAIZ, "ferramentas", "preparar-repo.ps1"), "-Repo", destino, "-ComandoTeste", "pytest -q"],
    { encoding: "utf8", env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" } },
  );
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(destino, "AGENTS.md"), "utf8"), original);
  const ao_lado = fs.readFileSync(path.join(destino, "AGENTS.orquestrador.md"), "utf8");
  assert.match(ao_lado, /```\npytest -q\n```/);
  assert.ok(!ao_lado.includes("npm test"));
});

test("rodar de novo não sobrescreve a cópia ao lado (.orquestrador) que já existe", () => {
  // Achado da revisão: Copy-Item -Force apagava o que o dono já tinha juntado em AGENTS.orquestrador.md.
  assert.match(script, /Test-Path \$alternativo/);
  const { spawnSync, execFileSync } = require("node:child_process");
  const os = require("node:os");
  const ps = (process.platform === "win32" ? ["pwsh", "powershell"] : ["pwsh"]).find(
    (c) => spawnSync(c, ["-NoProfile", "-Command", "exit 0"]).status === 0,
  );
  if (!ps) return;
  const destino = fs.mkdtempSync(path.join(os.tmpdir(), "prep-reexec-"));
  execFileSync("git", ["init", "-q"], { cwd: destino });
  fs.writeFileSync(path.join(destino, "AGENTS.md"), "# do dono\n");
  const rodar = () =>
    spawnSync(ps, ["-NoProfile", "-File", path.join(RAIZ, "ferramentas", "preparar-repo.ps1"), "-Repo", destino, "-ComandoTeste", "pytest -q"], {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
    });
  assert.strictEqual(rodar().status, 0);
  const aoLado = path.join(destino, "AGENTS.orquestrador.md");
  fs.writeFileSync(aoLado, "# juntado pelo dono\n");
  const segunda = rodar();
  assert.strictEqual(segunda.status, 0, segunda.stdout + segunda.stderr);
  assert.strictEqual(fs.readFileSync(aoLado, "utf8"), "# juntado pelo dono\n");
  assert.strictEqual(fs.readFileSync(path.join(destino, "AGENTS.md"), "utf8"), "# do dono\n");
});

function prepararComGhFalso(comandoQueFalha) {
  const { spawnSync, execFileSync } = require("node:child_process");
  const os = require("node:os");
  const ps = (process.platform === "win32" ? ["powershell", "pwsh"] : ["pwsh"]).find(
    (c) => spawnSync(c, ["-NoProfile", "-Command", "exit 0"]).status === 0,
  );
  if (!ps) return null;

  const destino = fs.mkdtempSync(path.join(os.tmpdir(), "prep-gh-"));
  const bin = path.join(destino, "bin");
  fs.mkdirSync(bin);
  execFileSync("git", ["init", "-q"], { cwd: destino });
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "gh.cmd"),
      `@echo off\r\nif "%1"=="${comandoQueFalha}" exit /b 17\r\nexit /b 0\r\n`);
  } else {
    const gh = path.join(bin, "gh");
    fs.writeFileSync(gh, `#!/bin/sh\nif [ "$1" = "${comandoQueFalha}" ]; then exit 17; fi\nexit 0\n`);
    fs.chmodSync(gh, 0o755);
  }
  const novoPath = bin + path.delimiter + (process.env.PATH || process.env.Path || "");
  return spawnSync(ps, ["-NoProfile", "-File", path.join(RAIZ, "ferramentas", "preparar-repo.ps1"),
    "-Repo", destino, "-ComandoTeste", "pytest -q"], {
    encoding: "utf8",
    env: { ...process.env, PATH: novoPath, Path: novoPath, GH_TOKEN: "", GITHUB_TOKEN: "" },
  });
}

test("falha ao criar label encerra a preparação sem anunciar sucesso", () => {
  const r = prepararComGhFalso("label");
  if (!r) return;
  assert.match(r.stdout, /Labels da revisao cruzada/);
  assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /ok: feito-por:claude|==> Pronto/);
});

test("falha ao definir REGRESSION_CMD encerra a preparação sem anunciar sucesso", () => {
  const r = prepararComGhFalso("variable");
  if (!r) return;
  assert.match(r.stdout, /Comando de regressao no CI/);
  assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /ok: variavel REGRESSION_CMD|==> Pronto/);
});
