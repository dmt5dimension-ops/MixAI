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

const PARADO = { ociosoSegundos: 600, gpuOutrosPct: 2, cpuOutrosPct: 5, videoDecodePct: 0, memoriaLivreGB: 6 };
const RECEM_PARADO = { ...PARADO, ociosoSegundos: 100 };
const decide = (leitura, modo, anterior, agora) => par.decidir({ leitura, modo, anterior, agora, modos, config, memoriaMinimaGB: 2 });

test("usando o PC (mexeu há pouco, placa ou processador ocupados, vídeo, leitura faltando) o alvo é 1", () => {
  const casos = [
    [{ ...PARADO, ociosoSegundos: 10 }, /mexeu no PC/],
    [{ ...PARADO, gpuOutrosPct: 80 }, /placa/],
    [{ ...PARADO, cpuOutrosPct: 90 }, /processador/],
    [{ ...PARADO, videoDecodePct: 18.5 }, /vídeo/],
    [{ ...PARADO, videoDecodePct: null }, /indisponível/],
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
    const d = decide(estado ? PARADO : RECEM_PARADO, "noite", estado, t * 1000);
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
  assert.strictEqual(c.max, 0, "placa sem espaço para um agente: 0, não 1 à força");
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

test("a saída do uso-windows.ps1 vira leitura: JSON na última linha, vídeo medido pelo decodificador, lixo vira null (= usando o PC)", () => {
  const saida = JSON.stringify({ ociosoSegundos: 700, gpuOutrosPct: 1.5, cpuOutrosPct: 4, videoDecodePct: 0, memoriaLivreGB: 5.2 });
  const parado = par.lerSaida(`aviso qualquer\r\n${saida}\r\n`);
  assert.strictEqual(decide(parado, "noite", { alvo: 2, subiuEm: 0 }, 1e6).alvo, 3);
  const comVideo = par.lerSaida(saida.replace('"videoDecodePct":0', '"videoDecodePct":23.4'));
  const d = decide(comVideo, "noite", { alvo: 3, subiuEm: 0 }, 1e6);
  assert.strictEqual(d.alvo, 1);
  assert.match(d.motivo, /23\.4%/);
  const semContador = par.lerSaida(saida.replace('"videoDecodePct":0', '"videoDecodePct":null'));
  assert.match(decide(semContador, "noite", null, 0).motivo, /indisponível/);
  assert.strictEqual(par.lerSaida("erro: nada"), null);
  assert.strictEqual(par.lerSaida(""), null);
  assert.strictEqual(par.lerSaida("123"), null);
});

test("vídeo: lê os nomes reais dos motores (AMD 'video codec 0', 'video decode', NVIDIA 'VideoDecode'), ignora jpeg/enhance, tira a média de 3 leituras e usa limiar >= 1%", () => {
  const nome = (motor) => `pid_4321_luid_0x00000000_0x0000F0D3_phys_0_eng_5_engtype_${motor}`;
  const leituras = (porAmostra) => porAmostra.flatMap((motores, i) => Object.entries(motores).map(([motor, v]) => ({ i, n: nome(motor), v })));
  // AMD tocando vídeo: o uso aparece em "video codec 0" (0 a 4%), "video decode" fica em 0.
  const amd = leituras([{ "video decode": 0, "video codec 0": 4, "video jpeg": 0, "video enhance": 0 }, { "video decode": 0, "video codec 0": 0, "video jpeg": 0, "video enhance": 0 }, { "video decode": 0, "video codec 0": 2, "video jpeg": 0, "video enhance": 0 }]);
  assert.strictEqual(par.videoDecodeDe({ amostras: 3, motores: amd }), 2);
  // jpeg e enhance sozinhos não contam como vídeo tocando
  const so = leituras([{ "video jpeg": 50, "video enhance": 60 }, { "video jpeg": 50, "video enhance": 60 }, { "video jpeg": 50, "video enhance": 60 }]);
  assert.strictEqual(par.videoDecodeDe({ amostras: 3, motores: so }), 0);
  // NVIDIA/Intel
  const nv = leituras([{ VideoDecode: 9 }, { VideoDecode: 6 }, { VideoDecode: 3 }]);
  assert.strictEqual(par.videoDecodeDe({ amostras: 3, motores: nv }), 6);
  // menos de 3 leituras, ou nenhum motor de vídeo: indisponível
  assert.strictEqual(par.videoDecodeDe({ amostras: 2, motores: nv }), null);
  assert.strictEqual(par.videoDecodeDe({ amostras: 3, motores: [] }), null);
  assert.strictEqual(par.videoDecodeDe({ amostras: 3, motores: { i: 0, n: nome("3D"), v: 5 } }), null);
  // um pico isolado diluído nas 3 leituras (0,0,2 => 0,67%) não conta; média de 1% ou mais conta
  const pico = leituras([{ "video codec 0": 0 }, { "video codec 0": 0 }, { "video codec 0": 2 }]);
  assert.ok(par.videoDecodeDe({ amostras: 3, motores: pico }) < config.ocupado.videoDecodeAcimaDePct);
  const limite = leituras([{ "video codec 0": 1 }, { "video codec 0": 1 }, { "video codec 0": 1 }]);
  const base = { ociosoSegundos: 700, gpuOutrosPct: 1, cpuOutrosPct: 2, memoriaLivreGB: 6 };
  const bruta = (motores) => JSON.stringify({ ...base, videoAmostras: 3, videoMotores: motores });
  assert.match(decide(par.lerSaida(bruta(limite)), "noite", { alvo: 3, subiuEm: 0 }, 1e6).motivo, /vídeo tocando/);
  assert.strictEqual(decide(par.lerSaida(bruta(pico)), "noite", { alvo: 3, subiuEm: 0 }, 1e6).alvo, 3);
  assert.match(decide(par.lerSaida(bruta([])), "noite", { alvo: 3, subiuEm: 0 }, 1e6).motivo, /indisponível/);
});

test("falha de leitura NUNCA vira PC parado: null, texto, negativo, NaN, fora de faixa e campo faltando contam como em uso", () => {
  const campos = ["ociosoSegundos", "gpuOutrosPct", "cpuOutrosPct", "videoDecodePct", "memoriaLivreGB"];
  const ruins = [null, undefined, "0", "", NaN, -1, Infinity, {}, [], true];
  for (const campo of campos) {
    for (const ruim of ruins) {
      const d = decide({ ...PARADO, [campo]: ruim }, "noite", { alvo: 3, subiuEm: 0 }, 1e6);
      assert.strictEqual(d.alvo, 1, `${campo}=${String(ruim)}`);
      assert.match(d.motivo, /indisponível/, `${campo}=${String(ruim)}`);
    }
    const sem = { ...PARADO };
    delete sem[campo];
    assert.strictEqual(decide(sem, "noite", { alvo: 3, subiuEm: 0 }, 1e6).alvo, 1, `sem ${campo}`);
  }
  assert.strictEqual(decide(PARADO, "noite", { alvo: 3, subiuEm: 0 }, 1e6).alvo, 3, "controle: tudo válido e parado mantém");
  // pela saída do script: contador que falhou vem null
  const base = { ociosoSegundos: 900, gpuOutrosPct: 1, cpuTotalPct: 10, cpuMeuPct: 5, nucleos: 8, videoAmostras: 3, videoMotores: [0, 1, 2].map((i) => ({ i, n: "pid_1_engtype_video codec 0", v: 0 })), memoriaLivreGB: 6 };
  for (const quebra of [{ ociosoSegundos: null }, { gpuOutrosPct: null }, { cpuTotalPct: null }, { cpuMeuPct: null }, { nucleos: null }, { videoAmostras: 0 }, { videoMotores: [] }, { memoriaLivreGB: null }]) {
    const leitura = par.lerSaida(JSON.stringify({ ...base, ...quebra }));
    assert.strictEqual(decide(leitura, "noite", { alvo: 3, subiuEm: 0 }, 1e6).alvo, 1, JSON.stringify(quebra));
  }
  assert.strictEqual(decide(par.lerSaida(JSON.stringify(base)), "noite", { alvo: 3, subiuEm: 0 }, 1e6).alvo, 3, "controle: saída completa e parada mantém");
});

test("CPU de outros programas: cada processo do Ollama conta uma vez, dividido pelos núcleos; o script não usa curinga por nome", () => {
  // total 30%; o Ollama usa 80% de UM núcleo (de 8) => 10% da máquina => outros programas: 20%
  assert.strictEqual(par.cpuOutrosDe({ cpuTotalPct: 30, cpuMeuPct: 80, nucleos: 8 }), 20);
  // Ollama com 3 processos (50 + 30 + 20 de núcleo) somados uma vez só
  assert.strictEqual(par.cpuOutrosDe({ cpuTotalPct: 30, cpuMeuPct: 100, nucleos: 8 }), 17.5);
  // nunca negativo nem acima de 100
  assert.strictEqual(par.cpuOutrosDe({ cpuTotalPct: 5, cpuMeuPct: 20, nucleos: 8 }), 2.5);
  assert.strictEqual(par.cpuOutrosDe({ cpuTotalPct: 5, cpuMeuPct: 100, nucleos: 8 }), 0, "o Ollama a 100% de um núcleo num total baixo: folga de medição, vira 0");
  assert.strictEqual(par.cpuOutrosDe({ cpuTotalPct: 5, cpuMeuPct: 9000, nucleos: 8 }), null, "9000% por processo é impossível: leitura quebrada, não 0%");
  assert.strictEqual(par.cpuOutrosDe({ cpuTotalPct: 250, cpuMeuPct: 10, nucleos: 8 }), null, "total acima de 100% é impossível");
  assert.strictEqual(par.cpuOutrosDe({ cpuTotalPct: 100, cpuMeuPct: 0, nucleos: 8 }), 100);
  assert.strictEqual(par.cpuOutrosDe({ cpuTotalPct: 30, cpuMeuPct: 80, nucleos: 0 }), null);
  assert.strictEqual(par.cpuOutrosDe({ cpuTotalPct: null, cpuMeuPct: 80, nucleos: 8 }), null);
  const uso = fs.readFileSync(path.join(RAIZ, "local", "uso-windows.ps1"), "utf8");
  // Windows em português traduz os caminhos de Get-Counter (\Processor, \Process): a CPU vem das classes CIM,
  // que têm o mesmo nome em qualquer idioma, e o processo do Ollama é achado pelo número (IDProcess), não pelo nome.
  assert.doesNotMatch(uso, /Get-Counter\s+['"]\\Process/i);
  assert.match(uso, /Win32_PerfFormattedData_PerfOS_Processor/);
  assert.match(uso, /Win32_PerfFormattedData_PerfProc_Process/);
  assert.match(uso, /IDProcess/);
  assert.doesNotMatch(uso, /\\Process\(\$/, "curinga por nome contava o mesmo processo mais de uma vez");
});

test("leitura inválida de contador (null, NaN, negativo, fora de faixa, amostra faltando) vira indisponível, nunca zero", () => {
  const nome = "pid_4321_luid_0x0_0x1_phys_0_eng_5_engtype_video codec 0";
  const tres = (v) => [0, 1, 2].map((i) => ({ i, n: nome, v }));
  assert.strictEqual(par.videoDecodeDe({ amostras: 3, motores: tres(2) }), 2, "controle");
  for (const ruim of [null, undefined, NaN, "3", -1, 250, Infinity]) {
    assert.strictEqual(par.videoDecodeDe({ amostras: 3, motores: tres(ruim) }), null, String(ruim));
    const uma = tres(2);
    uma[1] = { ...uma[1], v: ruim };
    assert.strictEqual(par.videoDecodeDe({ amostras: 3, motores: uma }), null, `uma leitura ${String(ruim)}`);
  }
  // amostra sem nenhum motor de vídeo (faltou ler) não conta como zero
  assert.strictEqual(par.videoDecodeDe({ amostras: 3, motores: [tres(2)[0], tres(2)[2]] }), null);
  // índice de amostra fora do intervalo
  assert.strictEqual(par.videoDecodeDe({ amostras: 3, motores: [...tres(2), { i: 7, n: nome, v: 1 }] }), null);
  // e o decisor trata isso como em uso
  const base = { ociosoSegundos: 900, gpuOutrosPct: 1, cpuTotalPct: 10, cpuMeuPct: 5, nucleos: 8, videoAmostras: 3, memoriaLivreGB: 6 };
  const leitura = par.lerSaida(JSON.stringify({ ...base, videoMotores: tres(null) }));
  assert.strictEqual(decide(leitura, "noite", { alvo: 3, subiuEm: 0 }, 1e6).alvo, 1);
  // o script não aceita número inválido: só sai número depois de Test-Numero
  const uso = fs.readFileSync(path.join(RAIZ, "local", "uso-windows.ps1"), "utf8");
  assert.match(uso, /function Test-Numero/);
  assert.match(uso, /Test-Numero \$l\.v/);
  assert.match(uso, /Test-Numero \$cpu\.PercentProcessorTime/);
  assert.match(uso, /Test-Numero \$p\.PercentProcessorTime/);
  assert.match(uso, /Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine/);
  // cada amostra do contador da placa só vale com Status válido (0 ou 1); senão vira $null, mesmo que o valor seja 0
  assert.match(uso, /\$a\.Status -eq 0 -or \$a\.Status -eq 1/);
  assert.match(uso, /\} else \{ \$null \}|else \{ \$null \}/);
  // e uma amostra inválida (null) no meio invalida a medida inteira, tanto de vídeo quanto de placa
  const nomeMotor = "pid_4321_luid_0x0_0x1_phys_0_eng_5_engtype_video decode";
  const motores = [0, 1, 2].map((i) => ({ i, n: nomeMotor, v: i === 1 ? null : 0 }));
  assert.strictEqual(par.videoDecodeDe({ amostras: 3, motores }), null, "amostra inválida com valor zero não pode virar 'sem vídeo'");
  const semGpu = par.lerSaida(JSON.stringify({ ociosoSegundos: 900, gpuOutrosPct: null, cpuTotalPct: 5, cpuMeuPct: 1, nucleos: 8, videoAmostras: 0, videoMotores: [], memoriaLivreGB: 6 }));
  assert.strictEqual(decide(semGpu, "noite", { alvo: 3, subiuEm: 0 }, 1e6).alvo, 1);
});

test("sem histórico, o tempo que o PC já está parado conta como subida (parado há horas não começa em 1); mostra o regime", () => {
  const horas = decide({ ...PARADO, ociosoSegundos: 5 * 3600 }, "dia", null, 0);
  assert.strictEqual(horas.alvo, modos.dia.agentesMax);
  assert.strictEqual(horas.regime, modos.dia.agentesMax);
  assert.match(horas.motivo, /no máximo/);
  const pouco = decide({ ...PARADO, ociosoSegundos: config.ocupado.ociosoAbaixoDeSegundos + 1 }, "noite", null, 0);
  assert.strictEqual(pouco.alvo, 1);
  assert.strictEqual(pouco.regime, modos.noite.agentesMax);
  const quase = decide({ ...PARADO, ociosoSegundos: config.ocupado.ociosoAbaixoDeSegundos + config.subidaMinSegundos * 2 }, "noite", null, 0);
  assert.strictEqual(quase.alvo, 3);
  const usando = decide({ ...PARADO, ociosoSegundos: 5 }, "noite", null, 0);
  assert.strictEqual(usando.alvo, 1);
  assert.strictEqual(usando.regime, 1);
  // a primeira chamada do controle (sem arquivo de estado) também parte desse crédito
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "par-")), "estado.json");
  const controle = par.criarControle({ leitor: { ler: () => ({ ...PARADO, ociosoSegundos: 7200 }) }, modo: "dia", arquivoEstado: arq, relogio: () => 0, modos, config });
  assert.strictEqual(controle(), modos.dia.agentesMax);
});

test("o controle lê o PC, guarda o estado em arquivo, reaproveita leitura recente e avisa só quando muda", () => {
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "par-")), "estado.json");
  let agora = 0;
  let leituras = 0;
  const leitor = { ler: () => { leituras += 1; return leituras === 1 ? RECEM_PARADO : PARADO; } };
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

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
const microDe = (id) => ({ id, instrucao: "x", contexto: `contexto de ${id}`, escopo: [`src/${id}.js`], verificar: "true" });
const arquivosTemp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "esc-")); return { regras: path.join(d, "r.json"), casos: path.join(d, "casos.jsonl"), treino: path.join(d, "t.jsonl"), falhas: path.join(d, "falhas.jsonl"), pendentes: path.join(d, "p.jsonl") }; };
// O verificador do lote devolve { ok }; devolver só um booleano reprova tudo sem ninguém perceber.
const verificadorOk = () => (saida) => ({ ok: saida === "ok" });

