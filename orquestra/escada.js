// Escada do modelo local: tarefa bem delimitada vai primeiro ao mixai-local.
// Se errar, sobe para Codex ou Claude; a solução vira regra com exemplo; o local tenta de novo com a regra.
// Se acertar, a regra fica salva para as próximas vezes. Todo caso resolvido é registrado para treino futuro (LoRA).
// Quem decide se a tarefa "cabe no local" é o Claude (o 7B erra ao julgar tamanho de tarefa).
const fs = require('node:fs');
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

function chamarComando(comando) {
  // `signal` (opcional): ao ser abortado, mata o processo (e os filhos dele, no Windows). Usado pelo lote para
  // reduzir agentes locais quando o dono volta a usar o PC.
  return (prompt, signal) => new Promise((resolve, reject) => {
    const filho = spawn(comando, { shell: true, timeout: TEMPO_MAXIMO_MS, detached: process.platform !== 'win32' }); // fora do Windows, grupo próprio: matar o grupo leva os filhos do shell
    const parar = () => {
      if (process.platform === 'win32') {
        const r = spawnSync('taskkill', ['/pid', String(filho.pid), '/T', '/F']);
        if (r.error || r.status !== 0) filho.kill(); // taskkill não funcionou: pelo menos o processo principal
      } else {
        try { process.kill(-filho.pid, 'SIGKILL'); } catch { filho.kill('SIGKILL'); }
      }
    };
    if (signal) {
      if (signal.aborted) parar();
      else signal.addEventListener('abort', parar, { once: true });
      filho.on('close', () => signal.removeEventListener('abort', parar));
    }
    let saida = '';
    let erro = '';
    filho.stdout.on('data', (d) => { saida += d; });
    filho.stderr.on('data', (d) => { erro += d; });
    filho.on('error', reject);
    filho.on('close', (codigo) => (codigo === 0 ? resolve(saida) : reject(new Error(erro || `saiu com ${codigo}`))));
    filho.stdin.on('error', () => {});
    filho.stdin.end(prompt);
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
    const n = dinamico ? paralelismo() : paralelismo;
    // Zero só vale no limite dinâmico (memória ou placa sem espaço agora): o lote espera abrir vaga.
    if (!Number.isInteger(n) || n < (dinamico ? 0 : 1)) throw new Error(dinamico ? 'paralelismo dinâmico precisa devolver um número inteiro maior que zero ou zero.' : 'paralelismo precisa ser um número inteiro maior que zero.');
    return n;
  };
  limiteAgora();
  const resultados = new Map();
  const pendentes = [...microtarefas];
  const rodando = new Map();
  const estados = new Map(); // microtarefa -> { ctl, abandonada, emLocal, fim }
  const encerrando = []; // { m, fim }: abortadas cujo processo ainda não confirmou que morreu; a vaga e o escopo seguem ocupados

  while (pendentes.length || rodando.size || encerrando.length) {
    // O dono voltou ao PC: tira agentes locais em andamento (os mais novos primeiro) e devolve a microtarefa à fila.
    // Só tira quem está esperando o modelo local; quem já passou para o Codex/Claude ou para a conferência termina.
    // A vaga só é reaproveitada quando o processo abortado de fato terminou (o `fim` da chamada ao local).
    const limite = limiteAgora();
    while (rodando.size > limite) {
      const alvo = [...rodando.keys()].reverse().find((m) => estados.get(m).emLocal);
      if (!alvo) break;
      const e = estados.get(alvo);
      e.abandonada = true; // a execução antiga nunca mais responde: não sobe para o Codex nem registra resultado
      const morte = { m: alvo, fim: e.fim.then(() => { encerrando.splice(encerrando.indexOf(morte), 1); }) };
      encerrando.push(morte);
      e.ctl.abort();
      rodando.delete(alvo);
      pendentes.unshift(alvo);
    }
    while (rodando.size + encerrando.length < limiteAgora()) {
      const ocupados = () => [...rodando.keys(), ...encerrando.map((x) => x.m)];
      const i = pendentes.findIndex((m) => !ocupados().some((r) => sobrepoe(r.escopo, m.escopo)));
      if (i < 0) break;
      const [m] = pendentes.splice(i, 1);
      const entrada = promptMicro(m);
      const e = { ctl: new AbortController(), abandonada: false, emLocal: false, fim: null };
      let liberar;
      e.fim = new Promise((ok) => { liberar = ok; });
      estados.set(m, e);
      const agentesDaMicro = {
        ...agentes,
        local: (prompt) => new Promise((ok, no) => {
          if (e.abandonada) return;
          e.emLocal = true;
          Promise.resolve().then(() => agentes.local(prompt, e.ctl.signal)).then(
            (r) => { e.emLocal = false; liberar(); if (!e.abandonada) ok(r); },
            (erro) => { e.emLocal = false; liberar(); if (!e.abandonada) no(erro); },
          );
        }),
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
    const acordar = dinamico && (pendentes.length || rodando.size > 1) ? [new Promise((ok) => { relogio = setTimeout(ok, reavaliarMs); })] : [];
    await Promise.race([...rodando.values(), ...encerrando.map((x) => x.fim), ...acordar]);
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

module.exports = { lote, chamarComando, resolverComLoop, escolherRegras, montarPrompt, lerRegraGerada, registrarCaso, lerCasos, paraTreino, resolver, exportar };

if (require.main === module) {
  principal(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (erro) => {
    console.error(`Erro na escada: ${erro.message}`);
    process.exitCode = 1;
  });
}
