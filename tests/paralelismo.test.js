// Testa o ajuste de quantos agentes locais rodam juntos conforme o uso do PC (orquestra/paralelismo.js).
// A leitura do Windows é simulada; o script real (local/uso-windows.ps1) só roda no PC do dono.
const { test, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RAIZ = path.resolve(__dirname, "..");
const matarGrupo = (pid) => {
  if (process.platform === "win32") require("node:child_process").spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
  else { try { process.kill(-pid, "SIGKILL"); } catch { /* limpeza do teste */ } }
};
const matarReal = (f) => escada.matarArvore(f);
// O orquestrador com paralelismo só roda no Windows (Job Object); fora dele `chamarComando` recusa (testado abaixo).
// Para exercitar o resto da lógica em Linux (CI), `chamar` injeta um lançador de shell em grupo próprio, com a morte
// do grupo no lugar do Job Object. No Windows passa direto para o código real.
// Processos que os testes deixam vivos de propósito (matar recusado): encerrados de verdade ao fim de cada teste.
const rastreados = new Set();
afterEach(() => { for (const pid of rastreados) matarGrupo(pid); rastreados.clear(); });
const rastrear = (matar) => (f) => { rastreados.add(f.pid); return matar(f); };
const semente = () => process.platform === "win32" ? {} : {
  plataforma: "win32",
  lancar: (c, fd) => { const f = require("node:child_process").spawn(c, { shell: true, stdio: [fd, "pipe", "pipe"], detached: true }); rastreados.add(f.pid); return f; },
  matar: (f) => { matarGrupo(f.pid); return true; },
  orfaos: (f) => { matarGrupo(f.pid); return []; },
};
const chamar = (comando, opcoes = {}) => escada.chamarComando(comando, { ...(opcoes.lancar ? {} : semente()), ...opcoes, ...(opcoes.matar ? { matar: rastrear(opcoes.matar) } : {}) });
const par = require(path.join(RAIZ, "orquestra", "paralelismo.js"));
const escada = require(path.join(RAIZ, "orquestra", "escada.js"));
const modos = JSON.parse(fs.readFileSync(path.join(RAIZ, "local", "modos.json"), "utf8"));
const config = JSON.parse(fs.readFileSync(path.join(RAIZ, "orquestra", "paralelismo.json"), "utf8"));

const PARADO = { ociosoSegundos: 600, gpuOutrosPct: 2, cpuOutrosPct: 5, videoDecodePct: 0, memoriaLivreGB: 6 };
const RECEM_PARADO = { ...PARADO, ociosoSegundos: 100 };
const decide = (leitura, modo, anterior, agora) => par.decidir({ leitura, modo, anterior, agora, modos, config, memoriaMinimaGB: 2 });
// Sem o campo de memória na leitura, a decisão usa a memória livre do próprio sistema (os.freemem): o teste fixa esse número,
// senão o resultado depende de quanta memória o PC de quem roda tem livre naquele instante.
const comMemoriaDoSO = (gb, corpo) => {
  const original = os.freemem;
  os.freemem = () => gb * 1024 ** 3;
  try { return corpo(); } finally { os.freemem = original; }
};

test("usando o PC (mexeu há pouco, placa ou processador ocupados, vídeo, leitura faltando) o alvo é 1", () => {
  comMemoriaDoSO(6, () => {
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

test("vídeo: lê os nomes reais dos motores (AMD 'video codec 0', 'video decode', NVIDIA 'VideoDecode'), ignora jpeg/enhance, tira a média de 3 leituras e usa o limiar da config (acima do ruído de ~5% do 'video codec 0' sem vídeo)", () => {
  const nome = (motor) => `pid_4321_luid_0x00000000_0x0000F0D3_phys_0_eng_5_engtype_${motor}`;
  const leituras = (porAmostra) => porAmostra.flatMap((motores, i) => Object.entries(motores).map(([motor, v]) => ({ i, n: nome(motor), v })));
  // AMD tocando vídeo: o uso aparece em "video codec 0" (0 a 4%), "video decode" fica em 0.
  const amd = leituras([{ "video decode": 0, "video codec 0": 4, "video jpeg": 0, "video enhance": 0 }, { "video decode": 0, "video codec 0": 0, "video jpeg": 0, "video enhance": 0 }, { "video decode": 0, "video codec 0": 2, "video jpeg": 0, "video enhance": 0 }]);
  assert.strictEqual(par.videoDecodeDe({ amostras: 3, motores: amd }), 2);
  // coleta válida sem motor de decodificação (só jpeg/enhance, ou nenhum motor de vídeo): "sem vídeo" = 0, não null
  const so = leituras([{ "video jpeg": 50, "video enhance": 60 }, { "video jpeg": 50, "video enhance": 60 }, { "video jpeg": 50, "video enhance": 60 }]);
  assert.strictEqual(par.videoDecodeDe({ amostras: 3, motores: so }), 0);
  assert.strictEqual(par.videoDecodeDe({ amostras: 3, motores: [] }), 0);
  // só falha de coleta vira null
  assert.strictEqual(par.videoDecodeDe({ amostras: 2, motores: [] }), null);
  assert.strictEqual(par.videoDecodeDe({ amostras: undefined, motores: [] }), null);
  // uma amostra só com jpeg no meio de amostras com decodificador também é indisponível
  const faltaUma = leituras([{ "video codec 0": 0 }, { "video jpeg": 5 }, { "video codec 0": 0 }]);
  assert.strictEqual(par.videoDecodeDe({ amostras: 3, motores: faltaUma }), null);
  // NVIDIA/Intel
  const nv = leituras([{ VideoDecode: 9 }, { VideoDecode: 6 }, { VideoDecode: 3 }]);
  assert.strictEqual(par.videoDecodeDe({ amostras: 3, motores: nv }), 6);
  // menos de 3 leituras, ou nenhum motor de vídeo: indisponível
  assert.strictEqual(par.videoDecodeDe({ amostras: 2, motores: nv }), null);
  assert.strictEqual(par.videoDecodeDe({ amostras: 3, motores: { i: 0, n: nome("3D"), v: 5 } }), 0);
  // um pico isolado diluído nas 3 leituras (0,0,2 => 0,67%) não conta; média de 1% ou mais conta
  const pico = leituras([{ "video codec 0": 0 }, { "video codec 0": 0 }, { "video codec 0": 2 }]);
  assert.ok(par.videoDecodeDe({ amostras: 3, motores: pico }) < config.ocupado.videoDecodeAcimaDePct);
  const limiar = config.ocupado.videoDecodeAcimaDePct;
  assert.ok(limiar > 5, "o limiar tem que ficar acima do ruído de ~5% medido no PC sem vídeo tocando");
  const limite = leituras([{ "video codec 0": limiar }, { "video codec 0": limiar }, { "video codec 0": limiar }]);
  const ruido = leituras([{ "video codec 0": 5 }, { "video codec 0": 5.5 }, { "video codec 0": 4.5 }]);
  const base = { ociosoSegundos: 700, gpuOutrosPct: 1, cpuOutrosPct: 2, memoriaLivreGB: 6 };
  const bruta = (motores) => JSON.stringify({ ...base, videoAmostras: 3, videoMotores: motores });
  assert.match(decide(par.lerSaida(bruta(limite)), "noite", { alvo: 3, subiuEm: 0 }, 1e6).motivo, /vídeo tocando/);
  assert.strictEqual(decide(par.lerSaida(bruta(pico)), "noite", { alvo: 3, subiuEm: 0 }, 1e6).alvo, 3);
  assert.strictEqual(decide(par.lerSaida(bruta(ruido)), "noite", { alvo: 3, subiuEm: 0 }, 1e6).alvo, 3, "o ruído de ~5% sem vídeo não vira 'vídeo tocando' permanente");
  // coleta válida (3 amostras) sem nenhum motor de decodificação = sem vídeo: não bloqueia
  assert.strictEqual(decide(par.lerSaida(bruta([])), "noite", { alvo: 3, subiuEm: 0 }, 1e6).alvo, 3);
  // falha de coleta (nenhuma amostra) continua indisponível
  assert.match(decide(par.lerSaida(JSON.stringify({ ...base, videoAmostras: 0, videoMotores: [] })), "noite", { alvo: 3, subiuEm: 0 }, 1e6).motivo, /indisponível/);
});

test("falha de leitura NUNCA vira PC parado: null, texto, negativo, NaN, fora de faixa e campo faltando contam como em uso", () => {
  comMemoriaDoSO(6, () => {
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
    for (const quebra of [{ ociosoSegundos: null }, { gpuOutrosPct: null }, { cpuTotalPct: null }, { cpuMeuPct: null }, { nucleos: null }, { videoAmostras: 0 }, { memoriaLivreGB: null }]) {
      const leitura = par.lerSaida(JSON.stringify({ ...base, ...quebra }));
      assert.strictEqual(decide(leitura, "noite", { alvo: 3, subiuEm: 0 }, 1e6).alvo, 1, JSON.stringify(quebra));
    }
    assert.strictEqual(decide(par.lerSaida(JSON.stringify(base)), "noite", { alvo: 3, subiuEm: 0 }, 1e6).alvo, 3, "controle: saída completa e parada mantém");
  });
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
// Testes assíncronos que dependem da memória livre do SO: fixa o valor (senão a máquina com pouca RAM dá capacidade 0).
const comMemoriaAsync = async (gb, corpo) => { const original = os.freemem; os.freemem = () => gb * 1024 ** 3; try { return await corpo(); } finally { os.freemem = original; } };
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
  const chamada = chamar(comando)("x", ctl.signal);
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

// Linhas "pid,pid do pai,hora de criação" como o PowerShell as imprime
const pidsDe = (arvore) => arvore.map((e) => e.pid);

test("shell que fecha deixando um descendente sem pipe vivo: o descendente é morto e a chamada ainda termina normalmente; se não morrer, naoConfirmado", async () => {
  if (process.platform === "win32") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orfao-"));
  const marca = path.join(dir, "pid");
  const orfaoJs = path.join(dir, "orfao.js");
  fs.writeFileSync(orfaoJs, `require('fs').writeFileSync(${JSON.stringify(marca)}, String(process.pid)); setTimeout(()=>{},30000);`);
  const saida = await chamar(`"${process.execPath}" "${orfaoJs}" >/dev/null 2>&1 & sleep 1; echo pronto`)("x");
  assert.match(saida, /pronto/);
  const pid = Number(fs.readFileSync(marca, "utf8"));
  const estaVivo = () => { try { process.kill(pid, 0); } catch { return false; } try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return true; } };
  let vivo = true;
  for (let i = 0; i < 100 && vivo; i++) { vivo = estaVivo(); if (vivo) await new Promise((r) => setTimeout(r, 20)); } // o SIGKILL leva um instante para valer
  assert.strictEqual(vivo, false, "o descendente sem pipe foi morto ao fechar o shell");
  // descendente que não morre: naoConfirmado
  const chamada = chamar(`echo oi`, { orfaos: () => [4242] })("x");
  await assert.rejects(chamada, (erro) => erro.naoConfirmado === true && /continuam vivos/.test(erro.message));
});

test("naoConfirmado: o comando larga o processo e fecha os pipes, então o Node consegue terminar (não fica pendurado)", async () => {
  const { spawnSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "largar-"));
  const script = path.join(dir, "s.js");
  fs.writeFileSync(script, `
    const escada = require(${JSON.stringify(path.join(__dirname, "..", "orquestra", "escada.js"))});
    const ctl = new AbortController();
    const comando = '"' + process.execPath + '" -e "setTimeout(()=>{},20000)"';
    let pidPreso;
    const lancar = (c, fd) => require("node:child_process").spawn(c, { shell: true, stdio: [fd, "pipe", "pipe"], detached: true });
    escada.chamarComando(comando, { lancar, orfaos: () => [], matar: (f) => { pidPreso = f.pid; return false; }, reintentoMs: 10, tentativasDeMatar: 2 })("x", ctl.signal)
      .catch((e) => console.log(e.naoConfirmado ? "naoConfirmado " + pidPreso : "outro"));
    setTimeout(() => ctl.abort(), 100);
  `);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 15000 });
  assert.match(r.stdout.trim(), /^naoConfirmado \d+$/);
  assert.ok(Date.now() - t0 < 10000, `o Node terminou sozinho (${Date.now() - t0} ms)`);
  matarGrupo(Number(r.stdout.trim().split(" ")[1]));
});

test("o tempo máximo mata a árvore pelo mesmo caminho (matar), não só o shell", async () => {
  let mortes = 0;
  const comando = `"${process.execPath}" -e "setTimeout(()=>{},30000)"`;
  const chamada = chamar(comando, { tempoMaximoMs: 200, matar: (f) => { mortes += 1; if (process.platform !== "win32") { matarGrupo(f.pid); return true; } return matarReal(f); } })("x");
  await assert.rejects(chamada, /tempo máximo/);
  assert.strictEqual(mortes, 1);
});

test("durante a conferência da resposta (depois que o modelo local terminou) a microtarefa não ocupa vaga: outra começa no local", async () => {
  const eventos = [];
  const local = (prompt) => { eventos.push(`local ${prompt.includes("contexto de a") ? "a" : "b"}`); return "ok"; };
  const verificadorDe = (m) => async (saida) => { if (m.id === "a") { eventos.push("conferindo a"); await new Promise((r) => setTimeout(r, 200)); eventos.push("a conferida"); } return { ok: saida === "ok" }; };
  const r = await escada.lote({ microtarefas: ["a", "b"].map(microDe), verificadorDe, paralelismo: 1, arquivos: arquivosTemp(), agentes: { local, superiores: [] } });
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  assert.ok(eventos.indexOf("local b") < eventos.indexOf("a conferida"), eventos.join(" | "));
});

test("estado salvo de uma execução antiga expira: um lote novo não herda o alvo antigo", () => {
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "par-")), "estado.json");
  fs.writeFileSync(arq, JSON.stringify({ alvo: 3, subiuEm: 0, gravadoEm: 0 }));
  const agora = 10 * 3600 * 1000;
  const controle = par.criarControle({ leitor: { ler: () => RECEM_PARADO }, modo: "noite", arquivoEstado: arq, relogio: () => agora, modos, config });
  assert.strictEqual(controle(), 1, "estado de 10 h atrás é ignorado");
  controle.liberar(); // o lote acabou: devolve a vaga reservada (senão o lote seguinte dividiria o teto com ele)
  // com a leitura "recém parado" e SEM estado, a subida inicial dá 1; com estado recente do mesmo modo o 3 só pode vir do estado
  fs.writeFileSync(arq, JSON.stringify({ alvo: 3, subiuEm: agora - 1000, gravadoEm: agora - 1000, modo: "noite" }));
  const recente = par.criarControle({ leitor: { ler: () => RECEM_PARADO }, modo: "noite", arquivoEstado: arq, relogio: () => agora, modos, config });
  assert.strictEqual(recente(), 3, "estado recente (do mesmo modo) vale: prova a reutilização, não a subida inicial");
  recente.liberar();
  fs.writeFileSync(arq, JSON.stringify({ alvo: 3, subiuEm: agora, modo: "noite" }));
  assert.strictEqual(par.criarControle({ leitor: { ler: () => RECEM_PARADO }, modo: "noite", arquivoEstado: arq, relogio: () => agora, modos, config })(), 1, "sem data de gravação: ignorado");
});

