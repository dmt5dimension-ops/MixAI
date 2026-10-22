// Testa o ajuste de quantos agentes locais rodam juntos conforme o uso do PC (orquestra/paralelismo.js).
// A leitura do Windows é simulada; o script real (local/uso-windows.ps1) só roda no PC do dono.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RAIZ = path.resolve(__dirname, "..");
const par = require(path.join(RAIZ, "orquestra", "paralelismo.js"));
const escada = require(path.join(RAIZ, "orquestra", "escada.js"));
const modos = JSON.parse(fs.readFileSync(path.join(RAIZ, "local", "modos.json"), "utf8"));
const config = JSON.parse(fs.readFileSync(path.join(RAIZ, "orquestra", "paralelismo.json"), "utf8"));

const PARADO = { ociosoSegundos: 600, gpuOutrosPct: 2, cpuOutrosPct: 5, videoTocando: false, memoriaLivreGB: 6 };
const decide = (leitura, modo, anterior, agora) => par.decidir({ leitura, modo, anterior, agora, modos, config, memoriaMinimaGB: 2 });

test("usando o PC (mexeu há pouco, placa ou processador ocupados, vídeo, leitura faltando) o alvo é 1", () => {
  const casos = [
    [{ ...PARADO, ociosoSegundos: 10 }, /mexeu no PC/],
    [{ ...PARADO, gpuOutrosPct: 80 }, /placa/],
    [{ ...PARADO, cpuOutrosPct: 90 }, /processador/],
    [{ ...PARADO, videoTocando: true }, /vídeo/],
    [null, /indisponível/],
    [{ ...PARADO, memoriaLivreGB: undefined }, /indisponível/],
  ];
  for (const [leitura, texto] of casos) {
    const d = decide(leitura, "noite", { alvo: 3, subiuEm: 0 }, 1e6);
    assert.strictEqual(d.alvo, 1, String(texto));
    assert.match(d.motivo, texto);
  }
});

test("parado, sobe um por vez, só depois do tempo mínimo, até o teto do modo", () => {
  let estado = null;
  const alvos = [];
  for (let t = 0; t <= 300; t += 30) {
    const d = decide(PARADO, "noite", estado, t * 1000);
    estado = d.estado;
    alvos.push(d.alvo);
  }
  // primeira leitura: 1 (agora=0); sobe a cada 60 s; teto da noite = agentesMax 3
  assert.deepStrictEqual(alvos, [1, 1, 2, 2, 3, 3, 3, 3, 3, 3, 3]);
});

test("o modo dia tem teto menor que o da noite, e o teto sempre respeita placa, memória e máximo absoluto", () => {
  assert.ok(par.capacidade({ modo: "dia", memoriaLivreGB: 10, modos, config, memoriaMinimaGB: 2 }).max < par.capacidade({ modo: "noite", memoriaLivreGB: 10, modos, config, memoriaMinimaGB: 2 }).max);
  const placaPequena = { ...config, placa: { ...config.placa, vramGB: 6.5 } };
  const c = par.capacidade({ modo: "noite", memoriaLivreGB: 10, modos, config: placaPequena, memoriaMinimaGB: 2 });
  assert.strictEqual(c.max, 1);
  assert.strictEqual(c.limitante, "placa");
  const semRam = par.capacidade({ modo: "noite", memoriaLivreGB: 2.6, modos, config, memoriaMinimaGB: 2 });
  assert.strictEqual(semRam.max, 1);
  assert.strictEqual(semRam.limitante, "memoria");
  const muitos = par.capacidade({ modo: "noite", memoriaLivreGB: 64, modos: { noite: { ...modos.noite, agentesMax: 99, contexto: 1024 } }, config, memoriaMinimaGB: 2 });
  assert.strictEqual(muitos.max, config.maximoAbsoluto);
  assert.throws(() => par.capacidade({ modo: "meio-dia", memoriaLivreGB: 8, modos, config, memoriaMinimaGB: 2 }), /modo desconhecido/);
});

test("com a configuração real, 8 GB de placa e contexto de cada modo cabem no teto do modo", () => {
  for (const modo of ["dia", "noite"]) {
    const c = par.capacidade({ modo, memoriaLivreGB: 8, modos, config, memoriaMinimaGB: 2 });
    assert.strictEqual(c.max, modos[modo].agentesMax, `${modo}: ${JSON.stringify(c.limites)}`);
  }
});

test("quando o dono volta a mexer no PC cai para 1 na hora; parado de novo, sobe de novo aos poucos", () => {
  let d = decide(PARADO, "noite", { alvo: 3, subiuEm: 0 }, 1e6);
  assert.strictEqual(d.alvo, 3);
  d = decide({ ...PARADO, ociosoSegundos: 2 }, "noite", d.estado, 1e6 + 1000);
  assert.strictEqual(d.alvo, 1);
  d = decide(PARADO, "noite", d.estado, 1e6 + 2000);
  assert.strictEqual(d.alvo, 1, "não sobe antes do tempo mínimo");
  d = decide(PARADO, "noite", d.estado, 1e6 + 70000);
  assert.strictEqual(d.alvo, 2);
});

