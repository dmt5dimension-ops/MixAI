// Quantos agentes locais (Qwen) rodam ao mesmo tempo, conforme o uso do PC.
// Usando o PC: 1. Parado: sobe um por vez (na primeira decisão o tempo que o PC já está parado conta como subida) até o que cabe
// na placa de vídeo (medida: o que outros programas já ocupam sai da sobra), na memória e no modo dia/noite.
// A leitura do Windows fica atrás de um "leitor" ({ ler() }); os testes usam leituras simuladas.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFile } = require('node:child_process');

const raiz = path.resolve(__dirname, '..');
const lerJson = (arq) => JSON.parse(fs.readFileSync(arq, 'utf8'));
const configPadrao = () => lerJson(path.join(__dirname, 'paralelismo.json'));
const modosPadrao = () => lerJson(path.join(raiz, 'local', 'modos.json'));
const minimoMemoriaGB = () => lerJson(path.join(raiz, 'local', 'protecao.json')).memoriaLivreMinimaGB;

// Quantos agentes cabem agora, e o que limita (o menor dos limites vale).
function capacidade({ modo, memoriaLivreGB, agentesAtuais = 0, vramOutrosGB = null, ramMeuGB = null, modos = modosPadrao(), config = configPadrao(), memoriaMinimaGB = minimoMemoriaGB() }) {
  const m = modos[modo];
  if (!m) throw new Error(`modo desconhecido: ${modo} (use ${Object.keys(modos).join(' ou ')})`);
  const kvGB = (config.placa.kvMBPorMilTokens * (m.contexto / 1000)) / 1024;
  // VRAM medida: o que OUTROS programas já ocupam na placa sai da sobra. Sem medida (null) vale só a reserva fixa da config
  // (limite conhecido: não enxerga outro programa na placa).
  const vramMedida = numeroValido(vramOutrosGB, 0, config.placa.vramGB * 2);
  const sobraPlacaGB = config.placa.vramGB - config.placa.reservaGB - (vramMedida ? vramOutrosGB : 0) - config.placa.pesosGB;
  // A parte da memória que se soma de volta é a dos agentes que rodam agora, limitada ao que o Ollama do MixAI realmente
  // ocupa (medido): não credita memória a agente que ainda não ocupa nada.
  const credito = numeroValido(ramMeuGB, 0) ? Math.min(agentesAtuais * config.ramPorAgenteGB, ramMeuGB) : agentesAtuais * config.ramPorAgenteGB;
  const limites = {
    modo: m.agentesMax,
    placa: Math.max(0, Math.floor(sobraPlacaGB / kvGB)),
    // A memória livre já está reduzida pelos agentes que rodam agora: soma de volta a parte deles, senão o teto cai a cada
    // agente aberto e o lote aborta e reinicia em loop perto do mínimo.
    memoria: Math.max(0, Math.floor((memoriaLivreGB + credito - memoriaMinimaGB) / config.ramPorAgenteGB)),
    absoluto: config.maximoAbsoluto,
  };
  // Zero é resposta válida: sem espaço na memória ou na placa, nenhum agente local agora (o lote espera abrir vaga).
  const max = Math.max(0, Math.min(...Object.values(limites)));
  const limitante = Object.entries(limites).sort((a, b) => a[1] - b[1])[0][0];
  return { max, limites, limitante, vramMedida };
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
    && numeroValido(leitura.memoriaLivreGB, 0)
    && (leitura.playersCpuPct === undefined || numeroValido(leitura.playersCpuPct, 0));
  if (!ok) return indisponivel;
  const motivos = [];
  if (leitura.ociosoSegundos < o.ociosoAbaixoDeSegundos) motivos.push(`mexeu no PC há ${leitura.ociosoSegundos}s`);
  if (leitura.gpuOutrosPct > o.gpuOutrosAcimaDePct) motivos.push(`outro programa usa ${leitura.gpuOutrosPct}% da placa`);
  if (leitura.cpuOutrosPct > o.cpuOutrosAcimaDePct) motivos.push(`outros programas usam ${leitura.cpuOutrosPct}% do processador`);
  if (leitura.videoDecodePct >= o.videoDecodeAcimaDePct) motivos.push(`vídeo tocando (decodificador em ${leitura.videoDecodePct}%)`);
  // Indício de mídia por software (o decodificador da placa não mexe): CPU de um player de vídeo conhecido (vlc, mpv, ffplay...).
  // Navegador tocando vídeo NÃO é detectado (não dá para separar do uso comum do navegador).
  if (leitura.playersCpuPct !== undefined && leitura.playersCpuPct >= o.playerCpuAcimaDePct) motivos.push(`player de vídeo ativo (${leitura.playersCpuPct}% de um núcleo)`);
  return motivos;
}