test("o lote acompanha o limite dinâmico: abre vagas quando o PC fica parado, e TODAS as microtarefas terminam certas pelo local", async () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const limites = [1, 1, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2];
  let chamada = 0;
  let agora = 0;
  let pico = 0;
  const picos = [];
  let superior = 0;
  const r = await escada.lote({
    microtarefas: ids.map(microDe),
    verificadorDe: verificadorOk,
    paralelismo: () => limites[Math.min(chamada++, limites.length - 1)],
    reavaliarMs: 5,
    arquivos: arquivosTemp(),
    agentes: { local: async () => { agora += 1; pico = Math.max(pico, agora); picos.push(agora); await esperar(20); agora -= 1; return "ok"; }, superiores: [{ nome: "codex", chamar: () => { superior += 1; return "ok"; } }] },
  });
  assert.deepStrictEqual(r.map((x) => [x.id, x.ok, x.resolvidoPor]), ids.map((id) => [id, true, "local"]));
  assert.strictEqual(superior, 0, "nada deve subir para o Codex");
  assert.ok(pico >= 2 && pico <= 3, `pico ${pico}`);
  assert.strictEqual(picos[0], 1, "começa com 1");
});

test("quando o dono volta ao PC, agentes locais em andamento são tirados (sem subir para o Codex) e a microtarefa volta à fila", async () => {
  const ids = ["a", "b", "c"];
  let limite = 3;
  const abortados = [];
  const iniciadas = [];
  let simultaneos = 0;
  let picoDepoisDeReduzir = 0;
  let reduziu = false;
  let superior = 0;
  const local = (prompt, signal) => new Promise((ok, no) => {
    const id = ids.find((i) => prompt.includes(`contexto de ${i}`));
    iniciadas.push(id);
    simultaneos += 1;
    if (reduziu) picoDepoisDeReduzir = Math.max(picoDepoisDeReduzir, simultaneos);
    const fim = setTimeout(() => { simultaneos -= 1; ok("ok"); }, 120);
    signal.addEventListener("abort", () => { clearTimeout(fim); simultaneos -= 1; abortados.push(id); no(new Error("abortado")); });
  });
  setTimeout(() => { limite = 1; reduziu = true; }, 30);
  const r = await escada.lote({
    microtarefas: ids.map(microDe), verificadorDe: verificadorOk, paralelismo: () => limite, reavaliarMs: 10, arquivos: arquivosTemp(),
    agentes: { local, superiores: [{ nome: "codex", chamar: () => { superior += 1; return "ok"; } }] },
  });
  assert.deepStrictEqual(r.map((x) => [x.id, x.ok, x.resolvidoPor]), ids.map((id) => [id, true, "local"]));
  assert.deepStrictEqual(abortados.sort(), ["b", "c"], "tira os mais novos e deixa o mais antigo terminar");
  assert.strictEqual(superior, 0, "tirar do local não é falha: nada sobe para o Codex");
  assert.ok(iniciadas.length >= 5, `as duas tiradas recomeçam depois (${iniciadas.join(",")})`);
  assert.strictEqual(picoDepoisDeReduzir, 1, "depois de reduzir, só 1 agente por vez");
});