test("quem subiu para o Codex/Claude não ocupa vaga de agente local: com limite 1, outra microtarefa começa no local enquanto a primeira espera o Codex", async () => {
  const eventos = [];
  const local = (prompt) => {
    const id = prompt.includes("contexto de a") ? "a" : "b";
    eventos.push(`local ${id}`);
    return id === "a" ? "ruim" : "ok";
  };
  const codex = () => new Promise((ok) => { eventos.push("codex começa"); setTimeout(() => { eventos.push("codex termina"); ok("ok"); }, 150); });
  const r = await escada.lote({
    microtarefas: ["a", "b"].map(microDe), verificadorDe: verificadorOk, paralelismo: 1, arquivos: arquivosTemp(),
    agentes: { local, superiores: [{ nome: "codex", chamar: codex }] },
  });
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  assert.ok(eventos.indexOf("local b") < eventos.indexOf("codex termina"), eventos.join(" | "));
});

test("abortar mata também o processo descendente (neto), em qualquer sistema", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neto-"));
  const marca = path.join(dir, "pid");
  const netoJs = path.join(dir, "neto.js");
  const paiJs = path.join(dir, "pai.js");
  fs.writeFileSync(netoJs, `require('fs').writeFileSync(${JSON.stringify(marca)}, String(process.pid)); setTimeout(()=>{},30000);`);
  fs.writeFileSync(paiJs, `require('child_process').spawn(process.execPath, [${JSON.stringify(netoJs)}], { stdio: 'inherit' }); setTimeout(()=>{},30000);`);
  const ctl = new AbortController();
  const chamada = chamar(`"${process.execPath}" "${paiJs}"`)("x", ctl.signal);
  for (let i = 0; i < 150 && !fs.existsSync(marca); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fs.existsSync(marca), "o neto começou");
  await new Promise((r) => setTimeout(r, 50));
  const pid = Number(fs.readFileSync(marca, "utf8"));
  const inicio = Date.now();
  ctl.abort();
  await assert.rejects(chamada);
  assert.ok(Date.now() - inicio < 5000, "a chamada terminou logo, sem esperar o neto acabar sozinho (30 s)");
  // zumbi (morto que o init ainda não recolheu) conta como morto
  const estaVivo = () => { try { process.kill(pid, 0); } catch { return false; } try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return true; } };
  let vivo = true;
  for (let i = 0; i < 50 && vivo; i++) { vivo = estaVivo(); if (vivo) await new Promise((r) => setTimeout(r, 20)); }
  assert.strictEqual(vivo, false, "o processo descendente morreu");
});

test("se não dá para confirmar a morte do processo (taskkill falhando), a chamada termina com naoConfirmado e o lote inteiro para com erro claro", async () => {
  const ctl = new AbortController();
  const comando = `"${process.execPath}" -e "setTimeout(()=>{},30000)"`;
  let preso;
  const chamada = chamar(comando, { matar: (f) => { preso = f; return false; }, reintentoMs: 10, tentativasDeMatar: 3 })("x", ctl.signal);
  setTimeout(() => ctl.abort(), 100);
  await assert.rejects(chamada, (erro) => erro.naoConfirmado === true && /não morreu/.test(erro.message));
  matarGrupo(preso.pid);

  // No lote: quando um processo abortado não dá para confirmar que morreu, o lote INTEIRO para com erro claro
  // (nada de bloquear vaga na memória: um lote novo não herdaria o bloqueio).
  let limite = 2;
  const abortados = [];
  const local = (prompt, signal) => new Promise((ok, no) => {
    const id = prompt.includes("contexto de a") ? "a" : prompt.includes("contexto de b") ? "b" : "c";
    signal.addEventListener("abort", () => {
      abortados.push(id);
      if (id === "b") setTimeout(() => no(Object.assign(new Error("não morreu"), { naoConfirmado: true })), 20);
      else setTimeout(() => no(new Error("abortado")), 30); // os outros morrem e o lote espera essa confirmação
    });
    if (id === "c") setTimeout(() => ok("ok"), 10);
  });
  setTimeout(() => { limite = 1; }, 50);
  await assert.rejects(
    escada.lote({ microtarefas: ["a", "b", "c"].map(microDe), verificadorDe: verificadorOk, paralelismo: () => limite, reavaliarMs: 10, arquivos: arquivosTemp(), agentes: { local, superiores: [] } }),
    /o lote parou.*"b"/,
  );
  assert.ok(abortados.includes("a"), "os outros agentes locais também são interrompidos");
});

test("voltando do Codex para o local, a microtarefa espera haver vaga dentro do limite (não fura o limite)", async () => {
  let vivos = 0;
  let pico = 0;
  const chamadas = { a: 0, b: 0 };
  const local = (prompt) => {
    const id = prompt.includes("contexto de a") ? "a" : "b";
    chamadas[id] += 1;
    vivos += 1;
    pico = Math.max(pico, vivos);
    return new Promise((ok) => setTimeout(() => { vivos -= 1; ok(id === "a" && chamadas.a === 1 ? "ruim" : "ok"); }, id === "b" ? 200 : 10));
  };
  // a: local ruim -> Codex (dica) -> volta ao local; enquanto isso b ocupa a única vaga
  const codex = () => "dica";
  const r = await escada.lote({
    microtarefas: ["a", "b"].map(microDe), verificadorDe: verificadorOk, paralelismo: 1, maxTentativas: 2, arquivos: arquivosTemp(),
    agentes: { local, superiores: [{ nome: "codex", chamar: codex }] },
  });
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  assert.strictEqual(pico, 1, "nunca mais de 1 agente local ao mesmo tempo");
});

test("a memória livre que o controle recebe já vem reduzida pelos agentes que rodam: o teto soma de volta a parte deles (sem aborto em loop)", () => {
  // 5 GB livres, mínimo 2: sem agentes cabem 6 (0,5 GB cada); com 3 rodando a memória livre cai 1,5 GB (3,5) e o teto continua o mesmo
  const sem = par.capacidade({ modo: "noite", memoriaLivreGB: 5, modos: { noite: { ...modos.noite, agentesMax: 99, contexto: 1024 } }, config: { ...config, maximoAbsoluto: 99 }, memoriaMinimaGB: 2 });
  const com = par.capacidade({ modo: "noite", memoriaLivreGB: 3.5, agentesAtuais: 3, modos: { noite: { ...modos.noite, agentesMax: 99, contexto: 1024 } }, config: { ...config, maximoAbsoluto: 99 }, memoriaMinimaGB: 2 });
  assert.strictEqual(sem.limites.memoria, 6);
  assert.strictEqual(com.limites.memoria, 6);
  // sem a correção o teto cairia para 3 com 3 rodando: o lote abortaria um e o liberaria memória, reabrindo a vaga em loop
  assert.strictEqual(par.capacidade({ modo: "noite", memoriaLivreGB: 3.5, modos: { noite: { ...modos.noite, agentesMax: 99, contexto: 1024 } }, config: { ...config, maximoAbsoluto: 99 }, memoriaMinimaGB: 2 }).limites.memoria, 3);
  const vistos = [];
  const controle = par.criarControle({ leitor: { ler: () => ({ ...PARADO, memoriaLivreGB: 3.5 }) }, modo: "noite", arquivoEstado: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "par-")), "e.json"), relogio: () => 0, modos, config, aoDecidir: (d) => vistos.push(d.capacidade.limites.memoria) });
  controle({ agentesLocais: 3 });
  assert.ok(vistos[0] >= 6, `o controle passa os agentes atuais (${vistos[0]})`);
});

test("o prompt chega ao comando por arquivo (stdin sem pipe) e o arquivo temporário é apagado", async () => {
  const antes = (fs.existsSync(path.join(os.tmpdir(), "mixai-prompts")) ? fs.readdirSync(path.join(os.tmpdir(), "mixai-prompts")) : []).filter((f) => f.startsWith("prompt-")).length;
  const saida = await chamar(`"${process.execPath}" -e "process.stdin.pipe(process.stdout)"`)("olá, prompt com acentuação ç ã");
  assert.strictEqual(saida, "olá, prompt com acentuação ç ã");
  assert.strictEqual(fs.readdirSync(path.join(os.tmpdir(), "mixai-prompts")).filter((f) => f.startsWith("prompt-")).length, antes);
});

test("morte não confirmada no tempo máximo também para o lote (não vira erro comum que sobe para o Codex)", async () => {
  let codex = 0;
  let preso;
  const local = () => chamar(`"${process.execPath}" -e "setTimeout(()=>{},30000)"`, { tempoMaximoMs: 100, matar: (f) => { preso = f; return false; }, reintentoMs: 10, tentativasDeMatar: 2 })("x");
  await assert.rejects(
    escada.lote({ microtarefas: [microDe("a")], verificadorDe: verificadorOk, paralelismo: 1, reavaliarMs: 10, arquivos: arquivosTemp(), agentes: { local, superiores: [{ nome: "codex", chamar: () => { codex += 1; return "ok"; } }] } }),
    /o lote parou.*"a"/,
  );
  assert.strictEqual(codex, 0, "não subiu para o Codex");
  matarGrupo(preso.pid);
});

test("no erro fatal o lote ESPERA a morte confirmada dos outros agentes antes de lançar o erro, e lista os que não foram confirmados", async () => {
  const mortes = [];
  const local = (prompt, signal) => new Promise((ok, no) => {
    const id = prompt.includes("contexto de a") ? "a" : prompt.includes("contexto de b") ? "b" : "c";
    signal.addEventListener("abort", () => {
      if (id === "b") setTimeout(() => no(Object.assign(new Error("não morreu"), { naoConfirmado: true })), 10);
      else if (id === "a") setTimeout(() => { mortes.push("a"); no(new Error("abortado")); }, 150); // demora a morrer
      else setTimeout(() => { mortes.push("c"); no(Object.assign(new Error("também não"), { naoConfirmado: true })); }, 80);
    });
  });
  setTimeout(() => {}, 0);
  let limite = 3;
  setTimeout(() => { limite = 1; }, 40);
  let erro;
  try {
    await escada.lote({ microtarefas: ["a", "b", "c"].map(microDe), verificadorDe: verificadorOk, paralelismo: () => limite, reavaliarMs: 10, arquivos: arquivosTemp(), agentes: { local, superiores: [] } });
  } catch (e) { erro = e; }
  assert.ok(erro, "o lote falhou");
  assert.deepStrictEqual(mortes.sort(), ["a", "c"], "quando o erro chegou, os outros já tinham terminado de morrer");
  assert.match(erro.message, /o lote parou/);
  assert.match(erro.message, /Também não foi confirmada a morte de: c/);
});