// CPU de outros programas: total da máquina menos a parte do Ollama. O contador por processo vai de 0 a 100 POR
// NÚCLEO, então a parte do Ollama é dividida pelo número de núcleos. Falta de qualquer número vira null.
function cpuOutrosDe({ cpuTotalPct, cpuMeuPct, nucleos }) {
  if (!Number.isInteger(nucleos) || nucleos < 1) return null;
  // Impossível (total acima de 100% ou Ollama acima de 100% por núcleo) é leitura quebrada, não "zero": vira null.
  if (!numeroValido(cpuTotalPct, 0, 100.0001) || !numeroValido(cpuMeuPct, 0, 100.0001 * nucleos)) return null;
  // A parte do Ollama não pode passar do total da máquina (com folga de 10 pontos pela diferença de janelas de amostragem): se passar,
  // a diferença negativa viraria "zero de outros" e declararia o PC livre. Leitura inconsistente = null.
  if (cpuMeuPct / nucleos > cpuTotalPct + 10) return null;
  return Math.round(Math.min(100, Math.max(0, cpuTotalPct - cpuMeuPct / nucleos)) * 10) / 10;
}

// Decide o alvo agora. `anterior` é { alvo, subiuEm } da última decisão (ou null). Sobe no máximo um por vez.
// `regime` é onde o alvo chega se o PC continuar parado (o teto), para quem só quer olhar.
function decidir({ leitura, modo, agentesAtuais = 0, anterior = null, agora = Date.now(), modos, config = configPadrao(), memoriaMinimaGB }) {
  const motivos = motivosDeUso(leitura, config);
  const cap = capacidade({ modo, memoriaLivreGB: numeroValido(leitura?.memoriaLivreGB, 0) ? leitura.memoriaLivreGB : os.freemem() / 1024 ** 3, agentesAtuais, vramOutrosGB: leitura?.vramOutrosGB, ramMeuGB: leitura?.ramMeuGB, modos, config, memoriaMinimaGB });
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
// `ler()` bloqueia (só para o uso na linha de comando); `lerAsync()` não bloqueia o Node (é o que o controle usa dentro do
// lote, onde um bloqueio de até 30 s atrasaria abortos, temporizadores e os outros agentes).
function leitorWindows({ executar = execFile } = {}) {
  return {
    lerAsync() {
      return new Promise((resolve) => {
        executar('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(raiz, 'local', 'uso-windows.ps1')], { encoding: 'utf8', timeout: 30000, windowsHide: true }, (erro, stdout, stderr) => {
          // Erro do coletor (mesmo não terminante, escrito na saída de erro) = leitura incompleta: indisponível.
          resolve(erro || String(stderr ?? '').trim() ? null : lerSaida(stdout));
        });
      });
    },
    ler() {
      const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(raiz, 'local', 'uso-windows.ps1')], { encoding: 'utf8', timeout: 30000 });
      if (r.error || r.status !== 0 || String(r.stderr ?? '').trim()) return null;
      return lerSaida(r.stdout);
    },
  };
}