test("a vaga só é reaproveitada depois que o processo abortado confirma que morreu (mesmo se demorar a morrer)", async () => {
  const ids = ["a", "b", "c"];
  let limite = 3;
  let vivos = 0;
  const violacoes = [];
  const local = (prompt, signal) => new Promise((ok, no) => {
    vivos += 1;
    if (limite === 1 && vivos > 3) violacoes.push(`vivos ${vivos}`);
    const fim = setTimeout(() => { vivos -= 1; ok("ok"); }, 80);
    // morre devagar: 100 ms depois do pedido
    signal.addEventListener("abort", () => { clearTimeout(fim); setTimeout(() => { vivos -= 1; no(new Error("abortado")); }, 100); });
  });
  let nascidosEnquantoMorriam = 0;
  setTimeout(() => { limite = 1; }, 20);
  const sonda = setInterval(() => { if (limite === 1 && vivos > 3) nascidosEnquantoMorriam += 1; }, 5);
  const r = await escada.lote({
    microtarefas: ids.map(microDe), verificadorDe: verificadorOk, paralelismo: () => limite, reavaliarMs: 10, arquivos: arquivosTemp(),
    agentes: { local, superiores: [] },
  });
  clearInterval(sonda);
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  assert.deepStrictEqual(violacoes, []);
  assert.strictEqual(nascidosEnquantoMorriam, 0);
});

