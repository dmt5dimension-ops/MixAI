// Testa a troca de papéis entre Claude, Codex e o modelo local (orquestra/).
// Ideia: cada papel tem uma ordem de preferência; quem está sem cota é pulado até a pausa acabar.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const PASTA = path.resolve(__dirname, "..", "orquestra");
const papeis = JSON.parse(fs.readFileSync(path.join(PASTA, "papeis.json"), "utf8"));
const { detectarLimite, limiteNaSaida, escolher, marcarSemCota } = require(path.join(PASTA, "chamar.js"));

const AGORA = new Date("2026-10-21T12:00:00Z");

test("papeis.json tem os três papéis e o normal é Claude planeja, Codex executa", () => {
  for (const p of ["planejador", "executor", "revisor"]) {
    assert.ok(Array.isArray(papeis.ordem[p]) && papeis.ordem[p].length >= 2, `papel ${p} sem reserva`);
  }
  assert.strictEqual(papeis.ordem.planejador[0], "claude");
  assert.strictEqual(papeis.ordem.executor[0], "codex");
  assert.ok(papeis.pausaHoras > 0);
});

test("o modelo local nunca planeja nem revisa", () => {
  // Teste real de 2026-10-21: o 7B errou ao classificar tarefas. Não decide nada.
  assert.ok(!papeis.ordem.planejador.includes("local"));
  assert.ok(!papeis.ordem.revisor.includes("local"));
});

test("reconhece as mensagens de limite do Claude e do Codex", () => {
  const limites = [
    "API Error: Rate limit reached",
    "You've hit your session limit · resets 6pm",
    "Claude usage limit reached. Your limit will reset at 5pm",
    "You've hit your usage limit. Upgrade to Pro or try again in 2 hours.",
    "ERROR: You've hit your weekly limit",
    '{"type":"result","subtype":"success","is_error":true,"result":"API Error: Rate limit reached"}',
  ];
  for (const t of limites) assert.ok(detectarLimite(t), `não reconheceu: ${t}`);
});

test("não confunde texto normal com limite", () => {
  const normais = [
    "Pronto: teste novo passou e npm test está verde.",
    "Adicionei um limite de 10 itens na lista.",
    "O rate da conversão ficou em 2%.",
    "",
  ];
  for (const t of normais) assert.ok(!detectarLimite(t), `falso alarme: ${t}`);
});

test("não marca sem cota só porque a tarefa fala de limite", () => {
  // O Codex repete o texto da tarefa na saída; uma tarefa sobre "usage limit" não pode pausar ninguém.
  const tarefa = "Detecte a frase 'usage limit' e 'rate limit reached' nas mensagens.";
  const saidaCodex = `user\n${tarefa}\ncodex\nPronto, npm test verde.\n`;
  assert.ok(!limiteNaSaida("codex", saidaCodex, tarefa));
  const okClaude = JSON.stringify({ type: "result", is_error: false, result: "Feito. Tratei o caso 'usage limit'." });
  assert.ok(!limiteNaSaida("claude", okClaude, tarefa));
});

test("marca sem cota quando o limite vem do próprio agente", () => {
  const tarefa = "Conserte o botão.";
  assert.ok(limiteNaSaida("codex", `user\n${tarefa}\nERROR: You've hit your usage limit. Try again in 3 hours.\n`, tarefa));
  const erroClaude = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "API Error: Rate limit reached" });
  assert.ok(limiteNaSaida("claude", erroClaude, tarefa));
});

test("sem ninguém pausado, escolhe o primeiro da ordem", () => {
  assert.strictEqual(escolher("planejador", papeis, {}, AGORA), "claude");
  assert.strictEqual(escolher("executor", papeis, {}, AGORA), "codex");
});

test("Claude sem cota: Codex planeja e Claude sai da execução", () => {
  const estado = marcarSemCota({}, "claude", papeis.pausaHoras, AGORA);
  assert.strictEqual(escolher("planejador", papeis, estado, AGORA), "codex");
  assert.notStrictEqual(escolher("executor", papeis, estado, AGORA), "claude");
});

test("Codex sem cota: Claude ou o modelo local executam", () => {
  const estado = marcarSemCota({}, "codex", papeis.pausaHoras, AGORA);
  assert.strictEqual(escolher("planejador", papeis, estado, AGORA), "claude");
  assert.ok(["claude", "local"].includes(escolher("executor", papeis, estado, AGORA)));
});

test("revisor nunca é quem implementou", () => {
  assert.strictEqual(escolher("revisor", papeis, {}, AGORA, "codex"), "claude");
  assert.strictEqual(escolher("revisor", papeis, {}, AGORA, "claude"), "codex");
});

test("revisão espera (null) se o único com cota foi quem implementou", () => {
  const estado = marcarSemCota({}, "codex", papeis.pausaHoras, AGORA);
  assert.strictEqual(escolher("revisor", papeis, estado, AGORA, "claude"), null);
});

test("a pausa acaba sozinha depois das horas configuradas", () => {
  const estado = marcarSemCota({}, "claude", papeis.pausaHoras, AGORA);
  const depois = new Date(AGORA.getTime() + (papeis.pausaHoras * 3600 + 60) * 1000);
  assert.strictEqual(escolher("planejador", papeis, estado, depois), "claude");
});

test("todos sem cota: devolve null em vez de inventar alguém", () => {
  let estado = {};
  for (const a of ["claude", "codex", "local"]) estado = marcarSemCota(estado, a, 5, AGORA);
  assert.strictEqual(escolher("executor", papeis, estado, AGORA), null);
});

test("o arquivo de pausas fica fora do git", () => {
  const ignore = fs.readFileSync(path.resolve(__dirname, "..", ".gitignore"), "utf8");
  assert.match(ignore, /orquestra\/sem-cota\.json/);
});

test("comando manual de troca existe e usa o mesmo arquivo de pausas", () => {
  const script = fs.readFileSync(path.join(PASTA, "trocar.ps1"), "utf8");
  assert.match(script, /chamar\.js/);
  assert.match(script, /ValidateSet\('claude', 'codex', 'local', 'normal'/);
});