test("no erro fatal, agentes que não terminaram depois do prazo entram na lista de mortes não confirmadas", async () => {
  const local = (prompt, signal) => new Promise((ok, no) => {
    const id = prompt.includes("contexto de a") ? "a" : "b";
    signal.addEventListener("abort", () => {
      if (id === "b") setTimeout(() => no(Object.assign(new Error("não morreu"), { naoConfirmado: true })), 10);
      // "a" nunca responde ao aborto
    });
  });
  let limite = 2;
  setTimeout(() => { limite = 1; }, 30);
  let erro;
  try {
    await escada.lote({ microtarefas: ["a", "b"].map(microDe), verificadorDe: verificadorOk, paralelismo: () => limite, reavaliarMs: 10, tempoParaConfirmarMs: 150, arquivos: arquivosTemp(), agentes: { local, superiores: [] } });
  } catch (e) { erro = e; }
  assert.match(erro.message, /o lote parou/);
  assert.match(erro.message, /Também não foi confirmada a morte de: a/);
});

test("aborto e tempo máximo ao mesmo tempo usam UMA rotina de parada: um só temporizador, termina com naoConfirmado e sem segurar o Node", async () => {
  const ctl = new AbortController();
  let chamadas = 0;
  setTimeout(() => ctl.abort(), 20);
  const t0 = Date.now();
  await assert.rejects(
    chamar(`"${process.execPath}" -e "setTimeout(()=>{},30000)"`, {
      matar: () => { chamadas++; return false; }, orfaos: () => [], reintentoMs: 20, tentativasDeMatar: 3, tempoMaximoMs: 90,
    })("x", ctl.signal),
    (erro) => erro.naoConfirmado === true,
  );
  assert.ok(chamadas <= 3, `a parada repetiu demais (${chamadas} chamadas): havia duas rotinas`);
  assert.ok(Date.now() - t0 < 2000);
});


// --- Windows: o comando roda dentro de um Job Object (orquestra/job-windows.ps1) -----------------------------------
const WRAPPER = path.join(RAIZ, "orquestra", "job-windows.ps1");

test("o wrapper do Job Object: KILL_ON_JOB_CLOSE sem escape, entra no job ANTES de iniciar o comando e não roda o comando se o job falhar", () => {
  const ps = fs.readFileSync(WRAPPER, "utf8");
  assert.match(ps, /LimitFlags = 0x2000/, "KILL_ON_JOB_CLOSE");
  assert.deepStrictEqual([...ps.matchAll(/LimitFlags = (0x[0-9a-f]+)/g)].map((m) => m[1]), ["0x2000"], "nenhuma outra flag: sem permissão de escapar do job");
  assert.match(ps, /AssignProcessToJobObject\(job, GetCurrentProcess\(\)\)/, "o próprio wrapper entra no job");
  const entrou = ps.search(/\[MixJob\]::Entrar\(\$env:MIXAI_JOB\)/);
  const iniciou = ps.search(/\[System\.Diagnostics\.Process\]::Start/);
  assert.ok(entrou >= 0 && iniciou >= 0, "as duas chamadas existem no wrapper (indexOf -1 não pode passar)");
  assert.ok(entrou < iniciou, "entra no job antes de criar o comando");
  assert.match(ps, /CreateJobObject\(IntPtr\.Zero, nome\)/, "alça do job sem atributos de herança: o comando não herda a alça");
  assert.match(ps, /exit 125/, "falha ao criar o job: sai sem rodar o comando");
  assert.match(ps, /\$env:MIXAI_COMANDO/);
  assert.match(ps, /UseShellExecute = \$false/, "o comando herda stdin/stdout/stderr");
  assert.match(ps, /exit \$processo\.ExitCode/);
});

test("matarArvore no Windows mata pela alça do Node (sem ler PID): aceito = true, recusado = false", () => {
  const chamadas = [];
  const filho = { exitCode: null, kill: (sinal) => { chamadas.push(sinal); return true; } };
  assert.strictEqual(escada.matarArvore(filho, { plataforma: "win32" }), true);
  assert.deepStrictEqual(chamadas, ["SIGKILL"]);
  assert.strictEqual(escada.matarArvore({ exitCode: null, kill: () => false }, { plataforma: "win32" }), false);
  assert.strictEqual(escada.matarArvore({ exitCode: 0, kill: () => false }, { plataforma: "win32" }), true, "já tinha terminado");
  assert.strictEqual(escada.matarArvore({ exitCode: null, kill: () => { throw new Error("x"); } }, { plataforma: "win32" }), false);
});

test("chamarComando (Windows simulado): aborta, termina logo, e a conferência vai ao Job Object (por nome), não a uma leitura de árvore por PID", async () => {
  const { spawn } = require("node:child_process");
  const lancados = [];
  // sem shell: no Windows de verdade, matar o cmd.exe não mataria o node dentro dele (quem cuida disso é o Job Object, que este teste não usa)
  const lancar = (comando, fd) => { lancados.push(comando); return spawn(process.execPath, ["-e", comando], { stdio: [fd, "pipe", "pipe"] }); };
  const consultas = [];
  const executar = (cmd, args, opcoes, cb) => { consultas.push([cmd, args]); cb(null, "FECHADO\n"); };
  const orfaos = (f) => escada.orfaosVivos(f, { plataforma: "win32", executar });
  const matar = (f) => escada.matarArvore(f, { plataforma: "win32" });
  const ctl = new AbortController();
  const inicio = Date.now();
  const chamada = chamar("setTimeout(()=>{},30000)", { plataforma: "win32", lancar, matar, orfaos })("x", ctl.signal);
  setTimeout(() => ctl.abort(), 100);
  await assert.rejects(chamada);
  assert.ok(Date.now() - inicio < 5000);
  assert.strictEqual(lancados.length, 1);
  assert.strictEqual(consultas.length, 1, "uma só conferência, no Job Object");
  assert.strictEqual(consultas[0][0], "powershell");
  assert.ok(consultas[0][1].some((x) => /job-confirmar-windows\.ps1$/.test(x)), "usa o script de conferência do job");
  assert.match(consultas[0][1].at(-1), /^Local\\MixAI-[0-9a-f]{24}$/, "pelo nome do job desta chamada");
  // comando normal termina com a conferência do job, e o job com processo sobrando não é "limpo"
  assert.strictEqual(await chamar("process.stdout.write('ok')", { plataforma: "win32", lancar, orfaos })("x"), "ok");
  const vivos = (cmd, args, opcoes, cb) => cb(null, "VIVOS 2\n");
  await assert.rejects(chamar("process.stdout.write('ok')", { plataforma: "win32", lancar, orfaos: (f) => escada.orfaosVivos(f, { plataforma: "win32", executar: vivos }) })("x"), (erro) => erro.naoConfirmado === true && /2 descendente/.test(erro.message));
  for (const resposta of ["lixo\n", ""]) await assert.rejects(chamar("process.stdout.write('ok')", { plataforma: "win32", lancar, orfaos: (f) => escada.orfaosVivos(f, { plataforma: "win32", executar: (c, a, o, cb) => cb(null, resposta) }) })("x"), (erro) => erro.naoConfirmado === true, "resposta que não é FECHADO/VAZIO/VIVOS é inconclusiva");
  await assert.rejects(chamar("process.stdout.write('ok')", { plataforma: "win32", lancar, orfaos: (f) => escada.orfaosVivos(f, { plataforma: "win32", executar: (c, a, o, cb) => cb(new Error("PowerShell bloqueado")) }) })("x"), (erro) => erro.naoConfirmado === true);
  assert.strictEqual(await escada.confirmarJob("Local\\MixAI-x", (c, a, o, cb) => cb(null, "VAZIO\n")).then((r) => r.length), 0);
});

test("Windows de verdade: abortar mata o neto (o comando roda dentro do Job Object); em outros sistemas este teste não se aplica", async () => {
  if (process.platform !== "win32") return; // só no Windows existe o wrapper; no PC do dono ele roda de verdade
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-"));
  const marca = path.join(dir, "pid");
  const netoJs = path.join(dir, "neto.js");
  const paiJs = path.join(dir, "pai.js");
  fs.writeFileSync(netoJs, `require('fs').writeFileSync(${JSON.stringify(marca)}, String(process.pid)); setTimeout(()=>{},60000);`);
  // o pai cria o neto e SAI: o neto fica órfão, fora de qualquer foto de árvore
  fs.writeFileSync(paiJs, `require('child_process').spawn(process.execPath, [${JSON.stringify(netoJs)}], { stdio: 'ignore', detached: true }).unref(); setTimeout(()=>{},60000);`);
  const ctl = new AbortController();
  const chamada = chamar(`"${process.execPath}" "${paiJs}"`)("x", ctl.signal);
  for (let i = 0; i < 400 && !fs.existsSync(marca); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(marca), "o neto começou");
  const pid = Number(fs.readFileSync(marca, "utf8"));
  ctl.abort();
  await assert.rejects(chamada);
  let vivo = true;
  for (let i = 0; i < 100 && vivo; i++) { try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { vivo = false; } }
  assert.strictEqual(vivo, false, "o neto morreu junto com o job");
});

test("Windows de verdade: o pai SAI deixando o neto desacoplado vivo, e a conferência do job mata o neto (chamada termina normalmente)", async () => {
  if (process.platform !== "win32") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-pai-sai-"));
  const marca = path.join(dir, "pid");
  const netoJs = path.join(dir, "neto.js");
  const paiJs = path.join(dir, "pai.js");
  fs.writeFileSync(netoJs, `require('fs').writeFileSync(${JSON.stringify(marca)}, String(process.pid)); setTimeout(()=>{},60000);`);
  fs.writeFileSync(paiJs, `require('child_process').spawn(process.execPath, [${JSON.stringify(netoJs)}], { stdio: 'ignore', detached: true }).unref(); setTimeout(()=>process.exit(0), 600);`);
  const resposta = await chamar(`"${process.execPath}" "${paiJs}"`)("x");
  assert.strictEqual(resposta, "");
  assert.ok(fs.existsSync(marca), "o neto chegou a nascer");
  const pid = Number(fs.readFileSync(marca, "utf8"));
  let vivo = true;
  for (let i = 0; i < 100 && vivo; i++) { try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { vivo = false; } }
  assert.strictEqual(vivo, false, "o neto desacoplado morreu mesmo com o pai já fora");
});

// --- Contrato de parada: prazo do 'close', saída sem fim, erro depois do spawn, erro do controlador ------------------
test("pedido de parada aceito mas a chamada não termina (descendente desconhecido segurando o stdout): naoConfirmado depois do prazo, sem ficar pendurado", async () => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 30);
  const t0 = Date.now();
  let filhoCriado;
  await assert.rejects(
    chamar(`"${process.execPath}" -e "setTimeout(()=>{},30000)"`, { matar: (f) => { filhoCriado = f; return true; }, orfaos: () => [], prazoDeFechamentoMs: 150, reintentoMs: 40 })("x", ctl.signal),
    (erro) => erro.naoConfirmado === true && /não terminou em/.test(erro.message),
  );
  assert.ok(Date.now() - t0 < 3000);
  matarGrupo(filhoCriado.pid);
});

test("saída sem fim: passado o limite de bytes a árvore é parada e a chamada falha com mensagem clara (sem esgotar a memória)", async () => {
  const t0 = Date.now();
  await assert.rejects(
    chamar(`"${process.execPath}" -e "setInterval(()=>process.stdout.write('x'.repeat(500)),2)"`, { maxSaidaBytes: 2000 })("x"),
    (erro) => /saída passou de 2000 bytes/.test(erro.message),
  );
  assert.ok(Date.now() - t0 < 5000);
});

test("erro do processo depois de ele nascer: para, ESPERA o close e confere; sem close vira naoConfirmado, com close vira o erro normal", async () => {
  const { EventEmitter } = require("node:events");
  const falso = (fechaAoMatar) => {
    const f = new EventEmitter();
    f.pid = 4242; f.exitCode = null; f.stdout = new EventEmitter(); f.stderr = new EventEmitter();
    f.stdout.destroy = f.stderr.destroy = () => {}; f.unref = () => {};
    f.kill = () => { if (fechaAoMatar) setImmediate(() => f.emit("close", null)); return true; };
    return f;
  };
  const rodar = (fechaAoMatar) => {
    const f = falso(fechaAoMatar);
    const chamada = chamar("x", { lancar: () => f, matar: (x) => x.kill(), orfaos: () => [], reintentoMs: 10, prazoDeFechamentoMs: 60 })("p");
    setTimeout(() => f.emit("error", new Error("EPIPE")), 10);
    return chamada;
  };
  await assert.rejects(rodar(false), (erro) => erro.naoConfirmado === true && /não terminou em/.test(erro.message), "sem close: não rejeita como erro comum");
  await assert.rejects(rodar(true), (erro) => !erro.naoConfirmado && /EPIPE/.test(erro.message));
});

test("erro do controlador de paralelismo com agentes já rodando: o lote aborta os agentes, espera a morte e rejeita com o erro (não fica pendurado)", async () => {
  let iniciou = false;
  let abortado = false;
  const local = (prompt, signal) => new Promise((ok, no) => {
    iniciou = true;
    signal.addEventListener("abort", () => { abortado = true; no(new Error("abortado")); });
  });
  const inicio = Date.now();
  await assert.rejects(
    escada.lote({
      microtarefas: [microDe("a")], verificadorDe: verificadorOk, reavaliarMs: 10, arquivos: arquivosTemp(),
      paralelismo: () => { if (iniciou) throw new Error("leitura do PC quebrou"); return 1; },
      agentes: { local, superiores: [] },
    }),
    /leitura do PC quebrou/,
  );
  assert.strictEqual(abortado, true, "o agente que já rodava foi abortado");
  assert.ok(Date.now() - inicio < 5000);
});