test("limite oscilando 2 -> 0 -> 1 -> 2: com 0 nada novo nasce, com 1 só nasce com ninguém vivo (inclusive morrendo); todas terminam", async () => {
  let limite = 2;
  let vivos = 0;
  const violacoes = [];
  let partidas = 0;
  const local = (prompt, signal) => new Promise((ok, no) => {
    vivos += 1;
    partidas += 1;
    if (limite === 0) violacoes.push("nasceu com limite 0");
    if (limite === 1 && vivos > 1) violacoes.push(`nasceu com limite 1 e ${vivos} vivos`);
    const fim = setTimeout(() => { vivos -= 1; ok("ok"); }, 60);
    signal.addEventListener("abort", () => { clearTimeout(fim); setTimeout(() => { vivos -= 1; no(new Error("abortado")); }, 15); });
  });
  for (const [t, v] of [[25, 0], [140, 1], [300, 2]]) setTimeout(() => { limite = v; }, t);
  const r = await escada.lote({
    microtarefas: ["a", "b"].map(microDe), verificadorDe: verificadorOk, paralelismo: () => limite, reavaliarMs: 5, arquivos: arquivosTemp(),
    agentes: { local, superiores: [] },
  });
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  assert.deepStrictEqual(violacoes, []);
  assert.ok(partidas >= 4, `as duas foram tiradas e recomeçaram (${partidas} partidas)`);
});

