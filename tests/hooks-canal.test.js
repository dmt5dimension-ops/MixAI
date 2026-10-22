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

test("decidirParar: nunca prende em laço (stop_hook_active) e não quebra sem canal", () => {
  const texto = "### 2026-10-22 — Codex → Claude (b)\nfaça X\n";
  assert.strictEqual(canal.decidirParar(texto, { stop_hook_active: true }), null);
  assert.strictEqual(canal.decidirParar("", {}), null);
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