test("morte NÃO confirmada de um agente tirado do local para o lote (a vaga não é reaproveitada) e o fim da chamada não conta como morte", async () => {
  let limite = 2;
  let ctlB;
  const local = (prompt, signal) => new Promise((ok, no) => {
    if (prompt.includes("contexto de b")) signal.addEventListener("abort", () => no(Object.assign(new Error("não morreu"), { naoConfirmado: true })));
    else setTimeout(() => ok("ok"), 400);
  });
  setTimeout(() => { limite = 1; }, 30);
  await assert.rejects(
    escada.lote({
      microtarefas: ["a", "b"].map(microDe), verificadorDe: verificadorOk, reavaliarMs: 10, arquivos: arquivosTemp(),
      paralelismo: () => limite, agentes: { local, superiores: [] },
    }),
    /o lote parou: não consegui confirmar/,
  );
});

test("o script de conferência do job: abre pelo nome, encerra o job e só dá por limpo com job inexistente ou vazio", () => {
  const ps = fs.readFileSync(path.join(RAIZ, "orquestra", "job-confirmar-windows.ps1"), "utf8");
  assert.match(ps, /OpenJobObject\(0x0004 \| 0x0008, false, nome\)/, "QUERY | TERMINATE, sem herança");
  assert.match(ps, /erro == 2\) return "FECHADO"/);
  assert.match(ps, /TerminateJobObject/);
  assert.match(ps, /"VIVOS " \+ ativos/);
  assert.match(ps, /exit 2/, "falha de consulta é inconclusiva");
});

test("um só orçamento de BYTES para stdout e stderr juntos (cada um abaixo do limite, os dois juntos acima)", async () => {
  await assert.rejects(
    chamar(`"${process.execPath}" -e "process.stdout.write('a'.repeat(600));process.stderr.write('é'.repeat(300));setTimeout(()=>{},20000)"`, { maxSaidaBytes: 1000 })("x"),
    (erro) => /saída passou de 1000 bytes/.test(erro.message),
  );
});

test("chamada abortada nunca vira sucesso, mesmo que o processo já tenha saído com código 0", async () => {
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(
    chamar(`"${process.execPath}" -e "process.stdout.write('ok')"`, { matar: () => true, orfaos: () => [] })("x", ctl.signal),
    (erro) => erro.abortada === true,
  );
});

test("a parada continua tentando depois de o pedido ser aceito, até o prazo final (e não para na primeira aceitação)", async () => {
  let pedidos = 0;
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 20);
  let filhoCriado;
  await assert.rejects(
    chamar(`"${process.execPath}" -e "setTimeout(()=>{},30000)"`, { matar: (f) => { filhoCriado = f; pedidos += 1; return true; }, orfaos: () => [], reintentoMs: 20, prazoDeFechamentoMs: 120 })("x", ctl.signal),
    (erro) => erro.naoConfirmado === true,
  );
  assert.ok(pedidos >= 3, `o pedido foi repetido (${pedidos} vezes)`);
  matarGrupo(filhoCriado.pid);
});

test("erro fatal do lote cancela também a chamada em andamento a um superior (Codex/Claude): ela recebe o sinal e o lote espera ela terminar", async () => {
  let sinalDoSuperior = null;
  let superiorTerminou = false;
  const local = (prompt, signal) => new Promise((ok, no) => {
    if (prompt.includes("contexto de b")) signal.addEventListener("abort", () => no(Object.assign(new Error("não morreu"), { naoConfirmado: true })));
    else no(new Error("o local errou")); // a vai para o superior
  });
  const superior = { nome: "codex", chamar: (prompt, signal) => new Promise((ok, no) => {
    sinalDoSuperior = signal;
    signal.addEventListener("abort", () => setTimeout(() => { superiorTerminou = true; no(new Error("cancelado")); }, 30));
  }) };
  let limite = 2;
  setTimeout(() => { limite = 0; }, 60); // a está no superior (não ocupa vaga local); b é tirada do local e não morre
  await assert.rejects(
    escada.lote({ microtarefas: ["a", "b"].map(microDe), verificadorDe: verificadorOk, reavaliarMs: 10, arquivos: arquivosTemp(), paralelismo: () => limite, agentes: { local, superiores: [superior] } }),
    /o lote parou/,
  );
  assert.ok(sinalDoSuperior && sinalDoSuperior.aborted, "o superior foi abortado");
  assert.strictEqual(superiorTerminou, true, "o lote esperou a chamada ao superior terminar antes de lançar o erro");
});

test("o controle de paralelismo com leitor assíncrono não bloqueia: sem leitura pronta vale 1 (indisponível); com leitura pronta usa o PC parado; leitura velha demais vale 1", () => comMemoriaAsync(6, async () => {
  let agora = 1e6;
  let leituras = 0;
  const leitor = { lerAsync: async () => { leituras += 1; return { ...PARADO, ociosoSegundos: 900 }; }, ler: () => { throw new Error("o controle não pode usar a leitura que bloqueia"); } };
  const controle = par.criarControle({ leitor, modo: "noite", arquivoEstado: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ctl-")), "e.json"), relogio: () => agora, cacheMs: 1000, modos, config });
  assert.strictEqual(controle({ agentesLocais: 0 }), 1, "primeira vez: ainda sem leitura = indisponível");
  await new Promise((r) => setImmediate(r));
  agora += 1500;
  assert.ok(controle({ agentesLocais: 0 }) >= 1);
  await new Promise((r) => setImmediate(r));
  assert.ok(leituras >= 2, "a leitura roda em segundo plano a cada decisão nova");
  // leitura que ficou velha (mais de 4 x o cache) não vale
  const lento = { lerAsync: () => new Promise(() => {}) };
  const c2 = par.criarControle({ leitor: lento, modo: "noite", arquivoEstado: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ctl-")), "e.json"), relogio: () => agora, cacheMs: 1000, modos, config });
  assert.strictEqual(c2({ agentesLocais: 0 }), 1);
  agora += 10000;
  assert.strictEqual(c2({ agentesLocais: 0 }), 1);
}));

// --- Verificação como processo; só Windows ------------------------------------------------------------------------
test("fora do Windows (sem lançador injetado) chamarComando recusa com erro explícito e não executa nada", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recusa-"));
  const marca = path.join(dir, "rodou");
  const comando = `"${process.execPath}" -e "require('fs').writeFileSync(${JSON.stringify(marca).replace(/"/g, '\\"')}, 'x')"`;
  for (const plataforma of ["linux", "darwin"]) {
    await assert.rejects(escada.chamarComando(comando, { plataforma })("x"), /plataforma sem contenção garantida/);
  }
  assert.strictEqual(fs.existsSync(marca), false, "nada foi executado");
});

test("verificadorPorComando: processo de verdade (assíncrono, abortável): código 0 = ok, outro = não ok com o motivo, morte não confirmada sobe como erro", async () => {
  const ok = escada.verificadorPorComando(`"${process.execPath}" -e "process.exit(0)"`, semente());
  assert.deepStrictEqual(await ok("x"), { ok: true, motivo: "" });
  const ruim = escada.verificadorPorComando(`"${process.execPath}" -e "console.error('faltou X'); process.exit(3)"`, semente());
  const r = await ruim("x");
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /faltou X/);
  const preso = escada.verificadorPorComando(`"${process.execPath}" -e "setTimeout(()=>{},30000)"`, { ...semente(), matar: rastrear(() => false), orfaos: () => [], reintentoMs: 10, tentativasDeMatar: 2 });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(preso("x", ctl.signal), (erro) => erro.naoConfirmado === true);
});

test("naoConfirmado do comando de VERIFICAÇÃO para o lote com mensagem clara (não vira resposta errada da microtarefa)", async () => {
  const verificadorDe = () => async () => { throw Object.assign(new Error("verificador não morreu"), { naoConfirmado: true }); };
  await assert.rejects(
    escada.lote({ microtarefas: [microDe("a")], verificadorDe, arquivos: arquivosTemp(), agentes: { local: () => "ok", superiores: [{ nome: "codex", chamar: () => "ok" }] } }),
    /comando de verificação da microtarefa "a" morreu/,
  );
});

test("erro fatal do lote cancela também a verificação em andamento e espera ela terminar", async () => {
  let sinalDaVerificacao = null;
  let verificacaoTerminou = false;
  const local = (prompt, signal) => new Promise((ok, no) => {
    if (prompt.includes("contexto de b")) signal.addEventListener("abort", () => no(Object.assign(new Error("não morreu"), { naoConfirmado: true })));
    else ok("ok"); // a responde e vai para a verificação, que demora
  });
  const verificadorDe = (m) => (saida, signal) => new Promise((ok, no) => {
    if (m.id !== "a") return ok({ ok: true });
    sinalDaVerificacao = signal;
    signal.addEventListener("abort", () => setTimeout(() => { verificacaoTerminou = true; no(Object.assign(new Error("abortada"), { abortada: true })); }, 30));
  });
  let limite = 2;
  setTimeout(() => { limite = 0; }, 60);
  await assert.rejects(
    escada.lote({ microtarefas: ["a", "b"].map(microDe), verificadorDe, reavaliarMs: 10, arquivos: arquivosTemp(), paralelismo: () => limite, agentes: { local, superiores: [] } }),
    /o lote parou/,
  );
  assert.ok(sinalDaVerificacao && sinalDaVerificacao.aborted, "a verificação recebeu o aborto");
  assert.strictEqual(verificacaoTerminou, true, "o lote esperou a verificação terminar");
});

// --- Pontos do Codex no #19 (rodada final) -------------------------------------------------------------------------
test("superior (Codex/Claude) que devolve naoConfirmado torna o lote FATAL, não falha comum", async () => {
  const verificadorDe = () => async () => ({ ok: false, motivo: "errado" }); // o local não passa: sobe para o superior
  const superior = { nome: "codex", chamar: async () => { throw Object.assign(new Error("não morreu"), { naoConfirmado: true }); } };
  await assert.rejects(
    escada.lote({ microtarefas: [microDe("a")], verificadorDe, arquivos: arquivosTemp(), agentes: { local: () => "ok", superiores: [superior] } }),
    /o lote parou: não consegui confirmar que o processo do superior "codex" da microtarefa "a" morreu/,
  );
});

test("o uso-windows.ps1 dá null (não 0) para placa sem motor no formato pid_, e só conta como 'meu' o Ollama registrado pelo MixAI", () => {
  const uso = fs.readFileSync(path.join(RAIZ, "local", "uso-windows.ps1"), "utf8");
  assert.match(uso, /\$amostrasComPid/);
  assert.doesNotMatch(uso, /\$meus = @\(/, "nada de contar 'meu' pelo nome do processo");
  assert.match(uso, /mixai-ollama\.pid/);
  assert.match(uso, /ParentProcessId/, "meus = o registrado e os descendentes dele");
  const modo = fs.readFileSync(path.join(RAIZ, "local", "modo.ps1"), "utf8");
  assert.match(modo, /mixai-ollama\.pid/);
});

test("conferência lenta do job não vira 'tempo máximo' num comando que já acabou, e conferência sem resposta tem prazo próprio", async () => {
  const { spawn } = require("node:child_process");
  const lancar = (comando, fd) => spawn(process.execPath, ["-e", comando], { stdio: [fd, "pipe", "pipe"] });
  const lenta = () => new Promise((ok) => setTimeout(() => ok([]), 400));
  assert.strictEqual(await escada.chamarComando("process.stdout.write('ok')", { plataforma: "win32", lancar, orfaos: lenta, tempoMaximoMs: 150, prazoDeFechamentoMs: 3000 })("x"), "ok");
  await assert.rejects(
    escada.chamarComando("process.stdout.write('ok')", { plataforma: "win32", lancar, orfaos: () => new Promise(() => {}), prazoDeFechamentoMs: 150 })("x"),
    (erro) => erro.naoConfirmado === true,
  );
});

test("primeira decisão sem leitura pronta não grava estado; quando a leitura chega a decisão segue o ramo da subida inicial", () => comMemoriaAsync(6, async () => {
  const arquivoEstado = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ctl-")), "e.json");
  const leitor = { lerAsync: async () => ({ ...PARADO, ociosoSegundos: 900 }) };
  const controle = par.criarControle({ leitor, modo: "noite", arquivoEstado, relogio: () => 1e6, cacheMs: 1000, modos, config });
  assert.strictEqual(controle({ agentesLocais: 0 }), 1, "sem leitura pronta: 1 agente");
  assert.strictEqual(fs.existsSync(arquivoEstado), false, "nada de estado gravado sem leitura");
  await new Promise((r) => setImmediate(r));
  const alvo = controle({ agentesLocais: 1 }); // a mesma hora: sem cache da decisão sem leitura
  assert.strictEqual(fs.existsSync(arquivoEstado), true, "com leitura pronta o estado é gravado");
  const esperado = decide(PARADO, "noite", null, 1e6);
  assert.strictEqual(alvo, decide({ ...PARADO, ociosoSegundos: 900 }, "noite", null, 1e6).alvo, `como a primeira decisão real (${esperado.alvo})`);
}));

test("uso-windows.ps1: o PID do Ollama do MixAI vale só com a data de criação batendo, e qualquer amostra sem motor pid_ dá GPU null", () => {
  const uso = fs.readFileSync(path.join(RAIZ, "local", "uso-windows.ps1"), "utf8");
  assert.match(uso, /Split\('\|'\)/, "arquivo tem PID|data de criação");
  assert.match(uso, /\$_\.CreationDate\.ToUniversalTime\(\)\.ToString\('o'\) -eq \$partes\[1\]/, "compara a data de criação");
  assert.match(uso, /\$amostrasComPid\.Count -eq \$motores\.amostras/, "todas as amostras precisam ter motor pid_");
  assert.doesNotMatch(uso, /\$viuPid/);
  assert.match(uso, /\$l\.n -notmatch 'pid_\(\\d\+\)_'\) \{ \$valido = \$false; continue \}/, "motor de GPU fora do formato pid_<n>_ invalida a medida");
  const modo = fs.readFileSync(path.join(RAIZ, "local", "modo.ps1"), "utf8");
  assert.match(modo, /function Registrar-Ollama/);
  assert.match(modo, /CreationDate\.ToUniversalTime\(\)\.ToString\('o'\)/);
  assert.match(modo, /-PassThru \| ForEach-Object \{ Registrar-Ollama \$_ \}/);
});

test("com leitura velha (>= cacheMs) o controle nunca SOBE o número de agentes: só mantém ou reduz; com leitura recente sobe", () => comMemoriaAsync(6, async () => {
  let agora = 1e6;
  const leitor = { lerAsync: async () => ({ ...PARADO, ociosoSegundos: 900 }) };
  const arquivoEstado = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ctl-")), "e.json");
  const controle = par.criarControle({ leitor, modo: "noite", arquivoEstado, relogio: () => agora, cacheMs: 1000, modos, config });
  assert.strictEqual(controle({ agentesLocais: 1 }), 1, "sem leitura pronta");
  await new Promise((r) => setImmediate(r)); // a leitura chegou em `agora`
  agora += 1500; // a amostra tem 1500 ms: velha para subir (cacheMs = 1000), ainda válida para manter
  assert.strictEqual(controle({ agentesLocais: 1 }), 1, "amostra velha: mantém, não sobe");
  assert.strictEqual(fs.existsSync(arquivoEstado), false, "e não grava estado de subida");
  await new Promise((r) => setImmediate(r)); // chegou uma leitura nova, agora com 0 ms
  agora += 500;
  assert.ok(controle({ agentesLocais: 1 }) > 1, "leitura recente e PC parado: sobe");
}));

test("fatal com UM só id sem morte confirmada que a mensagem não cita: o erro lista o id", async () => {
  // a falha original é do limite/controlador (não cita "a"); a microtarefa a ainda não terminou dentro do prazo
  const local = (prompt, signal) => new Promise((ok, no) => signal.addEventListener("abort", () => setTimeout(() => no(new Error("abortado")), 400)));
  let limite = 1;
  setTimeout(() => { limite = () => { throw new Error("controlador quebrou"); }; }, 60);
  const erro = await escada.lote({ microtarefas: [microDe("a")], verificadorDe: verificadorOk, paralelismo: () => (typeof limite === "function" ? limite() : limite), reavaliarMs: 10, tempoParaConfirmarMs: 100, arquivos: arquivosTemp(), agentes: { local, superiores: [] } }).then(() => null, (e) => e);
  assert.ok(erro, "o lote parou");
  assert.match(erro.message, /Também não foi confirmada a morte de: a\./);
});

test("aborto que chega DURANTE a conferência do job conta: a chamada rejeita como abortada, nunca é sucesso", async () => {
  const { spawn } = require("node:child_process");
  const lancar = (comando, fd) => spawn(process.execPath, ["-e", comando], { stdio: [fd, "pipe", "pipe"] });
  const ctl = new AbortController();
  const orfaos = () => new Promise((ok) => { setTimeout(() => ctl.abort(), 30); setTimeout(() => ok([]), 150); }); // o aborto vem no meio da conferência
  await assert.rejects(
    escada.chamarComando("process.stdout.write('ok')", { plataforma: "win32", lancar, orfaos, matar: () => true })("x", ctl.signal),
    (erro) => erro.abortada === true,
  );
});

test("sinal já abortado antes da chamada: não cria arquivo nem processo (o comando não escreve o arquivo-marca)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abortado-antes-"));
  const marca = path.join(dir, "rodou");
  const ctl = new AbortController();
  ctl.abort();
  let lancou = 0;
  const { spawn } = require("node:child_process");
  const lancar = (comando, fd) => { lancou += 1; return spawn(process.execPath, ["-e", comando], { stdio: [fd, "pipe", "pipe"] }); };
  await assert.rejects(
    chamar(`require('fs').writeFileSync(${JSON.stringify(marca)}, 'x')`, { plataforma: "win32", lancar, orfaos: () => [] })("x", ctl.signal),
    (erro) => erro.abortada === true,
  );
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(lancou, 0, "o processo nem foi lançado");
  assert.strictEqual(fs.existsSync(marca), false, "o comando não escreveu nada");
});

