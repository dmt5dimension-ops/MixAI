// Testa a escada: tarefa vai primeiro ao modelo local; se falhar sobe para Codex/Claude;
// a solução vira regra com exemplo; o local tenta de novo com a regra; cada caso fica registrado para treino futuro.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const escada = require(path.resolve(__dirname, "..", "orquestra", "escada.js"));

function pastaTemp() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "escada-"));
  return { regras: path.join(p, "regras.json"), casos: path.join(p, "casos.jsonl") };
}

const ENTRADA = "Converta a data 21/10/2026 para o formato ISO.";
const verificar = (saida) => ({ ok: saida.trim() === "2026-10-21" });

test("os arquivos reais de regras e config existem e estão válidos", () => {
  const dir = path.resolve(__dirname, "..", "orquestra");
  const regras = JSON.parse(fs.readFileSync(path.join(dir, "regras-locais.json"), "utf8"));
  assert.ok(Array.isArray(regras.regras));
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "escada.json"), "utf8"));
  assert.ok(cfg.superiores.length >= 2);
  assert.ok(!cfg.superiores.includes("local"));
});

test("só regras confirmadas cuja palavra aparece na tarefa entram no prompt", () => {
  const regras = [
    { id: "a", palavras: ["data"], regra: "Use ISO.", exemplo: { entrada: "x", saida: "y" }, status: "confirmada" },
    { id: "b", palavras: ["cor"], regra: "Use hex.", exemplo: { entrada: "x", saida: "y" }, status: "confirmada" },
    { id: "c", palavras: ["data"], regra: "Rascunho.", exemplo: { entrada: "x", saida: "y" }, status: "candidata" },
  ];
  const usadas = escada.escolherRegras(regras, ENTRADA);
  assert.deepStrictEqual(usadas.map((r) => r.id), ["a"]);
  const prompt = escada.montarPrompt(ENTRADA, usadas);
  assert.ok(prompt.includes("Use ISO.") && prompt.includes(ENTRADA));
  assert.ok(!prompt.includes("Use hex."));
});

