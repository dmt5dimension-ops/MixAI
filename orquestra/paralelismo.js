// Quantos agentes locais (Qwen) rodam ao mesmo tempo, conforme o uso do PC.
// Usando o PC: 1. Parado: sobe um por vez até o que cabe na placa de vídeo, na memória e no modo dia/noite.
// A leitura do Windows fica atrás de um "leitor" ({ ler() }); os testes usam leituras simuladas.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const raiz = path.resolve(__dirname, '..');
const lerJson = (arq) => JSON.parse(fs.readFileSync(arq, 'utf8'));
const configPadrao = () => lerJson(path.join(__dirname, 'paralelismo.json'));
const modosPadrao = () => lerJson(path.join(raiz, 'local', 'modos.json'));
const minimoMemoriaGB = () => lerJson(path.join(raiz, 'local', 'protecao.json')).memoriaLivreMinimaGB;

// Quantos agentes cabem agora, e o que limita (o menor dos limites vale).
function capacidade({ modo, memoriaLivreGB, modos = modosPadrao(), config = configPadrao(), memoriaMinimaGB = minimoMemoriaGB() }) {
  const m = modos[modo];
  if (!m) throw new Error(`modo desconhecido: ${modo} (use ${Object.keys(modos).join(' ou ')})`);
  const kvGB = (config.placa.kvMBPorMilTokens * (m.contexto / 1000)) / 1024;
  const sobraPlacaGB = config.placa.vramGB - config.placa.reservaGB - config.placa.pesosGB;
  const limites = {
    modo: m.agentesMax,
    placa: Math.floor(sobraPlacaGB / kvGB),
    memoria: Math.floor((memoriaLivreGB - memoriaMinimaGB) / config.ramPorAgenteGB),
    absoluto: config.maximoAbsoluto,
  };
  // Zero é resposta válida: sem espaço na memória ou na placa, nenhum agente local agora (o lote espera abrir vaga).
  const max = Math.max(0, Math.min(...Object.values(limites)));
  const limitante = Object.entries(limites).sort((a, b) => a[1] - b[1])[0][0];
  return { max, limites, limitante };
}

// Motivos pelos quais o dono está usando o PC. Leitura que faltou, não é número ou está fora do possível
// conta como "usando" (o lado seguro): falha nunca pode virar "PC parado".
function numeroValido(v, minimo, maximo = Infinity) {
  return typeof v === 'number' && Number.isFinite(v) && v >= minimo && v <= maximo;
}
function motivosDeUso(leitura, config) {
  const o = config.ocupado;
  const indisponivel = ['leitura do Windows indisponível'];
  if (!leitura || typeof leitura !== 'object') return indisponivel;
  const ok = numeroValido(leitura.ociosoSegundos, 0) && numeroValido(leitura.gpuOutrosPct, 0, 100.0001)
    && numeroValido(leitura.cpuOutrosPct, 0, 100.0001) && numeroValido(leitura.videoDecodePct, 0, 100.0001)
    && numeroValido(leitura.memoriaLivreGB, 0);
  if (!ok) return indisponivel;
  const motivos = [];
  if (leitura.ociosoSegundos < o.ociosoAbaixoDeSegundos) motivos.push(`mexeu no PC há ${leitura.ociosoSegundos}s`);
  if (leitura.gpuOutrosPct > o.gpuOutrosAcimaDePct) motivos.push(`outro programa usa ${leitura.gpuOutrosPct}% da placa`);
  if (leitura.cpuOutrosPct > o.cpuOutrosAcimaDePct) motivos.push(`outros programas usam ${leitura.cpuOutrosPct}% do processador`);
  if (leitura.videoDecodePct >= o.videoDecodeAcimaDePct) motivos.push(`vídeo tocando (decodificador em ${leitura.videoDecodePct}%)`);
  return motivos;
}

// CPU de outros programas: total da máquina menos a parte do Ollama. O contador por processo vai de 0 a 100 POR
// NÚCLEO, então a parte do Ollama é dividida pelo número de núcleos. Falta de qualquer número vira null.
function cpuOutrosDe({ cpuTotalPct, cpuMeuPct, nucleos }) {
  if (!numeroValido(cpuTotalPct, 0) || !numeroValido(cpuMeuPct, 0) || !Number.isInteger(nucleos) || nucleos < 1) return null;
  return Math.round(Math.min(100, Math.max(0, cpuTotalPct - cpuMeuPct / nucleos)) * 10) / 10;
}