test("chamarComando: ao abortar, só termina depois do processo morrer de verdade", async () => {
  const comando = `"${process.execPath}" -e "setTimeout(()=>{},30000)"`;
  const ctl = new AbortController();
  const chamada = escada.chamarComando(comando)("x", ctl.signal);
  const inicio = Date.now();
  setTimeout(() => ctl.abort(), 150);
  await assert.rejects(chamada);
  assert.ok(Date.now() - inicio < 10000, "não esperou o processo acabar sozinho (30 s)");
});

test("capacidade pode ser 0 (memória ou placa sem espaço) e o alvo acompanha, mesmo com o dono usando o PC", () => {
  const semRam = par.capacidade({ modo: "noite", memoriaLivreGB: 1.5, modos, config, memoriaMinimaGB: 2 });
  assert.strictEqual(semRam.max, 0);
  assert.strictEqual(semRam.limitante, "memoria");
  const semPlaca = par.capacidade({ modo: "noite", memoriaLivreGB: 10, modos, config: { ...config, placa: { ...config.placa, vramGB: 5 } }, memoriaMinimaGB: 2 });
  assert.strictEqual(semPlaca.max, 0);
  const parada = { ociosoSegundos: 99999, gpuOutrosPct: 0, cpuOutrosPct: 0, videoDecodePct: 0, memoriaLivreGB: 1.5 };
  assert.strictEqual(par.decidir({ leitura: parada, modo: "noite", modos, config, memoriaMinimaGB: 2 }).alvo, 0);
  assert.strictEqual(par.decidir({ leitura: { ...parada, ociosoSegundos: 1 }, modo: "noite", modos, config, memoriaMinimaGB: 2 }).alvo, 0, "usando o PC e sem espaço: 0, não 1");
  const livre = { ...parada, memoriaLivreGB: 10 };
  assert.strictEqual(par.decidir({ leitura: livre, modo: "noite", anterior: { alvo: 0, subiuEm: 0 }, agora: 30000, modos, config, memoriaMinimaGB: 2 }).alvo, 0, "ainda não passou o tempo mínimo de subida");
  assert.strictEqual(par.decidir({ leitura: livre, modo: "noite", anterior: { alvo: 0, subiuEm: 0 }, agora: 61000, modos, config, memoriaMinimaGB: 2 }).alvo, 1, "volta a subir quando abre espaço");
});