test("uso-windows.ps1: toda linha de motor tem valor validado ANTES de filtrar por dono (linha inválida do próprio Ollama também dá null)", () => {
  const uso = fs.readFileSync(path.join(RAIZ, "local", "uso-windows.ps1"), "utf8");
  const valida = uso.search(/if \(-not \(Test-Numero \$l\.v\)\) \{ \$valido = \$false; continue \}/);
  const filtra = uso.search(/\$pidsMeus -notcontains \$pidDono/);
  assert.ok(valida >= 0 && filtra >= 0, "as duas linhas existem");
  assert.ok(valida < filtra, "validação vem antes do filtro por dono");
  assert.match(uso, /\$a\.Status -eq 0 -or \$a\.Status -eq 1/, "o Status inválido vira null na leitura");
});

test("descida: leitura nova que indica uso reduz na hora, sem esperar o cache; leitura velha com vários agentes reduz para 1 e pede leitura nova", () => comMemoriaAsync(6, async () => {
  let agora = 1e6;
  let atual = { ...PARADO, ociosoSegundos: 900 };
  let leituras = 0;
  const leitor = { lerAsync: async () => { leituras += 1; return atual; } };
  const controle = par.criarControle({ leitor, modo: "noite", arquivoEstado: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ctl-")), "e.json"), relogio: () => agora, cacheMs: 1000, modos, config });
  controle({ agentesLocais: 1 });
  await new Promise((r) => setImmediate(r)); // chegou a leitura de PC parado
  agora += 500;
  const alto = controle({ agentesLocais: 1 }); // decide com leitura recente: sobe
  assert.ok(alto > 1, `subiu (${alto})`);
  // o dono volta: a próxima leitura (já pedida por essa decisão) vem com uso
  atual = { ...PARADO, ociosoSegundos: 3 };
  agora += 100;
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(controle({ agentesLocais: alto }), 1, "dentro do cache da decisão anterior, mas a leitura nova manda reduzir já");
  // leitura velha (2 x cache) com vários agentes rodando: reduz para 1 e pede leitura nova
  atual = { ...PARADO, ociosoSegundos: 900 };
  await new Promise((r) => setImmediate(r));
  agora += 2500;
  const antes = leituras;
  assert.strictEqual(controle({ agentesLocais: 3 }), 1, "leitura velha com 3 agentes: reduz na hora");
  await new Promise((r) => setImmediate(r));
  assert.ok(leituras > antes, "pediu leitura nova");
}));

test("modo.ps1 prova pelo log que o Ollama subiu com o OLLAMA_NUM_PARALLEL do modo e falha com erro explícito se não bater", () => {
  const modo = fs.readFileSync(path.join(RAIZ, "local", "modo.ps1"), "utf8");
  assert.match(modo, /OLLAMA_NUM_PARALLEL:\(\\d\+\)/, "lê o valor impresso pelo Ollama no log");
  assert.match(modo, /\$vistoParalelo -ne \$esperadoParalelo/);
  assert.match(modo, /throw "O Ollama subiu com OLLAMA_NUM_PARALLEL:/);
  // a conferência vem depois de subir o servidor e antes do vigia/apelido (nada é anunciado com o valor errado)
  assert.ok(modo.search(/\$vistoParalelo -ne/) > modo.search(/'serve'/));
  assert.ok(modo.search(/\$vistoParalelo -ne/) < modo.search(/criar-apelido\.ps1/));
});

test("uso-windows.ps1 exige cobertura: instâncias de motor iguais em todas as amostras e erro parcial da coleta não é silenciado", () => {
  const uso = fs.readFileSync(path.join(RAIZ, "local", "uso-windows.ps1"), "utf8");
  assert.match(uso, /function Conjuntos-Iguais/);
  assert.match(uso, /-ErrorVariable errosContador/);
  assert.match(uso, /-ErrorVariable errosCim/);
  assert.match(uso, /@\(\$errosContador\)\.Count -gt 0\) \{ return \$null \}/);
  assert.match(uso, /if \(-not \(Conjuntos-Iguais \$leituras\)\) \{ return \$null \}/);
});

// --- Acompanhamento da coleta de uso (itens da revisão exaustiva) ----------------------------------------------------
test("GPU de outros programas: vale o motor MAIS carregado (média das amostras), não a soma de motores diferentes; sem cobertura ou linha inválida = null", () => {
  const linhas = [0, 1, 2].flatMap((i) => [{ i, t: "3D", v: 40 }, { i, t: "Copy", v: 30 }, { i, t: "VideoDecode", v: 10 }]);
  assert.strictEqual(par.gpuOutrosDe({ amostras: 3, linhas }), 40, "3D 40, Copy 30, vídeo 10: a placa está a 40, não a 80");
  assert.strictEqual(par.gpuOutrosDe({ amostras: 3, linhas: [] }), 0, "cobertura provada e ninguém usando");
  assert.strictEqual(par.gpuOutrosDe({ amostras: 3, linhas: [{ i: 0, t: "3D", v: 90 }, { i: 1, t: "3D", v: 90 }] }), 60, "amostra sem uso do tipo conta zero nela");
  assert.strictEqual(par.gpuOutrosDe({ amostras: 3, linhas: [0, 1, 2].map((i) => ({ i, t: "3D", v: 150 })) }), 100, "limita a 100");
  assert.strictEqual(par.gpuOutrosDe({ amostras: 0, linhas: [] }), null, "coleta sem cobertura");
  assert.strictEqual(par.gpuOutrosDe({ amostras: 2, linhas: [] }), null);
  for (const ruim of [{ i: 0, t: "3D", v: null }, { i: 0, t: "3D", v: -1 }, { i: 7, t: "3D", v: 1 }, { i: 0, t: "", v: 1 }, { i: 0, v: 1 }]) {
    assert.strictEqual(par.gpuOutrosDe({ amostras: 3, linhas: [ruim] }), null, JSON.stringify(ruim));
  }
  // vem pela saída do script
  const base = { ociosoSegundos: 900, cpuTotalPct: 10, cpuMeuPct: 5, nucleos: 8, videoAmostras: 3, videoMotores: [], memoriaLivreGB: 6 };
  assert.strictEqual(par.lerSaida(JSON.stringify({ ...base, gpuAmostras: 3, gpuPorTipo: linhas })).gpuOutrosPct, 40);
  assert.strictEqual(par.lerSaida(JSON.stringify({ ...base, gpuAmostras: 0, gpuPorTipo: [] })).gpuOutrosPct, null, "sem cobertura: null, e o decisor trata como em uso");
});

test("CPU: parte do Ollama muito acima do total da máquina é leitura inconsistente (null), não 'zero de outros programas'", () => {
  assert.strictEqual(par.cpuOutrosDe({ cpuTotalPct: 5, cpuMeuPct: 400, nucleos: 8 }), null, "Ollama a 50% da máquina com total em 5%");
  assert.strictEqual(par.cpuOutrosDe({ cpuTotalPct: 40, cpuMeuPct: 400, nucleos: 8 }), 0, "Ollama a 50% com total em 40%: dentro da folga, não passa de 0");
});

test("capacidade usa a VRAM medida de outros programas e só credita a memória que o Ollama do MixAI realmente ocupa", () => {
  const sem = par.capacidade({ modo: "noite", memoriaLivreGB: 6, modos, config, memoriaMinimaGB: 2 });
  const ocupada = par.capacidade({ modo: "noite", memoriaLivreGB: 6, vramOutrosGB: 3, modos, config, memoriaMinimaGB: 2 });
  assert.ok(sem.limites.placa >= 1, "controle: a placa livre cabe agente");
  assert.strictEqual(ocupada.limites.placa, 0, "outro programa com 3 GB na placa: não cabe agente");
  assert.strictEqual(ocupada.limitante, "placa");
  assert.strictEqual(ocupada.vramMedida, true);
  assert.strictEqual(sem.vramMedida, false, "sem medida vale só a reserva fixa");
  // crédito de memória: 3 agentes contados, mas o Ollama do MixAI só ocupa 0.5 GB de verdade
  const cheio = par.capacidade({ modo: "noite", memoriaLivreGB: 2.5, agentesAtuais: 3, modos, config, memoriaMinimaGB: 2 });
  const medido = par.capacidade({ modo: "noite", memoriaLivreGB: 2.5, agentesAtuais: 3, ramMeuGB: 0.5, modos, config, memoriaMinimaGB: 2 });
  assert.ok(medido.limites.memoria < cheio.limites.memoria, `${medido.limites.memoria} < ${cheio.limites.memoria}`);
  // vem da leitura pelo decisor
  const d = decide({ ...PARADO, vramOutrosGB: 3 }, "noite", { alvo: 3, subiuEm: 0 }, 1e6);
  assert.strictEqual(d.capacidade.limites.placa, 0);
});

test("estado do controle: gravação atômica com o modo, e estado de outro modo ou com lixo é ignorado (recomeça)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-"));
  const arquivoEstado = path.join(dir, "e.json");
  await comMemoriaAsync(6, async () => {
    const controle = par.criarControle({ leitor: { ler: () => ({ ...PARADO, ociosoSegundos: 7200 }) }, modo: "noite", arquivoEstado, relogio: () => 1e6, cacheMs: 0, modos, config });
    controle({ agentesLocais: 0 });
    const gravado = JSON.parse(fs.readFileSync(arquivoEstado, "utf8"));
    assert.strictEqual(gravado.modo, "noite");
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => !n.startsWith("e.json.lotes")), ["e.json"], "nenhum temporário sobra (só a pasta e a trava das reservas de vagas)");
    controle.liberar();
    // outro modo: o estado não vale (recomeça pela primeira decisão)
    fs.writeFileSync(arquivoEstado, JSON.stringify({ alvo: 1, subiuEm: 1e6, gravadoEm: 1e6, modo: "dia" }));
    const c2 = par.criarControle({ leitor: { ler: () => ({ ...PARADO, ociosoSegundos: 7200 }) }, modo: "noite", arquivoEstado, relogio: () => 1e6 + 1000, cacheMs: 0, modos, config });
    assert.ok(c2({ agentesLocais: 0 }) > 1, "estado do modo dia (alvo 1, acabou de subir) não segura o modo noite");
    c2.liberar();
    // lixo
    for (const lixo of ["", "{", "[]", "null", JSON.stringify({ alvo: "x", subiuEm: 1, gravadoEm: 1e6, modo: "noite" }), JSON.stringify({ alvo: -2, subiuEm: 1, gravadoEm: 1e6, modo: "noite" })]) {
      fs.writeFileSync(arquivoEstado, lixo);
      const c3 = par.criarControle({ leitor: { ler: () => ({ ...PARADO, ociosoSegundos: 7200 }) }, modo: "noite", arquivoEstado, relogio: () => 1e6 + 2000, cacheMs: 0, modos, config });
      assert.ok(c3({ agentesLocais: 0 }) > 1, `lixo ignorado: ${lixo}`);
      c3.liberar();
    }
  });
});

