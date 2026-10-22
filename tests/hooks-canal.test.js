// Trava obrigatória do canal Claude↔Codex no Claude Code: hooks que mostram o canal ao começar a sessão
// e impedem encerrar o turno quando o Codex deixou mensagem sem resposta.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RAIZ = path.resolve(__dirname, "..");
const SCRIPT = path.join(RAIZ, ".claude", "hooks", "canal.js");
const canal = require(SCRIPT);

const tmp = (texto) => {
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "canal-")), "coordenacao.md");
  if (texto !== null) fs.writeFileSync(arq, texto);
  return arq;
};

test(".claude/settings.json liga SessionStart e Stop ao script do canal", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, ".claude", "settings.json"), "utf8"));
  for (const [evento, modo] of [["SessionStart", "inicio"], ["Stop", "parar"]]) {
    const comandos = (cfg.hooks[evento] || []).flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(comandos.some((c) => c.includes(".claude/hooks/canal.js") && c.includes(modo)), `falta o hook ${evento} → canal.js ${modo}`);
  }
});

test("decidirParar: última mensagem do Codex sem resposta do Claude bloqueia o fim do turno", () => {
  const texto = "# Canal\n\n### 2026-10-22 — Claude → Codex (a)\nok\n\n### 2026-10-22 — Codex → Claude (b)\nfaça X\n";
  const r = canal.decidirParar(texto, { stop_hook_active: false });
  assert.strictEqual(r.decision, "block");
  assert.match(r.reason, /Codex/);
});

test("decidirParar: se o Claude respondeu por último, libera", () => {
  const texto = "### 2026-10-22 — Codex → Claude (b)\nfaça X\n\n### 2026-10-22 — Claude → Codex (c)\nfeito\n";
  assert.strictEqual(canal.decidirParar(texto, {}), null);
});

test("decidirParar: transcrições do Codex rodado pelo Claude contam como do Claude (ele mesmo respondeu)", () => {
  const texto = "### 2026-10-22 — Codex (rodado pelo Claude) → nuvem: revisão\nBLOQUEADO\n";
  assert.strictEqual(canal.decidirParar(texto, {}), null);
});

test("decidirParar: sem mensagem do Codex pendente e sem canal não prende nem quebra", () => {
  assert.strictEqual(canal.decidirParar("", {}), null);
  assert.strictEqual(canal.decidirParar("# Canal sem seções\n", {}), null);
});

test("script de linha de comando: inicio mostra o fim do canal; parar bloqueia com JSON; sem arquivo sai em silêncio", () => {
  const arq = tmp("# Canal\n\n### 2026-10-22 — Codex → Claude (b)\nfaça X\n");
  const env = { ...process.env, MIXAI_CANAL: arq };
  const ini = spawnSync(process.execPath, [SCRIPT, "inicio"], { env, encoding: "utf8", input: "{}" });
  assert.strictEqual(ini.status, 0);
  assert.match(ini.stdout, /faça X/);
  const par = spawnSync(process.execPath, [SCRIPT, "parar"], { env, encoding: "utf8", input: "{}" });
  assert.strictEqual(par.status, 0);
  assert.strictEqual(JSON.parse(par.stdout).decision, "block");
  const sem = spawnSync(process.execPath, [SCRIPT, "parar"], { env: { ...process.env, MIXAI_CANAL: tmp(null) }, encoding: "utf8", input: "{}" });
  assert.strictEqual(sem.status, 0);
  assert.strictEqual(sem.stdout.trim(), "");
});

test("regra global do Codex: o repositório guarda o texto que vai para ~/.codex/AGENTS.md", () => {
  const texto = fs.readFileSync(path.join(RAIZ, "ferramentas", "codex-agents-global.md"), "utf8");
  assert.ok(texto.includes(["D:", "MixAI-coordenacao", "coordenacao.md"].join(String.fromCharCode(92))));
  assert.match(texto, /antes e depois/i);
});

test("Codex #21: os hooks usam CLAUDE_PROJECT_DIR e funcionam a partir de uma subpasta", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, ".claude", "settings.json"), "utf8"));
  for (const evento of ["SessionStart", "Stop"]) {
    for (const g of cfg.hooks[evento]) for (const h of g.hooks) assert.ok(h.command.includes("${CLAUDE_PROJECT_DIR}"), `${evento}: o comando precisa usar \${CLAUDE_PROJECT_DIR}`);
  }
  const arq = tmp("### 2026-10-22 — Codex → Claude (b)\nfaça X\n");
  const subpasta = path.join(RAIZ, "tests");
  const cmd = cfg.hooks.Stop[0].hooks[0].command;
  // O Claude Code roda os hooks pelo bash (no Windows, o Git Bash), que expande ${CLAUDE_PROJECT_DIR}; o cmd.exe não expandiria.
  // No Windows o primeiro "bash" do PATH pode ser o do WSL (sem node); escolhe o Git Bash explicitamente.
  const bash = process.platform === "win32"
    ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")]
      .filter(Boolean).map((p) => path.join(p, "Git", "bin", "bash.exe")).find((p) => fs.existsSync(p))
    : "bash";
  if (!bash) return; // sem Git Bash instalado o Claude Code nem roda hooks no Windows; nada a provar aqui
  const r = spawnSync(bash, ["-c", cmd], { cwd: subpasta, env: { ...process.env, CLAUDE_PROJECT_DIR: RAIZ.split(path.sep).join("/"), MIXAI_CANAL: arq }, encoding: "utf8", input: "{}" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).decision, "block");
});

test("Codex #21: com stop_hook_active a trava relê o canal e só libera depois da resposta do Claude", () => {
  const semResposta = "### 2026-10-22 — Codex → Claude (b)\nfaça X\n";
  assert.strictEqual(canal.decidirParar(semResposta, { stop_hook_active: true }).decision, "block");
  const comResposta = semResposta + "\n### 2026-10-22 — Claude → Codex (c)\nfeito\n";
  assert.strictEqual(canal.decidirParar(comResposta, { stop_hook_active: true }), null);
});