test("o lote aceita limite dinâmico 0: não inicia nada e espera abrir vaga; limite fixo 0 ou inválido é recusado", async () => {
  let limite = 0;
  let iniciou = 0;
  setTimeout(() => { limite = 1; }, 80);
  const t0 = Date.now();
  const r = await escada.lote({
    microtarefas: [microDe("a")], verificadorDe: verificadorOk, paralelismo: () => limite, reavaliarMs: 10, arquivos: arquivosTemp(),
    agentes: { local: () => { iniciou = Date.now() - t0; return "ok"; }, superiores: [] },
  });
  assert.ok(r[0].ok);
  assert.ok(iniciou >= 70, `só começou depois de abrir vaga (${iniciou} ms)`);
  for (const n of [0, -1, 1.5]) {
    await assert.rejects(escada.lote({ microtarefas: [microDe("a")], verificadorDe: verificadorOk, paralelismo: n, agentes: { local: () => "x", superiores: [] } }), /inteiro maior que zero/, String(n));
  }
  await assert.rejects(escada.lote({ microtarefas: [microDe("a")], verificadorDe: verificadorOk, paralelismo: () => -1, agentes: { local: () => "x", superiores: [] } }), /dinâmico/);
});

test("o modo.ps1 liga o paralelismo do Ollama pelo modo e guarda o modo ligado; o uso-windows.ps1 devolve os campos que o decisor lê", () => {
  const modo = fs.readFileSync(path.join(RAIZ, "local", "modo.ps1"), "utf8");
  assert.match(modo, /OLLAMA_NUM_PARALLEL\s*=\s*"\$\(\$config\.agentesMax\)"/);
  assert.match(modo, /mixai-modo\.txt/);
  assert.ok(modo.indexOf("mixai-modo.txt") > modo.indexOf("criar-apelido.ps1"), "só guarda o modo depois de criar o mixai-local");
  for (const m of Object.values(modos)) assert.ok(Number.isInteger(m.agentesMax) && m.agentesMax >= 1);
  const uso = fs.readFileSync(path.join(RAIZ, "local", "uso-windows.ps1"), "utf8");
  for (const campo of ["ociosoSegundos", "gpuOutrosPct", "cpuTotalPct", "cpuMeuPct", "nucleos", "videoMotores", "videoAmostras", "memoriaLivreGB"]) assert.ok(uso.includes(campo), campo);
  assert.match(uso, /MaxSamples 3/);
  assert.doesNotMatch(uso, /powercfg/, "powercfg /requests exige administrador");
  assert.match(uso, /ConvertTo-Json/);
});