// Decide o alvo agora. `anterior` é { alvo, subiuEm } da última decisão (ou null). Sobe no máximo um por vez.
// `regime` é onde o alvo chega se o PC continuar parado (o teto), para quem só quer olhar.
function decidir({ leitura, modo, anterior = null, agora = Date.now(), modos, config = configPadrao(), memoriaMinimaGB }) {
  const motivos = motivosDeUso(leitura, config);
  const cap = capacidade({ modo, memoriaLivreGB: numeroValido(leitura?.memoriaLivreGB, 0) ? leitura.memoriaLivreGB : os.freemem() / 1024 ** 3, modos, config, memoriaMinimaGB });
  const antes = Number.isInteger(anterior?.alvo) && anterior.alvo >= 0 ? anterior.alvo : 1;
  if (motivos.length) {
    const alvo = Math.min(1, cap.max);
    return { alvo, regime: alvo, motivo: `usando o PC: ${motivos.join('; ')}${alvo === 0 ? ` (sem espaço para agente local: ${cap.limitante})` : ''}`, estado: { alvo, subiuEm: agora }, capacidade: cap };
  }
  if (antes > cap.max) {
    return { alvo: cap.max, regime: cap.max, motivo: `limite caiu para ${cap.max} (${cap.limitante})`, estado: { alvo: cap.max, subiuEm: agora }, capacidade: cap };
  }
  if (!anterior) {
    // Sem histórico (primeira chamada): o tempo que o PC já está parado conta como subida. Parado há 5 h não precisa
    // esperar 60 s por agente; parado há pouco começa baixo. Nunca passa do teto.
    const parado = leitura.ociosoSegundos - config.ocupado.ociosoAbaixoDeSegundos;
    const alvo = Math.min(cap.max, 1 + Math.max(0, Math.floor(parado / config.subidaMinSegundos)));
    return { alvo, regime: cap.max, motivo: alvo === cap.max ? `PC parado há ${leitura.ociosoSegundos}s: já no máximo (${cap.max}, limite: ${cap.limitante})` : `PC parado há ${leitura.ociosoSegundos}s: começa com ${alvo} de ${cap.max}`, estado: { alvo, subiuEm: agora }, capacidade: cap };
  }
  const podeSubir = antes < cap.max && agora - anterior.subiuEm >= config.subidaMinSegundos * 1000;
  const alvo = podeSubir ? antes + 1 : antes;
  const motivo = podeSubir ? `PC parado: sobe para ${alvo} de ${cap.max}` : antes === cap.max ? `PC parado: no máximo (${cap.max}, limite: ${cap.limitante})` : `PC parado: espera para subir (${antes} de ${cap.max})`;
  return { alvo, regime: cap.max, motivo, estado: { alvo, subiuEm: podeSubir ? agora : anterior.subiuEm }, capacidade: cap };
}

// Leitor real: roda local/uso-windows.ps1. Devolve null se o PowerShell não existe ou falha.
function leitorWindows() {
  return {
    ler() {
      const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(raiz, 'local', 'uso-windows.ps1')], { encoding: 'utf8', timeout: 30000 });
      if (r.error || r.status !== 0) return null;
      return lerSaida(r.stdout);
    },
  };
}