// Uso médio dos motores de DECODIFICAÇÃO de vídeo da placa, a partir das leituras cruas do uso-windows.ps1.
// Os nomes mudam por fabricante: "VideoDecode" (NVIDIA/Intel), "video decode" e "video codec 0" (AMD, este é
// o que mexe quando um vídeo toca). "video jpeg" e "video enhance" ficam de fora. Precisa de pelo menos
// `amostrasMinimas` leituras; sem motor de decodificação nelas devolve 0 (sem vídeo); falha de coleta devolve null.
const motorDeDecodificacao = /engtype_(?:video\s*decode|video\s*codec)/i;
function videoDecodeDe({ amostras, motores }, amostrasMinimas = 3) {
  if (!Number.isInteger(amostras) || amostras < amostrasMinimas) return null;
  const lista = Array.isArray(motores) ? motores : motores ? [motores] : [];
  const videos = lista.filter((m) => /video/i.test(String(m?.n)));
  // Coleta válida sem nenhum motor de decodificação (a placa não expõe, ou só jpeg/enhance): conta como "sem vídeo" (0).
  // Só falha de coleta (amostras insuficientes, leitura inválida) vira null.
  if (!videos.some((m) => motorDeDecodificacao.test(String(m?.n)))) return 0;
  // Toda leitura de motor de vídeo tem que ser um número válido, de uma das amostras, e cada amostra tem que
  // ter pelo menos um motor de vídeo. Leitura inválida ou faltando não pode virar zero (= "sem vídeo").
  const vistas = new Set(); // amostras que tiveram motor de DECODIFICAÇÃO
  const soma = new Array(amostras).fill(0);
  for (const m of videos) {
    if (!Number.isInteger(m.i) || m.i < 0 || m.i >= amostras || !numeroValido(m.v, 0, 100.0001)) return null;
    if (motorDeDecodificacao.test(String(m.n))) { vistas.add(m.i); soma[m.i] += m.v; }
  }
  if (vistas.size !== amostras) return null;
  return Math.round((soma.reduce((a, b) => a + b, 0) / amostras) * 100) / 100;
}

// Ocupação da placa por OUTROS programas: o coletor soma, por amostra e por tipo de motor (3D, Copy, Compute, vídeo...), o uso
// dos processos que não são do MixAI. A ocupação é a do motor mais carregado de cada amostra (como no Gerenciador de Tarefas),
// depois a média das amostras; somar motores diferentes contaria duas vezes o mesmo trabalho. `amostras` é a quantidade de amostras em que o
// coletor provou ter lido os motores (0 = coleta sem cobertura). Linha inválida ou de amostra inexistente é null.
function gpuOutrosDe({ amostras, linhas }, amostrasMinimas = 3) {
  if (!Number.isInteger(amostras) || amostras < amostrasMinimas) return null;
  const lista = Array.isArray(linhas) ? linhas : [];
  const porAmostra = Array.from({ length: amostras }, () => new Map());
  for (const l of lista) {
    if (!l || typeof l.t !== 'string' || !l.t || !Number.isInteger(l.i) || l.i < 0 || l.i >= amostras || !numeroValido(l.v, 0)) return null;
    porAmostra[l.i].set(l.t, (porAmostra[l.i].get(l.t) ?? 0) + l.v);
  }
  // O motor mais carregado EM CADA amostra, e só depois a média: 3D e Copy alternando a 90% é uma placa a 90%, não a 60%.
  const maximos = porAmostra.map((tipos) => Math.min(100, Math.max(0, ...tipos.values())));
  return Math.round((maximos.reduce((a, b) => a + b, 0) / amostras) * 10) / 10;
}

