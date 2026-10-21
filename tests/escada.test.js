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
  return { regras: path.join(p, "regras.json"), casos: path.join(p, "casos.jsonl"), falhas: path.join(p, "falhas.jsonl"), pendentes: path.join(p, "pendentes.jsonl") };
}

const ENTRADA = "Converta a data 21/10/2026 para o formato ISO.";
const verificar = (saida) => ({ ok: saida.trim() === "2026-10-21" });

test("os arquivos reais de regras e config existem e estão válidos", async () => {
  const dir = path.resolve(__dirname, "..", "orquestra");
  const regras = JSON.parse(fs.readFileSync(path.join(dir, "regras-locais.json"), "utf8"));
  assert.ok(Array.isArray(regras.regras));
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "escada.json"), "utf8"));
  assert.ok(cfg.superiores.length >= 2);
  assert.ok(!cfg.superiores.includes("local"));
});

test("só regras confirmadas cuja palavra aparece na tarefa entram no prompt", async () => {
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

test("local acerta de primeira: ninguém sobe e o caso é registrado como do local", async () => {
  const f = pastaTemp();
  const chamadas = [];
  const r = await escada.resolver({
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

test("local erra, Codex resolve, vira regra, local acerta com a regra e a regra fica salva", async () => {
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
  const r = await escada.resolver({
    entrada: ENTRADA, cabeNoLocal: true, verificar, arquivos: f,
    agentes: { local, superiores: [{ nome: "codex", chamar: codex }] },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.resolvidoPor, "codex");
  assert.strictEqual(r.regraSalva, "data-iso");
  const salvas = JSON.parse(fs.readFileSync(f.regras, "utf8")).regras;
  assert.strictEqual(salvas[0].status, "confirmada");
  // na próxima vez o local já recebe a regra e resolve sozinho
  const r2 = await escada.resolver({
    entrada: "Converta a data 03/04/2026 para o formato ISO.", cabeNoLocal: true,
    verificar: (s) => ({ ok: s.trim() === "2026-04-03" }), arquivos: f,
    agentes: { local: (p) => (p.includes("Escreva sempre ano-mes-dia") ? "2026-04-03" : "errado"), superiores: [{ nome: "codex", chamar: () => { throw new Error("não devia subir"); } }] },
  });
  assert.strictEqual(r2.resolvidoPor, "local");
  assert.deepStrictEqual(r2.regrasUsadas, ["data-iso"]);
});

test("se o local continua errando com a regra, a regra NÃO é salva, mas o caso é registrado", async () => {
  const f = pastaTemp();
  const codex = (prompt) => prompt.includes("REGRA")
    ? JSON.stringify({ id: "regra-ruim", palavras: ["data"], regra: "Faça certo.", exemplo: { entrada: "a", saida: "b" } })
    : "2026-10-21";
  const r = await escada.resolver({
    entrada: ENTRADA, cabeNoLocal: true, verificar, arquivos: f,
    agentes: { local: () => "errado", superiores: [{ nome: "codex", chamar: codex }] },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.regraSalva, null);
  assert.ok(!fs.existsSync(f.regras) || JSON.parse(fs.readFileSync(f.regras, "utf8")).regras.length === 0);
  assert.strictEqual(escada.lerCasos(f.casos).length, 1);
});

test("sem cota no Codex, passa para o Claude", async () => {
  const f = pastaTemp();
  const r = await escada.resolver({
    entrada: ENTRADA, cabeNoLocal: false, verificar, arquivos: f,
    agentes: { local: () => "errado", superiores: [
      { nome: "codex", chamar: () => { throw new Error("usage limit"); } },
      { nome: "claude", chamar: () => "2026-10-21" },
    ] },
  });
  assert.strictEqual(r.resolvidoPor, "claude");
});

test("quando o Claude diz que não cabe no local, o local nem é chamado", async () => {
  const f = pastaTemp();
  let localChamado = false;
  const r = await escada.resolver({
    entrada: ENTRADA, cabeNoLocal: false, verificar, arquivos: f,
    agentes: { local: () => { localChamado = true; return ""; }, superiores: [{ nome: "codex", chamar: () => "2026-10-21" }] },
  });
  assert.strictEqual(localChamado, false);
  assert.strictEqual(r.resolvidoPor, "codex");
  assert.strictEqual(r.regraSalva, null);
});

test("resposta que ninguém acerta não vira caso de treino", async () => {
  const f = pastaTemp();
  const r = await escada.resolver({
    entrada: ENTRADA, cabeNoLocal: true, verificar, arquivos: f,
    agentes: { local: () => "errado", superiores: [{ nome: "codex", chamar: () => "tambem errado" }] },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(escada.lerCasos(f.casos).length, 0);
});

test("o caso guarda entrada, regra, saída e quem resolveu, e exporta no formato de treino", async () => {
  const f = pastaTemp();
  const codex = (p) => p.includes("REGRA")
    ? JSON.stringify({ id: "data-iso", palavras: ["data"], regra: "Escreva sempre ano-mes-dia com zeros.", exemplo: { entrada: "01/02/2026", saida: "2026-02-01" } })
    : "2026-10-21";
  await escada.resolver({
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

test("sem verificador a escada se recusa a decidir", async () => {
  await assert.rejects(() => escada.resolver({ entrada: ENTRADA, cabeNoLocal: true, agentes: { local: () => "x", superiores: [] }, arquivos: pastaTemp() }), /verificador/);
});

test("regra com id repetido não sobrescreve a existente", async () => {
  const f = pastaTemp();
  const codex = (p) => p.includes("REGRA")
    ? JSON.stringify({ id: "data-iso", palavras: ["data"], regra: "Nova regra ano-mes-dia.", exemplo: { entrada: "a", saida: "b" } })
    : "2026-10-21";
  fs.writeFileSync(f.regras, JSON.stringify({ regras: [{ id: "data-iso", palavras: ["nada"], regra: "Antiga.", exemplo: { entrada: "a", saida: "b" }, status: "confirmada" }] }));
  const r = await escada.resolver({
    entrada: ENTRADA, cabeNoLocal: true, verificar, arquivos: f,
    agentes: { local: (p) => (p.includes("Nova regra") ? "2026-10-21" : "x"), superiores: [{ nome: "codex", chamar: codex }] },
  });
  assert.strictEqual(r.regraSalva, "data-iso-2");
  const ids = JSON.parse(fs.readFileSync(f.regras, "utf8")).regras.map((x) => x.id);
  assert.deepStrictEqual(ids, ["data-iso", "data-iso-2"]);
});

test("arquivo de regras corrompido dá erro em vez de ser apagado", async () => {
  const f = pastaTemp();
  fs.writeFileSync(f.regras, "{quebrado");
  await assert.rejects(() => escada.resolver({ entrada: ENTRADA, cabeNoLocal: true, verificar, arquivos: f, agentes: { local: () => "x", superiores: [] } }), /JSON inválido/);
});

// ---- lote: o Qwen recebe microtarefas bem delimitadas, em paralelo, nunca o controle da produção ----
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const micro = (id, extra = {}) => ({ id, instrucao: `Devolva a palavra ${id}.`, contexto: `contexto de ${id}`, escopo: [`src/${id}.js`], verificar: `confere ${id}`, ...extra });
const verificadorDe = (m) => (saida) => ({ ok: saida.trim() === m.id });

test("lote recusa plano mal delimitado", async () => {
  const base = { verificadorDe, agentes: { local: () => "a", superiores: [] }, arquivos: pastaTemp() };
  const ruins = [
    [micro("a", { verificar: "" })],
    [micro("a", { instrucao: "" })],
    [micro("a", { escopo: [] })],
    [micro("a", { contexto: "x".repeat(2000) })],
    [micro("a"), micro("a")],
  ];
  for (const microtarefas of ruins) await assert.rejects(() => escada.lote({ ...base, microtarefas, paralelismo: 1 }), /microtarefa|plano/i);
});

test("cada agente local recebe só a sua microtarefa", async () => {
  const prompts = [];
  const r = await escada.lote({
    microtarefas: [micro("a"), micro("b")], verificadorDe, paralelismo: 2, arquivos: pastaTemp(),
    agentes: { local: (p) => { prompts.push(p); return p.includes("a.js") ? "a" : "b"; }, superiores: [] },
  });
  assert.deepStrictEqual(r.map((x) => [x.id, x.ok, x.resolvidoPor]), [["a", true, "local"], ["b", true, "local"]]);
  const pa = prompts.find((p) => p.includes("contexto de a"));
  assert.ok(pa && !pa.includes("contexto de b") && pa.includes("src/a.js"));
});

test("respeita o limite de agentes em paralelo", async () => {
  for (const limite of [1, 2]) {
    let agora = 0; let pico = 0;
    await escada.lote({
      microtarefas: ["a", "b", "c", "d"].map((i) => micro(i)), verificadorDe, paralelismo: limite, arquivos: pastaTemp(),
      agentes: { local: async (p) => { agora += 1; pico = Math.max(pico, agora); await esperar(15); agora -= 1; return ["a", "b", "c", "d"].find((i) => p.includes(`contexto de ${i}`)); }, superiores: [] },
    });
    assert.strictEqual(pico, limite);
  }
});

test("microtarefas que mexem no mesmo arquivo nunca rodam juntas", async () => {
  let agora = 0; let pico = 0;
  await escada.lote({
    microtarefas: [micro("a", { escopo: ["src/x.js"] }), micro("b", { escopo: ["src/x.js"] }), micro("c")], verificadorDe, paralelismo: 3, arquivos: pastaTemp(),
    agentes: { local: async (p) => { agora += 1; pico = Math.max(pico, agora); await esperar(15); agora -= 1; return ["a", "b", "c"].find((i) => p.includes(`contexto de ${i}`)); }, superiores: [] },
  });
  assert.strictEqual(pico, 2); // c anda junto com a ou b, mas a e b não andam juntas
});

test("uma microtarefa que falha não derruba as outras", async () => {
  const r = await escada.lote({
    microtarefas: [micro("a"), micro("b")], verificadorDe, paralelismo: 2, arquivos: pastaTemp(),
    agentes: { local: (p) => (p.includes("contexto de a") ? "errado" : "b"), superiores: [{ nome: "codex", chamar: () => "tambem errado" }] },
  });
  assert.deepStrictEqual(r.map((x) => [x.id, x.ok]), [["a", false], ["b", true]]);
});

test("lote: caminhos diferentes do mesmo arquivo contam como o mesmo escopo", async () => {
  let agora = 0; let pico = 0;
  await escada.lote({
    microtarefas: [micro("a", { escopo: ["src/x.js"] }), micro("b", { escopo: ["./src/X.js"] })], verificadorDe, paralelismo: 2, arquivos: pastaTemp(),
    agentes: { local: async (p) => { agora += 1; pico = Math.max(pico, agora); await esperar(15); agora -= 1; return p.includes("contexto de a") ? "a" : "b"; }, superiores: [] },
  });
  assert.strictEqual(pico, 1);
});

test("lote recusa paralelismo inválido em vez de travar", async () => {
  for (const p of [NaN, 0, -1, 1.5]) {
    await assert.rejects(() => escada.lote({ microtarefas: [micro("a")], verificadorDe, paralelismo: p, agentes: { local: () => "a", superiores: [] }, arquivos: pastaTemp() }), /paralelismo/);
  }
});

// ---- loop de tentativas: local tenta, o modelo grande investiga e reinstrui, até acertar ou estourar o limite ----
const verifMotivo = (esperado) => (saida) => (saida.trim() === esperado ? { ok: true } : { ok: false, motivo: `esperava ${esperado}, veio ${saida.trim()}` });

test("loop: o grande recebe o erro, reinstrui, e o local acerta na segunda rodada", async () => {
  const f = pastaTemp();
  const reinstrucoes = [];
  const r = await escada.resolverComLoop({
    entrada: "Devolva a palavra alfa.", verificar: verifMotivo("alfa"), arquivos: f, maxTentativas: 3,
    agentes: {
      local: (p) => (p.includes("DICA-DO-GRANDE") ? "alfa" : "beta"),
      superiores: [{ nome: "codex", chamar: (p) => { reinstrucoes.push(p); return "DICA-DO-GRANDE: devolva exatamente alfa."; } }],
    },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.resolvidoPor, "local");
  assert.strictEqual(r.tentativas, 2);
  assert.ok(reinstrucoes[0].includes("esperava alfa, veio beta"), "o erro do verificador vai para o grande");
});

test("loop: se um grande não responde (sem cota), passa para o outro", async () => {
  const r = await escada.resolverComLoop({
    entrada: "Devolva alfa.", verificar: verifMotivo("alfa"), arquivos: pastaTemp(), maxTentativas: 2,
    agentes: {
      local: (p) => (p.includes("DICA") ? "alfa" : "x"),
      superiores: [{ nome: "codex", chamar: () => { throw new Error("usage limit"); } }, { nome: "claude", chamar: () => "DICA: alfa" }],
    },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.resolvidoPor, "local");
});

test("loop: estourou o limite, o grande resolve direto e a falha vira caso de regressão", async () => {
  const f = pastaTemp();
  const r = await escada.resolverComLoop({
    entrada: "Devolva alfa.", verificar: verifMotivo("alfa"), arquivos: f, maxTentativas: 2, verificarComando: "node confere-alfa",
    agentes: { local: () => "x", superiores: [{ nome: "codex", chamar: (p) => (p.includes("REINSTRUIR") ? "tente de novo" : "alfa") }] },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.resolvidoPor, "codex");
  const falhas = escada.lerCasos(f.falhas);
  assert.strictEqual(falhas.length, 1);
  assert.strictEqual(falhas[0].saidaCerta, "alfa");
  assert.strictEqual(falhas[0].verificar, "node confere-alfa");
  assert.ok(falhas[0].saidasErradas.length >= 1);
});

test("loop: ninguém acerta -> vai para pendentes, não para os casos de regressão", async () => {
  const f = pastaTemp();
  const r = await escada.resolverComLoop({
    entrada: "Devolva alfa.", verificar: verifMotivo("alfa"), arquivos: f, maxTentativas: 2,
    agentes: { local: () => "x", superiores: [{ nome: "codex", chamar: () => "y" }] },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(escada.lerCasos(f.falhas).length, 0);
  assert.strictEqual(escada.lerCasos(f.pendentes).length, 1);
});

test("loop: checagem antagônica reprova resposta que passou no verificador", async () => {
  const r = await escada.resolverComLoop({
    entrada: "Devolva alfa.", verificar: verifMotivo("alfa"), arquivos: pastaTemp(), maxTentativas: 1, antagonico: true,
    agentes: {
      local: () => "alfa",
      superiores: [
        { nome: "codex", chamar: (p) => (p.includes("ANTAGONISTA") ? "PROBLEMA: faltou tratar maiúscula" : "alfa") },
        { nome: "claude", chamar: (p) => (p.includes("ANTAGONISTA") ? "OK" : "alfa") },
      ],
    },
  });
  // o local passa no verificador mas o codex (antagonista) reprova; o codex resolve e o OUTRO grande (claude) confere
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.resolvidoPor, "codex");
  assert.strictEqual(r.antagonista, "claude");
});

test("loop: limite de tentativas inválido é recusado", async () => {
  for (const m of [0, -1, 1.5, NaN]) {
    await assert.rejects(() => escada.resolverComLoop({ entrada: "x", verificar: () => ({ ok: true }), maxTentativas: m, agentes: { local: () => "x", superiores: [] }, arquivos: pastaTemp() }), /tentativas/);
  }
});
