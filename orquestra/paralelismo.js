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
  const max = Math.max(1, Math.min(...Object.values(limites)));
  const limitante = Object.entries(limites).sort((a, b) => a[1] - b[1])[0][0];
  return { max, limites, limitante };
}

// Motivos pelos quais o dono está usando o PC. Leitura que faltou conta como "usando" (o seguro).
function motivosDeUso(leitura, config) {
  const o = config.ocupado;
  const campos = ['ociosoSegundos', 'gpuOutrosPct', 'cpuOutrosPct', 'videoTocando', 'memoriaLivreGB'];
  if (!leitura || campos.some((c) => leitura[c] === undefined || leitura[c] === null)) return ['leitura do Windows indisponível'];
  const motivos = [];
  if (leitura.ociosoSegundos < o.ociosoAbaixoDeSegundos) motivos.push(`mexeu no PC há ${leitura.ociosoSegundos}s`);
  if (leitura.gpuOutrosPct > o.gpuOutrosAcimaDePct) motivos.push(`outro programa usa ${leitura.gpuOutrosPct}% da placa`);
  if (leitura.cpuOutrosPct > o.cpuOutrosAcimaDePct) motivos.push(`outros programas usam ${leitura.cpuOutrosPct}% do processador`);
  if (leitura.videoTocando) motivos.push('vídeo tocando');
  return motivos;
}

// Decide o alvo agora. `anterior` é { alvo, subiuEm } da última decisão (ou null). Sobe no máximo um por vez.
function decidir({ leitura, modo, anterior = null, agora = Date.now(), modos, config = configPadrao(), memoriaMinimaGB }) {
  const motivos = motivosDeUso(leitura, config);
  const cap = capacidade({ modo, memoriaLivreGB: leitura?.memoriaLivreGB ?? os.freemem() / 1024 ** 3, modos, config, memoriaMinimaGB });
  const antes = anterior?.alvo >= 1 ? anterior.alvo : 1;
  if (motivos.length) {
    return { alvo: 1, motivo: `usando o PC: ${motivos.join('; ')}`, estado: { alvo: 1, subiuEm: agora }, capacidade: cap };
  }
  if (antes > cap.max) {
    return { alvo: cap.max, motivo: `limite caiu para ${cap.max} (${cap.limitante})`, estado: { alvo: cap.max, subiuEm: agora }, capacidade: cap };
  }
  if (!anterior) return { alvo: 1, motivo: 'PC parado: começa com 1', estado: { alvo: 1, subiuEm: agora }, capacidade: cap };
  const podeSubir = antes < cap.max && agora - anterior.subiuEm >= config.subidaMinSegundos * 1000;
  const alvo = podeSubir ? antes + 1 : antes;
  const motivo = podeSubir ? `PC parado: sobe para ${alvo} de ${cap.max}` : antes === cap.max ? `PC parado: no máximo (${cap.max}, limite: ${cap.limitante})` : `PC parado: espera para subir (${antes} de ${cap.max})`;
  return { alvo, motivo, estado: { alvo, subiuEm: podeSubir ? agora : anterior.subiuEm }, capacidade: cap };
}

// Leitor real: roda local/uso-windows.ps1. Devolve null se o PowerShell não existe ou falha.
function leitorWindows() {
  return {
    ler() {
      const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(raiz, 'local', 'uso-windows.ps1')], { encoding: 'utf8', timeout: 30000 });
      if (r.error || r.status !== 0) return null;
      try { return JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); } catch { return null; }
    },
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

module.exports = { capacidade, motivosDeUso, decidir, leitorWindows, leitorSimulado, modoAtual, criarControle };

if (require.main === module) {
  const i = process.argv.indexOf('--modo');
  const modo = i >= 0 ? process.argv[i + 1] : modoAtual();
  const leitura = leitorWindows().ler();
  const d = decidir({ leitura, modo });
  console.log(JSON.stringify({ modo, leitura, alvo: d.alvo, motivo: d.motivo, capacidade: d.capacidade }, null, 2));
}