test("escada.js aceita --paralelo auto", () => {
  assert.match(fs.readFileSync(path.join(RAIZ, "orquestra", "escada.js"), "utf8"), /=== 'auto'/);
});

test("abortar a SEGUNDA chamada ao local também espera aquele processo morrer (o fim da 1ª chamada não vale)", async () => {
  let limite = 2;
  let vivos = 0;
  const violacoes = [];
  const chamadas = { a: 0, b: 0 };
  const local = (prompt, signal) => new Promise((ok, no) => {
    const id = prompt.includes("contexto de a") ? "a" : "b";
    chamadas[id] += 1;
    const n = chamadas[id];
    vivos += 1;
    if (limite === 1 && vivos > 1) violacoes.push(`${id} nasceu com ${vivos} vivos`);
    const morrer = (f) => { vivos -= 1; f(); };
    if (n === 1) return setTimeout(() => morrer(() => ok("ruim")), 5);
    if (id === "a" && n === 2) return setTimeout(() => morrer(() => ok("ok")), 150);
    if (id === "b" && n === 2) { signal.addEventListener("abort", () => setTimeout(() => morrer(() => no(new Error("abortado"))), 200)); return; }
    return setTimeout(() => morrer(() => ok("ok")), 10);
  });
  setTimeout(() => { limite = 1; }, 50);
  const r = await escada.lote({
    microtarefas: ["a", "b"].map(microDe), verificadorDe: verificadorOk, paralelismo: () => limite, reavaliarMs: 5, maxTentativas: 2, arquivos: arquivosTemp(),
    agentes: { local, superiores: [] },
  });
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  assert.deepStrictEqual(violacoes, []);
});