// Uso médio dos motores de DECODIFICAÇÃO de vídeo da placa, a partir das leituras cruas do uso-windows.ps1.
// Os nomes mudam por fabricante: "VideoDecode" (NVIDIA/Intel), "video decode" e "video codec 0" (AMD, este é
// o que mexe quando um vídeo toca). "video jpeg" e "video enhance" ficam de fora. Precisa de pelo menos
// `amostrasMinimas` leituras e de pelo menos um motor de vídeo; senão devolve null (leitura indisponível).
const motorDeDecodificacao = /engtype_(?:video\s*decode|video\s*codec)/i;
function videoDecodeDe({ amostras, motores }, amostrasMinimas = 3) {
  if (!Number.isInteger(amostras) || amostras < amostrasMinimas) return null;
  const lista = Array.isArray(motores) ? motores : motores ? [motores] : [];
  const videos = lista.filter((m) => /video/i.test(String(m?.n)));
  if (!videos.length) return null;
  // Toda leitura de motor de vídeo tem que ser um número válido, de uma das amostras, e cada amostra tem que
  // ter pelo menos um motor de vídeo. Leitura inválida ou faltando não pode virar zero (= "sem vídeo").
  const vistas = new Set();
  const soma = new Array(amostras).fill(0);
  for (const m of videos) {
    if (!Number.isInteger(m.i) || m.i < 0 || m.i >= amostras || !numeroValido(m.v, 0, 100.0001)) return null;
    vistas.add(m.i);
    if (motorDeDecodificacao.test(String(m.n))) soma[m.i] += m.v;
  }
  if (vistas.size !== amostras) return null;
  return Math.round((soma.reduce((a, b) => a + b, 0) / amostras) * 100) / 100;
}

// Interpreta o que o uso-windows.ps1 imprimiu (a última linha é o JSON). Texto estranho vira null.
function lerSaida(texto) {
  let l;
  try { l = JSON.parse(String(texto).trim().split(/\r?\n/).pop()); } catch { return null; }
  if (!l || typeof l !== 'object' || Array.isArray(l)) return null;
  const { videoAmostras, videoMotores, cpuTotalPct, cpuMeuPct, nucleos, ...resto } = l;
  return {
    ...resto,
    cpuOutrosPct: resto.cpuOutrosPct ?? cpuOutrosDe({ cpuTotalPct, cpuMeuPct, nucleos }),
    videoDecodePct: resto.videoDecodePct ?? videoDecodeDe({ amostras: videoAmostras, motores: videoMotores }),
  };
}

// Leitor para testes: devolve as leituras da lista, na ordem (a última se repete).
function leitorSimulado(leituras) {
  let i = 0;
  return { ler: () => leituras[Math.min(i++, leituras.length - 1)] };
}

// Modo que o local/modo.ps1 deixou ligado; sem informação, o dia (o mais cauteloso).
function modoAtual(env = process.env) {
  if (env.MIXAI_MODO) return env.MIXAI_MODO;
  const base = env.LOCALAPPDATA;
  try { return fs.readFileSync(path.join(base, 'Ollama', 'mixai-modo.txt'), 'utf8').trim() || 'dia'; } catch { return 'dia'; }
}

// Função sem argumentos para o `lote` chamar sempre que for abrir vaga: lê o PC, decide e guarda o estado.
function criarControle({ leitor = leitorWindows(), modo = modoAtual(), arquivoEstado = path.join(os.tmpdir(), 'mixai-paralelismo.json'), relogio = Date.now, cacheMs = 5000, modos, config, aoDecidir } = {}) {
  let ultimo = null;
  return () => {
    // O lote pergunta a cada vaga; ler o Windows custa um PowerShell, então reaproveita a resposta recente.
    if (ultimo && relogio() - ultimo.em < cacheMs) return ultimo.alvo;
    let anterior = null;
    try { anterior = lerJson(arquivoEstado); } catch { /* primeira vez */ }
    const d = decidir({ leitura: leitor.ler(), modo, anterior, agora: relogio(), modos, config });
    try { fs.writeFileSync(arquivoEstado, JSON.stringify(d.estado)); } catch { /* sem estado, só não sobe devagar */ }
    if (aoDecidir && d.alvo !== ultimo?.alvo) aoDecidir(d);
    ultimo = { em: relogio(), alvo: d.alvo };
    return d.alvo;
  };
}

module.exports = { capacidade, motivosDeUso, decidir, leitorWindows, lerSaida, videoDecodeDe, cpuOutrosDe, leitorSimulado, modoAtual, criarControle };

if (require.main === module) {
  const i = process.argv.indexOf('--modo');
  const modo = i >= 0 ? process.argv[i + 1] : modoAtual();
  const leitura = leitorWindows().ler();
  const d = decidir({ leitura, modo });
  console.log(JSON.stringify({ modo, leitura, alvo: d.alvo, regime: d.regime, motivo: d.motivo, capacidade: d.capacidade, subida: `+1 a cada ${configPadrao().subidaMinSegundos}s com o PC parado` }, null, 2));
}