test("local acerta de primeira: ninguém sobe e o caso é registrado como do local", () => {
  const f = pastaTemp();
  const chamadas = [];
  const r = escada.resolver({
    entrada: ENTRADA, cabeNoLocal: true, verificar, arquivos: f,
    agentes: { local: () => "2026-10-21", superiores: [{ nome: "codex", chamar: () => { chamadas.push("codex"); return "x"; } }] },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.resolvidoPor, "local");
  assert.deepStrictEqual(chamadas, []);
  const casos = escada.lerCasos(f.casos);
  assert.strictEqual(casos.length, 1);
  assert.strictEqual(casos[0].resolvidoPor, "local");
});

test("local erra, Codex resolve, vira regra, local acerta com a regra e a regra fica salva", () => {
  const f = pastaTemp();
  const promptsLocal = [];
  const local = (prompt) => {
    promptsLocal.push(prompt);
    return prompt.includes("Escreva sempre ano-mes-dia") ? "2026-10-21" : "21-10-2026";
  };
  const codex = (prompt) => {
    if (prompt.includes("REGRA")) {
      return JSON.stringify({ id: "data-iso", palavras: ["data"], regra: "Escreva sempre ano-mes-dia com zeros.", exemplo: { entrada: "01/02/2026", saida: "2026-02-01" } });
    }
    return "2026-10-21";
  };
  const r = escada.resolver({
    entrada: ENTRADA, cabeNoLocal: true, verificar, arquivos: f,
    agentes: { local, superiores: [{ nome: "codex", chamar: codex }] },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.resolvidoPor, "codex");
  assert.strictEqual(r.regraSalva, "data-iso");
  const salvas = JSON.parse(fs.readFileSync(f.regras, "utf8")).regras;
  assert.strictEqual(salvas[0].status, "confirmada");
  // na próxima vez o local já recebe a regra e resolve sozinho
  const r2 = escada.resolver({
    entrada: "Converta a data 03/04/2026 para o formato ISO.", cabeNoLocal: true,
    verificar: (s) => ({ ok: s.trim() === "2026-04-03" }), arquivos: f,
    agentes: { local: (p) => (p.includes("Escreva sempre ano-mes-dia") ? "2026-04-03" : "errado"), superiores: [{ nome: "codex", chamar: () => { throw new Error("não devia subir"); } }] },
  });
  assert.strictEqual(r2.resolvidoPor, "local");
  assert.deepStrictEqual(r2.regrasUsadas, ["data-iso"]);
});

test("se o local continua errando com a regra, a regra NÃO é salva, mas o caso é registrado", () => {
  const f = pastaTemp();
  const codex = (prompt) => prompt.includes("REGRA")
    ? JSON.stringify({ id: "regra-ruim", palavras: ["data"], regra: "Faça certo.", exemplo: { entrada: "a", saida: "b" } })
    : "2026-10-21";
  const r = escada.resolver({
    entrada: ENTRADA, cabeNoLocal: true, verificar, arquivos: f,
    agentes: { local: () => "errado", superiores: [{ nome: "codex", chamar: codex }] },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.regraSalva, null);
  assert.ok(!fs.existsSync(f.regras) || JSON.parse(fs.readFileSync(f.regras, "utf8")).regras.length === 0);
  assert.strictEqual(escada.lerCasos(f.casos).length, 1);
});

test("sem cota no Codex, passa para o Claude", () => {
  const f = pastaTemp();
  const r = escada.resolver({
    entrada: ENTRADA, cabeNoLocal: false, verificar, arquivos: f,
    agentes: { local: () => "errado", superiores: [
      { nome: "codex", chamar: () => { throw new Error("usage limit"); } },
      { nome: "claude", chamar: () => "2026-10-21" },
    ] },
  });
  assert.strictEqual(r.resolvidoPor, "claude");
});

test("quando o Claude diz que não cabe no local, o local nem é chamado", () => {
  const f = pastaTemp();
  let localChamado = false;
  const r = escada.resolver({
    entrada: ENTRADA, cabeNoLocal: false, verificar, arquivos: f,
    agentes: { local: () => { localChamado = true; return ""; }, superiores: [{ nome: "codex", chamar: () => "2026-10-21" }] },
  });
  assert.strictEqual(localChamado, false);
  assert.strictEqual(r.resolvidoPor, "codex");
  assert.strictEqual(r.regraSalva, null);
});

test("resposta que ninguém acerta não vira caso de treino", () => {
  const f = pastaTemp();
  const r = escada.resolver({
    entrada: ENTRADA, cabeNoLocal: true, verificar, arquivos: f,
    agentes: { local: () => "errado", superiores: [{ nome: "codex", chamar: () => "tambem errado" }] },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(escada.lerCasos(f.casos).length, 0);
});

test("o caso guarda entrada, regra, saída e quem resolveu, e exporta no formato de treino", () => {
  const f = pastaTemp();
  const codex = (p) => p.includes("REGRA")
    ? JSON.stringify({ id: "data-iso", palavras: ["data"], regra: "Escreva sempre ano-mes-dia com zeros.", exemplo: { entrada: "01/02/2026", saida: "2026-02-01" } })
    : "2026-10-21";
  escada.resolver({
    entrada: ENTRADA, cabeNoLocal: true, verificar, arquivos: f,
    agentes: { local: (p) => (p.includes("Escreva sempre ano-mes-dia") ? "2026-10-21" : "x"), superiores: [{ nome: "codex", chamar: codex }] },
  });
  const [c] = escada.lerCasos(f.casos);
  assert.strictEqual(c.entrada, ENTRADA);
  assert.strictEqual(c.saida, "2026-10-21");
  assert.strictEqual(c.resolvidoPor, "codex");
  assert.strictEqual(c.regra.id, "data-iso");
  const t = escada.paraTreino(c);
  assert.deepStrictEqual(t.messages.map((m) => m.role), ["user", "assistant"]);
  assert.strictEqual(t.messages[0].content, ENTRADA);
  assert.strictEqual(t.messages[1].content, "2026-10-21");
});

test("sem verificador a escada se recusa a decidir", () => {
  assert.throws(() => escada.resolver({ entrada: ENTRADA, cabeNoLocal: true, agentes: { local: () => "x", superiores: [] }, arquivos: pastaTemp() }), /verificador/);
});

test("regra com id repetido não sobrescreve a existente", () => {
  const f = pastaTemp();
  const codex = (p) => p.includes("REGRA")
    ? JSON.stringify({ id: "data-iso", palavras: ["data"], regra: "Nova regra ano-mes-dia.", exemplo: { entrada: "a", saida: "b" } })
    : "2026-10-21";
  fs.writeFileSync(f.regras, JSON.stringify({ regras: [{ id: "data-iso", palavras: ["nada"], regra: "Antiga.", exemplo: { entrada: "a", saida: "b" }, status: "confirmada" }] }));
  const r = escada.resolver({
    entrada: ENTRADA, cabeNoLocal: true, verificar, arquivos: f,
    agentes: { local: (p) => (p.includes("Nova regra") ? "2026-10-21" : "x"), superiores: [{ nome: "codex", chamar: codex }] },
  });
  assert.strictEqual(r.regraSalva, "data-iso-2");
  const ids = JSON.parse(fs.readFileSync(f.regras, "utf8")).regras.map((x) => x.id);
  assert.deepStrictEqual(ids, ["data-iso", "data-iso-2"]);
});

test("arquivo de regras corrompido dá erro em vez de ser apagado", () => {
  const f = pastaTemp();
  fs.writeFileSync(f.regras, "{quebrado");
  assert.throws(() => escada.resolver({ entrada: ENTRADA, cabeNoLocal: true, verificar, arquivos: f, agentes: { local: () => "x", superiores: [] } }), /JSON inválido/);
});