test("uma única microtarefa rodando é reavaliada: se o teto cai para 0 ela é tirada, e volta quando abre vaga", async () => {
  let limite = 1;
  let vivos = 0;
  let abortada = 0;
  const violacoes = [];
  const local = (prompt, signal) => new Promise((ok, no) => {
    vivos += 1;
    if (limite === 0) violacoes.push("nasceu com limite 0");
    const fim = setTimeout(() => { vivos -= 1; ok("ok"); }, 150);
    signal.addEventListener("abort", () => { clearTimeout(fim); abortada += 1; setTimeout(() => { vivos -= 1; no(new Error("abortado")); }, 10); });
  });
  setTimeout(() => { limite = 0; }, 40);
  setTimeout(() => { limite = 1; }, 200);
  const r = await escada.lote({ microtarefas: [microDe("a")], verificadorDe: verificadorOk, paralelismo: () => limite, reavaliarMs: 10, arquivos: arquivosTemp(), agentes: { local, superiores: [] } });
  assert.ok(r[0].ok);
  assert.strictEqual(abortada, 1);
  assert.deepStrictEqual(violacoes, []);
});

test("matarArvore no Windows repete o taskkill, aceita 'já não existe' e, se falhar, avisa e devolve false (a vaga segue ocupada até o processo fechar)", () => {
  const filho = { pid: 123, kill: () => { filho.mortoSo = true; } };
  const chamadas = [];
  const seguidos = (...status) => (cmd, args) => { chamadas.push([cmd, ...args]); return { status: status[Math.min(chamadas.length - 1, status.length - 1)] }; };
  assert.strictEqual(escada.matarArvore(filho, { plataforma: "win32", executar: seguidos(1, 1, 0) }), true);
  assert.strictEqual(chamadas.length, 3);
  assert.deepStrictEqual(chamadas[0], ["taskkill", "/pid", "123", "/T", "/F"]);
  chamadas.length = 0;
  assert.strictEqual(escada.matarArvore(filho, { plataforma: "win32", executar: seguidos(128) }), true, "128 = já não existe");
  chamadas.length = 0;
  const err = console.error; const avisos = []; console.error = (m) => avisos.push(m);
  try {
    assert.strictEqual(escada.matarArvore(filho, { plataforma: "win32", executar: () => ({ status: 1 }) }), false);
  } finally { console.error = err; }
  assert.ok(filho.mortoSo, "ao menos o processo principal");
  assert.match(avisos[0], /não consegui matar/);
  assert.strictEqual(escada.matarArvore(filho, { plataforma: "win32", executar: () => ({ error: new Error("sem taskkill") }), tentativas: 1 }), false);
});

test("estado salvo de uma execução antiga expira: um lote novo não herda o alvo antigo", () => {
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "par-")), "estado.json");
  fs.writeFileSync(arq, JSON.stringify({ alvo: 3, subiuEm: 0, gravadoEm: 0 }));
  const agora = 10 * 3600 * 1000;
  const controle = par.criarControle({ leitor: { ler: () => RECEM_PARADO }, modo: "noite", arquivoEstado: arq, relogio: () => agora, modos, config });
  assert.strictEqual(controle(), 1, "estado de 10 h atrás é ignorado");
  fs.writeFileSync(arq, JSON.stringify({ alvo: 3, subiuEm: agora - 1000, gravadoEm: agora - 1000 }));
  assert.strictEqual(par.criarControle({ leitor: { ler: () => PARADO }, modo: "noite", arquivoEstado: arq, relogio: () => agora, modos, config })(), 3, "estado recente vale");
  fs.writeFileSync(arq, JSON.stringify({ alvo: 3, subiuEm: agora }));
  assert.strictEqual(par.criarControle({ leitor: { ler: () => RECEM_PARADO }, modo: "noite", arquivoEstado: arq, relogio: () => agora, modos, config })(), 1, "sem data de gravação: ignorado");
});