test("leitorWindows: erro escrito pelo coletor na saída de erro torna a leitura indisponível (null), mesmo com JSON na saída", async () => {
  const json = JSON.stringify({ ociosoSegundos: 900, memoriaLivreGB: 6, nucleos: 8, cpuTotalPct: 5, cpuMeuPct: 0, videoAmostras: 3, videoMotores: [], gpuAmostras: 3, gpuPorTipo: [] });
  const comSaida = (stderr) => ({ executar: (c, a, o, cb) => cb(null, json, stderr) });
  assert.ok((await par.leitorWindows(comSaida("")).lerAsync()).gpuOutrosPct === 0, "controle: sem erro vale");
  assert.strictEqual(await par.leitorWindows(comSaida("Get-CimInstance : acesso negado")).lerAsync(), null);
  assert.strictEqual(await par.leitorWindows({ executar: (c, a, o, cb) => cb(new Error("falhou")) }).lerAsync(), null);
});

test("prompt temporário fica em pasta privada: pasta aberta para outros é recusada antes de escrever o prompt ou iniciar o processo", async () => {
  if (process.platform === "win32") return; // no Windows a permissão vem da ACL do %TEMP% do usuário
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pasta-prompt-"));
  const aberta = path.join(base, "aberta");
  fs.mkdirSync(aberta, { mode: 0o755 });
  fs.chmodSync(aberta, 0o755);
  let lancou = 0;
  await assert.rejects(
    escada.chamarComando("x", { plataforma: "win32", lancar: () => { lancou += 1; throw new Error("não devia lançar"); }, pastaPrompts: aberta })("segredo"),
    /não é privada/,
  );
  assert.strictEqual(lancou, 0);
  assert.deepStrictEqual(fs.readdirSync(aberta), [], "nenhum prompt foi escrito na pasta aberta");
  // pasta privada nova: funciona, e o arquivo some no fim
  const privada = path.join(base, "privada");
  const { spawn } = require("node:child_process");
  const resposta = await escada.chamarComando("process.stdin.pipe(process.stdout)", { plataforma: "win32", lancar: (c, fd) => spawn(process.execPath, ["-e", c], { stdio: [fd, "pipe", "pipe"] }), orfaos: () => [], pastaPrompts: privada })("olá");
  assert.strictEqual(resposta, "olá");
  assert.strictEqual((fs.statSync(privada).mode & 0o077), 0, "pasta criada só para o dono");
  assert.deepStrictEqual(fs.readdirSync(privada), [], "o prompt temporário foi apagado");
});

test("uso-windows.ps1 e modo.ps1 (texto): sessão do console, tempo ocioso plausível, CIM como segunda fonte, cobertura de cpuMeu, VRAM e RAM medidas, modo gravado conferido", () => {
  const uso = fs.readFileSync(path.join(RAIZ, "local", "uso-windows.ps1"), "utf8");
  assert.match(uso, /WTSGetActiveConsoleSessionId/);
  assert.match(uso, /\(Get-Process -Id \$PID\)\.SessionId -ne \[MixaiOcioso\]::SessaoDoConsole\(\)\)\) \{ \$ocioso = \$null \}/, "outra sessão: ocioso indisponível");
  assert.match(uso, /\$ocioso -gt \(\(Get-Date\) - \$so\.LastBootUpTime\)\.TotalSeconds/, "ocioso maior que o tempo ligado é impossível");
  assert.match(uso, /function Ler-Contador/);
  assert.match(uso, /function Ler-Cim/);
  assert.match(uso, /\$r = Ler-Contador\s+if \(\$null -eq \$r\) \{ \$r = Ler-Cim \}/, "o CIM é tentado quando o contador é inválido");
  assert.match(uso, /\$vistosCpu\.Count -ne \$pidsMeus\.Count\) \{ \$valido = \$false \}/, "cpuMeu exige cobertura dos processos do MixAI");
  assert.match(uso, /GPU Adapter Memory\(\*\)\\Dedicated Usage/);
  assert.match(uso, /GPU Process Memory\(\*\)\\Dedicated Usage/);
  assert.match(uso, /vramOutrosGB\s+= \$vramOutrosGB/);
  assert.match(uso, /ramMeuGB\s+= \$ramMeuGB/);
  assert.match(uso, /gpuPorTipo\s+= @\(\$gpuPorTipo\)/);
  const modo = fs.readFileSync(path.join(RAIZ, "local", "modo.ps1"), "utf8");
  assert.match(modo, /\$gravadoModo -ne \$Modo/);
  assert.match(modo, /throw "Não consegui gravar o modo/);
  assert.ok(modo.search(/\$gravadoModo -ne/) > modo.search(/Set-Content \$arquivoModo \$Modo/), "confere depois de gravar");
  assert.ok(modo.search(/Write-Host "Modo \$Modo ligado/) > modo.search(/\$gravadoModo -ne/), "só anuncia depois de conferir");
});

test("GPU: o motor mais carregado EM CADA amostra e só depois a média (3D e Copy alternando a 90% = placa a 90%)", () => {
  const linhas = [{ i: 0, t: "3D", v: 90 }, { i: 0, t: "Copy", v: 0 }, { i: 1, t: "3D", v: 0 }, { i: 1, t: "Copy", v: 90 }, { i: 2, t: "3D", v: 90 }, { i: 2, t: "Copy", v: 0 }];
  assert.strictEqual(par.gpuOutrosDe({ amostras: 3, linhas }), 90, "a média por tipo daria 60");
});

test("player de vídeo conhecido ativo (CPU) conta como vídeo por software; ausente não muda nada; inválido é leitura indisponível", () => {
  assert.strictEqual(decide({ ...PARADO, playersCpuPct: 0 }, "noite", { alvo: 3, subiuEm: 0 }, 1e6).alvo, 3);
  assert.match(decide({ ...PARADO, playersCpuPct: 12 }, "noite", { alvo: 3, subiuEm: 0 }, 1e6).motivo, /player de vídeo ativo/);
  assert.strictEqual(decide({ ...PARADO, playersCpuPct: 12 }, "noite", { alvo: 3, subiuEm: 0 }, 1e6).alvo, 1);
  for (const ruim of [null, NaN, -1, "3"]) assert.match(decide({ ...PARADO, playersCpuPct: ruim }, "noite", { alvo: 3, subiuEm: 0 }, 1e6).motivo, /indisponível/, String(ruim));
});

test("dois lotes juntos nunca passam do teto: o segundo fica com o que sobra, a vaga volta ao liberar, e reserva de lote morto ou sem batimento é descartada", () => comMemoriaAsync(6, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lotes-"));
  const arquivoEstado = path.join(dir, "e.json");
  let agora = 1e6;
  const mais = () => par.criarControle({ leitor: { ler: () => ({ ...PARADO, ociosoSegundos: 7200 }) }, modo: "noite", arquivoEstado, relogio: () => agora, cacheMs: 0, modos, config });
  const teto = modos.noite.agentesMax;
  const a = mais();
  const b = mais();
  const alvoA = a({ agentesLocais: 0 });
  assert.strictEqual(alvoA, teto, "o primeiro lote reserva até o teto");
  assert.strictEqual(b({ agentesLocais: 0 }), 0, "o segundo não tem vaga: o teto inteiro está reservado");
  for (let i = 0; i < 5; i++) { const x = a({ agentesLocais: 1 }); const y = b({ agentesLocais: 0 }); assert.ok(x + y <= teto, `${x} + ${y} <= ${teto}`); }
  a.liberar();
  assert.strictEqual(b({ agentesLocais: 0 }), teto, "o primeiro acabou: a vaga volta");
  // lote com agentes vivos (morrendo) continua reservando mesmo que o alvo caia
  const c = mais();
  assert.strictEqual(c({ agentesLocais: 0 }), 0, "o segundo (b) segura o teto");
  b.liberar();
  // reserva de PID inexistente e PID reaproveitado (outra data de criação) não contam
  const pasta = `${arquivoEstado}.lotes`;
  fs.writeFileSync(path.join(pasta, "morto.json"), JSON.stringify({ reservado: 3, pid: 2147483000, em: agora }));
  fs.writeFileSync(path.join(pasta, "reaproveitado.json"), JSON.stringify({ reservado: 3, pid: process.pid, inicio: "outro-processo", em: agora }));
  fs.writeFileSync(path.join(pasta, "lixo.json"), "{");
  assert.strictEqual(c({ agentesLocais: 0 }), teto, "nada disso reserva vaga");
  assert.deepStrictEqual(fs.readdirSync(pasta).filter((n) => !n.startsWith(`${process.pid}-`)), [], "as reservas inválidas foram apagadas");
  c.liberar();
}));

test("o lote devolve a reserva de vagas ao terminar (também com erro)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lotes-"));
  let liberou = 0;
  const controle = Object.assign(() => 1, { liberar: () => { liberou += 1; } });
  await escada.lote({ microtarefas: [microDe("a")], verificadorDe: verificadorOk, paralelismo: controle, arquivos: arquivosTemp(), agentes: { local: () => "ok", superiores: [] } });
  assert.strictEqual(liberou, 1);
  await assert.rejects(escada.lote({ microtarefas: [microDe("a")], verificadorDe: verificadorOk, paralelismo: Object.assign(() => { throw new Error("quebrou"); }, { liberar: () => { liberou += 1; } }), arquivos: arquivosTemp(), agentes: { local: () => "ok", superiores: [] } }));
  assert.strictEqual(liberou, 2);
});

