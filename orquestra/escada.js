// Escada do modelo local: tarefa bem delimitada vai primeiro ao mixai-local.
// Se errar, sobe para Codex ou Claude; a solução vira regra com exemplo; o local tenta de novo com a regra.
// Se acertar, a regra fica salva para as próximas vezes. Todo caso resolvido é registrado para treino futuro (LoRA).
// Quem decide se a tarefa "cabe no local" é o Claude (o 7B erra ao julgar tamanho de tarefa).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const pasta = __dirname;
const ARQUIVOS = {
  regras: path.join(pasta, 'regras-locais.json'),
  casos: path.join(pasta, 'casos', 'casos.jsonl'),
  treino: path.join(pasta, 'casos', 'treino.jsonl'),
  falhas: path.join(pasta, 'falhas', 'falhas.jsonl'),
  pendentes: path.join(pasta, 'falhas', 'pendentes.jsonl'),
};

function lerRegras(arquivo) {
  if (!fs.existsSync(arquivo)) return [];
  try {
    const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    return Array.isArray(dados.regras) ? dados.regras : [];
  } catch (erro) {
    if (erro instanceof SyntaxError) throw new Error(`${arquivo} está com JSON inválido; conserte antes de continuar (nada foi apagado).`);
    throw erro;
  }
}

function salvarRegra(arquivo, regra) {
  const regras = lerRegras(arquivo);
  const ids = new Set(regras.map((r) => r.id));
  let id = regra.id;
  for (let n = 2; ids.has(id); n += 1) id = `${regra.id}-${n}`; // nunca sobrescreve regra existente
  regras.push({ ...regra, id });
  regra.id = id;
  let aviso;
  try {
    aviso = JSON.parse(fs.readFileSync(arquivo, 'utf8')).aviso;
  } catch (erro) {
    aviso = undefined;
  }
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, JSON.stringify({ aviso, regras }, null, 2) + '\n');
}

function escolherRegras(regras, entrada) {
  const texto = String(entrada).toLowerCase();
  return regras.filter((r) => r.status === 'confirmada' &&
    (r.palavras || []).some((p) => texto.includes(String(p).toLowerCase())));
}

function montarPrompt(entrada, regras) {
  const partes = [];
  if (regras.length) {
    partes.push('Siga estas regras da casa:');
    for (const r of regras) {
      partes.push(`- ${r.regra}\n  Exemplo: entrada "${r.exemplo.entrada}" -> saída "${r.exemplo.saida}"`);
    }
    partes.push('');
  }
  partes.push('Tarefa:', entrada, '', 'Responda só com o resultado, sem explicação.');
  return partes.join('\n');
}

function promptRegra(entrada, saidaErrada, saidaCerta) {
  return [
    'Um modelo pequeno errou esta tarefa. Escreva a REGRA curta (uma ou duas frases) que o faria acertar esta e tarefas parecidas.',
    `Tarefa: ${entrada}`,
    `Saída errada do modelo pequeno: ${saidaErrada}`,
    `Saída certa: ${saidaCerta}`,
    'Responda só com JSON: {"id":"nome-curto-com-hifens","palavras":["palavras que aparecem em tarefas desse tipo"],"regra":"...","exemplo":{"entrada":"...","saida":"..."}}',
  ].join('\n');
}

function lerRegraGerada(texto) {
  const m = String(texto).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const r = JSON.parse(m[0]);
    if (!r.id || !r.regra || !Array.isArray(r.palavras) || r.palavras.length === 0 ||
        !r.exemplo || typeof r.exemplo.entrada !== 'string' || typeof r.exemplo.saida !== 'string') return null;
    return { id: String(r.id), palavras: r.palavras.map(String), regra: String(r.regra), exemplo: r.exemplo };
  } catch (erro) {
    if (erro instanceof SyntaxError) return null;
    throw erro;
  }
}

function registrarCaso(arquivo, caso) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.appendFileSync(arquivo, JSON.stringify(caso) + '\n');
}