test("se a memória livre cai no meio do caminho, o alvo desce para o que cabe", () => {
  const d = decide({ ...PARADO, memoriaLivreGB: 2.6 }, "noite", { alvo: 3, subiuEm: 0 }, 1e6);
  assert.strictEqual(d.alvo, 1);
  assert.match(d.motivo, /memoria/);
});

test("o controle lê o PC, guarda o estado em arquivo, reaproveita leitura recente e avisa só quando muda", () => {
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "par-")), "estado.json");
  let agora = 0;
  let leituras = 0;
  const leitor = { ler: () => { leituras += 1; return PARADO; } };
  const avisos = [];
  const controle = par.criarControle({ leitor, modo: "noite", arquivoEstado: arq, relogio: () => agora, cacheMs: 5000, modos, config, aoDecidir: (d) => avisos.push(d.alvo) });
  assert.strictEqual(controle(), 1);
  agora = 1000;
  assert.strictEqual(controle(), 1);
  assert.strictEqual(leituras, 1, "leitura recente é reaproveitada");
  agora = 61000;
  assert.strictEqual(controle(), 2);
  assert.strictEqual(JSON.parse(fs.readFileSync(arq, "utf8")).alvo, 2);
  assert.deepStrictEqual(avisos, [1, 2]);
});

test("modoAtual usa a variável MIXAI_MODO, o arquivo que o modo.ps1 deixa, e cai no dia", () => {
  assert.strictEqual(par.modoAtual({ MIXAI_MODO: "noite" }), "noite");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "modo-"));
  assert.strictEqual(par.modoAtual({ LOCALAPPDATA: base }), "dia");
  fs.mkdirSync(path.join(base, "Ollama"));
  fs.writeFileSync(path.join(base, "Ollama", "mixai-modo.txt"), "noite\r\n");
  assert.strictEqual(par.modoAtual({ LOCALAPPDATA: base }), "noite");
});

test("o lote acompanha o limite dinâmico: abre vagas quando o PC fica parado e fecha quando o dono volta", async () => {
  const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const ids = ["a", "b", "c", "d", "e", "f"];
  const micro = (id) => ({ id, instrucao: "x", contexto: `contexto de ${id}`, escopo: [`src/${id}.js`], verificar: "true" });
  const arquivos = (() => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "esc-")); return { regras: path.join(d, "r.json"), casos: path.join(d, "casos.jsonl"), treino: path.join(d, "t.jsonl"), falhas: path.join(d, "falhas.jsonl"), pendentes: path.join(d, "p.jsonl") }; })();
  const limites = [1, 1, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2];
  let chamada = 0;
  let agora = 0;
  let pico = 0;
  const picos = [];
  await escada.lote({
    microtarefas: ids.map(micro),
    verificadorDe: () => (saida) => saida === "ok",
    paralelismo: () => limites[Math.min(chamada++, limites.length - 1)],
    reavaliarMs: 5,
    arquivos,
    agentes: { local: async () => { agora += 1; pico = Math.max(pico, agora); picos.push(agora); await esperar(20); agora -= 1; return "ok"; }, superiores: [] },
  });
  assert.ok(pico >= 2 && pico <= 3, `pico ${pico}`);
  assert.strictEqual(picos[0], 1, "começa com 1");
});

test("limite dinâmico inválido é recusado em vez de travar o lote", async () => {
  await assert.rejects(escada.lote({ microtarefas: [{ id: "a", instrucao: "x", contexto: "c", escopo: ["a.js"], verificar: "true" }], verificadorDe: () => () => true, paralelismo: () => 0, agentes: { local: () => "x", superiores: [] } }), /inteiro maior que zero/);
});

test("o modo.ps1 liga o paralelismo do Ollama pelo modo e guarda o modo ligado; o uso-windows.ps1 devolve os campos que o decisor lê", () => {
  const modo = fs.readFileSync(path.join(RAIZ, "local", "modo.ps1"), "utf8");
  assert.match(modo, /OLLAMA_NUM_PARALLEL\s*=\s*"\$\(\$config\.agentesMax\)"/);
  assert.match(modo, /mixai-modo\.txt/);
  assert.ok(modo.indexOf("mixai-modo.txt") > modo.indexOf("criar-apelido.ps1"), "só guarda o modo depois de criar o mixai-local");
  for (const m of Object.values(modos)) assert.ok(Number.isInteger(m.agentesMax) && m.agentesMax >= 1);
  const uso = fs.readFileSync(path.join(RAIZ, "local", "uso-windows.ps1"), "utf8");
  for (const campo of ["ociosoSegundos", "gpuOutrosPct", "cpuOutrosPct", "videoTocando", "memoriaLivreGB"]) assert.ok(uso.includes(campo), campo);
  assert.match(uso, /ConvertTo-Json/);
});

test("escada.js aceita --paralelo auto", () => {
  assert.match(fs.readFileSync(path.join(RAIZ, "orquestra", "escada.js"), "utf8"), /=== 'auto'/);
});