test("pasta privada do prompt no Windows: pasta nova aleatória, icacls sem herança com só o usuário, ACL lida de volta; qualquer outro principal ou falha do icacls recusa e apaga a pasta", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "acl base "));
  const chamadas = [];
  const fingir = (listaDoIcacls) => (cmd, args) => { chamadas.push([cmd, ...args]); return args.length === 1 ? `${args[0]} ${listaDoIcacls}\n\nSuccessfully processed 1 files; Failed processing 0 files\n` : "Successfully processed 1 files; Failed processing 0 files\n"; };
  const ok = escada.criarPastaPrivadaWindows(base, { executar: fingir("PC\\maria:(OI)(CI)(F)"), usuario: "maria", dominio: "PC" });
  assert.ok(ok.startsWith(path.join(base, "mixai-prompts-")) && fs.existsSync(ok), "pasta nova com nome aleatório");
  assert.deepStrictEqual(chamadas[0].slice(0, 1).concat(chamadas[0].slice(2)), ["icacls", "/inheritance:r", "/grant:r", "maria:(OI)(CI)F"]);
  const outra = escada.criarPastaPrivadaWindows(base, { executar: fingir("PC\\maria:(OI)(CI)(F)"), usuario: "maria", dominio: "PC" });
  assert.notStrictEqual(outra, ok, "cada pasta tem nome diferente");
  // ACL com outro principal (herdado, Users, Everyone...) é recusada e a pasta some
  for (const extra of ["PC\\maria:(OI)(CI)(F)\n                          BUILTIN\\Users:(I)(OI)(CI)(RX)", "Everyone:(OI)(CI)(F)", "BUILTIN\\Administrators:(OI)(CI)(F)"]) {
    const antes = fs.readdirSync(base).length;
    assert.throws(() => escada.criarPastaPrivadaWindows(base, { executar: fingir(extra), usuario: "maria", dominio: "PC" }), /não é só do usuário/);
    assert.strictEqual(fs.readdirSync(base).length, antes, "a pasta recusada foi apagada");
  }
  assert.throws(() => escada.criarPastaPrivadaWindows(base, { executar: () => { throw new Error("icacls: acesso negado"); }, usuario: "maria" }), /não consegui tornar privada.*acesso negado/);
  assert.throws(() => escada.criarPastaPrivadaWindows(base, { executar: fingir("sem acl legível"), usuario: "maria" }), /não consegui ler a ACL/);
  assert.throws(() => escada.criarPastaPrivadaWindows(base, { executar: fingir(""), usuario: "" }), /USERNAME/);
});

test("Windows de verdade: a pasta privada do prompt criada pelo icacls real tem ACL só do usuário e dá para escrever nela", () => {
  if (process.platform !== "win32") return;
  const pasta = escada.criarPastaPrivadaWindows();
  try {
    fs.writeFileSync(path.join(pasta, "teste.txt"), "x");
    assert.strictEqual(fs.readFileSync(path.join(pasta, "teste.txt"), "utf8"), "x");
  } finally { fs.rmSync(pasta, { recursive: true, force: true }); }
});

test("uso-windows.ps1 (texto): VRAM só do adaptador do MixAI (luid), adaptadores vazios = null, RAM só dos runners (memória privada), players de vídeo conhecidos", () => {
  const uso = fs.readFileSync(path.join(RAIZ, "local", "uso-windows.ps1"), "utf8");
  assert.match(uso, /luid_0x\[0-9a-fA-F\]\+_0x\[0-9a-fA-F\]\+/, "o luid liga o adaptador ao processo");
  assert.match(uso, /\$meuPorAdaptador\[\$luidMeu\]/);
  assert.match(uso, /\$amostrasAdaptador\.Count -eq 0\) \{ \$valido = \$false \}/, "CounterSamples vazio do adaptador dá null");
  assert.doesNotMatch(uso, /\$totalVram \+= /, "não soma todos os adaptadores");
  assert.match(uso, /Measure-Object PrivatePageCount -Sum/, "só memória privada");
  assert.match(uso, /\$_\.Name -match '\^\(llama-server\|ollama_llama_server\|ollama-runner\)/, "só os runners do modelo, pelo nome exato");
  assert.doesNotMatch(uso, /Measure-Object WorkingSetSize/, "o working set inteiro não é crédito");
  assert.match(uso, /\$playersCpu = \$null/);
  assert.match(uso, /vlc\|mpv\|mpc-hc/);
  assert.match(uso, /playersCpuPct\s+= \$playersCpu/);
});

// --- Rodada do Codex no #27: trava, retenção, chave do motor --------------------------------------------------------

test("sem conseguir a trava da reserva nenhuma vaga NOVA é concedida (só mantém as que já existem); trava de dono vivo nunca é tomada, de dono morto é superada", () => comMemoriaAsync(6, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trava-"));
  const arquivoEstado = path.join(dir, "e.json");
  const pasta = `${arquivoEstado}.lotes`;
  const mk = () => par.criarControle({ leitor: { ler: () => ({ ...PARADO, ociosoSegundos: 7200 }) }, modo: "noite", arquivoEstado, relogio: () => 1e6, cacheMs: 0, modos, config });
  // um dono VIVO (este processo) segura a trava, por mais velha que seja: ninguém a toma
  const trava = `${pasta}.trava.lock.00000001`;
  fs.mkdirSync(path.dirname(trava), { recursive: true });
  fs.writeFileSync(trava, `${process.pid}:abc`);
  const velho = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(trava, velho, velho);
  const c = mk();
  const t0 = Date.now();
  assert.strictEqual(c({ agentesLocais: 0 }), 0, "sem trava: nenhuma vaga nova");
  assert.ok(Date.now() - t0 >= 1500, "esperou a trava antes de desistir");
  assert.strictEqual(c({ agentesLocais: 2 }), 2, "sem trava: mantém as que já existem, não sobe");
  assert.strictEqual(fs.readFileSync(trava, "utf8"), `${process.pid}:abc`, "a trava do dono vivo continua intacta");
  // dono MORTO: superado por uma geração maior, sem apagar a dele
  fs.writeFileSync(trava, "2147483000:morto");
  assert.strictEqual(c({ agentesLocais: 0 }), modos.noite.agentesMax, "dono morto não segura");
  assert.ok(fs.existsSync(trava), "a trava do morto não foi apagada, foi superada");
  assert.ok(fs.existsSync(`${pasta}.trava.lock.00000002`));
  c.liberar();
}));

test("morte NÃO confirmada: o lote não devolve a reserva dessas vagas; ela fica até os processos morrerem ou expirar, e some depois", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retida-"));
  const arquivoEstado = path.join(dir, "e.json");
  const pasta = `${arquivoEstado}.lotes`;
  let agora = 1e6;
  await comMemoriaAsync(6, async () => {
    const mk = () => par.criarControle({ leitor: { ler: () => ({ ...PARADO, ociosoSegundos: 7200 }) }, modo: "noite", arquivoEstado, relogio: () => agora, cacheMs: 0, modos, config });
    const controle = mk();
    const teto = modos.noite.agentesMax;
    // o lote concede vagas e termina com morte não confirmada de um agente (processo "vivo": este mesmo processo)
    const vivo = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"], { stdio: "ignore" });
    t.after?.(() => { try { vivo.kill("SIGKILL"); } catch { /* já foi */ } });
    const local = () => { throw Object.assign(new Error("não morreu"), { naoConfirmado: true, pid: vivo.pid }); };
    await assert.rejects(escada.lote({ microtarefas: [microDe("a")], verificadorDe: verificadorOk, paralelismo: controle, arquivos: arquivosTemp(), agentes: { local, superiores: [] } }), /o lote parou/);
    const guardadas = fs.readdirSync(pasta).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(fs.readFileSync(path.join(pasta, n), "utf8")));
    assert.strictEqual(guardadas.length, 1, "a reserva ficou");
    assert.strictEqual(guardadas[0].reservado, 1);
    assert.strictEqual(guardadas[0].itens.length, 1);
    assert.strictEqual(guardadas[0].itens[0].pid, vivo.pid);
    // outro lote só recebe o que sobra: 1 vaga continua retida
    const outro = mk();
    assert.strictEqual(outro({ agentesLocais: 0 }), teto - 1, "uma vaga está retida pelo agente que pode estar vivo");
    outro.liberar();
    // o tempo NÃO expira a retenção enquanto o processo retido vive
    agora += 3 * 3600 * 1000;
    const depois = mk();
    assert.strictEqual(depois({ agentesLocais: 0 }), teto - 1, "processo retido ainda vivo: continua retida horas depois");
    depois.liberar();
    vivo.kill("SIGKILL");
    await new Promise((r) => vivo.once("exit", r));
    const morreu = mk();
    assert.strictEqual(morreu({ agentesLocais: 0 }), teto, "o processo retido morreu: a vaga volta");
    morreu.liberar();
  });
  // quando o processo retido já morreu, a vaga volta na hora
  const morto = path.join(pasta, "retido-morto.json");
  fs.mkdirSync(pasta, { recursive: true });
  fs.writeFileSync(morto, JSON.stringify({ reservado: 1, itens: [{ pid: 2147483000 }], ate: agora + 1e6, em: agora }));
  await comMemoriaAsync(6, async () => {
    const c = par.criarControle({ leitor: { ler: () => ({ ...PARADO, ociosoSegundos: 7200 }) }, modo: "noite", arquivoEstado, relogio: () => agora, cacheMs: 0, modos, config });
    assert.strictEqual(c({ agentesLocais: 0 }), modos.noite.agentesMax, "o processo retido morreu");
    c.liberar();
  });
});

test("o erro naoConfirmado leva o PID do processo (a reserva fica retida por ele)", async () => {
  const { spawn } = require("node:child_process");
  const lancar = (c, fd) => spawn(process.execPath, ["-e", c], { stdio: [fd, "pipe", "pipe"] });
  let filho;
  const erro = await escada.chamarComando("setTimeout(()=>{},3000)", { plataforma: "win32", lancar: (c, fd) => (filho = lancar(c, fd)), matar: () => false, orfaos: () => [], reintentoMs: 10, tentativasDeMatar: 2 })("x", AbortSignal.abort()).catch((e) => e);
  assert.ok(erro.abortada, "já abortado: nem lança");
  const ctl = new AbortController();
  const p = escada.chamarComando("setTimeout(()=>{},3000)", { plataforma: "win32", lancar: (c, fd) => (filho = lancar(c, fd)), matar: () => false, orfaos: () => [], reintentoMs: 10, tentativasDeMatar: 2 })("x", ctl.signal);
  setTimeout(() => ctl.abort(), 50);
  const e2 = await p.catch((e) => e);
  assert.strictEqual(e2.naoConfirmado, true);
  assert.strictEqual(e2.pid, filho.pid);
  try { filho.kill("SIGKILL"); } catch { /* já foi */ }
});

test("GPU: a chave do motor é adaptador + engine + tipo (não só o tipo): dois motores do mesmo tipo em adaptadores diferentes não se somam", () => {
  const uso = fs.readFileSync(path.join(RAIZ, "local", "uso-windows.ps1"), "utf8");
  assert.match(uso, /\[regex\]::Match\(\$l\.n, 'pid_\\d\+_\(\.\+\)\$'\)/, "a chave é tudo depois de pid_<n>_");
  assert.doesNotMatch(uso, /Match\(\$l\.n, 'engtype_/, "não agrupa só pelo tipo");
  // o decisor pega o máximo entre os motores de cada amostra
  const motor = (i, adaptador, v) => ({ i, t: `luid_0x0_0x${adaptador}_phys_0_eng_0_engtype_3D`, v });
  const linhas = [0, 1, 2].flatMap((i) => [motor(i, "A", 60), motor(i, "B", 70)]);
  assert.strictEqual(par.gpuOutrosDe({ amostras: 3, linhas }), 70, "3D de duas placas: vale a mais carregada (70), não 130");
});

test("ESCADA.md não diz mais que dois lotes passam do teto", () => {
  const doc = fs.readFileSync(path.join(RAIZ, "orquestra", "ESCADA.md"), "utf8");
  assert.doesNotMatch(doc, /o total pode passar do teto/);
  assert.doesNotMatch(doc, /o arquivo de estado não reserva vagas/);
});

// --- Rodada do Codex no #27: validade, retenção pelo Job, gravação dentro da trava -----------------------------------

const controleCom = (arquivoEstado, agora, extra = {}) => par.criarControle({ leitor: { ler: () => ({ ...PARADO, ociosoSegundos: 7200 }) }, modo: "noite", arquivoEstado, relogio: () => agora.v, cacheMs: 0, modos, config, ...extra });

test("reserva de lote com dono vivo NÃO expira por tempo; só cai com dono morto ou PID reaproveitado (outra data de criação)", () => comMemoriaAsync(6, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validade-"));
  const arquivoEstado = path.join(dir, "e.json");
  const agora = { v: 1e9 };
  const pasta = `${arquivoEstado}.lotes`;
  const teto = modos.noite.agentesMax;
  fs.mkdirSync(pasta, { recursive: true });
  const meuInicio = par.inicioDoProcesso(process.pid);
  fs.writeFileSync(path.join(pasta, "antigo.json"), JSON.stringify({ reservado: 3, pid: process.pid, inicio: meuInicio, em: agora.v - 24 * 3600 * 1000 }));
  let c = controleCom(arquivoEstado, agora);
  assert.strictEqual(c({ agentesLocais: 0 }), teto - 3, "dono vivo, mesmo sem batimento há um dia: segura");
  c.liberar();
  if (meuInicio !== null) {
    fs.writeFileSync(path.join(pasta, "antigo.json"), JSON.stringify({ reservado: 3, pid: process.pid, inicio: "outro", em: agora.v }));
    c = controleCom(arquivoEstado, agora);
    assert.strictEqual(c({ agentesLocais: 0 }), teto, "PID reaproveitado por outro processo: não segura");
    c.liberar();
  }
}));

test("retenção pelo Job: vale enquanto o Job não estiver vazio (vivo ou inconclusivo, sem limite de tempo) e some quando ele esvazia; sem nada para consultar vale até `ate`", () => comMemoriaAsync(6, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-"));
  const arquivoEstado = path.join(dir, "e.json");
  const agora = { v: 1e6 };
  const pasta = `${arquivoEstado}.lotes`;
  const teto = modos.noite.agentesMax;
  const estado = { "Local\\MixAI-a": true };
  const consultas = [];
  const jobVivo = (nome) => { consultas.push(nome); return estado[nome]; };
  const retida = (extra = {}) => fs.writeFileSync(path.join(pasta, "retida.json"), JSON.stringify({ reservado: 1, itens: [{ job: "Local\\MixAI-a" }], ate: agora.v + 600000, em: agora.v, ...extra }));
  fs.mkdirSync(pasta, { recursive: true });
  retida(); // o PID do wrapper está morto, mas o Job tem processo: continua retida
  let c = controleCom(arquivoEstado, agora, { jobVivo });
  assert.strictEqual(c({ agentesLocais: 0 }), teto - 1, "Job com processo vivo segura a vaga");
  assert.deepStrictEqual(consultas, ["Local\\MixAI-a"]);
  c.liberar();
  agora.v += 5 * 3600 * 1000; // horas depois, Job ainda vivo ou inconclusivo: não expira
  for (const v of [true, null]) {
    estado["Local\\MixAI-a"] = v;
    c = controleCom(arquivoEstado, agora, { jobVivo });
    assert.strictEqual(c({ agentesLocais: 0 }), teto - 1, `Job ${v}: mantém`);
    c.liberar();
  }
  estado["Local\\MixAI-a"] = false;
  c = controleCom(arquivoEstado, agora, { jobVivo });
  assert.strictEqual(c({ agentesLocais: 0 }), teto, "Job vazio: a vaga volta na hora");
  c.liberar();
  // sem Job nem PID para consultar: vale até `ate`
  fs.writeFileSync(path.join(pasta, "sem-nada.json"), JSON.stringify({ reservado: 1, itens: [{}], ate: agora.v + 1000, em: agora.v }));
  c = controleCom(arquivoEstado, agora, { jobVivo });
  assert.strictEqual(c({ agentesLocais: 0 }), teto - 1);
  c.liberar();
  agora.v += 2000;
  c = controleCom(arquivoEstado, agora, { jobVivo });
  assert.strictEqual(c({ agentesLocais: 0 }), teto, "passou de `ate`");
  c.liberar();
}));