function lerCasos(arquivo) {
  if (!fs.existsSync(arquivo)) return [];
  return fs.readFileSync(arquivo, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

// Par entrada/saída certa, sem a regra: o treino quer que o modelo aprenda a regra, não a leia.
function paraTreino(caso) {
  return { messages: [{ role: 'user', content: caso.entrada }, { role: 'assistant', content: caso.saida }] };
}

async function tentar(chamar, prompt) {
  try {
    const saida = await chamar(prompt);
    return typeof saida === 'string' ? saida.trim() : null;
  } catch (erro) {
    return null; // sem cota ou falha: o chamador tenta o próximo
  }
}

// O grande resolveu depois de o local errar: pede a regra, deixa o local tentar de novo com ela e só salva se ele acertar.
async function aprenderRegra({ entrada, saidaLocal, saida, nome, chamarSuperior, usadas, ok, agentes, arquivos, data }) {
  const candidata = lerRegraGerada(await tentar(chamarSuperior, promptRegra(entrada, saidaLocal, saida)));
  if (!candidata) return { regra: null, regraSalva: null };
  const segunda = await tentar(agentes.local, montarPrompt(entrada, [...usadas, { ...candidata, status: 'confirmada' }]));
  const funcionou = segunda !== null && (await ok(segunda));
  const regra = { ...candidata, status: funcionou ? 'confirmada' : 'descartada' };
  if (!funcionou) return { regra, regraSalva: null };
  const nova = { ...regra, criadaEm: data, origem: nome };
  salvarRegra(arquivos.regras, nova);
  return { regra: nova, regraSalva: nova.id };
}

async function resolver({ entrada, cabeNoLocal, verificar, agentes, arquivos = ARQUIVOS }) {
  if (typeof verificar !== 'function') throw new Error('Sem verificador não há como saber se a resposta está certa.');
  const ok = async (saida) => (await verificar(saida)).ok === true;
  const usadas = escolherRegras(lerRegras(arquivos.regras), entrada);
  const ids = usadas.map((r) => r.id);
  const base = { entrada, data: new Date().toISOString() };
  let saidaLocal = null;

  if (cabeNoLocal) {
    saidaLocal = await tentar(agentes.local, montarPrompt(entrada, usadas));
    if (saidaLocal !== null && (await ok(saidaLocal))) {
      registrarCaso(arquivos.casos, { ...base, regra: usadas[0] || null, regrasUsadas: ids, saida: saidaLocal, resolvidoPor: 'local' });
      return { ok: true, resolvidoPor: 'local', saida: saidaLocal, regrasUsadas: ids, regraSalva: null };
    }
  }

  let nome = null;
  let chamarSuperior = null;
  let saida = null;
  for (const s of agentes.superiores) {
    const tentativa = await tentar(s.chamar, montarPrompt(entrada, []));
    if (tentativa !== null && (await ok(tentativa))) {
      nome = s.nome;
      chamarSuperior = s.chamar;
      saida = tentativa;
      break;
    }
  }
  if (!nome) return { ok: false, resolvidoPor: null, saida: null, regrasUsadas: ids, regraSalva: null };

  let regra = null;
  let regraSalva = null;
  if (cabeNoLocal && saidaLocal !== null) {
    ({ regra, regraSalva } = await aprenderRegra({ entrada, saidaLocal, saida, nome, chamarSuperior, usadas, ok, agentes, arquivos, data: base.data }));
  }

  registrarCaso(arquivos.casos, { ...base, regra, regrasUsadas: ids, saida, resolvidoPor: nome });
  return { ok: true, resolvidoPor: nome, saida, regrasUsadas: ids, regraSalva };
}

// Pids do processo e de todos os descendentes (uma foto tirada ENQUANTO o processo principal ainda existe), pelo
// PowerShell. `null` se não deu para ler. É a única forma de saber, depois, se algum descendente ficou vivo: o
// `taskkill /T` só acha filhos pelo pai, e um descendente cujo pai já morreu fica órfão e não é mais encontrado.
function arvoreDe(pid, executar = spawnSync) {
  const r = executar('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.CreationDate.ToFileTimeUtc())" }'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
  const filhos = new Map();
  const criacaoDe = new Map();
  let linhas = 0;
  for (const linha of r.stdout.split(/\r?\n/)) {
    const m = /^(\d+),(\d+)(?:,(\d+))?$/.exec(linha.trim());
    if (!m) continue;
    linhas += 1;
    criacaoDe.set(Number(m[1]), m[3] ?? '');
    filhos.set(Number(m[2]), [...(filhos.get(Number(m[2])) || []), Number(m[1])]);
  }
  // Saída vazia ou sem nenhuma linha válida (a consulta falhou sem dar erro) é inconclusiva, não "só a raiz".
  if (!linhas) return null;
  const pids = criacaoDe.has(pid) ? [pid] : [];
  for (let i = -1; i < pids.length; i++) for (const f of filhos.get(i < 0 ? pid : pids[i]) || []) if (!pids.includes(f) && f !== pid) pids.push(f);
  // Raiz já sumida e nenhum descendente achado: inconclusivo (a árvore ficou sem raiz).
  if (!pids.length) return null;
  // Cada item leva o PID E a hora de criação: um PID reaproveitado por outro programa tem outra hora de criação e
  // nunca é confundido com o processo da foto.
  return pids.map((p) => ({ pid: p, criacao: criacaoDe.get(p) }));
}
const chaveDe = (e) => `${e.pid}:${e.criacao}`;
const juntarPids = (a, b) => {
  if (!a && !b) return null;
  const por = new Map();
  for (const e of [...(a || []), ...(b || [])]) por.set(chaveDe(e), e);
  return [...por.values()];
};

// Mata o processo e os filhos dele. No Windows tira antes uma foto da árvore (com o processo principal ainda vivo),
// roda `taskkill /T /F` e só dá por morta quando CADA processo da foto (pid + hora de criação) não existe mais (o código
// 128 e o código 0 do taskkill só falam do pid do shell; descendente órfão não é achado por `/T`); os que sobrarem levam
// `taskkill /F` um a um, e só se pid e hora de criação baterem (nunca um programa do usuário que herdou o pid).
// Sem a foto (PowerShell falhou) ou com a raiz já sumida e nada achado não há como confirmar: devolve false. Nunca mata
// só o processo principal. `executar` e `vivo(pid, criacao)` existem para os testes.
function matarArvore(filho, { plataforma = process.platform, executar = spawnSync, tentativas = 3, vivo = processoVivoComCriacao(executar, plataforma) } = {}) {
  if (plataforma === 'win32') {
    const opcoes = { timeout: 15000, windowsHide: true };
    // Foto de agora, somada às fotos periódicas da execução (um intermediário que já morreu deixou o órfão fora da foto
    // de agora, mas ele aparece nas anteriores).
    filho.arvore = juntarPids(filho.arvore, arvoreDe(filho.pid, executar));
    // vivo() devolve true (existe e a hora bate: pode matar), false (morreu ou o pid é de outro programa) ou null (não deu para saber).
    const naoMortos = () => filho.arvore.filter((e) => vivo(e.pid, e.criacao) !== false);
    if (filho.arvore) {
      for (let i = 0; i < tentativas; i++) {
        const raiz = filho.arvore.find((e) => e.pid === filho.pid);
        if (raiz && vivo(raiz.pid, raiz.criacao) === true) executar('taskkill', ['/pid', String(filho.pid), '/T', '/F'], opcoes);
        for (const e of filho.arvore) if (vivo(e.pid, e.criacao) === true) executar('taskkill', ['/pid', String(e.pid), '/F'], opcoes);
        if (!naoMortos().length) return true;
      }
    }
    console.error(`não consegui confirmar a morte da árvore do processo ${filho.pid}; o lote vai parar se não conseguir`);
    return false;
  }
  try { process.kill(-filho.pid, 'SIGKILL'); } catch { try { filho.kill('SIGKILL'); } catch { /* já morreu */ } }
  return true;
}

// O processo `pid` existe E foi criado na hora `criacao`? (Windows: consulta CIM por pid; outros: só o pid.)
function processoVivoComCriacao(executar = spawnSync, plataforma = process.platform) {
  return (pid, criacao) => {
    if (plataforma !== 'win32') return processoVivoNoSistema(pid);
    const r = executar('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { $p.CreationDate.ToFileTimeUtc() }`], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (r.error || r.status !== 0) return null; // não deu para saber: não conta como morto e nunca é morto sem a hora bater
    const atual = String(r.stdout || '').trim();
    return atual !== '' && atual === String(criacao ?? '');
  };
}

// Depois que o shell fechou: sobrou algum descendente vivo (sem pipe, que o 'close' não enxerga)? Mata e confere.
// Devolve a lista dos que continuam vivos (vazia = limpo) ou `null` se não deu para conferir (Windows sem leitura da
// árvore). Windows: fotos periódicas + a de agora (descendentes guardam o pid do pai); outros: o grupo de processos.
// Há processo vivo no grupo? Zumbi (morto que ninguém recolheu) não conta; onde existe /proc lê o estado de cada um.
function grupoTemVivos(pgid) {
  try {
    for (const nome of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(nome)) continue;
      let stat;
      try { stat = fs.readFileSync(`/proc/${nome}/stat`, 'utf8'); } catch { continue; }
      const resto = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // estado, ppid, pgrp...
      if (Number(resto[2]) === pgid && resto[0] !== 'Z') return true;
    }
    return false;
  } catch {
    try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }
}

function orfaosVivos(filho, { plataforma = process.platform, executar = spawnSync, vivo = processoVivoComCriacao(executar, plataforma) } = {}) {
  if (plataforma === 'win32') {
    filho.arvore = juntarPids(filho.arvore, arvoreDe(filho.pid, executar));
    if (!filho.arvore) return null; // não deu para ler a árvore: inconclusivo, quem chamou trata como morte não confirmada
    const resto = filho.arvore.filter((e) => e.pid !== filho.pid && vivo(e.pid, e.criacao) !== false);
    for (const e of resto) if (vivo(e.pid, e.criacao) === true) executar('taskkill', ['/pid', String(e.pid), '/T', '/F'], { timeout: 15000, windowsHide: true });
    return resto.filter((e) => vivo(e.pid, e.criacao) !== false).map((e) => e.pid);
  }
  const grupoVivo = () => grupoTemVivos(filho.pid);
  if (!grupoVivo()) return [];
  try { process.kill(-filho.pid, 'SIGKILL'); } catch { /* já foi */ }
  const limite = Date.now() + 1000;
  while (grupoVivo() && Date.now() < limite) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  return grupoVivo() ? [-filho.pid] : [];
}
const processoVivoNoSistema = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function chamarComando(comando, { matar = matarArvore, orfaos = orfaosVivos, fotografar = (f) => arvoreDe(f.pid), fotoMs = 2000, plataforma = process.platform, reintentoMs = 2000, tentativasDeMatar = 5, tempoMaximoMs = TEMPO_MAXIMO_MS } = {}) {
  // `signal` (opcional): ao ser abortado, mata o processo (e os filhos dele, no Windows). Usado pelo lote para
  // reduzir agentes locais quando o dono volta a usar o PC. Se a árvore não morrer (taskkill falhando), repete a
  // cada `reintentoMs`; esgotadas as tentativas, a chamada termina com erro `naoConfirmado`: o processo pode
  // continuar vivo, e quem chamou (o lote) deve parar. Também termina com `naoConfirmado` se o shell fechar e sobrar
  // descendente vivo que não morre.
  return (prompt, signal) => new Promise((resolve, reject) => {
    // O prompt vai por ARQUIVO como stdin (nada de pipe de entrada): no Windows, com shell, um pipe de entrada aberto
    // mantém o Node vivo até o filho morrer, mesmo com destroy() e unref().
    const entrada = path.join(os.tmpdir(), `mixai-prompt-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
    const apagarEntrada = () => { try { fs.rmSync(entrada, { force: true }); } catch { /* no Windows pode estar em uso; fica no tmp */ } };
    let filho;
    try {
      fs.writeFileSync(entrada, String(prompt), { mode: 0o600 }); // só o dono lê
      const fdEntrada = fs.openSync(entrada, 'r');
      try {
        filho = spawn(comando, { shell: true, stdio: [fdEntrada, 'pipe', 'pipe'], detached: process.platform !== 'win32' }); // fora do Windows, grupo próprio: matar o grupo leva os filhos do shell
      } finally { fs.closeSync(fdEntrada); }
    } catch (e) { apagarEntrada(); throw e; }
    let terminou = false;
    let relogio = null;
    let estourou = false;
    let fotos = null;
    const fim = (f, valor) => {
      if (terminou) return;
      terminou = true; clearInterval(relogio); clearTimeout(limiteDeTempo);
      clearInterval(fotos);
      apagarEntrada();
      f(valor);
    };
    // Morte não confirmada: larga o processo (pipes fechados e sem segurar o Node), senão o comando nunca termina.
    const largar = () => {
      for (const f of [filho.stdout, filho.stderr]) {
        if (!f) continue;
        try { f.removeAllListeners('data'); f.on('error', () => {}); f.destroy(); } catch { /* já fechado */ }
        try { f.unref?.(); } catch { /* sem efeito */ }
      }
      try { filho.removeAllListeners('close'); filho.removeAllListeners('error'); filho.on('error', () => {}); } catch { /* sem efeito */ }
      try { filho.unref(); } catch { /* sem efeito */ }
    };
    const naoConfirmado = (texto) => { fim(reject, Object.assign(new Error(texto), { naoConfirmado: true })); largar(); };
    const parar = () => {
      if (matar(filho)) return;
      let feitas = 1;
      relogio = setInterval(() => {
        if (terminou) return clearInterval(relogio);
        if (matar(filho)) return clearInterval(relogio);
        if (++feitas >= tentativasDeMatar) naoConfirmado(`o processo ${filho.pid} não morreu (taskkill falhou ${feitas} vezes); pode continuar vivo`);
      }, reintentoMs);
    };
    // O tempo máximo também mata a árvore pelo mesmo caminho (o `timeout` do spawn mataria só o shell).
    const limiteDeTempo = setTimeout(() => { estourou = true; parar(); }, tempoMaximoMs);
    // Windows: fotografa a árvore de tempos em tempos, para o órfão de um intermediário que morreu ainda constar da lista.
    if (plataforma === 'win32') {
      const foto = () => { try { filho.arvore = juntarPids(filho.arvore, fotografar(filho)); } catch { /* a próxima tenta */ } };
      setTimeout(foto, 200).unref?.();
      fotos = setInterval(foto, fotoMs);
      fotos.unref?.();
    }
    if (signal) {
      if (signal.aborted) parar();
      else signal.addEventListener('abort', parar, { once: true });
      filho.on('close', () => signal.removeEventListener('abort', parar));
    }
    let saida = '';
    let erro = '';
    filho.stdout.on('data', (d) => { saida += d; });
    filho.stderr.on('data', (d) => { erro += d; });
    filho.on('error', (e) => fim(reject, e));
    filho.on('close', (codigo) => {
      if (terminou) return;
      // O shell fechou: se ficou descendente vivo (sem pipe), o 'close' não prova que acabou. Mata e confere.
      let sobrou;
      try { sobrou = orfaos(filho); } catch { sobrou = null; }
      if (sobrou === null || sobrou === undefined) return naoConfirmado(`o shell do processo ${filho.pid} fechou e não consegui conferir se sobrou descendente vivo (leitura da árvore falhou)`);
      if (sobrou.length) return naoConfirmado(`o shell do processo ${filho.pid} fechou, mas ${sobrou.length} descendente(s) continuam vivos e não morreram`);
      if (codigo === 0 && !estourou) fim(resolve, saida);
      else fim(reject, new Error(estourou ? `passou do tempo máximo (${tempoMaximoMs / 1000} s)` : erro || `saiu com ${codigo}`));
    });
  });
}

const TEMPO_MAXIMO_MS = 10 * 60 * 1000;

const COMANDOS = {
  // Passa pelo rodar-local.js, que confere a memória livre antes de carregar o modelo.
  local: `node "${path.join(__dirname, '..', 'local', 'rodar-local.js')}"`,
  codex: 'codex exec -s read-only -',
  claude: 'claude -p',
};

function verificadorPorComando(comando) {
  return (saida) => {
    const r = spawnSync(comando, { shell: true, input: saida, encoding: 'utf8', timeout: TEMPO_MAXIMO_MS });
    return { ok: r.status === 0, motivo: String(r.stderr || r.stdout || '').trim().slice(0, 500) };
  };
}

function promptReinstruir(entrada, erradas) {
  const ultimas = erradas.slice(-2).map((e, i) => `Tentativa ${erradas.length - Math.min(2, erradas.length) + i + 1}: saída "${e.saida}" -> erro: ${e.motivo}`);
  return [
    'REINSTRUIR: um modelo pequeno errou esta tarefa. Leia o erro, descubra a causa (pesquise se precisar) e escreva uma instrução curta e exata para ele acertar na próxima. Responda só com a instrução, sem resolver a tarefa por ele.',
    `Tarefa: ${entrada}`,
    ...ultimas,
  ].join('\n');
}

function promptAntagonista(entrada, saida) {
  return [
    'ANTAGONISTA: tente achar defeito nesta resposta (caso de borda, pedido não atendido, algo a mais que ninguém pediu).',
    `Tarefa: ${entrada}`,
    `Resposta: ${saida}`,
    'Responda só "OK" se não achar defeito, ou "PROBLEMA: <o defeito>".',
  ].join('\n');
}

// Loop de tentativas: o Qwen tenta; se falha, o modelo grande lê o erro e reinstrui; repete até o limite.
// Estourou o limite, o grande resolve direto. Cada falha resolvida vira caso de regressão (tests/falhas-escada.test.js).
// Com `antagonico`, a resposta só vale se outro agente (nunca o que produziu) não achar defeito.
async function resolverComLoop({ entrada, verificar, agentes, maxTentativas = 3, antagonico = false, verificarComando = null, arquivos = ARQUIVOS }) {
  if (typeof verificar !== 'function') throw new Error('Sem verificador não há como saber se a resposta está certa.');
  if (!Number.isInteger(maxTentativas) || maxTentativas < 1) throw new Error('tentativas precisa ser um número inteiro maior que zero.');
  const usadas = escolherRegras(lerRegras(arquivos.regras), entrada);
  const base = { entrada, data: new Date().toISOString() };
  const erradas = [];
  const supers = agentes.superiores;

  const julgar = async (saida, produtor) => {
    const v = await verificar(saida);
    if (v.ok !== true) return { ok: false, porVerificador: true, motivo: v.motivo || 'o verificador reprovou' };
    if (!antagonico) return { ok: true, antagonista: null };
    for (const outro of supers.filter((x) => x.nome !== produtor)) {
      const parecer = await tentar(outro.chamar, promptAntagonista(entrada, saida));
      if (parecer === null) continue; // este não respondeu (sem cota): tenta o próximo
      if (/^\s*OK\s*[.!]?\s*$/i.test(parecer)) return { ok: true, antagonista: outro.nome };
      return { ok: false, porVerificador: false, motivo: parecer };
    }
    return { ok: false, porVerificador: false, motivo: 'nenhum outro agente grande disponível para conferir (sem cota?); sem checagem antagônica a resposta não vale' };
  };

  // a regra aprendida passa pela MESMA checagem (verificador + antagonista) da resposta final
  const ok = async (saida) => (await julgar(saida, 'local')).ok === true;
  const concluir = (saida, resolvidoPor, tentativas, antagonista, regra = null, regraSalva = null) => {
    if (erradas.length && verificarComando) {
      registrarCaso(arquivos.falhas, { ...base, saidasErradas: erradas.filter((e) => e.porVerificador).map((e) => e.saida), rejeitadasPeloRevisor: erradas.filter((e) => !e.porVerificador && e.saida).map((e) => e.saida), motivos: erradas.map((e) => e.motivo), saidaCerta: saida, verificar: verificarComando, resolvidoPor });
    }
    registrarCaso(arquivos.casos, { ...base, regra: regra || usadas[0] || null, regrasUsadas: usadas.map((r) => r.id), saida, resolvidoPor });
    return { ok: true, resolvidoPor, saida, tentativas, antagonista, regraSalva };
  };

  let instrucao = entrada;
  for (let t = 1; t <= maxTentativas; t += 1) {
    const saida = await tentar(agentes.local, montarPrompt(instrucao, usadas));
    if (saida === null) {
      erradas.push({ saida: '', porVerificador: false, motivo: 'o modelo local não respondeu' });
    } else {
      const j = await julgar(saida, 'local');
      if (j.ok) return concluir(saida, 'local', t, j.antagonista);
      erradas.push({ saida, porVerificador: j.porVerificador, motivo: j.motivo });
    }
    if (t === maxTentativas || supers.length === 0) continue;
    for (let k = 0; k < supers.length; k += 1) {
      const dica = await tentar(supers[(t - 1 + k) % supers.length].chamar, promptReinstruir(entrada, erradas));
      if (dica) { instrucao = `${entrada}

Instrução do revisor: ${dica}`; break; }
    }
  }

  for (const s of supers) {
    const saida = await tentar(s.chamar, montarPrompt(entrada, []));
    if (saida === null) continue;
    const j = await julgar(saida, s.nome);
    if (j.ok) {
      const ultimaDoLocal = erradas.filter((e) => e.saida).pop();
      const aprendida = ultimaDoLocal
        ? await aprenderRegra({ entrada, saidaLocal: ultimaDoLocal.saida, saida, nome: s.nome, chamarSuperior: s.chamar, usadas, ok, agentes, arquivos, data: base.data })
        : { regra: null, regraSalva: null };
      return concluir(saida, s.nome, maxTentativas, j.antagonista, aprendida.regra, aprendida.regraSalva);
    }
    erradas.push({ saida, porVerificador: j.porVerificador, motivo: j.motivo });
  }
  registrarCaso(arquivos.pendentes, { ...base, saidasErradas: erradas.map((e) => e.saida), motivos: erradas.map((e) => e.motivo), verificar: verificarComando });
  return { ok: false, resolvidoPor: null, saida: null, tentativas: maxTentativas, antagonista: null };
}

const MAX_CONTEXTO = 1500;

function validarPlano(microtarefas) {
  if (!Array.isArray(microtarefas) || microtarefas.length === 0) throw new Error('plano vazio: precisa de ao menos uma microtarefa.');
  const ids = new Set();
  for (const m of microtarefas) {
    const nome = `microtarefa ${m && m.id}`;
    if (!m || !m.id || ids.has(m.id)) throw new Error(`${nome}: id ausente ou repetido.`);
    ids.add(m.id);
    if (!String(m.instrucao || '').trim()) throw new Error(`${nome}: falta a instrução exata.`);
    if (!String(m.verificar || '').trim()) throw new Error(`${nome}: falta o comando que confere o resultado.`);
    if (!Array.isArray(m.escopo) || m.escopo.length === 0) throw new Error(`${nome}: falta o escopo (arquivos que pode tocar).`);
    if (String(m.contexto || '').length > MAX_CONTEXTO) throw new Error(`${nome}: contexto grande demais (máx. ${MAX_CONTEXTO} caracteres); entregue só o que ela precisa.`);
  }
}

const normaliza = (p) => path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const sobrepoe = (a, b) => a.some((x) => b.some((y) => {
  const [p, q] = [normaliza(x), normaliza(y)];
  return p === q || p.startsWith(q + '/') || q.startsWith(p + '/');
}));

function promptMicro(m) {
  return [m.instrucao.trim(), m.contexto ? `Contexto:
${m.contexto}` : null, `Arquivos que você pode tocar: ${m.escopo.join(', ')}`]
    .filter(Boolean).join('\n');
}

// O modelo grande (Claude/Codex) planeja; o Qwen só executa microtarefas delimitadas, até `paralelismo` ao mesmo tempo.
// Microtarefas com escopo que se sobrepõe nunca rodam juntas. Uma que falha não para as outras.
async function lote({ microtarefas, verificadorDe, agentes, paralelismo = 1, reavaliarMs = 15000, maxTentativas, antagonico = false, arquivos = ARQUIVOS }) {
  validarPlano(microtarefas);
  // `paralelismo` pode ser um número ou uma função (orquestra/paralelismo.js) que diz quantos agentes cabem agora.
  const dinamico = typeof paralelismo === 'function';
  const limiteAgora = () => {
    const n = dinamico ? paralelismo({ agentesLocais: locais().length + encerrando.length }) : paralelismo;
    // Zero só vale no limite dinâmico (memória ou placa sem espaço agora): o lote espera abrir vaga.
    if (!Number.isInteger(n) || n < (dinamico ? 0 : 1)) throw new Error(dinamico ? 'paralelismo dinâmico precisa devolver um número inteiro maior que zero ou zero.' : 'paralelismo precisa ser um número inteiro maior que zero.');
    return n;
  };
  const resultados = new Map();
  const pendentes = [...microtarefas];
  const rodando = new Map();
  const estados = new Map(); // microtarefa -> { ctl, abandonada, emLocal, fim }
  const naoConfirmados = []; // ids de microtarefas cujo processo não teve a morte confirmada
  let fatal = null; // processo abortado que não deu para confirmar que morreu: o lote inteiro para com erro claro
  const encerrando = []; // { m, fim }: abortadas cujo processo ainda não confirmou que morreu; a vaga e o escopo seguem ocupados
  // A vaga é de agente LOCAL: quem já subiu para o Codex/Claude (`ocupa` falso: subiu, ou está só conferindo a resposta) não usa o modelo local nem a placa e não conta.
  const locais = () => [...rodando.keys()].filter((m) => estados.get(m).ocupa);
  limiteAgora(); // recusa cedo um limite inválido
  let acordaLoop;
  let mudanca = new Promise((ok) => { acordaLoop = ok; });
  const avisarMudanca = () => { acordaLoop(); mudanca = new Promise((ok) => { acordaLoop = ok; }); };

  while (pendentes.length || rodando.size || encerrando.length) {
    if (fatal) {
      // Interrompe os outros agentes locais e ESPERA a confirmação da morte de cada um antes de lançar o erro.
      const esperas = encerrando.map((x) => x.fim);
      for (const e of estados.values()) if (!e.abandonada && e.emLocal) { e.abandonada = true; e.ctl.abort(); esperas.push(e.fim); }
      let corte;
      await Promise.race([Promise.all(esperas), new Promise((ok) => { corte = setTimeout(ok, 60000); })]);
      clearTimeout(corte);
      if (naoConfirmados.length > 1) fatal = new Error(`${fatal.message} Também não foi confirmada a morte de: ${naoConfirmados.slice(1).join(', ')}.`);
      throw fatal;
    }
    // O dono voltou ao PC: tira agentes locais em andamento (os mais novos primeiro) e devolve a microtarefa à fila.
    // Só tira quem está esperando o modelo local; quem já passou para o Codex/Claude ou para a conferência termina.
    // A vaga só é reaproveitada quando o processo abortado de fato terminou (o `fim` da chamada ao local).
    const limite = limiteAgora();
    while (locais().length > limite) {
      const alvo = locais().reverse().find((m) => estados.get(m).emLocal);
      if (!alvo) break;
      const e = estados.get(alvo);
      e.abandonada = true; // a execução antiga nunca mais responde: não sobe para o Codex nem registra resultado
      const morte = {
        m: alvo,
        fim: e.fim.then(() => {
          encerrando.splice(encerrando.indexOf(morte), 1);
          // Não dá para saber se o processo (e os filhos dele) morreu: reaproveitar a vaga ou o escopo seria arriscado, e o
          // estado só existe na memória deste lote. Para o lote inteiro com erro claro.
          avisarMudanca();
        }),
      };
      encerrando.push(morte);
      e.ctl.abort();
      rodando.delete(alvo);
      pendentes.unshift(alvo);
    }
    while (locais().length + encerrando.length < limiteAgora()) {
      const ocupados = () => [...rodando.keys(), ...encerrando.map((x) => x.m)];
      const i = pendentes.findIndex((m) => !ocupados().some((r) => sobrepoe(r.escopo, m.escopo)));
      if (i < 0) break;
      const [m] = pendentes.splice(i, 1);
      const entrada = promptMicro(m);
      const e = { ctl: new AbortController(), abandonada: false, emLocal: false, ocupa: true, fim: null };
      estados.set(m, e);
      const agentesDaMicro = {
        ...agentes,
        superiores: (agentes.superiores || []).map((sup) => ({ ...sup, chamar: (...a) => { if (e.ocupa) { e.ocupa = false; avisarMudanca(); } return sup.chamar(...a); } })),
        local: async (prompt) => {
          // Voltando do Codex/Claude (ou começando), só entra no local quando houver vaga dentro do limite.
          const outros = () => locais().filter((m) => estados.get(m) !== e).length;
          while (!e.abandonada && !fatal && outros() + encerrando.length >= limiteAgora()) {
            let t;
            await Promise.race([mudanca, new Promise((ok) => { t = setTimeout(ok, Math.min(reavaliarMs, 200)); })]);
            clearTimeout(t);
          }
          return new Promise((ok, no) => {
          if (e.abandonada || fatal) return;
          e.emLocal = true;
          e.ocupa = true; // (re)entrou no local: ocupa vaga
          // Cada chamada ao local (1ª tentativa, 2ª, correção...) tem o seu próprio fim: abortar a segunda não pode
          // olhar o fim da primeira, que já passou.
          let liberar;
          e.fim = new Promise((fimOk) => { liberar = fimOk; });
          Promise.resolve().then(() => agentes.local(prompt, e.ctl.signal)).then(
            (r) => { e.emLocal = false; e.ocupa = false; avisarMudanca(); liberar(); if (!e.abandonada) ok(r); },
            (erro) => {
              e.emLocal = false; e.ocupa = false;
              if (erro?.naoConfirmado) {
                // Morte não confirmada (ao abortar, no tempo máximo ou com descendente sobrando): nunca vira erro comum
                // que sobe para o Codex. O lote inteiro para, e esta chamada não responde mais.
                naoConfirmados.push(m.id);
                fatal = fatal || new Error(`o lote parou: não consegui confirmar que o processo do agente local "${m.id}" morreu (${erro.message}). Veja os processos do modelo local no Gerenciador de Tarefas, encerre-os à mão e rode o lote de novo.`);
                avisarMudanca(); liberar();
                return;
              }
              avisarMudanca(); liberar(); if (!e.abandonada) no(erro);
            },
          );
          });
        },
      };
      const execucao = maxTentativas !== undefined || antagonico
        ? resolverComLoop({ entrada, verificar: verificadorDe(m), agentes: agentesDaMicro, maxTentativas: maxTentativas === undefined ? 1 : maxTentativas, antagonico, verificarComando: m.verificar, arquivos })
        : resolver({ entrada, cabeNoLocal: true, verificar: verificadorDe(m), agentes: agentesDaMicro, arquivos });
      const feito = execucao
        .catch((erro) => ({ ok: false, resolvidoPor: null, saida: null, erro: erro.message }))
        .then((r) => {
          if (e.abandonada) return;
          resultados.set(m.id, { id: m.id, ...r });
          rodando.delete(m);
        });
      rodando.set(m, feito);
    }
    // Com limite dinâmico, acorda de tempos em tempos: para abrir vaga quando o PC ficar parado
    // e para tirar agentes quando o dono voltar.
    let relogio;
    const acordar = dinamico && (pendentes.length || locais().length || encerrando.length) ? [new Promise((ok) => { relogio = setTimeout(ok, reavaliarMs); })] : [];
    await Promise.race([...rodando.values(), ...encerrando.map((x) => x.fim), mudanca, ...acordar]);
    clearTimeout(relogio);
  }
  return microtarefas.map((m) => resultados.get(m.id));
}

function exportar(arquivos = ARQUIVOS) {
  const linhas = lerCasos(arquivos.casos).map((c) => JSON.stringify(paraTreino(c)));
  fs.mkdirSync(path.dirname(arquivos.treino), { recursive: true });
  fs.writeFileSync(arquivos.treino, linhas.join('\n') + (linhas.length ? '\n' : ''));
  return linhas.length;
}

async function principal(argumentos) {
  const [comando, alvo, ...resto] = argumentos;
  if (comando === 'exportar') {
    console.log(`${exportar()} exemplos escritos em ${ARQUIVOS.treino}`);
    return 0;
  }
  if (comando === 'lote' && alvo) {
    const ip = resto.indexOf('--paralelo');
    const cfgLote = JSON.parse(fs.readFileSync(path.join(pasta, 'escada.json'), 'utf8'));
    const microtarefas = JSON.parse(fs.readFileSync(path.resolve(alvo), 'utf8'));
    const resultados = await lote({
      microtarefas,
      verificadorDe: (m) => verificadorPorComando(m.verificar),
      paralelismo: ip >= 0 && resto[ip + 1] === 'auto'
        ? require('./paralelismo.js').criarControle({ aoDecidir: (d) => console.error(`paralelo ${d.alvo}: ${d.motivo}`) })
        : ip >= 0 ? Number(resto[ip + 1]) : cfgLote.paralelismoPadrao || 1,
      maxTentativas: resto.includes('--tentativas') ? Number(resto[resto.indexOf('--tentativas') + 1]) : undefined,
      antagonico: resto.includes('--antagonico'),
      agentes: {
        local: chamarComando(COMANDOS.local),
        superiores: cfgLote.superiores.map((nome) => ({ nome, chamar: chamarComando(COMANDOS[nome]) })),
      },
    });
    for (const r of resultados) console.log(`${r.id}: ${r.ok ? `ok (${r.resolvidoPor})` : 'FALHOU'}`);
    return resultados.every((r) => r.ok) ? 0 : 1;
  }
  if (comando === 'regras') {
    for (const r of lerRegras(ARQUIVOS.regras)) console.log(`${r.id} [${r.status}]: ${r.regra}`);
    return 0;
  }
  if (comando !== 'resolver' || !alvo) {
    console.error('Uso: node orquestra/escada.js resolver <arquivo-da-tarefa> [--cabe-no-local] --verificar "<comando que lê a resposta e sai 0 se estiver certa>" | lote <plano.json> [--paralelo N] [--tentativas N] [--antagonico] | regras | exportar');
    return 2;
  }
  const iv = resto.indexOf('--verificar');
  if (iv < 0 || !resto[iv + 1]) {
    console.error('Falta --verificar "<comando>": sem conferência automática a escada não sabe se a resposta está certa.');
    return 2;
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(pasta, 'escada.json'), 'utf8'));
  const r = await resolver({
    entrada: fs.readFileSync(path.resolve(alvo), 'utf8').trim(),
    cabeNoLocal: resto.includes('--cabe-no-local'),
    verificar: verificadorPorComando(resto[iv + 1]),
    agentes: {
      local: chamarComando(COMANDOS.local),
      superiores: cfg.superiores.map((nome) => ({ nome, chamar: chamarComando(COMANDOS[nome]) })),
    },
  });
  if (!r.ok) {
    console.error('Ninguém acertou. Nada foi registrado.');
    return 1;
  }
  console.log(r.saida);
  console.error(`Resolvido por ${r.resolvidoPor}.${r.regraSalva ? ` Regra nova salva: ${r.regraSalva}.` : ''}`);
  return 0;
}

module.exports = { lote, chamarComando, matarArvore, processoVivoComCriacao, orfaosVivos, arvoreDe, resolverComLoop, escolherRegras, montarPrompt, lerRegraGerada, registrarCaso, lerCasos, paraTreino, resolver, exportar };

if (require.main === module) {
  principal(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (erro) => {
    console.error(`Erro na escada: ${erro.message}`);
    process.exitCode = 1;
  });
}