// Interpreta o que o uso-windows.ps1 imprimiu (a última linha é o JSON). Texto estranho vira null.
function lerSaida(texto) {
  let l;
  try { l = JSON.parse(String(texto).trim().split(/\r?\n/).pop()); } catch { return null; }
  if (!l || typeof l !== 'object' || Array.isArray(l)) return null;
  const { videoAmostras, videoMotores, cpuTotalPct, cpuMeuPct, nucleos, gpuAmostras, gpuPorTipo, ...resto } = l;
  return {
    ...resto,
    gpuOutrosPct: resto.gpuOutrosPct ?? gpuOutrosDe({ amostras: gpuAmostras, linhas: gpuPorTipo }),
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

// Reserva de vagas entre lotes. Cada controle (um por lote) guarda numa pasta compartilhada um arquivo com o que RESERVOU
// (a vaga concedida, nunca menos que os agentes que ainda estão vivos, inclusive os morrendo), o PID e o relógio do último
// batimento. Ler os outros, decidir e gravar a própria reserva acontece dentro de uma trava (mkdir atômico), então dois lotes
// juntos nunca passam do teto: o que sobra para um é o teto menos o que os outros reservaram. Reserva de lote que morreu
// (PID inexistente) ou sem batimento há mais de VALIDADE_LOTE_MS é descartada.
const VALIDADE_LOTE_MS = 60000;
const pidVivo = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const esperaCurta = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* sem espera, só tenta de novo */ } };
function criarReserva({ pasta, relogio }) {
  const id = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const trava = `${pasta}.trava`;
  const meu = path.join(pasta, `${id}.json`);
  const comTrava = (corpo) => {
    let tem = false;
    for (let i = 0; i < 80 && !tem; i++) {
      try { fs.mkdirSync(trava); tem = true; } catch (e) {
        if (e.code !== 'EEXIST') return null;
        try { if (Date.now() - fs.statSync(trava).mtimeMs > 10000) fs.rmdirSync(trava); } catch { /* sumiu */ } // trava de quem morreu
        esperaCurta(25);
      }
    }
    if (!tem) return null;
    try { return corpo(); } finally { try { fs.rmdirSync(trava); } catch { /* já foi */ } }
  };
  const liberar = () => { try { fs.unlinkSync(meu); } catch { /* não havia */ } };
  process.once('exit', liberar);
  // Devolve a vaga concedida (0..alvo), ou null se não conseguiu coordenar (quem chama só mantém, nunca sobe).
  const reservar = ({ alvo, agentes, teto }) => comTrava(() => {
    fs.mkdirSync(pasta, { recursive: true });
    let outros = 0;
    for (const nome of fs.readdirSync(pasta)) {
      if (!nome.endsWith('.json') || nome === `${id}.json`) continue;
      const arq = path.join(pasta, nome);
      let valida = false;
      let r = null;
      try {
        r = JSON.parse(fs.readFileSync(arq, 'utf8'));
        valida = r && Number.isInteger(r.reservado) && r.reservado >= 0 && Number.isInteger(r.pid) && numeroValido(r.em, 0) && relogio() - r.em <= VALIDADE_LOTE_MS && pidVivo(r.pid);
      } catch { valida = false; }
      if (valida) outros += r.reservado; else { try { fs.unlinkSync(arq); } catch { /* já foi */ } }
    }
    const concedido = Math.max(0, Math.min(alvo, teto - outros));
    const temporario = `${meu}.tmp`;
    fs.writeFileSync(temporario, JSON.stringify({ reservado: Math.max(concedido, agentes), pid: process.pid, em: relogio() }), { mode: 0o600 });
    fs.renameSync(temporario, meu);
    return concedido;
  });
  return { reservar, liberar };
}