test("--limpar-reservas apaga as reservas e retenções (saída manual)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "limpa-"));
  const pasta = path.join(dir, "lotes");
  fs.mkdirSync(pasta);
  fs.writeFileSync(path.join(pasta, "a.json"), "{}"); fs.writeFileSync(path.join(pasta, "b.json"), "{}");
  assert.strictEqual(par.limparReservas(pasta), 2);
  assert.deepStrictEqual(fs.readdirSync(pasta), []);
  const uso = fs.readFileSync(path.join(RAIZ, "orquestra", "paralelismo.js"), "utf8");
  assert.match(uso, /--limpar-reservas/);
});

test("o erro naoConfirmado do comando leva o NOME DO JOB e o lote passa os Jobs para a reserva", async () => {
  const { spawn } = require("node:child_process");
  const ctl = new AbortController();
  let filho;
  const p = escada.chamarComando("setTimeout(()=>{},3000)", { plataforma: "win32", lancar: (c, fd) => (filho = spawn(process.execPath, ["-e", c], { stdio: [fd, "pipe", "pipe"] })), matar: () => false, orfaos: () => [], reintentoMs: 10, tentativasDeMatar: 2 })("x", ctl.signal);
  setTimeout(() => ctl.abort(), 50);
  const e = await p.catch((x) => x);
  try { filho.kill("SIGKILL"); } catch { /* já foi */ }
  assert.match(e.jobNome, /^Local\\MixAI-[0-9a-f]+$/);
  let recebido;
  const paralelismo = Object.assign(() => 1, { liberar: (r) => { recebido = r; } });
  const local = () => { throw Object.assign(new Error("não morreu"), { naoConfirmado: true, pid: 4242, jobNome: "Local\\MixAI-zz" }); };
  await assert.rejects(escada.lote({ microtarefas: [microDe("a")], verificadorDe: verificadorOk, paralelismo, arquivos: arquivosTemp(), agentes: { local, superiores: [] } }), /o lote parou/);
  assert.deepStrictEqual(recebido, { naoConfirmados: 1, itens: [{ pid: 4242, jobNome: "Local\\MixAI-zz" }] });
});

test("retenção é gravada ANTES de apagar a reserva; se a gravação falha a reserva NÃO é apagada; limpeza de outro lote não apaga retenção válida", () => comMemoriaAsync(6, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grava-"));
  const arquivoEstado = path.join(dir, "e.json");
  const agora = { v: 1e6 };
  const pasta = `${arquivoEstado}.lotes`;
  const teto = modos.noite.agentesMax;
  const a = controleCom(arquivoEstado, agora, { reintentoRetencaoMs: 100 });
  assert.strictEqual(a({ agentesLocais: 0 }), teto);
  const arq = () => fs.readdirSync(pasta).filter((n) => n.endsWith(".json"));
  const [meu] = arq();
  // gravação impossível (o temporário é uma pasta): a reserva original continua lá, `liberar` falha FECHADO (lança) e o processo
  // segue tentando; quando a gravação volta, a retenção é gravada e não depende mais do dono do lote
  fs.mkdirSync(path.join(pasta, `${meu}.tmp`));
  assert.throws(() => a.liberar({ naoConfirmados: 1, itens: [{ jobNome: "Local\\MixAI-a" }] }), (e) => e.retencaoNaoGravada === true);
  assert.deepStrictEqual(arq(), [meu], "a reserva não foi apagada");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pasta, meu), "utf8")).reservado, teto);
  fs.rmdirSync(path.join(pasta, `${meu}.tmp`));
  await new Promise((r) => setTimeout(r, 400));
  const gravada = JSON.parse(fs.readFileSync(path.join(pasta, meu), "utf8"));
  assert.deepStrictEqual(gravada.itens, [{ job: "Local\\MixAI-a" }], "a nova tentativa gravou a retenção (não é mais a reserva comum do PID do lote)");
  assert.strictEqual(gravada.pid, undefined);
  // outro lote limpando: uma retenção válida (Job vivo) fica
  const b = controleCom(arquivoEstado, agora, { jobVivo: () => true });
  fs.writeFileSync(path.join(pasta, "retida.json"), JSON.stringify({ reservado: 1, itens: [{ job: "Local\\MixAI-a" }], ate: agora.v + 600000, em: agora.v }));
  b({ agentesLocais: 0 });
  assert.ok(arq().includes("retida.json"), "a limpeza não apaga retenção válida");
  b.liberar();
}));

test("retenção mista: cada morte não confirmada é avaliada pelo próprio identificador; a reserva só cai quando TODAS estão resolvidas", () => comMemoriaAsync(6, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mista-"));
  const arquivoEstado = path.join(dir, "e.json");
  const agora = { v: 1e6 };
  const pasta = `${arquivoEstado}.lotes`;
  const teto = modos.noite.agentesMax;
  fs.mkdirSync(pasta, { recursive: true });
  const estado = { "Local\\MixAI-vazio": false, "Local\\MixAI-vivo": true };
  const jobVivo = (nome) => estado[nome];
  const grava = (itens) => fs.writeFileSync(path.join(pasta, "mista.json"), JSON.stringify({ reservado: itens.length, itens, ate: agora.v + 600000, em: agora.v }));
  const alvo = () => { const c = controleCom(arquivoEstado, agora, { jobVivo }); const r = c({ agentesLocais: 0 }); c.liberar(); return r; };
  grava([{ job: "Local\\MixAI-vazio" }, { pid: process.pid, inicio: par.inicioDoProcesso(process.pid) }]);
  assert.strictEqual(alvo(), teto - 2, "Job vazio + PID vivo: segue retida");
  assert.ok(fs.existsSync(path.join(pasta, "mista.json")));
  grava([{ job: "Local\\MixAI-vazio" }, { job: "Local\\MixAI-vivo" }]);
  assert.strictEqual(alvo(), teto - 2, "Job vazio + Job vivo: segue retida");
  grava([{ job: "Local\\MixAI-vazio" }, {}]);
  assert.strictEqual(alvo(), teto - 2, "Job vazio + item sem identificador (vale até `ate`): segue retida");
  grava([{ job: "Local\\MixAI-vazio" }, { pid: 2147483000 }]);
  assert.strictEqual(alvo(), teto, "todos resolvidos: a vaga volta");
  assert.ok(!fs.existsSync(path.join(pasta, "mista.json")));
}));

test("Windows de verdade: jobVivoPadrao encerra e confere um Job nomeado criado pelo wrapper (processo vivo antes, morto depois, false); Job inexistente também é false", async () => {
  if (process.platform !== "win32") return; // só o Windows tem Job Object: no PC este teste roda de verdade
  const { spawn } = require("node:child_process");
  const nome = `Local\\MixAI-teste-${process.pid}-${Date.now()}`;
  const filho = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(RAIZ, "orquestra", "job-windows.ps1")], { env: { ...process.env, MIXAI_COMANDO: "ping -n 60 127.0.0.1 >nul", MIXAI_JOB: nome }, stdio: "ignore", windowsHide: true });
  const saiu = new Promise((r) => filho.once("exit", r));
  try {
    await new Promise((r) => setTimeout(r, 5000));
    assert.strictEqual(filho.exitCode, null, "o comando está vivo dentro do Job");
    // a consulta encerra o job (TerminateJobObject) e só devolve false (resolvido) quando ele ficou vazio
    assert.strictEqual(par.jobVivoPadrao(nome), false, "Job encerrado e vazio");
    await Promise.race([saiu, new Promise((r) => setTimeout(r, 5000))]);
    assert.notStrictEqual(filho.exitCode ?? filho.signalCode, null, "o processo dentro do Job morreu");
    assert.strictEqual(par.jobVivoPadrao(`Local\\MixAI-inexistente-${Date.now()}`), false, "Job que não existe mais");
  } finally { try { filho.kill(); } catch { /* já foi */ } }
});

test("GPU/RAM: o coletor só conta como runner o nome exato do runner, nunca o ollama.exe do servidor", () => {
  const uso = fs.readFileSync(path.join(RAIZ, "local", "uso-windows.ps1"), "utf8");
  assert.match(uso, /-match '\^\(llama-server\|ollama_llama_server\|ollama-runner\)\(\\\.exe\)\?\$'/);
  assert.doesNotMatch(uso, /-match 'llama\|runner'/);
  const re = /^(llama-server|ollama_llama_server|ollama-runner)(\.exe)?$/i;
  for (const ok of ["llama-server.exe", "ollama_llama_server.exe", "ollama-runner.exe", "LLAMA-SERVER.EXE"]) assert.ok(re.test(ok), ok);
  for (const ruim of ["ollama.exe", "ollama app.exe", "llama-quantize.exe", "runner.exe", "my-runner.exe"]) assert.ok(!re.test(ruim), ruim);
});

test("chamada ainda pendente quando o lote desiste de esperar: a retenção guarda o Job e o PID dessa chamada, não só o id da microtarefa", async () => {
  const { spawn } = require("node:child_process");
  let filho;
  const arquivos = arquivosTemp();
  let recebido;
  const paralelismo = Object.assign(() => 2, { liberar: (r) => { recebido = r; } });
  const chamada = escada.chamarComando("setTimeout(()=>{},30000)", { plataforma: "win32", lancar: (c, fd) => (filho = spawn(process.execPath, ["-e", c], { stdio: [fd, "pipe", "pipe"] })), matar: () => true, orfaos: () => [], reintentoMs: 50, tentativasDeMatar: 100, prazoDeFechamentoMs: 600000 });
  // a parada é aceita mas a chamada nunca termina (descendente segurando): fica pendente
  // a microtarefa "b" falha com morte não confirmada (sem identificador); a "a" está pendente e é abortada sem nunca terminar
  const local = (prompt, signal) => (prompt.includes("contexto de b") ? new Promise((ok, no) => setTimeout(() => no(Object.assign(new Error("não morreu"), { naoConfirmado: true })), 150)) : chamada(prompt, signal));
  await assert.rejects(escada.lote({ microtarefas: [microDe("a"), microDe("b")], verificadorDe: verificadorOk, paralelismo, tempoParaConfirmarMs: 400, arquivos, agentes: { local, superiores: [] } }), /o lote parou/);
  try { filho.kill("SIGKILL"); } catch { /* já foi */ }
  assert.ok(recebido?.itens?.some((i) => i.pid === filho.pid && /^Local\\MixAI-/.test(i.jobNome)), JSON.stringify(recebido));
});