// Função sem argumentos para o `lote` chamar sempre que for abrir vaga: lê o PC, decide e guarda o estado.
function criarControle({ leitor = leitorWindows(), modo = modoAtual(), arquivoEstado = path.join(os.tmpdir(), 'mixai-paralelismo.json'), relogio = Date.now, cacheMs = 5000, refrescarMs = 0, pastaLotes = `${arquivoEstado}.lotes`, modos, config, aoDecidir } = {}) {
  let ultimo = null;
  const reserva = criarReserva({ pasta: pastaLotes, relogio });
  // Leitor assíncrono: a leitura roda em segundo plano e a decisão usa a última pronta. Sem leitura recente (a primeira
  // vez, ou uma que demorou demais) vale "indisponível" = usando o PC = 1 agente.
  let pronta = null;
  let lendo = false;
  let idadeDaLeitura = 0; // só o leitor assíncrono tem idade; a leitura síncrona é sempre do momento
  let ultimaChamada = null;
  const iniciarLeitura = () => {
    if (lendo) return;
    lendo = true;
    Promise.resolve().then(() => leitor.lerAsync()).then((l) => { pronta = { em: relogio(), leitura: l }; }, () => { pronta = { em: relogio(), leitura: null }; }).finally(() => {
      lendo = false;
      // Enquanto o lote está usando o controle, mantém a leitura fresca em segundo plano (para a descida não esperar a próxima
      // reavaliação só para ler); o timer não segura o Node.
      if (refrescarMs > 0 && ultimaChamada !== null && relogio() - ultimaChamada < 60000) { const t = setTimeout(iniciarLeitura, refrescarMs); t.unref?.(); }
    });
  };
  const leituraAtual = () => {
    if (!leitor.lerAsync) return leitor.ler();
    iniciarLeitura();
    idadeDaLeitura = pronta ? relogio() - pronta.em : Infinity;
    return pronta && idadeDaLeitura < 4 * cacheMs ? pronta.leitura : null;
  };
  const controle = ({ agentesLocais = 0 } = {}) => {
    ultimaChamada = relogio();
    // O lote pergunta a cada vaga; ler o Windows custa um PowerShell, então reaproveita a resposta recente. Mas nunca esconde
    // uma leitura NOVA que chegou depois da última decisão: na descida (o dono voltou) o cache não vale.
    if (ultimo && relogio() - ultimo.em < cacheMs && !(pronta && pronta.em > ultimo.em)) return ultimo.alvo;
    // O estado de uma execução antiga não vale para um lote novo: depois de `validadeEstadoSegundos` sem uso, recomeça do zero.
    let anterior = null;
    try {
      anterior = lerJson(arquivoEstado);
      const validade = (config ?? configPadrao()).validadeEstadoSegundos ?? 300;
      // Estado estrito: objeto com alvo inteiro, subiuEm e gravadoEm numéricos e o MESMO modo (outro modo ou lixo recomeça).
      if (!anterior || typeof anterior !== 'object' || anterior.modo !== modo || !Number.isInteger(anterior.alvo) || anterior.alvo < 0 || !numeroValido(anterior.subiuEm, 0)) anterior = null;
      else if (!numeroValido(anterior?.gravadoEm, 0) || relogio() - anterior.gravadoEm > validade * 1000 || relogio() < anterior.gravadoEm) anterior = null;
    } catch { anterior = null; /* primeira vez */ }
    const d = decidir({ leitura: leituraAtual(), modo, agentesAtuais: agentesLocais, anterior, agora: relogio(), modos, config });
    // Primeira decisão com leitura assíncrona ainda não pronta: vale 1 agente, mas não grava estado nem guarda cache, para a
    // leitura que chegar depois seguir o ramo da subida inicial (como se fosse a primeira decisão de verdade).
    // Vaga entre lotes: o que sobra do teto depois do que os outros lotes reservaram (null = não deu para coordenar: só mantém).
    const reservar = (alvo) => { const r = reserva.reservar({ alvo, agentes: agentesLocais, teto: d.capacidade.max }); return r === null ? Math.min(alvo, Math.max(agentesLocais, 1)) : r; };
    if (leitor.lerAsync && !pronta) return reservar(d.alvo);
    // Para SUBIR o número de agentes a leitura tem que ser recente (menos de `cacheMs`); com amostra velha só mantém ou reduz
    // (o piso de 1 agente continua valendo) e o estado de subida não é gravado.
    if (leitor.lerAsync && idadeDaLeitura >= cacheMs && d.alvo > Math.max(agentesLocais, 1)) return reservar(Math.max(agentesLocais, 1));
    // Leitura velha demais para provar que o PC continua livre (2 x cache) com vários agentes rodando: a leitura nova já foi
    // pedida acima, e enquanto ela não chega reduz na hora para 1 (a descida nunca espera o cache).
    if (leitor.lerAsync && idadeDaLeitura >= 2 * cacheMs && agentesLocais > 1) return reservar(1);
    // Escrita atômica (arquivo temporário + rename): outra instância nunca lê JSON truncado.
    try {
      const temporario = `${arquivoEstado}.${process.pid}.tmp`;
      fs.writeFileSync(temporario, JSON.stringify({ ...d.estado, modo, gravadoEm: relogio() }), { mode: 0o600 });
      fs.renameSync(temporario, arquivoEstado);
    } catch { /* sem estado, só não sobe devagar */ }
    const alvoFinal = reservar(d.alvo);
    if (aoDecidir && alvoFinal !== ultimo?.alvo) aoDecidir({ ...d, alvo: alvoFinal, motivo: alvoFinal === d.alvo ? d.motivo : `${d.motivo}; vagas reservadas por outros lotes: ${alvoFinal} de ${d.alvo}` });
    ultimo = { em: relogio(), alvo: alvoFinal };
    return alvoFinal;
  };
  controle.liberar = reserva.liberar;
  return controle;
}

module.exports = { capacidade, motivosDeUso, decidir, leitorWindows, lerSaida, videoDecodeDe, cpuOutrosDe, gpuOutrosDe, leitorSimulado, modoAtual, criarControle };

if (require.main === module) {
  const i = process.argv.indexOf('--modo');
  const modo = i >= 0 ? process.argv[i + 1] : modoAtual();
  const leitura = leitorWindows().ler();
  const d = decidir({ leitura, modo });
  console.log(JSON.stringify({ modo, leitura, alvo: d.alvo, regime: d.regime, motivo: d.motivo, capacidade: d.capacidade, subida: `na primeira decisão o tempo que o PC já está parado conta (1 agente por ${configPadrao().subidaMinSegundos}s); depois +1 a cada ${configPadrao().subidaMinSegundos}s com o PC parado` }, null, 2));
}
